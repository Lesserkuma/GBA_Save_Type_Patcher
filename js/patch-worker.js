import { patchSramBytes } from "./patchers/sram.js";
import { patchCustomFlashBytes } from "./patchers/custom-flash.js";
import { FLASH512K_LAYOUT, patchFlash512kBytes } from "./patchers/flash512k.js";
import { applyWaitstateForPipeline } from "./patchers/waitstate.js";
import { findWaitstatePayloadBase, waitstateFixedWriteRangesForLayout, waitstatePayloadSpanForLayout } from "./patchers/waitstate.js";
import { applyRtcForPipeline, findRtcPayloadBase, RTC_PAYLOAD_SIZE } from "./patchers/rtc.js";
import {
  applyIrqHandlerForPipeline,
  findIrqHandlerPayloadBase,
  irqHandlerPayloadSpanForLayout,
} from "./patchers/irq-handler.js";
import { PATCH_BLOCK_ALIGNMENT, alignDown, alignedPayloadSpan, isFreeRegion } from "./patchers/payload-placement.js";
import { applyPatchHeaderMarker, hasPatchHeaderMarker, makePatchHeaderFlags, readPatchFlags, updateGbaHeaderChecksum } from "./patchers/patch-state.js";
import { detectRomSaveMetadata } from "./patchers/save-type.js";


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
  else if (rtc?.status === "already_patched" && patched.result.status === "unchanged") patched.result.status = "already_rtc";
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
  else if (waitstate?.status === "already_patched" && patched.result.status === "unchanged") patched.result.status = "already_patched";
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

function payloadRange(result) {
  if (!Number.isInteger(result?.payload_offset) || !Number.isInteger(result?.size) || result.size <= 0) return null;
  return [result.payload_offset, result.payload_offset + alignedPayloadSpan(result.size)];
}

function journalWaitstateExcludedRanges(result) {
  const ranges = [];
  const journal = result?.flash512k?.journal;
  const runtimeWriteRanges = journal?.runtime_write_ranges || result?.runtime_write_ranges;
  if (Array.isArray(runtimeWriteRanges)) {
    ranges.push(...runtimeWriteRanges.filter(validRange).map(([start, end]) => [start, end]));
  }

  if (!ranges.length && Number.isInteger(journal?.offset) && Number.isInteger(journal?.active_size) && journal.active_size > 0) {
    ranges.push([journal.offset, journal.offset + journal.active_size]);
  }

  // Older result objects have no active-range metadata. Preserve their
  // conservative behavior instead of allowing writes into an unknown layout.
  if (!ranges.length) {
    const reserved = result?.reserved_ranges || journal?.reserved_ranges;
    if (Array.isArray(reserved)) ranges.push(...reserved.filter(validRange).map(([start, end]) => [start, end]));
  }

  // The generated journal runtime code itself must also remain intact, even
  // though it is read-only at runtime.
  const flash512 = result?.flash512;
  if (Number.isInteger(flash512?.payload_offset) && Number.isInteger(flash512?.payload_size) && flash512.payload_size > 0) {
    ranges.push([flash512.payload_offset, flash512.payload_offset + flash512.payload_size]);
  }
  return ranges;
}

