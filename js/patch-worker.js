// SPDX-License-Identifier: GPL-3.0-or-later

import { patchSramBytes } from "./patchers/sram.js";
import { patchCustomFlashBytes } from "./patchers/custom-flash.js";
import { patchFlash512kBytes } from "./patchers/flash512k.js";
import { applyWaitstateForPipeline } from "./patchers/waitstate.js";
import { waitstateFixedWriteRangesForLayout, waitstatePayloadSpanForLayout } from "./patchers/waitstate.js";
import {
  applyRtcForPipeline,
  rtcPayloadSpanForLayout,
  RTC_PAYLOAD_SIZE,
  RTC_PERSISTENCE_CUSTOM_BACKEND_FLAG,
} from "./patchers/rtc.js";
import {
  applyIrqHandlerForPipeline,
  irqHandlerPayloadSpanForLayout,
} from "./patchers/irq-handler.js";
import { alignedPayloadSpan } from "./patchers/payload-placement.js";
import {
  ensureStandaloneRtcPersistenceLayout,
  RTC_PERSISTENCE_BLOCK_SIZE,
} from "./patchers/rtc-persistence-placement.js";
import {
  applyPatchHeaderMarker,
  makePatchHeaderFlags,
  readDirectFlashHeaderSaveSize,
  updateGbaHeaderChecksum,
} from "./patchers/patch-state.js";
import { detectRomSaveMetadata } from "./patchers/save-type.js";
import { findStartupRomCopySourceRanges } from "./patchers/startup-rom-copy-ranges.js";
import { PATCH_MODES, PATCH_OPERATION_KIND, RTC_TICK_MODES, WORKER_PROTOCOL_VERSION } from "./domain/constants.js";
import { GBA_MAX_ROM_SIZE_BYTES } from "./domain/gba-constants.js";
import { sha256Hex } from "./core/hash.js";
import {
  assertCancelRequest,
  assertPatchRequest,
  serializePatchError,
  WORKER_MESSAGE_TYPE,
} from "./worker/protocol.js";
import { normalizePatchResult } from "./worker/result-adapter.js";
import { validatePayloadArtifacts } from "./generated/validate-payloads.js";
import { applyPatchPlan, createPatchPlan } from "./patch-engine/transaction.js";
import {
  decodeDirectEepromSave,
  exportDirectSramSave,
  inspectConvertedFlashSave,
  prepareDirectSave,
} from "./save-layouts/converted-flash.js";


function ensureResultArrays(patched) {
  patched.result.operations = patched.result.operations || [];
  patched.result.warnings = patched.result.warnings || [];
}

function applyRtcStandalonePatch(patched, rtcOptions = {}, context = {}) {
  if (!rtcOptions?.enabled) return patched;
  ensureResultArrays(patched);
  const operationCountBeforeRtc = patched.result.operations.length;
  const rom = { bytes: patched.bytes };
  const rtc = applyRtcForPipeline(rom, patched.result.operations, patched.result.warnings, rtcOptions, {
    excludedRanges: context.excludedRanges || [],
    payloadOffset: context.payloadOffset ?? null,
    persistenceBlockOffset: context.persistenceBlockOffset ?? null,
    persistenceFlags: context.persistenceFlags ?? 0,
  });
  patched.bytes = rom.bytes;
  patched.result.rtc = rtc;

  if (patched.result.operations.length > operationCountBeforeRtc) patched.result.status = "patched";
  return patched;
}

function applyWaitstateStandalonePatch(patched, waitstateOptions = {}, context = {}) {
  if (!waitstateOptions?.enabled) return patched;
  ensureResultArrays(patched);
  const operationCountBeforeWaitstate = patched.result.operations.length;
  const rom = { bytes: patched.bytes };
  const waitstate = applyWaitstateForPipeline(rom, patched.result.operations, patched.result.warnings, waitstateOptions, {
    excludedRanges: context.excludedRanges || [],
    waitstatePayloadOffset: context.waitstatePayloadOffset ?? null,
  });
  patched.bytes = rom.bytes;
  patched.result.waitstate = waitstate;

  if (patched.result.operations.length > operationCountBeforeWaitstate) patched.result.status = "patched";
  return patched;
}

