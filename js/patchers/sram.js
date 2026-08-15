// SPDX-License-Identifier: GPL-3.0-or-later AND MIT

import {
  cachedHexToBytes,
  findBytes,
  hexToBytes,
} from "../core/binary.js";
import { PatchError } from "../core/errors.js";
import { addPrefixGuardToRanges, findTailBlankRegion } from "../core/ranges.js";
import { GBA_PAYLOAD_PLACEMENT_LIMIT_BYTES } from "../domain/gba-constants.js";
import { PATCH_REASON_CODE } from "../domain/constants.js";
import { applyWaitstateForPipeline, planWaitstateForLayout } from "./waitstate.js";
import {
  applyRtcForPipeline,
  rtcPayloadSpanForLayout,
  RTC_PAYLOAD_SIZE,
  RTC_PERSISTENCE_MAPPER_CLEANUP_FLAG,
  RTC_PERSISTENCE_SHARED_SAVE_AREA_FLAG,
} from "./rtc.js";
import { applyIrqHandlerForPipeline, IRQ_HANDLER_PAYLOAD_SIZE, irqHandlerPayloadSpanForLayout } from "./irq-handler.js";
import { applyPatchHeaderMarker, makePatchHeaderFlags, PATCH_SAVE_MEDIUM, updateGbaHeaderChecksum } from "./patch-state.js";
import {
  PATCH_BY_SAVE_TYPE,
  SRAM_CONSTANTS,
} from "./sram-data.js";
import { alignedPayloadSpan } from "./payload-placement.js";
import { ensureStandaloneRtcPersistenceLayout } from "./rtc-persistence-placement.js";
import { findStartupRomCopySourceRanges } from "./startup-rom-copy-ranges.js";
import { detectRomSaveMetadata, findSaveType } from "./save-type.js";
import {
  BATTERYLESS_LAST_BLOCK_KEEP_EMPTY,
  FLASH1M_BANK_SWITCH_STYLE_MODERN,
  applyBatterylessPatch,
  batterylessPatchExcludedRanges,
  batterylessPayloadForStyle,
  batterylessSaveOffset,
  embedSaveFile,
  ensureBatterylessLayout,
  ensureNonBatterylessAddonLayout,
  inferredBatterylessSaveSize,
  normalizeBatterylessLastBlock,
  normalizeFlash1mBankSwitchStyle,
  rangeForSpan,
  routeBatterylessBootVector,
  resolveFlash1mBankSwitchWriteInfo,
} from "./batteryless-sram.js";
import { writeSramCode, writeSramU32Value } from "./sram-common.js";

const C = SRAM_CONSTANTS;
const firstBytePatternCache = new Map();

function firstBytePattern(value) {
  let pattern = firstBytePatternCache.get(value);
  if (!pattern) {
    pattern = new Uint8Array([value]);
    firstBytePatternCache.set(value, pattern);
  }
  return pattern;
}

function firstCheckedByte(identifier) {
  const check = identifier.checks.find(([offset]) => offset === 0);
  if (!check) throw new PatchError(`${identifier.name}: missing offset-0 identifier`);
  return check[1];
}

function findMatch(bytes, identifier, start = 1) {
  if (identifier.marker) {
    const pos = findBytes(bytes, cachedHexToBytes(identifier.marker), start);
    return pos < 0 ? null : pos;
  }

  const firstByte = firstCheckedByte(identifier);
  const minOffset = Math.min(...identifier.checks.map(([offset]) => offset));
  const maxOffset = Math.max(...identifier.checks.map(([offset]) => offset));
  let pos = Math.max(start, -minOffset, 1);
  const maxPos = bytes.length - maxOffset;
  const first = firstBytePattern(firstByte);

  while (pos < maxPos) {
    pos = findBytes(bytes, first, pos, maxPos);
    if (pos < 0 || pos >= maxPos) return null;
    if (pos + minOffset >= 0 && identifier.checks.every(([offset, value]) => bytes[pos + offset] === value)) return pos;
    pos += 1;
  }
  return null;
}

