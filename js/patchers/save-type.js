// SPDX-License-Identifier: GPL-3.0-or-later

import { asciiBytes, readU16, readU32, startsWithBytes } from "../core/binary.js";
import { decodeThumbBlTarget } from "../core/thumb.js";
import { GBA_ROM_BASE_ADDRESS } from "../domain/gba-constants.js";
import { KNOWN_SAVE_TYPES } from "./sram-data.js";

const SAVE_TYPE_PREFIXES = ["EEPROM", "SRAM_F", "SRAM", "FLASH512", "FLASH1M", "FLASH"];
const EEPROM_4K_ONLY_TYPES = new Set(["EEPROM_V110", "EEPROM_V111"]);

function patternsByFirstByte(values) {
  const patterns = [];
  for (const value of values) {
    const bytes = asciiBytes(value);
    const candidates = patterns[bytes[0]] || [];
    candidates.push({ value, bytes });
    patterns[bytes[0]] = candidates;
  }
  return patterns;
}

const KNOWN_SAVE_TYPE_PATTERNS = patternsByFirstByte(KNOWN_SAVE_TYPES);
const SAVE_TYPE_PREFIX_PATTERNS = patternsByFirstByte(SAVE_TYPE_PREFIXES);

const MAX_GENERIC_SAVE_TYPE_LENGTH = 32;

export function findSaveTypeCandidates(bytes) {
  const candidates = [];
  const seen = new Set();
  for (let pos = 0; pos < bytes.length; pos += 1) {
    const firstByte = bytes[pos];

    const knownCandidates = KNOWN_SAVE_TYPE_PATTERNS[firstByte];
    if (knownCandidates) {
      for (const candidate of knownCandidates) {
        if (startsWithBytes(bytes, pos, candidate.bytes) && !seen.has(candidate.value)) {
          seen.add(candidate.value);
          candidates.push({ library: candidate.value, offset: pos, evidence: "knownSignature" });
        }
      }
    }

    const prefixCandidates = SAVE_TYPE_PREFIX_PATTERNS[firstByte];
    if (!prefixCandidates) continue;
    for (const candidate of prefixCandidates) {
      if (!startsWithBytes(bytes, pos, candidate.bytes)) continue;
      const versionOffset = pos + candidate.bytes.length;
      if (versionOffset + 2 > bytes.length || bytes[versionOffset] !== 0x5f || bytes[versionOffset + 1] !== 0x56) continue;

      let end = versionOffset + 2;
      while (end < bytes.length && end - pos < MAX_GENERIC_SAVE_TYPE_LENGTH) {
        const ch = bytes[end];
        const ok = (ch >= 48 && ch <= 57) || (ch >= 65 && ch <= 90) || ch === 95;
        if (!ok) break;
        end += 1;
      }
      let genericSaveType = "";
      for (let offset = pos; offset < end; offset += 1) genericSaveType += String.fromCharCode(bytes[offset]);
      if (!seen.has(genericSaveType)) {
        seen.add(genericSaveType);
        candidates.push({ library: genericSaveType, offset: pos, evidence: "genericVersionSignature" });
      }
      break;
    }
  }
  return candidates;
}

export function findSaveType(bytes) {
  const candidates = findSaveTypeCandidates(bytes);
  return resolveSaveTypeCandidate(bytes, candidates)?.candidate.library ?? null;
}

function isEepromConfigTable(bytes, offset) {
  return (
    offset >= 0
    && offset + 24 <= bytes.length
    && readU32(bytes, offset) === 512
    && readU16(bytes, offset + 4) === 0x40
    && readU16(bytes, offset + 6) === 0x0300
    && bytes[offset + 8] === 6
    && readU32(bytes, offset + 12) === 8192
    && readU16(bytes, offset + 16) === 0x0400
    && readU16(bytes, offset + 18) === 0x0300
    && bytes[offset + 20] === 14
  );
}

function findEepromConfigTables(bytes) {
  const tables = [];
  for (let offset = 0; offset + 24 <= bytes.length; offset += 4) {
    if (isEepromConfigTable(bytes, offset)) tables.push(offset);
  }
  return tables;
}

function rangeContainsU32(bytes, start, end, value) {
  const limit = Math.min(bytes.length - 4, end);
  for (let offset = Math.max(0, start); offset <= limit; offset += 2) {
    if (readU32(bytes, offset) === value) return true;
  }
  return false;
}

