/*
 * GBA Save Type Patcher - Fake RTC menu patch port.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Ported from rtc_patcher/rtc-patcher.py in this package. The embedded
 * payload is relocated at ROM-patch time; no external build tools are needed.
 */

import { asciiBytes, findBytes, hexToBytes, readU32, writeU32 } from "../core/binary.js";
import { PatchError } from "../core/errors.js";
import { PATCH_OPERATION_KIND, RTC_TICK_MODES } from "../domain/constants.js";
import { stagePatchOperation, stageRomExpansion } from "../patch-engine/draft.js";
import {
  PAYLOAD_ALIGNMENT as TARGET_PAYLOAD_ALIGNMENT,
  ensureDirectPayloadRegion,
  markedPayloadSpan,
} from "./payload-placement.js";
import { RTC_PAYLOAD_CONSTANTS, RTC_PAYLOAD_HEX } from "./rtc-data.js";

const GBA_ROM_BASE = 0x08000000;
const GBA_MAX_ROM_SIZE = 0x02000000;
const RTC_PAYLOAD_ALIGNMENT = TARGET_PAYLOAD_ALIGNMENT;
const ORIGINAL_PAYLOAD_LINK_ADDR = RTC_PAYLOAD_CONSTANTS.RTC_ORIGINAL_PAYLOAD_LINK_ADDR;

export const RTC_PAYLOAD_SIZE = RTC_PAYLOAD_CONSTANTS.RTC_PAYLOAD_SIZE;
export const RTC_PERSISTENCE_BLOCK_SIZE = RTC_PAYLOAD_CONSTANTS.RTC_PERSIST_BLOCK_SIZE;
export const RTC_PERSISTENCE_HALF_SIZE = RTC_PAYLOAD_CONSTANTS.RTC_PERSIST_HALF_SIZE;
export const RTC_PERSISTENCE_RECORD_SIZE = RTC_PAYLOAD_CONSTANTS.RTC_PERSIST_RECORD_SIZE;
export const RTC_PERSISTENCE_CUSTOM_BACKEND_FLAG = RTC_PAYLOAD_CONSTANTS.RTC_PERSIST_FLAG_CUSTOM_BACKEND;
export const RTC_PERSISTENCE_SHARED_SAVE_AREA_FLAG = RTC_PAYLOAD_CONSTANTS.RTC_PERSIST_FLAG_SHARED_SAVE_AREA;

function validateGeneratedRtcData() {
  const constants = RTC_PAYLOAD_CONSTANTS;
  if (
    !RTC_PAYLOAD_HEX
    || !constants
    || !Number.isInteger(constants.RTC_PAYLOAD_SIZE)
    || !Number.isInteger(constants.RTC_ORIGINAL_PAYLOAD_LINK_ADDR)
    || !Array.isArray(constants.RTC_RELOCATION_OFFSETS)
    || !Array.isArray(constants.RTC_RELATIVE_ASSET_RELOCATION_OFFSETS)
    || !constants.RTC_ORIGINAL_PAYLOAD_SYMBOLS
    || !Number.isInteger(constants.RTC_TICK_MODE_CONFIG_OFFSET)
    || !Number.isInteger(constants.RTC_TICK_MODE_VBLANK)
    || !Number.isInteger(constants.RTC_TICK_MODE_READ)
    || !Number.isInteger(constants.RTC_PERSIST_BLOCK_CONFIG_OFFSET)
    || !Number.isInteger(constants.RTC_PERSIST_FLAGS_CONFIG_OFFSET)
    || constants.RTC_PERSIST_BLOCK_SIZE !== 0x40000
    || constants.RTC_PERSIST_HALF_SIZE !== 0x20000
    || !Number.isInteger(constants.RTC_PERSIST_RECORD_SIZE)
    || constants.RTC_PERSIST_RECORD_SIZE <= 0
    || !Number.isInteger(constants.RTC_PERSIST_FLAG_CUSTOM_BACKEND)
    || !Number.isInteger(constants.RTC_PERSIST_FLAG_SHARED_SAVE_AREA)
  ) {
    throw new PatchError("RTC generated payload data is missing or invalid.", {
      code: "RTC_GENERATED_DATA_INVALID",
      stage: "initialization",
    });
  }
  const payload = hexToBytes(RTC_PAYLOAD_HEX);
  if (payload.length !== constants.RTC_PAYLOAD_SIZE) {
    throw new PatchError("RTC generated payload size does not match its ABI metadata.", {
      code: "RTC_PAYLOAD_SIZE_MISMATCH",
      stage: "initialization",
      context: { expected: constants.RTC_PAYLOAD_SIZE, actual: payload.length },
    });
  }
  return payload;
}

