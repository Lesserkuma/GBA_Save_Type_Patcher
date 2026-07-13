// SPDX-License-Identifier: GPL-3.0-or-later

import { crc32 } from "./core/crc32.js";
import { PatchError } from "./core/errors.js";
import { writeU16, writeU32 } from "./core/binary.js";

const encoder = new TextEncoder();
const ZIP_MAX_ENTRIES = 0xffff;
const ZIP_MAX_U16 = 0xffff;
const ZIP_MAX_U32 = 0xffffffff;

function zipError(message, code, context = {}) {
  return new PatchError(message, { code, stage: "zip", context, isRecoverable: true });
}

function checkedAdd(left, right, label) {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result > ZIP_MAX_U32) {
    throw zipError(`Classic ZIP ${label} exceeds 4 GiB.`, "ZIP32_LIMIT", { left, right, label });
  }
  return result;
}

export function sanitizeZipEntryName(name) {
  let safe = String(name ?? "").normalize("NFC");
  safe = safe.replace(/[\u0000-\u001f\u007f]/g, "_");
  safe = safe.replace(/[\\/]+/g, "_").replace(/\.\.+/g, "_").replace(/^\.+/, "").trim();
  safe = safe.replace(/^_+/, "_");
  if (!safe) throw zipError("ZIP entry name is empty after sanitization.", "ZIP_INVALID_NAME");
  const nameBytes = encoder.encode(safe);
  if (nameBytes.length > ZIP_MAX_U16) {
    throw zipError("ZIP entry name exceeds 65,535 UTF-8 bytes.", "ZIP_NAME_TOO_LONG", { length: nameBytes.length });
  }
  return { name: safe, nameBytes };
}

function deduplicateName(name, usedNames) {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  let candidate = name;
  let suffix = 2;
  while (usedNames.has(candidate.toLocaleLowerCase("en-US"))) candidate = `${stem} (${suffix++})${extension}`;
  usedNames.add(candidate.toLocaleLowerCase("en-US"));
  return candidate;
}

export function dosDateTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw zipError("ZIP timestamp is invalid.", "ZIP_INVALID_DATE");
  const year = date.getUTCFullYear();
  if (year < 1980 || year > 2107) {
    throw zipError("ZIP timestamp year must be between 1980 and 2107.", "ZIP_DATE_RANGE", { year });
  }
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    day: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

function entryBytes(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  throw zipError("ZIP entry data must be a Uint8Array or ArrayBuffer.", "ZIP_INVALID_ENTRY_DATA");
}

function makeLocalHeader(entry, stamp) {
  const local = new Uint8Array(30 + entry.nameBytes.length);
  writeU32(local, 0, 0x04034b50);
  writeU16(local, 4, 20);
  writeU16(local, 6, 0x0800);
  writeU16(local, 8, 0);
  writeU16(local, 10, stamp.time);
  writeU16(local, 12, stamp.day);
  writeU32(local, 14, entry.crc);
  writeU32(local, 18, entry.size);
  writeU32(local, 22, entry.size);
  writeU16(local, 26, entry.nameBytes.length);
  writeU16(local, 28, 0);
  local.set(entry.nameBytes, 30);
  return local;
}

function makeCentralHeader(entry, stamp) {
  const central = new Uint8Array(46 + entry.nameBytes.length);
  writeU32(central, 0, 0x02014b50);
  writeU16(central, 4, 20);
  writeU16(central, 6, 20);
  writeU16(central, 8, 0x0800);
  writeU16(central, 10, 0);
  writeU16(central, 12, stamp.time);
  writeU16(central, 14, stamp.day);
  writeU32(central, 16, entry.crc);
  writeU32(central, 20, entry.size);
  writeU32(central, 24, entry.size);
  writeU16(central, 28, entry.nameBytes.length);
  writeU16(central, 30, 0);
  writeU16(central, 32, 0);
  writeU16(central, 34, 0);
  writeU16(central, 36, 0);
  writeU32(central, 38, 0);
  writeU32(central, 42, entry.offset);
  central.set(entry.nameBytes, 46);
  return central;
}

export function createZipBlob(entries, options = {}) {
  if (!Array.isArray(entries)) throw new TypeError("ZIP entries must be an array.");
  if (entries.length > ZIP_MAX_ENTRIES) {
    throw zipError("Classic ZIP supports at most 65,535 entries.", "ZIP_ENTRY_LIMIT", { count: entries.length });
  }

  const now = options.now ? options.now() : new Date();
  const stamp = dosDateTime(now);
  const blobParts = [];
  const directory = [];
  const usedNames = new Set();
  let offset = 0;

  for (const input of entries) {
    const normalized = sanitizeZipEntryName(input.name);
    const uniqueName = deduplicateName(normalized.name, usedNames);
    const nameBytes = encoder.encode(uniqueName);
    if (nameBytes.length > ZIP_MAX_U16) throw zipError("Deduplicated ZIP name is too long.", "ZIP_NAME_TOO_LONG");
    const data = entryBytes(input.bytes);
    if (data.byteLength > ZIP_MAX_U32) throw zipError("ZIP entry exceeds 4 GiB.", "ZIP_ENTRY_SIZE_LIMIT");
    const entry = { nameBytes, data, crc: crc32(data), size: data.byteLength, offset };
    const local = makeLocalHeader(entry, stamp);
    blobParts.push(local, data);
    directory.push(entry);
    offset = checkedAdd(offset, local.length, "local header offset");
    offset = checkedAdd(offset, data.byteLength, "file data offset");
  }

  const centralStart = offset;
  for (const entry of directory) {
    const central = makeCentralHeader(entry, stamp);
    blobParts.push(central);
    offset = checkedAdd(offset, central.length, "central directory offset");
  }
  const centralSize = offset - centralStart;

  const end = new Uint8Array(22);
  writeU32(end, 0, 0x06054b50);
  writeU16(end, 4, 0);
  writeU16(end, 6, 0);
  writeU16(end, 8, directory.length);
  writeU16(end, 10, directory.length);
  writeU32(end, 12, centralSize);
  writeU32(end, 16, centralStart);
  writeU16(end, 20, 0);
  checkedAdd(offset, end.length, "archive size");
  blobParts.push(end);
  return new Blob(blobParts, { type: "application/zip" });
}
