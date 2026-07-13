// SPDX-License-Identifier: GPL-3.0-or-later

import { patchSramBytes } from "./patchers/sram.js";
import { CUSTOM_JOURNAL_DESCRIPTOR, patchCustomFlashBytes } from "./patchers/custom-flash.js";
import { STANDARD_JOURNAL_DESCRIPTOR, patchFlash512kBytes } from "./patchers/flash512k.js";
import { applyWaitstateForPipeline } from "./patchers/waitstate.js";
import { waitstateFixedWriteRangesForLayout, waitstatePayloadSpanForLayout } from "./patchers/waitstate.js";
import { applyRtcForPipeline, RTC_PAYLOAD_SIZE } from "./patchers/rtc.js";
import {
  applyIrqHandlerForPipeline,
  irqHandlerPayloadSpanForLayout,
} from "./patchers/irq-handler.js";
import { PATCH_BLOCK_ALIGNMENT, alignDown, alignedPayloadSpan, isFreeRegion } from "./patchers/payload-placement.js";
import { applyPatchHeaderMarker, makePatchHeaderFlags, updateGbaHeaderChecksum } from "./patchers/patch-state.js";
import { detectRomSaveMetadata } from "./patchers/save-type.js";
import { PATCH_OPERATION_KIND, WORKER_PROTOCOL_VERSION } from "./domain/constants.js";
import {
  assertCancelRequest,
  assertPatchRequest,
  serializePatchError,
  WORKER_MESSAGE_TYPE,
} from "./worker/protocol.js";
import { normalizePatchResult } from "./worker/result-adapter.js";
import { validatePayloadArtifacts } from "./generated/validate-payloads.js";
import { applyPatchPlan, createPatchPlan } from "./patch-engine/transaction.js";


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
  return [payloadOffset, payloadOffset + alignedPayloadSpan(result.size)];
}

function journalWaitstateExcludedRanges(result) {
  const ranges = [];
  const journalPatch = result?.flashJournal;
  const journal = journalPatch?.journal;
  const runtimeWriteRanges = journal?.runtimeWriteRanges || result?.runtimeWriteRanges;
  if (Array.isArray(runtimeWriteRanges)) {
    ranges.push(...runtimeWriteRanges.filter(validRange).map(([start, end]) => [start, end]));
  }

  if (!ranges.length && Number.isInteger(journal?.offset) && Number.isInteger(journal?.activeSize) && journal.activeSize > 0) {
    ranges.push([journal.offset, journal.offset + journal.activeSize]);
  }

  const reservedRanges = journal?.reservedRanges;
  if (Array.isArray(reservedRanges)) {
    ranges.push(...reservedRanges.filter(validRange).map(([start, end]) => [start, end]));
  }

  if (!ranges.length) {
    const reserved = result?.reservedRanges || journal?.reservedRanges;
    if (Array.isArray(reserved)) ranges.push(...reserved.filter(validRange).map(([start, end]) => [start, end]));
  }

  // The generated journal runtime code itself must also remain intact, even
  // though it is read-only at runtime.
  if (Number.isInteger(journalPatch?.payloadOffset) && Number.isInteger(journalPatch?.payloadSize) && journalPatch.payloadSize > 0) {
    ranges.push([journalPatch.payloadOffset, journalPatch.payloadOffset + journalPatch.payloadSize]);
  }
  return ranges;
}

function planJournalAddons(bytes, options = {}, descriptor = STANDARD_JOURNAL_DESCRIPTOR) {
  const rtcSpan = options.rtc?.enabled
    ? alignedPayloadSpan(RTC_PAYLOAD_SIZE)
    : 0;
  const waitstateSpan = waitstatePayloadSpanForLayout(bytes, options.waitstate || {});
  const irqSpan = irqHandlerPayloadSpanForLayout();
  const plan = {
    rtcSpan,
    waitstateSpan,
    irqSpan,
    waitstateFixedWriteRanges: waitstateFixedWriteRangesForLayout(bytes, options.waitstate || {}),
  };
  const representativePayloadOffset = PATCH_BLOCK_ALIGNMENT - descriptor.payloadSize;
  const layout = layoutJournalAddonsBeforePayload(representativePayloadOffset, plan);
  return { ...plan, totalSpan: representativePayloadOffset - layout.prefixOffset };
}

