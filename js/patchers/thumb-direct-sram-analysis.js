// SPDX-License-Identifier: GPL-3.0-or-later AND MIT

import { readU16, readU32 } from "../core/binary.js";
import { decodeThumbBlTarget, decodeThumbBranchTarget } from "../core/thumb.js";
import { PatchError } from "../core/errors.js";
import {
  GBA_ROM_BASE_ADDRESS,
  GBA_SAVE_MEMORY_END_ADDRESS,
  GBA_SAVE_MEMORY_START_ADDRESS,
} from "../domain/gba-constants.js";


function directCallers(bytes, targets) {
  const wanted = new Set(targets);
  const callers = [];
  for (let offset = 0; offset + 4 <= bytes.length; offset += 2) {
    const target = decodeThumbBlTarget(bytes, offset);
    if (wanted.has(target)) callers.push({ offset, target });
  }
  return callers;
}

function thumbFunctionStart(bytes, instructionOffset) {
  for (let offset = instructionOffset; offset >= Math.max(0, instructionOffset - 0x100);
    offset -= 2) {
    const halfword = readU16(bytes, offset);
    if ((halfword & 0xff00) === 0xb500) return offset;
    if (offset !== instructionOffset && (
      (halfword & 0xff00) === 0x4700
      || ((halfword & 0xff00) === 0xbd00)
    )) return null;
  }
  return null;
}

function symbolicMove(halfword, registers) {
  // Thumb ADD Rd, Rn, #0 is the common low-register MOV spelling emitted by
  // Nintendo-era compilers.
  if ((halfword & 0xfe00) === 0x1c00 && (halfword & 0x01c0) === 0) {
    registers[halfword & 7] = registers[(halfword >> 3) & 7];
    return true;
  }
  if ((halfword & 0xfc00) === 0x4400
      && ((halfword >> 8) & 3) === 2) {
    const source = (halfword >> 3) & 0x0f;
    const destination = (halfword & 7) | ((halfword >> 4) & 8);
    if (source >= registers.length || destination >= registers.length) return false;
    registers[destination] = registers[source];
    return true;
  }
  return false;
}

function returnsWriteVerifyStatus(bytes, verifyCall) {
  const compare = verifyCall + 4;
  const conditional = compare + 2;
  if (compare + 14 > bytes.length
      || readU16(bytes, compare) !== 0x2800
      || (readU16(bytes, conditional) & 0xff00) !== 0xd000) return false;
  const condition = (readU16(bytes, conditional) >> 8) & 0x0f;
  const success = decodeThumbBranchTarget(bytes, conditional);
  if (condition !== 0 || success === null
      || readU16(bytes, compare + 4) !== 0x2001
      || readU16(bytes, compare + 6) !== 0x4240
      || (readU16(bytes, compare + 8) & 0xf800) !== 0xe000
      || success + 2 > bytes.length
      || readU16(bytes, success) !== 0x2000) return false;
  const join = decodeThumbBranchTarget(bytes, compare + 8);
  if (join !== success + 2) return false;
  for (let offset = join, count = 0;
    offset + 2 <= bytes.length && count < 12;
    offset += 2, count += 1) {
    const halfword = readU16(bytes, offset);
    if ((halfword & 0xff87) === 0x4700
        || (halfword & 0xff00) === 0xbd00) return true;
    if ((halfword & 0xfe00) === 0xbc00
        || (halfword & 0xf800) === 0xb000
        || symbolicMove(halfword, Array(16).fill(null))) continue;
    return false;
  }
  return false;
}

/**
 * Find compiler wrappers that are semantically one synchronous SRAM
 * transaction: destination/source/size are preserved, WriteSram is called,
 * the exact same triple is passed immediately to VerifySram, and the observed
 * verify pointer is reduced to the conventional zero/-1 status.  The proof is
 * based only on Thumb control/data flow and detected SDK hook addresses.
 */