function validRange(range) {
  return Array.isArray(range)
    && range.length >= 2
    && Number.isInteger(range[0])
    && Number.isInteger(range[1])
    && range[0] >= 0
    && range[1] > range[0];
}

function payloadRange(result, payloadOffset) {
  if (!Number.isInteger(payloadOffset) || !Number.isInteger(result?.size) || result.size <= 0) return null;
  const payloadSpan = Number.isInteger(result.payloadSpan)
    ? result.payloadSpan
    : alignedPayloadSpan(result.size);
  return [payloadOffset, payloadOffset + payloadSpan];
}

function persistenceRangeAt(offset) {
  if (!Number.isInteger(offset)
      || offset < 0
      || offset % RTC_PERSISTENCE_BLOCK_SIZE
      || offset + RTC_PERSISTENCE_BLOCK_SIZE > GBA_MAX_ROM_SIZE_BYTES) return null;
  return [offset, offset + RTC_PERSISTENCE_BLOCK_SIZE];
}

function appendReservedRange(result, range) {
  if (!validRange(range)) return;
  const ranges = Array.isArray(result.reservedRanges)
    ? result.reservedRanges.filter(validRange).map(([start, end]) => [start, end])
    : [];
  if (!ranges.some(([start, end]) => start === range[0] && end === range[1])) {
    ranges.push([range[0], range[1]]);
  }
  result.reservedRanges = ranges;
}

function shouldPersistRtc(options = {}) {
  return options.rtc?.enabled === true
    && options.rtc?.saveOnGlobalHotkey !== false;
}

function directRuntimeExcludedRanges(result) {
  const runtime = result?.saveRuntime;
  if (!Number.isInteger(runtime?.payloadOffset)
      || !Number.isInteger(runtime?.payloadSize)
      || runtime.payloadSize <= 0) return [];
  return [[runtime.payloadOffset, runtime.payloadOffset + alignedPayloadSpan(runtime.payloadSize)]];
}

