// SPDX-License-Identifier: GPL-3.0-or-later

import { readU16, readU32, writeU16, writeU32 } from "../core/binary.js";

const PHYSICAL_SIZE = 0x10000;
const CUSTOM_READBACK_SIZE = 0x20000;
const SRAM_SIZE = 0x8000;
const SRAM_HEADER_BASE = 0x8000;
const SRAM_LAYOUT_MARKER_BASE = 0xd0;
const SRAM_LAYOUT_VERSION = 16;
const SRAM_PROGRAM_MARKER = SRAM_HEADER_BASE + 0x10;
const SRAM_SCRATCH_BASE = 0xf000;
const SRAM_LOG_SECTOR_COUNT = 8;
const SRAM_LOG_ENTRY_SIZE = 2;
const SRAM_LOG_RLE_TAG_BASE = 0x80;
const SRAM_LOG_RLE_TAG_MASK = 0xc0;
const SRAM_LOG_RLE_LENGTH_MASK = 0x3f;
const SRAM_LOG_OVERFLOW_TAG = 0xc0;
const SRAM_LOG_OVERFLOW_MARKER = 0xc1;
const SRAM_LOG_HEADER_SIZE = 0x20;
const SRAM_LOG_BLOCK_SIZE = 0x40;
const SRAM_FULL_LOG_SECTOR_COUNT = 6;
const SRAM_SECTOR0_LOG_SLICE_SIZE = 0x3f;
const SRAM_FULL_LOG_SLICE_SIZE = 0x40;
const SRAM_SHARED_LOG_SLICE_SIZE = 0x20;
const SRAM_SHARED_LOG_BASE = 0xe000;
const SRAM_SHARED_LOG_PARTITION_SIZE = 0x800;
const SRAM_STORAGE = "direct-sram-sector-log-v16";
const SRAM_HEADER = Uint8Array.of(
  0x4c, 0x4b, 0x53, 0x52, SRAM_LAYOUT_VERSION,
  SRAM_LOG_ENTRY_SIZE, SRAM_LOG_SECTOR_COUNT, 0xff,
  0x00, 0x80, 0x01, 0xff, 0x52, 0x53, 0x4b, 0x4c,
);

const DIRECT_SNAPSHOT_SLOT_SIZE = 0x8000;
const DIRECT_SNAPSHOT_VERSION = 3;
const DIRECT_SNAPSHOT_RAW = 0x52;
const DIRECT_SNAPSHOT_RLE = 0x4c;
const DIRECT_SNAPSHOT_MAGIC = Uint8Array.of(0x44, 0x53, 0x53, 0x33);
const DIRECT_SNAPSHOT_STORAGE = "direct-sram-snapshot-v3";
const DIRECT_SNAPSHOT_HEADER_SIZE = 16;
const DIRECT_SNAPSHOT_PAGE_SIZE = 0x400;
const DIRECT_SNAPSHOT_PAGE_COUNT = SRAM_SIZE / DIRECT_SNAPSHOT_PAGE_SIZE;
const DIRECT_SNAPSHOT_INDEX_SIZE = DIRECT_SNAPSHOT_PAGE_COUNT * 2;

const EEPROM_SIZE = 0x2000;
const SECTOR_SIZE = 0x1000;
const DELTA_BASE = 0x2000;
const DELTA_SIZE = 0x2000;
const GENERATION_COUNT = 5;
const HEADER_OFFSET = 0xc000;
const EEPROM_PROGRAM_MARKER = 0xd000;
const EEPROM_SEED_BASE = 0xd100;
const EEPROM_SEED_SIZE = EEPROM_SIZE / 8;
const EEPROM_SCRATCH_BASE = 0xe000;
const EEPROM_LAYOUT_MARKER_BASE = 0xe0;
const EEPROM_LAYOUT_VERSION = 5;
const HEADER = Uint8Array.of(
  0x4c, 0x4b, 0x45, 0x44, EEPROM_LAYOUT_VERSION, GENERATION_COUNT, 0x07, 0xff,
  0x00, 0x20, 0x01, 0xff, 0x44, 0x45, 0x4b, 0x4c,
);

function bytesOf(input, label = "save") {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError(`${label} must be binary data.`);
}