export function analyzeSramWriteVerifyWrappers(bytes, writeTargets, verifyTargets) {
  const writes = new Set(writeTargets);
  const verifies = new Set(verifyTargets);
  if (writes.size === 0 || verifies.size === 0) return [];
  const wrappers = [];
  for (const caller of directCallers(bytes, writes)) {
    const start = thumbFunctionStart(bytes, caller.offset);
    if (start === null || start + 8 > caller.offset) continue;
    const registers = Array(16).fill(null);
    registers[0] = "destination";
    registers[1] = "source";
    registers[2] = "size";
    let valid = true;
    for (let offset = start; offset < caller.offset; offset += 2) {
      const halfword = readU16(bytes, offset);
      if ((offset === start && (halfword & 0xff00) === 0xb500)
          || (halfword & 0xfe00) === 0xb400
          || (halfword & 0xff80) === 0xb080
          || symbolicMove(halfword, registers)) continue;
      valid = false;
      break;
    }
    if (!valid || registers[0] !== "source"
        || registers[1] !== "destination" || registers[2] !== "size") continue;
    registers[0] = null;
    let verifyCall = null;
    for (let offset = caller.offset + 4, count = 0;
      offset + 2 <= bytes.length && count < 8;
      offset += 2, count += 1) {
      const target = decodeThumbBlTarget(bytes, offset);
      if (target !== null) {
        if (verifies.has(target)) verifyCall = offset;
        break;
      }
      if (!symbolicMove(readU16(bytes, offset), registers)) {
        valid = false;
        break;
      }
    }
    if (!valid || verifyCall === null
        || registers[0] !== "source"
        || registers[1] !== "destination"
        || registers[2] !== "size"
        || !returnsWriteVerifyStatus(bytes, verifyCall)) continue;
    wrappers.push(Object.freeze({
      offset: start,
      writeCall: caller.offset,
      verifyCall,
    }));
  }
  return [...new Map(wrappers.map((wrapper) => [wrapper.offset, wrapper])).values()]
    .sort((left, right) => left.offset - right.offset);
}

function literalLoadValue(bytes, offset, halfword) {
  if ((halfword & 0xf800) !== 0x4800) return null;
  const literal = ((offset + 4) & ~3) + ((halfword & 0xff) << 2);
  return literal + 4 <= bytes.length ? readU32(bytes, literal) : null;
}

/**
 * Inventory semantically executable Thumb literal loads that are subsequently
 * used as a Save-aperture memory base.  Requiring a real function prologue and
 * a supported straight-line data-flow prevents embedded signature bytes from
 * becoming strategy evidence.  Unknown/branched flows are deliberately not
 * classified as safe here; mapper-based accesses are handled separately.
 */
