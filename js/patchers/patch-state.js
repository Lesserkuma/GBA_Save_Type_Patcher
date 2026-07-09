import { SRAM_CONSTANTS as C } from "./sram-data.js";

const GBA_HEADER_CHECKSUM_START = 0xa0;
const GBA_HEADER_CHECKSUM_END = 0xbc;
const GBA_HEADER_CHECKSUM_OFFSET = 0xbd;
const PATCH_HEADER_SAVE_SIZE_MASK = C.PATCH_HEADER_SAVE_SIZE_MASK ?? 0x07;
const PATCH_HEADER_SAVE_MEDIUM_MASK = C.PATCH_HEADER_SAVE_MEDIUM_MASK ?? 0x18;
const PATCH_HEADER_SAVE_MEDIUM_SHIFT = C.PATCH_HEADER_SAVE_MEDIUM_SHIFT ?? 3;
const PATCH_HEADER_FLAG_BATTERYLESS = C.PATCH_HEADER_FLAG_BATTERYLESS ?? 0x20;
const PATCH_HEADER_FLAG_WAITSTATE = C.PATCH_HEADER_FLAG_WAITSTATE ?? 0x40;
const PATCH_HEADER_FLAG_FAKE_RTC = C.PATCH_HEADER_FLAG_FAKE_RTC ?? 0x80;

export const PATCH_SAVE_MEDIUM = Object.freeze({
  NONE: 0,
  SRAM: 1,
  EEPROM: 2,
  FLASH: 3,
});

function patchSucceeded(result) {
  return Boolean(result && ["patched", "already_patched"].includes(result.status));
}

export function hasPatchHeaderMarker(bytes) {
  return Boolean(
    bytes.length > C.PATCH_HEADER_MARKER_OFFSET + 1
    && bytes[C.PATCH_HEADER_MARKER_OFFSET] === C.PATCH_HEADER_MARKER_VALUE
  );
}

export function readPatchFlags(bytes) {
  if (hasPatchHeaderMarker(bytes)) return bytes[C.PATCH_HEADER_MARKER_OFFSET + 1] & 0xff;
  return 0;
}

export function hasSaveTypePatch(flags) {
  return readPatchHeaderSaveMedium(flags) !== PATCH_SAVE_MEDIUM.NONE;
}

export function hasWaitstatePatch(flags) {
  return Boolean(flags & PATCH_HEADER_FLAG_WAITSTATE);
}

export function hasBatterylessPatch(flags) {
  return Boolean(flags & PATCH_HEADER_FLAG_BATTERYLESS);
}

export function hasFlashSaveType(flags) {
  return readPatchHeaderSaveMedium(flags) === PATCH_SAVE_MEDIUM.FLASH;
}

export function hasFakeRtcPatch(flags) {
  return Boolean(flags & PATCH_HEADER_FLAG_FAKE_RTC);
}

export function patchHeaderSaveSizeCode(saveSize) {
  if (saveSize === null || saveSize === undefined) return C.PATCH_HEADER_SAVE_SIZE_CODES.None || 0;
  return C.PATCH_HEADER_SAVE_SIZE_CODES[String(saveSize)] || 0;
}

export function readPatchHeaderSaveSize(flags) {
  const code = flags & PATCH_HEADER_SAVE_SIZE_MASK;
  for (const [size, candidate] of Object.entries(C.PATCH_HEADER_SAVE_SIZE_CODES)) {
    if (candidate === code) return size === "None" ? null : Number(size);
  }
  return null;
}

export function readPatchHeaderSaveMedium(flags) {
  return (flags & PATCH_HEADER_SAVE_MEDIUM_MASK) >>> PATCH_HEADER_SAVE_MEDIUM_SHIFT;
}