function planJournalAddons(bytes, options = {}) {
  const rtcPayloadBase = findRtcPayloadBase(bytes);
  const waitstatePayloadBase = findWaitstatePayloadBase(bytes);
  const irqPayloadBase = findIrqHandlerPayloadBase(bytes);
  const rtcSpan = options.rtc?.enabled && rtcPayloadBase === null
    ? alignedPayloadSpan(RTC_PAYLOAD_SIZE)
    : 0;
  const waitstateSpan = waitstatePayloadSpanForLayout(bytes, options.waitstate || {}, readPatchFlags(bytes));
  const irqSpan = irqPayloadBase === null ? irqHandlerPayloadSpanForLayout() : 0;
  const plan = {
    rtcSpan,
    waitstateSpan,
    irqSpan,
    existingPayloadBases: [rtcPayloadBase, waitstatePayloadBase, irqPayloadBase]
      .filter((offset) => Number.isInteger(offset)),
    waitstateFixedWriteRanges: waitstateFixedWriteRangesForLayout(bytes, options.waitstate || {}),
  };
  const representativePayloadOffset = PATCH_BLOCK_ALIGNMENT - FLASH512K_LAYOUT.payload_size;
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
  const payloadOffset = patched.result.flash512k?.payload_offset;
  if (!Number.isInteger(payloadOffset)) return {};
  const installedNow = patched.result.operations?.some(
    (operation) => operation.code_name === "flash512k_payload",
  );
  const blockStart = alignDown(payloadOffset, PATCH_BLOCK_ALIGNMENT);
  let ceiling = payloadOffset;
  if (!installedNow) {
    for (const existingBase of plan.existingPayloadBases || []) {
      if (existingBase >= blockStart && existingBase < ceiling) ceiling = existingBase;
    }
  }

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
  const rtcRange = payloadRange(patched.result.rtc);
  if (rtcRange) excludedRanges.push(rtcRange);

  const waitstateExcludedRanges = [...(context.waitstateExcludedRanges || excludedRanges)];
  if (rtcRange) waitstateExcludedRanges.push(rtcRange);
  patched = applyWaitstateStandalonePatch(patched, options.waitstate, {
    excludedRanges: waitstateExcludedRanges,
    waitstatePayloadOffset: context.waitstatePayloadOffset,
  });
  const waitstateRange = payloadRange(patched.result.waitstate);
  if (waitstateRange) excludedRanges.push(waitstateRange);

  const rtcMenuEntry = patched.result.rtc?.runtime_menu_entry || 0;
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
    patched.result.irq_handler = irqHandler;
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
      size: patched.result.batteryless?.save_size ?? sourceSaveMetadata.size,
      batteryless: true,
    };
  }
  if (options.patchMode === "flash512k") {
    return { medium: "flash", size: 65536, batteryless: false };
  }
  if (options.patchMode === "custom-flash") {
    return {
      medium: "flash",
      size: patched.result.logical_save_size ?? sourceSaveMetadata.size,
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
    const headerFlags = makePatchHeaderFlags(patched.bytes, {
      saveMedium: saveMetadata.medium,
      saveSize: saveMetadata.size,
      batteryless: saveMetadata.batteryless,
      waitstateResult: patched.result.waitstate,
      rtcResult: patched.result.rtc,
    });
    applyPatchHeaderMarker(patched.bytes, patched.result.operations, headerFlags);
    patched.result.header_save = { ...saveMetadata, flags: headerFlags };
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

function optionalPatchFailed(result) {
  return result?.waitstate?.status === "failed"
    || result?.rtc?.status === "failed"
    || (result?.irq_handler?.status === "failed" && !sharedIrqIsRequired(result));
}

function sharedIrqIsRequired(result) {
  return Boolean(
    result?.batteryless?.flush_entry
    || result?.flash512k?.journal?.flush_entry,
  );
}

function ensureSuccessfulPatch(result, options = {}) {
  if (result?.batteryless?.status === "failed") throw new Error(failureWarning(result, "Batteryless SRAM:"));
  if (options.patchMode === "sram" && ["failed", "unsupported"].includes(result?.save_patch?.status)) throw new Error(firstWarning(result));
  if (result?.irq_handler?.status === "failed" && sharedIrqIsRequired(result)) throw new Error(failureWarning(result, "Shared IRQ:"));
  if (result?.status === "unsupported") throw new Error(firstWarning(result));
  const optionalOnlyFailure = options.patchMode === "none" && optionalPatchFailed(result);
  if (result?.status === "unchanged" && !result.operations?.length && !optionalOnlyFailure) {
    throw new Error("This ROM could not be patched.");
  }
}

self.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type !== "PATCH_ROM") return;

  try {
    const romBytes = new Uint8Array(message.romBuffer);
    if (hasPatchHeaderMarker(romBytes)) throw new Error("Already patched ROMs cannot be used as source files.");
    const sourceSaveMetadata = detectRomSaveMetadata(romBytes);
    let patched;

    if (message.options.patchMode === "flash512k") {
      const flash512kOptions = message.options.flash512k || {};
      const countdownFrames = Number.isInteger(flash512kOptions.countdownFrames) ? flash512kOptions.countdownFrames : 100;
      const indicatorMode = flash512kOptions.indicator || "save";
      const addonPlan = planJournalAddons(romBytes, message.options);
      patched = patchFlash512kBytes(romBytes, {
        countdownFrames,
        indicatorMode,
        addonPrefixSize: addonPlan.totalSpan,
        placementExcludedRanges: addonPlan.waitstateFixedWriteRanges,
        keepLastBlockEmpty: message.options.batteryless?.lastBlock === "keep-empty",
        deferHeaderFinalization: true,
      });
      const journal = patched.result.flash512k?.journal;
      const effectiveCountdownFrames = journal?.countdown_frames ?? countdownFrames;
      const effectiveIndicatorMode = journal?.indicator_mode ?? indicatorMode;
      const addonLayout = journal ? preparedJournalAddonLayout(patched, addonPlan) : {};
      patched = applyStandaloneAddonPatches(patched, message.options, {
        excludedRanges: journalWaitstateExcludedRanges(patched.result),
        waitstateExcludedRanges: journalWaitstateExcludedRanges(patched.result),
        saveFlushEntry: journal?.flush_entry || 0,
        saveFlushAuto: Boolean(journal?.flush_entry),
        saveFlushHotkey: false,
        countdownFrames: effectiveCountdownFrames,
        indicatorMode: effectiveIndicatorMode,
        hotkeyMask: message.options.batteryless?.hotkeyMask,
        ...addonLayout,
      });
    } else if (message.options.patchMode === "custom-flash") {
      patched = patchCustomFlashBytes(romBytes, {
        saveChipType: message.options.customFlash.saveChipType,
        waitstate: { enabled: false },
        deferHeaderFinalization: true,
      });
      patched = applyStandaloneAddonPatches(patched, message.options);
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

    patched = finalizeHeaderChecksum(patched, message.options, sourceSaveMetadata);
    ensureSuccessfulPatch(patched.result, message.options);
    self.postMessage({
      type: "PATCH_DONE",
      id: message.id,
      outputName: message.outputName,
      patchedBuffer: patched.bytes.buffer,
      result: patched.result,
    }, [patched.bytes.buffer]);
  } catch (error) {
    self.postMessage({ type: "PATCH_ERROR", id: message.id, message: error.message || String(error) });
  }
});
