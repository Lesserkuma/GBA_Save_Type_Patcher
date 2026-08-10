// SPDX-License-Identifier: GPL-3.0-or-later AND MIT

import { readU16, readU32 } from "../core/binary.js";
import { decodeThumbBlTarget, decodeThumbBranchTarget } from "../core/thumb.js";
import {
  GBA_EWRAM_END_ADDRESS,
  GBA_EWRAM_START_ADDRESS,
  GBA_ROM_BASE_ADDRESS,
  GBA_SAVE_MEMORY_START_ADDRESS,
} from "../domain/gba-constants.js";

const SRAM_SIZE = 0x8000;
const RECORD_SIZE = 24;
const MAX_PROVIDERS = 128;
const MAX_TRANSIENT_RANGES = 8;
const SNAPSHOT_HEADER_SIZE = 16;

function romPointer(value, length, thumb = false) {
  if (thumb && (value & 1) === 0) return null;
  const offset = (value & ~1) - GBA_ROM_BASE_ADDRESS;
  return offset >= 0 && offset < length ? offset : null;
}

function ewramRange(address, length) {
  return address >= GBA_EWRAM_START_ADDRESS && length > 0 && address + length <= GBA_EWRAM_END_ADDRESS;
}

function parseRecord(bytes, words, offset) {
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
      || !ewramRange(sourceAddress, length)
      || logicalStart < 0
      || logicalStart + length > SRAM_SIZE
      || romPointer(loadCallback, bytes.length, true) === null
      || romPointer(saveCallback, bytes.length, true) === null
      || loadCallback === saveCallback) return null;
  return {
    logicalStart,
    length,
    sourceAddress,
    loadCallback,
    saveCallback,
  };
}

function tableCandidates(bytes) {
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
    if (offset >= RECORD_SIZE && parseRecord(bytes, words, offset - RECORD_SIZE)) continue;
    const records = [];
    for (let cursor = offset; records.length < MAX_PROVIDERS; cursor += RECORD_SIZE) {
      const record = parseRecord(bytes, words, cursor);
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

function buildProviders(records, bias) {
  const sourceFirst = Math.min(...records.map((record) => record.sourceAddress));
  const sourceEnd = Math.max(...records.map((record) => (
    record.sourceAddress + record.length
  )));
  const sourceStride = sourceEnd - sourceFirst;
  if (sourceStride <= 0) return null;
  /*
   * The transaction owns two persistent banks.  The table describes the
   * first bank; the derived logical bank bias and the immediately following
   * equally shaped EWRAM provider set describe the second.  Materialize both
   * sets explicitly so the runtime never has to infer a game-specific source
   * displacement from one observed call.
   */
  const providers = records.flatMap((record) => ([
    {
      logicalStart: record.logicalStart,
      length: record.length,
      sourceAddress: record.sourceAddress,
    },
    {
      logicalStart: record.logicalStart + bias,
      length: record.length,
      sourceAddress: record.sourceAddress + sourceStride,
    },
  ])).sort((left, right) => left.logicalStart - right.logicalStart);
  if (providers.length > MAX_PROVIDERS
      || providers.some((provider) => !ewramRange(
        provider.sourceAddress, provider.length,
      ))) return null;
  let covered = 0;
  let gaps = 0;
  let cursor = providers[0]?.logicalStart ?? 0;
  for (const provider of providers) {
    if (provider.logicalStart < cursor) return null;
    gaps += provider.logicalStart - cursor;
    covered += provider.length;
    cursor = provider.logicalStart + provider.length;
  }
  // Opt in only when the transaction reconstructs nearly a complete 16-KiB
  // bank.  This is a capability bound, not a known record count or layout.
  if (covered < 0x3000 || gaps > 0x400) return null;
  return { providers, sourceStride, sourceEnd };
}

function deriveTransientRanges(records, sourceStride, sourceEnd) {
  const firstPersistent = Math.min(...records.map((record) => record.logicalStart));
  // RAW snapshots share their 32-KiB slot with the physical v3 header.  The
  // first header-sized logical span must therefore be semantically proven
  // transient and logically zero; compression ratio must never decide data
  // safety at runtime.
  if (firstPersistent < SNAPSHOT_HEADER_SIZE) return null;
  // The leading aperture prefix is outside the ordered persistent record
  // transaction.  Calls wholly contained in it are SDK/game probe traffic:
  // they may be verified immediately, but must never become snapshot input.
  // The bound is derived from the table, not from a known game layout.
  if (firstPersistent > 0x1000) return null;
  const sourceAddress = sourceEnd + sourceStride;
  if (!ewramRange(sourceAddress, firstPersistent)) return null;
  return [{ logicalStart: 0, length: firstPersistent, sourceAddress }];
}

export function analyzeBatchedSramSnapshot(bytes, hooks) {
  if (hooks.family !== "sram") return null;
  const readHooks = new Set(hooks.sramRead || []);
  const writeHooks = new Set((hooks.sramWrite || [])
    .flatMap((hook) => hook.offsets || []));
  if (readHooks.size === 0 || writeHooks.size === 0) return null;
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
    const providerPlan = buildProviders(table.records, bank.bias);
    if (!providerPlan) continue;
    if (!rangeContainsEwramDelta(
      bytes, saveProofs[0].range, providerPlan.sourceStride,
    ) && !loadProofs.some((proof) => rangeContainsEwramDelta(
      bytes, proof.range, providerPlan.sourceStride,
    ))) continue;
    const transientRanges = deriveTransientRanges(
      table.records, providerPlan.sourceStride, providerPlan.sourceEnd,
    );
    if (!transientRanges || transientRanges.length > MAX_TRANSIENT_RANGES) continue;
    const last = table.records.at(-1);
    const commitFirst = last.logicalStart + bank.bias;
    if (commitFirst + last.length > SRAM_SIZE) continue;
    proven.push({
      table, bank, providers: providerPlan.providers, transientRanges,
      loadProof: loadProofs[0], saveProof: saveProofs[0],
      commitFirst, commitSize: last.length,
    });
  }
  if (proven.length !== 1) return null;
  const result = proven[0];
  return Object.freeze({
    commitFirst: result.commitFirst,
    commitSize: result.commitSize,
    providers: Object.freeze(result.providers.map((provider) => Object.freeze(provider))),
    transientRanges: Object.freeze(result.transientRanges.map((range) => Object.freeze(range))),
  });
}
