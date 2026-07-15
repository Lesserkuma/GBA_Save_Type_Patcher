// SPDX-License-Identifier: GPL-3.0-or-later AND MIT

import {
  findBytes,
  hexToBytes,
  readU32,
  writeU32,
} from "../core/binary.js";
import { PatchError } from "../core/errors.js";
import { PATCH_OPERATION_KIND } from "../domain/constants.js";
import { stageRomExpansion } from "../patch-engine/draft.js";
import {
  PAYLOAD_ALIGNMENT,
  ensureDirectPayloadRegion,
  overlapsPowerOfTwoTailBlock,
} from "./payload-placement.js";
import {
  BATTERYLESS_ARM_BRANCH_THUNK_HEX,
  BATTERYLESS_EEPROM_V111_EPILOGUE_PATCH_HEX,
  BATTERYLESS_FLASH1M_BANK_SWITCH_THUNK_HEX,
  BATTERYLESS_PAYLOAD_GBATA_HEX,
  BATTERYLESS_PAYLOAD_HEX,
  BATTERYLESS_THUMB_BRANCH_THUNK_HEX,
  BATTERYLESS_WRITE_HOOKS,
  FLASH1M_BANK_SWITCH_GBATA_PATCH_HEX,
  FLASH1M_BANK_SWITCH_MODERN_PATCH_HEX,
  SRAM_CONSTANTS,
} from "./sram-data.js";
import {
  alignDown,
  alignUp,
  findAlignedMarker,
  isFreeByte,
  isFreeRegion,
  rangesOverlap,
  stageSramWrite,
} from "./sram-common.js";
import { buildEepromV12xWriteCompatHook } from "./eeprom-v12x-write-compat.js";

const C = SRAM_CONSTANTS;
const BATTERYLESS_PAYLOAD_MODERN = hexToBytes(BATTERYLESS_PAYLOAD_HEX);
const BATTERYLESS_PAYLOAD_GBATA = hexToBytes(BATTERYLESS_PAYLOAD_GBATA_HEX);
const BATTERYLESS_PAYLOAD = BATTERYLESS_PAYLOAD_MODERN;
const BATTERYLESS_THUMB_BRANCH_THUNK = hexToBytes(BATTERYLESS_THUMB_BRANCH_THUNK_HEX);
const BATTERYLESS_ARM_BRANCH_THUNK = hexToBytes(BATTERYLESS_ARM_BRANCH_THUNK_HEX);
const BATTERYLESS_EEPROM_V111_EPILOGUE_PATCH = hexToBytes(BATTERYLESS_EEPROM_V111_EPILOGUE_PATCH_HEX);
const BATTERYLESS_FLASH1M_BANK_SWITCH_THUNK = hexToBytes(BATTERYLESS_FLASH1M_BANK_SWITCH_THUNK_HEX);
export const FLASH1M_BANK_SWITCH_STYLE_MODERN = "modern";
const FLASH1M_BANK_SWITCH_STYLE_GBATA = "gbata";
const BATTERYLESS_LAST_BLOCK_USABLE = "usable";
export const BATTERYLESS_LAST_BLOCK_KEEP_EMPTY = "keep-empty";
const FLASH1M_BANK_SWITCH_PATCH_HEX_BY_STYLE = {
  [FLASH1M_BANK_SWITCH_STYLE_MODERN]: FLASH1M_BANK_SWITCH_MODERN_PATCH_HEX,
  [FLASH1M_BANK_SWITCH_STYLE_GBATA]: FLASH1M_BANK_SWITCH_GBATA_PATCH_HEX,
};
const FLASH1M_BANK_SWITCH_MODERN_PATCH = hexToBytes(FLASH1M_BANK_SWITCH_MODERN_PATCH_HEX);
const FLASH1M_BANK_SWITCH_GBATA_PATCH = hexToBytes(FLASH1M_BANK_SWITCH_GBATA_PATCH_HEX);
const FLASH1M_BANK_SWITCH_PATCHES = [
  FLASH1M_BANK_SWITCH_MODERN_PATCH,
  FLASH1M_BANK_SWITCH_GBATA_PATCH,
];
const FLASH1M_SWITCH_BANK_CODE_NAMES = new Set([
  "flash1m_v102_switch_bank",
  "flash1m_v103_switch_bank",
]);
const FLASH1M_SRAM_BANK_SELECT_ROM_OFFSET = 0x01000000;
const BATTERYLESS_PAYLOAD_BY_STYLE = {
  [FLASH1M_BANK_SWITCH_STYLE_MODERN]: BATTERYLESS_PAYLOAD_MODERN,
  [FLASH1M_BANK_SWITCH_STYLE_GBATA]: BATTERYLESS_PAYLOAD_GBATA,
};
const hexPatternCache = new Map();

