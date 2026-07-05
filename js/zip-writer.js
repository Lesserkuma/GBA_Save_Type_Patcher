import { crc32 } from "./core/crc32.js";
import { writeU16, writeU32 } from "./core/binary.js";
const encoder = new TextEncoder();
function dosDateTime(date = new Date()) { const year = Math.max(1980, date.getFullYear()); return { time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2), day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate() }; }
function concat(parts, totalSize) { const out = new Uint8Array(totalSize); let offset = 0; for (const part of parts) { out.set(part, offset); offset += part.length; } return out; }
export function createZipBlob(entries) {
  const parts = []; const centralParts = []; const directory = []; let offset = 0; let totalSize = 0; const stamp = dosDateTime();
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name); const data = new Uint8Array(entry.bytes); const crc = crc32(data); const local = new Uint8Array(30 + nameBytes.length);
    writeU32(local,0,0x04034b50); writeU16(local,4,20); writeU16(local,6,0x0800); writeU16(local,8,0); writeU16(local,10,stamp.time); writeU16(local,12,stamp.day); writeU32(local,14,crc); writeU32(local,18,data.length); writeU32(local,22,data.length); writeU16(local,26,nameBytes.length); writeU16(local,28,0); local.set(nameBytes,30);
    parts.push(local, data); directory.push({ nameBytes, crc, size: data.length, offset }); offset += local.length + data.length; totalSize += local.length + data.length;
  }
  const centralStart = offset;
  for (const entry of directory) {
    const central = new Uint8Array(46 + entry.nameBytes.length);
    writeU32(central,0,0x02014b50); writeU16(central,4,20); writeU16(central,6,20); writeU16(central,8,0x0800); writeU16(central,10,0); writeU16(central,12,stamp.time); writeU16(central,14,stamp.day); writeU32(central,16,entry.crc); writeU32(central,20,entry.size); writeU32(central,24,entry.size); writeU16(central,28,entry.nameBytes.length); writeU16(central,30,0); writeU16(central,32,0); writeU16(central,34,0); writeU16(central,36,0); writeU32(central,38,0); writeU32(central,42,entry.offset); central.set(entry.nameBytes,46);
    centralParts.push(central); offset += central.length; totalSize += central.length;
  }
  const end = new Uint8Array(22); writeU32(end,0,0x06054b50); writeU16(end,4,0); writeU16(end,6,0); writeU16(end,8,directory.length); writeU16(end,10,directory.length); writeU32(end,12,offset-centralStart); writeU32(end,16,centralStart); writeU16(end,20,0); totalSize += end.length;
  return new Blob([concat([...parts, ...centralParts, end], totalSize)], { type: "application/zip" });
}
