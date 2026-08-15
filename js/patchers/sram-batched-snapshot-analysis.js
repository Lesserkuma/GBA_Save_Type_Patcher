// SPDX-License-Identifier: GPL-3.0-or-later AND MIT

import { readU16, readU32, writeU32 } from "../core/binary.js";
import { PatchError } from "../core/errors.js";
import { decodeThumbBlTarget, decodeThumbBranchTarget } from "../core/thumb.js";
import { PATCH_OPERATION_KIND, PATCH_REASON_CODE } from "../domain/constants.js";
import {
  GBA_EWRAM_END_ADDRESS,
  GBA_EWRAM_START_ADDRESS,
  GBA_IWRAM_END_ADDRESS,
  GBA_IWRAM_START_ADDRESS,
  GBA_ROM_BASE_ADDRESS,
  GBA_SAVE_MEMORY_START_ADDRESS,
} from "../domain/gba-constants.js";
import { stagePatchOperation } from "../patch-engine/draft.js";

const SRAM_SIZE = 0x8000;
const RECORD_SIZE = 24;
const MAX_PROVIDERS = 128;
const MAX_TRANSIENT_RANGES = 8;
const SNAPSHOT_HEADER_SIZE = 16;
const MIRROR_METADATA_SIZE = 16;
// Keep the executable reader in the proven top-of-EWRAM slot used by the
// hardware-tested implementation; the unused tail also prevents instruction
// prefetch from crossing the EWRAM boundary.
const PERSISTENT_READER_RESERVED_SIZE = 0x80;
const PRIVATE_WORKSPACE_SIZE = SRAM_SIZE
  + MIRROR_METADATA_SIZE + PERSISTENT_READER_RESERVED_SIZE;

function romPointer(value, length, thumb = false) {
  if (thumb && (value & 1) === 0) return null;
  const offset = (value & ~1) - GBA_ROM_BASE_ADDRESS;
  return offset >= 0 && offset < length ? offset : null;
}

function ewramRange(address, length) {
  return address >= GBA_EWRAM_START_ADDRESS && length > 0 && address + length <= GBA_EWRAM_END_ADDRESS;
}

function ramProviderRange(address, length, allowVolatileProvider) {
  return ewramRange(address, length) || (
    allowVolatileProvider
    && address >= GBA_IWRAM_START_ADDRESS
    && length > 0
    && address + length <= GBA_IWRAM_END_ADDRESS
  );
}

function parseRecord(
  bytes,
  words,
  offset,
  { allowVolatileProvider = false, allowUnprovenCallbacks = false } = {},
) {
  if (offset < 0 || offset + RECORD_SIZE > bytes.length) return null;
  const word = offset >>> 2;
  const descriptorAddress = words[word];
  const sourceAddress = words[word + 1];
  const length = words[word + 2];
  const saveAddress = words[word + 3];
  const loadCallback = words[word + 4];
  const saveCallback = words[word + 5];
  const logicalStart = saveAddress - GBA_SAVE_MEMORY_START_ADDRESS;
  if (romPointer(descriptorAddress, bytes.length) === null
      || !ramProviderRange(sourceAddress, length, allowVolatileProvider)
      || logicalStart < 0
      || logicalStart + length > SRAM_SIZE
      || romPointer(loadCallback, bytes.length, !allowUnprovenCallbacks) === null
      || romPointer(saveCallback, bytes.length, !allowUnprovenCallbacks) === null
      || loadCallback === saveCallback) return null;
  return {
    logicalStart,
    length,
    sourceAddress,
    loadCallback,
    saveCallback,
  };
}