function layoutJournalAddonsBeforePayload(payloadOffset, plan) {
  let cursor = payloadOffset;
  let irqPayloadOffset = null;
  let waitstatePayloadOffset = null;
  let rtcPayloadOffset = null;

  if (plan.irqSpan) {
    cursor = alignDown(cursor - plan.irqSpan, 0x100);
    irqPayloadOffset = cursor;
  }
  if (plan.waitstateSpan) {
    cursor = alignDown(cursor - plan.waitstateSpan, 0x100);
    waitstatePayloadOffset = cursor;
  }
  if (plan.rtcSpan) {
    cursor = alignDown(cursor - plan.rtcSpan, 0x100);
    rtcPayloadOffset = cursor;
  }
  return { rtcPayloadOffset, waitstatePayloadOffset, irqPayloadOffset, prefixOffset: cursor };
}

function preparedJournalAddonLayout(patched, plan) {
  const journalPatch = patched.result.flashJournal;
  const payloadOffset = journalPatch?.payloadOffset;
  if (!Number.isInteger(payloadOffset)) return {};
  const blockStart = alignDown(payloadOffset, PATCH_BLOCK_ALIGNMENT);
  const ceiling = payloadOffset;
  const layout = layoutJournalAddonsBeforePayload(ceiling, plan);
  if (layout.prefixOffset < blockStart) return {};
  if (!isFreeRegion(patched.bytes, layout.prefixOffset, ceiling - layout.prefixOffset)) return {};
  return layout;
}

function applyStandaloneAddonPatches(patched, options = {}, context = {}) {
  // Target layout without Batteryless SRAM: [last ROM data] [Fake RTC] [Waitstate] [Shared IRQ] [free space].
  const excludedRanges = [...(context.excludedRanges || [])].filter(validRange);
  patched = applyRtcStandalonePatch(patched, options.rtc, {
    excludedRanges,
    payloadOffset: context.rtcPayloadOffset,
  });
  const rtcRange = payloadRange(patched.result.rtc, patched.result.rtc?.payloadOffset);
  if (rtcRange) excludedRanges.push(rtcRange);

  const waitstateExcludedRanges = [...(context.waitstateExcludedRanges || excludedRanges)];
  if (rtcRange) waitstateExcludedRanges.push(rtcRange);
  patched = applyWaitstateStandalonePatch(patched, options.waitstate, {
    excludedRanges: waitstateExcludedRanges,
    waitstatePayloadOffset: context.waitstatePayloadOffset,
  });
  const waitstateRange = payloadRange(patched.result.waitstate, patched.result.waitstate?.payloadOffset);
  if (waitstateRange) excludedRanges.push(waitstateRange);

  const rtcMenuEntry = patched.result.rtc?.runtimeMenuEntry || 0;
  const saveFlushEntry = context.saveFlushEntry || 0;
  if (rtcMenuEntry || saveFlushEntry) {
    ensureResultArrays(patched);
    const operationCountBeforeIrq = patched.result.operations.length;
    const rom = { bytes: patched.bytes };
    const irqHandler = applyIrqHandlerForPipeline(rom, patched.result.operations, patched.result.warnings, {
      enabled: true,
      rtcMenuEntry,
      saveFlushEntry,
      saveFlushAuto: context.saveFlushAuto === true,
      saveFlushHotkey: context.saveFlushHotkey !== false,
      countdownFrames: context.countdownFrames || 0,
      indicatorMode: context.indicatorMode || "off",
      hotkeyMask: context.hotkeyMask ?? options.batteryless?.hotkeyMask,
    }, {
      excludedRanges,
      payloadOffset: context.irqPayloadOffset ?? null,
    });
    patched.bytes = rom.bytes;
    patched.result.irqHandler = irqHandler;
    if (patched.result.operations.length > operationCountBeforeIrq) patched.result.status = "patched";
  }
  return patched;
}

