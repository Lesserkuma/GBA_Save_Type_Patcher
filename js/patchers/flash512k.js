// SPDX-License-Identifier: GPL-3.0-or-later AND MIT

import { asciiBytes, findBytes, hexToBytes, writeU32 } from "../core/binary.js";
import { PatchError } from "../core/errors.js";
import {
  customFlashSaveChipModelFromType,
  PATCH_MODES,
  PATCH_OPERATION_KIND,
  PATCH_REASON_CODE,
} from "../domain/constants.js";
import { GBA_MAX_ROM_SIZE_BYTES } from "../domain/gba-constants.js";
import { stagePatchOperation } from "../patch-engine/draft.js";
import {
  alignedPayloadSpan,
  ensureDirectPayloadRegion,
  normalizeExcludedRanges,
} from "./payload-placement.js";
import {
  applyPatchHeaderMarker,
  makePatchHeaderFlags,
  PATCH_SAVE_MEDIUM,
} from "./patch-state.js";
import {
  detectEepromSize,
  findSaveType,
} from "./save-type.js";
import { patchSramBytes } from "./sram.js";
import { findStartupRomCopySourceRanges } from "./startup-rom-copy-ranges.js";
import { analyzeDirectCompatibility } from "./direct-compatibility.js";
import { stageMirroredBatchWorkspaceReservation } from "./sram-batched-snapshot-analysis.js";
import { buildEepromV120FlashTimingHook } from "./eeprom-v12x-write-compat.js";
import * as FLASH_DIRECT_DATA from "./flash-direct-data.js";
import * as FLASH_DIRECT_SNAPSHOT_DATA from "./flash-direct-snapshot-data.js";
import * as FLASH_DIRECT_TRANSACTION_DATA from "./flash-direct-transaction-data.js";
import {
  applyFlash512kDetectedHooks,
  DIRECT_SRAM_SAVE_TYPES,
  detectFlash512kDirectSramHookSet,
  detectFlash512kEepromV11xHookSet,
  detectFlash512kHookSet,
  logicalFlash512kSaveSize,
  validateFlash512kPayloadDescriptor,
} from "./flash512k-common.js";

const FLASH1M_MARKER = asciiBytes("FLASH1M_");
const EEPROM_4K_ONLY_SAVE_TYPES = new Set(["EEPROM_V110", "EEPROM_V111"]);
const DIRECT_SNAPSHOT_STORAGE = "direct-sram-snapshot-v3";
const DIRECT_PHYSICAL_SIZE = 0x10000;