export function inventoryLiteralSaveAccesses(bytes) {
  const accesses = [];
  for (let literalOffset = 0; literalOffset + 2 <= bytes.length; literalOffset += 2) {
    const literalInstruction = readU16(bytes, literalOffset);
    const value = literalLoadValue(bytes, literalOffset, literalInstruction);
    if (value === null || value < GBA_SAVE_MEMORY_START_ADDRESS || value >= GBA_SAVE_MEMORY_END_ADDRESS) continue;
    const functionStart = thumbFunctionStart(bytes, literalOffset);
    if (functionStart === null) continue;
    const registers = Array(8).fill(null);
    for (let offset = functionStart, count = 0;
      offset + 2 <= bytes.length && count < 96;
      offset += 2, count += 1) {
      const halfword = readU16(bytes, offset);
      const loaded = literalLoadValue(bytes, offset, halfword);
      if (loaded !== null) {
        registers[(halfword >> 8) & 7] = loaded >>> 0;
        continue;
      }
      if ((halfword & 0xf000) === 0x6000
          || (halfword & 0xf000) === 0x7000
          || (halfword & 0xf000) === 0x8000) {
        const base = (halfword >> 3) & 7;
        const byteScale = (halfword & 0xf000) === 0x8000 ? 2 : 1;
        const address = registers[base] === null ? null
          : (registers[base] + ((halfword >> 6) & 0x1f) * byteScale) >>> 0;
        if (address !== null && address >= GBA_SAVE_MEMORY_START_ADDRESS && address < GBA_SAVE_MEMORY_END_ADDRESS) {
          accesses.push(Object.freeze({
            functionStart,
            literalOffset,
            accessOffset: offset,
            address,
            kind: (halfword & 0x0800) !== 0 ? "read" : "write",
          }));
        }
        if ((halfword & 0x0800) !== 0) registers[halfword & 7] = null;
        continue;
      }
      if (offset !== functionStart && (
        (halfword & 0xff00) === 0x4700
        || (halfword & 0xff00) === 0xbd00
        || (halfword & 0xf800) === 0xe000
        || (halfword & 0xf000) === 0xd000
        || (halfword & 0xf800) === 0xf000
      )) break;
      if (!executeAlu(halfword, registers)) {
        if ((halfword & 0xff00) === 0xb500 || (halfword & 0xfe00) === 0xb400) continue;
        if ((halfword & 0xfe00) === 0xbc00) {
          for (let register = 0; register < 8; register += 1) {
            if (halfword & (1 << register)) registers[register] = null;
          }
          continue;
        }
        // Unsupported instructions invalidate only their explicit destination
        // where one can be identified; otherwise stop before inventing flow.
        break;
      }
    }
  }
  return [...new Map(accesses.map((access) => [
    `${access.functionStart}:${access.accessOffset}`,
    access,
  ])).values()].sort((left, right) => left.accessOffset - right.accessOffset);
}

function r0Access(halfword) {
  if ((halfword & 0xf800) === 0x2000) {
    return ((halfword >> 8) & 7) === 0 ? "write" : "none";
  }
  if ((halfword & 0xe000) === 0x0000) {
    const source = (halfword >> 3) & 7;
    const destination = halfword & 7;
    if (source === 0) return "read";
    return destination === 0 ? "write" : "none";
  }
  if ((halfword & 0xfc00) === 0x4000) {
    const source = (halfword >> 3) & 7;
    const destination = halfword & 7;
    return source === 0 || destination === 0 ? "read" : "none";
  }
  if ((halfword & 0xfc00) === 0x4400) {
    const source = (halfword >> 3) & 0x0f;
    const destination = (halfword & 7) | ((halfword >> 4) & 8);
    const operation = (halfword >> 8) & 3;
    if (operation === 2 && destination === 0 && source !== 0) return "write";
    return source === 0 || destination === 0 ? "read" : "none";
  }
  if ((halfword & 0xf800) === 0x2800) return "read";
  if ((halfword & 0xf000) === 0x6000
      || (halfword & 0xf000) === 0x7000
      || (halfword & 0xf000) === 0x8000) {
    const register = halfword & 7;
    const base = (halfword >> 3) & 7;
    const load = (halfword & 0x0800) !== 0;
    if (base === 0 || (!load && register === 0)) return "read";
    return load && register === 0 ? "write" : "none";
  }
  if ((halfword & 0xfe00) === 0xb400) {
    return (halfword & 1) !== 0 ? "read" : "none";
  }
  if ((halfword & 0xfe00) === 0xbc00) {
    return (halfword & 1) !== 0 ? "write" : "none";
  }
  return "none";
}

function callResultIsProvablyDead(bytes, callOffset) {
  for (let offset = callOffset + 4, count = 0;
    offset + 2 <= bytes.length && count < 16;
    offset += 2, count += 1) {
    const halfword = readU16(bytes, offset);
    const access = r0Access(halfword);
    if (access === "read") return false;
    if (access === "write") return true;
    if ((halfword & 0xf000) === 0xd000
        || (halfword & 0xf800) === 0xe000
        || (halfword & 0xf800) === 0xf000
        || (halfword & 0xff00) === 0x4700) return false;
  }
  return false;
}