function targetHeaderSaveMetadata(patched, options, sourceSaveMetadata) {
  if (options.patchMode === "sram") {
    return { medium: "sram", size: sourceSaveMetadata.size, batteryless: false };
  }
  if (options.patchMode === "batteryless-sram") {
    return {
      medium: "sram",
      size: patched.result.batteryless?.saveSize ?? sourceSaveMetadata.size,
      batteryless: true,
    };
  }
  if (options.patchMode === "flash512k") {
    return { medium: "flash", size: 65536, batteryless: false };
  }
  if (options.patchMode === "custom-flash") {
    return {
      medium: "flash",
      size: patched.result.targetSaveSizeBytes ?? sourceSaveMetadata.size,
      batteryless: false,
    };
  }
  return { medium: sourceSaveMetadata.medium, size: sourceSaveMetadata.size, batteryless: false };
}

function finalizeHeaderChecksum(patched, options, sourceSaveMetadata) {
  ensureResultArrays(patched);
  const hasPatchOperations = patched.result.operations.length > 0;
  if (hasPatchOperations) {
    const saveMetadata = targetHeaderSaveMetadata(patched, options, sourceSaveMetadata);
    const headerFlags = makePatchHeaderFlags({
      saveMedium: saveMetadata.medium,
      saveSize: saveMetadata.size,
      batteryless: saveMetadata.batteryless,
      waitstateResult: patched.result.waitstate,
      rtcResult: patched.result.rtc,
    });
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
    || result?.flashJournal?.journal?.flushEntry,
  );
}

function ensureJournalReserveIntegrity(patched) {
  const journal = patched.result?.flashJournal?.journal;
  if (!journal) return;
  const tailStart = journal.offset + journal.activeSize;
  const tailEnd = journal.offset + journal.reservedSize;
  if (tailStart < journal.offset || tailEnd > patched.bytes.length) {
    throw new Error("Journal reserve is truncated after add-on installation.");
  }
  for (let offset = tailStart; offset < tailEnd; offset += 1) {
    if (patched.bytes[offset] !== 0xff) throw new Error("Journal inactive reserve tail was modified by an add-on.");
  }
}