function applyStandaloneAddonPatches(patched, options = {}, context = {}) {
  // With RTC persistence enabled: [last ROM data/padding] [Fake RTC]
  // [Waitstate] [Shared IRQ] | 0x40000-byte writable RTC block. Disabled
  // persistence uses the regular add-on placement and reserves no block.
  ensureResultArrays(patched);
  const excludedRanges = [
    ...findStartupRomCopySourceRanges(patched.bytes),
    ...(context.excludedRanges || []),
  ].filter(validRange);
  let rtcPayloadOffset = context.rtcPayloadOffset ?? null;
  let waitstatePayloadOffset = context.waitstatePayloadOffset ?? null;
  let irqPayloadOffset = context.irqPayloadOffset ?? null;
  const persistenceEnabled = shouldPersistRtc(options);
  let persistenceBlockOffset = persistenceEnabled
    ? (context.persistenceBlockOffset ?? null)
    : null;
  const persistenceFlags = persistenceEnabled ? (context.persistenceFlags ?? 0) : 0;
  let persistenceRange = persistenceRangeAt(persistenceBlockOffset);
  let rtcLayoutAvailable = true;

  if (persistenceEnabled && persistenceBlockOffset === null) {
    const operationCountBeforeLayout = patched.result.operations.length;
    const rom = { bytes: patched.bytes };
    const layout = ensureStandaloneRtcPersistenceLayout(
      rom,
      patched.result.operations,
      patched.result.warnings,
      {
        rtcSpan: rtcPayloadSpanForLayout(),
        waitstateSpan: waitstatePayloadSpanForLayout(patched.bytes, options.waitstate || {}),
        irqSpan: irqHandlerPayloadSpanForLayout(),
      },
      [
        ...excludedRanges,
        ...waitstateFixedWriteRangesForLayout(patched.bytes, options.waitstate || {}),
      ],
    );
    patched.bytes = rom.bytes;
    if (layout === null) {
      patched.result.rtc = { requested: true, status: "failed", size: RTC_PAYLOAD_SIZE };
      rtcLayoutAvailable = false;
    } else {
      rtcPayloadOffset = layout.rtcPayloadOffset;
      waitstatePayloadOffset = layout.waitstatePayloadOffset;
      irqPayloadOffset = layout.irqPayloadOffset;
      persistenceBlockOffset = layout.persistenceBlockOffset;
      persistenceRange = layout.persistenceRange;
      if (patched.result.operations.length > operationCountBeforeLayout) patched.result.status = "patched";
    }
  } else if (persistenceEnabled && persistenceRange === null) {
    throw new Error("Fake RTC persistence block supplied by the patch pipeline is invalid.");
  }

  if (persistenceRange) {
    excludedRanges.push(persistenceRange);
    appendReservedRange(patched.result, persistenceRange);
  }

  if (rtcLayoutAvailable) {
    patched = applyRtcStandalonePatch(patched, options.rtc, {
      excludedRanges,
      payloadOffset: rtcPayloadOffset,
      persistenceBlockOffset,
      persistenceFlags,
    });
  }
  const rtcRange = payloadRange(patched.result.rtc, patched.result.rtc?.payloadOffset);
  if (rtcRange) excludedRanges.push(rtcRange);

  const waitstateExcludedRanges = [...(context.waitstateExcludedRanges || excludedRanges)];
  if (persistenceRange) waitstateExcludedRanges.push(persistenceRange);
  if (rtcRange) waitstateExcludedRanges.push(rtcRange);
  patched = applyWaitstateStandalonePatch(patched, options.waitstate, {
    excludedRanges: waitstateExcludedRanges,
    waitstatePayloadOffset,
  });
  const waitstateRange = payloadRange(patched.result.waitstate, patched.result.waitstate?.payloadOffset);
  if (waitstateRange) excludedRanges.push(waitstateRange);

  const rtcMenuEntry = patched.result.rtc?.runtimeMenuEntry || 0;
  const rtcTickMode = patched.result.rtc?.tickMode;
  const pipelineSaveFlushEntry = context.saveFlushEntry
    || (context.directRtcAutoFlush ? (patched.result.rtc?.persistenceFlushEntry || 0) : 0);
  const standalonePersistenceFlushEntry = pipelineSaveFlushEntry
    ? 0
    : (patched.result.rtc?.persistenceFlushEntry || 0);
  const saveFlushEntry = pipelineSaveFlushEntry || standalonePersistenceFlushEntry;
  if (rtcMenuEntry || saveFlushEntry) {
    ensureResultArrays(patched);
    const operationCountBeforeIrq = patched.result.operations.length;
    const rom = { bytes: patched.bytes };
    const irqHandler = applyIrqHandlerForPipeline(rom, patched.result.operations, patched.result.warnings, {
      enabled: true,
      rtcMenuEntry,
      rtcTickMode,
      saveFlushEntry,
      saveFlushAuto: standalonePersistenceFlushEntry ? false : (
        context.directRtcAutoFlush === true || context.saveFlushAuto === true
      ),
      saveFlushHotkey: standalonePersistenceFlushEntry ? true : context.saveFlushHotkey !== false,
      countdownFrames: context.countdownFrames || 0,
      indicatorMode: context.indicatorMode || "off",
      hotkeyMask: context.hotkeyMask ?? options.batteryless?.hotkeyMask,
    }, {
      excludedRanges,
      payloadOffset: irqPayloadOffset,
    });
    patched.bytes = rom.bytes;
    patched.result.irqHandler = irqHandler;
    if (patched.result.operations.length > operationCountBeforeIrq) patched.result.status = "patched";
  }
  return patched;
}