function tableCandidates(bytes, options = {}) {
  const candidates = [];
  const aligned = bytes.byteOffset % 4 === 0 ? bytes : bytes.slice();
  const words = new Uint32Array(
    aligned.buffer,
    aligned.byteOffset,
    Math.floor(aligned.byteLength / 4),
  );
  for (let offset = 0; offset + RECORD_SIZE * 4 <= bytes.length; offset += 4) {
    // The fourth word is a Save-aperture address. This cheap discriminator
    // avoids running the full six-field validator for ordinary ROM words.
    const saveAddress = words[(offset >>> 2) + 3];
    if (saveAddress < GBA_SAVE_MEMORY_START_ADDRESS || saveAddress >= GBA_SAVE_MEMORY_START_ADDRESS + SRAM_SIZE) continue;
    if (offset >= RECORD_SIZE && parseRecord(bytes, words, offset - RECORD_SIZE, options)) continue;
    const records = [];
    for (let cursor = offset; records.length < MAX_PROVIDERS; cursor += RECORD_SIZE) {
      const record = parseRecord(bytes, words, cursor, options);
      if (!record) break;
      records.push(record);
    }
    if (records.length < 4) continue;
    // A transaction table may use a distinct ABI-compatible callback pair for
    // a terminal metadata record.  The pairing is part of each record; table
    // identity must therefore not depend on one particular callback address.
    candidates.push({ offset, records });
    offset += records.length * RECORD_SIZE - 4;
  }
  return candidates;
}

function rangesDoNotConflict(records) {
  const sorted = [...records].sort((left, right) => left.logicalStart - right.logicalStart);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].logicalStart < sorted[index - 1].logicalStart + sorted[index - 1].length) {
      return false;
    }
  }
  return true;
}

function functionRangeAt(bytes, offset, radius = 0x800) {
  let start = null;
  for (let cursor = offset & ~1; cursor >= Math.max(0, offset - radius); cursor -= 2) {
    const halfword = readU16(bytes, cursor);
    if ((halfword & 0xff00) === 0xb500) {
      start = cursor;
      break;
    }
  }
  if (start === null) return null;
  for (let cursor = Math.max(offset, start + 2); cursor + 2 <= bytes.length
       && cursor < start + radius; cursor += 2) {
    const halfword = readU16(bytes, cursor);
    if (halfword === 0x4770
        || ((halfword & 0xff87) === 0x4700
          && cursor >= 2 && (readU16(bytes, cursor - 2) & 0xff00) === 0xbc00)) {
      return { start, end: cursor + 2 };
    }
  }
  return null;
}

function literalLoadReferences(bytes, value) {
  const references = [];
  for (let offset = 0; offset + 2 <= bytes.length; offset += 2) {
    const halfword = readU16(bytes, offset);
    if ((halfword & 0xf800) !== 0x4800) continue;
    const literal = ((offset + 4) & ~3) + ((halfword & 0xff) << 2);
    if (literal + 4 <= bytes.length && readU32(bytes, literal) === value) {
      references.push({ offset, literal, register: (halfword >> 8) & 7 });
    }
  }
  return references;
}

function directCalls(bytes, range) {
  const targets = [];
  for (let offset = range.start; offset + 4 <= range.end; offset += 2) {
    const target = decodeThumbBlTarget(bytes, offset);
    if (target !== null) {
      targets.push(target);
      offset += 2;
    }
  }
  return targets;
}

function callbackReachesAnyHook(bytes, callbackAddress, hookOffsets) {
  const first = romPointer(callbackAddress, bytes.length, true);
  if (first === null || hookOffsets.size === 0) return false;
  const pending = [{ offset: first, depth: 0 }];
  const visited = new Set();
  while (pending.length > 0) {
    const { offset, depth } = pending.pop();
    if (hookOffsets.has(offset)) return true;
    if (visited.has(offset) || depth >= 4) continue;
    visited.add(offset);
    const range = functionRangeAt(bytes, offset, 0x400);
    if (!range || range.start !== offset) continue;
    for (const target of directCalls(bytes, range)) {
      if (hookOffsets.has(target)) return true;
      pending.push({ offset: target, depth: depth + 1 });
    }
  }
  return false;
}

function immediateConstantsInRange(bytes, range) {
  const constants = new Set();
  for (let offset = range.start; offset + 4 <= range.end; offset += 2) {
      const move = readU16(bytes, offset);
      const shift = readU16(bytes, offset + 2);
      if ((move & 0xf800) !== 0x2000 || (shift & 0xf800) !== 0x0000) continue;
      const register = (move >> 8) & 7;
      if ((shift & 7) !== register || ((shift >> 3) & 7) !== register) continue;
      constants.add(((move & 0xff) << ((shift >> 6) & 0x1f)) >>> 0);
  }
  return constants;
}

