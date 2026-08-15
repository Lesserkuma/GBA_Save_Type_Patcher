// SPDX-License-Identifier: GPL-3.0-or-later

import {
  findBytes,
  readU16,
  readU32,
  u16ToBytes,
  u32ToBytes,
} from "../core/binary.js";
import { overlapsAnyRange } from "../core/ranges.js";
import { decodeThumbBlTarget } from "../core/thumb.js";
import { SRAM_CONSTANTS as C } from "./sram-data.js";
import { stageWaitstateWrite } from "./waitstate-common.js";

const THUMB_LITERAL_BACKOFF = 0x404;
const ARM_LITERAL_BACKOFF = 0x1008;

function armLdrLiteral(instruction, instructionAddress) {
  if ((instruction & 0x0c000000) !== 0x04000000) return null;
  if (instruction & (1 << 25)) return null;
  if (!(instruction & (1 << 24))) return null;
  if (instruction & (1 << 22)) return null;
  if (instruction & (1 << 21)) return null;
  if (!(instruction & (1 << 20))) return null;
  if (((instruction >>> 16) & 0xf) !== 15) return null;
  const immediate = instruction & 0xfff;
  const pc = instructionAddress + 8;
  return {
    condition: instruction >>> 28,
    register: (instruction >>> 12) & 0xf,
    target: instruction & (1 << 23) ? pc + immediate : pc - immediate,
  };
}

function thumbLdrLiteral(instruction, instructionAddress) {
  if ((instruction & 0xf800) !== 0x4800) return null;
  const immediate = (instruction & 0xff) << 2;
  return {
    register: (instruction >>> 8) & 0x7,
    target: ((instructionAddress + 4) & ~3) + immediate,
  };
}

function thumbRegisterCopy(instruction) {
  if ((instruction & 0xffc0) === 0x1c00) {
    return { destination: instruction & 0x7, source: (instruction >>> 3) & 0x7 };
  }
  if ((instruction & 0xff00) === 0x4600) {
    return {
      destination: (instruction & 0x7) | ((instruction >>> 4) & 0x8),
      source: (instruction >>> 3) & 0xf,
    };
  }
  return null;
}

function thumbStrhZero(instruction) {
  if ((instruction & 0xffc0) !== 0x8000) return null;
  return { base: (instruction >>> 3) & 0x7, source: instruction & 0x7 };
}

function armRegisterCopy(instruction) {
  if ((instruction & 0x0fe00ff0) === 0x01a00000) {
    return { destination: (instruction >>> 12) & 0xf, source: instruction & 0xf };
  }
  if ((instruction & 0x0fe00fff) === 0x02800000) {
    return { destination: (instruction >>> 12) & 0xf, source: (instruction >>> 16) & 0xf };
  }
  return null;
}

function armStrhZero(instruction) {
  if (((instruction >>> 25) & 0x7) !== 0) return null;
  if (!(instruction & (1 << 24))) return null;
  if (!(instruction & (1 << 22))) return null;
  if (instruction & (1 << 21)) return null;
  if (instruction & (1 << 20)) return null;
  if ((instruction & 0xf0) !== 0xb0) return null;
  if ((((instruction >>> 8) & 0xf) << 4 | (instruction & 0xf)) !== 0) return null;
  return { base: (instruction >>> 16) & 0xf, source: (instruction >>> 12) & 0xf };
}

function loadedLiteralRoles(first, second, waitcntAddress, valueAddress) {
  if (first.target === waitcntAddress && second.target === valueAddress) {
    return { addressRegister: first.register, valueRegister: second.register };
  }
  if (first.target === valueAddress && second.target === waitcntAddress) {
    return { addressRegister: second.register, valueRegister: first.register };
  }
  return null;
}

function storeUsesLiteralRegisters(store, copy, roles) {
  if (!store || !roles || roles.addressRegister === roles.valueRegister) return false;
  if (!copy) {
    return store.base === roles.addressRegister && store.source === roles.valueRegister;
  }
  return copy.source === roles.valueRegister
    && copy.destination !== roles.addressRegister
    && store.base === roles.addressRegister
    && store.source === copy.destination;
}

function findThumbWaitcntStore(bytes, literalOffset) {
  const waitcntAddress = C.GBA_ROM_BASE + literalOffset;
  const valueAddress = waitcntAddress + 4;
  const start = Math.max(0, literalOffset - THUMB_LITERAL_BACKOFF) & ~1;
  for (let offset = start; offset + 4 < literalOffset; offset += 2) {
    const first = thumbLdrLiteral(readU16(bytes, offset), C.GBA_ROM_BASE + offset);
    const second = thumbLdrLiteral(readU16(bytes, offset + 2), C.GBA_ROM_BASE + offset + 2);
    if (!first || !second) continue;
    const roles = loadedLiteralRoles(first, second, waitcntAddress, valueAddress);
    if (!roles) continue;

    const directStore = thumbStrhZero(readU16(bytes, offset + 4));
    if (storeUsesLiteralRegisters(directStore, null, roles)) {
      return { instructionOffset: offset + 4, mode: "thumb" };
    }

    if (offset + 6 < literalOffset) {
      const copy = thumbRegisterCopy(readU16(bytes, offset + 4));
      const copiedStore = thumbStrhZero(readU16(bytes, offset + 6));
      if (storeUsesLiteralRegisters(copiedStore, copy, roles)) {
        return { instructionOffset: offset + 6, mode: "thumb" };
      }
    }
  }
  return null;
}