export function verifyResultNeedsReadback(bytes, targets, abiRequiresReadback = false) {
  if (abiRequiresReadback) return true;
  const callers = directCallers(bytes, targets);
  if (callers.length === 0) return true;
  if (callers.some(({ offset }) => !callResultIsProvablyDead(bytes, offset))) return true;

  const addresses = new Set(targets.flatMap((target) => [
    (GBA_ROM_BASE_ADDRESS + target) >>> 0,
    (GBA_ROM_BASE_ADDRESS + target + 1) >>> 0,
  ]));
  for (let offset = 0; offset + 4 <= bytes.length; offset += 4) {
    if (addresses.has(readU32(bytes, offset))) return true;
  }
  return false;
}

function executeAlu(halfword, registers) {
  if ((halfword & 0xf800) === 0x2000) {
    registers[(halfword >> 8) & 7] = halfword & 0xff;
    return true;
  }
  if ((halfword & 0xe000) === 0x0000 && (halfword & 0x1800) !== 0x1800) {
    const operation = (halfword >> 11) & 3;
    const amount = (halfword >> 6) & 0x1f;
    const source = registers[(halfword >> 3) & 7];
    const destination = halfword & 7;
    if (operation === 0) registers[destination] = source << amount;
    else if (operation === 1) registers[destination] = source >>> (amount || 32);
    else return false;
    registers[destination] >>>= 0;
    return true;
  }
  if ((halfword & 0xf800) === 0x1800) {
    const immediate = (halfword & 0x0400) !== 0;
    const subtract = (halfword & 0x0200) !== 0;
    const left = registers[(halfword >> 3) & 7];
    const right = immediate ? ((halfword >> 6) & 7) : registers[(halfword >> 6) & 7];
    registers[halfword & 7] = (subtract ? left - right : left + right) >>> 0;
    return true;
  }
  if ((halfword & 0xf800) === 0x3000 || (halfword & 0xf800) === 0x3800) {
    const register = (halfword >> 8) & 7;
    const immediate = halfword & 0xff;
    registers[register] = ((halfword & 0x0800) ? registers[register] - immediate
      : registers[register] + immediate) >>> 0;
    return true;
  }
  if ((halfword & 0xfc00) === 0x4000) {
    const operation = (halfword >> 6) & 0x0f;
    const source = registers[(halfword >> 3) & 7];
    const destination = halfword & 7;
    if (operation === 0) registers[destination] &= source;
    else if (operation === 2) registers[destination] <<= source & 0xff;
    else if (operation === 3) registers[destination] >>>= source & 0xff;
    else if (operation === 12) registers[destination] |= source;
    else return false;
    registers[destination] >>>= 0;
    return true;
  }
  if ((halfword & 0xfc00) === 0x4400) {
    const operation = (halfword >> 8) & 3;
    const source = (halfword >> 3) & 0x0f;
    const destination = (halfword & 7) | ((halfword >> 4) & 8);
    if (source > 7 || destination > 7) return false;
    if (operation === 0) registers[destination] = (registers[destination] + registers[source]) >>> 0;
    else if (operation === 2) registers[destination] = registers[source];
    else return false;
    return true;
  }
  return false;
}

function executeMapper(bytes, start, input, seed) {
  const registers = Array.from({ length: 8 }, (_, index) => (
    index === 0 ? input >>> 0 : (seed + index * 0x11111111) >>> 0
  ));
  for (let offset = start, count = 0; offset + 2 <= bytes.length && count < 16;
    offset += 2, count += 1) {
    const halfword = readU16(bytes, offset);
    if (halfword === 0x4770) return { value: registers[0] >>> 0, end: offset + 2 };
    if (!executeAlu(halfword, registers)) return null;
  }
  return null;
}

