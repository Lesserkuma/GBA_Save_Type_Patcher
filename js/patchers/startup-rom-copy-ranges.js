// SPDX-License-Identifier: GPL-3.0-or-later

import { readU16, readU32 } from "../core/binary.js";

const GBA_ROM_BASE = 0x08000000;
const GBA_ROM_WINDOW_SIZE = 0x02000000;
const STARTUP_SCAN_SIZE = 0x1000;
const MAX_COPY_HELPER_DISTANCE = 0x400;

const THUMB_WORD_COPY_HELPER = Object.freeze([
  0x1aa3, // subs r3, r4, r2
  0xd003, // beq  done
  0xc901, // ldmia r1!, {r0}
  0xc201, // stmia r2!, {r0}
  0x3b04, // subs r3, #4
  0xd1fb, // bne  copy
  0x4770, // bx    lr
]);

const WRITABLE_COPY_REGIONS = Object.freeze([
  [0x02000000, 0x02040000], // EWRAM
  [0x03000000, 0x03008000], // IWRAM
  [0x05000000, 0x05000400], // palette RAM
  [0x06000000, 0x06018000], // VRAM
  [0x07000000, 0x07000400], // OAM
]);

function decodeArmEntrypointOffset(bytes) {
  if (bytes.length < 4) return null;
  const instruction = readU32(bytes, 0);
  if (((instruction >>> 24) & 0xff) !== 0xea) return null;
  let immediate = instruction & 0x00ffffff;
  if (immediate & 0x00800000) immediate -= 0x01000000;
  const target = 8 + immediate * 4;
  return target >= 0 && target < bytes.length && target % 2 === 0
    ? target
    : null;
}

function decodeThumbBlTarget(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length || offset % 2) return null;
  const high = readU16(bytes, offset);
  const low = readU16(bytes, offset + 2);
  if ((high & 0xf800) !== 0xf000 || (low & 0xf800) !== 0xf800) return null;
  let displacement = ((high & 0x07ff) << 12) | ((low & 0x07ff) << 1);
  if (displacement & 0x00400000) displacement -= 0x00800000;
  return offset + 4 + displacement;
}

function readThumbLiteral(bytes, instructionOffset, register, startupStart, startupEnd) {
  if (instructionOffset < startupStart || instructionOffset + 2 > startupEnd) return null;
  const instruction = readU16(bytes, instructionOffset);
  if ((instruction & 0xf800) !== 0x4800 || ((instruction >>> 8) & 0x07) !== register) return null;
  const literalOffset = ((instructionOffset + 4) & ~3) + ((instruction & 0xff) << 2);
  if (literalOffset < startupStart || literalOffset + 4 > startupEnd) return null;
  return readU32(bytes, literalOffset);
}

function isThumbWordCopyHelper(bytes, offset, startupStart, startupEnd) {
  const byteLength = THUMB_WORD_COPY_HELPER.length * 2;
  if (
    offset < startupStart
    || offset + byteLength > startupEnd
    || offset % 2
  ) return false;
  return THUMB_WORD_COPY_HELPER.every(
    (instruction, index) => readU16(bytes, offset + index * 2) === instruction,
  );
}

function writableCopyLength(destination, end) {
  if (
    !Number.isSafeInteger(destination)
    || !Number.isSafeInteger(end)
    || destination % 4
    || end % 4
    || end <= destination
  ) return null;
  const region = WRITABLE_COPY_REGIONS.find(
    ([regionStart, regionEnd]) => destination >= regionStart && end <= regionEnd,
  );
  if (!region) return null;
  const length = end - destination;
  return length % 4 === 0 ? length : null;
}

function romSourceRange(bytes, sourceAddress, byteLength) {
  if (!Number.isSafeInteger(sourceAddress) || sourceAddress % 4 || byteLength <= 0) return null;
  if (sourceAddress < GBA_ROM_BASE || sourceAddress >= 0x0e000000) return null;
  const windowBase = sourceAddress & 0x0e000000;
  if (sourceAddress + byteLength > windowBase + GBA_ROM_WINDOW_SIZE) return null;
  const start = sourceAddress - windowBase;
  const end = start + byteLength;
  if (start < 0 || end > bytes.length) return null;
  return [start, end];
}

function mergeRanges(ranges) {
  const sorted = ranges
    .map(([start, end]) => [start, end])
    .sort((first, second) => first[0] - second[0] || first[1] - second[1]);
  const merged = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

/**
 * Find ROM source intervals copied into writable GBA memory by a narrowly
 * recognized startup helper. These intervals can contain 00/FF padding that
 * is nevertheless observable at runtime and therefore is unsafe for payloads.
 */
export function findStartupRomCopySourceRanges(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("Startup copy detection requires ROM bytes.");
  const startupStart = decodeArmEntrypointOffset(bytes);
  if (startupStart === null) return [];
  const startupEnd = Math.min(bytes.length, startupStart + STARTUP_SCAN_SIZE);
  const ranges = [];

  for (let callOffset = startupStart + 6; callOffset + 4 <= startupEnd; callOffset += 2) {
    const helperOffset = decodeThumbBlTarget(bytes, callOffset);
    if (
      helperOffset === null
      || helperOffset <= callOffset
      || helperOffset - callOffset > MAX_COPY_HELPER_DISTANCE
      || !isThumbWordCopyHelper(bytes, helperOffset, startupStart, startupEnd)
    ) continue;

    const sourceAddress = readThumbLiteral(bytes, callOffset - 6, 1, startupStart, startupEnd);
    const destination = readThumbLiteral(bytes, callOffset - 4, 2, startupStart, startupEnd);
    const end = readThumbLiteral(bytes, callOffset - 2, 4, startupStart, startupEnd);
    if (sourceAddress === null || destination === null || end === null) continue;
    const byteLength = writableCopyLength(destination, end);
    if (byteLength === null) continue;
    const range = romSourceRange(bytes, sourceAddress, byteLength);
    if (range) ranges.push(range);
  }

  return mergeRanges(ranges);
}