function findArmWaitcntStore(bytes, literalOffset) {
  const waitcntAddress = C.GBA_ROM_BASE + literalOffset;
  const valueAddress = waitcntAddress + 4;
  const start = Math.max(0, literalOffset - ARM_LITERAL_BACKOFF) & ~3;
  for (let offset = start; offset + 8 < literalOffset; offset += 4) {
    const first = armLdrLiteral(readU32(bytes, offset), C.GBA_ROM_BASE + offset);
    const second = armLdrLiteral(readU32(bytes, offset + 4), C.GBA_ROM_BASE + offset + 4);
    if (!first || !second || first.condition !== second.condition || first.condition === 0xf) continue;
    const roles = loadedLiteralRoles(first, second, waitcntAddress, valueAddress);
    if (!roles) continue;

    const directInstruction = readU32(bytes, offset + 8);
    const directStore = armStrhZero(directInstruction);
    if (
      (directInstruction >>> 28) === first.condition
      && storeUsesLiteralRegisters(directStore, null, roles)
    ) return { instructionOffset: offset + 8, mode: "arm" };

    if (offset + 12 < literalOffset) {
      const copyInstruction = readU32(bytes, offset + 8);
      const storeInstruction = readU32(bytes, offset + 12);
      const copy = armRegisterCopy(copyInstruction);
      const copiedStore = armStrhZero(storeInstruction);
      if (
        (copyInstruction >>> 28) === first.condition
        && (storeInstruction >>> 28) === first.condition
        && storeUsesLiteralRegisters(copiedStore, copy, roles)
      ) return { instructionOffset: offset + 12, mode: "arm" };
    }
  }
  return null;
}

function findVerifiedWaitcntStore(bytes, literalOffset) {
  return findThumbWaitcntStore(bytes, literalOffset)
    || findArmWaitcntStore(bytes, literalOffset);
}

function isRelevantArmRegisterRamReset(bytes, offset) {
  if (offset < 4 || offset + 4 > bytes.length || offset % 4) return false;
  const previous = readU32(bytes, offset - 4);
  return readU32(bytes, offset) === 0xef010000
    && ((previous & 0xffffff00) >>> 0) === 0xe3a00000
    && (previous & 0x80) !== 0;
}

function isRelevantThumbRegisterRamResetCall(bytes, offset, wrapperOffsets) {
  if (offset < 2 || offset + 4 > bytes.length || offset % 2) return false;
  const move = readU16(bytes, offset - 2);
  if ((move & 0xff00) !== 0x2000 || (move & 0x80) === 0) return false;
  const target = decodeThumbBlTarget(bytes, offset);
  return target !== null && wrapperOffsets.has(target);
}

/**
 * Finds only explicit RegisterRamReset call shapes whose flags include the
 * register-reset bit. Header identifiers and ROM identity are never read.
 */
export function findWaitstateSwiSites(bytes, excludedRanges = [], scanLimit = null) {
  const limit = scanLimit === undefined || scanLimit === null
    ? bytes.length
    : Math.min(bytes.length, Math.max(0, scanLimit));
  const wrapperOffsets = new Set();
  for (let offset = 0; offset + 4 <= limit; offset += 2) {
    if (
      readU16(bytes, offset) === 0xdf01
      && readU16(bytes, offset + 2) === 0x4770
      && !overlapsAnyRange(offset, offset + 4, excludedRanges)
    ) wrapperOffsets.add(offset);
  }

  const sites = [];
  for (let offset = 0; offset + 4 <= limit; offset += 2) {
    if (overlapsAnyRange(offset, offset + 4, excludedRanges)) continue;
    if (isRelevantThumbRegisterRamResetCall(bytes, offset, wrapperOffsets)) {
      sites.push({ instructionOffset: offset, mode: "thumb-bl" });
    }
    if (offset % 4 === 0 && isRelevantArmRegisterRamReset(bytes, offset)) {
      sites.push({ instructionOffset: offset, mode: "arm-swi" });
    }
  }
  return sites.sort((first, second) => first.instructionOffset - second.instructionOffset);
}

function thumbHighRegisterCopy(instruction) {
  if ((instruction & 0xff00) !== 0x4600) return null;
  return {
    destination: (instruction & 0x7) | ((instruction >>> 4) & 0x8),
    source: (instruction >>> 3) & 0xf,
  };
}