function findIdentifierMatches(data, identifier, matchAll) {
  const matchOffsets = [];
  let searchStart = 1;
  while (true) {
    const matchOffset = findMatch(data, identifier, searchStart);
    if (matchOffset === null) break;
    matchOffsets.push(matchOffset);
    if (matchAll === false) break;
    searchStart = matchOffset + 1;
  }
  return matchOffsets;
}

function planSimplePatch(data, patchInfo, warnings) {
  const steps = [];
  for (const step of patchInfo.steps) {
    const matchOffsets = findIdentifierMatches(data, step.identifier, patchInfo.match_all);
    if (!matchOffsets.length) {
      warnings.push(`${step.name}: identifier not found`);
      return { ok: false, reasonCode: PATCH_REASON_CODE.INCOMPLETE_HOOK_SET };
    }
    steps.push({ step, matchOffsets });
  }
  return { ok: true, steps };
}

function applySimplePatch(out, plan, operations, flash1mBankSwitchStyle = FLASH1M_BANK_SWITCH_STYLE_MODERN) {
  for (const { step, matchOffsets } of plan.steps) {
    for (const matchOffset of matchOffsets) {
      for (const writeInfo of step.writes) {
        const resolvedWriteInfo = resolveFlash1mBankSwitchWriteInfo(writeInfo, flash1mBankSwitchStyle);
        writeSramCode(out, matchOffset + (resolvedWriteInfo.target_add || 0), resolvedWriteInfo, operations, step.name);
      }
    }
  }
  return { ok: true };
}

function targetBase(writeInfo, hookOffset, injectionOffset) {
  if (writeInfo.base === "hook") return hookOffset;
  if (writeInfo.base === "injection") return injectionOffset;
  throw new PatchError(`Unknown patch base: ${writeInfo.base}`);
}

function dynamicU32Value(valueName, hookOffset, injectionOffset) {
  if (valueName === "injection_address") return (C.GBA_ROM_BASE + injectionOffset + 1) >>> 0;
  if (valueName === "return_address") return (C.GBA_ROM_BASE + hookOffset + 0x21) >>> 0;
  throw new PatchError(`Unknown dynamic u32 value: ${valueName}`);
}

function planTailHookMatches(data, patchInfo, warnings) {
  const hookOffsets = findIdentifierMatches(data, patchInfo.identifier, patchInfo.match_all);
  if (!hookOffsets.length) {
    warnings.push(`${patchInfo.name}: hook identifier not found`);
    return { ok: false, reasonCode: PATCH_REASON_CODE.INCOMPLETE_HOOK_SET };
  }
  return { ok: true, hookOffsets };
}

function applyTailTrampolinePatch(out, patchInfo, hookPlan, operations, warnings, excludedRanges = []) {
  const allocatedRanges = [...excludedRanges];
  const placements = [];
  for (const hookOffset of hookPlan.hookOffsets) {
    const injectionOffset = findTailBlankRegion(
      out,
      patchInfo.injection_size,
      16,
      GBA_PAYLOAD_PLACEMENT_LIMIT_BYTES,
      allocatedRanges,
    );
    if (injectionOffset === null) {
      warnings.push(`${patchInfo.name}: no free tail area for trampoline`);
      return { ok: false, reasonCode: PATCH_REASON_CODE.ROM_CAPACITY };
    }
    allocatedRanges.push([injectionOffset, injectionOffset + patchInfo.injection_size]);
    placements.push({ hookOffset, injectionOffset });
  }

  for (const { hookOffset, injectionOffset } of placements) {
    for (const writeInfo of patchInfo.writes) {
      const targetOffset = targetBase(writeInfo, hookOffset, injectionOffset) + (writeInfo.target_add || 0);
      if (writeInfo.hex) writeSramCode(out, targetOffset, writeInfo, operations);
      else writeSramU32Value(out, targetOffset, dynamicU32Value(writeInfo.u32_value, hookOffset, injectionOffset), operations, writeInfo.name);
    }
  }
  return { ok: true };
}

function makeResult(
  saveType,
  status,
  operations,
  warnings,
  batteryless = null,
  waitstate = null,
  saveEmbedded = false,
  rtc = null,
  irqHandler = null,
  savePatch = null,
) {
  const result = { saveType, status, changed: operations.length > 0, operations, warnings };
  if (savePatch !== null) result.savePatch = savePatch;
  if (batteryless !== null) result.batteryless = batteryless;
  if (waitstate !== null) result.waitstate = waitstate;
  if (rtc !== null) result.rtc = rtc;
  if (irqHandler !== null) result.irqHandler = irqHandler;
  if (saveEmbedded) result.saveEmbedded = true;
  return result;
}

