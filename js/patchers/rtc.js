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
import { alignDown, alignUp, isBlankRegion, overlapsAnyRange } from "../core/ranges.js";
import { PATCH_OPERATION_KIND, RTC_TICK_MODES } from "../domain/constants.js";
import {
  GBA_PAYLOAD_PLACEMENT_LIMIT_BYTES,
  GBA_ROM_BASE_ADDRESS,
} from "../domain/gba-constants.js";
import { stageErasedRomExpansion, stageNamedPatchWrite } from "../patch-engine/draft.js";
import {
  PAYLOAD_ALIGNMENT as TARGET_PAYLOAD_ALIGNMENT,
  ensureDirectPayloadRegion,
  markedPayloadSpan,
} from "./payload-placement.js";
import { RTC_PAYLOAD_CONSTANTS, RTC_PAYLOAD_HEX } from "./rtc-data.js";

const RTC_PAYLOAD_ALIGNMENT = TARGET_PAYLOAD_ALIGNMENT;
const ORIGINAL_PAYLOAD_LINK_ADDR = RTC_PAYLOAD_CONSTANTS.RTC_ORIGINAL_PAYLOAD_LINK_ADDR;
const REQUIRED_RTC_PAYLOAD_SYMBOLS = Object.freeze([
  "payload_probe",
  "payload_reset",
  "payload_getstatus",
  "payload_gettimedate",
  "payload_zodiac_probe",
  "payload_zodiac_gettimedate",
  "payload_zodiac_available_address_config",
  "payload_zodiac_status_address_config",
]);

export const RTC_PAYLOAD_SIZE = RTC_PAYLOAD_CONSTANTS.RTC_PAYLOAD_SIZE;
export const RTC_PERSISTENCE_BLOCK_SIZE = RTC_PAYLOAD_CONSTANTS.RTC_PERSIST_BLOCK_SIZE;
export const RTC_PERSISTENCE_HALF_SIZE = RTC_PAYLOAD_CONSTANTS.RTC_PERSIST_HALF_SIZE;
export const RTC_PERSISTENCE_RECORD_SIZE = RTC_PAYLOAD_CONSTANTS.RTC_PERSIST_RECORD_SIZE;
export const RTC_PERSISTENCE_MAPPER_CLEANUP_FLAG = RTC_PAYLOAD_CONSTANTS.RTC_PERSIST_FLAG_MAPPER_CLEANUP;
export const RTC_PERSISTENCE_SHARED_SAVE_AREA_FLAG = RTC_PAYLOAD_CONSTANTS.RTC_PERSIST_FLAG_SHARED_SAVE_AREA;
export const RTC_PERSISTENCE_VISOLY_MAPPER_CLEANUP_FLAG = RTC_PAYLOAD_CONSTANTS.RTC_PERSIST_FLAG_VISOLY_MAPPER_CLEANUP;

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
    || REQUIRED_RTC_PAYLOAD_SYMBOLS.some(
      (name) => !Number.isInteger(constants.RTC_ORIGINAL_PAYLOAD_SYMBOLS[name]),
    )
    || !Number.isInteger(constants.RTC_TICK_MODE_CONFIG_OFFSET)
    || !Number.isInteger(constants.RTC_TICK_MODE_VBLANK)
    || !Number.isInteger(constants.RTC_TICK_MODE_READ)
    || !Number.isInteger(constants.RTC_MENU_ON_BOOT_CONFIG_OFFSET)
    || constants.RTC_MENU_ON_BOOT_SKIP !== 0
    || constants.RTC_MENU_ON_BOOT_SHOW !== 1
    || !Number.isInteger(constants.RTC_PERSIST_BLOCK_CONFIG_OFFSET)
    || !Number.isInteger(constants.RTC_PERSIST_FLAGS_CONFIG_OFFSET)
    || constants.RTC_PERSIST_BLOCK_SIZE !== 0x40000
    || constants.RTC_PERSIST_HALF_SIZE !== 0x20000
    || !Number.isInteger(constants.RTC_PERSIST_RECORD_SIZE)
    || constants.RTC_PERSIST_RECORD_SIZE <= 0
    || !Number.isInteger(constants.RTC_PERSIST_FLAG_MAPPER_CLEANUP)
    || !Number.isInteger(constants.RTC_PERSIST_FLAG_SHARED_SAVE_AREA)
    || !Number.isInteger(constants.RTC_PERSIST_FLAG_VISOLY_MAPPER_CLEANUP)
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

