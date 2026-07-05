export function hexToBytes(hex) {
  const clean = hex.replace(/[^0-9a-f]/gi, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function readAscii(bytes, offset, length) {
  let text = "";
  const end = Math.min(bytes.length, offset + length);
  for (let i = offset; i < end; i += 1) {
    const value = bytes[i];
    if (value === 0) break;
    if (value >= 32 && value <= 126) text += String.fromCharCode(value);
  }
  return text.trim();
}

export function asciiBytes(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

export function readU16(bytes, offset) { return bytes[offset] | (bytes[offset + 1] << 8); }
export function writeU16(bytes, offset, value) { bytes[offset] = value & 0xff; bytes[offset + 1] = (value >>> 8) & 0xff; }
export function readU32(bytes, offset) { return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0; }
export function writeU32(bytes, offset, value) { const v = value >>> 0; bytes[offset] = v & 0xff; bytes[offset+1] = (v>>>8)&0xff; bytes[offset+2]=(v>>>16)&0xff; bytes[offset+3]=(v>>>24)&0xff; }

export function findBytes(bytes, pattern, start = 0, end = bytes.length) {
  if (!pattern.length) return Math.max(0, start);
  const first = pattern[0];
  const limit = Math.min(end, bytes.length) - pattern.length;
  for (let pos = Math.max(0, start); pos <= limit; pos += 1) {
    if (bytes[pos] !== first) continue;
    let matched = true;
    for (let i = 1; i < pattern.length; i += 1) if (bytes[pos + i] !== pattern[i]) { matched = false; break; }
    if (matched) return pos;
  }
  return -1;
}

export function startsWithBytes(bytes, offset, pattern) {
  if (offset < 0 || offset + pattern.length > bytes.length) return false;
  for (let i = 0; i < pattern.length; i += 1) if (bytes[offset + i] !== pattern[i]) return false;
  return true;
}

export function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

export function copyBytes(target, offset, source) {
  if (offset < 0 || offset + source.length > target.length) throw new Error(`Patch range outside ROM: 0x${offset.toString(16)}+0x${source.length.toString(16)}`);
  target.set(source, offset);
}

export function fillBytes(target, offset, length, value) {
  if (offset < 0 || length < 0 || offset + length > target.length) throw new Error(`Fill range outside ROM: 0x${offset.toString(16)}+0x${length.toString(16)}`);
  target.fill(value & 0xff, offset, offset + length);
}