function findIdentifyEepromFunctions(bytes, tableOffsets) {
  const functions = [];
  for (let core = 0; core + 64 <= bytes.length; core += 2) {
    if (
      readU16(bytes, core) !== 0x0400
      || readU16(bytes, core + 2) !== 0x0c00
      || readU16(bytes, core + 4) !== 0x2200
      || readU16(bytes, core + 6) !== 0x2804
      || (readU16(bytes, core + 8) & 0xff00) !== 0xd100
    ) {
      continue;
    }

    let has64KComparison = false;
    for (let offset = core + 10; offset < core + 48; offset += 2) {
      if (readU16(bytes, offset) === 0x2840) {
        has64KComparison = true;
        break;
      }
    }
    if (!has64KComparison) continue;

    const tableOffset = tableOffsets.find((candidate) => {
      const tableAddress = GBA_ROM_BASE_ADDRESS + candidate;
      return (
        rangeContainsU32(bytes, core, core + 80, tableAddress)
        && rangeContainsU32(bytes, core, core + 80, tableAddress + 12)
      );
    });
    if (tableOffset === undefined) continue;
    const previous = core >= 2 ? readU16(bytes, core - 2) : null;
    functions.push(previous !== null && (previous & 0xff00) === 0xb500
      ? core - 2
      : core);
  }
  return [...new Set(functions)];
}

function identifyEepromCallArguments(bytes, functionOffsets) {
  const argumentsFound = [];
  const functionOffsetSet = new Set(functionOffsets);
  for (let offset = 2; offset + 4 <= bytes.length; offset += 2) {
    const target = decodeThumbBlTarget(bytes, offset);
    if (target === null || !functionOffsetSet.has(target)) continue;

    const previous = readU16(bytes, offset - 2);
    if (previous !== null && (previous & 0xff00) === 0x2000) argumentsFound.push(previous & 0xff);
    else argumentsFound.push(null);
  }
  return argumentsFound;
}

export function detectEepromSize(bytes, saveType = null) {
  const fallback = EEPROM_4K_ONLY_TYPES.has(saveType) ? 512 : null;
  const tables = findEepromConfigTables(bytes);
  if (!tables.length) return fallback;

  const identifyFunctions = findIdentifyEepromFunctions(bytes, tables);
  if (!identifyFunctions.length) return fallback;

  const argumentsFound = identifyEepromCallArguments(bytes, identifyFunctions);
  if (!argumentsFound.length || argumentsFound.some((value) => value !== 4 && value !== 64)) return fallback;

  const distinct = [...new Set(argumentsFound)];
  if (distinct.length !== 1) return fallback;
  return distinct[0] === 4 ? 512 : 8192;
}

function resolveSaveTypeCandidate(bytes, candidates) {
  if (candidates.length === 1) return { candidate: candidates[0], structuralEvidence: null };
  if (candidates.length < 2) return null;

  const eepromCandidates = candidates.filter((candidate) => candidate.library.startsWith("EEPROM"));
  const onlyEepromAndSram = candidates.every((candidate) => (
    candidate.library.startsWith("EEPROM") || candidate.library.startsWith("SRAM")
  ));
  if (!onlyEepromAndSram || eepromCandidates.length !== 1) return null;

  const eepromSize = detectEepromSize(bytes);
  if (eepromSize === null) return null;
  return {
    candidate: eepromCandidates[0],
    structuralEvidence: {
      library: eepromCandidates[0].library,
      offset: null,
      evidence: "eepromStructure",
      size: eepromSize,
    },
  };
}

export function detectRomSaveMetadata(bytes, explicitSaveType) {
  const candidates = explicitSaveType
    ? [{ library: explicitSaveType, offset: null, evidence: "explicit" }]
    : findSaveTypeCandidates(bytes);
  const resolution = resolveSaveTypeCandidate(bytes, candidates);
  const saveType = resolution?.candidate.library ?? null;
  const evidence = candidates.map((candidate) => ({ ...candidate }));
  if (resolution?.structuralEvidence) evidence.push(resolution.structuralEvidence);
  const ambiguousCandidates = !resolution && candidates.length > 1
    ? candidates.map((candidate) => candidate.library)
    : [];
  const confidence = resolution ? "high" : candidates.length > 1 ? "ambiguous" : "unknown";
  const common = { confidence, evidence, ambiguousCandidates };
  if (!saveType) return { library: null, medium: "none", size: null, label: "Unknown", ...common };

  if (saveType.startsWith("EEPROM")) {
    const size = detectEepromSize(bytes, saveType);
    return {
      library: saveType,
      medium: "eeprom",
      size,
      label: size === 512 ? "4K EEPROM" : size === 8192 ? "64K EEPROM" : "4K or 64K EEPROM",
      ...common,
    };
  }
  if (saveType.startsWith("SRAM")) {
    return { library: saveType, medium: "sram", size: 32768, label: "SRAM", ...common };
  }
  if (saveType.startsWith("FLASH1M")) {
    return { library: saveType, medium: "flash", size: 131072, label: "1M FLASH", ...common };
  }
  if (saveType.startsWith("FLASH512") || saveType.startsWith("FLASH")) {
    return { library: saveType, medium: "flash", size: 65536, label: "512K FLASH", ...common };
  }
  return { library: saveType, medium: "none", size: null, label: "Unknown", ...common };
}
