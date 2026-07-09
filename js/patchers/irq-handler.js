import { asciiBytes, copyBytes, findBytes, hexToBytes, readU32, startsWithBytes, writeU32 } from "../core/binary.js";
import { PatchError } from "../core/errors.js";
import { alignedPayloadSpan, ensureDirectPayloadRegion, isFreeRegion } from "./payload-placement.js";
import { IRQ_HANDLER_CONSTANTS, IRQ_HANDLER_PAYLOAD_HEX } from "./irq-handler-data.js";

const C = IRQ_HANDLER_CONSTANTS;
const GBA_ROM_BASE = 0x08000000;
const IRQ_HANDLER_PAYLOAD = hexToBytes(IRQ_HANDLER_PAYLOAD_HEX);
const IRQ_HANDLER_MARKER = IRQ_HANDLER_PAYLOAD.slice(C.IRQ_CONFIG_MAGIC_OFFSET, C.IRQ_CONFIG_MAGIC_OFFSET + 4);
const IRQ_HANDLER_CODE_MARKER = IRQ_HANDLER_PAYLOAD.slice(C.IRQ_BOOTSTRAP_OFFSET, C.IRQ_BOOTSTRAP_OFFSET + 16);
const IRQ_HANDLER_ROM_MARKER_TEXT = "lk_irq_shared";
const IRQ_HANDLER_ROM_MARKER = asciiBytes(IRQ_HANDLER_ROM_MARKER_TEXT);
const IRQ_SAVE_FLUSH_ENTRY_OFFSET = C.IRQ_SAVE_FLUSH_ENTRY_OFFSET;
const IRQ_FLAG_SAVE_FLUSH = C.IRQ_FLAG_SAVE_FLUSH;
const IRQ_FLAG_SAVE_FLUSH_AUTO = C.IRQ_FLAG_SAVE_FLUSH_AUTO;
const IRQ_FLAG_SAVE_FLUSH_HOTKEY = C.IRQ_FLAG_SAVE_FLUSH_HOTKEY;
const OLD_IRQ_SLOT = hexToBytes("fc7f0003");
const ORIGINAL_IRQ_SLOT = hexToBytes("f47f0003");

export const IRQ_HANDLER_PAYLOAD_SIZE = C.IRQ_HANDLER_SIZE;

function addOperation(operations, name, offset, size, details = {}) {
  const operation = { name, offset, size };
  if (details.codeName !== undefined) operation.code_name = details.codeName;
  if (details.value !== undefined) operation.value = details.value;
  operations.push(operation);
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
  return alignedPayloadSpan(IRQ_HANDLER_PAYLOAD.length);
}

function writeIrqHandlerRomMarker(bytes, operations, payloadBase) {
  const marker = IRQ_HANDLER_ROM_MARKER;
  const markerOffset = payloadBase + IRQ_HANDLER_PAYLOAD.length;
  const markerEnd = markerOffset + marker.length;
  const paddingEnd = payloadBase + alignedPayloadSpan(IRQ_HANDLER_PAYLOAD.length);
  if (markerEnd > paddingEnd || markerEnd > bytes.length) return false;
  if (!isFreeRegion(bytes, markerOffset, marker.length)) return false;
  copyBytes(bytes, markerOffset, marker);
  addOperation(operations, "Shared IRQ ROM marker", markerOffset, marker.length, { codeName: "shared_irq_rom_marker" });
  return true;
}

function isHandlerConfigByte(offset) {
  const configOffsets = [
    C.IRQ_ORIGINAL_ENTRYPOINT_OFFSET,
    C.IRQ_FLAGS_OFFSET,
    C.IRQ_RTC_MENU_ENTRY_OFFSET,
    IRQ_SAVE_FLUSH_ENTRY_OFFSET,
    C.IRQ_COUNTDOWN_FRAMES_OFFSET,
    C.IRQ_INDICATOR_MODE_OFFSET,
    C.IRQ_HOTKEY_MASK_OFFSET,
    C.IRQ_HANDLER_ENTRY_OFFSET,
  ];
  return configOffsets.some((configOffset) => offset >= configOffset && offset < configOffset + 4);
}