const ACTIVE_RELOCATION_OFFSETS = RTC_PAYLOAD_CONSTANTS.RTC_RELOCATION_OFFSETS;
const ACTIVE_RELATIVE_ASSET_RELOCATION_OFFSETS = RTC_PAYLOAD_CONSTANTS.RTC_RELATIVE_ASSET_RELOCATION_OFFSETS;
const ACTIVE_ORIGINAL_PAYLOAD_SYMBOLS = RTC_PAYLOAD_CONSTANTS.RTC_ORIGINAL_PAYLOAD_SYMBOLS;

export function normalizeRtcTickMode(value) {
  return value === RTC_TICK_MODES.READ ? RTC_TICK_MODES.READ : RTC_TICK_MODES.VBLANK;
}

function configureRtcTickMode(payloadBuild, tickMode) {
  const offset = RTC_PAYLOAD_CONSTANTS.RTC_TICK_MODE_CONFIG_OFFSET;
  if (offset < 0 || offset + 4 > payloadBuild.payloadBytes.length) {
    throw new PatchError("RTC: tick-mode configuration is outside the payload");
  }
  const value = tickMode === RTC_TICK_MODES.READ
    ? RTC_PAYLOAD_CONSTANTS.RTC_TICK_MODE_READ
    : RTC_PAYLOAD_CONSTANTS.RTC_TICK_MODE_VBLANK;
  writeU32(payloadBuild.payloadBytes, offset, value);
}

function configureRtcPersistence(payloadBuild, context = {}) {
  const blockOffset = context.persistenceBlockOffset ?? null;
  const flags = context.persistenceFlags ?? 0;
  if (blockOffset === null) {
    writeU32(
      payloadBuild.payloadBytes,
      RTC_PAYLOAD_CONSTANTS.RTC_PERSIST_BLOCK_CONFIG_OFFSET,
      0xffffffff,
    );
    writeU32(
      payloadBuild.payloadBytes,
      RTC_PAYLOAD_CONSTANTS.RTC_PERSIST_FLAGS_CONFIG_OFFSET,
      0,
    );
    return null;
  }
  if (!Number.isInteger(blockOffset)
      || blockOffset < 0
      || blockOffset % RTC_PERSISTENCE_BLOCK_SIZE
      || blockOffset + RTC_PERSISTENCE_BLOCK_SIZE > GBA_MAX_ROM_SIZE
      || (blockOffset <= 0x01000000
        && 0x01000000 < blockOffset + RTC_PERSISTENCE_BLOCK_SIZE)) {
    throw new PatchError("RTC: persistence block is invalid");
  }
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xffffffff) {
    throw new PatchError("RTC: persistence flags are invalid");
  }
  writeU32(
    payloadBuild.payloadBytes,
    RTC_PAYLOAD_CONSTANTS.RTC_PERSIST_BLOCK_CONFIG_OFFSET,
    blockOffset >>> 0,
  );
  writeU32(
    payloadBuild.payloadBytes,
    RTC_PAYLOAD_CONSTANTS.RTC_PERSIST_FLAGS_CONFIG_OFFSET,
    flags >>> 0,
  );
  return {
    offset: blockOffset,
    size: RTC_PERSISTENCE_BLOCK_SIZE,
    recordOffset: blockOffset + RTC_PERSISTENCE_BLOCK_SIZE - RTC_PERSISTENCE_RECORD_SIZE,
    recordSize: RTC_PERSISTENCE_RECORD_SIZE,
    eraseOffsets: [blockOffset, blockOffset + RTC_PERSISTENCE_HALF_SIZE],
    eraseSize: RTC_PERSISTENCE_HALF_SIZE,
    flags: flags >>> 0,
  };
}

