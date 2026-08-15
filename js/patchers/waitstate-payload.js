// SPDX-License-Identifier: GPL-3.0-or-later

import { decodeArmBranchTargetAt, makeArmBranchInstruction } from "../core/arm.js";
import { asciiBytes, writeU16, writeU32 } from "../core/binary.js";
import { PatchError } from "../core/errors.js";
import { isBlankRegion } from "../core/ranges.js";
import { PATCH_OPERATION_KIND } from "../domain/constants.js";
import { SRAM_CONSTANTS as C } from "./sram-data.js";
import { stageWaitstateWrite } from "./waitstate-common.js";

export const WAITCNT_ENTRYPOINT_MARKER = "lk_waitcnt_bootstrap";
export const WAITCNT_SWI_RESTORE_MARKER = "lk_swi_waitcnt_restore";
export const WAITCNT_SWI_VENEER_MARKER = "lk_swi_waitcnt_veneer";
export const WAITCNT_ENTRYPOINT_MARKER_BYTES = asciiBytes(WAITCNT_ENTRYPOINT_MARKER);
export const WAITCNT_SWI_RESTORE_MARKER_BYTES = asciiBytes(WAITCNT_SWI_RESTORE_MARKER);
export const WAITCNT_SWI_VENEER_MARKER_BYTES = asciiBytes(WAITCNT_SWI_VENEER_MARKER);

export const WAITCNT_SWI_RESTORE_THUMB_OFFSET = 0;
export const WAITCNT_SWI_RESTORE_ARM_OFFSET = 20;
export const WAITCNT_SWI_RESTORE_SIZE = 52;
export const WAITCNT_SWI_VENEER_SIZE = 8;

export function decodeEntrypointAddress(bytes) {
  if (bytes.length < 4 || bytes[3] !== 0xea) {
    throw new PatchError("Unexpected entrypoint instruction");
  }
  return decodeArmBranchTargetAt(bytes, 0, C.GBA_ROM_BASE);
}

export function encodeArmBranch(sourceAddress, targetAddress) {
  const instruction = makeArmBranchInstruction(sourceAddress, targetAddress);
  if (instruction === null) {
    throw new PatchError("Entrypoint target is outside ARM branch range");
  }
  return instruction;
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

/**
 * RegisterRamReset (BIOS SWI 1) can clear WAITCNT. These two entrypoints run
 * the original SWI while preserving the register value selected by the user.
 * The payload is deliberately self-contained and carries no format/version
 * discriminator; callers are selected only from their instruction flow.
 */
export function makeWaitcntSwiRestorePayload() {
  const payload = new Uint8Array(WAITCNT_SWI_RESTORE_SIZE);
  const thumbHalfwords = [
    0x4903, // ldr  r1, [pc, #12] -> WAITCNT literal
    0x8809, // ldrh r1, [r1]
    0xb402, // push {r1}
    0xdf01, // swi  1
    0x4901, // ldr  r1, [pc, #4] -> the same WAITCNT literal
    0xbc01, // pop  {r0}
    0x8008, // strh r0, [r1]
    0x4770, // bx   lr
    0x0204,
    0x0400,
  ];
  thumbHalfwords.forEach((halfword, index) => writeU16(payload, index * 2, halfword));

  const armWords = [
    0xe3a02301, // mov r2, #0x04000000
    0xe5921204, // ldr r1, [r2, #0x204]
    0xe52d1004, // push {r1}
    0xef010000, // swi 1
    0xe49d0004, // pop {r0}
    0xe3a01301, // mov r1, #0x04000000
    0xe5810204, // str r0, [r1, #0x204]
    0xe12fff1e, // bx lr
  ];
  armWords.forEach((word, index) => {
    writeU32(payload, WAITCNT_SWI_RESTORE_ARM_OFFSET + index * 4, word);
  });
  return payload;
}

export function makeWaitcntSwiVeneer(veneerAddress, armRestoreAddress) {
  const branch = encodeArmBranch(veneerAddress + 4, armRestoreAddress);
  const veneer = new Uint8Array(WAITCNT_SWI_VENEER_SIZE);
  writeU16(veneer, 0, 0x4679); // mov r1, pc
  writeU16(veneer, 2, 0x4708); // bx r1 (continue in ARM state at +4)
  writeU32(veneer, 4, branch);
  return veneer;
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
  if (!isBlankRegion(bytes, markerOffset, marker.length)) {
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
