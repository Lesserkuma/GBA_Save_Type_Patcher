import {
  asciiBytes,
  copyBytes,
  fillBytes,
  findBytes,
  hexToBytes,
  readU32,
  startsWithBytes,
  writeU32,
} from "../core/binary.js";
import { PatchError } from "../core/errors.js";
import { applyWaitstateForPipeline, waitstatePayloadSpanForLayout } from "./waitstate.js";
import { applyRtcForPipeline, findRtcPayloadBase, RTC_PAYLOAD_SIZE } from "./rtc.js";
import { applyIrqHandlerForPipeline, findIrqHandlerPayloadBase, IRQ_HANDLER_PAYLOAD_SIZE, irqHandlerPayloadSpanForLayout } from "./irq-handler.js";
import { applyPatchHeaderMarker, hasBatterylessPatch, hasSaveTypePatch, hasWaitstatePatch, makePatchHeaderFlags, readPatchFlags, updateGbaHeaderChecksum } from "./patch-state.js";
import {
  BATTERYLESS_ARM_BRANCH_THUNK_HEX,
  BATTERYLESS_EEPROM_V111_EPILOGUE_PATCH_HEX,
  BATTERYLESS_FLASH1M_BANK_SWITCH_THUNK_HEX,
  BATTERYLESS_NEW_IRQ_ADDR_HEX,
  BATTERYLESS_OLD_IRQ_ADDR_HEX,
  BATTERYLESS_PAYLOAD_GBATA_HEX,
  BATTERYLESS_PAYLOAD_HEX,
  BATTERYLESS_SIGNATURE_HEX,
  BATTERYLESS_SRAM_BANK_SELECT_GBATA_TAIL_HEX,
  BATTERYLESS_SRAM_BANK_SELECT_MODERN_TAIL_HEX,
  BATTERYLESS_THUMB_BRANCH_THUNK_HEX,
  BATTERYLESS_WRITE_HOOKS,
  FLASH1M_BANK_SWITCH_GBATA_PATCH_HEX,
  FLASH1M_BANK_SWITCH_MODERN_PATCH_HEX,
  KNOWN_SAVE_TYPES,
  PATCH_BY_SAVE_TYPE,
  SRAM_CONSTANTS,
} from "./sram-data.js";
import { PAYLOAD_ALIGNMENT, alignedPayloadSpan, ensureDirectPayloadRegion } from "./payload-placement.js";

const C = SRAM_CONSTANTS;
const BATTERYLESS_PAYLOAD_MODERN = hexToBytes(BATTERYLESS_PAYLOAD_HEX);
const BATTERYLESS_PAYLOAD_GBATA = hexToBytes(BATTERYLESS_PAYLOAD_GBATA_HEX);
const BATTERYLESS_PAYLOAD = BATTERYLESS_PAYLOAD_MODERN;
const BATTERYLESS_SIGNATURE = hexToBytes(BATTERYLESS_SIGNATURE_HEX);
const BATTERYLESS_THUMB_BRANCH_THUNK = hexToBytes(BATTERYLESS_THUMB_BRANCH_THUNK_HEX);
const BATTERYLESS_ARM_BRANCH_THUNK = hexToBytes(BATTERYLESS_ARM_BRANCH_THUNK_HEX);
const BATTERYLESS_EEPROM_V111_EPILOGUE_PATCH = hexToBytes(BATTERYLESS_EEPROM_V111_EPILOGUE_PATCH_HEX);
const BATTERYLESS_FLASH1M_BANK_SWITCH_THUNK = hexToBytes(BATTERYLESS_FLASH1M_BANK_SWITCH_THUNK_HEX);
const BATTERYLESS_OLD_IRQ_ADDR = hexToBytes(BATTERYLESS_OLD_IRQ_ADDR_HEX);
const BATTERYLESS_NEW_IRQ_ADDR = hexToBytes(BATTERYLESS_NEW_IRQ_ADDR_HEX);
const FLASH1M_BANK_SWITCH_STYLE_MODERN = "modern";
const FLASH1M_BANK_SWITCH_STYLE_GBATA = "gbata";
const BATTERYLESS_LAST_BLOCK_USABLE = "usable";
const BATTERYLESS_LAST_BLOCK_KEEP_EMPTY = "keep-empty";
const FLASH1M_BANK_SWITCH_PATCH_HEX_BY_STYLE = {
  [FLASH1M_BANK_SWITCH_STYLE_MODERN]: FLASH1M_BANK_SWITCH_MODERN_PATCH_HEX,
  [FLASH1M_BANK_SWITCH_STYLE_GBATA]: FLASH1M_BANK_SWITCH_GBATA_PATCH_HEX,
};
const FLASH1M_BANK_SWITCH_MODERN_PATCH = hexToBytes(FLASH1M_BANK_SWITCH_MODERN_PATCH_HEX);
const FLASH1M_BANK_SWITCH_GBATA_PATCH = hexToBytes(FLASH1M_BANK_SWITCH_GBATA_PATCH_HEX);
const FLASH1M_BANK_SWITCH_PATCHES = [FLASH1M_BANK_SWITCH_MODERN_PATCH, FLASH1M_BANK_SWITCH_GBATA_PATCH];
const FLASH1M_SWITCH_BANK_CODE_NAMES = new Set(["flash1m_v102_switch_bank", "flash1m_v103_switch_bank"]);
// ROM offset 0x01000000 maps to CPU address 0x09000000, which the SRAM
// conversion uses as the FLASH1M SRAM bank-select register.
const FLASH1M_SRAM_BANK_SELECT_ROM_OFFSET = 0x01000000;
const BATTERYLESS_SRAM_BANK_SELECT_MODERN_TAIL = hexToBytes(BATTERYLESS_SRAM_BANK_SELECT_MODERN_TAIL_HEX);
const BATTERYLESS_SRAM_BANK_SELECT_TAIL_BY_STYLE = {
  [FLASH1M_BANK_SWITCH_STYLE_MODERN]: BATTERYLESS_SRAM_BANK_SELECT_MODERN_TAIL,
  [FLASH1M_BANK_SWITCH_STYLE_GBATA]: hexToBytes(BATTERYLESS_SRAM_BANK_SELECT_GBATA_TAIL_HEX),
};
const BATTERYLESS_PAYLOAD_BY_STYLE = {
  [FLASH1M_BANK_SWITCH_STYLE_MODERN]: BATTERYLESS_PAYLOAD_MODERN,
  [FLASH1M_BANK_SWITCH_STYLE_GBATA]: BATTERYLESS_PAYLOAD_GBATA,
};
const BATTERYLESS_CODE_MARKER_OFFSET = 0x30;
const BATTERYLESS_CODE_MARKER_LENGTH = 0x20;
const SAVE_TYPE_PREFIXES = ["EEPROM", "SRAM_F", "SRAM", "FLASH512", "FLASH1M", "FLASH"];
const hexPatternCache = new Map();
const asciiPatternCache = new Map();
const firstBytePatternCache = new Map();

function hexPattern(hex) {
  let pattern = hexPatternCache.get(hex);
  if (!pattern) {
    pattern = hexToBytes(hex);
    hexPatternCache.set(hex, pattern);
  }
  return pattern;
}

function asciiPattern(text) {
  let pattern = asciiPatternCache.get(text);
  if (!pattern) {
    pattern = asciiBytes(text);
    asciiPatternCache.set(text, pattern);
  }
  return pattern;
}

function firstBytePattern(value) {
  let pattern = firstBytePatternCache.get(value);
  if (!pattern) {
    pattern = new Uint8Array([value]);
    firstBytePatternCache.set(value, pattern);
  }
  return pattern;
}

function normalizeFlash1mBankSwitchStyle(style) {
  return style === FLASH1M_BANK_SWITCH_STYLE_GBATA ? FLASH1M_BANK_SWITCH_STYLE_GBATA : FLASH1M_BANK_SWITCH_STYLE_MODERN;
}

function batterylessPayloadForStyle(style) {
  return BATTERYLESS_PAYLOAD_BY_STYLE[normalizeFlash1mBankSwitchStyle(style)];
}

function batterylessPayloadVariants() {
  return [
    { style: FLASH1M_BANK_SWITCH_STYLE_MODERN, payload: BATTERYLESS_PAYLOAD_MODERN },
    { style: FLASH1M_BANK_SWITCH_STYLE_GBATA, payload: BATTERYLESS_PAYLOAD_GBATA },
  ];
}