function hexPattern(hex) {
  let pattern = hexPatternCache.get(hex);
  if (!pattern) {
    pattern = hexToBytes(hex);
    hexPatternCache.set(hex, pattern);
  }
  return pattern;
}

export function normalizeFlash1mBankSwitchStyle(style) {
  return style === FLASH1M_BANK_SWITCH_STYLE_GBATA
    ? FLASH1M_BANK_SWITCH_STYLE_GBATA
    : FLASH1M_BANK_SWITCH_STYLE_MODERN;
}

export function batterylessPayloadForStyle(style) {
  return BATTERYLESS_PAYLOAD_BY_STYLE[normalizeFlash1mBankSwitchStyle(style)];
}

export function normalizeBatterylessLastBlock(lastBlock) {
  return lastBlock === BATTERYLESS_LAST_BLOCK_KEEP_EMPTY
    ? BATTERYLESS_LAST_BLOCK_KEEP_EMPTY
    : BATTERYLESS_LAST_BLOCK_USABLE;
}

function isFlash1mSwitchBankWrite(writeInfo) {
  return FLASH1M_SWITCH_BANK_CODE_NAMES.has(writeInfo?.code_name);
}

export function resolveFlash1mBankSwitchWriteInfo(writeInfo, style) {
  if (!isFlash1mSwitchBankWrite(writeInfo)) return writeInfo;
  return {
    ...writeInfo,
    hex: FLASH1M_BANK_SWITCH_PATCH_HEX_BY_STYLE[normalizeFlash1mBankSwitchStyle(style)],
  };
}

export function batterylessSaveOffset(payloadBase, payload = BATTERYLESS_PAYLOAD) {
  return alignUp(payloadBase + payload.length, C.BATTERYLESS_REGION_ALIGNMENT);
}

function batterylessSaveRangeHitsFlash1mBankSelect(saveOffset, size = C.BATTERYLESS_RESERVED_SIZE) {
  const end = saveOffset + size;
  return saveOffset <= FLASH1M_SRAM_BANK_SELECT_ROM_OFFSET && FLASH1M_SRAM_BANK_SELECT_ROM_OFFSET < end;
}