function directBank(bytes) {
  if (bytes.length === PHYSICAL_SIZE) return bytes;
  if (bytes.length === CUSTOM_READBACK_SIZE) return bytes.subarray(0, PHYSICAL_SIZE);
  return null;
}

function requireDirectBank(input, label) {
  const physical = directBank(bytesOf(input));
  if (!physical) throw new RangeError(`${label} must be exactly 65536 or 131072 bytes.`);
  return physical;
}

function requireLength(bytes, length, label) {
  if (bytes.length !== length) throw new RangeError(`${label} must be exactly ${length} bytes.`);
}

function rangeIsErased(bytes, first, end) {
  for (let offset = first; offset < end; offset += 1) {
    if (bytes[offset] !== 0xff) return false;
  }
  return true;
}

function eepromHeaderMatches(bytes) {
  if (bytes.length !== PHYSICAL_SIZE) return false;
  if (!HEADER.every((value, index) => bytes[HEADER_OFFSET + index] === value)) return false;
  return bytes[EEPROM_PROGRAM_MARKER] === EEPROM_LAYOUT_MARKER_BASE
    && rangeIsErased(bytes, HEADER_OFFSET + HEADER.length, HEADER_OFFSET + SECTOR_SIZE)
    && rangeIsErased(bytes, EEPROM_PROGRAM_MARKER + 1, EEPROM_SEED_BASE)
    && rangeIsErased(bytes, EEPROM_SEED_BASE + EEPROM_SEED_SIZE, EEPROM_SCRATCH_BASE);
}

function sramMarkerMatches(bytes) {
  if (bytes.length !== PHYSICAL_SIZE) return false;
  return bytes[SRAM_PROGRAM_MARKER] === SRAM_LAYOUT_MARKER_BASE;
}

function sramHeaderMatches(bytes) {
  return bytes.length === PHYSICAL_SIZE
    && SRAM_HEADER.every((value, index) => bytes[SRAM_HEADER_BASE + index] === value)
    && sramMarkerMatches(bytes)
    && rangeIsErased(
      bytes,
      SRAM_PROGRAM_MARKER + 1,
      SRAM_HEADER_BASE + SRAM_LOG_HEADER_SIZE,
    );
}

function sramLogSliceBase(logicalFirst) {
  const sector = Math.floor(logicalFirst / SECTOR_SIZE);
  const block = Math.floor((logicalFirst & (SECTOR_SIZE - 1)) / SRAM_LOG_BLOCK_SIZE);
  if (sector === 0) {
    return SRAM_HEADER_BASE + SRAM_LOG_HEADER_SIZE
      + block * SRAM_SECTOR0_LOG_SLICE_SIZE;
  }
  if (sector < SRAM_FULL_LOG_SECTOR_COUNT) {
    return SRAM_HEADER_BASE + sector * SECTOR_SIZE
      + block * SRAM_FULL_LOG_SLICE_SIZE;
  }
  return SRAM_SHARED_LOG_BASE
    + (sector - SRAM_FULL_LOG_SECTOR_COUNT) * SRAM_SHARED_LOG_PARTITION_SIZE
    + block * SRAM_SHARED_LOG_SLICE_SIZE;
}

function sramLogSliceSize(logicalFirst) {
  const sector = Math.floor(logicalFirst / SECTOR_SIZE);
  if (sector === 0) return SRAM_SECTOR0_LOG_SLICE_SIZE;
  if (sector < SRAM_FULL_LOG_SECTOR_COUNT) return SRAM_FULL_LOG_SLICE_SIZE;
  return SRAM_SHARED_LOG_SLICE_SIZE;
}

function sramLogPoolBase(logicalFirst) {
  const sector = Math.floor(logicalFirst / SECTOR_SIZE);
  if (sector === 0) return SRAM_HEADER_BASE + SRAM_LOG_HEADER_SIZE;
  if (sector < SRAM_FULL_LOG_SECTOR_COUNT) {
    return SRAM_HEADER_BASE + sector * SECTOR_SIZE;
  }
  return SRAM_SHARED_LOG_BASE
    + (sector - SRAM_FULL_LOG_SECTOR_COUNT) * SRAM_SHARED_LOG_PARTITION_SIZE;
}

function sramRleByte(physical, position, input) {
  const source = input === 0 ? position : position + input + 1;
  return (~physical[source]) & 0xff;
}