function createSramPatchContext(inputBytes, options) {
  const originalData = new Uint8Array(inputBytes);
  const saveType = options.saveTypeOverride || findSaveType(originalData);
  const sourceSaveMetadata = detectRomSaveMetadata(originalData, saveType);
  const batteryless = options.batteryless === true;
  const waitstate = options.waitstate?.enabled === true;
  const rtc = options.rtc?.enabled === true;
  const rtcPersistenceEnabled = rtc && options.rtc?.saveOnGlobalHotkey !== false;
  const rtcPayloadSpan = rtc ? rtcPayloadSpanForLayout() : 0;
  const startupRomCopySourceRanges = findStartupRomCopySourceRanges(originalData);
  const waitstatePlan = waitstate
    ? planWaitstateForLayout(originalData, options.waitstate, startupRomCopySourceRanges)
    : null;
  const waitstatePayloadSpan = waitstatePlan?.totalPayloadSpan || 0;
  const flash1mBankSwitchStyle = normalizeFlash1mBankSwitchStyle(options.flash1mBankSwitchStyle);
  const selectedBatterylessPayload = batterylessPayloadForStyle(flash1mBankSwitchStyle);
  return {
    rom: { bytes: new Uint8Array(inputBytes) },
    originalData,
    options,
    saveType,
    sourceSaveMetadata,
    operations: [],
    warnings: [],
    patchInfo: null,
    batterylessResult: null,
    waitstateResult: null,
    rtcResult: null,
    irqHandlerResult: null,
    batterylessPayloadOffset: null,
    rtcPayloadOffset: null,
    waitstatePayloadOffset: null,
    irqHandlerPayloadOffset: null,
    rtcPlacement: null,
    batterylessPrefixSize: 0,
    batterylessExcludedRanges: [],
    rtcExcludedRanges: [],
    waitstateExcludedRanges: [],
    irqHandlerExcludedRanges: [],
    rtcPersistenceExcludedRanges: [],
    rtcPersistenceBlockOffset: null,
    rtcPersistenceRange: null,
    skipSavePatch: false,
    sramPatchApplied: false,
    savePatchReasonCode: null,
    savePatchPlan: null,
    saveEmbedded: false,
    batteryless,
    waitstate,
    rtc,
    rtcPersistenceEnabled,
    rtcPayloadSpan,
    waitstatePlan,
    waitstatePayloadSpan,
    waitstateFixedWriteRanges: waitstatePlan?.fixedWriteRanges || [],
    startupRomCopySourceRanges,
    batterylessMode: options.batterylessMode || "auto",
    batterylessCountdown: options.batterylessCountdown ?? C.BATTERYLESS_DEFAULT_COUNTDOWN,
    batterylessIndicatorMode: options.batterylessIndicatorMode || "off",
    batterylessHotkeyMask: options.batterylessHotkeyMask,
    flash1mBankSwitchStyle,
    selectedBatterylessPayload,
    activeBatterylessPayload: selectedBatterylessPayload,
    keepBatterylessLastBlockEmpty: normalizeBatterylessLastBlock(options.batterylessLastBlock)
      === BATTERYLESS_LAST_BLOCK_KEEP_EMPTY,
    plannedBatterylessSaveSize: sourceSaveMetadata.size || inferredBatterylessSaveSize(saveType),
    batterylessWaitstatePrefixSize: batteryless ? waitstatePayloadSpan : 0,
    batterylessIrqPrefixSize: batteryless
      ? irqHandlerPayloadSpanForLayout()
      : 0,
  };
}

function payloadPlacementExcludedRanges(context) {
  return [
    ...context.waitstateFixedWriteRanges,
    ...context.startupRomCopySourceRanges,
  ];
}