function overlapsBatterylessPowerBoundaryGuard(start, end) {
  return overlapsPowerOfTwoTailBlock(
    start,
    end,
    C.BATTERYLESS_RESERVED_SIZE,
    C.GBA_MAX_ROM_SIZE,
  );
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

function batterylessPayloadFitsAtBlockEnd(bytes, blockStart, payload = BATTERYLESS_PAYLOAD, prefixSize = 0, keepLastBlockEmpty = false, excludedRanges = []) {
  const blockEnd = blockStart + C.BATTERYLESS_REGION_ALIGNMENT;
  const payloadBase = blockEnd - payload.length;
  const prefixBase = payloadBase - prefixSize;
  const saveOffset = blockEnd;
  const regionEnd = saveOffset + C.BATTERYLESS_RESERVED_SIZE;

  if (prefixBase < 0 || regionEnd > bytes.length) return null;
  if (batterylessSaveRangeHitsFlash1mBankSelect(saveOffset)) return null;
  if (keepLastBlockEmpty && overlapsBatterylessPowerBoundaryGuard(prefixBase, regionEnd)) return null;
  if (rangesOverlap(prefixBase, regionEnd, excludedRanges)) return null;
  if (prefixSize && !isFreeRegion(bytes, prefixBase, prefixSize)) return null;
  if (!isFreeRegion(bytes, payloadBase, payload.length)) return null;
  if (!isFreeRegion(bytes, saveOffset, C.BATTERYLESS_RESERVED_SIZE)) return null;
  return payloadBase;
}

function findBatterylessFreeRegion(bytes, payload = BATTERYLESS_PAYLOAD, prefixSize = 0, keepLastBlockEmpty = false, excludedRanges = []) {
  const lastContentBlock = lastNonEmptyBatterylessBlockStart(bytes);
  if (lastContentBlock === null) return null;

  let blockStart = lastContentBlock;
  while (blockStart + C.BATTERYLESS_REGION_ALIGNMENT * 2 <= bytes.length) {
    const payloadBase = batterylessPayloadFitsAtBlockEnd(bytes, blockStart, payload, prefixSize, keepLastBlockEmpty, excludedRanges);
    if (payloadBase !== null) return payloadBase;
    blockStart += C.BATTERYLESS_REGION_ALIGNMENT;
  }
  return null;
}

function stageBatterylessExpansion(rom, operations, oldSize, newSize) {
  const byteLength = newSize - oldSize;
  const erasedBytes = new Uint8Array(byteLength).fill(0xff);
  stageRomExpansion(rom, operations, {
    id: `batteryless-expand-${operations.length}`,
    kind: PATCH_OPERATION_KIND.ROM_EXPAND,
    component: "batteryless",
    offset: oldSize,
    byteLength,
    expectedBefore: erasedBytes,
    replacement: new Uint8Array(erasedBytes),
    labelKey: "operation.romExpand",
    metadata: {
      name: "Batteryless SRAM ROM expansion",
      value: newSize,
    },
  });
}

function ensureBatterylessRegion(rom, operations, warnings, payload = BATTERYLESS_PAYLOAD, prefixSize = 0, keepLastBlockEmpty = false, excludedRanges = []) {
  while (true) {
    if (rom.bytes.length > C.GBA_MAX_ROM_SIZE) {
      warnings.push("Batteryless SRAM: ROM is larger than 32 MiB");
      return null;
    }
    const payloadBase = findBatterylessFreeRegion(rom.bytes, payload, prefixSize, keepLastBlockEmpty, excludedRanges);
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
    stageBatterylessExpansion(rom, operations, oldSize, newSize);
  }
}

export function layoutPrefixBeforePayload(payloadBase, rtcSpan = 0, waitstateSpan = 0, irqSpan = 0) {
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

export function rangeForSpan(offset, span) {
  return span > 0 && offset !== null && offset !== undefined ? [[offset, offset + span]] : [];
}

export function ensureNonBatterylessAddonLayout(rom, operations, warnings, rtcSpan, waitstateSpan, excludedRanges = []) {
  const totalSpan = rtcSpan + waitstateSpan;
  if (totalSpan <= 0) return { base: null, rtcOffset: null, waitstateOffset: null, totalSpan: 0 };

  const label = rtcSpan && waitstateSpan ? "RTC/Waitstate" : rtcSpan ? "RTC" : "Waitstate";
  const base = ensureDirectPayloadRegion(rom, operations, warnings, totalSpan, label, excludedRanges);
  if (base === null) return null;

  return {
    base,
    rtcOffset: rtcSpan ? base : null,
    waitstateOffset: waitstateSpan ? base + rtcSpan : null,
    totalSpan,
  };
}

function batterylessLayoutFitsAtBlockEnd(
  bytes,
  blockStart,
  payload = BATTERYLESS_PAYLOAD,
  rtcSpan = 0,
  waitstateSpan = 0,
  irqSpan = 0,
  keepLastBlockEmpty = false,
  excludedRanges = [],
) {
  const blockEnd = blockStart + C.BATTERYLESS_REGION_ALIGNMENT;
  const payloadBase = blockEnd - payload.length;
  const prefixLayout = layoutPrefixBeforePayload(payloadBase, rtcSpan, waitstateSpan, irqSpan);
  const prefixBase = prefixLayout.prefixBase;
  const saveOffset = blockEnd;
  const regionEnd = saveOffset + C.BATTERYLESS_RESERVED_SIZE;

  if (prefixBase < 0 || regionEnd > bytes.length) return null;
  if (batterylessSaveRangeHitsFlash1mBankSelect(saveOffset)) return null;
  if (keepLastBlockEmpty && overlapsBatterylessPowerBoundaryGuard(prefixBase, regionEnd)) return null;
  if (rangesOverlap(prefixBase, regionEnd, excludedRanges)) return null;
  if (prefixLayout.prefixSize && !isFreeRegion(bytes, prefixBase, prefixLayout.prefixSize)) return null;
  if (!isFreeRegion(bytes, payloadBase, payload.length)) return null;
  if (!isFreeRegion(bytes, saveOffset, C.BATTERYLESS_RESERVED_SIZE)) return null;
  return { payloadBase, prefixLayout };
}

function findBatterylessFreeLayout(
  bytes,
  payload = BATTERYLESS_PAYLOAD,
  rtcSpan = 0,
  waitstateSpan = 0,
  irqSpan = 0,
  keepLastBlockEmpty = false,
  excludedRanges = [],
) {
  const lastContentBlock = lastNonEmptyBatterylessBlockStart(bytes);
  if (lastContentBlock === null) return null;

  let blockStart = lastContentBlock;
  while (blockStart + C.BATTERYLESS_REGION_ALIGNMENT * 2 <= bytes.length) {
    const layout = batterylessLayoutFitsAtBlockEnd(bytes, blockStart, payload, rtcSpan, waitstateSpan, irqSpan, keepLastBlockEmpty, excludedRanges);
    if (layout !== null) return layout;
    blockStart += C.BATTERYLESS_REGION_ALIGNMENT;
  }
  return null;
}

export function ensureBatterylessLayout(
  rom,
  operations,
  warnings,
  payload = BATTERYLESS_PAYLOAD,
  rtcSpan = 0,
  waitstateSpan = 0,
  irqSpan = 0,
  keepLastBlockEmpty = false,
  excludedRanges = [],
) {
  while (true) {
    if (rom.bytes.length > C.GBA_MAX_ROM_SIZE) {
      warnings.push("Batteryless SRAM: ROM is larger than 32 MiB");
      return null;
    }
    const layout = findBatterylessFreeLayout(rom.bytes, payload, rtcSpan, waitstateSpan, irqSpan, keepLastBlockEmpty, excludedRanges);
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
    stageBatterylessExpansion(rom, operations, oldSize, newSize);
  }
}

function batterylessReservedRange(payloadBase, prefixSize = 0, payload = BATTERYLESS_PAYLOAD) {
  return [payloadBase - prefixSize, batterylessSaveOffset(payloadBase, payload) + C.BATTERYLESS_RESERVED_SIZE];
}

export function batterylessPatchExcludedRanges(payloadBase, prefixSize = 0, payload = BATTERYLESS_PAYLOAD, saveSize = null) {
  const saveOffset = batterylessSaveOffset(payloadBase, payload);
  return [[payloadBase - prefixSize, saveOffset + C.BATTERYLESS_RESERVED_SIZE]];
}

export function inferredBatterylessSaveSize(saveType) {
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
  const replacement = new Uint8Array(8);
  replacement.set(BATTERYLESS_THUMB_BRANCH_THUNK);
  writeU32(replacement, 4, targetAddress);
  stageSramWrite(out, operations, `Batteryless SRAM ${name}`, offset, replacement, {
    codeName: "batteryless_thumb_hook",
    value: targetAddress >>> 0,
  });
}

function writeBatterylessEepromV12xCompatHook(out, offset, targetAddress, operations, name) {
  const compat = buildEepromV12xWriteCompatHook(out, offset, targetAddress, C.GBA_ROM_BASE);
  if (compat === null) return false;
  stageSramWrite(out, operations, `Batteryless SRAM ${name} SDK timer compatibility`, offset, compat.replacement, {
    codeName: "batteryless_eeprom_v12x_compat_hook",
    value: targetAddress >>> 0,
  });
  return true;
}

function writeBatterylessArmHook(out, offset, targetAddress, operations, name) {
  if (offset < 0 || offset + 12 > out.length) throw new PatchError(`Batteryless ARM hook is outside the ROM: 0x${offset.toString(16)}`);
  const replacement = new Uint8Array(12);
  replacement.set(BATTERYLESS_ARM_BRANCH_THUNK);
  writeU32(replacement, 8, targetAddress);
  stageSramWrite(out, operations, `Batteryless SRAM ${name}`, offset, replacement, {
    codeName: "batteryless_arm_hook",
    value: targetAddress >>> 0,
  });
}

function writeBatterylessEepromV111Hook(out, offset, targetAddress, operations, name) {
  const patchOffset = offset + 0x0c;
  const pointerOffset = offset + 0x2c;
  if (patchOffset < 0 || pointerOffset + 4 > out.length) throw new PatchError(`Batteryless EEPROM hook is outside the ROM: 0x${offset.toString(16)}`);
  const targetBytes = new Uint8Array(4);
  writeU32(targetBytes, 0, targetAddress);
  stageSramWrite(out, operations, `Batteryless SRAM ${name}`, patchOffset, BATTERYLESS_EEPROM_V111_EPILOGUE_PATCH, {
    codeName: "batteryless_eeprom_v111_epilogue",
    value: targetAddress >>> 0,
  });
  stageSramWrite(out, operations, `Batteryless SRAM ${name} target`, pointerOffset, targetBytes, {
    value: targetAddress >>> 0,
  });
}

function patchBatterylessWriteHooks(
  out,
  payloadBase,
  mode,
  saveType,
  operations,
  warnings,
  prefixSize = 0,
  payload = BATTERYLESS_PAYLOAD,
  knownSaveSize = null,
) {
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
        const usedEepromCompatHook = (
          hook.target === "eeprom"
          && hook.thunk === "thumb"
          && writeBatterylessEepromV12xCompatHook(out, matchOffset, targetAddress, operations, hook.name)
        );
        if (!usedEepromCompatHook) {
          if (hook.thunk === "thumb") writeBatterylessThumbHook(out, matchOffset, targetAddress, operations, hook.name);
          else if (hook.thunk === "arm") writeBatterylessArmHook(out, matchOffset, targetAddress, operations, hook.name);
          else if (hook.thunk === "eeprom_v111_epilogue") writeBatterylessEepromV111Hook(out, matchOffset, targetAddress, operations, hook.name);
          else throw new PatchError(`Unknown Batteryless hook type: ${hook.thunk}`);
        }
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
  if (knownSaveSize !== null) saveSize = knownSaveSize;
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
      stageSramWrite(out, operations, "Batteryless SRAM FLASH1M bank switch via RAM", matchOffset, patch, {
        kind: PATCH_OPERATION_KIND.BANK_SWITCH_PATCH,
        codeName: "batteryless_flash1m_bank_switch",
        value: targetAddress,
      });
      count += 1;
      pos = matchOffset + patch.length;
    }
  }
  return count;
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

function makeBatterylessPayload(
  originalEntrypoint,
  mode,
  saveSize,
  countdown,
  storageMode,
  indicatorMode,
  flash1mBankSwitchStyle = FLASH1M_BANK_SWITCH_STYLE_MODERN,
  rtcPersistEntry = 0,
) {
  if (countdown < 0 || countdown > 0xff) throw new PatchError("Batteryless SRAM: delay value must be between 0 and 255");
  if (!(indicatorMode in C.BATTERYLESS_INDICATOR_MODE_VALUES)) throw new PatchError("Batteryless SRAM: unknown indicator mode");
  const bankSwitchStyle = normalizeFlash1mBankSwitchStyle(flash1mBankSwitchStyle);
  const payload = new Uint8Array(batterylessPayloadForStyle(bankSwitchStyle));
  writeU32(payload, C.BATTERYLESS_ORIGINAL_ENTRYPOINT_OFFSET, originalEntrypoint >>> 0);
  writeU32(payload, C.BATTERYLESS_FLUSH_MODE_OFFSET, mode === "auto" ? 0 : 1);
  writeU32(payload, C.BATTERYLESS_SAVE_SIZE_OFFSET, saveSize >>> 0);
  writeU32(payload, C.BATTERYLESS_STORAGE_MODE_OFFSET, storageMode >>> 0);
  writeU32(payload, C.BATTERYLESS_INDICATOR_MODE_OFFSET, C.BATTERYLESS_INDICATOR_MODE_VALUES[indicatorMode] >>> 0);
  if (C.BATTERYLESS_RTC_PERSIST_ENTRY_OFFSET === undefined) {
    if (rtcPersistEntry) throw new PatchError("Batteryless SRAM: payload does not expose the Fake-RTC persistence ABI");
  } else {
    writeU32(payload, C.BATTERYLESS_RTC_PERSIST_ENTRY_OFFSET, rtcPersistEntry >>> 0);
  }
  payload[C.BATTERYLESS_COUNTDOWN_IMMEDIATE_OFFSET] = countdown & 0xff;
  return payload;
}

function batterylessFailure(mode, countdown, indicatorMode, details = {}) {
  return {
    requested: true,
    mode,
    status: "failed",
    countdown,
    indicatorMode,
    ...details,
  };
}

function resolveBatterylessPayloadBase(context) {
  if (context.payloadBase === null) {
    return ensureBatterylessRegion(
      context.workRom,
      context.operations,
      context.warnings,
      context.payload,
      0,
      context.keepLastBlockEmpty,
    );
  }
  const saveOffset = batterylessSaveOffset(context.payloadBase, context.payload);
  const reservedStart = context.payloadBase - context.prefixSize;
  const reservedEnd = saveOffset + C.BATTERYLESS_RESERVED_SIZE;
  const invalid = (
    context.keepLastBlockEmpty
      && overlapsBatterylessPowerBoundaryGuard(reservedStart, reservedEnd)
  ) || !isFreeRegion(context.workRom.bytes, context.payloadBase, context.payload.length)
    || !isFreeRegion(context.workRom.bytes, saveOffset, C.BATTERYLESS_RESERVED_SIZE);
  if (invalid) context.warnings.push("Batteryless SRAM: reserved area is no longer free");
  return context.payloadBase;
}

function installBatterylessCore(context) {
  const originalEntrypoint = decodeEntrypointAddress(context.workRom.bytes);
  const hookResult = patchBatterylessWriteHooks(
    context.workRom.bytes,
    context.payloadBase,
    context.mode,
    context.saveType,
    context.operations,
    context.warnings,
    context.prefixSize,
    context.payload,
    context.knownSaveSize,
  );
  if (hookResult.saveSize === null) return { hookResult, failed: true };
  const newEntrypoint = C.GBA_ROM_BASE
    + context.payloadBase
    + C.BATTERYLESS_PATCHED_ENTRYPOINT;
  const entrypointBranch = encodeArmBranch(C.GBA_ROM_BASE, newEntrypoint);
  const entrypointReplacement = new Uint8Array(4);
  writeU32(entrypointReplacement, 0, entrypointBranch);
  stageSramWrite(context.workRom.bytes, context.operations, "Batteryless SRAM Entrypoint", 0, entrypointReplacement, {
    value: entrypointBranch,
  });
  const payload = makeBatterylessPayload(
    originalEntrypoint,
    context.mode,
    hookResult.saveSize,
    context.countdown,
    hookResult.storageMode,
    context.indicatorMode,
    context.style,
    context.rtcPersistEntry,
  );
  stageSramWrite(context.workRom.bytes, context.operations, "Batteryless SRAM Payload", context.payloadBase, payload, {
    kind: PATCH_OPERATION_KIND.PAYLOAD_INSTALL,
    codeName: "batteryless_payload",
  });
  const bankSwitches = patchBatterylessFlash1mBankSwitch(
    context.workRom.bytes,
    context.payloadBase,
    context.saveType,
    context.operations,
    context.prefixSize,
    context.payload,
  );
  if (!isFreeRegion(context.workRom.bytes, context.saveOffset, C.BATTERYLESS_RESERVED_SIZE)) {
    context.warnings.push("Batteryless SRAM: save area is not free");
    return { hookResult, failed: true };
  }
  const erasedSaveArea = new Uint8Array(C.BATTERYLESS_RESERVED_SIZE).fill(0xff);
  stageSramWrite(
    context.workRom.bytes,
    context.operations,
    "Batteryless SRAM save area initialized",
    context.saveOffset,
    erasedSaveArea,
    { kind: PATCH_OPERATION_KIND.CONFIG_WRITE, value: 0xff },
  );
  return { hookResult, bankSwitches, failed: false };
}

function completedBatterylessResult(context, installed) {
  return {
    requested: true,
    mode: context.mode,
    status: "patched",
    payloadOffset: context.payloadBase,
    saveOffset: context.saveOffset,
    reservedSize: C.BATTERYLESS_RESERVED_SIZE,
    saveSize: installed.hookResult.saveSize,
    storageMode: installed.hookResult.storageMode,
    flushEntry: C.BATTERYLESS_FLUSH_SRAM === undefined
      ? null
      : (C.GBA_ROM_BASE + context.payloadBase + C.BATTERYLESS_FLUSH_SRAM) >>> 0,
    initEntry: C.BATTERYLESS_INITIALIZE_SRAM === undefined
      ? null
      : (C.GBA_ROM_BASE + context.payloadBase + C.BATTERYLESS_INITIALIZE_SRAM) >>> 0,
    rtcPersistEntry: context.rtcPersistEntry || null,
    countdown: context.countdown,
    indicatorMode: context.indicatorMode,
    hooks: installed.hookResult.hooksFound,
    flash1mBankSwitches: installed.bankSwitches,
    flash1mBankSwitchStyle: normalizeFlash1mBankSwitchStyle(context.style),
  };
}

export function applyBatterylessPatch(
  rom,
  operations,
  warnings,
  mode,
  saveType,
  countdown,
  indicatorMode,
  flash1mBankSwitchStyle = FLASH1M_BANK_SWITCH_STYLE_MODERN,
  payloadBase = null,
  prefixSize = 0,
  keepLastBlockEmpty = false,
  knownSaveSize = null,
  rtcPersistEntry = 0,
) {
  const selectedPayload = batterylessPayloadForStyle(flash1mBankSwitchStyle);
  const previousOperationCount = operations.length;
  const baseContext = {
    mode,
    saveType,
    countdown,
    indicatorMode,
    style: flash1mBankSwitchStyle,
    rtcPersistEntry: rtcPersistEntry >>> 0,
  };
  const context = {
    ...baseContext,
    workRom: { bytes: new Uint8Array(rom.bytes) },
    operations: [...operations],
    warnings: [],
    payload: selectedPayload,
    payloadBase,
    prefixSize,
    keepLastBlockEmpty,
    knownSaveSize,
  };
  context.payloadBase = resolveBatterylessPayloadBase(context);
  if (context.payloadBase === null || context.warnings.length) {
    warnings.push(...context.warnings);
    return batterylessFailure(mode, countdown, indicatorMode);
  }
  context.saveOffset = batterylessSaveOffset(context.payloadBase, selectedPayload);
  try {
    const installed = installBatterylessCore(context);
    if (installed.failed) {
      warnings.push(...context.warnings);
      return batterylessFailure(mode, countdown, indicatorMode, {
        payloadOffset: context.payloadBase,
        saveOffset: context.saveOffset,
      });
    }
    rom.bytes = context.workRom.bytes;
    operations.push(...context.operations.slice(previousOperationCount));
    warnings.push(...context.warnings);
    return completedBatterylessResult(context, installed);
  } catch (error) {
    context.warnings.push(error.message);
    warnings.push(...context.warnings);
    return batterylessFailure(mode, countdown, indicatorMode, {
      payloadOffset: context.payloadBase,
      saveOffset: context.saveOffset,
    });
  }
}

export function embedSaveFile(rom, batterylessResult, saveBuffer, operations) {
  if (!saveBuffer) return false;
  if (!batterylessResult || batterylessResult.status !== "patched") throw new PatchError("Save data can only be embedded after a Batteryless SRAM patch.");
  const saveOffset = batterylessResult.saveOffset;
  const saveSize = batterylessResult.saveSize ?? batterylessResult.reservedSize ?? C.BATTERYLESS_RESERVED_SIZE;
  if (saveOffset === undefined || saveOffset === null) throw new PatchError("Batteryless SRAM save block was not found.");
  if (saveBuffer.byteLength !== saveSize) {
    throw new PatchError(`Save file must be exactly ${saveSize} bytes.`, {
      code: "SAVE_SIZE_MISMATCH",
      stage: "saveEmbed",
      context: { expectedBytes: saveSize, actualBytes: saveBuffer.byteLength },
      isRecoverable: true,
    });
  }
  if (saveOffset + saveSize > rom.bytes.length) throw new PatchError("Batteryless SRAM save block is outside the ROM.");
  const saveReplacement = new Uint8Array(saveSize).fill(0xff);
  saveReplacement.set(new Uint8Array(saveBuffer));
  stageSramWrite(rom.bytes, operations, "Embedded save data", saveOffset, saveReplacement, {
    kind: PATCH_OPERATION_KIND.SAVE_EMBED,
    value: saveBuffer.byteLength,
    allowOverlap: true,
  });
  return true;
}