function decodeSramRleBlock(physical, position, stored, canonical, blockFirst) {
  let input = 0;
  let output = 0;
  while (input < stored && output < SRAM_LOG_BLOCK_SIZE) {
    const control = sramRleByte(physical, position, input++);
    const count = control < 0x80 ? control + 1 : (control & 0x7f) + 3;
    if (count > SRAM_LOG_BLOCK_SIZE - output) {
      throw new RangeError("Invalid Direct SRAM v16 RLE output length.");
    }
    if (control < 0x80) {
      if (count > stored - input) {
        throw new RangeError("Invalid Direct SRAM v16 RLE literal length.");
      }
      for (let index = 0; index < count; index += 1) {
        canonical[blockFirst + output + index] = sramRleByte(
          physical, position, input + index,
        );
      }
      input += count;
    } else {
      if (input >= stored) {
        throw new RangeError("Invalid Direct SRAM v16 RLE run length.");
      }
      canonical.fill(
        sramRleByte(physical, position, input++),
        blockFirst + output,
        blockFirst + output + count,
      );
    }
    output += count;
  }
  if (input !== stored || output !== SRAM_LOG_BLOCK_SIZE) {
    throw new RangeError("Invalid Direct SRAM v16 RLE block length.");
  }
}

function directSnapshotFingerprint(bytes) {
  let fingerprint = 0x6d2b79f5;
  for (let logical = 0; logical < bytes.length; logical += 1) {
    const value = bytes[logical];
    if (value === 0) continue;
    let mixed = (Math.imul(logical + 1, 0x9e3779b1)
      ^ Math.imul(value, 0x85ebca6b)) >>> 0;
    mixed = (mixed ^ (mixed >>> 16)) >>> 0;
    fingerprint = (fingerprint ^ mixed) >>> 0;
    fingerprint = ((fingerprint << 5) | (fingerprint >>> 27)) >>> 0;
  }
  return fingerprint;
}

function snapshotHeaderMagicMatches(bytes, base) {
  return bytes.length === PHYSICAL_SIZE
    && DIRECT_SNAPSHOT_MAGIC.every((value, index) => bytes[base + index] === value);
}

function encodeDirectSnapshotRleFragment(canonical, first, end) {
  const output = [];
  let at = first;
  while (at < end) {
    let run = 1;
    while (at + run < end && run < 130 && canonical[at + run] === canonical[at]) run += 1;
    if (run >= 3) {
      output.push(0x80 | (run - 3), canonical[at]);
      at += run;
      continue;
    }
    const literalFirst = at;
    at += run;
    while (at < end) {
      run = 1;
      while (at + run < end && run < 130 && canonical[at + run] === canonical[at]) run += 1;
      if (run >= 3 || at - literalFirst + run > 128) break;
      at += run;
    }
    output.push(at - literalFirst - 1);
    for (let index = literalFirst; index < at; index += 1) {
      output.push(canonical[index]);
    }
  }
  return Uint8Array.from(output);
}

function encodeDirectSnapshotRle(canonical) {
  const index = new Uint8Array(DIRECT_SNAPSHOT_INDEX_SIZE);
  const fragments = [];
  let stored = 0;
  for (let page = 0; page < DIRECT_SNAPSHOT_PAGE_COUNT; page += 1) {
    writeU16(index, page * 2, stored);
    const first = page * DIRECT_SNAPSHOT_PAGE_SIZE;
    const fragment = encodeDirectSnapshotRleFragment(
      canonical, first, first + DIRECT_SNAPSHOT_PAGE_SIZE,
    );
    fragments.push(fragment);
    stored += fragment.length;
  }
  const output = new Uint8Array(DIRECT_SNAPSHOT_INDEX_SIZE + stored);
  output.set(index);
  let cursor = DIRECT_SNAPSHOT_INDEX_SIZE;
  for (const fragment of fragments) {
    output.set(fragment, cursor);
    cursor += fragment.length;
  }
  return output;
}

function invertedCopy(bytes) {
  const result = new Uint8Array(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) {
    result[index] = (~bytes[index]) & 0xff;
  }
  return result;
}