function targetHeaderSaveMetadata(
  patched,
  options,
  sourceSaveMetadata,
  sourceHeaderSaveSize = null,
) {
  if (options.patchMode === PATCH_MODES.SRAM) {
    return { medium: "sram", size: sourceSaveMetadata.size, batteryless: false };
  }
  if (options.patchMode === PATCH_MODES.BATTERYLESS_SRAM) {
    return {
      medium: "sram",
      size: patched.result.batteryless?.saveSize ?? sourceSaveMetadata.size,
      batteryless: true,
    };
  }
  if (options.patchMode === PATCH_MODES.FLASH_512K) {
    return {
      medium: "flash",
      size: Object.hasOwn(patched.result, "headerSaveSizeBytes")
        ? patched.result.headerSaveSizeBytes
        : 65536,
      batteryless: false,
    };
  }
  if (options.patchMode === PATCH_MODES.CUSTOM_FLASH) {
    return {
      medium: "flash",
      size: Object.hasOwn(patched.result, "headerSaveSizeBytes")
        ? patched.result.headerSaveSizeBytes
        : (patched.result.targetSaveSizeBytes ?? sourceSaveMetadata.size),
      batteryless: false,
    };
  }
  if (options.patchMode === PATCH_MODES.NONE && Number.isInteger(sourceHeaderSaveSize)) {
    return { medium: "flash", size: sourceHeaderSaveSize, batteryless: false };
  }
  return { medium: sourceSaveMetadata.medium, size: sourceSaveMetadata.size, batteryless: false };
}

function finalizeHeaderChecksum(patched, options, sourceSaveMetadata, sourceHeaderSaveSize) {
  ensureResultArrays(patched);
  const hasPatchOperations = patched.result.operations.length > 0;
  if (hasPatchOperations) {
    const saveMetadata = targetHeaderSaveMetadata(
      patched,
      options,
      sourceSaveMetadata,
      sourceHeaderSaveSize,
    );
    let headerFlags = makePatchHeaderFlags({
      saveMedium: saveMetadata.medium,
      saveSize: saveMetadata.size,
      batteryless: saveMetadata.batteryless,
      waitstateResult: patched.result.waitstate,
      rtcResult: patched.result.rtc,
    });
    if (options.patchMode === PATCH_MODES.NONE && Number.isInteger(sourceHeaderSaveSize)) {
      headerFlags |= patched.bytes[0xbf] & 0xe0;
    }
    applyPatchHeaderMarker(patched.bytes, patched.result.operations, headerFlags);
    patched.result.headerSave = { ...saveMetadata, flags: headerFlags };
  }
  updateGbaHeaderChecksum(patched.bytes, patched.result.operations);
  if (patched.result.operations.length) patched.result.status = patched.result.status === "unchanged" ? "patched" : patched.result.status;
  return patched;
}

function firstWarning(result) {
  return result?.warnings?.[0] || "This ROM could not be patched.";
}

function failureWarning(result, prefix) {
  const warnings = result?.warnings || [];
  for (let index = warnings.length - 1; index >= 0; index -= 1) {
    if (warnings[index].startsWith(prefix)) return warnings[index];
  }
  return firstWarning(result);
}

function sharedIrqIsRequired(result) {
  return Boolean(
    result?.batteryless?.flushEntry
    || (result?.rtc?.status === "patched" && result.rtc.tickMode === RTC_TICK_MODES.VBLANK),
  );
}

function ensureSuccessfulPatch(result, options = {}) {
  if (result?.batteryless?.status === "failed") throw new Error(failureWarning(result, "Batteryless SRAM:"));
  if (options.patchMode === PATCH_MODES.SRAM && ["failed", "unsupported"].includes(result?.savePatch?.status)) throw new Error(firstWarning(result));
  if (result?.rtc?.status === "patched"
      && result.rtc.tickMode === RTC_TICK_MODES.VBLANK
      && result?.irqHandler?.status !== "patched") {
    throw new Error(failureWarning(result, "Shared IRQ:") || "Continuous Fake RTC requires the shared IRQ handler.");
  }
  if (result?.irqHandler?.status === "failed" && sharedIrqIsRequired(result)) throw new Error(failureWarning(result, "Shared IRQ:"));
  if (result?.status === "unsupported") throw new Error(firstWarning(result));
}

const activeRequestIds = new Set();