function unsupportedSramResult(context, saveType) {
  const reasonCode = context.savePatchReasonCode || PATCH_REASON_CODE.UNSUPPORTED_SAVE_TYPE;
  return {
    bytes: new Uint8Array(context.originalData),
    result: makeResult(
      saveType,
      "unsupported",
      [],
      context.warnings,
      context.batterylessResult,
      null,
      false,
      null,
      null,
      {
        requested: true,
        status: "unsupported",
        reasonCode,
      },
    ),
  };
}

function resolveSramPatchInfo(context) {
  if (context.saveType === null) {
    if (context.batteryless && context.batterylessResult === null) {
      context.warnings.push("No known GBA save type found");
      context.savePatchReasonCode = PATCH_REASON_CODE.AMBIGUOUS_SAVE_TYPE;
      context.batterylessResult = {
        requested: true,
        mode: context.batterylessMode,
        status: "failed",
        countdown: context.batterylessCountdown,
        indicatorMode: context.batterylessIndicatorMode,
        reasonCode: PATCH_REASON_CODE.AMBIGUOUS_SAVE_TYPE,
      };
      return atomicSaveConversionFailure(context);
    } else if (!context.waitstate && !context.rtc && !context.skipSavePatch) {
      context.warnings.push("No known GBA save type found");
      context.savePatchReasonCode = PATCH_REASON_CODE.AMBIGUOUS_SAVE_TYPE;
      return unsupportedSramResult(context, null);
    }
    return null;
  }
  context.patchInfo = PATCH_BY_SAVE_TYPE[context.saveType] || null;
  if (context.patchInfo !== null) return null;
  if (context.batteryless && context.batterylessResult === null) {
    context.warnings.push(`${context.saveType} is not supported by the SRAM patcher`);
    context.savePatchReasonCode = PATCH_REASON_CODE.UNSUPPORTED_SAVE_TYPE;
    context.batterylessResult = {
      requested: true,
      mode: context.batterylessMode,
      status: "failed",
      countdown: context.batterylessCountdown,
      indicatorMode: context.batterylessIndicatorMode,
      reasonCode: PATCH_REASON_CODE.UNSUPPORTED_SAVE_TYPE,
    };
    return atomicSaveConversionFailure(context);
  } else if (!context.waitstate && !context.rtc && !context.skipSavePatch) {
    context.warnings.push(`${context.saveType} is not supported by the SRAM patcher`);
    context.savePatchReasonCode = PATCH_REASON_CODE.UNSUPPORTED_SAVE_TYPE;
    return unsupportedSramResult(context, context.saveType);
  }
  return null;
}

function assignPlannedBatterylessLayout(context, layout, rtcSpan) {
  context.batterylessPayloadOffset = layout.payloadBase;
  context.batterylessPrefixSize = layout.prefixLayout.prefixSize;
  context.batterylessExcludedRanges = batterylessPatchExcludedRanges(
    layout.payloadBase,
    layout.prefixLayout.prefixSize,
    context.selectedBatterylessPayload,
    context.plannedBatterylessSaveSize,
  );
  if (rtcSpan) {
    context.rtcPayloadOffset = layout.prefixLayout.rtcOffset;
    context.rtcPlacement = "before-batteryless";
    context.rtcExcludedRanges = rangeForSpan(context.rtcPayloadOffset, rtcSpan);
  }
  if (context.batterylessWaitstatePrefixSize) {
    context.waitstatePayloadOffset = layout.prefixLayout.waitstateOffset;
    context.waitstateExcludedRanges = rangeForSpan(
      context.waitstatePayloadOffset,
      context.batterylessWaitstatePrefixSize,
    );
  }
  if (context.batterylessIrqPrefixSize) {
    context.irqHandlerPayloadOffset = layout.prefixLayout.irqOffset;
    context.irqHandlerExcludedRanges = rangeForSpan(
      context.irqHandlerPayloadOffset,
      context.batterylessIrqPrefixSize,
    );
  }
}

