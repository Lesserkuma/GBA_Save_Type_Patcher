// SPDX-License-Identifier: GPL-3.0-or-later

import { asciiBytes, readU32, writeU32 } from "../core/binary.js";
import { PatchError } from "../core/errors.js";
import { PATCH_OPERATION_KIND } from "../domain/constants.js";
import { SRAM_CONSTANTS as C } from "./sram-data.js";
import { isFreeRegion, stageWaitstateWrite } from "./waitstate-common.js";

export const WAITCNT_ENTRYPOINT_MARKER = "lk_waitcnt_bootstrap";
export const WAITCNT_SWI_RESTORE_MARKER = "lk_swi_waitcnt_restore";
export const WAITCNT_ENTRYPOINT_MARKER_BYTES = asciiBytes(WAITCNT_ENTRYPOINT_MARKER);
export const WAITCNT_SWI_RESTORE_MARKER_BYTES = asciiBytes(WAITCNT_SWI_RESTORE_MARKER);

export function decodeEntrypointAddress(bytes) {
  if (bytes.length < 4 || bytes[3] !== 0xea) {
    throw new PatchError("Unexpected entrypoint instruction");
  }
  const branchWord = readU32(bytes, 0);
  let branchOffset = branchWord & 0x00ffffff;
  if (branchOffset & 0x00800000) branchOffset -= 0x01000000;
  return C.GBA_ROM_BASE + 8 + (branchOffset << 2);
}

export function encodeArmBranch(sourceAddress, targetAddress) {
  const branchOffset = (targetAddress - sourceAddress - 8) >> 2;
  if (branchOffset < -0x800000 || branchOffset > 0x7fffff) {
    throw new PatchError("Entrypoint target is outside ARM branch range");
  }
  return (0xea000000 | (branchOffset & 0x00ffffff)) >>> 0;
}

export function makeWaitstatePayload(waitstateValue, nextEntrypoint) {
  const payload = new Uint8Array(C.WAITSTATE_PAYLOAD_SIZE);
  const words = [
    0xe59f0008,
    0xe59f1008,
    0xe1c010b0,
    0xe59ff004,
    C.WAITSTATE_REGISTER,
    waitstateValue & 0xffff,
    nextEntrypoint >>> 0,
  ];
  words.forEach((word, index) => writeU32(payload, index * 4, word));
  return payload;
}

export function writeRomMarker(
  bytes,
  operations,
  offset,
  size,
  span,
  markerText,
  label,
  codeName,
) {
  const marker = asciiBytes(markerText);
  const markerOffset = offset + size;
  const markerEnd = markerOffset + marker.length;
  const paddingEnd = offset + span;
  if (markerEnd > paddingEnd || markerEnd > bytes.length) {
    throw new PatchError(`${label}: reserved payload span does not include the ROM marker`);
  }
  if (!isFreeRegion(bytes, markerOffset, marker.length)) {
    throw new PatchError(`${label}: ROM marker region is not free`);
  }
  stageWaitstateWrite(bytes, operations, label, markerOffset, marker, {
    kind: PATCH_OPERATION_KIND.LITERAL_REPLACE,
    codeName,
  });
  return true;
}

export function writeWaitstateEntrypointMarker(bytes, operations, offset, size, span) {
  return writeRomMarker(
    bytes,
    operations,
    offset,
    size,
    span,
    WAITCNT_ENTRYPOINT_MARKER,
    "WAITCNT entrypoint ROM marker",
    "waitcnt_entrypoint_rom_marker",
  );
}