function importCanonicalDirectSnapshot(input) {
  const canonical = bytesOf(input);
  requireLength(canonical, SRAM_SIZE, "Canonical Direct SRAM snapshot");
  const rle = encodeDirectSnapshotRle(canonical);
  const rleFits = rle.length <= DIRECT_SNAPSHOT_SLOT_SIZE - DIRECT_SNAPSHOT_HEADER_SIZE;
  const rawHeaderSafe = canonical.subarray(0, DIRECT_SNAPSHOT_HEADER_SIZE)
    .every((value) => value === 0);
  if (!rleFits && !rawHeaderSafe) {
    throw new RangeError(
      "Direct snapshot is incompressible and its header span is not logically blank.",
    );
  }
  const tag = rleFits ? DIRECT_SNAPSHOT_RLE : DIRECT_SNAPSHOT_RAW;
  const payload = tag === DIRECT_SNAPSHOT_RLE ? rle : canonical;
  const physical = new Uint8Array(PHYSICAL_SIZE).fill(0xff);
  const header = 0;
  physical.set(
    invertedCopy(payload),
    tag === DIRECT_SNAPSHOT_RLE ? DIRECT_SNAPSHOT_HEADER_SIZE : header,
  );
  physical.set(DIRECT_SNAPSHOT_MAGIC, header);
  physical[header + 4] = DIRECT_SNAPSHOT_VERSION;
  physical[header + 5] = tag;
  writeU16(physical, header + 6, payload.length);
  writeU16(physical, header + 8, (~payload.length) & 0xffff);
  writeU16(physical, header + 10, SRAM_SIZE);
  writeU32(physical, header + 12, directSnapshotFingerprint(canonical));
  return physical;
}

function directSnapshotHeaderBases(physical) {
  return [0, DIRECT_SNAPSHOT_SLOT_SIZE].filter((base) => (
    snapshotHeaderMagicMatches(physical, base)
    && physical[base + 4] === DIRECT_SNAPSHOT_VERSION
    && [DIRECT_SNAPSHOT_RAW, DIRECT_SNAPSHOT_RLE].includes(physical[base + 5])
  ));
}

function directSnapshotHeaderBase(physical) {
  const headers = directSnapshotHeaderBases(physical);
  return headers.length === 1 ? headers[0] : null;
}

function decodeDirectSnapshot(input) {
  const physical = requireDirectBank(input, "Direct SRAM snapshot");
  const header = directSnapshotHeaderBase(physical);
  if (header === null) throw new RangeError("Unknown or ambiguous Direct SRAM snapshot header.");
  const tag = physical[header + 5];
  const data = header + (tag === DIRECT_SNAPSHOT_RLE ? DIRECT_SNAPSHOT_HEADER_SIZE : 0);
  const stored = readU16(physical, header + 6);
  if ((stored ^ readU16(physical, header + 8)) !== 0xffff
      || readU16(physical, header + 10) !== SRAM_SIZE
      || stored === 0
      || stored > SRAM_SIZE
      || (physical[header + 5] === DIRECT_SNAPSHOT_RLE
        && stored > DIRECT_SNAPSHOT_SLOT_SIZE - DIRECT_SNAPSHOT_HEADER_SIZE)) {
    throw new RangeError("Invalid Direct SRAM snapshot lengths.");
  }
  let canonical;
  if (tag === DIRECT_SNAPSHOT_RAW) {
    if (stored !== SRAM_SIZE) throw new RangeError("Invalid raw Direct SRAM snapshot length.");
    canonical = invertedCopy(physical.subarray(data, data + stored));
    canonical.fill(0, 0, DIRECT_SNAPSHOT_HEADER_SIZE);
  } else {
    canonical = new Uint8Array(SRAM_SIZE);
    if (stored <= DIRECT_SNAPSHOT_INDEX_SIZE) {
      throw new RangeError("Invalid Direct SRAM RLE index length.");
    }
    for (let page = 0; page < DIRECT_SNAPSHOT_PAGE_COUNT; page += 1) {
      const offsetAt = page * 2;
      let inputOffset = ((~physical[data + offsetAt]) & 0xff)
        | (((~physical[data + offsetAt + 1]) & 0xff) << 8);
      let inputEnd = stored - DIRECT_SNAPSHOT_INDEX_SIZE;
      if (page + 1 < DIRECT_SNAPSHOT_PAGE_COUNT) {
        inputEnd = ((~physical[data + offsetAt + 2]) & 0xff)
          | (((~physical[data + offsetAt + 3]) & 0xff) << 8);
      }
      if (inputOffset >= inputEnd || inputEnd > stored - DIRECT_SNAPSHOT_INDEX_SIZE) {
        throw new RangeError("Invalid Direct SRAM RLE page index.");
      }
      inputOffset += DIRECT_SNAPSHOT_INDEX_SIZE;
      inputEnd += DIRECT_SNAPSHOT_INDEX_SIZE;
      let outputOffset = page * DIRECT_SNAPSHOT_PAGE_SIZE;
      const outputEnd = outputOffset + DIRECT_SNAPSHOT_PAGE_SIZE;
      while (inputOffset < inputEnd && outputOffset < outputEnd) {
        const control = (~physical[data + inputOffset++]) & 0xff;
        const count = control < 0x80 ? control + 1 : (control & 0x7f) + 3;
        if (count > outputEnd - outputOffset) {
          throw new RangeError("Invalid Direct SRAM RLE output length.");
        }
        if (control < 0x80) {
          if (count > inputEnd - inputOffset) {
            throw new RangeError("Invalid Direct SRAM RLE literal length.");
          }
          for (let index = 0; index < count; index += 1) {
            canonical[outputOffset + index] = (~physical[data + inputOffset + index]) & 0xff;
          }
          inputOffset += count;
        } else {
          if (inputOffset >= inputEnd) throw new RangeError("Invalid Direct SRAM RLE run length.");
          canonical.fill(
            (~physical[data + inputOffset++]) & 0xff,
            outputOffset,
            outputOffset + count,
          );
        }
        outputOffset += count;
      }
      if (inputOffset !== inputEnd || outputOffset !== outputEnd) {
        throw new RangeError("Invalid Direct SRAM RLE page length.");
      }
    }
  }
  if (directSnapshotFingerprint(canonical) !== readU32(physical, header + 12)) {
    throw new RangeError("Invalid Direct SRAM snapshot fingerprint.");
  }
  return canonical;
}