function findBlockMappers(bytes) {
  const expected = (value) => (GBA_SAVE_MEMORY_START_ADDRESS + ((value & 0xff) << 7)) >>> 0;
  const samples = [0, 1, 2, 0x7f, 0x80, 0xff, 0x1234];
  const matches = [];
  for (let end = 0; end + 2 <= bytes.length; end += 2) {
    if (readU16(bytes, end) !== 0x4770) continue;
    for (let start = Math.max(0, end - 30); start <= end; start += 2) {
      const runs = samples.flatMap((input) => [0x13579bdf, 0x2468ace0].map((seed) => (
        executeMapper(bytes, start, input, seed)
      )));
      if (runs.every((run, index) => run?.end === end + 2
          && run.value === expected(samples[Math.floor(index / 2)]))) {
        matches.push(start);
        break;
      }
    }
  }
  return [...new Set(matches)];
}

function candidateFunctionStarts(bytes, callOffset) {
  const starts = [];
  for (let offset = Math.max(0, callOffset - 24); offset <= callOffset; offset += 2) {
    const halfword = readU16(bytes, offset);
    if ((halfword & 0xff00) === 0xb500) starts.push(offset);
  }
  return starts;
}

function executeTripletReader(bytes, start, mapperTarget, index) {
  const destination = 0x02010000;
  const registers = [destination, index, 0x22222222, 0x33333333,
    0x44444444, 0x55555555, 0x66666666, 0x77777777];
  const reads = [];
  const stores = new Map();
  for (let offset = start, count = 0; offset + 2 <= bytes.length && count < 40;
    offset += 2, count += 1) {
    const halfword = readU16(bytes, offset);
    if ((halfword & 0xff00) === 0xb500 || (halfword & 0xfe00) === 0xbc00) continue;
    if ((halfword & 0xff00) === 0x4700) return { reads, stores };
    const callTarget = decodeThumbBlTarget(bytes, offset);
    if (callTarget !== null) {
      if (callTarget !== mapperTarget) return null;
      registers[0] = (GBA_SAVE_MEMORY_START_ADDRESS + ((registers[0] & 0xff) << 7)) >>> 0;
      offset += 2;
      continue;
    }
    if ((halfword & 0xf800) === 0x7800) {
      const destinationRegister = halfword & 7;
      const base = (halfword >> 3) & 7;
      const address = (registers[base] + ((halfword >> 6) & 0x1f)) >>> 0;
      if (address < GBA_SAVE_MEMORY_START_ADDRESS || address >= GBA_SAVE_MEMORY_START_ADDRESS + 0x8000) return null;
      reads.push(address);
      registers[destinationRegister] = ((address * 29) ^ (address >>> 8) ^ 0x5a) & 0xff;
      continue;
    }
    if ((halfword & 0xf800) === 0x8000) {
      const source = halfword & 7;
      const base = (halfword >> 3) & 7;
      const address = (registers[base] + (((halfword >> 6) & 0x1f) << 1)) >>> 0;
      if (address < destination || address >= destination + 16) return null;
      stores.set(address - destination, registers[source] & 0xffff);
      continue;
    }
    if (!executeAlu(halfword, registers)) return null;
  }
  return null;
}

function isTripletReader(bytes, start, mapperTarget) {
  return [0, 1, 17, 0xff].every((index) => {
    const result = executeTripletReader(bytes, start, mapperTarget, index);
    if (!result) return false;
    const first = GBA_SAVE_MEMORY_START_ADDRESS + index * 3 + 1;
    if (result.reads.length !== 3
        || result.reads.some((address, readIndex) => address !== first + readIndex)
        || result.stores.get(2) !== index) return false;
    const values = result.reads.map((address) => ((address * 29) ^ (address >>> 8) ^ 0x5a) & 0xff);
    return result.stores.get(6) === values[0]
      && result.stores.get(4) === (values[1] | (values[2] << 8));
  });
}