export const RTC_HANDLER_SIGNATURES = Object.freeze({
  "probe": [
    46464,
    45188,
    18031,
    7481,
    7176,
    61440,
    0,
    1537,
    3592,
    10240,
    0,
    8192
  ],
  "reset": [
    46464,
    45188,
    18031,
    18435,
    30721,
    10497,
    0,
    8192
  ],
  "getstatus": [
    46480,
    45186,
    18031,
    24632,
    18434,
    30721,
    10497,
    0,
    8192,
    0,
    0,
    0,
    0,
    8449,
    28673,
    0,
    8449,
    32769,
    0,
    8453,
    32769,
    0,
    8455,
    32769
  ],
  "gettimedate": [
    46464,
    45186,
    18031,
    24632,
    18434,
    30721,
    10497,
    0,
    8192,
    0,
    0,
    0,
    0,
    8449,
    28673,
    0,
    8449,
    32769,
    0,
    8453,
    32769,
    0,
    8455,
    32769,
    8293
  ]
});

// Additional handler signatures for Pokemon Unbound-style FireRed RTC code.
// The original signatures above identify the common SiiRTC implementation.
// Unbound keeps RTC/GPIO routines, but the compiler output/prologues differ,
// so the standard exact signatures do not match. Zero halfwords are wildcards
// for branch immediates or ROM-version-sensitive values.
const ADDITIONAL_SIGS = {
  "probe": [
    [
      0xB530, 0xB085, 0xAD01, 0x0028, 0xF7FF, 0x0000, 0x2800, 0xD102,
      0x2000, 0xB005, 0xBD30, 0x79EB, 0x065B, 0xD411, 0xF7FF, 0x0000,
      0x2401, 0x2800, 0xD0F4, 0x0028,
    ],
  ],
  "reset": [
    [0x2201, 0x4B03, 0x801A, 0x2200, 0x4B02, 0x701A, 0x4770, 0x46C0],
  ],
  "getstatus": [
    [
      0xB5F7, 0x4F16, 0x783B, 0x9001, 0x2600, 0x2B01, 0xD024, 0x2401,
      0x2305, 0x4D13, 0x4A13, 0x703C, 0x802C, 0x802B, 0x3302, 0x8013,
      0x2063, 0xF7FF, 0x0000, 0x2305, 0x4A0E, 0x8013, 0xF7FF, 0x0000,
    ],
  ],
  "gettimedate": [
    [
      0xB5F7, 0x4E14, 0x7833, 0x0005, 0x2000, 0x2B01, 0xD020, 0x2301,
      0x4C11, 0x7033, 0x4F11, 0x8023, 0x3304, 0x8023, 0x3302, 0x803B,
      0x3065, 0xF7FF, 0x0000, 0x2305, 0x803B, 0x002F, 0x1DEB, 0x9301,
      0xF7FF, 0x0000,
    ],
  ],
};

const PATCH_ORDER = ["probe", "reset", "getstatus", "gettimedate"];
const PAYLOAD_SYMBOLS = {
  "probe": "payload_probe",
  "reset": "payload_reset",
  "getstatus": "payload_getstatus",
  "gettimedate": "payload_gettimedate"
};

const EMBEDDED_PAYLOAD = validateGeneratedRtcData();
const RTC_ROM_MARKER_TEXT = "lk_rtc_runtime";
const RTC_ROM_MARKER = asciiBytes(RTC_ROM_MARKER_TEXT);

export function rtcPayloadSpanForLayout() {
  return markedPayloadSpan(RTC_PAYLOAD_SIZE, RTC_ROM_MARKER.length);
}

