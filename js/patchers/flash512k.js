// SPDX-License-Identifier: GPL-3.0-or-later AND MIT

import {
  asciiBytes,
  findBytes,
  hexToBytes,
  writeU32,
} from "../core/binary.js";
import { PatchError } from "../core/errors.js";
import { PATCH_OPERATION_KIND } from "../domain/constants.js";
import { stagePatchOperation, stageRomExpansion } from "../patch-engine/draft.js";
import {
  GBA_MAX_ROM_SIZE,
  PATCH_BLOCK_ALIGNMENT,
  alignDown,
  alignUp,
  isFreeRegion,
  normalizeExcludedRanges,
  overlapsPowerOfTwoTailBlock,
  rangesOverlap,
} from "./payload-placement.js";
import {
  applyPatchHeaderMarker,
  makePatchHeaderFlags,
  PATCH_SAVE_MEDIUM,
} from "./patch-state.js";
import { findSaveType, patchSramBytes } from "./sram.js";
import { findStartupRomCopySourceRanges } from "./startup-rom-copy-ranges.js";
import * as FLASH512K_DATA from "./flash512k-data.js";
import {
  applyFlash512kDetectedHooks,
  DIRECT_SRAM_SAVE_TYPES,
  detectFlash512kDirectSramHookSet,
  detectFlash512kHookSet,
  detectFlash512kEepromV11xHookSet,
  flash512kTargetAddress,
  logicalFlash512kSaveSize,
  validateFlash512kPayloadDescriptor,
} from "./flash512k-common.js";


const C = FLASH512K_DATA.FLASH512K_CONSTANTS;
const PAYLOAD = hexToBytes(FLASH512K_DATA.FLASH512K_PAYLOAD_HEX);
const SIGNATURE = hexToBytes(FLASH512K_DATA.FLASH512K_SIGNATURE_HEX);
const FLASH1M_MARKER = asciiBytes("FLASH1M_");
const JOURNAL_RESERVED_SIZE = requiredConstant("FLASH512K_RESERVED_SIZE");
const JOURNAL_ACTIVE_SIZE = requiredConstant("FLASH512K_ACTIVE_SIZE");
const FLASH1M_BANK_SELECT_ROM_OFFSET = 0x01000000;
const DEFAULT_COUNTDOWN_FRAMES = requiredConstant("FLASH512K_DEFAULT_COUNTDOWN");
const INDICATOR_MODE_VALUES = { off: 0, countdown: 1, save: 2 };
const DIRECT_EEPROM_SAVE_TYPES = new Set(["EEPROM_V110", "EEPROM_V111"]);

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
  rtcPersistEntryConfigOffset: requiredConstant("FLASH512K_RTC_PERSIST_ENTRY_CONFIG_OFFSET"),
  flushEntry: requiredConstant("FLASH512K_FLUSH_ENTRY"),
};

