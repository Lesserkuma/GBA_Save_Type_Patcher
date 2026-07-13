// SPDX-License-Identifier: GPL-3.0-or-later

import { asciiBytes, findBytes, hexToBytes, readU16, readU32, writeU32 } from "../core/binary.js";
import { PatchError } from "../core/errors.js";
import { PATCH_OPERATION_KIND, RTC_TICK_MODES } from "../domain/constants.js";
import { stagePatchOperation } from "../patch-engine/draft.js";
import { ensureDirectPayloadRegion, isFreeRegion, markedPayloadSpan } from "./payload-placement.js";
import { IRQ_HANDLER_CONSTANTS, IRQ_HANDLER_PAYLOAD_HEX } from "./irq-handler-data.js";

const C = IRQ_HANDLER_CONSTANTS;
const GBA_ROM_BASE = 0x08000000;
const IRQ_HANDLER_PAYLOAD = hexToBytes(IRQ_HANDLER_PAYLOAD_HEX);
const IRQ_HANDLER_ROM_MARKER_TEXT = "lk_irq_shared";
const IRQ_HANDLER_ROM_MARKER = asciiBytes(IRQ_HANDLER_ROM_MARKER_TEXT);
const IRQ_SAVE_FLUSH_ENTRY_OFFSET = C.IRQ_SAVE_FLUSH_ENTRY_OFFSET;
const IRQ_FLAG_SAVE_FLUSH = C.IRQ_FLAG_SAVE_FLUSH;
const IRQ_FLAG_SAVE_FLUSH_AUTO = C.IRQ_FLAG_SAVE_FLUSH_AUTO;
const IRQ_FLAG_SAVE_FLUSH_HOTKEY = C.IRQ_FLAG_SAVE_FLUSH_HOTKEY;
const IRQ_FLAG_RTC_VBLANK_TICK = C.IRQ_FLAG_RTC_VBLANK_TICK;
const OLD_IRQ_SLOT = hexToBytes("fc7f0003");
const ORIGINAL_IRQ_SLOT = hexToBytes("f47f0003");

export const IRQ_HANDLER_PAYLOAD_SIZE = C.IRQ_HANDLER_SIZE;