function planBatterylessLayout(context) {
  if (!context.batteryless) return true;
  if (context.batterylessResult !== null) {
    return context.batterylessResult.status !== "failed";
  }
  const rtcSpan = context.rtc && context.rtcResult === null
    ? context.rtcPayloadSpan
    : 0;
  const layout = ensureBatterylessLayout(
    context.rom,
    context.operations,
    context.warnings,
    context.selectedBatterylessPayload,
    rtcSpan,
    context.batterylessWaitstatePrefixSize,
    context.batterylessIrqPrefixSize,
    context.keepBatterylessLastBlockEmpty,
    payloadPlacementExcludedRanges(context),
  );
  if (layout === null) {
    context.savePatchReasonCode = PATCH_REASON_CODE.ROM_CAPACITY;
    context.batterylessResult = {
      requested: true,
      mode: context.batterylessMode,
      status: "failed",
      countdown: context.batterylessCountdown,
      indicatorMode: context.batterylessIndicatorMode,
      reasonCode: PATCH_REASON_CODE.ROM_CAPACITY,
    };
    return false;
  }
  assignPlannedBatterylessLayout(context, layout, rtcSpan);
  return true;
}

function planSaveConversion(context) {
  if (context.patchInfo === null || context.skipSavePatch) return true;
  if (context.patchInfo.type === "simple") {
    context.savePatchPlan = planSimplePatch(
      context.originalData,
      context.patchInfo,
      context.warnings,
    );
  } else if (context.patchInfo.type === "tail_trampoline") {
    context.savePatchPlan = planTailHookMatches(
      context.originalData,
      context.patchInfo,
      context.warnings,
    );
  } else if (context.patchInfo.type === "already_sram") {
    context.savePatchPlan = { ok: true };
  } else {
    context.warnings.push(`${context.patchInfo.name}: unknown patch type`);
    context.savePatchPlan = {
      ok: false,
      reasonCode: PATCH_REASON_CODE.UNSUPPORTED_SAVE_TYPE,
    };
  }
  if (context.savePatchPlan.ok) return true;
  context.savePatchReasonCode = context.savePatchPlan.reasonCode;
  return false;
}

function atomicSaveConversionFailure(context) {
  const reasonCode = context.savePatchReasonCode
    || context.batterylessResult?.reasonCode
    || null;
  const savePatch = { requested: true, status: "failed" };
  if (reasonCode) savePatch.reasonCode = reasonCode;
  const batteryless = context.batteryless ? {
    ...(context.batterylessResult || {}),
    requested: true,
    mode: context.batterylessMode,
    status: "failed",
    countdown: context.batterylessCountdown,
    indicatorMode: context.batterylessIndicatorMode,
  } : null;
  if (batteryless && reasonCode) batteryless.reasonCode = reasonCode;
  return {
    bytes: new Uint8Array(context.originalData),
    result: makeResult(
      context.saveType,
      "unsupported",
      [],
      context.warnings,
      batteryless,
      null,
      false,
      null,
      null,
      savePatch,
    ),
  };
}

function applySaveConversion(context) {
  if (context.patchInfo === null || context.skipSavePatch) return true;
  const operationCount = context.operations.length;
  let applied = { ok: true };
  if (context.patchInfo.type === "simple") {
    applied = applySimplePatch(
      context.rom.bytes,
      context.savePatchPlan,
      context.operations,
      context.flash1mBankSwitchStyle,
    );
  } else if (context.patchInfo.type === "tail_trampoline") {
    const excluded = [
      ...context.batterylessExcludedRanges,
      ...context.rtcExcludedRanges,
      ...context.waitstateExcludedRanges,
      ...context.irqHandlerExcludedRanges,
    ];
    applied = applyTailTrampolinePatch(
      context.rom.bytes,
      context.patchInfo,
      context.savePatchPlan,
      context.operations,
      context.warnings,
      addPrefixGuardToRanges(excluded, C.TAIL_TRAMPOLINE_EXCLUDED_PREFIX_GUARD),
    );
  } else if (context.patchInfo.type !== "already_sram") {
    context.warnings.push(`${context.patchInfo.name}: unknown patch type`);
  }
  if (!applied.ok) {
    context.savePatchReasonCode = applied.reasonCode;
    return false;
  }
  context.sramPatchApplied = context.operations.length > operationCount;
  return true;
}