export function defineJournalDescriptor(rawData, spec = {}) {
  const constants = rawData.FLASH512K_CONSTANTS;
  const required = (...names) => {
    for (const name of names) if (Number.isInteger(constants?.[name])) return constants[name];
    throw new Error(`${spec.label || "Journal"} payload constant is missing (${names.join(" / ")}).`);
  };
  const requiredText = (name) => {
    if (typeof constants?.[name] === "string" && constants[name].length > 0) return constants[name];
    throw new Error(`${spec.label || "Journal"} payload constant is missing (${name}).`);
  };
  const generatedId = requiredText("JOURNAL_VARIANT_ID");
  if (spec.id !== undefined && spec.id !== generatedId) {
    throw new Error(`${spec.label || "Journal"} payload ID does not match its generated ABI.`);
  }
  const payload = hexToBytes(rawData.FLASH512K_PAYLOAD_HEX);
  const signature = hexToBytes(rawData.FLASH512K_SIGNATURE_HEX);
  const configFields = {
    journalBase: required("FLASH512K_BASE_CONFIG_OFFSET"),
    logicalSaveSize: required("FLASH512K_LOGICAL_SIZE_CONFIG_OFFSET"),
    layout: required("FLASH512K_LAYOUT_CONFIG_OFFSET"),
    countdown: required("FLASH512K_COUNTDOWN_CONFIG_OFFSET"),
    indicator: required("FLASH512K_INDICATOR_CONFIG_OFFSET"),
    rtcPersistEntry: required("FLASH512K_RTC_PERSIST_ENTRY_CONFIG_OFFSET"),
  };
  if (Number.isInteger(constants.FLASH512K_SAVE_CHIP_TYPE_CONFIG_OFFSET)) {
    configFields.saveChipType = constants.FLASH512K_SAVE_CHIP_TYPE_CONFIG_OFFSET;
  }
  const descriptor = {
    id: generatedId,
    label: spec.label ?? "Journal",
    abiVersion: required("JOURNAL_ABI_VERSION"),
    payload,
    signature,
    payloadSize: required("FLASH512K_PAYLOAD_SIZE"),
    signatureOffset: required("FLASH512K_SIGNATURE_OFFSET"),
    gbaRomBase: required("GBA_ROM_BASE"),
    eepromMetaOffset: null,
    configFields,
    mutableRanges: Object.values(configFields).map((offset) => [offset, offset + 4]),
    entries: {
      sramWrite: required("FLASH512K_WRITE_SRAM_ENTRY"),
      eepromWrite: required("FLASH512K_WRITE_EEPROM_ENTRY"),
      eepromWriteCompat: required("FLASH512K_WRITE_EEPROM_COMPAT_ENTRY"),
      eepromWriteDirect: required("FLASH512K_WRITE_EEPROM_DIRECT_ENTRY"),
      sramRead: required("FLASH512K_READ_SRAM_ENTRY"),
      eepromRead: required("FLASH512K_READ_EEPROM_ENTRY"),
      sramVerify: required("FLASH512K_VERIFY_SRAM_ENTRY"),
      eepromVerify: required("FLASH512K_VERIFY_EEPROM_ENTRY"),
      flush: required("FLASH512K_FLUSH_ENTRY"),
    },
    families: {
      sram: { logicalSaveSize: 0x8000, layout: 0 },
      eeprom: { logicalSaveSize: 0x2000, layout: 1 },
    },
    placement: {
      blockSize: PATCH_BLOCK_ALIGNMENT,
      activeSize: required("FLASH512K_ACTIVE_SIZE"),
      reservedSize: required("FLASH512K_RESERVED_SIZE"),
      forbiddenRomOffsets: [FLASH1M_BANK_SELECT_ROM_OFFSET],
      maxRomSize: GBA_MAX_ROM_SIZE,
    },
    target: { medium: "flash", saveType: "FLASH512", saveSize: 0x10000, bankSwitch: false },
  };
  validateFlash512kPayloadDescriptor(descriptor, descriptor.label);
  if (descriptor.target?.bankSwitch !== false) throw new Error(`${descriptor.label} must disable bank switching.`);
  return Object.freeze(descriptor);
}

export const STANDARD_JOURNAL_DESCRIPTOR = defineJournalDescriptor(FLASH512K_DATA, {
  id: "standard-journal-v2",
  label: "512K FLASH",
});

const DESCRIPTOR = STANDARD_JOURNAL_DESCRIPTOR;

validateFlash512kPayloadDescriptor(DESCRIPTOR, "512K FLASH");


function normalizeCountdownFrames(value, label = "512K FLASH") {
  const countdown = value ?? DEFAULT_COUNTDOWN_FRAMES;
  if (!Number.isInteger(countdown) || countdown < 1 || countdown > 255) {
    throw new PatchError(`${label}: delay value must be an integer between 1 and 255.`);
  }
  return countdown;
}

