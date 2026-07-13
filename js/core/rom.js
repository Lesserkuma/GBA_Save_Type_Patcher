// SPDX-License-Identifier: GPL-3.0-or-later

import { readAscii } from "./binary.js";
import { computeGbaHeaderChecksum } from "../patchers/patch-state.js";

export const ROM_EXTENSIONS = new Set([".gba", ".bin", ".srl"]);
export const SAVE_EXTENSION = ".sav";

export const GBA_HEADER_STATUS = Object.freeze({
  VALID: "valid",
  SUSPICIOUS: "suspicious",
  INVALID: "invalid",
});

const GBA_LOGO_OFFSET = 0x04;
const GBA_LOGO_BYTE_LENGTH = 156;
const GBA_LOGO_SHA256 = "08a0153cfd6b0ea54b938f7d209933fa849da0d56f5a34c481060c9ff2fad818";

async function logoMatches(bytes) {
  const logoEnd = GBA_LOGO_OFFSET + GBA_LOGO_BYTE_LENGTH;
  if (bytes.length < logoEnd) return false;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.subarray(GBA_LOGO_OFFSET, logoEnd),
  );
  const actual = Array.from(
    new Uint8Array(digest),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
  return actual === GBA_LOGO_SHA256;
}

export function splitFileName(name) {
  const normalized = String(name).normalize("NFC");
  const dot = normalized.lastIndexOf(".");
  if (dot <= 0) return { baseName: normalized.toLowerCase(), extension: "" };
  return {
    baseName: normalized.slice(0, dot).toLowerCase(),
    extension: normalized.slice(dot).toLowerCase(),
  };
}

export async function parseRomMetadata(bytes, options = {}) {
  const strict = options.strict ?? false;
  if (!(bytes instanceof Uint8Array) || bytes.length < 0xc0) {
    return { headerStatus: GBA_HEADER_STATUS.INVALID, isHeaderValid: false, title: "", gameCode: "", issues: ["headerTruncated"] };
  }

  const issues = [];
  if (bytes[0xb2] !== 0x96) issues.push("fixedByte");
  if (computeGbaHeaderChecksum(bytes) !== bytes[0xbd]) issues.push("complementChecksum");
  if (!await logoMatches(bytes)) issues.push("nintendoLogo");
  if (bytes[0xb3] !== 0) issues.push("mainUnitCode");
  for (let offset = 0xb5; offset <= 0xbb; offset += 1) {
    if (bytes[offset] !== 0) {
      issues.push("reservedBytes");
      break;
    }
  }

  const fatalIssues = issues.filter((issue) => issue === "fixedByte" || issue === "complementChecksum");
  const headerStatus = fatalIssues.length
    ? GBA_HEADER_STATUS.INVALID
    : issues.length
      ? strict
        ? GBA_HEADER_STATUS.INVALID
        : GBA_HEADER_STATUS.SUSPICIOUS
      : GBA_HEADER_STATUS.VALID;
  return {
    headerStatus,
    isHeaderValid: headerStatus !== GBA_HEADER_STATUS.INVALID,
    title: readAscii(bytes, 0xa0, 12),
    gameCode: readAscii(bytes, 0xac, 4),
    issues,
  };
}

export function sanitizeOutputFileName(name, fallback = "patched.gba") {
  let safe = String(name ?? "").normalize("NFC");
  safe = safe.replace(/[\u0000-\u001f\u007f/\\]/g, "_");
  safe = safe.replace(/\.\.+/g, "_").replace(/^\.+/, "").trim();
  safe = safe.replace(/^_+/, "_");
  return safe || fallback;
}

export function makeOutputName(name) {
  const safeName = sanitizeOutputFileName(name, "rom.gba");
  const dot = safeName.lastIndexOf(".");
  return dot <= 0 ? `${safeName}_patched.gba` : `${safeName.slice(0, dot)}_patched${safeName.slice(dot)}`;
}

export function deduplicateOutputNames(names) {
  const used = new Set();
  return names.map((name) => {
    const safe = sanitizeOutputFileName(name);
    const dot = safe.lastIndexOf(".");
    const stem = dot > 0 ? safe.slice(0, dot) : safe;
    const extension = dot > 0 ? safe.slice(dot) : "";
    let candidate = safe;
    let suffix = 2;
    while (used.has(candidate.toLocaleLowerCase("en-US"))) candidate = `${stem} (${suffix++})${extension}`;
    used.add(candidate.toLocaleLowerCase("en-US"));
    return candidate;
  });
}
