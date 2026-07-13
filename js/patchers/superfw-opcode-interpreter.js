// SPDX-License-Identifier: GPL-3.0-or-later

import { PatchError } from "../core/errors.js";
import { SRAM_CONSTANTS as C } from "./sram-data.js";
import { makeSuperfwProgramRelocations } from "./superfw-db-parser.js";
import {
  MAX_GBA_ROM_SIZE,
  rangesOverlap,
  readU32At,
  recordAndWriteBytes,
  u16ToBytes,
  u32ToBytes,
  wordsToBytes,
  writeU16At,
  writeU32At,
} from "./waitstate-common.js";

function mapRelocatedSuperfwTarget(targetAddress, relocations) {
  const targetOffset = targetAddress - C.GBA_ROM_BASE;
  if (!Number.isFinite(targetOffset) || targetOffset < 0 || targetOffset >= MAX_GBA_ROM_SIZE) {
    return null;
  }
  for (const relocation of relocations || []) {
    const oldEnd = relocation.oldOffset + relocation.size;
    if (targetOffset >= relocation.oldOffset && targetOffset < oldEnd) {
      return (C.GBA_ROM_BASE + relocation.newOffset + targetOffset - relocation.oldOffset) >>> 0;
    }
  }
  return null;
}

function decodeArmBranchTarget(word, instructionAddress) {
  if (((word >>> 25) & 0x7) !== 0x5) return null;
  let immediate = word & 0x00ffffff;
  if (immediate & 0x00800000) immediate -= 0x01000000;
  return (instructionAddress + 8 + (immediate << 2)) >>> 0;
}

function encodeArmBranchToTarget(originalWord, instructionAddress, targetAddress) {
  const delta = targetAddress - instructionAddress - 8;
  if (delta % 4 !== 0) return null;
  const immediate = delta >> 2;
  if (immediate < -0x800000 || immediate > 0x7fffff) return null;
  return ((originalWord & 0xff000000) | (immediate & 0x00ffffff)) >>> 0;
}

function decodeThumbBranchTarget(halfword, instructionAddress) {
  if ((halfword & 0xf800) !== 0xe000) return null;
  let immediate = halfword & 0x07ff;
  if (immediate & 0x0400) immediate -= 0x0800;
  return (instructionAddress + 4 + (immediate << 1)) >>> 0;
}

function encodeThumbBranchToTarget(targetAddress, instructionAddress) {
  const delta = targetAddress - instructionAddress - 4;
  if (delta % 2 !== 0) return null;
  const immediate = delta >> 1;
  if (immediate < -0x400 || immediate > 0x3ff) return null;
  return 0xe000 | (immediate & 0x07ff);
}

function decodeThumbBlTarget(firstHalfword, secondHalfword, instructionAddress) {
  if ((firstHalfword & 0xf800) !== 0xf000 || (secondHalfword & 0xf800) !== 0xf800) return null;
  let high = firstHalfword & 0x07ff;
  if (high & 0x0400) high -= 0x0800;
  return (instructionAddress + 4 + (high << 12) + ((secondHalfword & 0x07ff) << 1)) >>> 0;
}

function encodeThumbBlToTarget(targetAddress, instructionAddress) {
  const delta = targetAddress - instructionAddress - 4;
  if (delta % 2 !== 0 || delta < -0x400000 || delta > 0x3ffffe) return null;
  return [0xf000 | ((delta >> 12) & 0x07ff), 0xf800 | ((delta >> 1) & 0x07ff)];
}

function relocateAbsoluteWords(bytes, writeOffset, relocations) {
  for (let offset = 0; offset + 4 <= bytes.length; offset += 1) {
    if ((writeOffset + offset) % 4 !== 0) continue;
    const value = readU32At(bytes, offset);
    const mapped = mapRelocatedSuperfwTarget(value & ~1, relocations);
    if (mapped !== null) writeU32At(bytes, offset, (mapped | (value & 1)) >>> 0);
  }
}