function normalizeIndicatorMode(value, label = "512K FLASH") {
  const mode = value ?? "save";
  if (!(mode in INDICATOR_MODE_VALUES)) throw new PatchError(`${label}: unknown indicator mode.`);
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

/**
 * Locate a payload tail followed immediately by its complete 256 KiB journal
 * reservation. The returned offsets are ROM file offsets, not CPU addresses.
 */
export function findJournalRegion(bytes, descriptor, {
  addonPrefixSize = 0,
  placementExcludedRanges = [],
  keepLastBlockEmpty = false,
} = {}) {
  const payloadSize = descriptor.payloadSize;
  const reservedSize = descriptor.placement.reservedSize;
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
    blockStart + PATCH_BLOCK_ALIGNMENT + reservedSize <= bytes.length;
    blockStart += PATCH_BLOCK_ALIGNMENT
  ) {
    const blockEnd = blockStart + PATCH_BLOCK_ALIGNMENT;
    const payloadBase = blockEnd - payloadSize;
    const addonPrefixBase = payloadBase - addonPrefixSize;
    const journalOffset = blockEnd;
    if (addonPrefixBase < blockStart || payloadBase % 4 !== 0) continue;
    if (descriptor.placement.forbiddenRomOffsets.some(
      (offset) => journalOffset <= offset && offset < journalOffset + reservedSize
    )) continue;
    if (
      keepLastBlockEmpty
      && overlapsPowerOfTwoTailBlock(addonPrefixBase, journalOffset + reservedSize, PATCH_BLOCK_ALIGNMENT)
    ) continue;
    if (rangesOverlap(addonPrefixBase, payloadBase, placementExcludedRanges)) continue;
    if (rangesOverlap(payloadBase, blockEnd, placementExcludedRanges)) continue;
    if (rangesOverlap(journalOffset, journalOffset + reservedSize, placementExcludedRanges)) continue;
    if (addonPrefixSize && !isFreeRegion(bytes, addonPrefixBase, addonPrefixSize)) continue;
    if (!isFreeRegion(bytes, payloadBase, payloadSize)) continue;
    if (!isFreeRegion(bytes, journalOffset, reservedSize)) continue;
    return {
      payloadBase,
      addonPrefixBase,
      addonPrefixSize,
      journalOffset,
      reservedRange: [journalOffset, journalOffset + reservedSize],
    };
  }
  return null;
}

function ensureJournalRegion(rom, operations, warnings, descriptor, addonPrefixSize = 0, placementExcludedRanges = [], keepLastBlockEmpty = false) {
  while (true) {
    if (rom.bytes.length > GBA_MAX_ROM_SIZE) {
      warnings.push(`${descriptor.label}: ROM is larger than 32 MiB.`);
      return null;
    }
    const region = findJournalRegion(rom.bytes, descriptor, { addonPrefixSize, placementExcludedRanges, keepLastBlockEmpty });
    if (region !== null) return region;
    if (rom.bytes.length >= GBA_MAX_ROM_SIZE) {
      warnings.push(`${descriptor.label}: no free payload-plus-reserve area and ROM is already 32 MiB.`);
      return null;
    }

    const oldSize = rom.bytes.length;
    const newSize = Math.min(alignUp(oldSize, PATCH_BLOCK_ALIGNMENT) + PATCH_BLOCK_ALIGNMENT, GBA_MAX_ROM_SIZE);
    if (newSize <= oldSize) {
      warnings.push(`${descriptor.label}: ROM could not be expanded.`);
      return null;
    }
    const byteLength = newSize - oldSize;
    const erasedBytes = new Uint8Array(byteLength).fill(0xff);
    stageRomExpansion(rom, operations, {
      id: `flash-journal-expand-${operations.length}`,
      kind: PATCH_OPERATION_KIND.ROM_EXPAND,
      component: "flashJournal",
      offset: oldSize,
      byteLength,
      expectedBefore: erasedBytes,
      replacement: new Uint8Array(erasedBytes),
      labelKey: "operation.romExpand",
      metadata: {
        name: `${descriptor.label} ROM expansion`,
        value: newSize,
      },
    });
  }
}

function familyConfig(family, descriptor = DESCRIPTOR) {
  if (descriptor.families?.[family]) return descriptor.families[family];
  throw new PatchError(`512K FLASH: unsupported hook family ${family}.`);
}

function configurePayload(payloadBase, journalOffset, family, countdownFrames, indicatorMode, descriptor, saveChipType = null) {
  const payload = new Uint8Array(descriptor.payload);
  const config = familyConfig(family, descriptor);
  const fields = descriptor.configFields;
  writeU32(payload, fields.journalBase, journalOffset >>> 0);
  writeU32(payload, fields.logicalSaveSize, config.logicalSaveSize >>> 0);
  writeU32(payload, fields.layout, config.layout >>> 0);
  writeU32(payload, fields.countdown, countdownFrames >>> 0);
  writeU32(payload, fields.indicator, INDICATOR_MODE_VALUES[indicatorMode] >>> 0);
  writeU32(payload, fields.rtcPersistEntry, 0);
  if (Number.isInteger(fields.saveChipType)) writeU32(payload, fields.saveChipType, saveChipType >>> 0);
  return {
    payload,
    ...config,
    payloadBase,
    journalOffset,
    saveChipType: Number.isInteger(fields.saveChipType) ? saveChipType : null,
  };
}