function currentHandlerCodeMatches(bytes, payloadBase) {
  if (payloadBase < 0 || payloadBase + IRQ_HANDLER_PAYLOAD.length > bytes.length) return false;
  for (let offset = 0; offset < IRQ_HANDLER_PAYLOAD.length; offset += 1) {
    if (isHandlerConfigByte(offset)) continue;
    if (bytes[payloadBase + offset] !== IRQ_HANDLER_PAYLOAD[offset]) return false;
  }
  return true;
}

export function findIrqHandlerPayloadBase(bytes) {
  if (!IRQ_HANDLER_MARKER.length || !IRQ_HANDLER_CODE_MARKER.length) return null;
  let pos = 0;
  while (true) {
    const markerOffset = findAlignedMarker(bytes, IRQ_HANDLER_MARKER, pos, bytes.length, 4);
    if (markerOffset === null) return null;
    if (
      markerOffset + IRQ_HANDLER_PAYLOAD.length <= bytes.length
      && startsWithBytes(bytes, markerOffset + C.IRQ_BOOTSTRAP_OFFSET, IRQ_HANDLER_CODE_MARKER)
    ) {
      return markerOffset;
    }
    pos = markerOffset + 4;
  }
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
    copyBytes(out, matchOffset, ORIGINAL_IRQ_SLOT);
    addOperation(operations, "Shared IRQ original handler slot", matchOffset, 4, { value: 0x03007ff4 });
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
  const value = Number.isInteger(hotkeyMask) ? hotkeyMask & 0x03ff : C.IRQ_HOTKEY_MASK;
  return value || C.IRQ_HOTKEY_MASK;
}

function irqFlags(options) {
  const saveFlushEntry = options.saveFlushEntry ?? 0;
  const saveFlushAuto = options.saveFlushAuto ?? false;
  const saveFlushHotkey = options.saveFlushHotkey ?? Boolean(saveFlushEntry);
  return (
    (options.rtcMenuEntry ? C.IRQ_FLAG_RTC : 0)
    | (saveFlushEntry ? IRQ_FLAG_SAVE_FLUSH : 0)
    | (saveFlushEntry && saveFlushAuto ? IRQ_FLAG_SAVE_FLUSH_AUTO : 0)
    | (saveFlushEntry && saveFlushHotkey ? IRQ_FLAG_SAVE_FLUSH_HOTKEY : 0)
  ) >>> 0;
}

function saveFlushEntryValue(options) {
  return (options.saveFlushEntry ?? 0) >>> 0;
}

function writeExistingConfig(bytes, operations, payloadBase, offset, value, name) {
  if (offset < 0 || payloadBase + offset + 4 > bytes.length) throw new PatchError("Shared IRQ: existing config offset outside ROM");
  if (readU32(bytes, payloadBase + offset) === (value >>> 0)) return false;
  writeU32(bytes, payloadBase + offset, value >>> 0);
  addOperation(operations, name, payloadBase + offset, 4, { codeName: "shared_irq_config", value: value >>> 0 });
  return true;
}