function stageRtcWrite(bytes, operations, name, offset, replacement, details = {}) {
  return stagePatchOperation(bytes, operations, {
    id: `rtc-${operations.length}`,
    kind: details.kind || PATCH_OPERATION_KIND.HOOK_REPLACE,
    component: "rtc",
    labelKey: details.labelKey || "operation.rtc",
    offset,
    byteLength: replacement.length,
    expectedBefore: bytes.slice(offset, offset + replacement.length),
    replacement,
    metadata: {
      name,
      ...(details.codeName === undefined ? {} : { codeName: details.codeName }),
      ...(details.value === undefined ? {} : { value: details.value }),
    },
  });
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

export function isRtcFreeRegion(bytes, start, size) {
  if (start < 0 || size < 0 || start + size > bytes.length) return false;
  for (let offset = start; offset < start + size; offset += 1) {
    if (!isFreeByte(bytes[offset])) return false;
  }
  return true;
}

function writeRtcRomMarker(bytes, operations, payloadOffset) {
  const marker = RTC_ROM_MARKER;
  const markerOffset = payloadOffset + RTC_PAYLOAD_SIZE;
  const markerEnd = markerOffset + marker.length;
  const paddingEnd = payloadOffset + rtcPayloadSpanForLayout();
  if (markerEnd > paddingEnd || markerEnd > bytes.length) {
    throw new PatchError("RTC: reserved payload span does not include the ROM marker");
  }
  if (!isRtcFreeRegion(bytes, markerOffset, marker.length)) {
    throw new PatchError("RTC: ROM marker region is not free");
  }
  stageRtcWrite(bytes, operations, "RTC ROM marker", markerOffset, marker, {
    kind: PATCH_OPERATION_KIND.LITERAL_REPLACE,
    codeName: "rtc_rom_marker",
  });
  return true;
}

function rangesOverlap(start, end, ranges) {
  return ranges.some(([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart);
}

function embeddedPayloadBytes() {
  if (EMBEDDED_PAYLOAD.length !== RTC_PAYLOAD_SIZE) {
    throw new PatchError(`RTC: embedded payload size mismatch: expected ${RTC_PAYLOAD_SIZE}, got ${EMBEDDED_PAYLOAD.length}`);
  }
  return EMBEDDED_PAYLOAD;
}

function relocatePayload(payload, newLinkAddr) {
  const delta = newLinkAddr - ORIGINAL_PAYLOAD_LINK_ADDR;
  const relocated = new Uint8Array(payload);

  for (const offset of ACTIVE_RELOCATION_OFFSETS) {
    if (offset + 4 > relocated.length) throw new PatchError(`RTC: bad relocation offset 0x${offset.toString(16)} outside payload`);
    const oldValue = readU32(relocated, offset);
    const oldTarget = (oldValue & 0xfffffffe) >>> 0;
    if (oldTarget < ORIGINAL_PAYLOAD_LINK_ADDR || oldTarget >= ORIGINAL_PAYLOAD_LINK_ADDR + payload.length) {
      throw new PatchError(`RTC: relocation sanity check failed at 0x${offset.toString(16)}`);
    }
    writeU32(relocated, offset, (oldValue + delta) >>> 0);
  }

  for (const offset of ACTIVE_RELATIVE_ASSET_RELOCATION_OFFSETS) {
    if (offset + 4 > relocated.length) throw new PatchError(`RTC: bad relative relocation offset 0x${offset.toString(16)} outside payload`);
    const oldValue = readU32(relocated, offset);
    writeU32(relocated, offset, (oldValue + delta) >>> 0);
  }

  const symbols = {};
  for (const [name, address] of Object.entries(ACTIVE_ORIGINAL_PAYLOAD_SYMBOLS)) {
    symbols[name] = (address + delta) >>> 0;
  }
  return { payloadBytes: relocated, symbols };
}

function ensureRtcPayloadRegion(rom, operations, warnings, excludedRanges = []) {
  return ensureDirectPayloadRegion(rom, operations, warnings, rtcPayloadSpanForLayout(), "RTC", excludedRanges);
}

function halfwordAt(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function matchesSig(bytes, offset, sig) {
  if (offset & 3) return false;
  const end = offset + sig.length * 2;
  if (end > bytes.length) return false;
  for (let index = 0; index < sig.length; index += 1) {
    const expected = sig[index];
    if (expected && halfwordAt(bytes, offset + index * 2) !== expected) return false;
  }
  return true;
}

function firstBytesForSig(sig) {
  if (sig.length < 2 || sig[0] === 0 || sig[1] === 0) throw new PatchError("RTC: handler signature cannot be indexed");
  return new Uint8Array([sig[0] & 0xff, (sig[0] >>> 8) & 0xff, sig[1] & 0xff, (sig[1] >>> 8) & 0xff]);
}

function findAllSig(bytes, sig) {
  const first = firstBytesForSig(sig);
  const found = [];
  let pos = 0;
  while (true) {
    pos = findBytes(bytes, first, pos);
    if (pos < 0) break;
    if (matchesSig(bytes, pos, sig)) found.push(pos);
    pos += 1;
  }
  return found;
}

function signatureVariants(name) {
  return [RTC_HANDLER_SIGNATURES[name], ...(ADDITIONAL_SIGS[name] || [])];
}

function findRtcHandlers(bytes, excludedRanges = []) {
  const matches = [];
  const problems = [];

  for (const name of PATCH_ORDER) {
    const candidatesByOffset = new Map();
    for (const sig of signatureVariants(name)) {
      for (const offset of findAllSig(bytes, sig)) {
        // Multiple variants may intentionally identify the same handler.
        // Keep the longest replacement window for that offset.
        const size = sig.length * 2;
        if (rangesOverlap(offset, offset + size, excludedRanges)) continue;
        candidatesByOffset.set(offset, Math.max(candidatesByOffset.get(offset) || 0, size));
      }
    }

    const candidates = [...candidatesByOffset.entries()].sort((a, b) => a[0] - b[0]);
    if (candidates.length !== 1) {
      const formatted = candidates.length ? candidates.map(([offset]) => `0x${offset.toString(16).padStart(6, "0")}`).join(", ") : "none";
      problems.push(`${name}: expected 1 match, found ${candidates.length} (${formatted})`);
    } else {
      const [offset, size] = candidates[0];
      matches.push({ name, offset, size });
    }
  }

  if (problems.length) throw new PatchError(`RTC handler detection failed:\n  ${problems.join("\n  ")}`);
  return matches;
}

export function hasRecognizedRtcHandlerSet(bytes, excludedRanges = []) {
  try {
    return findRtcHandlers(bytes, excludedRanges).length === PATCH_ORDER.length;
  } catch {
    // Partial or ambiguous RTC implementations are not enough to justify a
    // startup-timing change. Callers can retain their established fallback.
    return false;
  }
}

function makeThumbJumpStub(targetAddr, totalSize) {
  if (totalSize < 8) throw new PatchError(`RTC: need at least 8 bytes for Thumb jump stub, got ${totalSize}`);
  const stub = new Uint8Array(totalSize);
  stub[0] = 0x00;
  stub[1] = 0x4b;
  stub[2] = 0x18;
  stub[3] = 0x47;
  writeU32(stub, 4, (targetAddr | 1) >>> 0);
  for (let offset = 8; offset < totalSize; offset += 2) {
    stub[offset] = 0xc0;
    if (offset + 1 < totalSize) stub[offset + 1] = 0x46;
  }
  return stub;
}

function validatePayloadOffset(bytes, payloadOffset) {
  const payloadSpan = rtcPayloadSpanForLayout();
  if (!Number.isInteger(payloadOffset)) throw new PatchError("RTC: payload offset is invalid");
  if (payloadOffset % RTC_PAYLOAD_ALIGNMENT) throw new PatchError("RTC: payload offset must be 0x100-byte aligned");
  if (payloadOffset < 0 || payloadOffset + payloadSpan > GBA_MAX_ROM_SIZE) {
    throw new PatchError("RTC: payload would be outside the 32 MiB GBA ROM address space");
  }
  if (payloadOffset < bytes.length && !isRtcFreeRegion(bytes, payloadOffset, Math.min(payloadSpan, bytes.length - payloadOffset))) {
    throw new PatchError("RTC: chosen payload region is not free");
  }
}

function patchRtcOnWorkingRom(workRom, operations, warnings, originalBytes, rtcOptions = {}, context = {}) {
  const matches = findRtcHandlers(originalBytes, context.excludedRanges || []);
  const tickMode = normalizeRtcTickMode(rtcOptions.tickMode);
  let payloadOffset = context.payloadOffset ?? null;
  let placement = context.placement || (payloadOffset === null ? null : "manual");

  if (payloadOffset === null) {
    payloadOffset = ensureRtcPayloadRegion(workRom, operations, warnings, context.excludedRanges || []);
    if (payloadOffset === null) {
      return { requested: true, status: "failed", size: RTC_PAYLOAD_SIZE };
    }
    placement = payloadOffset + rtcPayloadSpanForLayout() <= originalBytes.length
      ? "uniformTrailingPadding"
      : "alignedRomExpansion";
  } else {
    validatePayloadOffset(workRom.bytes, payloadOffset);
    const end = payloadOffset + rtcPayloadSpanForLayout();
    if (end > workRom.bytes.length) {
      const oldSize = workRom.bytes.length;
      const byteLength = end - oldSize;
      const erasedBytes = new Uint8Array(byteLength).fill(0xff);
      stageRomExpansion(workRom, operations, {
        id: `rtc-expand-${operations.length}`,
        kind: PATCH_OPERATION_KIND.ROM_EXPAND,
        component: "rtc",
        offset: oldSize,
        byteLength,
        expectedBefore: erasedBytes,
        replacement: new Uint8Array(erasedBytes),
        labelKey: "operation.romExpand",
        metadata: {
          name: "RTC ROM expansion",
          value: end,
        },
      });
    }
  }

  const end = payloadOffset + RTC_PAYLOAD_SIZE;
  const region = workRom.bytes.slice(payloadOffset, end);
  if (!isRtcFreeRegion(region, 0, region.length)) throw new PatchError("RTC: chosen payload region is not free");

  const linkAddr = (GBA_ROM_BASE + payloadOffset) >>> 0;
  const payloadBuild = relocatePayload(embeddedPayloadBytes(), linkAddr);
  configureRtcTickMode(payloadBuild, tickMode);
  const persistenceContext = rtcOptions.saveOnGlobalHotkey === false
    ? { ...context, persistenceBlockOffset: null, persistenceFlags: 0 }
    : context;
  const persistence = configureRtcPersistence(payloadBuild, persistenceContext);
  const persistenceLoadEntry = persistence
    && payloadBuild.symbols.rtc_persist_load !== undefined
    ? (payloadBuild.symbols.rtc_persist_load | 1) >>> 0
    : null;
  const persistenceFlushEntry = persistence
    && payloadBuild.symbols.rtc_persist_flush !== undefined
    ? (payloadBuild.symbols.rtc_persist_flush | 1) >>> 0
    : null;
  stageRtcWrite(workRom.bytes, operations, "RTC payload", payloadOffset, payloadBuild.payloadBytes, {
    kind: PATCH_OPERATION_KIND.PAYLOAD_INSTALL,
    codeName: "rtc_payload",
    value: linkAddr,
  });
  writeRtcRomMarker(workRom.bytes, operations, payloadOffset);

  const handlerResults = [];
  for (const match of matches) {
    const symbolName = PAYLOAD_SYMBOLS[match.name];
    const target = payloadBuild.symbols[symbolName];
    if (target === undefined) throw new PatchError(`RTC: missing payload symbol for ${match.name}`);
    const stub = makeThumbJumpStub(target, match.size);
    stageRtcWrite(workRom.bytes, operations, `RTC ${match.name} hook`, match.offset, stub, {
      codeName: `rtc_${match.name}_hook`,
      value: target >>> 0,
    });
    handlerResults.push({ name: match.name, offset: match.offset, size: match.size, target: target >>> 0 });
  }

  return {
    requested: true,
    status: "patched",
    payloadOffset,
    runtimeBase: linkAddr,
    runtimeMenuEntry: payloadBuild.symbols.fake_rtc_menu_run_runtime === undefined ? null : (payloadBuild.symbols.fake_rtc_menu_run_runtime | 1) >>> 0,
    persistenceLoadEntry,
    persistenceFlushEntry,
    persistence,
    tickMode,
    size: RTC_PAYLOAD_SIZE,
    payloadSpan: rtcPayloadSpanForLayout(),
    placement,
    relocations: ACTIVE_RELOCATION_OFFSETS.length + ACTIVE_RELATIVE_ASSET_RELOCATION_OFFSETS.length,
    graphicsRelocations: ACTIVE_RELATIVE_ASSET_RELOCATION_OFFSETS.length,
    handlers: handlerResults,
  };
}

export function applyRtcForPipeline(rom, operations, warnings, rtcOptions = {}, context = {}) {
  if (!rtcOptions?.enabled) return null;

  const originalBytes = new Uint8Array(rom.bytes);
  const workRom = { bytes: new Uint8Array(rom.bytes) };
  const previousOperationCount = operations.length;
  const localOperations = [...operations];
  const localWarnings = [];

  try {
    const rtc = patchRtcOnWorkingRom(workRom, localOperations, localWarnings, originalBytes, rtcOptions, context);
    rom.bytes = workRom.bytes;
    operations.push(...localOperations.slice(previousOperationCount));
    warnings.push(...localWarnings);
    return rtc;
  } catch (error) {
    localWarnings.push(error.message || String(error));
    warnings.push(...localWarnings);
    return { requested: true, status: "failed", size: RTC_PAYLOAD_SIZE };
  }
}