function makeJournalMetadata(payloadBase, family, counts, config, status, descriptor = DESCRIPTOR) {
  const flushEntry = flash512kTargetAddress(payloadBase, descriptor.entries.flush, descriptor.gbaRomBase);
  const reservedRange = [config.journalOffset, config.journalOffset + descriptor.placement.reservedSize];
  const runtimeWriteRange = [config.journalOffset, config.journalOffset + descriptor.placement.activeSize];
  const rtcPersistEntryConfigOffset = payloadBase + descriptor.configFields.rtcPersistEntry;
  return {
    requested: true,
    status,
    variantId: descriptor.id,
    variant: "patched",
    family,
    payloadOffset: payloadBase,
    payloadSize: descriptor.payloadSize,
    hookCounts: counts,
    journal: {
      offset: config.journalOffset,
      reservedSize: descriptor.placement.reservedSize,
      activeSize: descriptor.placement.activeSize,
      // The inactive remainder stays erased in the ROM image. Fake-RTC may
      // later own the complete reserve and place its record at the tail.
      runtimeWriteRanges: [runtimeWriteRange],
      countdownFrames: config.countdownFrames,
      indicatorMode: config.indicatorMode,
      flushEntry,
      rtcPersistEntry: 0,
      rtcPersistEntryConfigOffset,
      reservedRanges: [reservedRange],
    },
    config: {
      ...(Number.isInteger(config.saveChipType) ? { saveChipType: config.saveChipType } : {}),
      rtcPersistEntry: 0,
      rtcPersistEntryConfigOffset,
      rtcPersistEntryPayloadOffset: descriptor.configFields.rtcPersistEntry,
    },
  };
}

/**
 * Configure an already staged Standard or Custom Journal payload after the
 * Fake-RTC payload address is known. stagePatchOperation declares the overlap
 * with the earlier whole-payload install and uses the current staged bytes as
 * this operation's preimage.
 */
export function patchInstalledJournalRtcPersistEntry(
  bytes,
  operations,
  journalPatch,
  rtcPersistEntry,
) {
  if (!(bytes instanceof Uint8Array) || !Array.isArray(operations)) {
    throw new TypeError("Journal RTC persistence patching requires ROM bytes and an operation array.");
  }
  const payloadOffset = journalPatch?.payloadOffset;
  const payloadSize = journalPatch?.payloadSize;
  const configOffset = journalPatch?.config?.rtcPersistEntryConfigOffset
    ?? journalPatch?.journal?.rtcPersistEntryConfigOffset;
  if (
    !Number.isSafeInteger(payloadOffset)
    || !Number.isSafeInteger(payloadSize)
    || payloadSize <= 0
    || !Number.isSafeInteger(configOffset)
    || configOffset < payloadOffset
    || configOffset + 4 > payloadOffset + payloadSize
    || configOffset + 4 > bytes.length
  ) {
    throw new PatchError("Journal RTC persistence config is outside the installed payload.");
  }
  if (
    !Number.isSafeInteger(rtcPersistEntry)
    || rtcPersistEntry < 0
    || rtcPersistEntry > 0xffffffff
    || (rtcPersistEntry !== 0 && (
      (rtcPersistEntry & 1) !== 1
      || rtcPersistEntry - 1 < ABI.gbaRomBase
      || rtcPersistEntry - 1 >= ABI.gbaRomBase + GBA_MAX_ROM_SIZE
    ))
  ) {
    throw new PatchError("Journal RTC persistence entry is not a valid Thumb ROM address.");
  }

  const replacement = new Uint8Array(4);
  writeU32(replacement, 0, rtcPersistEntry >>> 0);
  const operation = stagePatchOperation(bytes, operations, {
    id: `flash-journal-${operations.length}`,
    kind: PATCH_OPERATION_KIND.CONFIG_WRITE,
    component: "flashJournal",
    offset: configOffset,
    byteLength: replacement.length,
    expectedBefore: bytes.slice(configOffset, configOffset + replacement.length),
    replacement,
    labelKey: "operation.flashJournal",
    metadata: {
      name: "Journal RTC persistence entry",
      value: rtcPersistEntry >>> 0,
      codeName: "journal_rtc_persist_entry",
      configOffset: configOffset - payloadOffset,
    },
  });

  journalPatch.config = {
    ...(journalPatch.config || {}),
    rtcPersistEntry: rtcPersistEntry >>> 0,
    rtcPersistEntryConfigOffset: configOffset,
  };
  if (journalPatch.journal) {
    journalPatch.journal.rtcPersistEntry = rtcPersistEntry >>> 0;
    journalPatch.journal.rtcPersistEntryConfigOffset = configOffset;
    const journalOffset = journalPatch.journal.offset;
    const runtimeSize = rtcPersistEntry
      ? journalPatch.journal.reservedSize
      : journalPatch.journal.activeSize;
    if (Number.isSafeInteger(journalOffset) && Number.isSafeInteger(runtimeSize) && runtimeSize > 0) {
      journalPatch.journal.runtimeWriteRanges = [[journalOffset, journalOffset + runtimeSize]];
    }
  }
  return {
    entry: rtcPersistEntry >>> 0,
    configOffset,
    payloadConfigOffset: configOffset - payloadOffset,
    operationId: operation.id,
  };
}