function defineDirectDescriptor(rawData, spec = {}) {
  const constants = rawData.FLASH_DIRECT_CONSTANTS;
  const shape = spec.shape;
  if (!["base", "snapshot", "transaction"].includes(shape)) {
    throw new Error(`${spec.label || "Direct"} payload shape is invalid.`);
  }
  const required = (name) => {
    if (Number.isInteger(constants?.[name])) return constants[name];
    throw new Error(`${spec.label || "Direct"} payload constant is missing (${name}).`);
  };
  const payload = hexToBytes(rawData.FLASH_DIRECT_PAYLOAD_HEX);
  const signature = hexToBytes(rawData.FLASH_DIRECT_SIGNATURE_HEX);
  const configFields = {
    layout: required("DIRECT_LAYOUT_CONFIG_OFFSET"),
    saveProtocol: required("DIRECT_SAVE_PROTOCOL_CONFIG_OFFSET"),
  };
  if (Number.isInteger(constants.DIRECT_SNAPSHOT_WORKSPACE_BASE_CONFIG_OFFSET)) {
    configFields.snapshotWorkspaceBase = required("DIRECT_SNAPSHOT_WORKSPACE_BASE_CONFIG_OFFSET");
    configFields.snapshotReaderBase = required("DIRECT_SNAPSHOT_READER_BASE_CONFIG_OFFSET");
    configFields.snapshotCommitFirst = required("DIRECT_SNAPSHOT_COMMIT_FIRST_CONFIG_OFFSET");
    configFields.snapshotCommitSize = required("DIRECT_SNAPSHOT_COMMIT_SIZE_CONFIG_OFFSET");
  }
  const entries = {
    sramWrite: required("DIRECT_WRITE_SRAM_ENTRY"),
    sramWriteCached: required("DIRECT_WRITE_SRAM_CACHED_ENTRY"),
    sramWriteVerify: required("DIRECT_WRITE_VERIFY_SRAM_ENTRY"),
    sramRead: required("DIRECT_READ_SRAM_ENTRY"),
    sramReadCached: required("DIRECT_READ_SRAM_CACHED_ENTRY"),
    sramReadTriplet: required("DIRECT_READ_SRAM_TRIPLET_ENTRY"),
    sramReadTripletCached: required("DIRECT_READ_SRAM_TRIPLET_CACHED_ENTRY"),
    sramVerify: required("DIRECT_VERIFY_SRAM_ENTRY"),
    sramVerifyCached: required("DIRECT_VERIFY_SRAM_CACHED_ENTRY"),
    sramVerifyFast: required("DIRECT_VERIFY_SRAM_FAST_ENTRY"),
  };
  const families = {
    sram: { layout: required("DIRECT_LAYOUT_SRAM") },
  };
  if (shape === "base") {
    if (required("EEPROM_LOGICAL_SIZE") !== 8192) {
      throw new Error(`${spec.label || "Direct"} EEPROM geometry must be 8 KiB.`);
    }
    Object.assign(entries, {
      eepromWrite: required("DIRECT_WRITE_EEPROM_ENTRY"),
      eepromWriteSettled: required("DIRECT_WRITE_EEPROM_SETTLED_ENTRY"),
      eepromRead: required("DIRECT_READ_EEPROM_ENTRY"),
      eepromVerify: required("DIRECT_VERIFY_EEPROM_ENTRY"),
    });
    families.eeprom = {
      layout: required("DIRECT_LAYOUT_EEPROM"),
    };
  }
  const descriptor = {
    label: spec.label ?? "Direct Save-FLASH",
    shape,
    payload,
    signature,
    payloadSize: required("FLASH_DIRECT_PAYLOAD_SIZE"),
    signatureOffset: required("FLASH_DIRECT_SIGNATURE_OFFSET"),
    gbaRomBase: required("GBA_ROM_BASE"),
    configFields,
    mutableRanges: Object.entries(configFields).map(([name, offset]) => [
      offset,
      offset + 4,
    ]),
    entries,
    families,
    protocols: {
      standard: required("DIRECT_PROTOCOL_STANDARD"),
      customType1: required("DIRECT_PROTOCOL_CUSTOM_TYPE_1"),
      customType2: required("DIRECT_PROTOCOL_CUSTOM_TYPE_2"),
    },
    storageFormat: spec.storageFormat ?? null,
  };
  validateFlash512kPayloadDescriptor(descriptor, descriptor.label);
  const familyRuntimes = {};
  if (spec.snapshotData) {
    const snapshotRuntime = defineDirectDescriptor(spec.snapshotData, {
      label: `${descriptor.label} mirrored SRAM batch snapshot`,
      shape: "snapshot",
      storageFormat: DIRECT_SNAPSHOT_STORAGE,
    });
    familyRuntimes.sramMirroredBatch = snapshotRuntime;
  }
  if (spec.transactionData) {
    const transactionRuntime = defineDirectDescriptor(spec.transactionData, {
      label: `${descriptor.label} SRAM transaction`,
      shape: "transaction",
    });
    familyRuntimes.sramTransaction = transactionRuntime;
  }
  descriptor.familyRuntimes = Object.freeze(familyRuntimes);
  return Object.freeze(descriptor);
}

const DIRECT_DESCRIPTOR = defineDirectDescriptor(FLASH_DIRECT_DATA, {
  label: "Direct Save-FLASH",
  shape: "base",
  snapshotData: FLASH_DIRECT_SNAPSHOT_DATA,
  transactionData: FLASH_DIRECT_TRANSACTION_DATA,
});

function familyConfig(family, descriptor) {
  const config = descriptor.families?.[family];
  if (!config) throw new PatchError(`${descriptor.label}: unsupported hook family ${family}.`);
  return config;
}

