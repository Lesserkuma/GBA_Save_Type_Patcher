// SPDX-License-Identifier: GPL-3.0-or-later

import { readU32 } from "./binary.js";

export function decodeArmBranchTarget(instruction, instructionAddress) {
  if (((instruction >>> 25) & 0x07) !== 0x05) return null;
  let displacement = instruction & 0x00ffffff;
  if (displacement & 0x00800000) displacement -= 0x01000000;
  return instructionAddress + 8 + (displacement << 2);
}

export function decodeArmBranchTargetAt(bytes, offset, addressBase = 0) {
  if (!(bytes instanceof Uint8Array) || offset < 0 || offset + 4 > bytes.length) return null;
  return decodeArmBranchTarget(readU32(bytes, offset), addressBase + offset);
}

export function encodeArmBranchToTarget(originalInstruction, instructionAddress, targetAddress) {
  if (((originalInstruction >>> 25) & 0x07) !== 0x05) return null;
  const displacement = targetAddress - instructionAddress - 8;
  if (displacement % 4 !== 0) return null;
  const immediate = displacement / 4;
  if (immediate < -0x800000 || immediate > 0x7fffff) return null;
  return ((originalInstruction & 0xff000000) | (immediate & 0x00ffffff)) >>> 0;
}

export function makeArmBranchInstruction(sourceAddress, targetAddress, link = false) {
  const immediate = (targetAddress - sourceAddress - 8) >> 2;
  if (immediate < -0x800000 || immediate > 0x7fffff) return null;
  const opcode = link ? 0xeb000000 : 0xea000000;
  return (opcode | (immediate & 0x00ffffff)) >>> 0;
}