function baseResult(bytes, saveType, status, operations = [], warnings = [], journalPatch = null, reservedRanges = []) {
  return {
    bytes,
    result: {
      mode: "flash512k",
      status,
      saveType,
      sourceSaveType: saveType,
      targetSaveType: "FLASH512",
      logicalSaveSizeBytes: logicalFlash512kSaveSize(saveType, journalPatch?.family),
      targetSaveSizeBytes: 65536,
      bankSwitchMode: "none",
      flashJournal: journalPatch?.journal ? journalPatch : null,
      reservedRanges,
      operations,
      warnings,
    },
  };
}

function validatedFlashOptions(input, options) {
  const descriptor = options.descriptor || DESCRIPTOR;
  const saveChipType = options.saveChipType ?? null;
  if (Number.isInteger(descriptor.configFields.saveChipType) && ![1, 2].includes(saveChipType)) {
    throw new PatchError(`${descriptor.label}: save chip type must be integer 1 or 2.`);
  }
  if (input.length < 0xc0 || input[0xb2] !== 0x96) throw new PatchError("Invalid GBA header.");
  if (input.length > GBA_MAX_ROM_SIZE) throw new PatchError("512K FLASH: ROM is larger than 32 MiB.");
  const addonPrefixSize = options.addonPrefixSize ?? 0;
  if (!Number.isInteger(addonPrefixSize) || addonPrefixSize < 0 || addonPrefixSize % 4 !== 0) {
    throw new PatchError("512K FLASH: add-on prefix size must be a non-negative 4-byte multiple.");
  }
  if (addonPrefixSize + descriptor.payloadSize > PATCH_BLOCK_ALIGNMENT) {
    throw new PatchError("512K FLASH: add-on prefix and payload do not fit in one 256 KiB code block.");
  }
  const requestedPlacementExcludedRanges = options.placementExcludedRanges ?? [];
  if (!Array.isArray(requestedPlacementExcludedRanges)) {
    throw new PatchError("512K FLASH: placement exclusions must be an array of ranges.");
  }
  const placementExcludedRanges = normalizeExcludedRanges([
    ...requestedPlacementExcludedRanges,
    ...findStartupRomCopySourceRanges(input),
  ]);
  return {
    descriptor,
    saveChipType,
    countdownFrames: normalizeCountdownFrames(options.countdownFrames, descriptor.label),
    indicatorMode: normalizeIndicatorMode(options.indicatorMode, descriptor.label),
    addonPrefixSize,
    placementExcludedRanges,
    keepLastBlockEmpty: options.keepLastBlockEmpty === true,
  };
}