function relocateArmBranches(bytes, writeOffset, relocations, warnings) {
  for (let offset = 0; offset + 4 <= bytes.length; offset += 1) {
    if ((writeOffset + offset) % 4 !== 0) continue;
    const instructionAddress = C.GBA_ROM_BASE + writeOffset + offset;
    const word = readU32At(bytes, offset);
    const target = decodeArmBranchTarget(word, instructionAddress);
    const mapped = target === null ? null : mapRelocatedSuperfwTarget(target, relocations);
    if (mapped === null) continue;
    const encoded = encodeArmBranchToTarget(word, instructionAddress, mapped);
    if (encoded === null) {
      warnings?.push(`Waitstate: could not relocate ARM branch at 0x${(writeOffset + offset).toString(16)} to relocated SuperFW program`);
    } else {
      writeU32At(bytes, offset, encoded);
    }
  }
}

function relocateThumbBranches(bytes, writeOffset, relocations, warnings) {
  for (let offset = 0; offset + 2 <= bytes.length; offset += 1) {
    if ((writeOffset + offset) % 2 !== 0) continue;
    const instructionAddress = C.GBA_ROM_BASE + writeOffset + offset;
    const halfword = bytes[offset] | (bytes[offset + 1] << 8);
    const nextHalfword = offset + 4 <= bytes.length
      ? bytes[offset + 2] | (bytes[offset + 3] << 8)
      : null;
    const blTarget = nextHalfword === null
      ? null
      : decodeThumbBlTarget(halfword, nextHalfword, instructionAddress);
    const mappedBl = blTarget === null ? null : mapRelocatedSuperfwTarget(blTarget, relocations);
    if (mappedBl !== null) {
      const encodedBl = encodeThumbBlToTarget(mappedBl, instructionAddress);
      if (encodedBl === null) warnings?.push(`Waitstate: could not relocate Thumb BL at 0x${(writeOffset + offset).toString(16)} to relocated SuperFW program`);
      else {
        writeU16At(bytes, offset, encodedBl[0]);
        writeU16At(bytes, offset + 2, encodedBl[1]);
      }
      offset += 3;
      continue;
    }
    const target = decodeThumbBranchTarget(halfword, instructionAddress);
    const mapped = target === null ? null : mapRelocatedSuperfwTarget(target, relocations);
    if (mapped === null) continue;
    const encoded = encodeThumbBranchToTarget(mapped, instructionAddress);
    if (encoded === null) warnings?.push(`Waitstate: could not relocate Thumb branch at 0x${(writeOffset + offset).toString(16)} to relocated SuperFW program`);
    else writeU16At(bytes, offset, encoded);
  }
}

function relocateSuperfwWriteBytes(bytes, writeOffset, relocations, warnings) {
  if (!relocations?.length) return bytes;
  const relocated = new Uint8Array(bytes);
  relocateAbsoluteWords(relocated, writeOffset, relocations);
  relocateArmBranches(relocated, writeOffset, relocations, warnings);
  relocateThumbBranches(relocated, writeOffset, relocations, warnings);
  return relocated;
}

function relocatedProgramOffset(relocations, programIndex, oldOffset, size) {
  const relocation = (relocations || []).find((entry) => (
    entry.programIndex === programIndex
    && entry.oldOffset === oldOffset
    && entry.size === size
  ));
  return relocation ? relocation.newOffset : oldOffset;
}

function writeDbBytes(rom, operations, originalOffset, newBytes, codeName, context, meta = {}) {
  const actualOffset = meta.isProgram
    ? relocatedProgramOffset(
      context.programRelocations,
      meta.programIndex,
      originalOffset,
      newBytes.length,
    )
    : originalOffset;
  if (rangesOverlap(actualOffset, actualOffset + newBytes.length, context.excludedRanges)) {
    throw new PatchError(`SuperFW WAITCNT write overlaps an excluded range at 0x${actualOffset.toString(16)}`);
  }
  const relocated = relocateSuperfwWriteBytes(
    newBytes,
    actualOffset,
    context.programRelocations,
    context.warnings,
  );
  const relocatedName = meta.isProgram && actualOffset !== originalOffset
    ? `${codeName}_relocated`
    : codeName;
  return recordAndWriteBytes(rom, operations, actualOffset, relocated, relocatedName);
}

function applyInlineBytes(entry, operationIndex, argument, offset, context) {
  const byteCount = argument + 1;
  const wordCount = Math.floor((byteCount + 3) / 4);
  const bytes = new Uint8Array(byteCount);
  for (let index = 0; index < byteCount; index += 1) {
    const word = entry.ops[operationIndex + 1 + Math.floor(index / 4)] || 0;
    bytes[index] = (word >>> ((index & 3) * 8)) & 0xff;
  }
  return {
    advancedBy: wordCount,
    appliedCount: Number(writeDbBytes(context.rom, context.operations, offset, bytes, "superfw_db_wr_bytes", context)),
  };
}