function validatedFlashOptions(input, options) {
  const descriptor = DIRECT_DESCRIPTOR;
  const directBackend = options.directBackend ?? "standard";
  const saveChipType = options.saveChipType ?? null;
  let protocol = descriptor.protocols.standard;
  if (directBackend !== "standard" && directBackend !== "custom") {
    throw new PatchError(`${descriptor.label}: backend must be standard or custom.`);
  }
  if (directBackend === "custom") {
    if (![1, 2].includes(saveChipType)) {
      throw new PatchError(`${descriptor.label}: save chip type must be integer 1 or 2.`);
    }
    protocol = saveChipType === 1
      ? descriptor.protocols.customType1
      : descriptor.protocols.customType2;
  }
  if (input.length < 0xc0 || input[0xb2] !== 0x96) throw new PatchError("Invalid GBA header.");
  if (input.length > GBA_MAX_ROM_SIZE_BYTES) {
    throw new PatchError(`${descriptor.label}: ROM is larger than 32 MiB.`, {
      code: PATCH_REASON_CODE.ROM_CAPACITY,
      isRecoverable: true,
    });
  }
  const requestedRanges = options.placementExcludedRanges ?? [];
  if (!Array.isArray(requestedRanges)) throw new PatchError(`${descriptor.label}: placement exclusions must be ranges.`);
  return {
    descriptor,
    directBackend,
    saveChipType,
    protocol,
    placementExcludedRanges: normalizeExcludedRanges([
      ...requestedRanges,
      ...findStartupRomCopySourceRanges(input),
    ]),
  };
}

function directEepromExportSize(sourceSaveType, detectedSize) {
  if ([512, 8192].includes(detectedSize)) return detectedSize;
  return EEPROM_4K_ONLY_SAVE_TYPES.has(sourceSaveType) ? 512 : 8192;
}

/** @param {string} [mode] */
function baseResult(bytes, sourceSaveType, status, operations, warnings, saveRuntime, mode = PATCH_MODES.FLASH_512K) {
  return {
    bytes,
    result: {
      mode,
      status,
      saveType: sourceSaveType,
      sourceSaveType,
      targetSaveType: "FLASH512",
      logicalSaveSizeBytes: logicalFlash512kSaveSize(sourceSaveType, saveRuntime?.family),
      targetSaveSizeBytes: DIRECT_PHYSICAL_SIZE,
      bankSwitchMode: "none",
      saveRuntime,
      reservedRanges: [],
      operations,
      warnings,
    },
  };
}

function nativeFlashResult(input, sourceSaveType) {
  return baseResult(new Uint8Array(input), sourceSaveType, "unchanged", [], [], null);
}

function validateFlashSource(input) {
  if (findBytes(input, DIRECT_DESCRIPTOR.signature) >= 0) {
    throw new PatchError("This ROM already contains the Direct Save-FLASH backend.");
  }
  const sourceSaveType = findSaveType(input);
  if (findBytes(input, FLASH1M_MARKER) >= 0 || sourceSaveType?.startsWith("FLASH1M")) {
    throw new PatchError("512K FLASH is incompatible with 1M FLASH / 128 KiB save games.", {
      code: PATCH_REASON_CODE.INCOMPATIBLE_SAVE_SIZE,
      isRecoverable: true,
    });
  }
  if (sourceSaveType?.startsWith("FLASH512") || sourceSaveType?.startsWith("FLASH_")) {
    return { sourceSaveType, output: nativeFlashResult(input, sourceSaveType) };
  }
  if (!sourceSaveType || (!sourceSaveType.startsWith("SRAM") && !sourceSaveType.startsWith("EEPROM"))) {
    throw new PatchError(sourceSaveType
      ? `${sourceSaveType} is not supported by 512K FLASH.`
      : "512K FLASH could not detect a supported SRAM or EEPROM save type.", {
      code: sourceSaveType
        ? PATCH_REASON_CODE.UNSUPPORTED_SAVE_TYPE
        : PATCH_REASON_CODE.AMBIGUOUS_SAVE_TYPE,
      isRecoverable: true,
    });
  }
  return { sourceSaveType, output: null };
}