function ensureSuccessfulPatch(result, options = {}) {
  if (result?.batteryless?.status === "failed") throw new Error(failureWarning(result, "Batteryless SRAM:"));
  if (options.patchMode === "sram" && ["failed", "unsupported"].includes(result?.savePatch?.status)) throw new Error(firstWarning(result));
  if (result?.irqHandler?.status === "failed" && sharedIrqIsRequired(result)) throw new Error(failureWarning(result, "Shared IRQ:"));
  if (result?.status === "unsupported") throw new Error(firstWarning(result));
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
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
    let patched;

    if (message.options.patchMode === "flash512k") {
      const flash512kOptions = message.options.flash512k || {};
      const countdownFrames = Number.isInteger(flash512kOptions.countdownFrames) ? flash512kOptions.countdownFrames : 100;
      const indicatorMode = flash512kOptions.indicator || "save";
      const addonPlan = planJournalAddons(romBytes, message.options, STANDARD_JOURNAL_DESCRIPTOR);
      patched = patchFlash512kBytes(romBytes, {
        countdownFrames,
        indicatorMode,
        addonPrefixSize: addonPlan.totalSpan,
        placementExcludedRanges: addonPlan.waitstateFixedWriteRanges,
        keepLastBlockEmpty: message.options.batteryless?.lastBlock === "keep-empty",
        deferHeaderFinalization: true,
      });
      const journal = patched.result.flashJournal?.journal;
      const effectiveCountdownFrames = journal?.countdownFrames ?? countdownFrames;
      const effectiveIndicatorMode = journal?.indicatorMode ?? indicatorMode;
      const addonLayout = journal ? preparedJournalAddonLayout(patched, addonPlan) : {};
      patched = applyStandaloneAddonPatches(patched, message.options, {
        excludedRanges: journalWaitstateExcludedRanges(patched.result),
        waitstateExcludedRanges: journalWaitstateExcludedRanges(patched.result),
        saveFlushEntry: journal?.flushEntry || 0,
        saveFlushAuto: Boolean(journal?.flushEntry),
        saveFlushHotkey: false,
        countdownFrames: effectiveCountdownFrames,
        indicatorMode: effectiveIndicatorMode,
        hotkeyMask: message.options.batteryless?.hotkeyMask,
        ...addonLayout,
      });
    } else if (message.options.patchMode === "custom-flash") {
      const flash512kOptions = message.options.flash512k || {};
      const countdownFrames = Number.isInteger(flash512kOptions.countdownFrames) ? flash512kOptions.countdownFrames : 100;
      const indicatorMode = flash512kOptions.indicator || "save";
      const addonPlan = planJournalAddons(romBytes, message.options, CUSTOM_JOURNAL_DESCRIPTOR);
      patched = patchCustomFlashBytes(romBytes, {
        saveChipType: message.options.customFlash?.saveChipType,
        countdownFrames,
        indicatorMode,
        addonPrefixSize: addonPlan.totalSpan,
        placementExcludedRanges: addonPlan.waitstateFixedWriteRanges,
        keepLastBlockEmpty: message.options.batteryless?.lastBlock === "keep-empty",
        deferHeaderFinalization: true,
      });
      const journal = patched.result.flashJournal?.journal;
      if (journal) {
        const addonLayout = preparedJournalAddonLayout(patched, addonPlan);
        patched = applyStandaloneAddonPatches(patched, message.options, {
          excludedRanges: journalWaitstateExcludedRanges(patched.result),
          waitstateExcludedRanges: journalWaitstateExcludedRanges(patched.result),
          saveFlushEntry: journal.flushEntry,
          saveFlushAuto: true,
          saveFlushHotkey: false,
          countdownFrames: journal.countdownFrames,
          indicatorMode: journal.indicatorMode,
          ...addonLayout,
        });
      } else {
        patched = applyStandaloneAddonPatches(patched, message.options);
      }
    } else if (message.options.patchMode === "none") {
      patched = { bytes: romBytes, result: { operations: [], warnings: [], status: "unchanged" } };
      patched = applyStandaloneAddonPatches(patched, message.options);
    } else if (["sram", "batteryless-sram"].includes(message.options.patchMode)) {
      patched = patchSramBytes(romBytes, {
        batteryless: message.options.patchMode === "batteryless-sram",
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

    ensureJournalReserveIntegrity(patched);
    const contractPreview = normalizePatchResult(patched.result);
    if (!["none", "flash1m"].includes(contractPreview.bankSwitchMode)) {
      throw new Error("Internal patch plan selected an invalid bank-switch mode.");
    }
    if (contractPreview.bankSwitchMode === "flash1m" && contractPreview.targetSaveSizeBytes !== 131072) {
      throw new Error("Internal patch plan selected FLASH1M banking for a non-128 KiB target.");
    }
    if (contractPreview.flashJournal && contractPreview.bankSwitchMode !== "none") {
      throw new Error("Internal patch plan selected bank switching for a journal target.");
    }
    if (["flash512k", "custom-flash"].includes(message.options.patchMode)
        && contractPreview.bankSwitchMode !== "flash1m"
        && contractPreview.operations?.some((operation) => operation.kind === PATCH_OPERATION_KIND.BANK_SWITCH_PATCH)) {
      throw new Error("Internal patch plan contains a bank-switch operation for a non-FLASH1M target.");
    }
    ensureSuccessfulPatch(patched.result, message.options);
    patched = finalizeHeaderChecksum(patched, message.options, sourceSaveMetadata);
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
    self.postMessage({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      type: WORKER_MESSAGE_TYPE.PATCH_COMPLETED,
      requestId: message.requestId,
      outputFileName: message.outputFileName,
      patchedBuffer: patched.bytes.buffer,
      result: patched.result,
    }, [patched.bytes.buffer]);
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
