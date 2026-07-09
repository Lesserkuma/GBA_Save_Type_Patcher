import {
  asciiBytes,
  copyBytes,
  findBytes,
  hexToBytes,
  readU32,
  writeU32,
} from "../core/binary.js";
import { PatchError } from "../core/errors.js";
import {
  GBA_MAX_ROM_SIZE,
  PATCH_BLOCK_ALIGNMENT,
  alignDown,
  alignUp,
  isFreeRegion,
  overlapsPowerOfTwoTailBlock,
  rangesOverlap,
  resizeRom,
} from "./payload-placement.js";
import {
  applyPatchHeaderMarker,
  hasBatterylessPatch,
  hasFlashSaveType,
  makePatchHeaderFlags,
  PATCH_SAVE_MEDIUM,
  readPatchFlags,
  readPatchHeaderSaveSize,
} from "./patch-state.js";
import { containsBatterylessSignature, findSaveType, patchSramBytes } from "./sram.js";
import * as FLASH512K_DATA from "./flash512k-data.js";
import {
  addFlash512kOperation,
  applyFlash512kDetectedHooks,
  detectFlash512kHookSet,
  flash512kTargetAddress,
  inspectInstalledFlash512kPayload,
  logicalFlash512kSaveSize,
  validateFlash512kPayloadDescriptor,
} from "./flash512k-common.js";


const C = FLASH512K_DATA.FLASH512K_CONSTANTS;
const PAYLOAD = hexToBytes(FLASH512K_DATA.FLASH512K_PAYLOAD_HEX);
const SIGNATURE = hexToBytes(FLASH512K_DATA.FLASH512K_SIGNATURE_HEX);
const FLASH1M_MARKER = asciiBytes("FLASH1M_");
const JOURNAL_RESERVED_SIZE = 0x40000;
const JOURNAL_ACTIVE_SIZE = 0x10000;
const FLASH1M_BANK_SELECT_ROM_OFFSET = 0x01000000;
const DEFAULT_COUNTDOWN_FRAMES = 100;
const INDICATOR_MODE_VALUES = { off: 0, countdown: 1, save: 2 };


function requiredConstant(...names) {
  for (const name of names) {
    if (Number.isInteger(C?.[name])) return C[name];
  }
  throw new Error(`512K FLASH payload constant is missing (${names.join(" / ")}).`);
}

const ABI = {
  gbaRomBase: requiredConstant("GBA_ROM_BASE"),
  payloadSize: requiredConstant("FLASH512K_PAYLOAD_SIZE"),
  signatureOffset: requiredConstant("FLASH512K_SIGNATURE_OFFSET"),
  journalBaseConfigOffset: requiredConstant("FLASH512K_BASE_CONFIG_OFFSET"),
  logicalSaveSizeConfigOffset: requiredConstant("FLASH512K_LOGICAL_SIZE_CONFIG_OFFSET"),
  layoutConfigOffset: requiredConstant("FLASH512K_LAYOUT_CONFIG_OFFSET"),
  countdownConfigOffset: requiredConstant("FLASH512K_COUNTDOWN_CONFIG_OFFSET"),
  indicatorConfigOffset: requiredConstant("FLASH512K_INDICATOR_CONFIG_OFFSET"),
  flushEntry: requiredConstant("FLASH512K_FLUSH_ENTRY"),
};

const DESCRIPTOR = {
  payload: PAYLOAD,
  signature: SIGNATURE,
  payloadSize: ABI.payloadSize,
  signatureOffset: ABI.signatureOffset,
  gbaRomBase: ABI.gbaRomBase,
  eepromMetaOffset: null,
  mutableRanges: [
    [ABI.journalBaseConfigOffset, ABI.journalBaseConfigOffset + 4],
    [ABI.logicalSaveSizeConfigOffset, ABI.logicalSaveSizeConfigOffset + 4],
    [ABI.layoutConfigOffset, ABI.layoutConfigOffset + 4],
    [ABI.countdownConfigOffset, ABI.countdownConfigOffset + 4],
    [ABI.indicatorConfigOffset, ABI.indicatorConfigOffset + 4],
  ],
  entries: {
    sramWrite: requiredConstant("FLASH512K_WRITE_SRAM_ENTRY"),
    eepromWrite: requiredConstant("FLASH512K_WRITE_EEPROM_ENTRY"),
    sramRead: requiredConstant("FLASH512K_READ_SRAM_ENTRY"),
    eepromRead: requiredConstant("FLASH512K_READ_EEPROM_ENTRY"),
    sramVerify: requiredConstant("FLASH512K_VERIFY_SRAM_ENTRY"),
    eepromVerify: requiredConstant("FLASH512K_VERIFY_EEPROM_ENTRY"),
  },
};