function configureRtcBootMenu(payloadBuild, showMenuOnBoot) {
  const offset = RTC_PAYLOAD_CONSTANTS.RTC_MENU_ON_BOOT_CONFIG_OFFSET;
  if (offset < 0 || offset + 4 > payloadBuild.payloadBytes.length) {
    throw new PatchError("RTC: boot-menu configuration is outside the payload");
  }
  const value = showMenuOnBoot === false
    ? RTC_PAYLOAD_CONSTANTS.RTC_MENU_ON_BOOT_SKIP
    : RTC_PAYLOAD_CONSTANTS.RTC_MENU_ON_BOOT_SHOW;
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
      || blockOffset + RTC_PERSISTENCE_BLOCK_SIZE > GBA_PAYLOAD_PLACEMENT_LIMIT_BYTES
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

const SII_RTC_PATCH_ORDER = ["probe", "reset", "getstatus", "gettimedate"];
const SII_RTC_PAYLOAD_SYMBOLS = {
  "probe": "payload_probe",
  "reset": "payload_reset",
  "getstatus": "payload_getstatus",
  "gettimedate": "payload_gettimedate"
};

const RTC_HANDLER_FAMILY_SII = "sii-rtc";
const RTC_HANDLER_FAMILY_ZODIAC = "zodiac-wizard";

// ZodiacDaGreat/Wizard-DN-derived compact seven-byte RTC interface.
// Detection is based on the RTC protocol, resolved GPIO/RAM literals, compact
// seven-byte raw-reader ABI, and internal call graph. No game code, ROM hash,
// absolute ROM offset, or fixed spacing between functions is consulted.
const ZODIAC_FULL_TIME_COMMAND_BYTES = new Uint8Array([0x65, 0x20]);
const ZODIAC_GPIO_DATA_ADDRESS = 0x080000C4;
const ZODIAC_GPIO_DIRECTION_ADDRESS = 0x080000C6;
const ZODIAC_GPIO_CONTROL_ADDRESS = 0x080000C8;
const ZODIAC_PROBE_SIZE = 0x0C;
const ZODIAC_RAW_TIME_HOOK_SIZE = 0x0C;
const ZODIAC_ENTRY_SCAN_BYTES = 0x40;
const ZODIAC_FUNCTION_SCAN_BYTES = 0x100;
const THUMB_BL_REACH = 0x400000;

const EMBEDDED_PAYLOAD = validateGeneratedRtcData();
const RTC_ROM_MARKER_TEXT = "lk_rtc_runtime";
const RTC_ROM_MARKER = asciiBytes(RTC_ROM_MARKER_TEXT);

// Compatibility alias retained for callers of the previous public helper.
export const isRtcFreeRegion = isBlankRegion;

export function rtcPayloadSpanForLayout() {
  return markedPayloadSpan(RTC_PAYLOAD_SIZE, RTC_ROM_MARKER.length);
}

function stageRtcWrite(bytes, operations, name, offset, replacement, details = {}) {
  return stageNamedPatchWrite(bytes, operations, {
    idPrefix: "rtc",
    kind: details.kind || PATCH_OPERATION_KIND.HOOK_REPLACE,
    component: "rtc",
    labelKey: details.labelKey || "operation.rtc",
    name,
    offset,
    replacement,
    metadata: {
      ...(details.codeName === undefined ? {} : { codeName: details.codeName }),
      ...(details.value === undefined ? {} : { value: details.value }),
    },
  });
}

function writeRtcRomMarker(bytes, operations, payloadOffset) {
  const marker = RTC_ROM_MARKER;
  const markerOffset = payloadOffset + RTC_PAYLOAD_SIZE;
  const markerEnd = markerOffset + marker.length;
  const paddingEnd = payloadOffset + rtcPayloadSpanForLayout();
  if (markerEnd > paddingEnd || markerEnd > bytes.length) {
    throw new PatchError("RTC: reserved payload span does not include the ROM marker");
  }
  if (!isBlankRegion(bytes, markerOffset, marker.length)) {
    throw new PatchError("RTC: ROM marker region is not free");
  }
  stageRtcWrite(bytes, operations, "RTC ROM marker", markerOffset, marker, {
    kind: PATCH_OPERATION_KIND.LITERAL_REPLACE,
    codeName: "rtc_rom_marker",
  });
  return true;
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

function inspectSiiRtcProfile(bytes, excludedRanges = []) {
  const matches = [];
  const problems = [];

  for (const name of SII_RTC_PATCH_ORDER) {
    const candidatesByOffset = new Map();
    for (const sig of signatureVariants(name)) {
      for (const offset of findAllSig(bytes, sig)) {
        // Multiple variants may intentionally identify the same handler.
        // Keep the longest replacement window for that offset.
        const size = sig.length * 2;
        if (overlapsAnyRange(offset, offset + size, excludedRanges)) continue;
        candidatesByOffset.set(offset, Math.max(candidatesByOffset.get(offset) || 0, size));
      }
    }

    const candidates = [...candidatesByOffset.entries()].sort((a, b) => a[0] - b[0]);
    if (candidates.length !== 1) {
      const formatted = candidates.length ? candidates.map(([offset]) => `0x${offset.toString(16).padStart(6, "0")}`).join(", ") : "none";
      problems.push(`${name}: expected 1 match, found ${candidates.length} (${formatted})`);
    } else {
      const [offset, size] = candidates[0];
      matches.push({
        name,
        offset,
        size,
        payloadSymbol: SII_RTC_PAYLOAD_SYMBOLS[name],
      });
    }
  }

  return {
    label: "SiiRTC",
    problems,
    profile: problems.length ? null : {
      id: RTC_HANDLER_FAMILY_SII,
      matches,
    },
  };
}

function configureRtcHandlerProfile(payloadBuild, handlerProfile, runtimeBase) {
  if (handlerProfile.id !== RTC_HANDLER_FAMILY_ZODIAC) return;
  const configuration = handlerProfile.configuration || {};
  const entries = [
    ["payload_zodiac_available_address_config", configuration.availableAddress],
    ["payload_zodiac_status_address_config", configuration.statusAddress],
  ];
  for (const [symbolName, address] of entries) {
    if (!isWritableGbaRamAddress(address)) {
      throw new PatchError(`RTC: invalid Zodiac/Wizard RAM address for ${symbolName}`);
    }
    const symbolAddress = payloadBuild.symbols[symbolName];
    if (!Number.isInteger(symbolAddress)) {
      throw new PatchError(`RTC: missing Zodiac/Wizard payload config ${symbolName}`);
    }
    const offset = symbolAddress - runtimeBase;
    if (offset < 0 || offset + 4 > payloadBuild.payloadBytes.length) {
      throw new PatchError(`RTC: Zodiac/Wizard payload config is outside the payload: ${symbolName}`);
    }
    writeU32(payloadBuild.payloadBytes, offset, address);
  }
}

function thumbLiteralReference(bytes, instructionOffset) {
  if (instructionOffset < 0 || instructionOffset + 2 > bytes.length) return null;
  const instruction = halfwordAt(bytes, instructionOffset);
  if ((instruction & 0xF800) !== 0x4800) return null;
  const literalOffset = alignDown(instructionOffset + 4, 4) + ((instruction & 0xFF) << 2);
  if (literalOffset < 0 || literalOffset + 4 > bytes.length) return null;
  return {
    register: (instruction >>> 8) & 0x7,
    literalOffset,
    value: readU32(bytes, literalOffset),
  };
}

function thumbBlTarget(bytes, instructionOffset) {
  if (instructionOffset < 0 || instructionOffset + 4 > bytes.length) return null;
  const high = halfwordAt(bytes, instructionOffset);
  const low = halfwordAt(bytes, instructionOffset + 2);
  if ((high & 0xF800) !== 0xF000 || (low & 0xF800) !== 0xF800) return null;
  let displacement = ((high & 0x7FF) << 12) | ((low & 0x7FF) << 1);
  if (displacement & 0x400000) displacement -= 0x800000;
  return instructionOffset + 4 + displacement;
}

function isWritableGbaRamAddress(address) {
  return (address >= 0x02000000 && address < 0x02040000)
    || (address >= 0x03000000 && address < 0x03008000);
}

function isThumbPushWithLr(instruction) {
  return (instruction & 0xFF00) === 0xB500;
}

function isThumbBx(instruction) {
  return (instruction & 0xFF87) === 0x4700;
}

function nearestThumbFunctionStart(bytes, referenceOffset, maxDistance = ZODIAC_ENTRY_SCAN_BYTES) {
  const minimum = Math.max(0, referenceOffset - maxDistance);
  for (let offset = alignDown(referenceOffset, 2); offset >= minimum; offset -= 2) {
    if (isThumbPushWithLr(halfwordAt(bytes, offset))) return offset;
  }
  return null;
}

function thumbFunctionEnd(bytes, functionOffset, searchFrom) {
  const limit = Math.min(bytes.length, functionOffset + ZODIAC_FUNCTION_SCAN_BYTES);
  for (let offset = alignUp(Math.max(functionOffset + 2, searchFrom), 2); offset + 2 <= limit; offset += 2) {
    const instruction = halfwordAt(bytes, offset);
    if (instruction === 0x4770 || (instruction & 0xFF00) === 0xBD00) return offset + 2;
    if (isThumbBx(instruction) && offset >= functionOffset + 2) {
      const previous = halfwordAt(bytes, offset - 2);
      if ((previous & 0xFE00) === 0xBC00) return offset + 2;
    }
  }
  return null;
}

function thumbBlCalls(bytes, start, end) {
  const calls = [];
  for (let offset = alignUp(Math.max(0, start), 2); offset + 4 <= Math.min(bytes.length, end); offset += 2) {
    const target = thumbBlTarget(bytes, offset);
    if (target !== null) calls.push({ offset, target });
  }
  return calls;
}

function thumbBlCallsTo(bytes, target, start, end) {
  return thumbBlCalls(bytes, start, end).filter((call) => call.target === target);
}

function containsHalfword(bytes, start, end, expected) {
  for (let offset = alignUp(start, 2); offset + 2 <= end; offset += 2) {
    if (halfwordAt(bytes, offset) === expected) return true;
  }
  return false;
}

function literalValuesInRange(bytes, start, end) {
  const values = new Set();
  for (let offset = alignUp(start, 2); offset + 2 <= end; offset += 2) {
    const reference = thumbLiteralReference(bytes, offset);
    if (reference) values.add(reference.value);
  }
  return values;
}

function copiesR0ToSavedRegister(bytes, start, end) {
  for (let offset = alignUp(start, 2); offset + 2 <= end; offset += 2) {
    const instruction = halfwordAt(bytes, offset);
    const copiesLowR0 = (instruction & 0xFFF8) === 0x1C00
      || (instruction & 0xFFF8) === 0x4600;
    if (copiesLowR0 && (instruction & 0x7) >= 4) return true;
  }
  return false;
}

function inspectZodiacRawTimeReader(bytes, rawTimeOffset, commandOffset) {
  if (rawTimeOffset < 0 || (rawTimeOffset & 1) || !isThumbPushWithLr(halfwordAt(bytes, rawTimeOffset))) return null;
  const functionEnd = thumbFunctionEnd(bytes, rawTimeOffset, commandOffset + 2);
  if (functionEnd === null || functionEnd - rawTimeOffset < ZODIAC_RAW_TIME_HOOK_SIZE) return null;
  const literals = literalValuesInRange(bytes, rawTimeOffset, commandOffset + 2);
  if (!literals.has(ZODIAC_GPIO_DATA_ADDRESS) || !literals.has(ZODIAC_GPIO_DIRECTION_ADDRESS)) return null;
  if (!copiesR0ToSavedRegister(bytes, rawTimeOffset + 2, Math.min(commandOffset, rawTimeOffset + 0x20))) return null;

  const calls = thumbBlCalls(bytes, commandOffset + 2, functionEnd);
  const callsByTarget = new Map();
  for (const call of calls) callsByTarget.set(call.target, (callsByTarget.get(call.target) || 0) + 1);
  if (![...callsByTarget.values()].some((count) => count >= 2)) return null;

  let outputStores = 0;
  for (let offset = commandOffset + 2; offset + 2 <= functionEnd; offset += 2) {
    if ((halfwordAt(bytes, offset) & 0xF807) === 0x7000) outputStores += 1;
  }
  if (outputStores < 2 || !containsHalfword(bytes, Math.max(rawTimeOffset, functionEnd - 0x10), functionEnd, 0x2000)) return null;
  return { rawTimeOffset, functionEnd };
}

function findZodiacRawTimeReaders(bytes) {
  const readersByOffset = new Map();
  let commandAnchors = 0;
  let position = 0;
  while (true) {
    position = findBytes(bytes, ZODIAC_FULL_TIME_COMMAND_BYTES, position);
    if (position < 0) break;
    if ((position & 1) === 0) {
      commandAnchors += 1;
      const rawTimeOffset = nearestThumbFunctionStart(bytes, position);
      if (rawTimeOffset !== null) {
        const reader = inspectZodiacRawTimeReader(bytes, rawTimeOffset, position);
        if (reader) readersByOffset.set(rawTimeOffset, reader);
      }
    }
    position += 1;
  }
  return { commandAnchors, readers: [...readersByOffset.values()] };
}

function inspectZodiacProbe(bytes, probeOffset) {
  if (probeOffset < 0 || (probeOffset & 1) || probeOffset + ZODIAC_PROBE_SIZE > bytes.length) return null;
  const statusReference = thumbLiteralReference(bytes, probeOffset);
  if (!statusReference || !isWritableGbaRamAddress(statusReference.value)) return null;
  const baseRegister = statusReference.register;
  const expectedLoad = 0x6800 | (baseRegister << 3);
  if (halfwordAt(bytes, probeOffset + 2) !== expectedLoad
      || halfwordAt(bytes, probeOffset + 4) !== 0x2800
      || halfwordAt(bytes, probeOffset + 6) !== 0xD000
      || halfwordAt(bytes, probeOffset + 8) !== 0x2001
      || halfwordAt(bytes, probeOffset + 10) !== 0x4770) return null;
  return { probeOffset, statusAddress: statusReference.value };
}

function isStoreR0AtRegisterZero(instruction, baseRegister) {
  const opcode = instruction & 0xF800;
  if (opcode !== 0x6000 && opcode !== 0x7000) return false;
  return (instruction & 0x7FF) === (baseRegister << 3);
}

function storedR0AddressNear(bytes, start, end) {
  for (let offset = alignUp(start, 2); offset + 4 <= end; offset += 2) {
    const reference = thumbLiteralReference(bytes, offset);
    if (reference && isStoreR0AtRegisterZero(halfwordAt(bytes, offset + 2), reference.register)) {
      return reference.value;
    }
  }
  return null;
}

function functionStoresR0ToAddress(bytes, functionOffset, functionEnd, address) {
  for (let offset = functionOffset; offset + 4 <= functionEnd; offset += 2) {
    const reference = thumbLiteralReference(bytes, offset);
    if (reference?.value === address
        && isStoreR0AtRegisterZero(halfwordAt(bytes, offset + 2), reference.register)) return true;
  }
  return false;
}

function rawBufferAddressBeforeCall(bytes, functionOffset, callOffset) {
  for (let offset = callOffset - 2; offset >= Math.max(functionOffset, callOffset - 0x10); offset -= 2) {
    const reference = thumbLiteralReference(bytes, offset);
    if (reference?.register === 0 && isWritableGbaRamAddress(reference.value)) return reference.value;
  }
  return null;
}

function inspectZodiacSetup(bytes, setupOffset, rawCallOffset, rawTimeOffset) {
  if (setupOffset < 0 || (setupOffset & 1) || !isThumbPushWithLr(halfwordAt(bytes, setupOffset))) return null;
  const functionEnd = thumbFunctionEnd(bytes, setupOffset, rawCallOffset + 4);
  if (functionEnd === null || !containsHalfword(bytes, setupOffset, functionEnd, 0x2063)) return null;
  const literals = literalValuesInRange(bytes, setupOffset, functionEnd);
  if (!literals.has(ZODIAC_GPIO_CONTROL_ADDRESS) || !literals.has(ZODIAC_GPIO_DIRECTION_ADDRESS)) return null;
  const rawBufferAddress = rawBufferAddressBeforeCall(bytes, setupOffset, rawCallOffset);
  if (rawBufferAddress === null) return null;

  for (const call of thumbBlCalls(bytes, setupOffset, functionEnd)) {
    if (call.offset === rawCallOffset || call.target === rawTimeOffset) continue;
    const probe = inspectZodiacProbe(bytes, call.target);
    if (!probe) continue;
    const availableAddress = storedR0AddressNear(bytes, call.offset + 4, Math.min(functionEnd, call.offset + 0x14));
    if (!isWritableGbaRamAddress(availableAddress)
        || rawBufferAddress !== availableAddress + 1
        || !functionStoresR0ToAddress(bytes, setupOffset, functionEnd, probe.statusAddress)) continue;
    return {
      setupOffset,
      probeOffset: probe.probeOffset,
      statusAddress: probe.statusAddress,
      availableAddress,
      rawBufferAddress,
    };
  }
  return null;
}

function hasZodiacOrchestrator(bytes, probeOffset, setupOffset) {
  const start = Math.max(0, probeOffset - THUMB_BL_REACH);
  const end = Math.min(bytes.length, probeOffset + THUMB_BL_REACH);
  for (const call of thumbBlCallsTo(bytes, probeOffset, start, end)) {
    let sawZeroCompare = false;
    let sawConditionalBranch = false;
    const sequenceEnd = Math.min(end, call.offset + 0x30);
    for (let offset = call.offset + 4; offset + 2 <= sequenceEnd; offset += 2) {
      const instruction = halfwordAt(bytes, offset);
      if (instruction === 0x2800) sawZeroCompare = true;
      else if (sawZeroCompare && (instruction & 0xFE00) === 0xD000) sawConditionalBranch = true;
      if (sawZeroCompare && sawConditionalBranch && thumbBlTarget(bytes, offset) === setupOffset) return true;
    }
  }
  return false;
}

function inspectZodiacRtcProfile(bytes, excludedRanges = []) {
  const { commandAnchors, readers } = findZodiacRawTimeReaders(bytes);
  const verifiedByKey = new Map();
  for (const reader of readers) {
    // A direct Thumb-1 BL can reach four MiB in either direction. Searching
    // exactly that architectural range permits arbitrary linker placement.
    const start = Math.max(0, reader.rawTimeOffset - THUMB_BL_REACH);
    const end = Math.min(bytes.length, reader.rawTimeOffset + THUMB_BL_REACH);
    for (const rawCall of thumbBlCallsTo(bytes, reader.rawTimeOffset, start, end)) {
      const setupOffset = nearestThumbFunctionStart(bytes, rawCall.offset, ZODIAC_FUNCTION_SCAN_BYTES);
      if (setupOffset === null) continue;
      const setup = inspectZodiacSetup(bytes, setupOffset, rawCall.offset, reader.rawTimeOffset);
      if (!setup || !hasZodiacOrchestrator(bytes, setup.probeOffset, setup.setupOffset)) continue;
      if (overlapsAnyRange(setup.probeOffset, setup.probeOffset + ZODIAC_PROBE_SIZE, excludedRanges)
          || overlapsAnyRange(reader.rawTimeOffset, reader.rawTimeOffset + ZODIAC_RAW_TIME_HOOK_SIZE, excludedRanges)) continue;
      const key = `${setup.probeOffset}:${reader.rawTimeOffset}:${setup.availableAddress}:${setup.statusAddress}`;
      verifiedByKey.set(key, {
        id: RTC_HANDLER_FAMILY_ZODIAC,
        configuration: {
          availableAddress: setup.availableAddress,
          statusAddress: setup.statusAddress,
        },
        matches: [
          {
            name: "probe",
            offset: setup.probeOffset,
            size: ZODIAC_PROBE_SIZE,
            payloadSymbol: "payload_zodiac_probe",
          },
          {
            name: "gettimedate",
            offset: reader.rawTimeOffset,
            size: ZODIAC_RAW_TIME_HOOK_SIZE,
            payloadSymbol: "payload_zodiac_gettimedate",
          },
        ],
      });
    }
  }

  const verified = [...verifiedByKey.values()];
  const offsets = verified
    .map((profile) => profile.matches[1].offset)
    .map((offset) => `0x${offset.toString(16).padStart(6, "0")}`)
    .join(", ") || "none";
  const problems = verified.length === 1 ? [] : [
    `cluster: expected 1 verified match, found ${verified.length} (${offsets}; command anchors: ${commandAnchors}; compact readers: ${readers.length})`,
  ];
  return {
    label: "Zodiac/Wizard",
    problems,
    profile: problems.length ? null : verified[0],
  };
}

function findRtcProfile(bytes, excludedRanges = []) {
  const inspections = [
    inspectSiiRtcProfile(bytes, excludedRanges),
    inspectZodiacRtcProfile(bytes, excludedRanges),
  ];
  const profiles = inspections.flatMap((inspection) => inspection.profile ? [inspection.profile] : []);
  if (profiles.length === 1) return profiles[0];
  if (profiles.length > 1) {
    throw new PatchError(`RTC handler detection is ambiguous: ${profiles.map((profile) => profile.id).join(", ")}`);
  }
  const problems = inspections.flatMap((inspection) => (
    inspection.problems.map((problem) => `${inspection.label} ${problem}`)
  ));
  throw new PatchError(`RTC handler detection failed:\n  ${problems.join("\n  ")}`);
}

export function hasRecognizedRtcHandlerSet(bytes, excludedRanges = []) {
  try {
    return Boolean(findRtcProfile(bytes, excludedRanges));
  } catch {
    // Partial or ambiguous RTC implementations are not enough to justify a
    // startup-timing change. Callers can retain their established fallback.
    return false;
  }
}

function makeThumbJumpStub(targetAddr, totalSize, patchOffset) {
  if ((patchOffset & 1) || (totalSize & 1)) throw new PatchError("RTC: Thumb hook is not halfword-aligned");
  // Thumb literal loads word-align PC. A function at address 2 mod 4 therefore
  // needs one NOP before its aligned target literal.
  const literalOffset = (patchOffset & 3) === 0 ? 4 : 6;
  const minimumSize = literalOffset + 4;
  if (totalSize < minimumSize) throw new PatchError(`RTC: need at least ${minimumSize} bytes for Thumb jump stub, got ${totalSize}`);
  const stub = new Uint8Array(totalSize);
  for (let offset = 0; offset < totalSize; offset += 2) {
    stub[offset] = 0xC0;
    stub[offset + 1] = 0x46;
  }
  stub[0] = literalOffset === 4 ? 0x00 : 0x01;
  stub[1] = 0x4b;
  stub[2] = 0x18;
  stub[3] = 0x47;
  writeU32(stub, literalOffset, (targetAddr | 1) >>> 0);
  return stub;
}

function validatePayloadOffset(bytes, payloadOffset) {
  const payloadSpan = rtcPayloadSpanForLayout();
  if (!Number.isInteger(payloadOffset)) throw new PatchError("RTC: payload offset is invalid");
  if (payloadOffset % RTC_PAYLOAD_ALIGNMENT) throw new PatchError("RTC: payload offset must be 0x100-byte aligned");
  if (payloadOffset < 0 || payloadOffset + payloadSpan > GBA_PAYLOAD_PLACEMENT_LIMIT_BYTES) {
    throw new PatchError("RTC: payload would overlap the reserved 256-byte ROM tail");
  }
  if (payloadOffset < bytes.length && !isBlankRegion(bytes, payloadOffset, Math.min(payloadSpan, bytes.length - payloadOffset))) {
    throw new PatchError("RTC: chosen payload region is not free");
  }
}

function patchRtcOnWorkingRom(workRom, operations, warnings, originalBytes, rtcOptions = {}, context = {}) {
  const handlerProfile = findRtcProfile(originalBytes, context.excludedRanges || []);
  const matches = handlerProfile.matches;
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
      stageErasedRomExpansion(workRom, operations, {
        id: `rtc-expand-${operations.length}`,
        component: "rtc",
        newLength: end,
        metadata: {
          name: "RTC ROM expansion",
          value: end,
        },
      });
    }
  }

  const end = payloadOffset + RTC_PAYLOAD_SIZE;
  const region = workRom.bytes.slice(payloadOffset, end);
  if (!isBlankRegion(region, 0, region.length)) throw new PatchError("RTC: chosen payload region is not free");

  const linkAddr = (GBA_ROM_BASE_ADDRESS + payloadOffset) >>> 0;
  const payloadBuild = relocatePayload(embeddedPayloadBytes(), linkAddr);
  configureRtcTickMode(payloadBuild, tickMode);
  configureRtcBootMenu(payloadBuild, rtcOptions.showMenuOnBoot);
  configureRtcHandlerProfile(payloadBuild, handlerProfile, linkAddr);
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
    const target = payloadBuild.symbols[match.payloadSymbol];
    if (target === undefined) throw new PatchError(`RTC: missing payload symbol for ${match.name}`);
    const stub = makeThumbJumpStub(target, match.size, match.offset);
    stageRtcWrite(workRom.bytes, operations, `RTC ${match.name} hook`, match.offset, stub, {
      codeName: `rtc_${match.name}_hook`,
      value: target >>> 0,
    });
    handlerResults.push({ name: match.name, offset: match.offset, size: match.size, target: target >>> 0 });
  }

  return {
    requested: true,
    status: "patched",
    handlerFamily: handlerProfile.id,
    payloadOffset,
    runtimeBase: linkAddr,
    runtimeMenuEntry: payloadBuild.symbols.fake_rtc_menu_run_runtime === undefined ? null : (payloadBuild.symbols.fake_rtc_menu_run_runtime | 1) >>> 0,
    persistenceLoadEntry,
    persistenceFlushEntry,
    persistence,
    tickMode,
    showMenuOnBoot: rtcOptions.showMenuOnBoot !== false,
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