function normalizeFlashSource(input, sourceSaveType, descriptor) {
  const withRuntimeEvidence = (normalized, hooks) => {
    if (hooks.family !== "eeprom") return hooks;
    const eepromRuntimeTimer = hooks.eepromWrite.length > 0
      && hooks.eepromWrite.every((offset) => {
        const operations = normalized.result.operations.filter((operation) => (
          operation.offset === offset
          && operation.metadata?.codeName === "eeprom_write"
          && operation.expectedBefore instanceof Uint8Array
        ));
        return operations.length === 1
          && buildEepromV120FlashTimingHook(
            normalized.bytes,
            offset,
            descriptor.gbaRomBase + 1,
            operations[0].expectedBefore,
            descriptor.gbaRomBase,
          ) !== null;
      });
    return { ...hooks, eepromRuntimeTimer };
  };
  const analyzed = (normalized, hooks) => {
    const evidencedHooks = withRuntimeEvidence(normalized, hooks);
    return {
      normalized,
      hooks: evidencedHooks,
      capabilityPlan: analyzeDirectCompatibility(
        normalized.bytes, evidencedHooks, descriptor,
      ),
    };
  };
  if (EEPROM_4K_ONLY_SAVE_TYPES.has(sourceSaveType)) {
    const normalized = { bytes: new Uint8Array(input), result: { status: "patched", operations: [], warnings: [] } };
    const hooks = {
        ...detectFlash512kEepromV11xHookSet(normalized.bytes, sourceSaveType, descriptor.label),
        sourceSaveType,
        sourceLength: normalized.bytes.length,
    };
    return analyzed(normalized, hooks);
  }
  if (DIRECT_SRAM_SAVE_TYPES.has(sourceSaveType)) {
    const normalized = { bytes: new Uint8Array(input), result: { status: "patched", operations: [], warnings: [] } };
    const hooks = {
        ...detectFlash512kDirectSramHookSet(normalized.bytes, sourceSaveType, descriptor.label),
        sourceSaveType,
        sourceLength: normalized.bytes.length,
    };
    return analyzed(normalized, hooks);
  }
  const normalized = patchSramBytes(input, {
    batteryless: false,
    waitstate: { enabled: false },
    rtc: { enabled: false },
    deferHeaderFinalization: true,
  });
  const normalizedSavePatchStatus = normalized.result.savePatch?.status;
  const normalizedSavePatchComplete = normalizedSavePatchStatus === "patched"
    || (normalizedSavePatchStatus === "unchanged"
      && normalized.result.savePatch?.alreadySram === true);
  if (!normalizedSavePatchComplete) {
    throw new PatchError(
      normalized.result.warnings?.[0] || `${sourceSaveType} could not be normalized to SRAM.`,
      {
        code: normalized.result.savePatch?.reasonCode || "INCOMPLETE_HOOK_SET",
        isRecoverable: true,
      },
    );
  }
  const hooks = {
      ...detectFlash512kHookSet(
        normalized.bytes,
        descriptor.label,
        sourceSaveType.startsWith("EEPROM") ? "eeprom" : "sram",
      ),
      sourceSaveType,
      sourceLength: normalized.bytes.length,
  };
  return analyzed(normalized, hooks);
}

function configurePayload(
  descriptor,
  runtime,
  family,
  protocol,
  capabilityPlan,
) {
  const payload = new Uint8Array(runtime.payload);
  const familySettings = familyConfig(family, descriptor);
  writeU32(payload, runtime.configFields.layout, familySettings.layout);
  writeU32(payload, runtime.configFields.saveProtocol, protocol);
  if (capabilityPlan.profile === "sram-mirrored-batch-snapshot") {
    const snapshot = capabilityPlan.mirroredBatchSnapshot;
    const fields = runtime.configFields;
    if (!Number.isInteger(fields.snapshotWorkspaceBase)
        || !Number.isInteger(fields.snapshotReaderBase)
        || !Number.isInteger(fields.snapshotCommitFirst)
        || !Number.isInteger(fields.snapshotCommitSize)) {
      throw new PatchError(`${runtime.label}: snapshot configuration ABI is incomplete.`);
    }
    writeU32(payload, fields.snapshotWorkspaceBase, snapshot.workspaceBase);
    writeU32(payload, fields.snapshotReaderBase, snapshot.readerBase);
    writeU32(payload, fields.snapshotCommitFirst, snapshot.commitFirst);
    writeU32(payload, fields.snapshotCommitSize, snapshot.commitSize);
  }
  return payload;
}