function planNonBatterylessAddons(context) {
  if (context.batteryless) return;
  const rtcSpan = context.rtc && context.rtcResult === null
    ? context.rtcPayloadSpan
    : 0;
  const waitstateSpan = context.waitstate && context.waitstateResult === null
    ? context.waitstatePayloadSpan
    : 0;
  if (rtcSpan && context.rtcPersistenceEnabled) {
    const layout = ensureStandaloneRtcPersistenceLayout(
      context.rom,
      context.operations,
      context.warnings,
      {
        rtcSpan,
        waitstateSpan,
        irqSpan: irqHandlerPayloadSpanForLayout(),
      },
      payloadPlacementExcludedRanges(context),
    );
    if (layout === null) {
      context.rtcResult = { requested: true, status: "failed", size: RTC_PAYLOAD_SIZE };
      return;
    }
    context.rtcPayloadOffset = layout.rtcPayloadOffset;
    context.rtcPlacement = "before-rtc-persistence";
    context.rtcExcludedRanges = rangeForSpan(layout.rtcPayloadOffset, rtcSpan);
    context.waitstatePayloadOffset = waitstateSpan ? layout.waitstatePayloadOffset : null;
    context.waitstateExcludedRanges = rangeForSpan(layout.waitstatePayloadOffset, waitstateSpan);
    context.irqHandlerPayloadOffset = layout.irqPayloadOffset;
    context.irqHandlerExcludedRanges = rangeForSpan(
      layout.irqPayloadOffset,
      irqHandlerPayloadSpanForLayout(),
    );
    context.rtcPersistenceBlockOffset = layout.persistenceBlockOffset;
    context.rtcPersistenceRange = layout.persistenceRange;
    context.rtcPersistenceExcludedRanges = [layout.persistenceRange];
    return;
  }
  const layout = ensureNonBatterylessAddonLayout(
    context.rom,
    context.operations,
    context.warnings,
    rtcSpan,
    waitstateSpan,
    payloadPlacementExcludedRanges(context),
  );
  if (layout === null) {
    if (rtcSpan) context.rtcResult = { requested: true, status: "failed", size: RTC_PAYLOAD_SIZE };
    if (waitstateSpan) {
      context.waitstateResult = {
        requested: true,
        status: "failed",
        value: context.options.waitstate?.value ?? C.WAITSTATE_DEFAULT_VALUE,
        directWrites: 0,
      };
    }
    return;
  }
  if (rtcSpan) {
    context.rtcPayloadOffset = layout.rtcOffset;
    context.rtcPlacement = "after-original-data";
    context.rtcExcludedRanges = rangeForSpan(layout.rtcOffset, rtcSpan);
  }
  if (waitstateSpan) {
    context.waitstatePayloadOffset = layout.waitstateOffset;
    context.waitstateExcludedRanges = rangeForSpan(layout.waitstateOffset, waitstateSpan);
  }
}

function applyRtcAndBatteryless(context) {
  if (context.rtc && context.rtcResult === null) {
    context.rtcResult = applyRtcForPipeline(
      context.rom,
      context.operations,
      context.warnings,
      context.options.rtc,
      {
        payloadOffset: context.rtcPayloadOffset,
        placement: context.rtcPlacement,
        excludedRanges: [
          ...context.batterylessExcludedRanges,
          ...context.rtcExcludedRanges,
          ...context.waitstateExcludedRanges,
          ...context.irqHandlerExcludedRanges,
          ...context.rtcPersistenceExcludedRanges,
        ],
        persistenceBlockOffset: context.rtcPersistenceEnabled
          ? (context.batterylessPayloadOffset === null
            ? context.rtcPersistenceBlockOffset
            : batterylessSaveOffset(context.batterylessPayloadOffset, context.selectedBatterylessPayload))
          : null,
        persistenceFlags: context.rtcPersistenceEnabled
          ? (context.flash1mBankSwitchStyle === FLASH1M_BANK_SWITCH_STYLE_MODERN
            ? RTC_PERSISTENCE_MAPPER_CLEANUP_FLAG
            : 0)
            | (context.batterylessPayloadOffset !== null
              ? RTC_PERSISTENCE_SHARED_SAVE_AREA_FLAG
              : 0)
          : 0,
      },
    );
  }
  if (context.batteryless && context.batterylessResult === null) {
    context.batterylessResult = applyBatterylessPatch(
      context.rom,
      context.operations,
      context.warnings,
      context.batterylessMode,
      context.saveType,
      context.batterylessCountdown,
      context.batterylessIndicatorMode,
      context.flash1mBankSwitchStyle,
      context.batterylessPayloadOffset,
      context.batterylessPrefixSize,
      context.keepBatterylessLastBlockEmpty,
      context.sourceSaveMetadata.size,
      context.rtcResult?.persistenceFlushEntry || 0,
    );
  }
  if (context.batterylessResult?.payloadOffset !== undefined
      && context.batterylessResult?.payloadOffset !== null) {
    context.batterylessExcludedRanges = batterylessPatchExcludedRanges(
      context.batterylessResult.payloadOffset,
      context.batterylessPrefixSize,
      context.activeBatterylessPayload,
      context.batterylessResult.saveSize,
    );
  }
  if (context.batteryless && context.options.saveBuffer) {
    context.saveEmbedded = embedSaveFile(
      context.rom,
      context.batterylessResult,
      context.options.saveBuffer,
      context.operations,
    );
  }
}