function decodeDirectSramSectorLogSave(input) {
  const physical = requireDirectBank(input, "Direct SRAM save");
  if (!sramHeaderMatches(physical)) {
    throw new RangeError("Unknown or unsupported Direct SRAM v16 layout header.");
  }
  if (!rangeIsErased(physical, SRAM_SCRATCH_BASE, PHYSICAL_SIZE)) {
    throw new RangeError("Invalid Direct SRAM v16 scratch range.");
  }

  const canonical = new Uint8Array(SRAM_SIZE);
  for (let logical = 0; logical < SRAM_SIZE; logical += 1) {
    canonical[logical] = (~physical[logical]) & 0xff;
  }

  const loggedSize = SRAM_LOG_SECTOR_COUNT * SECTOR_SIZE;
  for (let blockFirst = 0; blockFirst < loggedSize; blockFirst += SRAM_LOG_BLOCK_SIZE) {
    const sliceBase = sramLogSliceBase(blockFirst);
    const sliceSize = sramLogSliceSize(blockFirst);
    const block = Math.floor((blockFirst & (SECTOR_SIZE - 1)) / SRAM_LOG_BLOCK_SIZE);
    const decodeSlice = (first, limit) => {
      let position = first;
      while (position <= limit - SRAM_LOG_ENTRY_SIZE) {
        const storedValue = physical[position];
        const storedAddress = physical[position + 1];
        if (storedAddress === 0xff) {
          if (!rangeIsErased(physical, position, limit)) {
            throw new RangeError("Invalid Direct SRAM v16 sector-log tail.");
          }
          return;
        }
        if ((storedAddress & SRAM_LOG_RLE_TAG_MASK) === SRAM_LOG_RLE_TAG_BASE) {
          const stored = (storedAddress & SRAM_LOG_RLE_LENGTH_MASK) + 1;
          if (stored + 1 > limit - position) {
            throw new RangeError("Invalid Direct SRAM v16 RLE stored length.");
          }
          decodeSramRleBlock(physical, position, stored, canonical, blockFirst);
          position += stored + 1;
          continue;
        }
        if (storedAddress >= SRAM_LOG_BLOCK_SIZE) {
          throw new RangeError("Invalid Direct SRAM v16 sector-log address.");
        }
        canonical[blockFirst + storedAddress] = (~storedValue) & 0xff;
        position += SRAM_LOG_ENTRY_SIZE;
      }
    };

    const primaryLimit = sliceBase + sliceSize - SRAM_LOG_ENTRY_SIZE;
    let scanOverflow = false;
    if (physical[sliceBase + 1] === SRAM_LOG_OVERFLOW_TAG) {
      if (physical[sliceBase] >= SRAM_LOG_BLOCK_SIZE) {
        throw new RangeError("Invalid Direct SRAM v16 overflow owner.");
      }
      scanOverflow = true;
    } else {
      decodeSlice(sliceBase, primaryLimit);
      const markerOwner = physical[primaryLimit];
      const marker = physical[primaryLimit + 1];
      if (marker === SRAM_LOG_OVERFLOW_MARKER) {
        if (markerOwner !== block) {
          throw new RangeError("Invalid Direct SRAM v16 overflow marker.");
        }
        scanOverflow = true;
      } else if (markerOwner !== 0xff || marker !== 0xff) {
        throw new RangeError("Invalid Direct SRAM v16 primary tail.");
      }
    }
    if (!scanOverflow) continue;
    const poolBase = sramLogPoolBase(blockFirst);
    for (let step = 1; step < SRAM_LOG_BLOCK_SIZE; step += 1) {
      const index = (block + step) & (SRAM_LOG_BLOCK_SIZE - 1);
      const overflowBase = poolBase + index * sliceSize;
      const owner = physical[overflowBase];
      const tag = physical[overflowBase + 1];
      if (tag !== SRAM_LOG_OVERFLOW_TAG) continue;
      if (owner >= SRAM_LOG_BLOCK_SIZE) {
        throw new RangeError("Invalid Direct SRAM v16 overflow owner.");
      }
      if (owner === block) {
        decodeSlice(overflowBase + SRAM_LOG_ENTRY_SIZE, overflowBase + sliceSize);
      }
    }
  }
  return canonical;
}