function classifyMappedTransfer(bytes, callOffset) {
  const tainted = Array(8).fill(false);
  tainted[0] = true;
  for (let offset = callOffset + 4, count = 0;
    offset + 2 <= bytes.length && count < 20;
    offset += 2, count += 1) {
    const halfword = readU16(bytes, offset);
    const target = decodeThumbBlTarget(bytes, offset);
    if (target !== null) {
      if (tainted[0] === tainted[1]) return null;
      return { callOffset: offset, kind: tainted[0] ? "read" : "write" };
    }
    if ((halfword & 0xf800) === 0x2000) {
      tainted[(halfword >> 8) & 7] = false;
    } else if ((halfword & 0xe000) === 0x0000 && (halfword & 0x1800) !== 0x1800) {
      tainted[halfword & 7] = tainted[(halfword >> 3) & 7];
    } else if ((halfword & 0xf800) === 0x1800) {
      const immediate = (halfword & 0x0400) !== 0;
      tainted[halfword & 7] = tainted[(halfword >> 3) & 7]
        || (!immediate && tainted[(halfword >> 6) & 7]);
    } else if ((halfword & 0xf800) === 0x3000 || (halfword & 0xf800) === 0x3800) {
      // The destination keeps its taint.
    } else if ((halfword & 0xfc00) === 0x4000) {
      tainted[halfword & 7] ||= tainted[(halfword >> 3) & 7];
    } else if ((halfword & 0xfc00) === 0x4400) {
      const operation = (halfword >> 8) & 3;
      const source = (halfword >> 3) & 0x0f;
      const destination = (halfword & 7) | ((halfword >> 4) & 8);
      if (destination > 7) return null;
      const sourceTaint = source <= 7 ? tainted[source] : false;
      if (operation === 2) tainted[destination] = sourceTaint;
      else if (operation === 0) tainted[destination] ||= sourceTaint;
      else if (operation !== 1) return null;
    } else if ((halfword & 0xf800) === 0x4800) {
      tainted[(halfword >> 8) & 7] = false;
    } else if ((halfword & 0xe000) === 0x6000
        || (halfword & 0xf000) === 0x8000
        || (halfword & 0xf200) === 0x5000) {
      if ((halfword & 0x0800) !== 0) tainted[halfword & 7] = false;
    } else if ((halfword & 0xfe00) === 0xb400) {
      // push has no register result
    } else if ((halfword & 0xfe00) === 0xbc00) {
      for (let register = 0; register < 8; register += 1) {
        if (halfword & (1 << register)) tainted[register] = false;
      }
    } else {
      return null;
    }
  }
  return null;
}

export function analyzeDirectSramAccesses(bytes, { allowedFunctionStarts = [] } = {}) {
  const allowed = new Set(allowedFunctionStarts);
  const literalAccesses = inventoryLiteralSaveAccesses(bytes);
  const unsupportedLiteralAccesses = literalAccesses
    .filter((access) => !allowed.has(access.functionStart));
  if (unsupportedLiteralAccesses.length !== 0) {
    const first = unsupportedLiteralAccesses[0];
    throw new PatchError(
      `Direct SRAM analysis found unsupported Save-aperture ${first.kind} `
      + `at 0x${first.accessOffset.toString(16)} in Thumb function `
      + `0x${first.functionStart.toString(16)}.`,
    );
  }
  const mappers = findBlockMappers(bytes);
  const readers = [];
  const transfers = [];
  for (const mapper of mappers) {
    const callers = directCallers(bytes, [mapper]);
    for (const { offset } of callers) {
      const starts = candidateFunctionStarts(bytes, offset)
        .filter((start) => isTripletReader(bytes, start, mapper));
      if (starts.length === 1) {
        readers.push(starts[0]);
        continue;
      }
      const transfer = classifyMappedTransfer(bytes, offset);
      if (transfer === null) {
        throw new PatchError(
          `Direct SRAM analysis found unsupported mapper caller 0x${offset.toString(16)} `
          + `for mapper 0x${mapper.toString(16)}.`,
        );
      }
      transfers.push(transfer);
    }
  }
  const uniqueReaders = [...new Set(readers)].sort((left, right) => left - right);
  const uniqueTransfers = [...new Map(transfers.map((transfer) => [
    transfer.callOffset,
    transfer,
  ])).values()].sort((left, right) => left.callOffset - right.callOffset);
  return {
    readers: uniqueReaders,
    transfers: uniqueTransfers,
    literalAccesses,
  };
}