function applySramWaitstate(context) {
  if (context.waitstateResult !== null) return;
  const hasPayload = context.batterylessResult?.payloadOffset !== undefined
    && context.batterylessResult?.payloadOffset !== null;
  const batterylessRanges = hasPayload
    ? batterylessPatchExcludedRanges(
      context.batterylessResult.payloadOffset,
      0,
      context.activeBatterylessPayload,
      context.batterylessResult.saveSize,
    )
    : context.batterylessExcludedRanges;
  context.waitstateResult = applyWaitstateForPipeline(
    context.rom,
    context.operations,
    context.warnings,
    context.options.waitstate,
    {
      excludedRanges: [
        ...batterylessRanges,
        ...context.rtcExcludedRanges,
        ...context.irqHandlerExcludedRanges,
        ...context.rtcPersistenceExcludedRanges,
      ],
      waitstatePayloadOffset: context.waitstatePayloadOffset,
      batterylessPayloadOffset: context.batterylessPayloadOffset,
      batterylessJustPatched: context.batterylessResult?.status === "patched",
      structuralPlan: context.waitstatePlan,
    },
  );
}

function irqExcludedRanges(context) {
  const ranges = [
    ...context.batterylessExcludedRanges,
    ...context.rtcExcludedRanges,
    ...context.waitstateExcludedRanges,
    ...context.irqHandlerExcludedRanges,
    ...context.rtcPersistenceExcludedRanges,
  ];
  if (context.batterylessResult?.payloadOffset !== undefined
      && context.batterylessResult?.payloadOffset !== null) {
    ranges.push(...batterylessPatchExcludedRanges(
      context.batterylessResult.payloadOffset,
      context.batterylessPrefixSize,
      context.activeBatterylessPayload,
      context.batterylessResult.saveSize,
    ));
  }
  if (context.rtcResult?.payloadOffset !== undefined
      && context.rtcResult?.payloadOffset !== null
      && context.rtcResult?.size) {
    ranges.push([
      context.rtcResult.payloadOffset,
      context.rtcResult.payloadOffset
        + (context.rtcResult.payloadSpan ?? rtcPayloadSpanForLayout()),
    ]);
  }
  if (context.waitstateResult?.payloadOffset !== undefined
      && context.waitstateResult?.payloadOffset !== null
      && context.waitstateResult?.size) {
    ranges.push([
      context.waitstateResult.payloadOffset,
      context.waitstateResult.payloadOffset
        + (context.waitstateResult.payloadSpan ?? alignedPayloadSpan(context.waitstateResult.size)),
    ]);
  }
  return ranges;
}