function normalizeBatterylessLastBlock(lastBlock) {
  return lastBlock === BATTERYLESS_LAST_BLOCK_KEEP_EMPTY ? BATTERYLESS_LAST_BLOCK_KEEP_EMPTY : BATTERYLESS_LAST_BLOCK_USABLE;
}

function isFlash1mSwitchBankWrite(writeInfo) {
  return FLASH1M_SWITCH_BANK_CODE_NAMES.has(writeInfo?.code_name);
}

function resolveFlash1mBankSwitchWriteInfo(writeInfo, flash1mBankSwitchStyle) {
  if (!isFlash1mSwitchBankWrite(writeInfo)) return writeInfo;
  return {
    ...writeInfo,
    hex: FLASH1M_BANK_SWITCH_PATCH_HEX_BY_STYLE[normalizeFlash1mBankSwitchStyle(flash1mBankSwitchStyle)],
  };
}

function addOperation(operations, name, offset, size, details = {}) {
  const operation = { name, offset, size };
  if (details.codeName !== undefined) operation.code_name = details.codeName;
  if (details.sourceOffset !== undefined) operation.source_offset = details.sourceOffset;
  if (details.value !== undefined) operation.value = details.value;
  operations.push(operation);
}

function alignDown(value, alignment) {
  return value - (value % alignment);
}

function alignUp(value, alignment) {
  return alignDown(value + alignment - 1, alignment);
}

function isFreeByte(value) {
  return value === 0x00 || value === 0xff;
}

function isFreeRegion(bytes, start, size) {
  if (start < 0 || size < 0 || start + size > bytes.length) return false;
  for (let offset = start; offset < start + size; offset += 1) {
    if (!isFreeByte(bytes[offset])) return false;
  }
  return true;
}