validateFlash512kPayloadDescriptor(DESCRIPTOR, "512K FLASH");
if (requiredConstant("FLASH512K_ACTIVE_SIZE") !== JOURNAL_ACTIVE_SIZE) {
  throw new Error("512K FLASH active-size ABI does not match the host layout.");
}
if (requiredConstant("FLASH512K_RESERVED_SIZE") !== JOURNAL_RESERVED_SIZE) {
  throw new Error("512K FLASH reserved-size ABI does not match the host layout.");
}


function normalizeCountdownFrames(value) {
  const countdown = value ?? DEFAULT_COUNTDOWN_FRAMES;
  if (!Number.isInteger(countdown) || countdown < 1 || countdown > 255) {
    throw new PatchError("512K FLASH: delay value must be an integer between 1 and 255.");
  }
  return countdown;
}

function normalizeIndicatorMode(value) {
  const mode = value ?? "save";
  if (!(mode in INDICATOR_MODE_VALUES)) throw new PatchError("512K FLASH: unknown indicator mode.");
  return mode;
}

function lastNonEmptyBlockStart(bytes) {
  let blockStart = alignDown(Math.max(0, bytes.length - 1), PATCH_BLOCK_ALIGNMENT);
  while (blockStart >= 0) {
    const blockEnd = Math.min(blockStart + PATCH_BLOCK_ALIGNMENT, bytes.length);
    for (let offset = blockStart; offset < blockEnd; offset += 1) {
      if (bytes[offset] !== 0x00 && bytes[offset] !== 0xff) return blockStart;
    }
    blockStart -= PATCH_BLOCK_ALIGNMENT;
  }
  return null;
}

function journalRangeHitsFlash1mBankSelect(journalOffset) {
  return journalOffset <= FLASH1M_BANK_SELECT_ROM_OFFSET
    && FLASH1M_BANK_SELECT_ROM_OFFSET < journalOffset + JOURNAL_RESERVED_SIZE;
}

/**
 * Locate a payload tail followed immediately by its complete 256 KiB journal
 * reservation. The returned offsets are ROM file offsets, not CPU addresses.
 */
export function findFlash512kRegion(bytes, payloadSize = PAYLOAD.length, addonPrefixSize = 0, placementExcludedRanges = [], keepLastBlockEmpty = false) {
  if (
    payloadSize <= 0
    || payloadSize % 4 !== 0
    || !Number.isInteger(addonPrefixSize)
    || addonPrefixSize < 0
    || addonPrefixSize % 4 !== 0
    || payloadSize + addonPrefixSize > PATCH_BLOCK_ALIGNMENT
  ) return null;
  if (!Array.isArray(placementExcludedRanges)) return null;
  const firstBlock = lastNonEmptyBlockStart(bytes);
  if (firstBlock === null) return null;

  for (
    let blockStart = firstBlock;
    blockStart + PATCH_BLOCK_ALIGNMENT + JOURNAL_RESERVED_SIZE <= bytes.length;
    blockStart += PATCH_BLOCK_ALIGNMENT
  ) {
    const blockEnd = blockStart + PATCH_BLOCK_ALIGNMENT;
    const payloadBase = blockEnd - payloadSize;
    const addonPrefixBase = payloadBase - addonPrefixSize;
    const journalOffset = blockEnd;
    if (addonPrefixBase < blockStart || payloadBase % 4 !== 0) continue;
    if (journalRangeHitsFlash1mBankSelect(journalOffset)) continue;
    if (
      keepLastBlockEmpty
      && overlapsPowerOfTwoTailBlock(addonPrefixBase, journalOffset + JOURNAL_RESERVED_SIZE, PATCH_BLOCK_ALIGNMENT)
    ) continue;
    if (rangesOverlap(addonPrefixBase, payloadBase, placementExcludedRanges)) continue;
    if (rangesOverlap(payloadBase, blockEnd, placementExcludedRanges)) continue;
    if (rangesOverlap(journalOffset, journalOffset + JOURNAL_ACTIVE_SIZE, placementExcludedRanges)) continue;
    if (addonPrefixSize && !isFreeRegion(bytes, addonPrefixBase, addonPrefixSize)) continue;
    if (!isFreeRegion(bytes, payloadBase, payloadSize)) continue;
    if (!isFreeRegion(bytes, journalOffset, JOURNAL_RESERVED_SIZE)) continue;
    return {
      payloadBase,
      addonPrefixBase,
      addonPrefixSize,
      journalOffset,
      reservedRange: [journalOffset, journalOffset + JOURNAL_RESERVED_SIZE],
    };
  }
  return null;
}