function transactionProofs(bytes, table, callbackField, requireCompleteLoop) {
  const tableAddress = (GBA_ROM_BASE_ADDRESS + table.offset) >>> 0;
  const functions = new Map();
  for (const reference of literalLoadReferences(bytes, tableAddress)) {
    const range = functionRangeAt(bytes, reference.offset);
    if (range) functions.set(range.start, range);
  }
  const proofs = [];
  for (const range of functions.values()) {
    for (let base = 0; base < 8; base += 1) {
      const fields = new Map();
      for (let offset = range.start; offset + 2 <= range.end; offset += 2) {
        const halfword = readU16(bytes, offset);
        if ((halfword & 0xf800) !== 0x6800 || ((halfword >> 3) & 7) !== base) continue;
        const field = ((halfword >> 6) & 0x1f) << 2;
        if ([4, 8, 12, 16, 20].includes(field)) {
          fields.set(field, { offset, register: halfword & 7 });
        }
      }
      if (![4, 8, 12, callbackField].every((field) => fields.has(field))) continue;
      if (requireCompleteLoop && fields.has(16)) continue;
      const firstField = Math.min(...[4, 8, 12, callbackField].map((field) => fields.get(field).offset));
      const callback = fields.get(callbackField);
      const dispatches = directCalls(bytes, {
        start: callback.offset + 2,
        end: range.end,
      }).filter((dispatch) => (
        dispatch + 2 <= bytes.length
        && readU16(bytes, dispatch) === (0x4700 | (callback.register << 3))
      ));
      if (!requireCompleteLoop) {
        if (dispatches.length > 0) {
          proofs.push({ range, base, callbackField, dispatch: dispatches[0] });
        }
        continue;
      }
      for (let branch = callback.offset + 2; branch + 2 <= range.end; branch += 2) {
        const target = decodeThumbBranchTarget(bytes, branch);
        if (target === null || target > firstField || branch <= firstField) continue;
        const condition = readU16(bytes, branch);
        if ((condition & 0xf000) !== 0xd000) continue;
        let countRegister = null;
        for (let cursor = Math.max(firstField, branch - 12); cursor < branch; cursor += 2) {
          const compare = readU16(bytes, cursor);
          if ((compare & 0xf800) === 0x2800
              && (compare & 0xff) + 1 === table.records.length) {
            countRegister = (compare >> 8) & 7;
          }
        }
        if (countRegister === null) continue;
        const stride = Array.from(
          { length: Math.floor((branch - target) / 2) + 1 },
          (_, index) => readU16(bytes, target + index * 2),
        ).some((halfword) => (
          (halfword & 0xf800) === 0x3000
          && ((halfword >> 8) & 7) === base
          && (halfword & 0xff) === RECORD_SIZE
        ));
        if (!stride) continue;
        const callbackDispatch = directCalls(bytes, {
          start: callback.offset + 2,
          end: branch,
        }).some((dispatch) => (
          dispatch + 2 <= bytes.length
          && readU16(bytes, dispatch) === (0x4700 | (callback.register << 3))
        ));
        if (!callbackDispatch) continue;
        let earlyReturn = false;
        for (let cursor = target; cursor < branch; cursor += 2) {
          const halfword = readU16(bytes, cursor);
          if (halfword === 0x4770 || (halfword & 0xff00) === 0xbd00) earlyReturn = true;
        }
        if (earlyReturn) continue;
        proofs.push({ range, base, callbackField, loopFirst: target, loopEnd: branch + 2 });
      }
    }
  }
  return proofs;
}

function deriveBankBias(bytes, table, saveProof) {
  const minimum = Math.min(...table.records.map((record) => record.logicalStart));
  const maximum = Math.max(...table.records.map((record) => (
    record.logicalStart + record.length
  )));
  const candidates = [...immediateConstantsInRange(bytes, saveProof.range)].filter((bias) => (
    bias > 0
    && minimum + bias < SRAM_SIZE
    && maximum + bias <= SRAM_SIZE
    && (minimum + bias) % 0x4000 === 0
  ));
  return candidates.length === 1 ? { bias: candidates[0] } : null;
}

