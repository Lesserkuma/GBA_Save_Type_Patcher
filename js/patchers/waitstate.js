/*
 * SuperCard-style GBA WAITCNT patcher.
 *
 * Intentional SuperCard-compatible behavior:
 *   - scan at most the first seven 1 MiB chunks;
 *   - inspect only 32-bit-aligned words in the outer scan;
 *   - use the same backward ARM/Thumb literal-pool scan;
 *   - handle only the SuperCard WAITCNT constants/patterns;
 *   - apply the same byte edits:
 *       0x04000204 literal pool entry -> 00000000
 *       pattern-derived patch offset   -> 46C0 (Thumb NOP)
 */

const WAITCNT = 0x04000204;
const WAITCNT_MINUS_4 = 0x04000200;
const WAITCNT_PLUS_4 = 0x04000208;
const SCAN_CHUNKS = 7;
const CHUNK_SIZE = 0x100000;
const THUMB_MODE = 0x10;
const ARM_MODE = 0x20;

function addOperation(operations, name, offset, size, details = {}) {
  const operation = { name, offset, size };
  if (details.codeName !== undefined) operation.code_name = details.codeName;
  if (details.value !== undefined) operation.value = details.value;
  if (details.oldBytes !== undefined) operation.old_bytes = details.oldBytes;
  if (details.newBytes !== undefined) operation.new_bytes = details.newBytes;
  operations.push(operation);
}

function hexBytes(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(" ");
}

function readU16Halfword(bytes, halfwordIndex) {
  const offset = halfwordIndex * 2;
  if (offset < 0 || offset + 2 > bytes.length) return null;
  return (bytes[offset] | (bytes[offset + 1] << 8)) & 0xffff;
}