function applySramIrq(context) {
  const rtcMenuEntry = context.rtcResult?.runtimeMenuEntry || 0;
  const rtcTickMode = context.rtcResult?.tickMode;
  const batterylessFlushEntry = context.batterylessResult?.flushEntry || 0;
  const standaloneRtcFlushEntry = batterylessFlushEntry
    ? 0
    : (context.rtcResult?.persistenceFlushEntry || 0);
  const flushEntry = batterylessFlushEntry || standaloneRtcFlushEntry;
  if (context.irqHandlerResult !== null || (!rtcMenuEntry && !flushEntry)) return;
  context.irqHandlerResult = applyIrqHandlerForPipeline(
    context.rom,
    context.operations,
    context.warnings,
    {
      enabled: true,
      rtcMenuEntry,
      rtcTickMode,
      saveFlushEntry: flushEntry,
      saveFlushAuto: Boolean(batterylessFlushEntry && context.batterylessMode === "auto"),
      saveFlushHotkey: Boolean(flushEntry),
      countdownFrames: context.batterylessCountdown,
      indicatorMode: context.batterylessIndicatorMode,
      hotkeyMask: context.batterylessHotkeyMask,
      // Batteryless storage is hydrated universally by its reset boot stub,
      // before the game can access EEPROM, FLASH, or SRAM. Shared IRQ only
      // owns flushing and must not initialize the save a second time.
      startupCallbackEntry: 0,
      // If the IRQ scanner needs a reset bootstrap, it runs after Batteryless
      // hydration and must continue to the real pre-patch entrypoint.
      originalEntrypointOverride: context.batterylessResult?.originalEntrypoint || 0,
    },
    {
      excludedRanges: irqExcludedRanges(context),
      payloadOffset: context.irqHandlerPayloadOffset,
      entrypointSource: context.originalData,
    },
  );
}

function finalizeSramHeader(context) {
  if (context.options.deferHeaderFinalization) return;
  const batterylessApplied = context.batteryless
    && context.batterylessResult?.status === "patched";
  const headerSaveSize = batterylessApplied
    ? context.batterylessResult?.saveSize ?? context.sourceSaveMetadata.size
    : context.sourceSaveMetadata.size;
  if (context.operations.length) {
    const flags = makePatchHeaderFlags({
      saveMedium: PATCH_SAVE_MEDIUM.SRAM,
      saveSize: headerSaveSize,
      batteryless: batterylessApplied,
      waitstateResult: context.waitstateResult,
      rtcResult: context.rtcResult,
    });
    applyPatchHeaderMarker(context.rom.bytes, context.operations, flags);
  }
  updateGbaHeaderChecksum(context.rom.bytes, context.operations);
}

function sramResultStatus(context) {
  if (context.operations.length) return "patched";
  if (context.patchInfo === null) return "unsupported";
  return "unchanged";
}

function savePatchStatus(context) {
  if (context.patchInfo?.type === "already_sram") return "unchanged";
  if (context.sramPatchApplied) return "patched";
  if (context.skipSavePatch) return "skipped";
  if (context.patchInfo === null) return "unsupported";
  return "failed";
}

function completedSramResult(context) {
  const savePatchResult = { requested: true, status: savePatchStatus(context) };
  if (context.patchInfo?.type === "already_sram") savePatchResult.alreadySram = true;
  if (context.savePatchReasonCode) savePatchResult.reasonCode = context.savePatchReasonCode;
  const result = makeResult(
    context.saveType,
    sramResultStatus(context),
    context.operations,
    context.warnings,
    context.batterylessResult,
    context.waitstateResult,
    context.saveEmbedded,
    context.rtcResult,
    context.irqHandlerResult,
    savePatchResult,
  );
  if (context.rtcPersistenceRange) result.reservedRanges = [context.rtcPersistenceRange];
  return {
    bytes: context.rom.bytes,
    result,
  };
}

export function patchSramBytes(inputBytes, options = {}) {
  const context = createSramPatchContext(inputBytes, options);
  const unsupported = resolveSramPatchInfo(context);
  if (unsupported) return unsupported;
  if (!planSaveConversion(context)) return atomicSaveConversionFailure(context);
  if (!planBatterylessLayout(context)) return atomicSaveConversionFailure(context);
  if (!applySaveConversion(context)) return atomicSaveConversionFailure(context);
  planNonBatterylessAddons(context);
  applyRtcAndBatteryless(context);
  if (context.batterylessResult?.status === "failed") {
    context.savePatchReasonCode = context.batterylessResult.reasonCode || null;
    return atomicSaveConversionFailure(context);
  }
  applySramWaitstate(context);
  applySramIrq(context);
  routeBatterylessBootVector(
    context.rom,
    context.operations,
    context.batterylessResult,
    context.waitstateResult,
  );
  finalizeSramHeader(context);
  return completedSramResult(context);
}