function rangeContainsEwramDelta(bytes, range, delta) {
  const values = new Set();
  for (let offset = range.start; offset + 2 <= range.end; offset += 2) {
    const halfword = readU16(bytes, offset);
    if ((halfword & 0xf800) !== 0x4800) continue;
    const literal = ((offset + 4) & ~3) + ((halfword & 0xff) << 2);
    if (literal + 4 > bytes.length) continue;
    const value = readU32(bytes, literal);
    if (value >= GBA_EWRAM_START_ADDRESS && value < GBA_EWRAM_END_ADDRESS) values.add(value);
  }
  return [...values].some((left) => (
    values.has((left + delta) >>> 0) || values.has((left - delta) >>> 0)
  ));
}

function alignDown(value, alignment) {
  return value - (value % alignment);
}

function thumbLiteral(bytes, offset, register) {
  if (offset < 0 || offset + 2 > bytes.length) return null;
  const instruction = readU16(bytes, offset);
  if ((instruction & 0xf800) !== 0x4800
      || ((instruction >> 8) & 7) !== register) return null;
  const literal = ((offset + 4) & ~3) + ((instruction & 0xff) << 2);
  return literal + 4 <= bytes.length
    ? { literal, value: readU32(bytes, literal) }
    : null;
}

/*
 * A private tail cannot be inferred from "currently unused" addresses.  The
 * only supported reservation proof is an allocator initialization whose end
 * literal can be reduced atomically before the allocator sees the arena.
 * The callee shape proves the r0/r1/r2 state/base/size ABI; it is deliberately
 * independent of ROM headers and identifiers.
 */
function allocatorInitializer(bytes, target) {
  const range = functionRangeAt(bytes, target, 0x100);
  if (!range || range.start !== target) return false;
  const instructions = [];
  for (let offset = range.start; offset + 2 <= Math.min(range.end, range.start + 0x30); offset += 2) {
    instructions.push(readU16(bytes, offset));
  }
  const moveState = instructions.indexOf(0x1c04); // mov/add r4, r0
  if (moveState < 0) return false;
  const after = instructions.slice(moveState + 1);
  return after.includes(0x6022) // str r2, [r4, #0] (arena size)
    && after.includes(0x60a1) // str r1, [r4, #8] (arena base)
    && after.includes(0x6062); // str r2, [r4, #4] (remaining)
}

function heapReservationCandidates(bytes) {
  const candidates = [];
  for (let offset = 0; offset + 12 <= bytes.length; offset += 2) {
    const state = thumbLiteral(bytes, offset, 0);
    const start = thumbLiteral(bytes, offset + 2, 1);
    const end = thumbLiteral(bytes, offset + 4, 2);
    if (!state || !start || !end || readU16(bytes, offset + 6) !== 0x1a52) continue;
    const target = decodeThumbBlTarget(bytes, offset + 8);
    if (target === null || !allocatorInitializer(bytes, target)) continue;
    if (!ewramRange(start.value, end.value - start.value)
        || end.value !== GBA_EWRAM_END_ADDRESS
        || state.value >= start.value
        || end.value - start.value <= PRIVATE_WORKSPACE_SIZE) continue;
    const readerBase = alignDown(
      GBA_EWRAM_END_ADDRESS - PERSISTENT_READER_RESERVED_SIZE, 16,
    );
    const workspaceBase = alignDown(
      readerBase - MIRROR_METADATA_SIZE - SRAM_SIZE, 16,
    );
    if (workspaceBase <= start.value) continue;
    candidates.push(Object.freeze({
      callOffset: offset,
      functionRange: functionRangeAt(bytes, offset),
      heapEndLiteral: end.literal,
      heapStart: start.value,
      workspaceBase,
      readerBase,
    }));
  }
  return candidates;
}

function executableThumbEwramReferences(bytes, first, end) {
  const references = [];
  for (let offset = 0; offset + 2 <= bytes.length; offset += 2) {
    const instruction = readU16(bytes, offset);
    if ((instruction & 0xf800) !== 0x4800) continue;
    const literal = ((offset + 4) & ~3) + ((instruction & 0xff) << 2);
    if (literal + 4 > bytes.length) continue;
    const value = readU32(bytes, literal);
    if (value < first || value > end) continue;
    const range = functionRangeAt(bytes, offset);
    if (range && offset >= range.start && offset < range.end) {
      references.push(Object.freeze({ offset, literal, value, range }));
    }
  }
  return references;
}

