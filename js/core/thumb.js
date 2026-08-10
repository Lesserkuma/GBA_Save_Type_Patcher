// SPDX-License-Identifier: GPL-3.0-or-later

import { readU16, writeU16 } from "./binary.js";

export function decodeThumbUnconditionalBranchTarget(halfword, instructionAddress) {
  if ((halfword & 0xf800) !== 0xe000) return null;
  let displacement = (halfword & 0x07ff) << 1;
  if (displacement & 0x0800) displacement -= 0x1000;
  return instructionAddress + 4 + displacement;
}

export function decodeThumbConditionalBranchTarget(halfword, instructionAddress) {
  if ((halfword & 0xf000) !== 0xd000 || (halfword & 0x0f00) >= 0x0e00) return null;
  let displacement = (halfword & 0x00ff) << 1;
  if (displacement & 0x0100) displacement -= 0x0200;
  return instructionAddress + 4 + displacement;
}

export function decodeThumbBlTargetFromHalfwords(
  firstHalfword,
  secondHalfword,
  instructionAddress,
) {
  if ((firstHalfword & 0xf800) !== 0xf000 || (secondHalfword & 0xf800) !== 0xf800) {
    return null;
  }
  let displacement = ((firstHalfword & 0x07ff) << 12)
    | ((secondHalfword & 0x07ff) << 1);
  if (displacement & 0x00400000) displacement -= 0x00800000;
  return instructionAddress + 4 + displacement;
}

export function encodeThumbUnconditionalBranchToTarget(targetAddress, instructionAddress) {
  const displacement = targetAddress - instructionAddress - 4;
  if (displacement % 2 !== 0) return null;
  const immediate = displacement >> 1;
  if (immediate < -0x400 || immediate > 0x3ff) return null;
  return 0xe000 | (immediate & 0x07ff);
}

export function encodeThumbBlToTarget(targetAddress, instructionAddress) {
  const displacement = targetAddress - instructionAddress - 4;
  if (
    displacement % 2 !== 0
    || displacement < -0x400000
    || displacement > 0x3ffffe
  ) {
    return null;
  }
  return [
    0xf000 | ((displacement >> 12) & 0x07ff),
    0xf800 | ((displacement >> 1) & 0x07ff),
  ];
}

export function decodeThumbBlTarget(bytes, offset) {
  if (
    !(bytes instanceof Uint8Array)
    || offset < 0
    || offset + 4 > bytes.length
    || offset % 2 !== 0
  ) {
    return null;
  }
  return decodeThumbBlTargetFromHalfwords(
    readU16(bytes, offset),
    readU16(bytes, offset + 2),
    offset,
  );
}

export function decodeThumbBranchTarget(bytes, offset) {
  if (
    !(bytes instanceof Uint8Array)
    || offset < 0
    || offset + 2 > bytes.length
    || offset % 2 !== 0
  ) {
    return null;
  }
  const halfword = readU16(bytes, offset);
  return decodeThumbUnconditionalBranchTarget(halfword, offset)
    ?? decodeThumbConditionalBranchTarget(halfword, offset);
}

export function writeThumbBl(bytes, writeOffset, sourceOffset, targetOffset) {
  const encoded = encodeThumbBlToTarget(targetOffset, sourceOffset);
  if (encoded === null || writeOffset < 0 || writeOffset + 4 > bytes.length) return false;
  writeU16(bytes, writeOffset, encoded[0]);
  writeU16(bytes, writeOffset + 2, encoded[1]);
  return true;
}
