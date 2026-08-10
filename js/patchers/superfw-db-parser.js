// SPDX-License-Identifier: GPL-3.0-or-later

import { tryReadU32 } from "../core/binary.js";
import { GBA_MAX_ROM_SIZE_BYTES } from "../domain/gba-constants.js";
import { markedPayloadSpan } from "./payload-placement.js";
import { SUPERFW_PATCH_DB_BASE64 } from "./superfw-db-data.generated.js";

const GBA_HEADER_GAME_CODE_OFFSET = 0xac;
const GBA_HEADER_VERSION_OFFSET = 0xbc;
const SUPERFW_DB_SIGNATURE = 0x31424450; // "PDB1"
const SUPERFW_DB_VERSION = 0x00010000;

let parsedSuperfwPatchDb = null;

function decodeBase64Bytes(base64) {
  if (typeof atob !== "function") {
    throw new Error("No base64 decoder is available in this environment.");
  }
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    out[index] = binary.charCodeAt(index) & 0xff;
  }
  return out;
}

function makeDbKeyFromParts(codeBytes, version) {
  return `${String.fromCharCode(...codeBytes)}:${version & 0xff}`;
}

function makeDbKeyFromRom(bytes) {
  if (bytes.length <= GBA_HEADER_VERSION_OFFSET) return null;
  const codeBytes = bytes.subarray(
    GBA_HEADER_GAME_CODE_OFFSET,
    GBA_HEADER_GAME_CODE_OFFSET + 4,
  );
  return makeDbKeyFromParts(codeBytes, bytes[GBA_HEADER_VERSION_OFFSET]);
}

function readPrograms(bytes) {
  const programs = [];
  let programOffset = 512;
  for (let programIndex = 0; programIndex < 4 && programOffset < 1024; programIndex += 1) {
    const length = bytes[programOffset];
    if (!length) break;
    const dataStart = programOffset + 1;
    const dataEnd = dataStart + length;
    if (dataEnd > 1024) throw new Error("Invalid superfw patch program table.");
    programs.push(bytes.slice(dataStart, dataEnd));
    programOffset = dataEnd;
  }
  return programs;
}

function readIndex(bytes, patchCount, indexOffset, entriesOffset) {
  const index = new Map();
  for (let entryIndex = 0; entryIndex < patchCount; entryIndex += 1) {
    const entryOffset = indexOffset + entryIndex * 8;
    if (entryOffset + 8 > entriesOffset || entryOffset + 8 > bytes.length) break;
    const codeBytes = bytes.subarray(entryOffset, entryOffset + 4);
    const offsetField = tryReadU32(bytes, entryOffset + 4);
    const gameVersion = offsetField & 0xff;
    index.set(makeDbKeyFromParts(codeBytes, gameVersion), offsetField >>> 8);
  }
  return index;
}

function parseSuperfwPatchDb() {
  if (parsedSuperfwPatchDb !== null) return parsedSuperfwPatchDb;
  const bytes = decodeBase64Bytes(SUPERFW_PATCH_DB_BASE64);
  if (
    tryReadU32(bytes, 0) !== SUPERFW_DB_SIGNATURE
    || tryReadU32(bytes, 4) !== SUPERFW_DB_VERSION
  ) {
    throw new Error("Unsupported superfw patch database format.");
  }

  const patchCount = tryReadU32(bytes, 8);
  const indexCount = tryReadU32(bytes, 12);
  const indexOffset = 1024;
  const entriesOffset = indexOffset + 512 * indexCount;
  parsedSuperfwPatchDb = {
    bytes,
    programs: readPrograms(bytes),
    index: readIndex(bytes, patchCount, indexOffset, entriesOffset),
    entriesOffset,
  };
  return parsedSuperfwPatchDb;
}

export function getSuperfwDbEntryForRom(bytes) {
  const key = makeDbKeyFromRom(bytes);
  if (key === null) return null;
  const db = parseSuperfwPatchDb();
  const patchEntryWordOffset = db.index.get(key);
  if (patchEntryWordOffset === undefined) return null;

  const entryOffset = db.entriesOffset + patchEntryWordOffset * 4;
  const patchHeader = tryReadU32(db.bytes, entryOffset);
  if (patchHeader === null) throw new Error("Invalid superfw patch database entry.");
  const wcntOps = patchHeader & 0xff;
  const ops = [];
  for (let index = 0; index < wcntOps; index += 1) {
    const operation = tryReadU32(db.bytes, entryOffset + 4 * (1 + index));
    if (operation === null) throw new Error("Truncated superfw WAITCNT operation list.");
    ops.push(operation);
  }
  return { programs: db.programs, ops, wcntOps };
}

function collectSuperfwProgramWrites(entry, markerSize = 0) {
  if (!entry) return [];
  const writes = [];
  const seen = new Set();
  for (let index = 0; index < entry.ops.length; index += 1) {
    const operation = entry.ops[index] >>> 0;
    const opcode = operation >>> 28;
    const argument = (operation >>> 25) & 7;
    const offset = operation & 0x01ffffff;
    if (opcode === 0x0) {
      const program = entry.programs[argument] || new Uint8Array(0);
      const key = `${argument}:${offset}:${program.length}`;
      if (program.length && offset < GBA_MAX_ROM_SIZE_BYTES && !seen.has(key)) {
        seen.add(key);
        writes.push({
          programIndex: argument,
          oldOffset: offset,
          size: program.length,
          span: markedPayloadSpan(program.length, markerSize),
        });
      }
    } else if (opcode === 0x3) {
      index += Math.floor((argument + 4) / 4);
    } else if (opcode === 0x4) {
      index += argument + 1;
    }
  }
  return writes;
}

export function makeSuperfwProgramRelocations(entry, programBaseOffset = null, markerSize = 0) {
  const writes = collectSuperfwProgramWrites(entry, markerSize);
  if (programBaseOffset === null || programBaseOffset === undefined || !writes.length) return [];
  let cursor = programBaseOffset;
  return writes.map((write) => {
    const relocation = { ...write, newOffset: cursor };
    cursor += write.span;
    return relocation;
  });
}

export function superfwProgramRelocationSpan(entry, markerSize = 0) {
  return collectSuperfwProgramWrites(entry, markerSize).reduce((sum, write) => sum + write.span, 0);
}

export function collectSuperfwFixedWriteRanges(entry) {
  if (!entry) return [];
  const ranges = [];
  for (let index = 0; index < entry.ops.length; index += 1) {
    const operation = entry.ops[index] >>> 0;
    const opcode = operation >>> 28;
    const argument = (operation >>> 25) & 7;
    const offset = operation & 0x01ffffff;
    let size = 0;
    if (opcode === 0x1) size = 2;
    else if (opcode === 0x2) size = 4;
    else if (opcode === 0x3) {
      size = argument + 1;
      index += Math.floor((size + 3) / 4);
    } else if (opcode === 0x4) {
      size = (argument + 1) * 4;
      index += argument + 1;
    } else if (opcode === 0x5) {
      size = argument === 0 || argument === 1 ? 4 : (argument === 4 || argument === 5 ? 8 : 0);
    }
    if (size > 0 && offset < GBA_MAX_ROM_SIZE_BYTES) {
      ranges.push([offset, Math.min(offset + size, GBA_MAX_ROM_SIZE_BYTES)]);
    }
  }
  return ranges;
}

export function waitstateFixedWriteRangesForLayout(inputBytes, waitstateOptions = {}) {
  if (!waitstateOptions?.enabled) return [];
  return collectSuperfwFixedWriteRanges(getSuperfwDbEntryForRom(inputBytes));
}