function ensureFlash512kRegion(rom, operations, warnings, addonPrefixSize = 0, placementExcludedRanges = [], keepLastBlockEmpty = false) {
  while (true) {
    if (rom.bytes.length > GBA_MAX_ROM_SIZE) {
      warnings.push("512K FLASH: ROM is larger than 32 MiB.");
      return null;
    }
    const region = findFlash512kRegion(rom.bytes, PAYLOAD.length, addonPrefixSize, placementExcludedRanges, keepLastBlockEmpty);
    if (region !== null) return region;
    if (rom.bytes.length >= GBA_MAX_ROM_SIZE) {
      warnings.push("512K FLASH: no free payload-plus-reserve area and ROM is already 32 MiB.");
      return null;
    }

    const oldSize = rom.bytes.length;
    const newSize = Math.min(alignUp(oldSize, PATCH_BLOCK_ALIGNMENT) + PATCH_BLOCK_ALIGNMENT, GBA_MAX_ROM_SIZE);
    if (newSize <= oldSize) {
      warnings.push("512K FLASH: ROM could not be expanded.");
      return null;
    }
    resizeRom(rom, newSize, 0xff);
    addFlash512kOperation(operations, "512K FLASH ROM expansion", oldSize, newSize - oldSize, { value: newSize });
  }
}

function familyConfig(family) {
  if (family === "sram") return { logicalSaveSize: 32768, layout: 0 };
  if (family === "eeprom") return { logicalSaveSize: 8192, layout: 1 };
  throw new PatchError(`512K FLASH: unsupported hook family ${family}.`);
}

function configurePayload(payloadBase, journalOffset, family, countdownFrames, indicatorMode) {
  const payload = new Uint8Array(PAYLOAD);
  const config = familyConfig(family);
  writeU32(payload, ABI.journalBaseConfigOffset, journalOffset >>> 0);
  writeU32(payload, ABI.logicalSaveSizeConfigOffset, config.logicalSaveSize >>> 0);
  writeU32(payload, ABI.layoutConfigOffset, config.layout >>> 0);
  writeU32(payload, ABI.countdownConfigOffset, countdownFrames >>> 0);
  writeU32(payload, ABI.indicatorConfigOffset, INDICATOR_MODE_VALUES[indicatorMode] >>> 0);
  return { payload, ...config, payloadBase, journalOffset };
}

function installedJournalDetails(bytes, installed) {
  const payloadBase = installed.payloadBase;
  const journalOffset = payloadBase + PAYLOAD.length;
  const expected = familyConfig(installed.family);
  if (journalOffset % PATCH_BLOCK_ALIGNMENT !== 0) {
    throw new PatchError("512K FLASH payload is not installed at a 256 KiB block end.");
  }
  if (journalRangeHitsFlash1mBankSelect(journalOffset)) {
    throw new PatchError("512K FLASH reserve overlaps the FLASH1M bank-select ROM offset.");
  }
  if (journalOffset + JOURNAL_RESERVED_SIZE > bytes.length) {
    throw new PatchError("512K FLASH reserve is truncated.");
  }
  for (let offset = journalOffset + JOURNAL_ACTIVE_SIZE; offset < journalOffset + JOURNAL_RESERVED_SIZE; offset += 1) {
    if (bytes[offset] !== 0xff) {
      throw new PatchError("512K FLASH unused reserve tail is no longer empty.");
    }
  }
  if (readU32(bytes, payloadBase + ABI.journalBaseConfigOffset) !== (journalOffset >>> 0)) {
    throw new PatchError("512K FLASH base configuration is damaged.");
  }
  if (readU32(bytes, payloadBase + ABI.logicalSaveSizeConfigOffset) !== expected.logicalSaveSize) {
    throw new PatchError("512K FLASH save-size configuration is damaged.");
  }
  if (readU32(bytes, payloadBase + ABI.layoutConfigOffset) !== expected.layout) {
    throw new PatchError("512K FLASH save-layout configuration is damaged.");
  }
  const countdownFrames = readU32(bytes, payloadBase + ABI.countdownConfigOffset);
  if (countdownFrames < 1 || countdownFrames > 255) {
    throw new PatchError("512K FLASH countdown configuration is damaged.");
  }
  const indicatorValue = readU32(bytes, payloadBase + ABI.indicatorConfigOffset);
  const indicatorMode = Object.keys(INDICATOR_MODE_VALUES).find((key) => INDICATOR_MODE_VALUES[key] === indicatorValue);
  if (!indicatorMode) throw new PatchError("512K FLASH indicator configuration is damaged.");
  return { journalOffset, countdownFrames, indicatorMode, ...expected };
}

