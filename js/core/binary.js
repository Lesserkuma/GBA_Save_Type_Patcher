// SPDX-License-Identifier: GPL-3.0-or-later

import { PatchError } from "./errors.js";

function assertBytes(bytes, name = "bytes") {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError(`${name} must be a Uint8Array.`);
  }
}

function assertRange(bytes, offset, byteLength) {
  assertBytes(bytes);
  if (
    !Number.isSafeInteger(offset)
    || !Number.isSafeInteger(byteLength)
    || offset < 0
    || byteLength < 0
    || offset + byteLength > bytes.length
  ) {
    throw new PatchError("Binary access is outside the available byte range.", {
      code: "BINARY_RANGE_ERROR",
      stage: "binary",
      context: { offset, byteLength, availableBytes: bytes.length },
    });
  }
}

export function hexToBytes(hex) {
  if (typeof hex !== "string") throw new TypeError("Hex input must be a string.");
  const invalidIndex = hex.search(/[^0-9a-f]/i);
  if (invalidIndex !== -1) {
    throw new PatchError(`Invalid hexadecimal character at position ${invalidIndex}.`, {
      code: "HEX_INVALID_CHARACTER",
      stage: "parse",
      context: { position: invalidIndex, character: hex[invalidIndex] },
    });
  }
  if (hex.length % 2 !== 0) {
    throw new PatchError("Hex input must contain an even number of digits.", {
      code: "HEX_ODD_LENGTH",
      stage: "parse",
      context: { length: hex.length },
    });
  }
  const output = new Uint8Array(hex.length / 2);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

export function formattedHexToBytes(hex) {
  if (typeof hex !== "string") throw new TypeError("Hex input must be a string.");
  const tokens = hex.trim() ? hex.trim().split(/[\s,:-]+/) : [];
  if (tokens.some((token) => !/^[0-9a-f]{2}$/i.test(token))) {
    throw new PatchError("Formatted hex must contain two-digit byte tokens.", {
      code: "HEX_INVALID_FORMAT",
      stage: "parse",
    });
  }
  return Uint8Array.from(tokens, (token) => Number.parseInt(token, 16));
}

export function readAscii(bytes, offset, length) {
  assertRange(bytes, offset, length);
  let text = "";
  const end = offset + length;
  for (let index = offset; index < end; index += 1) {
    const value = bytes[index];
    if (value === 0) break;
    if (value >= 32 && value <= 126) text += String.fromCharCode(value);
  }
  return text.trim();
}

export function asciiBytes(text) {
  if (typeof text !== "string") throw new TypeError("ASCII input must be a string.");
  const output = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    const value = text.charCodeAt(index);
    if (value > 0x7f) {
      throw new PatchError(`Non-ASCII character at position ${index}.`, {
        code: "ASCII_INVALID_CHARACTER",
        stage: "parse",
        context: { position: index, codePoint: value },
      });
    }
    output[index] = value;
  }
  return output;
}

export function readU16(bytes, offset) {
  assertRange(bytes, offset, 2);
  return bytes[offset] | (bytes[offset + 1] << 8);
}

export function writeU16(bytes, offset, value) {
  assertRange(bytes, offset, 2);
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

export function readU32(bytes, offset) {
  assertRange(bytes, offset, 4);
  return (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
  ) >>> 0;
}

export function writeU32(bytes, offset, value) {
  assertRange(bytes, offset, 4);
  const normalized = value >>> 0;
  bytes[offset] = normalized & 0xff;
  bytes[offset + 1] = (normalized >>> 8) & 0xff;
  bytes[offset + 2] = (normalized >>> 16) & 0xff;
  bytes[offset + 3] = (normalized >>> 24) & 0xff;
}

export function findBytes(bytes, pattern, start = 0, end = bytes.length) {
  assertBytes(bytes);
  assertBytes(pattern, "pattern");
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) throw new TypeError("Search bounds must be integers.");
  const searchStart = Math.max(0, start);
  const searchEnd = Math.min(end, bytes.length);
  if (searchEnd < searchStart) return -1;
  if (pattern.length === 0) return searchStart;
  const first = pattern[0];
  const limit = searchEnd - pattern.length;
  for (let position = searchStart; position <= limit; position += 1) {
    if (bytes[position] !== first) continue;
    let matched = true;
    for (let index = 1; index < pattern.length; index += 1) {
      if (bytes[position + index] !== pattern[index]) {
        matched = false;
        break;
      }
    }
    if (matched) return position;
  }
  return -1;
}

export function startsWithBytes(bytes, offset, pattern) {
  assertBytes(bytes);
  assertBytes(pattern, "pattern");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + pattern.length > bytes.length) return false;
  for (let index = 0; index < pattern.length; index += 1) {
    if (bytes[offset + index] !== pattern[index]) return false;
  }
  return true;
}

export function sameBytes(first, second) {
  assertBytes(first, "first");
  assertBytes(second, "second");
  if (first.length !== second.length) return false;
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] !== second[index]) return false;
  }
  return true;
}

export function copyBytes(target, offset, source) {
  assertBytes(source, "source");
  assertRange(target, offset, source.length);
  target.set(source, offset);
}

export function fillBytes(target, offset, length, value) {
  assertRange(target, offset, length);
  target.fill(value & 0xff, offset, offset + length);
}