/*
 * Some startup, DMA and IRQ setup code is ARM rather than Thumb.  A
 * PC-relative ARM load is sufficiently self-describing that it can be
 * inventoried without guessing function boundaries: the instruction names
 * both its literal word and the value loaded from it.  Reject every proven
 * reference into the reserved tail.  This complements the Thumb inventory
 * above and deliberately does not scan arbitrary aligned ROM words, which
 * would misclassify compressed/game data as pointers.
 */
function executableArmEwramReferences(bytes, first, end) {
  const references = [];
  for (let offset = 0; offset + 4 <= bytes.length; offset += 4) {
    const instruction = readU32(bytes, offset);
    // cond .... 01 I=0 P=1 ... L=1, Rn=pc; U/B/W are intentionally free.
    if ((instruction & 0x0f1f0000) !== 0x051f0000) continue;
    const displacement = instruction & 0xfff;
    const literal = (offset + 8)
      + ((instruction & 0x00800000) !== 0 ? displacement : -displacement);
    if (literal < 0 || literal + 4 > bytes.length || (literal & 3) !== 0) continue;
    const value = readU32(bytes, literal);
    if (value < first || value > end) continue;
    references.push(Object.freeze({ offset, literal, value, range: null }));
  }
  return references;
}

function isResetClearEndReference(bytes, reference, reservation) {
  if (reference.value !== GBA_EWRAM_END_ADDRESS - 1
      || !reservation.functionRange
      || reference.range.start !== reservation.functionRange.start) return false;
  // Full-EWRAM reset clearing is complete before the allocator is initialized;
  // it initializes mirror metadata rather than competing with it at runtime.
  for (let offset = reference.range.start; offset + 2 <= reference.range.end; offset += 2) {
    if (readU16(bytes, offset) === 0xc101) return true;
  }
  return false;
}

function isHeapEndReference(reference, reservation) {
  return reference.value === GBA_EWRAM_END_ADDRESS
    && reference.literal === reservation.heapEndLiteral
    && reservation.functionRange
    && reference.range?.start === reservation.functionRange.start;
}

function privateWorkspaceProof(bytes, table, hooks) {
  const reservations = heapReservationCandidates(bytes);
  if (reservations.length !== 1) return null;
  const reservation = reservations[0];
  const reservedFirst = reservation.workspaceBase;
  const reservedEnd = GBA_EWRAM_END_ADDRESS;
  const ownedRanges = table.records.map((record) => ({
    first: record.sourceAddress,
    end: record.sourceAddress + record.length,
  }));
  if (Number.isInteger(hooks.sramCacheAddress)) {
    ownedRanges.push({ first: hooks.sramCacheAddress, end: hooks.sramCacheAddress + 64 });
  }
  if (ownedRanges.some((range) => range.first < reservedEnd && reservedFirst < range.end)) {
    return null;
  }
  const unsafeReferences = [
    ...executableThumbEwramReferences(bytes, reservedFirst, reservedEnd),
    ...executableArmEwramReferences(bytes, reservedFirst, reservedEnd),
  ].filter((reference) => (
    !isHeapEndReference(reference, reservation)
    && !isResetClearEndReference(bytes, reference, reservation)
  ));
  if (unsafeReferences.length !== 0) return null;
  return reservation;
}