function nativeFlashResult(input, sourceSaveType) {
  const flash512k = {
    requested: true,
    status: "unchanged",
    variant: "native",
    family: "flash",
    payloadOffset: null,
    payloadSize: 0,
    hookCounts: {},
    journal: null,
  };
  return baseResult(
    new Uint8Array(input),
    sourceSaveType,
    "unchanged",
    [],
    [],
    flash512k,
  );
}

function validateFlashSource(input) {
  const sourceSaveType = findSaveType(input);
  if (findBytes(input, FLASH1M_MARKER) >= 0 || sourceSaveType?.startsWith("FLASH1M")) {
    throw new PatchError("512K FLASH is incompatible with 1M FLASH / 128 KiB save games.");
  }
  if (sourceSaveType?.startsWith("FLASH512") || sourceSaveType?.startsWith("FLASH_")) {
    return { sourceSaveType, output: nativeFlashResult(input, sourceSaveType) };
  }
  if (!sourceSaveType || (!sourceSaveType.startsWith("SRAM") && !sourceSaveType.startsWith("EEPROM"))) {
    throw new PatchError(
      sourceSaveType
        ? `${sourceSaveType} is not supported by 512K FLASH.`
        : "512K FLASH could not detect a supported SRAM or EEPROM save type.",
    );
  }
  return { sourceSaveType, output: null };
}

function normalizeFlashSource(input, sourceSaveType, descriptor) {
  if (DIRECT_EEPROM_SAVE_TYPES.has(sourceSaveType)) {
    const normalized = {
      bytes: new Uint8Array(input),
      result: { status: "patched", operations: [], warnings: [] },
    };
    return {
      normalized,
      hooks: {
        ...detectFlash512kEepromV11xHookSet(
          normalized.bytes,
          sourceSaveType,
          descriptor.label,
        ),
        sourceSaveType,
        sourceLength: normalized.bytes.length,
      },
    };
  }
  if (DIRECT_SRAM_SAVE_TYPES.has(sourceSaveType)) {
    const normalized = {
      bytes: new Uint8Array(input),
      result: { status: "patched", operations: [], warnings: [] },
    };
    return {
      normalized,
      hooks: {
        ...detectFlash512kDirectSramHookSet(
          normalized.bytes,
          sourceSaveType,
          descriptor.label,
        ),
        sourceSaveType,
        sourceLength: normalized.bytes.length,
      },
    };
  }
  const normalized = patchSramBytes(input, {
    batteryless: false,
    waitstate: { enabled: false },
    rtc: { enabled: false },
    deferHeaderFinalization: true,
  });
  if (normalized.result.status === "unsupported") {
    throw new PatchError(
      normalized.result.warnings?.[0] || `${sourceSaveType} could not be normalized to SRAM.`,
    );
  }
  return {
    normalized,
    // Some ROMs retain unused EEPROM/SRAM library fragments. The detected
    // source type identifies which normalized hook family is live, so do not
    // let remnants from the other family turn that proven choice into a
    // conflict.
    hooks: {
      ...detectFlash512kHookSet(
        normalized.bytes,
        descriptor.label,
        sourceSaveType.startsWith("EEPROM") ? "eeprom" : "sram",
      ),
      sourceSaveType,
      sourceLength: normalized.bytes.length,
    },
  };
}