self.addEventListener("message", async (event) => {
  const rawMessage = event.data;
  const fallbackRequestId = typeof rawMessage?.requestId === "string" ? rawMessage.requestId : "invalid-request";

  if (rawMessage?.type === WORKER_MESSAGE_TYPE.CANCEL_REQUEST) {
    try {
      assertCancelRequest(rawMessage);
    } catch (error) {
      self.postMessage({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        type: WORKER_MESSAGE_TYPE.PATCH_FAILED,
        requestId: fallbackRequestId,
        error: serializePatchError(error, "protocol"),
      });
    }
    return;
  }

  try {
    const message = assertPatchRequest(rawMessage);
    await validatePayloadArtifacts();
    if (activeRequestIds.has(message.requestId)) throw new Error("Duplicate worker request ID.");
    activeRequestIds.add(message.requestId);
    const romBytes = new Uint8Array(message.romBuffer);
    const sourceRomBytes = romBytes.slice();
    const inputSha256 = await sha256Hex(romBytes);
    const sourceSaveMetadata = detectRomSaveMetadata(romBytes);
    const sourceHeaderSaveSize = readDirectFlashHeaderSaveSize(romBytes);
    let patched;

    if (message.options.patchMode === PATCH_MODES.FLASH_512K) {
      patched = patchFlash512kBytes(romBytes, {
        placementExcludedRanges: waitstateFixedWriteRangesForLayout(
          romBytes,
          message.options.waitstate || {},
        ),
        deferHeaderFinalization: true,
      });
      patched = applyStandaloneAddonPatches(patched, message.options, {
        excludedRanges: directRuntimeExcludedRanges(patched.result),
        waitstateExcludedRanges: directRuntimeExcludedRanges(patched.result),
        indicatorMode: "off",
        hotkeyMask: message.options.batteryless?.hotkeyMask,
      });
    } else if (message.options.patchMode === PATCH_MODES.CUSTOM_FLASH) {
      patched = patchCustomFlashBytes(romBytes, {
        saveChipType: message.options.customFlash?.saveChipType,
        placementExcludedRanges: waitstateFixedWriteRangesForLayout(
          romBytes,
          message.options.waitstate || {},
        ),
        deferHeaderFinalization: true,
      });
      patched = applyStandaloneAddonPatches(patched, message.options, {
        excludedRanges: directRuntimeExcludedRanges(patched.result),
        waitstateExcludedRanges: directRuntimeExcludedRanges(patched.result),
        indicatorMode: "off",
        persistenceFlags: shouldPersistRtc(message.options)
          ? RTC_PERSISTENCE_CUSTOM_BACKEND_FLAG
          : 0,
      });
    } else if (message.options.patchMode === PATCH_MODES.NONE) {
      patched = { bytes: romBytes, result: { operations: [], warnings: [], status: "unchanged" } };
      patched = applyStandaloneAddonPatches(patched, message.options);
    } else if ([PATCH_MODES.SRAM, PATCH_MODES.BATTERYLESS_SRAM].includes(message.options.patchMode)) {
      const batteryless = message.options.patchMode === PATCH_MODES.BATTERYLESS_SRAM;
      patched = patchSramBytes(romBytes, {
        batteryless,
        batterylessMode: message.options.batteryless.mode,
        batterylessCountdown: message.options.batteryless.countdownFrames,
        batterylessIndicatorMode: message.options.batteryless.indicator,
        batterylessLastBlock: message.options.batteryless.lastBlock,
        batterylessHotkeyMask: message.options.batteryless.hotkeyMask,
        flash1mBankSwitchStyle: message.options.sram?.flash1mBankSwitchStyle || "modern",
        saveBuffer: message.saveBuffer || null,
        waitstate: message.options.waitstate,
        rtc: message.options.rtc,
        deferHeaderFinalization: true,
      });
    } else {
      throw new Error(`Unsupported patch mode: ${message.options.patchMode}.`);
    }

    const contractPreview = normalizePatchResult(patched.result);
    if (!["none", "flash1m"].includes(contractPreview.bankSwitchMode)) {
      throw new Error("Internal patch plan selected an invalid bank-switch mode.");
    }
    if (contractPreview.bankSwitchMode === "flash1m" && contractPreview.targetSaveSizeBytes !== 131072) {
      throw new Error("Internal patch plan selected FLASH1M banking for a non-128 KiB target.");
    }
    if (contractPreview.saveRuntime && contractPreview.bankSwitchMode !== "none") {
      throw new Error("Internal patch plan selected bank switching for a Direct save target.");
    }
    if ([PATCH_MODES.FLASH_512K, PATCH_MODES.CUSTOM_FLASH].includes(message.options.patchMode)
        && contractPreview.bankSwitchMode !== "flash1m"
        && contractPreview.operations?.some((operation) => operation.kind === PATCH_OPERATION_KIND.BANK_SWITCH_PATCH)) {
      throw new Error("Internal patch plan contains a bank-switch operation for a non-FLASH1M target.");
    }
    ensureSuccessfulPatch(patched.result, message.options);
    let convertedSave = null;
    if (message.saveBuffer && ["sram", "eeprom"].includes(patched.result.saveRuntime?.family)) {
      const sourceSave = new Uint8Array(message.saveBuffer);
      convertedSave = prepareDirectSave(
        sourceSave,
        patched.result.saveRuntime.family,
        patched.result.saveRuntime.storageFormat,
      );
    } else if (message.saveBuffer && message.options.patchMode === PATCH_MODES.NONE) {
      const sourceSave = new Uint8Array(message.saveBuffer);
      const inspection = inspectConvertedFlashSave(sourceSave);
      const direct128Eeprom = sourceSave.length === 0x20000
        && ["direct-eeprom-delta-v5", "blank-physical-save"].includes(inspection.format);
      const direct128Sram = sourceSave.length === 0x20000
        && ["direct-sram-sector-log-v16", "direct-sram-snapshot-v3", "blank-physical-save"]
          .includes(inspection.format);
      if ((sourceSave.length === 0x10000 || direct128Eeprom)
          && sourceSaveMetadata.medium === "eeprom") {
        if (![512, 8192].includes(sourceHeaderSaveSize)) {
          throw new RangeError("The ROM has no valid Direct EEPROM export-size marker.");
        }
        const decoded = decodeDirectEepromSave(sourceSave);
        convertedSave = decoded.slice(0, sourceHeaderSaveSize);
      } else if ((sourceSave.length === 0x10000 || direct128Sram)
          && sourceSaveMetadata.medium === "sram") {
        convertedSave = exportDirectSramSave(sourceSave);
      }
      if (!convertedSave && ["eeprom", "sram"].includes(sourceSaveMetadata.medium)) {
        throw new RangeError("The attached save is not a supported Direct physical image.");
      }
    }
    patched = finalizeHeaderChecksum(
      patched,
      message.options,
      sourceSaveMetadata,
      sourceHeaderSaveSize,
    );
    patched.result = normalizePatchResult(patched.result);
    const patchPlan = createPatchPlan(sourceRomBytes, patched.bytes, patched.result.operations);
    patched.bytes = applyPatchPlan(sourceRomBytes, patchPlan);
    patched.result.operations = patchPlan.operations;
    patched.result.patchPlan = {
      schemaVersion: patchPlan.schemaVersion,
      finalLength: patchPlan.finalLength,
      metadata: patchPlan.metadata,
    };
    patched.result.inputSha256 = inputSha256;
    patched.result.outputSha256 = await sha256Hex(patched.bytes);
    const convertedSaveBuffer = convertedSave?.buffer || null;
    const convertedSaveFileName = convertedSave
      ? message.outputFileName.replace(/\.[^.]+$/, ".sav")
      : null;
    const response = {
      protocolVersion: WORKER_PROTOCOL_VERSION,
      type: WORKER_MESSAGE_TYPE.PATCH_COMPLETED,
      requestId: message.requestId,
      outputFileName: message.outputFileName,
      patchedBuffer: patched.bytes.buffer,
      convertedSaveBuffer,
      convertedSaveFileName,
      result: patched.result,
    };
    const transfers = convertedSaveBuffer
      ? [patched.bytes.buffer, convertedSaveBuffer]
      : [patched.bytes.buffer];
    self.postMessage(response, transfers);
  } catch (error) {
    self.postMessage({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      type: WORKER_MESSAGE_TYPE.PATCH_FAILED,
      requestId: fallbackRequestId,
      error: serializePatchError(error),
    });
  } finally {
    activeRequestIds.delete(fallbackRequestId);
  }
});
