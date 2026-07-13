// SPDX-License-Identifier: GPL-3.0-or-later

import { findBytes, readU16, readU32 } from "../core/binary.js";
import { SRAM_CONSTANTS as C } from "./sram-data.js";
import { rangesOverlap, stageWaitstateWrite, u32ToBytes } from "./waitstate-common.js";

const WAITCNT_VALUE_EXACT = 0x04000204;
const ARM_LDR_BACKOFF = 1024;

function armLdrLiteralTarget(instruction, instructionAddress) {
  if ((instruction & 0x0c100000) !== 0x04100000) return null;
  if (((instruction >>> 16) & 0xf) !== 15) return null;
  const immediate = instruction & 0xfff;
  const pc = instructionAddress + 8;
  return instruction & (1 << 23) ? pc + immediate : pc - immediate;
}

function thumbLdrLiteralTarget(instruction, instructionAddress) {
  if ((instruction & 0xf800) !== 0x4800) return null;
  const immediate = (instruction & 0xff) << 2;
  return ((instructionAddress + 4) & ~3) + immediate;
}

function waitstateLiteralIsReferenced(bytes, targetOffset, searchStart, searchEnd) {
  const targetAddress = C.GBA_ROM_BASE + targetOffset;
  const start = Math.max(0, searchStart);
  const end = Math.min(bytes.length, searchEnd);
  for (let offset = start & ~1; offset < end - 1; offset += 2) {
    if (thumbLdrLiteralTarget(readU16(bytes, offset), C.GBA_ROM_BASE + offset) === targetAddress) {
      return true;
    }
  }
  for (let offset = start & ~3; offset < end - 3; offset += 4) {
    if (armLdrLiteralTarget(readU32(bytes, offset), C.GBA_ROM_BASE + offset) === targetAddress) {
      return true;
    }
  }
  return false;
}

export function applySuperfwPatchengineWaitcnt(inputBytes, operations, excludedRanges = []) {
  const out = new Uint8Array(inputBytes);
  const marker = u32ToBytes(WAITCNT_VALUE_EXACT);
  let patches = 0;
  let offset = findBytes(out, marker);
  while (offset >= 0) {
    const isReferenced = waitstateLiteralIsReferenced(
      out,
      offset,
      offset - ARM_LDR_BACKOFF * 4,
      offset,
    );
    if (
      offset % 4 === 0
      && !rangesOverlap(offset, offset + 4, excludedRanges)
      && isReferenced
    ) {
      stageWaitstateWrite(out, operations, "SuperFW WAITCNT literal", offset, u32ToBytes(0), {
        codeName: "superfw_patchengine_waitcnt",
        value: 0,
      });
      patches += 1;
    }
    offset = findBytes(out, marker, offset + 1);
  }
  return { bytes: out, patches };
}

export function patchWaitstateStartupLiterals(
  out,
  waitstateValue,
  operations,
  excludedRanges,
  scanLimit,
) {
  const marker = u32ToBytes(C.WAITSTATE_REGISTER);
  const targetValue = waitstateValue & 0xffff;
  const oldValues = new Set(
    C.WAITSTATE_DIRECT_OLD_VALUES
      .map((value) => value & 0xffff)
      .filter((value) => value !== targetValue),
  );
  const limit = Math.min(out.length, scanLimit || C.WAITSTATE_DIRECT_SCAN_LIMIT);
  let patched = 0;
  let offset = findBytes(out, marker, 0, limit);
  while (offset >= 0) {
    const valueOffset = offset + 4;
    const canPatch = offset % 4 === 0
      && !rangesOverlap(offset, offset + 4, excludedRanges)
      && valueOffset + 4 <= out.length
      && !rangesOverlap(valueOffset, valueOffset + 4, excludedRanges)
      && waitstateLiteralIsReferenced(out, offset, offset - 0x1000, offset);
    if (canPatch && oldValues.has(readU32(out, valueOffset) & 0xffff)) {
      stageWaitstateWrite(out, operations, "Waitstate startup WAITCNT value", valueOffset, u32ToBytes(targetValue), {
        codeName: "waitstate_startup_literal",
        value: targetValue,
      });
      patched += 1;
    }
    offset = findBytes(out, marker, offset + 1, limit);
  }
  return patched;
}