export function inspectConvertedFlashSave(input) {
  const bytes = bytesOf(input);
  if (bytes.length === SRAM_SIZE) return { format: "canonical-sram" };
  if (bytes.length === EEPROM_SIZE || bytes.length === 512) {
    return { format: "canonical-eeprom" };
  }
  const physical = directBank(bytes);
  if (!physical) return { format: "unknown" };
  if (sramHeaderMatches(physical)) {
    try {
      decodeDirectSramSectorLogSave(physical);
      return {
        format: SRAM_STORAGE,
      };
    } catch {
      return { format: "unknown-converted-flash" };
    }
  }
  if (eepromHeaderMatches(physical)) {
    return {
      format: "direct-eeprom-delta-v5",
    };
  }
  if (directSnapshotHeaderBase(physical) !== null) {
    try {
      decodeDirectSnapshot(physical);
      return {
        format: DIRECT_SNAPSHOT_STORAGE,
      };
    } catch {
      return { format: "unknown-converted-flash" };
    }
  }
  if (rangeIsErased(physical, 0, PHYSICAL_SIZE)) {
    return { format: "blank-physical-save" };
  }
  return { format: bytes.length === PHYSICAL_SIZE ? "unknown-converted-flash" : "unknown" };
}

export function exportDirectSramSave(input) {
  const bytes = bytesOf(input);
  const physical = requireDirectBank(bytes, "Direct SRAM save");
  if (rangeIsErased(physical, 0, PHYSICAL_SIZE)) {
    return new Uint8Array(SRAM_SIZE);
  }
  if (sramHeaderMatches(physical)) return decodeDirectSramSectorLogSave(physical);
  if (directSnapshotHeaderBases(physical).length > 0) return decodeDirectSnapshot(physical);
  throw new RangeError("Unknown or unsupported Direct SRAM layout header.");
}

function importCanonicalSramSave(input) {
  const canonical = bytesOf(input);
  requireLength(canonical, SRAM_SIZE, "Canonical SRAM save");
  const physical = new Uint8Array(PHYSICAL_SIZE).fill(0xff);
  for (let index = 0; index < SRAM_SIZE; index += 1) {
    physical[index] = (~canonical[index]) & 0xff;
  }
  physical.set(SRAM_HEADER, SRAM_HEADER_BASE);
  physical[SRAM_PROGRAM_MARKER] = SRAM_LAYOUT_MARKER_BASE;
  return physical;
}