function makeJournalMetadata(payloadBase, family, counts, config, status) {
  const flushEntry = flash512kTargetAddress(payloadBase, ABI.flushEntry, ABI.gbaRomBase);
  const reservedRange = [config.journalOffset, config.journalOffset + JOURNAL_RESERVED_SIZE];
  const runtimeWriteRange = [config.journalOffset, config.journalOffset + JOURNAL_ACTIVE_SIZE];
  return {
    requested: true,
    status,
    variant: "patched",
    family,
    payload_offset: payloadBase,
    payload_size: PAYLOAD.length,
    hook_counts: counts,
    journal: {
      offset: config.journalOffset,
      reserved_size: JOURNAL_RESERVED_SIZE,
      active_size: JOURNAL_ACTIVE_SIZE,
      // The remainder of the reservation must stay erased for validation,
      // but is not modified by the runtime.
      runtime_write_ranges: [runtimeWriteRange],
      countdown_frames: config.countdownFrames,
      indicator_mode: config.indicatorMode,
      flush_entry: flushEntry,
      reserved_ranges: [reservedRange],
    },
  };
}

function baseResult(bytes, saveType, status, operations = [], warnings = [], flash512k = null, reservedRanges = []) {
  return {
    bytes,
    result: {
      mode: "flash512k",
      status,
      save_type: saveType,
      source_save_type: saveType,
      target_save_type: "FLASH512",
      logical_save_size: logicalFlash512kSaveSize(saveType, flash512k?.family),
      flash512k,
      reserved_ranges: reservedRanges,
      operations,
      warnings,
    },
  };
}