export function applyIrqHandlerForPipeline(rom, operations, warnings, options = {}, context = {}) {
  if (!options.enabled) return null;

  const existingBase = findIrqHandlerPayloadBase(rom.bytes);
  if (existingBase !== null) {
    const payloadAddress = (GBA_ROM_BASE + existingBase) >>> 0;
    const handlerAddress = (payloadAddress + C.IRQ_HANDLER_OFFSET) >>> 0;
    const flags = irqFlags(options);
    const hotkeyMask = hotkeyMaskValue(options.hotkeyMask);
    const saveFlushEntry = saveFlushEntryValue(options);
    if (!currentHandlerCodeMatches(rom.bytes, existingBase)) {
      throw new PatchError("Shared IRQ: an installed handler does not match the current payload; migrations are not supported");
    }

    let updated = 0;
    updated += writeExistingConfig(rom.bytes, operations, existingBase, C.IRQ_FLAGS_OFFSET, flags, "Shared IRQ flags") ? 1 : 0;
    updated += writeExistingConfig(rom.bytes, operations, existingBase, C.IRQ_RTC_MENU_ENTRY_OFFSET, options.rtcMenuEntry || 0, "Shared IRQ RTC menu entry") ? 1 : 0;
    updated += writeExistingConfig(rom.bytes, operations, existingBase, IRQ_SAVE_FLUSH_ENTRY_OFFSET, saveFlushEntry, "Shared IRQ save flush entry") ? 1 : 0;
    updated += writeExistingConfig(rom.bytes, operations, existingBase, C.IRQ_COUNTDOWN_FRAMES_OFFSET, options.countdownFrames || 0, "Shared IRQ countdown frames") ? 1 : 0;
    updated += writeExistingConfig(rom.bytes, operations, existingBase, C.IRQ_INDICATOR_MODE_OFFSET, indicatorModeValue(options.indicatorMode), "Shared IRQ indicator mode") ? 1 : 0;
    updated += writeExistingConfig(rom.bytes, operations, existingBase, C.IRQ_HOTKEY_MASK_OFFSET, hotkeyMask, "Shared IRQ hotkey mask") ? 1 : 0;
    updated += writeExistingConfig(rom.bytes, operations, existingBase, C.IRQ_HANDLER_ENTRY_OFFSET, handlerAddress, "Shared IRQ handler entry") ? 1 : 0;
    return {
      requested: true,
      status: updated ? "reconfigured" : "already_patched",
      payload_offset: existingBase,
      size: IRQ_HANDLER_PAYLOAD.length,
      flags,
      save_flush_entry: saveFlushEntry,
      hotkey_mask: hotkeyMask,
      handler_entry: handlerAddress,
    };
  }

  const localOperations = [];
  const localWarnings = [];
  const workRom = { bytes: new Uint8Array(rom.bytes) };
  const excludedRanges = [...(context.excludedRanges || [])];

  try {
    const payloadSpan = alignedPayloadSpan(IRQ_HANDLER_PAYLOAD.length);
    const payloadBase = context.payloadOffset ?? ensureDirectPayloadRegion(workRom, localOperations, localWarnings, payloadSpan, "Shared IRQ", excludedRanges);
    if (payloadBase === null) {
      warnings.push(...localWarnings);
      return { requested: true, status: "failed", size: IRQ_HANDLER_PAYLOAD.length };
    }

    excludedRanges.push([payloadBase, payloadBase + payloadSpan]);
    const payloadEnd = payloadBase + IRQ_HANDLER_PAYLOAD.length;
    if (payloadEnd > workRom.bytes.length) throw new PatchError("Shared IRQ: payload placement is outside the ROM");

    const originalEntrypoint = decodeEntrypointAddress(workRom.bytes);
    const payload = new Uint8Array(IRQ_HANDLER_PAYLOAD);
    const payloadAddress = (GBA_ROM_BASE + payloadBase) >>> 0;
    const handlerAddress = (payloadAddress + C.IRQ_HANDLER_OFFSET) >>> 0;
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

    copyBytes(workRom.bytes, payloadBase, payload);
    addOperation(localOperations, "Shared IRQ payload", payloadBase, payload.length, { codeName: "shared_irq_handler", value: payloadAddress });
    writeIrqHandlerRomMarker(workRom.bytes, localOperations, payloadBase);

    const entrypointBranch = encodeArmBranch(GBA_ROM_BASE, bootstrapAddress);
    writeU32(workRom.bytes, 0, entrypointBranch);
    addOperation(localOperations, "Shared IRQ Entrypoint", 0, 4, { value: entrypointBranch });

    const irqReferences = patchIrqVectorReferences(workRom.bytes, localOperations, excludedRanges);

    rom.bytes = workRom.bytes;
    operations.push(...localOperations);
    warnings.push(...localWarnings);
    return {
      requested: true,
      status: "patched",
      payload_offset: payloadBase,
      runtime_base: payloadAddress,
      size: IRQ_HANDLER_PAYLOAD.length,
      flags,
      save_flush_entry: saveFlushEntry,
      handler_entry: handlerAddress,
      bootstrap_entry: bootstrapAddress,
      original_entrypoint: originalEntrypoint,
      hotkey_mask: hotkeyMask,
      irq_references: irqReferences,
    };
  } catch (error) {
    localWarnings.push(error.message || String(error));
    warnings.push(...localWarnings);
    return { requested: true, status: "failed", size: IRQ_HANDLER_PAYLOAD.length };
  }
}
