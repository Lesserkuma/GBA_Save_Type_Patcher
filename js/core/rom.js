import { readAscii } from "./binary.js";
export const ROM_EXTENSIONS = new Set([".gba", ".bin", ".srl"]);
export const SAVE_EXTENSION = ".sav";
export function splitFileName(name) { const dot = name.lastIndexOf("."); if (dot <= 0) return { baseName: name.toLowerCase(), extension: "" }; return { baseName: name.slice(0, dot).toLowerCase(), extension: name.slice(dot).toLowerCase() }; }
export function formatBytes(size) { if (size < 1024) return `${size} B`; if (size < 1024*1024) return `${(size/1024).toFixed(1)} KB`; return `${(size/1024/1024).toFixed(1)} MB`; }
export function parseRomMetadata(bytes) { const validHeader = bytes.length >= 0xc0 && bytes[0xb2] === 0x96; return { validHeader, title: validHeader ? readAscii(bytes, 0xa0, 12) : "", gameCode: validHeader ? readAscii(bytes, 0xac, 4) : "" }; }
export function makeOutputName(name) { const dot = name.lastIndexOf("."); return dot <= 0 ? `${name}_patched.gba` : `${name.slice(0, dot)}_patched${name.slice(dot)}`; }