function installDirectBackend(normalizedSource, config) {
  const { normalized, hooks, capabilityPlan } = normalizedSource;
  const rom = { bytes: normalized.bytes };
  const operations = [...(normalized.result.operations || [])];
  const warnings = [...(normalized.result.warnings || [])];
  const runtime = capabilityPlan.runtime;
  if (capabilityPlan.profile === "sram-mirrored-batch-snapshot") {
    stageMirroredBatchWorkspaceReservation(
      rom.bytes,
      operations,
      capabilityPlan.mirroredBatchSnapshot,
    );
  }
  const hookEntries = { ...runtime.entries };
  if (hooks.family === "sram" && hooks.sramReadbackVerify !== true) {
    hookEntries.sramVerify = runtime.entries.sramVerifyFast;
    hookEntries.sramVerifyCached = runtime.entries.sramVerifyFast;
  }
  const hookRuntime = { ...runtime, entries: hookEntries };
  const span = alignedPayloadSpan(runtime.payloadSize);
  const payloadBase = ensureDirectPayloadRegion(
    rom,
    operations,
    warnings,
    span,
    config.descriptor.label,
    config.placementExcludedRanges,
  );
  if (payloadBase === null) {
    throw new PatchError(warnings.at(-1) || `${config.descriptor.label} payload could not be placed.`);
  }
  const payload = configurePayload(
    config.descriptor,
    runtime,
    hooks.family,
    config.protocol,
    capabilityPlan,
  );
  stagePatchOperation(rom.bytes, operations, {
    id: `save-runtime-${operations.length}`,
    kind: PATCH_OPERATION_KIND.PAYLOAD_INSTALL,
    component: "saveRuntime",
    offset: payloadBase,
    byteLength: payload.length,
    expectedBefore: rom.bytes.slice(payloadBase, payloadBase + payload.length),
    replacement: payload,
    labelKey: "operation.saveRuntime",
    metadata: {
      name: `${config.descriptor.label} payload`,
      codeName: "direct_save_payload",
    },
  });
  applyFlash512kDetectedHooks(
    rom.bytes,
    operations,
    hooks,
    payloadBase,
    hookRuntime,
    config.descriptor.label,
    {
      capabilityProfile: capabilityPlan.profile,
      eepromSettledCompat: capabilityPlan.eepromWriteMode === "settled-wrapper",
    },
  );
  return {
    rom, operations, warnings, hooks, payloadBase, runtime, capabilityPlan,
  };
}

function directOutput(installed, sourceSaveType, config, options, eepromExportSize) {
  const family = installed.hooks.family;
  const headerSaveSizeBytes = family === "eeprom"
    ? eepromExportSize
    : DIRECT_PHYSICAL_SIZE;
  if (family === "eeprom" && ![512, 8192].includes(headerSaveSizeBytes)) {
    throw new PatchError(`${config.descriptor.label}: invalid EEPROM export size.`);
  }
  if (!options.deferHeaderFinalization) {
    applyPatchHeaderMarker(installed.rom.bytes, installed.operations, makePatchHeaderFlags({
      saveMedium: PATCH_SAVE_MEDIUM.FLASH,
      saveSize: headerSaveSizeBytes,
      batteryless: false,
    }));
  }
  const storageFormat = installed.runtime.storageFormat;
  const saveRuntime = {
    family,
    profile: installed.capabilityPlan.profile,
    storageFormat,
    payloadOffset: installed.payloadBase,
    payloadSize: installed.runtime.payloadSize,
    ...(installed.capabilityPlan.mirroredBatchSnapshot
      ? { mirroredBatchSnapshot: installed.capabilityPlan.mirroredBatchSnapshot }
      : {}),
  };
  const output = baseResult(
    installed.rom.bytes,
    sourceSaveType,
    "patched",
    installed.operations,
    installed.warnings,
    saveRuntime,
  );
  output.result.targetSaveSizeBytes = DIRECT_PHYSICAL_SIZE;
  output.result.headerSaveSizeBytes = headerSaveSizeBytes;
  if (config.directBackend === "custom") output.result.saveChipType = config.saveChipType;
  if (config.directBackend === "custom") {
    output.result.saveChipTypeId = customFlashSaveChipModelFromType(config.saveChipType);
  }
  return output;
}

export function patchFlash512kBytes(inputBytes, options = {}) {
  const input = new Uint8Array(inputBytes);
  const config = validatedFlashOptions(input, options);
  const source = validateFlashSource(input);
  if (source.output) return source.output;
  const eepromExportSize = source.sourceSaveType.startsWith("EEPROM")
    ? directEepromExportSize(source.sourceSaveType, detectEepromSize(input))
    : null;
  const normalized = normalizeFlashSource(
    input,
    source.sourceSaveType,
    config.descriptor,
  );
  return directOutput(
    installDirectBackend(normalized, config),
    source.sourceSaveType,
    config,
    options,
    eepromExportSize,
  );
}

export function patchCustomDirectSave(inputBytes, options = {}) {
  const output = patchFlash512kBytes(inputBytes, {
    ...options,
    directBackend: "custom",
  });
  output.result.mode = PATCH_MODES.CUSTOM_FLASH;
  return output;
}