function rangesOverlap(start, end, ranges) {
  return ranges.some(([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart);
}

function rangesWithPrefixGuard(ranges, guardSize) {
  return ranges.map(([start, end]) => [Math.max(0, start - guardSize), end]);
}

function offsetInRanges(offset, ranges) {
  return ranges.some(([start, end]) => start <= offset && offset < end);
}

function resizeRom(rom, newSize, fillValue = 0xff) {
  if (newSize <= rom.bytes.length) return;
  const expanded = new Uint8Array(newSize);
  expanded.fill(fillValue);
  expanded.set(rom.bytes);
  rom.bytes = expanded;
}

function findAlignedMarker(bytes, marker, start = 0, end = bytes.length, alignment = 1) {
  const limit = Math.min(end, bytes.length);
  let pos = Math.max(0, start);
  while (pos < limit) {
    pos = findBytes(bytes, marker, pos, limit);
    if (pos < 0) return null;
    if (alignment <= 1 || pos % alignment === 0) return pos;
    pos += 1;
  }
  return null;
}

export function findSaveType(bytes) {
  const hits = [];
  KNOWN_SAVE_TYPES.forEach((saveType, priority) => {
    const offset = findBytes(bytes, asciiPattern(saveType));
    if (offset >= 0) hits.push({ offset, priority, saveType });
  });
  if (hits.length) {
    hits.sort((a, b) => a.offset - b.offset || a.priority - b.priority);
    return hits[0].saveType;
  }

  for (let pos = 0; pos < bytes.length; pos += 1) {
    for (const prefix of SAVE_TYPE_PREFIXES) {
      const prefixBytes = asciiPattern(prefix);
      if (!startsWithBytes(bytes, pos, prefixBytes)) continue;
      const versionOffset = pos + prefix.length;
      if (versionOffset + 2 > bytes.length || bytes[versionOffset] !== 0x5f || bytes[versionOffset + 1] !== 0x56) continue;

      let end = versionOffset + 2;
      while (end < bytes.length) {
        const ch = bytes[end];
        const ok = (ch >= 48 && ch <= 57) || (ch >= 65 && ch <= 90) || ch === 95;
        if (!ok) break;
        end += 1;
      }
      return String.fromCharCode(...bytes.slice(pos, end));
    }
  }
  return null;
}

function firstCheckedByte(identifier) {
  const check = identifier.checks.find(([offset]) => offset === 0);
  if (!check) throw new PatchError(`${identifier.name}: missing offset-0 identifier`);
  return check[1];
}

function findMatch(bytes, identifier, start = 1) {
  if (identifier.marker) {
    const pos = findBytes(bytes, hexPattern(identifier.marker), start);
    return pos < 0 ? null : pos;
  }

  const firstByte = firstCheckedByte(identifier);
  const minOffset = Math.min(...identifier.checks.map(([offset]) => offset));
  const maxOffset = Math.max(...identifier.checks.map(([offset]) => offset));
  let pos = Math.max(start, -minOffset, 1);
  const maxPos = bytes.length - maxOffset;
  const first = firstBytePattern(firstByte);

  while (pos < maxPos) {
    pos = findBytes(bytes, first, pos, maxPos);
    if (pos < 0 || pos >= maxPos) return null;
    if (pos + minOffset >= 0 && identifier.checks.every(([offset, value]) => bytes[pos + offset] === value)) return pos;
    pos += 1;
  }
  return null;
}

function findTailFreeRegion(bytes, size, alignment = 16, end = bytes.length, excludedRanges = []) {
  let runEnd = null;
  const limit = Math.min(end, bytes.length);

  for (let pos = limit - 1; pos >= -1; pos -= 1) {
    const free = pos >= 0 && isFreeByte(bytes[pos]) && !offsetInRanges(pos, excludedRanges);
    if (free) {
      if (runEnd === null) runEnd = pos;
      continue;
    }

    if (runEnd !== null) {
      const runStart = pos + 1;
      const alignedStart = alignDown(runEnd - size + 1, alignment);
      if (alignedStart >= runStart && !rangesOverlap(alignedStart, alignedStart + size, excludedRanges)) return alignedStart;
      runEnd = null;
    }
  }
  return null;
}

function writeCode(out, targetOffset, writeInfo, operations, operationName = null) {
  const newCode = hexPattern(writeInfo.hex);
  copyBytes(out, targetOffset, newCode);
  addOperation(operations, operationName || writeInfo.name, targetOffset, newCode.length, {
    codeName: writeInfo.code_name,
    sourceOffset: writeInfo.source_offset,
  });
}

function writeU32Value(out, offset, value, operations, name) {
  if (offset < 0 || offset + 4 > out.length) throw new PatchError(`u32 patch is outside the ROM: 0x${offset.toString(16)}`);
  writeU32(out, offset, value);
  addOperation(operations, name, offset, 4, { value: value >>> 0 });
}

function applySimplePatch(data, out, patchInfo, operations, warnings, flash1mBankSwitchStyle = FLASH1M_BANK_SWITCH_STYLE_MODERN) {
  for (const step of patchInfo.steps) {
    const matchOffsets = [];
    let searchStart = 1;
    while (true) {
      const matchOffset = findMatch(data, step.identifier, searchStart);
      if (matchOffset === null) break;
      matchOffsets.push(matchOffset);
      if (patchInfo.match_all === false) break;
      searchStart = matchOffset + 1;
    }

    if (!matchOffsets.length) {
      warnings.push(`${step.name}: identifier not found`);
      continue;
    }

    for (const matchOffset of matchOffsets) {
      for (const writeInfo of step.writes) {
        const resolvedWriteInfo = resolveFlash1mBankSwitchWriteInfo(writeInfo, flash1mBankSwitchStyle);
        writeCode(out, matchOffset + (resolvedWriteInfo.target_add || 0), resolvedWriteInfo, operations, step.name);
      }
    }
  }
}

function targetBase(writeInfo, hookOffset, injectionOffset) {
  if (writeInfo.base === "hook") return hookOffset;
  if (writeInfo.base === "injection") return injectionOffset;
  throw new PatchError(`Unknown patch base: ${writeInfo.base}`);
}

function dynamicU32Value(valueName, hookOffset, injectionOffset) {
  if (valueName === "injection_address") return (C.GBA_ROM_BASE + injectionOffset + 1) >>> 0;
  if (valueName === "return_address") return (C.GBA_ROM_BASE + hookOffset + 0x21) >>> 0;
  throw new PatchError(`Unknown dynamic u32 value: ${valueName}`);
}

function applyTailTrampolinePatch(data, out, patchInfo, operations, warnings, excludedRanges = []) {
  const hookOffsets = [];
  let searchStart = 1;
  while (true) {
    const hookOffset = findMatch(data, patchInfo.identifier, searchStart);
    if (hookOffset === null) break;
    hookOffsets.push(hookOffset);
    if (patchInfo.match_all === false) break;
    searchStart = hookOffset + 1;
  }

  if (!hookOffsets.length) {
    warnings.push(`${patchInfo.name}: hook identifier not found`);
    return;
  }

  const allocatedRanges = [...excludedRanges];
  for (const hookOffset of hookOffsets) {
    const injectionOffset = findTailFreeRegion(out, patchInfo.injection_size, 16, out.length, allocatedRanges);
    if (injectionOffset === null) {
      warnings.push(`${patchInfo.name}: no free tail area for trampoline`);
      return;
    }
    allocatedRanges.push([injectionOffset, injectionOffset + patchInfo.injection_size]);

    for (const writeInfo of patchInfo.writes) {
      const targetOffset = targetBase(writeInfo, hookOffset, injectionOffset) + (writeInfo.target_add || 0);
      if (writeInfo.hex) writeCode(out, targetOffset, writeInfo, operations);
      else writeU32Value(out, targetOffset, dynamicU32Value(writeInfo.u32_value, hookOffset, injectionOffset), operations, writeInfo.name);
    }
  }
}

function containsBatterylessSignature(bytes) {
  return findAlignedMarker(bytes, BATTERYLESS_SIGNATURE, 0, bytes.length, 4) !== null;
}

function findBatterylessPayloadInfo(bytes) {
  const signatureOffset = findAlignedMarker(bytes, BATTERYLESS_SIGNATURE, 0, bytes.length, 4);
  if (signatureOffset === null) return null;

  for (const candidate of batterylessPayloadVariants()) {
    const payloadSignatureOffset = findBytes(candidate.payload, BATTERYLESS_SIGNATURE);
    if (payloadSignatureOffset < 0) continue;

    const payloadBase = signatureOffset - payloadSignatureOffset;
    if (payloadBase < 0 || payloadBase + candidate.payload.length > bytes.length) continue;
    if (!startsWithBytes(
      bytes,
      payloadBase + BATTERYLESS_CODE_MARKER_OFFSET,
      candidate.payload.slice(BATTERYLESS_CODE_MARKER_OFFSET, BATTERYLESS_CODE_MARKER_OFFSET + BATTERYLESS_CODE_MARKER_LENGTH),
    )) {
      continue;
    }
    return { payloadBase, payload: candidate.payload, style: candidate.style };
  }
  return null;
}

function findBatterylessPayloadBase(bytes) {
  return findBatterylessPayloadInfo(bytes)?.payloadBase ?? null;
}

function batterylessSaveOffset(payloadBase, payload = BATTERYLESS_PAYLOAD) {
  return alignUp(payloadBase + payload.length, C.BATTERYLESS_REGION_ALIGNMENT);
}

function batterylessSaveRangeHitsFlash1mBankSelect(saveOffset, size = C.BATTERYLESS_RESERVED_SIZE) {
  const end = saveOffset + size;
  return saveOffset <= FLASH1M_SRAM_BANK_SELECT_ROM_OFFSET && FLASH1M_SRAM_BANK_SELECT_ROM_OFFSET < end;
}

function rangePairOverlaps(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

function overlapsBatterylessPowerBoundaryGuard(start, end) {
  let boundary = C.BATTERYLESS_REGION_ALIGNMENT * 2;
  while (boundary <= C.GBA_MAX_ROM_SIZE) {
    const guardStart = boundary - C.BATTERYLESS_RESERVED_SIZE;
    if (rangePairOverlaps(start, end, guardStart, boundary)) return true;
    boundary <<= 1;
  }
  return false;
}

function lastNonEmptyBatterylessBlockStart(bytes) {
  let blockStart = alignDown(Math.max(0, bytes.length - 1), C.BATTERYLESS_REGION_ALIGNMENT);
  while (blockStart >= 0) {
    const blockEnd = Math.min(blockStart + C.BATTERYLESS_REGION_ALIGNMENT, bytes.length);
    let hasData = false;
    for (let offset = blockStart; offset < blockEnd; offset += 1) {
      if (!isFreeByte(bytes[offset])) {
        hasData = true;
        break;
      }
    }
    if (hasData) return blockStart;
    blockStart -= C.BATTERYLESS_REGION_ALIGNMENT;
  }
  return null;
}

function batterylessPayloadFitsAtBlockEnd(bytes, blockStart, payload = BATTERYLESS_PAYLOAD, prefixSize = 0, keepLastBlockEmpty = false) {
  const blockEnd = blockStart + C.BATTERYLESS_REGION_ALIGNMENT;
  const payloadBase = blockEnd - payload.length;
  const prefixBase = payloadBase - prefixSize;
  const saveOffset = blockEnd;
  const regionEnd = saveOffset + C.BATTERYLESS_RESERVED_SIZE;

  if (prefixBase < 0 || regionEnd > bytes.length) return null;
  if (batterylessSaveRangeHitsFlash1mBankSelect(saveOffset)) return null;
  if (keepLastBlockEmpty && overlapsBatterylessPowerBoundaryGuard(prefixBase, regionEnd)) return null;
  if (prefixSize && !isFreeRegion(bytes, prefixBase, prefixSize)) return null;
  if (!isFreeRegion(bytes, payloadBase, payload.length)) return null;
  if (!isFreeRegion(bytes, saveOffset, C.BATTERYLESS_RESERVED_SIZE)) return null;
  return payloadBase;
}

function findBatterylessFreeRegion(bytes, payload = BATTERYLESS_PAYLOAD, prefixSize = 0, keepLastBlockEmpty = false) {
  const lastContentBlock = lastNonEmptyBatterylessBlockStart(bytes);
  if (lastContentBlock === null) return null;

  let blockStart = lastContentBlock;
  while (blockStart + C.BATTERYLESS_REGION_ALIGNMENT * 2 <= bytes.length) {
    const payloadBase = batterylessPayloadFitsAtBlockEnd(bytes, blockStart, payload, prefixSize, keepLastBlockEmpty);
    if (payloadBase !== null) return payloadBase;
    blockStart += C.BATTERYLESS_REGION_ALIGNMENT;
  }
  return null;
}

function ensureBatterylessRegion(rom, operations, warnings, payload = BATTERYLESS_PAYLOAD, prefixSize = 0, keepLastBlockEmpty = false) {
  while (true) {
    if (rom.bytes.length > C.GBA_MAX_ROM_SIZE) {
      warnings.push("Batteryless SRAM: ROM is larger than 32 MiB");
      return null;
    }
    const payloadBase = findBatterylessFreeRegion(rom.bytes, payload, prefixSize, keepLastBlockEmpty);
    if (payloadBase !== null) return payloadBase;
    if (rom.bytes.length >= C.GBA_MAX_ROM_SIZE) {
      warnings.push("Batteryless SRAM: no free area and ROM is already 32 MiB");
      return null;
    }
    const oldSize = rom.bytes.length;
    const newSize = Math.min(oldSize + C.BATTERYLESS_REGION_ALIGNMENT, C.GBA_MAX_ROM_SIZE);
    if (newSize <= oldSize) {
      warnings.push("Batteryless SRAM: ROM could not be expanded");
      return null;
    }
    resizeRom(rom, newSize, 0xff);
    addOperation(operations, "Batteryless SRAM ROM expansion", oldSize, newSize - oldSize, { value: newSize });
  }
}

function layoutPrefixBeforePayload(payloadBase, rtcSpan = 0, waitstateSpan = 0, irqSpan = 0) {
  let cursor = payloadBase;
  let rtcOffset = null;
  let waitstateOffset = null;
  let irqOffset = null;

  if (irqSpan > 0) {
    if (cursor < irqSpan) return { prefixBase: -1, prefixSize: 0, rtcOffset, waitstateOffset, irqOffset };
    irqOffset = alignDown(cursor - irqSpan, PAYLOAD_ALIGNMENT);
    cursor = irqOffset;
  }

  if (waitstateSpan > 0) {
    if (cursor < waitstateSpan) return { prefixBase: -1, prefixSize: 0, rtcOffset, waitstateOffset, irqOffset };
    waitstateOffset = alignDown(cursor - waitstateSpan, PAYLOAD_ALIGNMENT);
    cursor = waitstateOffset;
  }

  if (rtcSpan > 0) {
    if (cursor < rtcSpan) return { prefixBase: -1, prefixSize: 0, rtcOffset, waitstateOffset, irqOffset };
    rtcOffset = alignDown(cursor - rtcSpan, PAYLOAD_ALIGNMENT);
    cursor = rtcOffset;
  }

  return { prefixBase: cursor, prefixSize: payloadBase - cursor, rtcOffset, waitstateOffset, irqOffset };
}

function rangeForSpan(offset, span) {
  return span > 0 && offset !== null && offset !== undefined ? [[offset, offset + span]] : [];
}

function ensureNonBatterylessAddonLayout(rom, operations, warnings, rtcSpan, waitstateSpan) {
  const totalSpan = rtcSpan + waitstateSpan;
  if (totalSpan <= 0) return { base: null, rtcOffset: null, waitstateOffset: null, totalSpan: 0 };

  const label = rtcSpan && waitstateSpan ? "RTC/Waitstate" : rtcSpan ? "RTC" : "Waitstate";
  const base = ensureDirectPayloadRegion(rom, operations, warnings, totalSpan, label);
  if (base === null) return null;

  return {
    base,
    rtcOffset: rtcSpan ? base : null,
    waitstateOffset: waitstateSpan ? base + rtcSpan : null,
    totalSpan,
  };
}

function batterylessLayoutFitsAtBlockEnd(bytes, blockStart, payload = BATTERYLESS_PAYLOAD, rtcSpan = 0, waitstateSpan = 0, irqSpan = 0, keepLastBlockEmpty = false) {
  const blockEnd = blockStart + C.BATTERYLESS_REGION_ALIGNMENT;
  const payloadBase = blockEnd - payload.length;
  const prefixLayout = layoutPrefixBeforePayload(payloadBase, rtcSpan, waitstateSpan, irqSpan);
  const prefixBase = prefixLayout.prefixBase;
  const saveOffset = blockEnd;
  const regionEnd = saveOffset + C.BATTERYLESS_RESERVED_SIZE;

  if (prefixBase < 0 || regionEnd > bytes.length) return null;
  if (batterylessSaveRangeHitsFlash1mBankSelect(saveOffset)) return null;
  if (keepLastBlockEmpty && overlapsBatterylessPowerBoundaryGuard(prefixBase, regionEnd)) return null;
  if (prefixLayout.prefixSize && !isFreeRegion(bytes, prefixBase, prefixLayout.prefixSize)) return null;
  if (!isFreeRegion(bytes, payloadBase, payload.length)) return null;
  if (!isFreeRegion(bytes, saveOffset, C.BATTERYLESS_RESERVED_SIZE)) return null;
  return { payloadBase, prefixLayout };
}

function findBatterylessFreeLayout(bytes, payload = BATTERYLESS_PAYLOAD, rtcSpan = 0, waitstateSpan = 0, irqSpan = 0, keepLastBlockEmpty = false) {
  const lastContentBlock = lastNonEmptyBatterylessBlockStart(bytes);
  if (lastContentBlock === null) return null;

  let blockStart = lastContentBlock;
  while (blockStart + C.BATTERYLESS_REGION_ALIGNMENT * 2 <= bytes.length) {
    const layout = batterylessLayoutFitsAtBlockEnd(bytes, blockStart, payload, rtcSpan, waitstateSpan, irqSpan, keepLastBlockEmpty);
    if (layout !== null) return layout;
    blockStart += C.BATTERYLESS_REGION_ALIGNMENT;
  }
  return null;
}

function ensureBatterylessLayout(rom, operations, warnings, payload = BATTERYLESS_PAYLOAD, rtcSpan = 0, waitstateSpan = 0, irqSpan = 0, keepLastBlockEmpty = false) {
  while (true) {
    if (rom.bytes.length > C.GBA_MAX_ROM_SIZE) {
      warnings.push("Batteryless SRAM: ROM is larger than 32 MiB");
      return null;
    }
    const layout = findBatterylessFreeLayout(rom.bytes, payload, rtcSpan, waitstateSpan, irqSpan, keepLastBlockEmpty);
    if (layout !== null) return layout;
    if (rom.bytes.length >= C.GBA_MAX_ROM_SIZE) {
      warnings.push("Batteryless SRAM: no free area and ROM is already 32 MiB");
      return null;
    }
    const oldSize = rom.bytes.length;
    const newSize = Math.min(oldSize + C.BATTERYLESS_REGION_ALIGNMENT, C.GBA_MAX_ROM_SIZE);
    if (newSize <= oldSize) {
      warnings.push("Batteryless SRAM: ROM could not be expanded");
      return null;
    }
    resizeRom(rom, newSize, 0xff);
    addOperation(operations, "Batteryless SRAM ROM expansion", oldSize, newSize - oldSize, { value: newSize });
  }
}

function batterylessReservedRange(payloadBase, prefixSize = 0, payload = BATTERYLESS_PAYLOAD) {
  return [payloadBase - prefixSize, batterylessSaveOffset(payloadBase, payload) + C.BATTERYLESS_RESERVED_SIZE];
}

function inferredBatterylessSaveSize(saveType) {
  if (!saveType) return null;
  const prefixes = Object.entries(C.BATTERYLESS_SAVE_SIZE_BY_TYPE_PREFIX).sort((a, b) => b[0].length - a[0].length);
  for (const [prefix, size] of prefixes) {
    if (saveType.startsWith(prefix)) return size;
  }
  return null;
}

function batterylessTargetOffset(target) {
  if (target === "sram") return C.BATTERYLESS_WRITE_SRAM_PATCHED;
  if (target === "eeprom") return C.BATTERYLESS_WRITE_EEPROM_PATCHED;
  if (target === "flash") return C.BATTERYLESS_WRITE_FLASH_PATCHED;
  if (target === "eeprom_v111_posthook") return C.BATTERYLESS_WRITE_EEPROM_V111_POSTHOOK;
  throw new PatchError(`Unknown Batteryless hook target: ${target}`);
}

function writeBatterylessThumbHook(out, offset, targetAddress, operations, name) {
  if (offset < 0 || offset + 8 > out.length) throw new PatchError(`Batteryless hook is outside the ROM: 0x${offset.toString(16)}`);
  copyBytes(out, offset, BATTERYLESS_THUMB_BRANCH_THUNK);
  writeU32(out, offset + 4, targetAddress);
  addOperation(operations, `Batteryless SRAM ${name}`, offset, 8, { codeName: "batteryless_thumb_hook", value: targetAddress >>> 0 });
}

function writeBatterylessArmHook(out, offset, targetAddress, operations, name) {
  if (offset < 0 || offset + 12 > out.length) throw new PatchError(`Batteryless ARM hook is outside the ROM: 0x${offset.toString(16)}`);
  copyBytes(out, offset, BATTERYLESS_ARM_BRANCH_THUNK);
  writeU32(out, offset + 8, targetAddress);
  addOperation(operations, `Batteryless SRAM ${name}`, offset, 12, { codeName: "batteryless_arm_hook", value: targetAddress >>> 0 });
}

function writeBatterylessEepromV111Hook(out, offset, targetAddress, operations, name) {
  const patchOffset = offset + 0x0c;
  const pointerOffset = offset + 0x2c;
  if (patchOffset < 0 || pointerOffset + 4 > out.length) throw new PatchError(`Batteryless EEPROM hook is outside the ROM: 0x${offset.toString(16)}`);
  copyBytes(out, patchOffset, BATTERYLESS_EEPROM_V111_EPILOGUE_PATCH);
  writeU32(out, pointerOffset, targetAddress);
  addOperation(operations, `Batteryless SRAM ${name}`, patchOffset, 4, { codeName: "batteryless_eeprom_v111_epilogue", value: targetAddress >>> 0 });
  addOperation(operations, `Batteryless SRAM ${name} target`, pointerOffset, 4, { value: targetAddress >>> 0 });
}

function patchBatterylessWriteHooks(out, payloadBase, mode, saveType, operations, warnings, prefixSize = 0, payload = BATTERYLESS_PAYLOAD) {
  const hooksFound = [];
  let saveSize = inferredBatterylessSaveSize(saveType);
  let storageMode = C.BATTERYLESS_STORAGE_MODE_NORMAL;
  const [reservedStart, reservedEnd] = batterylessReservedRange(payloadBase, prefixSize, payload);

  for (const hook of BATTERYLESS_WRITE_HOOKS) {
    const marker = hexPattern(hook.marker);
    let pos = 0;
    while (true) {
      const matchOffset = findAlignedMarker(out, marker, pos, out.length, 2);
      if (matchOffset === null) break;
      if (reservedStart <= matchOffset && matchOffset < reservedEnd) {
        pos = reservedEnd;
        continue;
      }

      hooksFound.push({ name: hook.name, offset: matchOffset });
      const hookStorageMode = hook.storage_mode ?? C.BATTERYLESS_STORAGE_MODE_NORMAL;
      if (hookStorageMode !== C.BATTERYLESS_STORAGE_MODE_NORMAL) {
        if (![C.BATTERYLESS_STORAGE_MODE_NORMAL, hookStorageMode].includes(storageMode)) {
          warnings.push("Batteryless SRAM: conflicting save storage formats detected");
          return { saveSize: null, hooksFound, storageMode };
        }
        storageMode = hookStorageMode;
        saveSize = hook.save_size;
      } else if (storageMode === C.BATTERYLESS_STORAGE_MODE_NORMAL) {
        saveSize = Math.max(saveSize || 0, hook.save_size);
      }

      if (mode === "auto") {
        const targetAddress = (C.GBA_ROM_BASE + payloadBase + batterylessTargetOffset(hook.target)) >>> 0;
        if (hook.thunk === "thumb") writeBatterylessThumbHook(out, matchOffset, targetAddress, operations, hook.name);
        else if (hook.thunk === "arm") writeBatterylessArmHook(out, matchOffset, targetAddress, operations, hook.name);
        else if (hook.thunk === "eeprom_v111_epilogue") writeBatterylessEepromV111Hook(out, matchOffset, targetAddress, operations, hook.name);
        else throw new PatchError(`Unknown Batteryless hook type: ${hook.thunk}`);
      }
      pos = matchOffset + 2;
    }
  }

  if (!hooksFound.length) {
    if (mode === "auto") {
      warnings.push("Batteryless SRAM: no matching save-write routine found for Auto mode");
      return { saveSize: null, hooksFound, storageMode };
    }
    warnings.push("Batteryless SRAM: save size could not be detected safely, using 128 KiB");
    saveSize = saveSize || 0x20000;
  }
  return { saveSize, hooksFound, storageMode };
}

function patchBatterylessFlash1mBankSwitch(out, payloadBase, saveType, operations, prefixSize = 0, payload = BATTERYLESS_PAYLOAD) {
  if (!saveType || !saveType.startsWith("FLASH1M")) return 0;
  const targetAddress = (C.GBA_ROM_BASE + payloadBase + C.BATTERYLESS_SRAM_BANK_SELECT_PATCHED) >>> 0;
  const patch = new Uint8Array(BATTERYLESS_FLASH1M_BANK_SWITCH_THUNK.length + 4 + 16);
  patch.set(BATTERYLESS_FLASH1M_BANK_SWITCH_THUNK);
  writeU32(patch, BATTERYLESS_FLASH1M_BANK_SWITCH_THUNK.length, targetAddress);
  for (let i = BATTERYLESS_FLASH1M_BANK_SWITCH_THUNK.length + 4; i < patch.length; i += 2) {
    patch[i] = 0xc0;
    patch[i + 1] = 0x46;
  }
  for (const directPatch of FLASH1M_BANK_SWITCH_PATCHES) {
    if (patch.length !== directPatch.length) throw new PatchError("Batteryless SRAM: FLASH1M bank-switch patch has the wrong length");
  }

  let count = 0;
  const [reservedStart, reservedEnd] = batterylessReservedRange(payloadBase, prefixSize, payload);
  for (const directPatch of FLASH1M_BANK_SWITCH_PATCHES) {
    let pos = 0;
    while (true) {
      const matchOffset = findAlignedMarker(out, directPatch, pos, out.length, 2);
      if (matchOffset === null) break;
      if (reservedStart <= matchOffset && matchOffset < reservedEnd) {
        pos = reservedEnd;
        continue;
      }
      copyBytes(out, matchOffset, patch);
      addOperation(operations, "Batteryless SRAM FLASH1M bank switch via RAM", matchOffset, patch.length, { codeName: "batteryless_flash1m_bank_switch", value: targetAddress });
      count += 1;
      pos = matchOffset + patch.length;
    }
  }
  return count;
}

function patchBatterylessIrqReferences(out, payloadBase, operations, prefixSize = 0, payload = BATTERYLESS_PAYLOAD) {
  let count = 0;
  let pos = 0;
  const [reservedStart, reservedEnd] = batterylessReservedRange(payloadBase, prefixSize, payload);

  while (true) {
    const matchOffset = findAlignedMarker(out, BATTERYLESS_OLD_IRQ_ADDR, pos, out.length, 4);
    if (matchOffset === null) return count;
    if (reservedStart <= matchOffset && matchOffset < reservedEnd) {
      pos = reservedEnd;
      continue;
    }

    copyBytes(out, matchOffset, BATTERYLESS_NEW_IRQ_ADDR);
    addOperation(operations, "Batteryless SRAM IRQ handler address", matchOffset, 4, { value: 0x03007ff4 });
    count += 1;
    pos = matchOffset + 4;
  }
}

function decodeEntrypointAddress(out) {
  if (out.length < 4 || out[3] !== 0xea) throw new PatchError("Unexpected entrypoint instruction");
  const branchWord = readU32(out, 0);
  let branchOffset = branchWord & 0x00ffffff;
  if (branchOffset & 0x00800000) branchOffset -= 0x01000000;
  return C.GBA_ROM_BASE + 8 + (branchOffset << 2);
}

function encodeArmBranch(sourceAddress, targetAddress) {
  const branchOffset = (targetAddress - sourceAddress - 8) >> 2;
  if (branchOffset < -0x800000 || branchOffset > 0x7fffff) throw new PatchError("Entrypoint target is outside ARM branch range");
  return (0xea000000 | (branchOffset & 0x00ffffff)) >>> 0;
}

function makeBatterylessPayload(originalEntrypoint, mode, saveSize, countdown, storageMode, indicatorMode, flash1mBankSwitchStyle = FLASH1M_BANK_SWITCH_STYLE_MODERN) {
  if (countdown < 0 || countdown > 0xff) throw new PatchError("Batteryless SRAM: delay value must be between 0 and 255");
  if (!(indicatorMode in C.BATTERYLESS_INDICATOR_MODE_VALUES)) throw new PatchError("Batteryless SRAM: unknown indicator mode");
  const bankSwitchStyle = normalizeFlash1mBankSwitchStyle(flash1mBankSwitchStyle);
  const payload = new Uint8Array(batterylessPayloadForStyle(bankSwitchStyle));
  const bankSelectTailOffset = findBytes(payload, BATTERYLESS_SRAM_BANK_SELECT_MODERN_TAIL);
  if (bankSelectTailOffset < 0) throw new PatchError("Batteryless SRAM: bank-select tail signature not found");
  copyBytes(payload, bankSelectTailOffset, BATTERYLESS_SRAM_BANK_SELECT_TAIL_BY_STYLE[bankSwitchStyle]);
  writeU32(payload, C.BATTERYLESS_ORIGINAL_ENTRYPOINT_OFFSET, originalEntrypoint >>> 0);
  writeU32(payload, C.BATTERYLESS_FLUSH_MODE_OFFSET, mode === "auto" ? 0 : 1);
  writeU32(payload, C.BATTERYLESS_SAVE_SIZE_OFFSET, saveSize >>> 0);
  writeU32(payload, C.BATTERYLESS_STORAGE_MODE_OFFSET, storageMode >>> 0);
  writeU32(payload, C.BATTERYLESS_INDICATOR_MODE_OFFSET, C.BATTERYLESS_INDICATOR_MODE_VALUES[indicatorMode] >>> 0);
  payload[C.BATTERYLESS_COUNTDOWN_IMMEDIATE_OFFSET] = countdown & 0xff;
  return payload;
}

function applyBatterylessPatch(rom, operations, warnings, mode, saveType, countdown, indicatorMode, flash1mBankSwitchStyle = FLASH1M_BANK_SWITCH_STYLE_MODERN, payloadBase = null, prefixSize = 0, keepLastBlockEmpty = false) {
  const selectedPayload = batterylessPayloadForStyle(flash1mBankSwitchStyle);
  if (containsBatterylessSignature(rom.bytes)) {
    const existingInfo = findBatterylessPayloadInfo(rom.bytes);
    const existingBase = existingInfo?.payloadBase ?? null;
    const existingPayload = existingInfo?.payload ?? selectedPayload;
    const result = { requested: true, mode, status: "already_patched", countdown, indicator_mode: indicatorMode, flash1m_bank_switch_style: normalizeFlash1mBankSwitchStyle(flash1mBankSwitchStyle) };
    if (existingBase !== null) {
      result.payload_offset = existingBase;
      result.save_offset = batterylessSaveOffset(existingBase, existingPayload);
      result.reserved_size = C.BATTERYLESS_RESERVED_SIZE;
      result.save_size = readU32(rom.bytes, existingBase + C.BATTERYLESS_SAVE_SIZE_OFFSET) || inferredBatterylessSaveSize(saveType);
      if (C.BATTERYLESS_FLUSH_SRAM !== undefined) {
        result.flush_entry = (C.GBA_ROM_BASE + existingBase + C.BATTERYLESS_FLUSH_SRAM) >>> 0;
      }
    }
    return result;
  }

  const workRom = { bytes: new Uint8Array(rom.bytes) };
  const localOperations = [];
  const localWarnings = [];
  let resolvedPayloadBase = payloadBase;

  if (resolvedPayloadBase === null) {
    resolvedPayloadBase = ensureBatterylessRegion(workRom, localOperations, localWarnings, selectedPayload, 0, keepLastBlockEmpty);
  } else {
    const saveOffset = batterylessSaveOffset(resolvedPayloadBase, selectedPayload);
    const reservedStart = resolvedPayloadBase - prefixSize;
    const reservedEnd = saveOffset + C.BATTERYLESS_RESERVED_SIZE;
    if (
      (keepLastBlockEmpty && overlapsBatterylessPowerBoundaryGuard(reservedStart, reservedEnd))
      || !isFreeRegion(workRom.bytes, resolvedPayloadBase, selectedPayload.length)
      || !isFreeRegion(workRom.bytes, saveOffset, C.BATTERYLESS_RESERVED_SIZE)
    ) {
      localWarnings.push("Batteryless SRAM: reserved area is no longer free");
    }
  }

  if (resolvedPayloadBase === null || localWarnings.length) {
    warnings.push(...localWarnings);
    return { requested: true, mode, status: "failed", countdown, indicator_mode: indicatorMode };
  }

  const saveOffset = batterylessSaveOffset(resolvedPayloadBase, selectedPayload);

  try {
    const originalEntrypoint = decodeEntrypointAddress(workRom.bytes);
    const hookResult = patchBatterylessWriteHooks(workRom.bytes, resolvedPayloadBase, mode, saveType, localOperations, localWarnings, prefixSize, selectedPayload);
    if (hookResult.saveSize === null) {
      warnings.push(...localWarnings);
      return { requested: true, mode, status: "failed", countdown, indicator_mode: indicatorMode, payload_offset: resolvedPayloadBase, save_offset: saveOffset };
    }

    const newEntrypoint = C.GBA_ROM_BASE + resolvedPayloadBase + C.BATTERYLESS_PATCHED_ENTRYPOINT;
    const entrypointBranch = encodeArmBranch(C.GBA_ROM_BASE, newEntrypoint);
    writeU32(workRom.bytes, 0, entrypointBranch);
    addOperation(localOperations, "Batteryless SRAM Entrypoint", 0, 4, { value: entrypointBranch });

    const payload = makeBatterylessPayload(originalEntrypoint, mode, hookResult.saveSize, countdown, hookResult.storageMode, indicatorMode, flash1mBankSwitchStyle);
    copyBytes(workRom.bytes, resolvedPayloadBase, payload);
    addOperation(localOperations, "Batteryless SRAM Payload", resolvedPayloadBase, payload.length, { codeName: "batteryless_payload" });

    const flash1mBankSwitchCount = patchBatterylessFlash1mBankSwitch(workRom.bytes, resolvedPayloadBase, saveType, localOperations, prefixSize, selectedPayload);
    if (!isFreeRegion(workRom.bytes, saveOffset, C.BATTERYLESS_RESERVED_SIZE)) {
      localWarnings.push("Batteryless SRAM: save area is not free");
      warnings.push(...localWarnings);
      return { requested: true, mode, status: "failed", countdown, indicator_mode: indicatorMode, payload_offset: resolvedPayloadBase, save_offset: saveOffset };
    }

    fillBytes(workRom.bytes, saveOffset, C.BATTERYLESS_RESERVED_SIZE, 0xff);
    addOperation(localOperations, "Batteryless SRAM save area initialized", saveOffset, C.BATTERYLESS_RESERVED_SIZE, { value: 0xff });

    rom.bytes = workRom.bytes;
    operations.push(...localOperations);
    warnings.push(...localWarnings);
    return {
      requested: true,
      mode,
      status: "patched",
      payload_offset: resolvedPayloadBase,
      save_offset: saveOffset,
      reserved_size: C.BATTERYLESS_RESERVED_SIZE,
      save_size: hookResult.saveSize,
      storage_mode: hookResult.storageMode,
      flush_entry: C.BATTERYLESS_FLUSH_SRAM === undefined ? null : (C.GBA_ROM_BASE + resolvedPayloadBase + C.BATTERYLESS_FLUSH_SRAM) >>> 0,
      countdown,
      indicator_mode: indicatorMode,
      hooks: hookResult.hooksFound,
      flash1m_bank_switches: flash1mBankSwitchCount,
      flash1m_bank_switch_style: normalizeFlash1mBankSwitchStyle(flash1mBankSwitchStyle),
    };
  } catch (error) {
    localWarnings.push(error.message);
    warnings.push(...localWarnings);
    return { requested: true, mode, status: "failed", countdown, indicator_mode: indicatorMode, payload_offset: resolvedPayloadBase, save_offset: saveOffset };
  }
}

function embedSaveFile(rom, batterylessResult, saveBuffer, operations) {
  if (!saveBuffer) return false;
  if (!batterylessResult || !["patched", "already_patched"].includes(batterylessResult.status)) throw new PatchError("Save data can only be embedded after a Batteryless SRAM patch.");
  const saveOffset = batterylessResult.save_offset;
  const saveSize = batterylessResult.save_size || batterylessResult.reserved_size || C.BATTERYLESS_RESERVED_SIZE;
  if (saveOffset === undefined || saveOffset === null) throw new PatchError("Batteryless SRAM save block was not found.");
  if (saveBuffer.byteLength > saveSize) throw new PatchError("Save file is larger than the available Batteryless SRAM save block.");
  if (saveOffset + saveSize > rom.bytes.length) throw new PatchError("Batteryless SRAM save block is outside the ROM.");
  copyBytes(rom.bytes, saveOffset, new Uint8Array(saveBuffer));
  if (saveBuffer.byteLength < saveSize) fillBytes(rom.bytes, saveOffset + saveBuffer.byteLength, saveSize - saveBuffer.byteLength, 0xff);
  addOperation(operations, "Embedded save data", saveOffset, saveBuffer.byteLength, { value: saveBuffer.byteLength });
  return true;
}

function makeResult(saveType, status, operations, warnings, batteryless = null, waitstate = null, saveEmbedded = false, rtc = null, irqHandler = null) {
  const result = { save_type: saveType, status, changed: operations.length > 0, operations, warnings };
  if (batteryless !== null) result.batteryless = batteryless;
  if (waitstate !== null) result.waitstate = waitstate;
  if (rtc !== null) result.rtc = rtc;
  if (irqHandler !== null) result.irq_handler = irqHandler;
  if (saveEmbedded) result.save_embedded = true;
  return result;
}

export function patchSramBytes(inputBytes, options = {}) {
  const rom = { bytes: new Uint8Array(inputBytes) };
  const originalData = new Uint8Array(inputBytes);
  const existingFlags = readPatchFlags(originalData);
  const savePatchAlreadyApplied = hasSaveTypePatch(existingFlags);
  const batterylessAlreadyApplied = hasBatterylessPatch(existingFlags) || containsBatterylessSignature(originalData);
  const saveType = options.saveTypeOverride || findSaveType(originalData);
  const operations = [];
  const warnings = [];
  let batterylessResult = null;
  let waitstateResult = null;
  let rtcResult = null;
  let irqHandlerResult = null;
  let batterylessPayloadOffset = null;
  let rtcPayloadOffset = null;
  let waitstatePayloadOffset = null;
  let irqHandlerPayloadOffset = null;
  let rtcPlacement = null;
  let batterylessPrefixSize = 0;
  let batterylessExcludedRanges = [];
  let rtcExcludedRanges = [];
  let waitstateExcludedRanges = [];
  let irqHandlerExcludedRanges = [];
  let skipSavePatch = false;
  let sramPatchApplied = false;
  const batteryless = options.batteryless === true;
  const waitstate = options.waitstate?.enabled === true;
  const rtc = options.rtc?.enabled === true;
  const rtcAlreadyApplied = rtc && findRtcPayloadBase(originalData) !== null;
  const waitstateAlreadyApplied = waitstate && hasWaitstatePatch(existingFlags);
  const irqHandlerAlreadyApplied = findIrqHandlerPayloadBase(originalData) !== null;
  const rtcPayloadSpan = rtc && !rtcAlreadyApplied ? alignedPayloadSpan(RTC_PAYLOAD_SIZE) : 0;
  const waitstatePayloadSpan = waitstatePayloadSpanForLayout(originalData, options.waitstate, existingFlags);
  const batterylessMode = options.batterylessMode || "auto";
  const batterylessCountdown = options.batterylessCountdown ?? C.BATTERYLESS_DEFAULT_COUNTDOWN;
  const batterylessIndicatorMode = options.batterylessIndicatorMode || "off";
  const batterylessHotkeyMask = options.batterylessHotkeyMask;
  const flash1mBankSwitchStyle = normalizeFlash1mBankSwitchStyle(options.flash1mBankSwitchStyle);
  const selectedBatterylessPayload = batterylessPayloadForStyle(flash1mBankSwitchStyle);
  let activeBatterylessPayload = selectedBatterylessPayload;
  const batterylessLastBlock = normalizeBatterylessLastBlock(options.batterylessLastBlock);
  const keepBatterylessLastBlockEmpty = batterylessLastBlock === BATTERYLESS_LAST_BLOCK_KEEP_EMPTY;
  const batterylessWaitstatePrefixSize = batteryless ? waitstatePayloadSpan : 0;
  const batterylessIrqPrefixSize = batteryless && !irqHandlerAlreadyApplied ? irqHandlerPayloadSpanForLayout() : 0;

  if (batteryless && batterylessAlreadyApplied) {
    batterylessResult = { requested: true, mode: batterylessMode, status: "already_patched", countdown: batterylessCountdown, indicator_mode: batterylessIndicatorMode, flash1m_bank_switch_style: flash1mBankSwitchStyle };
    const batterylessPayloadInfo = findBatterylessPayloadInfo(rom.bytes);
    const batterylessPayloadBase = batterylessPayloadInfo?.payloadBase ?? null;
    const existingBatterylessPayload = batterylessPayloadInfo?.payload ?? selectedBatterylessPayload;
    activeBatterylessPayload = existingBatterylessPayload;
    if (batterylessPayloadBase !== null) {
      batterylessPayloadOffset = batterylessPayloadBase;
      batterylessResult.payload_offset = batterylessPayloadBase;
      batterylessResult.save_offset = batterylessSaveOffset(batterylessPayloadBase, existingBatterylessPayload);
      batterylessResult.reserved_size = C.BATTERYLESS_RESERVED_SIZE;
      batterylessResult.save_size = readU32(rom.bytes, batterylessPayloadBase + C.BATTERYLESS_SAVE_SIZE_OFFSET) || inferredBatterylessSaveSize(saveType);
      if (C.BATTERYLESS_FLUSH_SRAM !== undefined) {
        batterylessResult.flush_entry = (C.GBA_ROM_BASE + batterylessPayloadBase + C.BATTERYLESS_FLUSH_SRAM) >>> 0;
      }

      const batterylessRtcPrefixSize = rtc && !rtcAlreadyApplied ? rtcPayloadSpan : 0;
      const existingPrefixLayout = layoutPrefixBeforePayload(batterylessPayloadBase, batterylessRtcPrefixSize, batterylessWaitstatePrefixSize, batterylessIrqPrefixSize);
      if (existingPrefixLayout.prefixSize) {
        if (existingPrefixLayout.prefixBase >= 0 && isFreeRegion(rom.bytes, existingPrefixLayout.prefixBase, existingPrefixLayout.prefixSize)) {
          batterylessPrefixSize = existingPrefixLayout.prefixSize;
          batterylessExcludedRanges = [batterylessReservedRange(batterylessPayloadBase, batterylessPrefixSize, existingBatterylessPayload)];
          if (batterylessRtcPrefixSize) {
            rtcPayloadOffset = existingPrefixLayout.rtcOffset;
            rtcPlacement = "before-batteryless";
            rtcExcludedRanges = rangeForSpan(rtcPayloadOffset, batterylessRtcPrefixSize);
          }
          if (batterylessWaitstatePrefixSize) {
            waitstatePayloadOffset = existingPrefixLayout.waitstateOffset;
            waitstateExcludedRanges = rangeForSpan(waitstatePayloadOffset, batterylessWaitstatePrefixSize);
          }
          if (batterylessIrqPrefixSize) {
            irqHandlerPayloadOffset = existingPrefixLayout.irqOffset;
            irqHandlerExcludedRanges = rangeForSpan(irqHandlerPayloadOffset, batterylessIrqPrefixSize);
          }
        } else {
          batterylessExcludedRanges = [batterylessReservedRange(batterylessPayloadBase, 0, existingBatterylessPayload)];
          if (batterylessRtcPrefixSize) {
            warnings.push("RTC: no free 0x100-aligned area directly before the existing Batteryless SRAM payload");
            rtcResult = { requested: true, status: "failed", size: RTC_PAYLOAD_SIZE };
          }
          if (batterylessWaitstatePrefixSize) {
            warnings.push("Waitstate: no free 0x100-aligned area directly before the existing Batteryless SRAM payload");
            waitstateResult = { requested: true, status: "failed", value: options.waitstate?.value ?? C.WAITSTATE_DEFAULT_VALUE, direct_writes: 0 };
          }
          if (batterylessIrqPrefixSize) {
            warnings.push("Shared IRQ: no free 0x100-aligned area directly before the existing Batteryless SRAM payload");
            irqHandlerResult = { requested: true, status: "failed", size: IRQ_HANDLER_PAYLOAD_SIZE };
          }
        }
      } else {
        batterylessExcludedRanges = [batterylessReservedRange(batterylessPayloadBase, 0, existingBatterylessPayload)];
      }
    } else if (rtc && !rtcAlreadyApplied) {
      warnings.push("RTC: existing Batteryless SRAM payload could not be located for before-Batteryless placement");
      rtcResult = { requested: true, status: "failed", size: RTC_PAYLOAD_SIZE };
    }
    skipSavePatch = true;
  } else if (savePatchAlreadyApplied) {
    skipSavePatch = true;
  }

  let patchInfo = null;
  if (saveType === null) {
    if (batteryless && batterylessResult === null) {
      warnings.push("No known GBA save type found");
      batterylessResult = { requested: true, mode: batterylessMode, status: "failed", countdown: batterylessCountdown, indicator_mode: batterylessIndicatorMode };
    } else if (!waitstate && !rtc && !skipSavePatch) {
      warnings.push("No known GBA save type found");
      updateGbaHeaderChecksum(rom.bytes, operations);
      return { bytes: rom.bytes, result: makeResult(null, "unsupported", operations, warnings, batterylessResult) };
    }
  } else {
    patchInfo = PATCH_BY_SAVE_TYPE[saveType] || null;
  }

  if (saveType !== null && patchInfo === null) {
    if (batteryless && batterylessResult === null) {
      warnings.push(`${saveType} is not supported by the SRAM patcher`);
      batterylessResult = { requested: true, mode: batterylessMode, status: "failed", countdown: batterylessCountdown, indicator_mode: batterylessIndicatorMode };
    } else if (!waitstate && !rtc && !skipSavePatch) {
      warnings.push(`${saveType} is not supported by the SRAM patcher`);
      updateGbaHeaderChecksum(rom.bytes, operations);
      return { bytes: rom.bytes, result: makeResult(saveType, "unsupported", operations, warnings, batterylessResult) };
    }
  }

  if (batteryless && batterylessResult === null) {
    const batterylessRtcPrefixSize = rtc && !rtcAlreadyApplied && rtcResult === null ? rtcPayloadSpan : 0;
    const plannedLayout = ensureBatterylessLayout(rom, operations, warnings, selectedBatterylessPayload, batterylessRtcPrefixSize, batterylessWaitstatePrefixSize, batterylessIrqPrefixSize, keepBatterylessLastBlockEmpty);
    if (plannedLayout === null) {
      batterylessResult = { requested: true, mode: batterylessMode, status: "failed", countdown: batterylessCountdown, indicator_mode: batterylessIndicatorMode };
    } else {
      batterylessPayloadOffset = plannedLayout.payloadBase;
      batterylessPrefixSize = plannedLayout.prefixLayout.prefixSize;
      batterylessExcludedRanges = [batterylessReservedRange(batterylessPayloadOffset, batterylessPrefixSize, selectedBatterylessPayload)];
      if (batterylessRtcPrefixSize) {
        rtcPayloadOffset = plannedLayout.prefixLayout.rtcOffset;
        rtcPlacement = "before-batteryless";
        rtcExcludedRanges = rangeForSpan(rtcPayloadOffset, batterylessRtcPrefixSize);
      }
      if (batterylessWaitstatePrefixSize) {
        waitstatePayloadOffset = plannedLayout.prefixLayout.waitstateOffset;
        waitstateExcludedRanges = rangeForSpan(waitstatePayloadOffset, batterylessWaitstatePrefixSize);
      }
      if (batterylessIrqPrefixSize) {
        irqHandlerPayloadOffset = plannedLayout.prefixLayout.irqOffset;
        irqHandlerExcludedRanges = rangeForSpan(irqHandlerPayloadOffset, batterylessIrqPrefixSize);
      }
    }
  }

  if (patchInfo !== null && !skipSavePatch) {
    const savePatchOperationCount = operations.length;
    if (patchInfo.type === "already_sram") {
      // No save conversion is required.
    } else if (patchInfo.type === "simple") {
      applySimplePatch(originalData, rom.bytes, patchInfo, operations, warnings, flash1mBankSwitchStyle);
    } else if (patchInfo.type === "tail_trampoline") {
      applyTailTrampolinePatch(originalData, rom.bytes, patchInfo, operations, warnings, rangesWithPrefixGuard([...batterylessExcludedRanges, ...rtcExcludedRanges, ...waitstateExcludedRanges, ...irqHandlerExcludedRanges], C.TAIL_TRAMPOLINE_EXCLUDED_PREFIX_GUARD));
    } else {
      warnings.push(`${patchInfo.name}: unknown patch type`);
    }
    sramPatchApplied = operations.length > savePatchOperationCount;
  }

  if (!batteryless) {
    const plannedRtcSpan = rtc && !rtcAlreadyApplied && rtcResult === null ? rtcPayloadSpan : 0;
    const plannedWaitstateSpan = waitstate && !waitstateAlreadyApplied && waitstateResult === null ? waitstatePayloadSpan : 0;
    const addonLayout = ensureNonBatterylessAddonLayout(rom, operations, warnings, plannedRtcSpan, plannedWaitstateSpan);

    if (addonLayout === null) {
      if (plannedRtcSpan) rtcResult = { requested: true, status: "failed", size: RTC_PAYLOAD_SIZE };
      if (plannedWaitstateSpan) waitstateResult = { requested: true, status: "failed", value: options.waitstate?.value ?? C.WAITSTATE_DEFAULT_VALUE, direct_writes: 0 };
    } else {
      if (plannedRtcSpan) {
        rtcPayloadOffset = addonLayout.rtcOffset;
        rtcPlacement = "after-original-data";
        rtcExcludedRanges = rangeForSpan(rtcPayloadOffset, plannedRtcSpan);
      }
      if (plannedWaitstateSpan) {
        waitstatePayloadOffset = addonLayout.waitstateOffset;
        waitstateExcludedRanges = rangeForSpan(waitstatePayloadOffset, plannedWaitstateSpan);
      }
    }
  }

  if (rtc && rtcResult === null) {
    rtcResult = applyRtcForPipeline(rom, operations, warnings, options.rtc, {
      payloadOffset: rtcPayloadOffset,
      placement: rtcPlacement,
      excludedRanges: [...batterylessExcludedRanges, ...rtcExcludedRanges, ...waitstateExcludedRanges, ...irqHandlerExcludedRanges],
    });
  }

  if (batteryless && batterylessResult === null) {
    batterylessResult = applyBatterylessPatch(rom, operations, warnings, batterylessMode, saveType, batterylessCountdown, batterylessIndicatorMode, flash1mBankSwitchStyle, batterylessPayloadOffset, batterylessPrefixSize, keepBatterylessLastBlockEmpty);
  }

  let saveEmbedded = false;
  if (batteryless && options.saveBuffer) saveEmbedded = embedSaveFile(rom, batterylessResult, options.saveBuffer, operations);

  if (waitstateResult === null) {
    waitstateResult = applyWaitstateForPipeline(rom, operations, warnings, options.waitstate, {
      excludedRanges: [...batterylessExcludedRanges, ...rtcExcludedRanges, ...waitstateExcludedRanges, ...irqHandlerExcludedRanges],
      waitstatePayloadOffset,
      batterylessPayloadOffset,
      batterylessJustPatched: batterylessResult?.status === "patched",
    });
  }

  {
    const rtcMenuEntry = rtcResult?.runtime_menu_entry || 0;
    const batterylessFlushEntry = batterylessResult?.flush_entry || 0;
    if (irqHandlerResult === null && (rtcMenuEntry || batterylessFlushEntry)) {
      const irqExcludedRanges = [...batterylessExcludedRanges, ...rtcExcludedRanges, ...waitstateExcludedRanges, ...irqHandlerExcludedRanges];
      if (batterylessResult?.payload_offset !== undefined && batterylessResult?.payload_offset !== null) {
        irqExcludedRanges.push(batterylessReservedRange(batterylessResult.payload_offset, batterylessPrefixSize, activeBatterylessPayload));
      }
      if (rtcResult?.payload_offset !== undefined && rtcResult?.payload_offset !== null && rtcResult?.size) {
        irqExcludedRanges.push([rtcResult.payload_offset, rtcResult.payload_offset + alignedPayloadSpan(rtcResult.size)]);
      }
      if (waitstateResult?.payload_offset !== undefined && waitstateResult?.payload_offset !== null && waitstateResult?.size) {
        irqExcludedRanges.push([waitstateResult.payload_offset, waitstateResult.payload_offset + alignedPayloadSpan(waitstateResult.size)]);
      }
      irqHandlerResult = applyIrqHandlerForPipeline(rom, operations, warnings, {
        enabled: true,
        rtcMenuEntry,
        batterylessFlushEntry,
        batterylessAuto: Boolean(batterylessFlushEntry && batterylessMode === "auto"),
        countdownFrames: batterylessCountdown,
        indicatorMode: batterylessIndicatorMode,
        hotkeyMask: batterylessHotkeyMask,
      }, {
        excludedRanges: irqExcludedRanges,
        payloadOffset: irqHandlerPayloadOffset,
      });
    }
  }

  const headerSaveSize = batterylessResult && batterylessResult.status === "patched" ? batterylessResult.save_size : savePatchAlreadyApplied ? null : inferredBatterylessSaveSize(saveType);
  const headerFlags = makePatchHeaderFlags(rom.bytes, { sramPatchApplied, waitstateResult, batterylessResult, saveSize: headerSaveSize });
  applyPatchHeaderMarker(rom.bytes, operations, headerFlags);
  updateGbaHeaderChecksum(rom.bytes, operations);

  let status;
  if (operations.length) status = "patched";
  else if (batterylessResult?.status === "already_patched") status = "already_batteryless";
  else if (rtcResult?.status === "already_patched") status = "already_rtc";
  else if (savePatchAlreadyApplied) status = "already_patched";
  else if (patchInfo !== null && patchInfo.type === "already_sram") status = "already_sram";
  else if (patchInfo === null) status = "unsupported";
  else status = "unchanged";

  return { bytes: rom.bytes, result: makeResult(saveType, status, operations, warnings, batterylessResult, waitstateResult, saveEmbedded, rtcResult, irqHandlerResult) };
}