function mirroredBatchShapes(bytes, hooks) {
  if (hooks.family !== "sram") return [];
  const readHooks = new Set(hooks.sramRead || []);
  const writeHooks = new Set((hooks.sramWrite || [])
    .flatMap((hook) => hook.offsets || []));
  const verifyHooks = new Set(hooks.sramVerify || []);
  if (readHooks.size !== 1 || writeHooks.size !== 1 || verifyHooks.size !== 1) return [];
  const tables = tableCandidates(bytes).filter((table) => rangesDoNotConflict(table.records));
  const proven = [];
  for (const table of tables) {
    if (!table.records.every((record) => (
      callbackReachesAnyHook(bytes, record.loadCallback, readHooks)
      && callbackReachesAnyHook(bytes, record.saveCallback, writeHooks)
    ))) continue;
    const loadProofs = transactionProofs(bytes, table, 16, false);
    const saveProofs = transactionProofs(bytes, table, 20, true);
    if (loadProofs.length === 0 || saveProofs.length !== 1) continue;
    const bank = deriveBankBias(bytes, table, saveProofs[0]);
    if (!bank) continue;
    const bothBanks = table.records.flatMap((record) => [
      { first: record.logicalStart, length: record.length },
      { first: record.logicalStart + bank.bias, length: record.length },
    ]).sort((left, right) => left.first - right.first);
    if (bothBanks.some((range) => range.first < 0
        || range.length <= 0 || range.first + range.length > SRAM_SIZE)) continue;
    const last = table.records.at(-1);
    const commitFirst = last.logicalStart + bank.bias;
    if (commitFirst < SNAPSHOT_HEADER_SIZE
        || commitFirst + last.length > SRAM_SIZE) continue;
    proven.push({
      table,
      commitFirst,
      commitSize: last.length,
    });
  }
  return proven;
}

function hasUnprovenMirroredBatchIntent(bytes, hooks) {
  if (hooks.family !== "sram") return false;
  /*
   * A referenced record loop which loads source, length, Save address and a
   * Save callback is already a batch transaction intent.  The looser record
   * inventory accepts IWRAM providers only so that an otherwise convincing
   * but volatile layout is rejected explicitly; it can never produce a
   * successful capability.
   */
  return tableCandidates(bytes, {
    allowVolatileProvider: true,
    allowUnprovenCallbacks: true,
  }).some((table) => (
    transactionProofs(bytes, table, 20, false).length > 0
  ));
}

function workspaceUnproven(message) {
  throw new PatchError(message, {
    code: PATCH_REASON_CODE.DIRECT_SRAM_PRIVATE_WORKSPACE_UNPROVEN,
    isRecoverable: true,
  });
}

/**
 * Prove the mirrored batch capability.  A successful public result contains
 * exactly the four runtime configuration values; diagnostic provider/stride
 * material never participates in backend selection.
 */
export function analyzeMirroredBatchSnapshot(bytes, hooks) {
  const shapes = mirroredBatchShapes(bytes, hooks);
  if (shapes.length === 0) {
    if (hasUnprovenMirroredBatchIntent(bytes, hooks)) {
      return workspaceUnproven(
        "Direct SRAM found a batched save transaction without a complete private-mirror proof.",
      );
    }
    return null;
  }
  if (shapes.length !== 1) {
    return workspaceUnproven("Direct SRAM found an ambiguous batched save transaction.");
  }
  const shape = shapes[0];
  const workspace = privateWorkspaceProof(bytes, shape.table, hooks);
  if (!workspace) {
    return workspaceUnproven(
      "Direct SRAM could not prove and reserve a private EWRAM mirror workspace.",
    );
  }
  return Object.freeze({
    workspaceBase: workspace.workspaceBase,
    readerBase: workspace.readerBase,
    commitFirst: shape.commitFirst,
    commitSize: shape.commitSize,
  });
}

/** Reserve the analyzer-proven tail by shrinking the one proven heap arena. */
export function stageMirroredBatchWorkspaceReservation(bytes, operations, plan) {
  const candidates = heapReservationCandidates(bytes).filter((candidate) => (
    candidate.workspaceBase === plan.workspaceBase
    && candidate.readerBase === plan.readerBase
  ));
  if (candidates.length !== 1) {
    return workspaceUnproven("Direct SRAM private workspace reservation changed during planning.");
  }
  const reservation = candidates[0];
  const replacement = new Uint8Array(4);
  writeU32(replacement, 0, plan.workspaceBase);
  stagePatchOperation(bytes, operations, {
    id: `save-runtime-${operations.length}`,
    kind: PATCH_OPERATION_KIND.LITERAL_REPLACE,
    component: "saveRuntime",
    offset: reservation.heapEndLiteral,
    byteLength: replacement.length,
    expectedBefore: bytes.slice(reservation.heapEndLiteral, reservation.heapEndLiteral + 4),
    replacement,
    labelKey: "operation.saveRuntime",
    metadata: {
      name: "Direct SRAM private mirror heap reservation",
      value: plan.workspaceBase,
      codeName: "direct_sram_private_workspace_reservation",
    },
  });
}
