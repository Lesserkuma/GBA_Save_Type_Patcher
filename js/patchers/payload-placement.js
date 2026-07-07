export const PAYLOAD_ALIGNMENT = 0x100;
export const PATCH_BLOCK_ALIGNMENT = 0x40000;
export const GBA_MAX_ROM_SIZE = 0x02000000;

export function alignDown(value, alignment) {
  return value - (value % alignment);
}

export function alignUp(value, alignment) {
  return alignDown(value + alignment - 1, alignment);
}

export function alignedPayloadSpan(size) {
  return alignUp(size, PAYLOAD_ALIGNMENT);
}

export function isFreeByte(value) {
  return value === 0x00 || value === 0xff;
}

export function isFreeRegion(bytes, start, size) {
  if (start < 0 || size < 0 || start + size > bytes.length) return false;
  for (let offset = start; offset < start + size; offset += 1) {
    if (!isFreeByte(bytes[offset])) return false;
  }
  return true;
}

export function rangesOverlap(start, end, ranges) {
  return ranges.some(([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart);
}

export function resizeRom(rom, newSize, fillValue = 0xff) {
  if (newSize <= rom.bytes.length) return;
  const expanded = new Uint8Array(newSize);
  expanded.fill(fillValue);
  expanded.set(rom.bytes);
  rom.bytes = expanded;
}

function addOperation(operations, name, offset, size, details = {}) {
  const operation = { name, offset, size };
  if (details.value !== undefined) operation.value = details.value;
  operations.push(operation);
}

export function lastNonFreeEnd(bytes) {
  for (let offset = bytes.length - 1; offset >= 0; offset -= 1) {
    if (!isFreeByte(bytes[offset])) return offset + 1;
  }
  return 0;
}

export function findDirectPayloadRegion(bytes, totalSpan, excludedRanges = []) {
  if (totalSpan < 0) return null;
  let start = alignUp(lastNonFreeEnd(bytes), PAYLOAD_ALIGNMENT);

  while (start + totalSpan <= bytes.length) {
    const end = start + totalSpan;
    const overlappingRange = excludedRanges.find(([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart);
    if (overlappingRange) {
      start = alignUp(overlappingRange[1], PAYLOAD_ALIGNMENT);
      continue;
    }
    if (isFreeRegion(bytes, start, totalSpan)) return start;
    start += PAYLOAD_ALIGNMENT;
  }

  return null;
}

function directPayloadTargetEnd(bytes, totalSpan, excludedRanges) {
  let start = alignUp(lastNonFreeEnd(bytes), PAYLOAD_ALIGNMENT);
  while (true) {
    const end = start + totalSpan;
    const overlappingRange = excludedRanges.find(([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart);
    if (!overlappingRange) return end;
    start = alignUp(overlappingRange[1], PAYLOAD_ALIGNMENT);
  }
}

export function ensureDirectPayloadRegion(rom, operations, warnings, totalSpan, label, excludedRanges = []) {
  while (true) {
    if (rom.bytes.length > GBA_MAX_ROM_SIZE) {
      warnings.push(`${label}: ROM is larger than 32 MiB`);
      return null;
    }

    const payloadBase = findDirectPayloadRegion(rom.bytes, totalSpan, excludedRanges);
    if (payloadBase !== null) return payloadBase;

    const targetEnd = directPayloadTargetEnd(rom.bytes, totalSpan, excludedRanges);
    if (targetEnd > GBA_MAX_ROM_SIZE || rom.bytes.length >= GBA_MAX_ROM_SIZE) {
      warnings.push(`${label}: no free payload area and ROM is already 32 MiB`);
      return null;
    }

    const oldSize = rom.bytes.length;
    const newSize = Math.min(alignUp(targetEnd, PATCH_BLOCK_ALIGNMENT), GBA_MAX_ROM_SIZE);
    if (newSize <= oldSize) {
      warnings.push(`${label}: ROM could not be expanded`);
      return null;
    }
    resizeRom(rom, newSize, 0xff);
    addOperation(operations, `${label} ROM expansion`, oldSize, newSize - oldSize, { value: newSize });
  }
}