function stageIrqWrite(bytes, operations, name, offset, replacement, details = {}) {
  return stagePatchOperation(bytes, operations, {
    id: `irq-${operations.length}`,
    kind: details.kind || PATCH_OPERATION_KIND.HOOK_REPLACE,
    component: "irq",
    labelKey: details.labelKey || "operation.irq",
    offset,
    byteLength: replacement.length,
    expectedBefore: bytes.slice(offset, offset + replacement.length),
    replacement,
    metadata: {
      name,
      ...(details.codeName !== undefined ? { codeName: details.codeName } : {}),
      ...(details.value !== undefined ? { value: details.value } : {}),
    },
  });
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

function offsetInRanges(offset, ranges) {
  return ranges.some(([start, end]) => start <= offset && offset < end);
}

function decodeEntrypointAddress(bytes) {
  if (bytes.length < 4 || bytes[3] !== 0xea) throw new PatchError("Shared IRQ: unexpected entrypoint instruction");
  const branchWord = readU32(bytes, 0);
  let branchOffset = branchWord & 0x00ffffff;
  if (branchOffset & 0x00800000) branchOffset -= 0x01000000;
  return GBA_ROM_BASE + 8 + (branchOffset << 2);
}

function encodeArmBranch(sourceAddress, targetAddress) {
  const branchOffset = (targetAddress - sourceAddress - 8) >> 2;
  if (branchOffset < -0x800000 || branchOffset > 0x7fffff) throw new PatchError("Shared IRQ: entrypoint target is outside ARM branch range");
  return (0xea000000 | (branchOffset & 0x00ffffff)) >>> 0;
}

export function irqHandlerPayloadSpanForLayout() {
  return markedPayloadSpan(IRQ_HANDLER_PAYLOAD.length, IRQ_HANDLER_ROM_MARKER.length);
}

function writeIrqHandlerRomMarker(bytes, operations, payloadBase) {
  const marker = IRQ_HANDLER_ROM_MARKER;
  const markerOffset = payloadBase + IRQ_HANDLER_PAYLOAD.length;
  const markerEnd = markerOffset + marker.length;
  const paddingEnd = payloadBase + irqHandlerPayloadSpanForLayout();
  if (markerEnd > paddingEnd || markerEnd > bytes.length) {
    throw new PatchError("Shared IRQ: reserved payload span does not include the ROM marker");
  }
  if (!isFreeRegion(bytes, markerOffset, marker.length)) {
    throw new PatchError("Shared IRQ: ROM marker region is not free");
  }
  stageIrqWrite(bytes, operations, "Shared IRQ ROM marker", markerOffset, marker, {
    kind: PATCH_OPERATION_KIND.LITERAL_REPLACE,
    codeName: "shared_irq_rom_marker",
  });
  return true;
}

function hasPcRelativeLiteralReference(bytes, literalOffset) {
  const armStart = Math.max(0, literalOffset - 0x1008);
  for (let instructionOffset = literalOffset - 4; instructionOffset >= armStart; instructionOffset -= 4) {
    if (instructionOffset + 4 > bytes.length) continue;
    const instruction = readU32(bytes, instructionOffset);
    if ((instruction & 0x0e5f0000) !== 0x041f0000) continue;
    const immediate = instruction & 0x0fff;
    const target = instructionOffset + 8 + ((instruction & 0x00800000) ? immediate : -immediate);
    if (target === literalOffset) return true;
  }

  const thumbStart = Math.max(0, literalOffset - 0x404);
  for (let instructionOffset = literalOffset - 2; instructionOffset >= thumbStart; instructionOffset -= 2) {
    if (instructionOffset + 2 > bytes.length) continue;
    const instruction = readU16(bytes, instructionOffset);
    if ((instruction & 0xf800) !== 0x4800) continue;
    const target = ((instructionOffset + 4) & ~3) + ((instruction & 0xff) << 2);
    if (target === literalOffset) return true;
  }
  return false;
}

export function patchIrqVectorReferences(out, operations, excludedRanges = []) {
  let count = 0;
  let pos = 0;
  while (true) {
    const matchOffset = findAlignedMarker(out, OLD_IRQ_SLOT, pos, out.length, 4);
    if (matchOffset === null) return count;
    if (offsetInRanges(matchOffset, excludedRanges)) {
      pos = matchOffset + 4;
      continue;
    }
    if (!hasPcRelativeLiteralReference(out, matchOffset)) {
      pos = matchOffset + 4;
      continue;
    }
    stageIrqWrite(out, operations, "Shared IRQ original handler slot", matchOffset, ORIGINAL_IRQ_SLOT, {
      value: 0x03007ff4,
    });
    count += 1;
    pos = matchOffset + 4;
  }
}

function writeConfig(payload, offset, value) {
  if (offset < 0 || offset + 4 > payload.length) throw new PatchError("Shared IRQ: config offset outside payload");
  writeU32(payload, offset, value >>> 0);
}

function indicatorModeValue(indicatorMode) {
  if (indicatorMode === "countdown") return 1;
  if (indicatorMode === "save") return 2;
  return 0;
}

function hotkeyMaskValue(hotkeyMask) {
  return Number.isInteger(hotkeyMask) ? hotkeyMask & 0x03ff : C.IRQ_HOTKEY_MASK;
}

function rtcTickModeValue(options) {
  if (!options.rtcMenuEntry) return null;
  return options.rtcTickMode === RTC_TICK_MODES.READ
    ? RTC_TICK_MODES.READ
    : RTC_TICK_MODES.VBLANK;
}

function irqFlags(options) {
  const saveFlushEntry = options.saveFlushEntry ?? 0;
  const saveFlushAuto = options.saveFlushAuto ?? false;
  const saveFlushHotkey = options.saveFlushHotkey ?? Boolean(saveFlushEntry);
  const rtcTickMode = rtcTickModeValue(options);
  return (
    (options.rtcMenuEntry ? C.IRQ_FLAG_RTC : 0)
    | (options.rtcMenuEntry && rtcTickMode === RTC_TICK_MODES.VBLANK ? IRQ_FLAG_RTC_VBLANK_TICK : 0)
    | (saveFlushEntry ? IRQ_FLAG_SAVE_FLUSH : 0)
    | (saveFlushEntry && saveFlushAuto ? IRQ_FLAG_SAVE_FLUSH_AUTO : 0)
    | (saveFlushEntry && saveFlushHotkey ? IRQ_FLAG_SAVE_FLUSH_HOTKEY : 0)
  ) >>> 0;
}

function saveFlushEntryValue(options) {
  return (options.saveFlushEntry ?? 0) >>> 0;
}

function configuredIrqPayload(bytes, payloadBase, options) {
  const originalEntrypoint = decodeEntrypointAddress(bytes);
  const payload = new Uint8Array(IRQ_HANDLER_PAYLOAD);
  const payloadAddress = (GBA_ROM_BASE + payloadBase) >>> 0;
  const rtcTickMode = rtcTickModeValue(options);
  const handlerOffset = rtcTickMode === RTC_TICK_MODES.VBLANK
    ? C.IRQ_HANDLER_CONTINUOUS_OFFSET
    : C.IRQ_HANDLER_OFFSET;
  const handlerAddress = (payloadAddress + handlerOffset) >>> 0;
  const bootstrapAddress = (payloadAddress + C.IRQ_BOOTSTRAP_OFFSET) >>> 0;
  const flags = irqFlags(options);
  const hotkeyMask = hotkeyMaskValue(options.hotkeyMask);
  const saveFlushEntry = saveFlushEntryValue(options);
  writeConfig(payload, C.IRQ_ORIGINAL_ENTRYPOINT_OFFSET, originalEntrypoint);
  writeConfig(payload, C.IRQ_FLAGS_OFFSET, flags);
  writeConfig(payload, C.IRQ_RTC_MENU_ENTRY_OFFSET, options.rtcMenuEntry || 0);
  writeConfig(payload, IRQ_SAVE_FLUSH_ENTRY_OFFSET, saveFlushEntry);
  writeConfig(payload, C.IRQ_COUNTDOWN_FRAMES_OFFSET, options.countdownFrames || 0);
  writeConfig(payload, C.IRQ_INDICATOR_MODE_OFFSET, indicatorModeValue(options.indicatorMode));
  writeConfig(payload, C.IRQ_HOTKEY_MASK_OFFSET, hotkeyMask);
  writeConfig(payload, C.IRQ_HANDLER_ENTRY_OFFSET, handlerAddress);
  return {
    payload,
    payloadAddress,
    handlerAddress,
    bootstrapAddress,
    originalEntrypoint,
    flags,
    hotkeyMask,
    saveFlushEntry,
    rtcTickMode,
  };
}

function installedIrqResult(payloadBase, configured, irqReferences) {
  return {
    requested: true,
    status: "patched",
    payloadOffset: payloadBase,
    runtimeBase: configured.payloadAddress,
    size: IRQ_HANDLER_PAYLOAD.length,
    payloadSpan: irqHandlerPayloadSpanForLayout(),
    flags: configured.flags,
    saveFlushEntry: configured.saveFlushEntry,
    rtcTickMode: configured.rtcTickMode,
    handlerEntry: configured.handlerAddress,
    bootstrapEntry: configured.bootstrapAddress,
    originalEntrypoint: configured.originalEntrypoint,
    hotkeyMask: configured.hotkeyMask,
    irqReferences,
  };
}

function installIrqHandler(rom, operations, warnings, options, context) {
  const previousOperationCount = operations.length;
  const localOperations = [...operations];
  const localWarnings = [];
  const workRom = { bytes: new Uint8Array(rom.bytes) };
  const excludedRanges = [...(context.excludedRanges || [])];
  try {
    const payloadSpan = irqHandlerPayloadSpanForLayout();
    const payloadBase = context.payloadOffset ?? ensureDirectPayloadRegion(
      workRom,
      localOperations,
      localWarnings,
      payloadSpan,
      "Shared IRQ",
      excludedRanges,
    );
    if (payloadBase === null) {
      warnings.push(...localWarnings);
      return { requested: true, status: "failed", size: IRQ_HANDLER_PAYLOAD.length };
    }
    excludedRanges.push([payloadBase, payloadBase + payloadSpan]);
    if (payloadBase + IRQ_HANDLER_PAYLOAD.length > workRom.bytes.length) {
      throw new PatchError("Shared IRQ: payload placement is outside the ROM");
    }
    const configured = configuredIrqPayload(workRom.bytes, payloadBase, options);
    stageIrqWrite(workRom.bytes, localOperations, "Shared IRQ payload", payloadBase, configured.payload, {
      kind: PATCH_OPERATION_KIND.PAYLOAD_INSTALL,
      codeName: "shared_irq_handler",
      value: configured.payloadAddress,
    });
    writeIrqHandlerRomMarker(workRom.bytes, localOperations, payloadBase);
    const entrypointBranch = encodeArmBranch(GBA_ROM_BASE, configured.bootstrapAddress);
    const entrypointBytes = new Uint8Array(4);
    writeU32(entrypointBytes, 0, entrypointBranch);
    stageIrqWrite(workRom.bytes, localOperations, "Shared IRQ Entrypoint", 0, entrypointBytes, {
      value: entrypointBranch,
    });
    const irqReferences = patchIrqVectorReferences(
      workRom.bytes,
      localOperations,
      excludedRanges,
    );
    rom.bytes = workRom.bytes;
    operations.push(...localOperations.slice(previousOperationCount));
    warnings.push(...localWarnings);
    return installedIrqResult(payloadBase, configured, irqReferences);
  } catch (error) {
    localWarnings.push(error.message || String(error));
    warnings.push(...localWarnings);
    return { requested: true, status: "failed", size: IRQ_HANDLER_PAYLOAD.length };
  }
}

export function applyIrqHandlerForPipeline(rom, operations, warnings, options = {}, context = {}) {
  if (!options.enabled) return null;
  return installIrqHandler(rom, operations, warnings, options, context);
}