export function patchFlash512kBytes(inputBytes, options = {}) {
  const input = new Uint8Array(inputBytes);
  if (input.length < 0xc0 || input[0xb2] !== 0x96) throw new PatchError("Invalid GBA header.");
  if (input.length > GBA_MAX_ROM_SIZE) throw new PatchError("512K FLASH: ROM is larger than 32 MiB.");
  const countdownFrames = normalizeCountdownFrames(options.countdownFrames);
  const indicatorMode = normalizeIndicatorMode(options.indicatorMode);
  const addonPrefixSize = options.addonPrefixSize ?? 0;
  if (!Number.isInteger(addonPrefixSize) || addonPrefixSize < 0 || addonPrefixSize % 4 !== 0) {
    throw new PatchError("512K FLASH: add-on prefix size must be a non-negative 4-byte multiple.");
  }
  if (addonPrefixSize + PAYLOAD.length > PATCH_BLOCK_ALIGNMENT) {
    throw new PatchError("512K FLASH: add-on prefix and payload do not fit in one 256 KiB code block.");
  }
  const placementExcludedRanges = options.placementExcludedRanges ?? [];
  if (!Array.isArray(placementExcludedRanges)) {
    throw new PatchError("512K FLASH: placement exclusions must be an array of ranges.");
  }
  const keepLastBlockEmpty = options.keepLastBlockEmpty === true;

  const sourceSaveType = findSaveType(input);
  const existingFlags = readPatchFlags(input);
  const installed = inspectInstalledFlash512kPayload(input, DESCRIPTOR, "512K FLASH");
  if (installed) {
    const config = installedJournalDetails(input, installed);
    const bytes = new Uint8Array(input);
    const operations = [];
    const flash512k = makeJournalMetadata(installed.payloadBase, installed.family, installed.counts, config, "already_patched");
    if (!options.deferHeaderFinalization) {
      const headerFlags = makePatchHeaderFlags(bytes, {
        saveMedium: PATCH_SAVE_MEDIUM.FLASH,
        saveSize: 65536,
        batteryless: false,
      });
      applyPatchHeaderMarker(bytes, operations, headerFlags);
    }
    const status = operations.length ? "patched" : "already_patched";
    flash512k.status = status;
    return baseResult(
      bytes,
      sourceSaveType,
      status,
      operations,
      [],
      flash512k,
      flash512k.journal.reserved_ranges,
    );
  }
  if (hasFlashSaveType(existingFlags)) throw new PatchError("FLASH save-type header marker exists, but no coherent 512K FLASH payload could be validated.");
  if (hasBatterylessPatch(existingFlags) || containsBatterylessSignature(input)) {
    throw new PatchError("512K FLASH cannot be applied to a Batteryless SRAM patched ROM.");
  }
  if (findBytes(input, FLASH1M_MARKER) >= 0 || sourceSaveType?.startsWith("FLASH1M") || readPatchHeaderSaveSize(existingFlags) === 131072) {
    throw new PatchError("512K FLASH is incompatible with 1M FLASH / 128 KiB save games.");
  }
  if (sourceSaveType?.startsWith("FLASH512") || sourceSaveType?.startsWith("FLASH_")) {
    const flash512k = {
      requested: true,
      status: "already_compatible",
      variant: "native",
      family: "flash",
      payload_offset: null,
      payload_size: 0,
      hook_counts: {},
      journal: null,
    };
    return baseResult(new Uint8Array(input), sourceSaveType, "already_compatible", [], [], flash512k);
  }
  if (!sourceSaveType || (!sourceSaveType.startsWith("SRAM") && !sourceSaveType.startsWith("EEPROM"))) {
    throw new PatchError(
      sourceSaveType
        ? `${sourceSaveType} is not supported by 512K FLASH.`
        : "512K FLASH could not detect a supported SRAM or EEPROM save type.",
    );
  }

  const normalized = patchSramBytes(input, {
    batteryless: false,
    waitstate: { enabled: false },
    rtc: { enabled: false },
    deferHeaderFinalization: true,
  });
  if (normalized.result.status === "unsupported") {
    throw new PatchError(normalized.result.warnings?.[0] || `${sourceSaveType} could not be normalized to SRAM.`);
  }

  // EEPROM normalization deliberately yields stable SRAM-like Write/Read
  // wrappers. Some SDK versions (including EEPROM_V124) no longer retain an
  // IdentifyEeprom marker here, so the runtime uses the fixed 8 KiB native
  // EEPROM-file layout instead of requiring an otherwise unused metadata hook.
  const hooks = detectFlash512kHookSet(normalized.bytes, "512K FLASH");
  const rom = { bytes: normalized.bytes };
  const operations = [...(normalized.result.operations || [])];
  const warnings = [...(normalized.result.warnings || [])];
  const region = ensureFlash512kRegion(rom, operations, warnings, addonPrefixSize, placementExcludedRanges, keepLastBlockEmpty);
  if (region === null) throw new PatchError(warnings.find((warning) => warning.startsWith("512K FLASH:")) || "512K FLASH payload could not be placed.");

  const configured = configurePayload(
    region.payloadBase,
    region.journalOffset,
    hooks.family,
    countdownFrames,
    indicatorMode,
  );
  rom.bytes.fill(0xff, region.journalOffset, region.journalOffset + JOURNAL_RESERVED_SIZE);
  addFlash512kOperation(
    operations,
    "512K FLASH reserve initialized",
    region.journalOffset,
    JOURNAL_RESERVED_SIZE,
    { value: 0xff, codeName: "flash512k_reserve" },
  );
  copyBytes(rom.bytes, region.payloadBase, configured.payload);
  addFlash512kOperation(
    operations,
    "512K FLASH payload",
    region.payloadBase,
    configured.payload.length,
    { codeName: "flash512k_payload" },
  );
  const hookCounts = applyFlash512kDetectedHooks(
    rom.bytes,
    operations,
    hooks,
    region.payloadBase,
    DESCRIPTOR,
    "512K FLASH",
  );
  const flash512k = makeJournalMetadata(
    region.payloadBase,
    hooks.family,
    hookCounts,
    { ...configured, countdownFrames, indicatorMode },
    "patched",
  );
  if (!options.deferHeaderFinalization) {
    const headerFlags = makePatchHeaderFlags(rom.bytes, {
      saveMedium: PATCH_SAVE_MEDIUM.FLASH,
      saveSize: 65536,
      batteryless: false,
    });
    applyPatchHeaderMarker(rom.bytes, operations, headerFlags);
  }

  return baseResult(
    rom.bytes,
    sourceSaveType,
    "patched",
    operations,
    warnings,
    flash512k,
    flash512k.journal.reserved_ranges,
  );
}

export const FLASH512K_LAYOUT = Object.freeze({
  block_size: PATCH_BLOCK_ALIGNMENT,
  payload_size: PAYLOAD.length,
  reserved_size: JOURNAL_RESERVED_SIZE,
  active_size: JOURNAL_ACTIVE_SIZE,
  flash1m_bank_select_offset: FLASH1M_BANK_SELECT_ROM_OFFSET,
});