function applyInlineWords(entry, operationIndex, argument, offset, context) {
  const wordCount = argument + 1;
  const words = Array.from(
    { length: wordCount },
    (_, index) => (entry.ops[operationIndex + 1 + index] || 0) >>> 0,
  );
  const writeAllowed = words.map((_, index) => offset + index < MAX_GBA_ROM_SIZE);
  let appliedCount = 0;
  if (writeAllowed.every(Boolean)) {
    appliedCount = Number(writeDbBytes(
      context.rom,
      context.operations,
      offset,
      wordsToBytes(words),
      "superfw_db_wr_words",
      context,
    ));
  } else {
    for (let index = 0; index < wordCount; index += 1) {
      if (!writeAllowed[index]) continue;
      appliedCount += Number(writeDbBytes(
        context.rom,
        context.operations,
        offset + index * 4,
        u32ToBytes(words[index]),
        "superfw_db_wr_word",
        context,
      ));
    }
  }
  return { advancedBy: wordCount, appliedCount };
}

function applyFunctionPatch(argument, offset, context) {
  if (argument === 0 || argument === 1) {
    const value = argument ? 0x47702001 : 0x47702000;
    return Number(writeDbBytes(context.rom, context.operations, offset, u32ToBytes(value), "superfw_db_patch_fn_thumb", context));
  }
  if (argument !== 4 && argument !== 5) return 0;
  const returnValue = argument === 5 ? 0xe3a00001 : 0xe3a00000;
  const first = writeDbBytes(context.rom, context.operations, offset, u32ToBytes(returnValue), "superfw_db_patch_fn_arm_ret", context);
  const second = writeDbBytes(context.rom, context.operations, offset + 4, u32ToBytes(0xe12fff1e), "superfw_db_patch_fn_arm_bx_lr", context);
  return Number(first) + Number(second);
}

function applyOperation(entry, operationIndex, context) {
  const operation = entry.ops[operationIndex] >>> 0;
  const opcode = operation >>> 28;
  const argument = (operation >>> 25) & 7;
  const offset = operation & 0x01ffffff;
  if (opcode === 0x0) {
    const program = entry.programs[argument] || new Uint8Array(0);
    return {
      advancedBy: 0,
      appliedCount: Number(Boolean(program.length && writeDbBytes(
        context.rom,
        context.operations,
        offset,
        program,
        `superfw_db_wr_buf_prg${argument}`,
        context,
        { isProgram: true, programIndex: argument },
      ))),
    };
  }
  if (opcode === 0x1) {
    return {
      advancedBy: 0,
      appliedCount: Number(writeDbBytes(
        context.rom,
        context.operations,
        offset,
        u16ToBytes(0x46c0),
        "superfw_db_nop_thumb",
        context,
      )),
    };
  }
  if (opcode === 0x2) {
    return {
      advancedBy: 0,
      appliedCount: Number(writeDbBytes(
        context.rom,
        context.operations,
        offset,
        u32ToBytes(0xe1a00000),
        "superfw_db_nop_arm",
        context,
      )),
    };
  }
  if (opcode === 0x3) return applyInlineBytes(entry, operationIndex, argument, offset, context);
  if (opcode === 0x4) return applyInlineWords(entry, operationIndex, argument, offset, context);
  if (opcode === 0x5) return { advancedBy: 0, appliedCount: applyFunctionPatch(argument, offset, context) };
  return { advancedBy: 0, appliedCount: 0 };
}

export function applySuperfwWaitcntDbOps(inputBytes, entry, operations, options = {}) {
  const context = {
    rom: { bytes: new Uint8Array(inputBytes) },
    operations,
    warnings: options.warnings || [],
    programRelocations: makeSuperfwProgramRelocations(
      entry,
      options.programBaseOffset ?? null,
      options.programMarkerSize ?? 0,
    ),
    excludedRanges: options.excludedRanges || [],
  };
  let appliedWrites = 0;
  for (let index = 0; index < entry.ops.length; index += 1) {
    const result = applyOperation(entry, index, context);
    appliedWrites += result.appliedCount;
    index += result.advancedBy;
  }
  return {
    bytes: context.rom.bytes,
    appliedWrites,
    programRelocations: context.programRelocations,
  };
}
