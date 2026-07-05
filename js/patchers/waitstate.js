import { copyBytes, findBytes, readU16, readU32, writeU32 } from "../core/binary.js";
import { PatchError } from "../core/errors.js";
import { SRAM_CONSTANTS as C } from "./sram-data.js";
import { applyPatchHeaderMarker, hasWaitstatePatch, makePatchHeaderFlags, readPatchFlags } from "./patch-state.js";

function addOperation(operations, name, offset, size, details = {}) {
  const operation = { name, offset, size };
  if (details.codeName !== undefined) operation.code_name = details.codeName;
  if (details.value !== undefined) operation.value = details.value;
  operations.push(operation);
}

function alignDown(value, alignment) {
  return value - (value % alignment);
}

function isFreeByte(value) {
  return value === 0x00 || value === 0xff;
}

function isFreeRegion(bytes, start, size) {
  if (start < 0 || size < 0 || start + size > bytes.length) return false;
  for (let offset = start; offset < start + size; offset += 1) {
    if (!isFreeByte(bytes[offset])) return false;
  }
  return true;
}

function rangesOverlap(start, end, ranges) {
  return ranges.some(([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart);
}

function offsetInRanges(offset, ranges) {
  return ranges.some(([start, end]) => start <= offset && offset < end);
}

function resizeRom(rom, newSize, fillValue = 0xff) {
  if (newSize <= rom.bytes.length) return;
  const expanded = new Uint8Array(newSize);
  expanded.fill(fillValue);
  expanded.set(rom.bytes);
  rom.bytes = expanded;
}

function findTailFreeRegion(bytes, size, alignment = 16, end = bytes.length, excludedRanges = []) {
  let runEnd = null;
  const limit = Math.min(end, bytes.length);
  for (let pos = limit - 1; pos >= -1; pos -= 1) {
    const free = pos >= 0 && isFreeByte(bytes[pos]) && !offsetInRanges(pos, excludedRanges);
    if (free) {
      if (runEnd === null) runEnd = pos;
      continue;
    }
    if (runEnd !== null) {
      const runStart = pos + 1;
      const alignedStart = alignDown(runEnd - size + 1, alignment);
      if (alignedStart >= runStart && !rangesOverlap(alignedStart, alignedStart + size, excludedRanges)) return alignedStart;
      runEnd = null;
    }
  }
  return null;
}

function rangePairOverlaps(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

function overlapsBatterylessPowerBoundaryGuard(start, end) {
  let boundary = C.BATTERYLESS_REGION_ALIGNMENT * 2;
  while (boundary <= C.GBA_MAX_ROM_SIZE) {
    const guardStart = boundary - C.BATTERYLESS_RESERVED_SIZE;
    if (rangePairOverlaps(start, end, guardStart, boundary)) return true;
    boundary <<= 1;
  }
  return false;
}

export function batterylessPowerBoundaryGuardRanges(limit) {
  const ranges = [];
  let boundary = C.BATTERYLESS_REGION_ALIGNMENT * 2;
  while (boundary <= Math.min(limit, C.GBA_MAX_ROM_SIZE)) {
    ranges.push([boundary - C.BATTERYLESS_RESERVED_SIZE, boundary]);
    boundary <<= 1;
  }
  return ranges;
}

function lastNonEmptyBatterylessBlockStart(bytes) {
  let blockStart = alignDown(Math.max(0, bytes.length - 1), C.BATTERYLESS_REGION_ALIGNMENT);
  while (blockStart >= 0) {
    const blockEnd = Math.min(blockStart + C.BATTERYLESS_REGION_ALIGNMENT, bytes.length);
    let hasData = false;
    for (let offset = blockStart; offset < blockEnd; offset += 1) {
      if (!isFreeByte(bytes[offset])) {
        hasData = true;
        break;
      }
    }
    if (hasData) return blockStart;
    blockStart -= C.BATTERYLESS_REGION_ALIGNMENT;
  }
  return null;
}

function waitstatePayloadFitsAtBlockEnd(bytes, blockStart, size) {
  const blockEnd = blockStart + C.BATTERYLESS_REGION_ALIGNMENT;
  const payloadBase = blockEnd - size;
  if (payloadBase < 0 || blockEnd > bytes.length) return null;
  if (overlapsBatterylessPowerBoundaryGuard(payloadBase, blockEnd)) return null;
  if (!isFreeRegion(bytes, payloadBase, size)) return null;
  return payloadBase;
}

function findWaitstateBatterylessPosition(bytes, size) {
  const lastContentBlock = lastNonEmptyBatterylessBlockStart(bytes);
  if (lastContentBlock === null) return null;

  let blockStart = lastContentBlock;
  while (blockStart + C.BATTERYLESS_REGION_ALIGNMENT <= bytes.length) {
    const payloadBase = waitstatePayloadFitsAtBlockEnd(bytes, blockStart, size);
    if (payloadBase !== null) return payloadBase;
    blockStart += C.BATTERYLESS_REGION_ALIGNMENT;
  }
  return null;
}

export function ensureWaitstateBatterylessPosition(rom, operations, warnings, size) {
  while (true) {
    if (rom.bytes.length > C.GBA_MAX_ROM_SIZE) {
      warnings.push("Waitstate: ROM is larger than 32 MiB");
      return null;
    }
    const payloadBase = findWaitstateBatterylessPosition(rom.bytes, size);
    if (payloadBase !== null) return payloadBase;
    if (rom.bytes.length >= C.GBA_MAX_ROM_SIZE) {
      warnings.push("Waitstate: no free Batteryless code block and ROM is already 32 MiB");
      return null;
    }
    const oldSize = rom.bytes.length;
    const newSize = Math.min(oldSize + C.BATTERYLESS_REGION_ALIGNMENT, C.GBA_MAX_ROM_SIZE);
    if (newSize <= oldSize) {
      warnings.push("Waitstate: ROM could not be expanded");
      return null;
    }
    resizeRom(rom, newSize, 0xff);
    addOperation(operations, "Waitstate ROM expansion", oldSize, newSize - oldSize, { value: newSize });
  }
}

function decodeEntrypointAddress(out) {
  if (out.length < 4 || out[3] !== 0xea) throw new PatchError("Unexpected entrypoint instruction");
  const branchWord = readU32(out, 0);
  let branchOffset = branchWord & 0x00ffffff;
  if (branchOffset & 0x00800000) branchOffset -= 0x01000000;
  return C.GBA_ROM_BASE + 8 + (branchOffset << 2);
}

function encodeArmBranch(sourceAddress, targetAddress) {
  const branchOffset = (targetAddress - sourceAddress - 8) >> 2;
  if (branchOffset < -0x800000 || branchOffset > 0x7fffff) throw new PatchError("Entrypoint target is outside ARM branch range");
  return (0xea000000 | (branchOffset & 0x00ffffff)) >>> 0;
}

function makeWaitstatePayload(waitstateValue, nextEntrypoint) {
  const payload = new Uint8Array(C.WAITSTATE_PAYLOAD_SIZE);
  [0xe59f0008, 0xe59f1008, 0xe1c010b0, 0xe59ff004, C.WAITSTATE_REGISTER, waitstateValue & 0xffff, nextEntrypoint >>> 0]
    .forEach((word, index) => writeU32(payload, index * 4, word));
  return payload;
}

function armLdrLiteralTarget(instruction, instructionAddress) {
  if ((instruction & 0x0c100000) !== 0x04100000) return null;
  if (((instruction >>> 16) & 0xf) !== 15) return null;
  const immediate = instruction & 0xfff;
  const pc = instructionAddress + 8;
  return instruction & (1 << 23) ? pc + immediate : pc - immediate;
}

function thumbLdrLiteralTarget(instruction, instructionAddress) {
  if ((instruction & 0xf800) !== 0x4800) return null;
  const immediate = (instruction & 0xff) << 2;
  return ((instructionAddress + 4) & ~3) + immediate;
}

function waitstateLiteralIsReferenced(bytes, targetOffset, searchStart, searchEnd) {
  const targetAddress = C.GBA_ROM_BASE + targetOffset;
  const start = Math.max(0, searchStart);
  const end = Math.min(bytes.length, searchEnd);
  for (let offset = start & ~1; offset < end - 1; offset += 2) {
    if (thumbLdrLiteralTarget(readU16(bytes, offset), C.GBA_ROM_BASE + offset) === targetAddress) return true;
  }
  for (let offset = start & ~3; offset < end - 3; offset += 4) {
    if (armLdrLiteralTarget(readU32(bytes, offset), C.GBA_ROM_BASE + offset) === targetAddress) return true;
  }
  return false;
}

function patchWaitstateStartupLiterals(out, waitstateValue, operations, excludedRanges, scanLimit) {
  const marker = new Uint8Array(4);
  writeU32(marker, 0, C.WAITSTATE_REGISTER);
  const oldValues = new Set(C.WAITSTATE_DIRECT_OLD_VALUES.map((value) => value & 0xffff).filter((value) => value !== (waitstateValue & 0xffff)));
  const limit = Math.min(out.length, scanLimit || C.WAITSTATE_DIRECT_SCAN_LIMIT);
  let patched = 0;
  let offset = findBytes(out, marker, 0, limit);
  while (offset >= 0) {
    if (offset % 4 === 0 && !rangesOverlap(offset, offset + 4, excludedRanges)) {
      const valueOffset = offset + 4;
      if (valueOffset + 4 <= out.length && !rangesOverlap(valueOffset, valueOffset + 4, excludedRanges) && waitstateLiteralIsReferenced(out, offset, offset - 0x1000, offset)) {
        const oldValue = readU32(out, valueOffset) & 0xffff;
        if (oldValues.has(oldValue)) {
          writeU32(out, valueOffset, waitstateValue & 0xffff);
          addOperation(operations, "Waitstate startup WAITCNT value", valueOffset, 4, { codeName: "waitstate_startup_literal", value: waitstateValue & 0xffff });
          patched += 1;
        }
      }
    }
    offset = findBytes(out, marker, offset + 1, limit);
  }
  return patched;
}

export function applyWaitstatePatch(rom, operations, warnings, waitstateValue, options = {}) {
  if (hasWaitstatePatch(readPatchFlags(rom.bytes))) {
    return { requested: true, status: "already_patched", value: waitstateValue, direct_writes: 0 };
  }

  const excludedRanges = [...(options.excludedRanges || []), [0, Math.min(C.GBA_HEADER_SIZE, rom.bytes.length)]];
  const localOperations = [];
  const localWarnings = [];
  const work = new Uint8Array(rom.bytes);
  let payloadOffset = options.payloadOffset ?? null;
  let nextEntrypoint = null;
  let directWrites = 0;

  try {
    nextEntrypoint = decodeEntrypointAddress(work);
    directWrites = patchWaitstateStartupLiterals(work, waitstateValue, localOperations, excludedRanges, options.scanLimit);
    const payload = makeWaitstatePayload(waitstateValue, nextEntrypoint);
    if (payloadOffset === null && options.payloadOffsetRequired) {
      localWarnings.push("Waitstate: no free code block for entrypoint payload found");
      warnings.push(...localWarnings);
      return { requested: true, status: "failed", value: waitstateValue, direct_writes: 0 };
    }
    if (payloadOffset === null) {
      payloadOffset = findTailFreeRegion(work, payload.length, C.WAITSTATE_PAYLOAD_ALIGNMENT, work.length, excludedRanges);
    } else if (payloadOffset < 0 || payloadOffset % C.WAITSTATE_PAYLOAD_ALIGNMENT || !isFreeRegion(work, payloadOffset, payload.length)) {
      payloadOffset = null;
    }
    if (payloadOffset === null) {
      localWarnings.push("Waitstate: no free tail area for entrypoint payload found");
      warnings.push(...localWarnings);
      return { requested: true, status: "failed", value: waitstateValue, direct_writes: 0 };
    }

    const entrypointBranch = encodeArmBranch(C.GBA_ROM_BASE, C.GBA_ROM_BASE + payloadOffset);
    writeU32(work, 0, entrypointBranch);
    addOperation(localOperations, "Waitstate Entrypoint", 0, 4, { codeName: "waitstate_entrypoint", value: entrypointBranch });
    copyBytes(work, payloadOffset, payload);
    addOperation(localOperations, "Waitstate Payload", payloadOffset, payload.length, { codeName: "waitstate_payload", value: waitstateValue & 0xffff });
  } catch (error) {
    localWarnings.push(`Waitstate: ${error.message}`);
    warnings.push(...localWarnings);
    return { requested: true, status: "failed", value: waitstateValue, direct_writes: 0 };
  }

  rom.bytes = work;
  operations.push(...localOperations);
  warnings.push(...localWarnings);
  return { requested: true, status: "patched", value: waitstateValue, payload_offset: payloadOffset, next_entrypoint: nextEntrypoint, direct_writes: directWrites };
}


export function waitstatePrefixSizeForBatteryless(waitstateOptions, existingFlags) {
  return waitstateOptions?.enabled && !hasWaitstatePatch(existingFlags) ? C.WAITSTATE_PAYLOAD_SIZE : 0;
}

export function applyWaitstateForPipeline(rom, operations, warnings, waitstateOptions = {}, context = {}) {
  if (!waitstateOptions.enabled) return null;

  const value = waitstateOptions.value ?? C.WAITSTATE_DEFAULT_VALUE;
  if (hasWaitstatePatch(readPatchFlags(rom.bytes))) {
    return { requested: true, status: "already_patched", value, direct_writes: 0 };
  }

  let payloadOffset = null;
  let payloadOffsetRequired = false;
  const excludedRanges = [...(context.excludedRanges || [])];

  if (context.batterylessPayloadOffset !== null && context.batterylessPayloadOffset !== undefined && context.batterylessJustPatched) {
    payloadOffset = context.batterylessPayloadOffset - C.WAITSTATE_PAYLOAD_SIZE;
    payloadOffsetRequired = true;
  }

  if (payloadOffset === null) {
    payloadOffset = ensureWaitstateBatterylessPosition(rom, operations, warnings, C.WAITSTATE_PAYLOAD_SIZE);
    payloadOffsetRequired = true;
  }

  if (excludedRanges.length) excludedRanges.push(...batterylessPowerBoundaryGuardRanges(rom.bytes.length));
  return applyWaitstatePatch(rom, operations, warnings, value, {
    excludedRanges,
    payloadOffset,
    payloadOffsetRequired,
    scanLimit: waitstateOptions.scanLimit ?? C.WAITSTATE_DIRECT_SCAN_LIMIT,
  });
}

export function applyWaitstateToBytes(inputBytes, waitstateOptions = {}) {
  const rom = { bytes: new Uint8Array(inputBytes) };
  const operations = [];
  const warnings = [];
  let waitstate;

  if (hasWaitstatePatch(readPatchFlags(rom.bytes))) {
    waitstate = { requested: true, status: "already_patched", value: waitstateOptions.value ?? C.WAITSTATE_DEFAULT_VALUE, direct_writes: 0 };
  } else {
    const payloadOffset = ensureWaitstateBatterylessPosition(rom, operations, warnings, C.WAITSTATE_PAYLOAD_SIZE);
    waitstate = applyWaitstatePatch(rom, operations, warnings, waitstateOptions.value ?? C.WAITSTATE_DEFAULT_VALUE, {
      payloadOffset,
      payloadOffsetRequired: true,
      scanLimit: waitstateOptions.scanLimit ?? C.WAITSTATE_DIRECT_SCAN_LIMIT,
    });
  }

  applyPatchHeaderMarker(rom.bytes, operations, makePatchHeaderFlags(rom.bytes, { waitstateResult: waitstate }));
  return { bytes: rom.bytes, result: { waitstate, operations, warnings, status: operations.length ? "patched" : waitstate.status } };
}