export function decodeDirectEepromSave(input) {
  const physical = requireDirectBank(input, "Direct EEPROM save");
  if (rangeIsErased(physical, 0, PHYSICAL_SIZE)) {
    return new Uint8Array(EEPROM_SIZE);
  }
  if (!eepromHeaderMatches(physical)) {
    throw new RangeError("Unknown or unsupported Direct EEPROM layout header.");
  }
  const canonical = new Uint8Array(EEPROM_SIZE);
  for (let page = 0; page < EEPROM_SIZE; page += 8) {
    const seed = physical[EEPROM_SEED_BASE + (page >>> 3)];
    for (let index = 0; index < 8; index += 1) {
      canonical[page + index] = ((~physical[(page + index) ^ 7]) & 0xff)
        ^ ((~seed) & 0xff);
    }
    for (let generation = 0; generation < GENERATION_COUNT; generation += 1) {
      const generationBase = DELTA_BASE + generation * DELTA_SIZE;
      let empty = true;
      for (let index = 0; index < 8; index += 1) {
        if (physical[generationBase + ((page + index) ^ 7)] !== 0xff) {
          empty = false;
          break;
        }
      }
      if (empty) break;
      for (let index = 0; index < 8; index += 1) {
        canonical[page + index] ^= (~physical[generationBase + ((page + index) ^ 7)]) & 0xff;
      }
    }
  }
  return canonical;
}

function importCanonicalEepromSave(input) {
  const source = bytesOf(input);
  if (![512, EEPROM_SIZE].includes(source.length)) {
    throw new RangeError("Canonical EEPROM save must be exactly 512 or 8192 bytes.");
  }
  const canonical = new Uint8Array(EEPROM_SIZE);
  canonical.set(source);
  const physical = new Uint8Array(PHYSICAL_SIZE).fill(0xff);
  for (let index = 0; index < EEPROM_SIZE; index += 1) {
    physical[index ^ 7] = (~canonical[index]) & 0xff;
  }
  physical.set(HEADER, HEADER_OFFSET);
  physical[EEPROM_PROGRAM_MARKER] = EEPROM_LAYOUT_MARKER_BASE;
  return physical;
}

export function prepareDirectSave(input, family, storageFormat = null) {
  const bytes = bytesOf(input);
  if (family === "sram") {
    const importCanonical = storageFormat === DIRECT_SNAPSHOT_STORAGE
      ? importCanonicalDirectSnapshot
      : importCanonicalSramSave;
    if (bytes.length === SRAM_SIZE) return importCanonical(bytes);
    if ([PHYSICAL_SIZE, CUSTOM_READBACK_SIZE].includes(bytes.length)) {
      const format = inspectConvertedFlashSave(bytes).format;
      if ([SRAM_STORAGE, DIRECT_SNAPSHOT_STORAGE].includes(format)) {
        return importCanonical(exportDirectSramSave(bytes));
      }
      if (format === "blank-physical-save") {
        return importCanonical(new Uint8Array(SRAM_SIZE));
      }
      throw new RangeError("Physical SRAM input must use Direct SRAM v16, Direct snapshot v3, or be completely erased.");
    }
    throw new RangeError("SRAM input must be canonical 32 KiB or a signed physical 64/128 KiB Direct image.");
  }
  if (family === "eeprom") {
    if (bytes.length === 512 || bytes.length === EEPROM_SIZE) {
      return importCanonicalEepromSave(bytes);
    }
    if ([PHYSICAL_SIZE, CUSTOM_READBACK_SIZE].includes(bytes.length)) {
      const inspection = inspectConvertedFlashSave(bytes);
      if (inspection.format === "direct-eeprom-delta-v5") {
        return importCanonicalEepromSave(decodeDirectEepromSave(bytes));
      }
      if (inspection.format === "blank-physical-save") {
        return importCanonicalEepromSave(new Uint8Array(EEPROM_SIZE));
      }
      throw new RangeError("Physical EEPROM input must use Direct EEPROM v5 or be completely erased.");
    }
    throw new RangeError("EEPROM input must be canonical 512-byte/8 KiB or a signed physical 64/128 KiB Direct image.");
  }
  throw new RangeError(`Unsupported converted-save family: ${family}.`);
}