function installFlashJournal(normalizedSource, config) {
  const { normalized, hooks } = normalizedSource;
  const rom = { bytes: normalized.bytes };
  const operations = [...(normalized.result.operations || [])];
  const warnings = [...(normalized.result.warnings || [])];
  const region = ensureJournalRegion(
    rom,
    operations,
    warnings,
    config.descriptor,
    config.addonPrefixSize,
    config.placementExcludedRanges,
    config.keepLastBlockEmpty,
  );
  if (region === null) {
    throw new PatchError(
      warnings.find((warning) => warning.startsWith(`${config.descriptor.label}:`))
        || `${config.descriptor.label} payload could not be placed.`,
    );
  }
  const configured = configurePayload(
    region.payloadBase,
    region.journalOffset,
    hooks.family,
    config.countdownFrames,
    config.indicatorMode,
    config.descriptor,
    config.saveChipType,
  );
  const reserveSize = config.descriptor.placement.reservedSize;
  stagePatchOperation(rom.bytes, operations, {
    id: `flash-journal-${operations.length}`,
    kind: PATCH_OPERATION_KIND.CONFIG_WRITE,
    component: "flashJournal",
    offset: region.journalOffset,
    byteLength: reserveSize,
    expectedBefore: rom.bytes.slice(region.journalOffset, region.journalOffset + reserveSize),
    replacement: new Uint8Array(reserveSize).fill(0xff),
    labelKey: "operation.flashJournal",
    metadata: {
      name: `${config.descriptor.label} reserve initialized`,
      value: 0xff,
      codeName: "journal_reserve",
    },
  });
  stagePatchOperation(rom.bytes, operations, {
    id: `flash-journal-${operations.length}`,
    kind: PATCH_OPERATION_KIND.PAYLOAD_INSTALL,
    component: "flashJournal",
    offset: region.payloadBase,
    byteLength: configured.payload.length,
    expectedBefore: rom.bytes.slice(region.payloadBase, region.payloadBase + configured.payload.length),
    replacement: configured.payload,
    labelKey: "operation.flashJournal",
    metadata: {
      name: `${config.descriptor.label} payload`,
      codeName: "journal_payload",
      variantId: config.descriptor.id,
    },
  });
  const hookCounts = applyFlash512kDetectedHooks(
    rom.bytes,
    operations,
    hooks,
    region.payloadBase,
    config.descriptor,
    config.descriptor.label,
  );
  return { rom, operations, warnings, region, configured, hooks, hookCounts };
}

function flashJournalOutput(installed, sourceSaveType, config, options) {
  const journal = makeJournalMetadata(
    installed.region.payloadBase,
    installed.hooks.family,
    installed.hookCounts,
    {
      ...installed.configured,
      countdownFrames: config.countdownFrames,
      indicatorMode: config.indicatorMode,
    },
    "patched",
    config.descriptor,
  );
  if (!options.deferHeaderFinalization) {
    const flags = makePatchHeaderFlags({
      saveMedium: PATCH_SAVE_MEDIUM.FLASH,
      saveSize: 65536,
      batteryless: false,
    });
    applyPatchHeaderMarker(installed.rom.bytes, installed.operations, flags);
  }
  const output = baseResult(
    installed.rom.bytes,
    sourceSaveType,
    "patched",
    installed.operations,
    installed.warnings,
    journal,
    journal.journal.reservedRanges,
  );
  output.result.targetSaveSizeBytes = config.descriptor.target.saveSize;
  output.result.bankSwitchMode = "none";
  if (Number.isInteger(options.saveChipType)) output.result.saveChipType = options.saveChipType;
  return output;
}

export function patchFlash512kBytes(inputBytes, options = {}) {
  const input = new Uint8Array(inputBytes);
  const config = validatedFlashOptions(input, options);
  const source = validateFlashSource(input);
  if (source.output) return source.output;
  const normalized = normalizeFlashSource(input, source.sourceSaveType, config.descriptor);
  const installed = installFlashJournal(normalized, config);
  return flashJournalOutput(installed, source.sourceSaveType, config, options);
}

export function patchJournalConvertedSave(inputBytes, options, descriptor) {
  const output = patchFlash512kBytes(inputBytes, { ...options, descriptor });
  output.result.mode = descriptor.id === DESCRIPTOR.id ? "flash512k" : "custom-flash";
  output.result.targetSaveSizeBytes = descriptor.target.saveSize;
  output.result.bankSwitchMode = "none";
  if (Number.isInteger(options?.saveChipType)) output.result.saveChipType = options.saveChipType;
  return output;
}

export function planJournalHooks(bytes, descriptor, label = descriptor.label) {
  return detectFlash512kHookSet(bytes, label);
}

export const FLASH512K_LAYOUT = Object.freeze({
  blockSize: PATCH_BLOCK_ALIGNMENT,
  payloadSize: PAYLOAD.length,
  reservedSize: JOURNAL_RESERVED_SIZE,
  activeSize: JOURNAL_ACTIVE_SIZE,
  flash1mBankSelectOffset: FLASH1M_BANK_SELECT_ROM_OFFSET,
});
