import { SRAM_CONSTANTS as C } from "./sram-data.js";

const GBA_HEADER_CHECKSUM_START = 0xa0;
const GBA_HEADER_CHECKSUM_END = 0xbc;
const GBA_HEADER_CHECKSUM_OFFSET = 0xbd;

export function readPatchFlags(bytes) {
  if (
    bytes.length > C.PATCH_HEADER_MARKER_OFFSET + 1
    && bytes[C.PATCH_HEADER_MARKER_OFFSET] === C.PATCH_HEADER_MARKER_VALUE
  ) {
    return bytes[C.PATCH_HEADER_MARKER_OFFSET + 1] & 0xff;
  }
  return 0;
}

export function hasSaveTypePatch(flags) {
  return Boolean(flags & (C.PATCH_HEADER_FLAG_SRAM | C.PATCH_HEADER_FLAG_BATTERYLESS));
}

export function hasWaitstatePatch(flags) {
  return Boolean(flags & C.PATCH_HEADER_FLAG_WAITSTATE);
}

export function hasBatterylessPatch(flags) {
  return Boolean(flags & C.PATCH_HEADER_FLAG_BATTERYLESS);
}

export function patchHeaderSaveSizeCode(saveSize) {
  if (saveSize === null || saveSize === undefined) return C.PATCH_HEADER_SAVE_SIZE_CODES.None || 0;
  return C.PATCH_HEADER_SAVE_SIZE_CODES[String(saveSize)] || 0;
}

export function makePatchHeaderFlags(bytes, { sramPatchApplied = false, waitstateResult = null, batterylessResult = null, saveSize = null } = {}) {
  const existingFlags = readPatchFlags(bytes);
  let lowFlags = existingFlags & 0x07;
  let saveSizeFlags = existingFlags & 0xf8;
  const saveSizeCode = patchHeaderSaveSizeCode(saveSize);

  if (saveSizeCode !== 0 || saveSizeFlags === 0) saveSizeFlags = (saveSizeCode << C.PATCH_HEADER_SAVE_SIZE_SHIFT) & 0xf8;
  if (sramPatchApplied) lowFlags |= C.PATCH_HEADER_FLAG_SRAM;
  if (waitstateResult && ["patched", "already_patched"].includes(waitstateResult.status)) lowFlags |= C.PATCH_HEADER_FLAG_WAITSTATE;
  if (batterylessResult && ["patched", "already_patched"].includes(batterylessResult.status)) lowFlags |= C.PATCH_HEADER_FLAG_BATTERYLESS;

  return (saveSizeFlags | lowFlags) & 0xff;
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