export function decodePatchHeaderSaveMetadata(bytes) {
  if (!hasPatchHeaderMarker(bytes)) return null;

  const flags = readPatchFlags(bytes);
  const mediumCode = readPatchHeaderSaveMedium(flags);
  const size = readPatchHeaderSaveSize(flags);
  const batteryless = hasBatterylessPatch(flags);
  let medium = "none";
  let label = "Unknown";

  if (mediumCode === PATCH_SAVE_MEDIUM.SRAM) {
    medium = "sram";
    label = batteryless ? "Batteryless-SRAM" : "SRAM";
  } else if (mediumCode === PATCH_SAVE_MEDIUM.EEPROM) {
    medium = "eeprom";
    if (size === 512) label = "4K EEPROM";
    else if (size === 8192) label = "64K EEPROM";
    else label = "4K or 64K EEPROM";
  } else if (mediumCode === PATCH_SAVE_MEDIUM.FLASH) {
    medium = "flash";
    if (size === 65536) label = "512K FLASH";
    else if (size === 131072) label = "1M FLASH";
    else label = "FLASH";
  }

  return {
    library: null,
    medium,
    size,
    label,
    flags,
    batteryless,
    waitstate: hasWaitstatePatch(flags),
    fakeRtc: hasFakeRtcPatch(flags),
  };
}

export function makePatchHeaderFlags(bytes, options = {}) {
  let flags = readPatchFlags(bytes);
  const saveMedium = options.saveMedium;
  const saveSize = options.saveSize;
  const batteryless = options.batteryless;

  if (saveSize !== undefined) {
    flags = (flags & ~PATCH_HEADER_SAVE_SIZE_MASK) | patchHeaderSaveSizeCode(saveSize);
  }
  if (saveMedium !== undefined) {
    const medium = Number.isInteger(saveMedium)
      ? saveMedium
      : PATCH_SAVE_MEDIUM[String(saveMedium).toUpperCase()] ?? PATCH_SAVE_MEDIUM.NONE;
    flags = (flags & ~PATCH_HEADER_SAVE_MEDIUM_MASK) | ((medium << PATCH_HEADER_SAVE_MEDIUM_SHIFT) & PATCH_HEADER_SAVE_MEDIUM_MASK);
  }
  if (batteryless !== undefined) {
    flags = batteryless ? flags | PATCH_HEADER_FLAG_BATTERYLESS : flags & ~PATCH_HEADER_FLAG_BATTERYLESS;
  }
  if (patchSucceeded(options.waitstateResult)) flags |= PATCH_HEADER_FLAG_WAITSTATE;
  if (patchSucceeded(options.rtcResult)) flags |= PATCH_HEADER_FLAG_FAKE_RTC;

  return flags & 0xff;
}

export function applyPatchHeaderMarker(bytes, operations, flags) {
  if (bytes.length < C.GBA_HEADER_SIZE) return;
  const markerValue = C.PATCH_HEADER_MARKER_VALUE | ((flags & 0xff) << 8);
  if (
    bytes[C.PATCH_HEADER_MARKER_OFFSET] === C.PATCH_HEADER_MARKER_VALUE
    && bytes[C.PATCH_HEADER_MARKER_OFFSET + 1] === (flags & 0xff)
  ) {
    return;
  }

  bytes[C.PATCH_HEADER_MARKER_OFFSET] = C.PATCH_HEADER_MARKER_VALUE;
  bytes[C.PATCH_HEADER_MARKER_OFFSET + 1] = flags & 0xff;
  operations.push({
    name: "Patch marker in GBA header",
    offset: C.PATCH_HEADER_MARKER_OFFSET,
    size: 2,
    value: markerValue,
  });
}

export function computeGbaHeaderChecksum(bytes) {
  if (bytes.length <= GBA_HEADER_CHECKSUM_OFFSET) return null;
  let sum = 0;
  for (let offset = GBA_HEADER_CHECKSUM_START; offset <= GBA_HEADER_CHECKSUM_END; offset += 1) {
    sum = (sum + bytes[offset]) & 0xff;
  }
  return (-(sum + 0x19)) & 0xff;
}

export function updateGbaHeaderChecksum(bytes, operations) {
  const checksum = computeGbaHeaderChecksum(bytes);
  if (checksum === null) return null;
  const oldChecksum = bytes[GBA_HEADER_CHECKSUM_OFFSET] & 0xff;
  if (oldChecksum === checksum) return checksum;

  bytes[GBA_HEADER_CHECKSUM_OFFSET] = checksum;
  operations.push({
    name: "GBA header checksum",
    offset: GBA_HEADER_CHECKSUM_OFFSET,
    size: 1,
    value: checksum,
    old_value: oldChecksum,
  });
  return checksum;
}