function thumbImmediateRegister(instruction, opcode) {
  if ((instruction & 0xf800) !== opcode) return null;
  return { register: (instruction >>> 8) & 0x7, immediate: instruction & 0xff };
}

function thumbHalfwordAccess(instruction, opcode) {
  if ((instruction & 0xf800) !== opcode) return null;
  return {
    register: instruction & 0x7,
    base: (instruction >>> 3) & 0x7,
    immediate: ((instruction >>> 6) & 0x1f) << 1,
  };
}

function isProvenEvenSlowClearLoop(bytes, offset) {
  if (offset < 0x24 || offset + 12 > bytes.length) return null;
  const load = thumbHalfwordAccess(readU16(bytes, offset), 0x8800);
  const store = thumbHalfwordAccess(readU16(bytes, offset + 2), 0x8000);
  const pointerAdvance = thumbImmediateRegister(readU16(bytes, offset + 4), 0x3000);
  const counterDecrement = thumbImmediateRegister(readU16(bytes, offset + 6), 0x3800);
  const counterCompare = thumbImmediateRegister(readU16(bytes, offset + 8), 0x2800);
  const branch = readU16(bytes, offset + 10);
  if (
    !load || !store || !pointerAdvance || !counterDecrement || !counterCompare
    || load.immediate !== 0
    || store.immediate !== 0
    || load.base !== store.base
    || load.register === store.register
    || pointerAdvance.register !== load.base
    || pointerAdvance.immediate !== 8
    || counterDecrement.immediate !== 1
    || counterCompare.immediate !== 0
    || counterDecrement.register !== counterCompare.register
    || branch !== 0xd1f9
  ) return null;

  const zeroInit = thumbImmediateRegister(readU16(bytes, offset - 0x24), 0x2000);
  const countLoad = thumbLdrLiteral(
    readU16(bytes, offset - 0x22),
    C.GBA_ROM_BASE + offset - 0x22,
  );
  const countPromote = thumbHighRegisterCopy(readU16(bytes, offset - 0x20));
  const countCopy = thumbHighRegisterCopy(readU16(bytes, offset - 4));
  const countIncrement = thumbImmediateRegister(readU16(bytes, offset - 2), 0x3000);
  if (
    !zeroInit || zeroInit.immediate !== 0 || zeroInit.register !== store.register
    || !countLoad || !countPromote || countPromote.source !== countLoad.register
    || countPromote.destination < 8
    || !countCopy || countCopy.source !== countPromote.destination
    || countCopy.destination !== counterDecrement.register
    || !countIncrement || countIncrement.register !== counterDecrement.register
    || countIncrement.immediate !== 1
    || countLoad.target < C.GBA_ROM_BASE
    || countLoad.target + 4 > C.GBA_ROM_BASE + bytes.length
  ) return null;
  const initialMinusOne = readU32(bytes, countLoad.target - C.GBA_ROM_BASE);
  const count = initialMinusOne + 1;
  if (!Number.isSafeInteger(count) || count < 2 || count > 0x10000 || count % 2) return null;
  return { load, store, counterDecrement, count };
}

/**
 * Unrolls a narrowly proven, even-count zero-fill loop by two. Every original
 * address is still cleared in the same order; only the unused read and half of
 * the loop-control overhead disappear. This prevents a slow-ROM timing race
 * without selecting a title, Game Code, hash, or library revision.
 */
export function patchWaitstateTimingSensitiveLoops(out, operations, excludedRanges = []) {
  let patched = 0;
  for (let offset = 0x24; offset + 12 <= out.length; offset += 2) {
    if (overlapsAnyRange(offset, offset + 12, excludedRanges)) continue;
    const loop = isProvenEvenSlowClearLoop(out, offset);
    if (!loop) continue;
    const firstStore = readU16(out, offset + 2);
    const replacement = new Uint8Array(12);
    const halfwords = [
      firstStore,
      firstStore | (4 << 6),
      0x3000 | (loop.load.base << 8) | 16,
      0x3800 | (loop.counterDecrement.register << 8) | 2,
      0xd1fa,
      0x46c0,
    ];
    halfwords.forEach((halfword, index) => replacement.set(u16ToBytes(halfword), index * 2));
    stageWaitstateWrite(out, operations, "Waitstate timing-sensitive clear loop", offset, replacement, {
      codeName: "waitstate_slow_clear_unroll",
      value: loop.count,
    });
    patched += 1;
    offset += 10;
  }
  return patched;
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
  const limit = scanLimit === undefined || scanLimit === null
    ? out.length
    : Math.min(out.length, Math.max(0, scanLimit));
  let patched = 0;
  let offset = findBytes(out, marker, 0, limit);
  while (offset >= 0) {
    const valueOffset = offset + 4;
    const canPatch = offset % 4 === 0
      && !overlapsAnyRange(offset, offset + 4, excludedRanges)
      && valueOffset + 4 <= out.length
      && !overlapsAnyRange(valueOffset, valueOffset + 4, excludedRanges)
      && findVerifiedWaitcntStore(out, offset) !== null;
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