function readU32Byte(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function patchOffset(chunkIndex, halfwordIndex) {
  return (chunkIndex << 20) + halfwordIndex * 2;
}

function isThumbTrackedRegClobberOrStop(halfword, register) {
  const hw = halfword & 0xffff;
  const reg = register & 7;

  for (const top of [0x3000, 0xa000, 0xa800]) {
    if ((hw & 0xf800) === top) return (hw & 0xff00) === (top + (reg << 8));
  }

  if ((hw & 0xff80) === 0xb000) return false;
  if ((hw & 0xf800) === 0xe000) return false;
  if ((hw & 0xf000) === 0xd000) return false;
  if ((hw & 0xff00) === 0xbe00) return false;
  if ((hw & 0xe000) === 0xe000) return false;
  if ((hw & 0xff80) === 0x4780) return false;
  if ((hw & 0xff80) === 0x4700) return false;
  if ((hw & 0xf800) === 0x2800) return false;
  if ((hw & 0xff00) === 0x4500) return false;

  if ((hw & 0xf800) === 0xc000) return true;

  if ((hw & 0xf800) === 0x4800) return (hw & 0xff00) === (0x4800 + (reg << 8));
  if ((hw & 0xf800) === 0x9800) return (hw & 0xff00) === (0x9800 + (reg << 8));
  if ((hw & 0xf800) === 0x2000) return (hw & 0xff00) === (0x2000 + (reg << 8));

  if ((hw & 0xfe00) === 0xbc00) return true;
  if ((hw & 0xfe00) === 0xb400) return true;

  // This mirrors the original helper even though the earlier C000 branch makes
  // this specific test unreachable for C000 opcodes.
  if ((hw & 0xf800) === 0xc000) return (hw & 0xff00) === (0xc000 + (reg << 8));

  if ((hw & 0xf800) === 0x9000) return false;
  if ((hw & 0xf800) === 0x3800) return (hw & 0xff00) === (0x3800 + (reg << 8));
  if ((hw & 0xff80) === 0xb080) return false;
  if ((hw & 0xff00) === 0xdf00) return true;

  return (hw & 0x0007) === reg;
}

function findLiteralLoadsSc(chunk, literalHalfword) {
  const refs = [];
  let mode = 0;
  let start = literalHalfword - 0x1004;
  if (start < 0) start = 0;

  for (let i = start; i < literalHalfword; i += 1) {
    const wi = readU16Halfword(chunk, i);
    if (wi === null) continue;

    if ((i & 1) === 0) {
      const wi1 = readU16Halfword(chunk, i + 1);
      if (wi1 === 0xe59f && mode !== THUMB_MODE) {
        const target = (wi & 0x0fff) + i * 2 + 8;
        if (target === literalHalfword * 2) {
          refs.push({ halfword: i, reg: (wi >>> 12) & 0xf, mode: ARM_MODE });
          mode = ARM_MODE;
        }
        // SuperCard jumps to the loop tail for any ARM LDR-literal candidate
        // with high halfword E59F, even when the target does not match.
        continue;
      }
    }

    const target = ((wi & 0x00ff) << 2) + ((i * 2) & 0xfffffffc) + 4;
    if (target !== literalHalfword * 2) continue;
    if ((wi & 0xf800) !== 0x4800) continue;
    const wi1 = readU16Halfword(chunk, i + 1);
    if (wi1 !== null && (wi1 & 0xf000) === 0xe000) continue;
    if (mode === ARM_MODE) continue;
    refs.push({ halfword: i, reg: (wi >>> 8) & 0x7, mode: THUMB_MODE });
    mode = THUMB_MODE;
  }

  return refs;
}

function finderWaitcntFrom04000208(ref, chunk, chunkIndex) {
  const out = [];
  let fc = ref.halfword;
  const reg = ref.reg;

  if (ref.mode === THUMB_MODE) {
    const subPat = ((reg << 8) + 0x3804) & 0xffff;
    let f8 = 0;
    while (f8 < 0x14) {
      fc += 1;
      const hw = readU16Halfword(chunk, fc);
      if (hw === null) break;
      if (hw === subPat) {
        let f4 = 0;
        while (f4 < 5) {
          fc += 1;
          const hw2 = readU16Halfword(chunk, fc);
          if (hw2 === null) return out;
          if (isThumbTrackedRegClobberOrStop(hw2, reg)) return out;
          const strhPat = ((reg << 3) + 0x8000) & 0xffff;
          if ((hw2 & 0xfff8) === strhPat) {
            out.push(patchOffset(chunkIndex, fc));
            return out;
          }
          f4 += 1;
        }
        return out;
      }
      if (isThumbTrackedRegClobberOrStop(hw, reg)) return out;
      f8 += 1;
    }
    return out;
  }

  const subLow = ((reg << 12) + 4) & 0xffff;
  const subHigh = (0xe240 + reg) & 0xffff;
  let f8 = 0;
  while (f8 < 0x14) {
    fc += 2;
    const low = readU16Halfword(chunk, fc);
    const high = readU16Halfword(chunk, fc + 1);
    if (low === null || high === null) break;
    if (low === subLow && high === subHigh) {
      let f4 = 0;
      while (f4 < 5) {
        fc += 2;
        const low2 = readU16Halfword(chunk, fc);
        const high2 = readU16Halfword(chunk, fc + 1);
        if (low2 === null || high2 === null) return out;
        if (high2 === ((0x0e1c + reg) & 0xffff) && (low2 & 0x0fff) === 0x00b0) {
          out.push(patchOffset(chunkIndex, fc));
          return out;
        }
        f4 += 1;
      }
      return out;
    }
    if (((low & 0xf000) >>> 12) === reg) return out;
    f8 += 1;
  }
  return out;
}

function finderWaitcntFrom04000200(ref, chunk, chunkIndex) {
  const out = [];
  let fc = ref.halfword;
  const reg = ref.reg;

  if (ref.mode === THUMB_MODE) {
    const pat = ((reg << 3) + 0x8080) & 0xffff;
    let f8 = 0;
    while (f8 < 0x28) {
      fc += 1;
      const hw = readU16Halfword(chunk, fc);
      if (hw === null) break;
      if (isThumbTrackedRegClobberOrStop(hw, reg)) return out;
      if ((hw & 0xfff8) === pat) out.push(patchOffset(chunkIndex, fc));
      f8 += 1;
    }
    return out;
  }

  const lowPat = 0x00b4;
  const highPat = (0xe1c0 + reg) & 0xffff;
  let f8 = 0;
  while (f8 < 0x14) {
    fc += 2;
    const low = readU16Halfword(chunk, fc);
    const high = readU16Halfword(chunk, fc + 1);
    if (low === null || high === null) break;
    if (((low & 0xf000) >>> 12) === reg) return out;
    if (high === highPat && (low & 0x0fff) === lowPat) out.push(patchOffset(chunkIndex, fc));
    f8 += 1;
  }
  return out;
}

function finderWaitcntFromArm04000000(seedHalfword, seedReg, chunk, chunkIndex) {
  const out = [];
  let fc = seedHalfword;
  const baseReg = seedReg & 0xf;

  let directBaseValue = 0x04000000;
  let tempBaseValue = 0;
  let tempBaseReg = 0;
  let imm204Value = 0;
  let imm204Reg = 0;

  for (let n = 0; n < 0x14; n += 1) {
    fc += 2;
    const low = readU16Halfword(chunk, fc);
    const high = readU16Halfword(chunk, fc + 1);
    if (low === null || high === null) return out;

    if (high === ((0xe280 + baseReg) & 0xffff) && (low & 0x0fff) === 0x0c02) {
      const dst = (low >>> 12) & 0xf;
      if (dst === baseReg) directBaseValue += 0x200;
      else {
        tempBaseValue = 0x04000200;
        tempBaseReg = dst;
      }
      continue;
    }

    if ((high & 0xfff0) === 0xe1c0 && (low & 0x0fff) === 0x00b4) {
      const rn = high & 0xf;
      if (rn === baseReg && directBaseValue === 0x04000200) {
        out.push(patchOffset(chunkIndex, fc));
        return out;
      }
      if (rn === tempBaseReg && tempBaseValue === 0x04000200) {
        out.push(patchOffset(chunkIndex, fc));
        return out;
      }
      continue;
    }

    if (high === ((0xe580 + baseReg) & 0xffff) && (low & 0x0fff) === 0x0204) {
      const rn = high & 0xf;
      if (rn === baseReg && directBaseValue === 0x04000000) {
        out.push(patchOffset(chunkIndex, fc));
        return out;
      }
      continue;
    }

    if (high === ((0xe280 + baseReg) & 0xffff) && (low & 0x0fff) === 0x0f81) {
      const dst = (low >>> 12) & 0xf;
      if (dst === baseReg) directBaseValue += 0x204;
      else {
        tempBaseValue = WAITCNT;
        tempBaseReg = dst;
      }
      continue;
    }

    if ((high & 0xfff0) === 0xe1c0 && (low & 0x0fff) === 0x00b0) {
      const rn = high & 0xf;
      if (rn === baseReg && directBaseValue === WAITCNT) {
        out.push(patchOffset(chunkIndex, fc));
        return out;
      }
      if (rn === tempBaseReg && tempBaseValue === WAITCNT) {
        out.push(patchOffset(chunkIndex, fc));
        return out;
      }
      continue;
    }

    if (high === 0xe3a0 && (low & 0x0fff) === 0x0f81) {
      imm204Value = 0x204;
      imm204Reg = (low >>> 12) & 0xf;
      continue;
    }

    if ((high & 0xfff0) === 0xe180 && (low & 0x0ff0) === 0x00b0) {
      const rn = high & 0xf;
      const lowNonzero = low === 0 ? 0 : 1;
      if (rn === baseReg && directBaseValue === 0x04000000 && lowNonzero === imm204Reg && imm204Value === 0x204) {
        out.push(patchOffset(chunkIndex, fc));
        return out;
      }
      if (rn === imm204Reg && directBaseValue === 0x04000000 && lowNonzero === baseReg && imm204Value === 0x204) {
        out.push(patchOffset(chunkIndex, fc));
        return out;
      }
      continue;
    }

    if (((low & 0xf000) >>> 12) === baseReg) return out;
  }

  return out;
}

function scanSupercardWaitcnt(data) {
  const literalZeroOffsets = [];
  const waitcntNopOffsets = [];
  let missedCandidates = 0;

  for (let chunkIndex = 0; chunkIndex < SCAN_CHUNKS; chunkIndex += 1) {
    const start = chunkIndex * CHUNK_SIZE;
    if (start >= data.length) break;
    const chunk = data.subarray(start, Math.min(start + CHUNK_SIZE, data.length));
    const dwordCount = Math.floor(chunk.length / 4);

    for (let dwordIndex = 0; dwordIndex < dwordCount; dwordIndex += 1) {
      const pos = dwordIndex * 4;
      const val = readU32Byte(chunk, pos);
      if (val === null) continue;
      const literalHalfword = dwordIndex * 2;

      if (val === WAITCNT) {
        const refs = findLiteralLoadsSc(chunk, literalHalfword);
        if (refs.length) literalZeroOffsets.push(start + pos);
        else missedCandidates += 1;
        continue;
      }

      if (val === WAITCNT_PLUS_4) {
        const refs = findLiteralLoadsSc(chunk, literalHalfword);
        if (!refs.length) {
          missedCandidates += 1;
          continue;
        }
        for (const ref of refs) waitcntNopOffsets.push(...finderWaitcntFrom04000208(ref, chunk, chunkIndex));
        continue;
      }

      if (val === WAITCNT_MINUS_4) {
        const refs = findLiteralLoadsSc(chunk, literalHalfword);
        if (!refs.length) {
          missedCandidates += 1;
          continue;
        }
        for (const ref of refs) waitcntNopOffsets.push(...finderWaitcntFrom04000200(ref, chunk, chunkIndex));
        continue;
      }

      const masked = (val & 0xffff0fff) >>> 0;
      if (masked === 0xe3a00301 || masked === 0xe3a00640) {
        const seedReg = (val >>> 12) & 0xf;
        const found = finderWaitcntFromArm04000000(literalHalfword, seedReg, chunk, chunkIndex);
        if (found.length) waitcntNopOffsets.push(...found);
        else missedCandidates += 1;
      }
    }
  }

  return { literalZeroOffsets, waitcntNopOffsets, missedCandidates };
}

function buildPatches(data, result) {
  const patches = [];

  for (const offset of result.literalZeroOffsets) {
    patches.push({
      offset,
      old: data.slice(offset, offset + 4),
      newBytes: new Uint8Array([0x00, 0x00, 0x00, 0x00]),
      kind: "literal-zero",
      reason: "0x04000204 literal referenced by SuperCard literal-load scan",
    });
  }

  for (const offset of result.waitcntNopOffsets) {
    patches.push({
      offset,
      old: data.slice(offset, offset + 2),
      newBytes: new Uint8Array([0xc0, 0x46]),
      kind: "store-nop-46c0",
      reason: "fixed SuperCard WAITCNT pattern list entry",
    });
  }

  return patches;
}

function applyPatches(data, patches, operations) {
  const out = new Uint8Array(data);
  for (const patch of patches) {
    if (patch.offset < 0 || patch.offset + patch.newBytes.length > out.length) {
      throw new Error(`Waitstate patch offset outside ROM: 0x${patch.offset.toString(16)}`);
    }
    out.set(patch.newBytes, patch.offset);
    addOperation(operations, "SuperCard WAITCNT patch", patch.offset, patch.newBytes.length, {
      codeName: patch.kind,
      oldBytes: hexBytes(patch.old),
      newBytes: hexBytes(patch.newBytes),
    });
  }
  return out;
}

function runSupercardWaitstatePatch(inputBytes, operations, warnings) {
  const original = new Uint8Array(inputBytes);
  const scan = scanSupercardWaitcnt(original);
  const patches = buildPatches(original, scan);
  const out = applyPatches(original, patches, operations);

  // Preserve this diagnostic for callers that want to expose advanced details;
  // do not warn on missed candidates because SuperCard also silently ignores
  // unreferenced constants and unmatched fixed patterns.
  const status = patches.length ? "patched" : "already_patched";
  return {
    bytes: out,
    waitstate: {
      requested: true,
      status,
      patches: patches.length,
      literal_zeroes: scan.literalZeroOffsets.length,
      store_nops: scan.waitcntNopOffsets.length,
      missed_candidates: scan.missedCandidates,
    },
  };
}

export function applyWaitstatePatch(rom, operations, warnings, waitstateValue = null, options = {}) {
  const result = runSupercardWaitstatePatch(rom.bytes, operations, warnings);
  rom.bytes = result.bytes;
  return result.waitstate;
}

export function applyWaitstateForPipeline(rom, operations, warnings, waitstateOptions = {}, context = {}) {
  if (!waitstateOptions?.enabled) return null;
  return applyWaitstatePatch(rom, operations, warnings);
}

export function applyWaitstateToBytes(inputBytes, waitstateOptions = {}) {
  const rom = { bytes: new Uint8Array(inputBytes) };
  const operations = [];
  const warnings = [];

  if (waitstateOptions?.enabled === false) {
    return { bytes: rom.bytes, result: { waitstate: null, operations, warnings, status: "unchanged" } };
  }

  const waitstate = applyWaitstatePatch(rom, operations, warnings);
  return { bytes: rom.bytes, result: { waitstate, operations, warnings, status: operations.length ? "patched" : waitstate.status } };
}
