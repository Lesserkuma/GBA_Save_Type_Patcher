// SPDX-License-Identifier: GPL-3.0-or-later AND MIT

import {
  findBytes,
  hexToBytes,
} from "../core/binary.js";
import { PatchError } from "../core/errors.js";
import { applyWaitstateForPipeline, waitstateFixedWriteRangesForLayout, waitstatePayloadSpanForLayout } from "./waitstate.js";
import {
  applyRtcForPipeline,
  rtcPayloadSpanForLayout,
  RTC_PAYLOAD_SIZE,
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
  resolveFlash1mBankSwitchWriteInfo,
} from "./batteryless-sram.js";
import {
  findTailFreeRegion,
  rangesWithPrefixGuard,
  writeSramCode,
  writeSramU32Value,
} from "./sram-common.js";

export { detectEepromSize, detectRomSaveMetadata, findSaveType } from "./save-type.js";
const C = SRAM_CONSTANTS;
const hexPatternCache = new Map();
const firstBytePatternCache = new Map();

function hexPattern(hex) {
  let pattern = hexPatternCache.get(hex);
  if (!pattern) {
    pattern = hexToBytes(hex);
    hexPatternCache.set(hex, pattern);
  }
  return pattern;
}

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
    const pos = findBytes(bytes, hexPattern(identifier.marker), start);
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

function applySimplePatch(data, out, patchInfo, operations, warnings, flash1mBankSwitchStyle = FLASH1M_BANK_SWITCH_STYLE_MODERN) {
  for (const step of patchInfo.steps) {
    const matchOffsets = [];
    let searchStart = 1;
    while (true) {
      const matchOffset = findMatch(data, step.identifier, searchStart);
      if (matchOffset === null) break;
      matchOffsets.push(matchOffset);
      if (patchInfo.match_all === false) break;
      searchStart = matchOffset + 1;
    }

    if (!matchOffsets.length) {
      warnings.push(`${step.name}: identifier not found`);
      continue;
    }

    for (const matchOffset of matchOffsets) {
      for (const writeInfo of step.writes) {
        const resolvedWriteInfo = resolveFlash1mBankSwitchWriteInfo(writeInfo, flash1mBankSwitchStyle);
        writeSramCode(out, matchOffset + (resolvedWriteInfo.target_add || 0), resolvedWriteInfo, operations, step.name);
      }
    }
  }
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

function applyTailTrampolinePatch(data, out, patchInfo, operations, warnings, excludedRanges = []) {
  const hookOffsets = [];
  let searchStart = 1;
  while (true) {
    const hookOffset = findMatch(data, patchInfo.identifier, searchStart);
    if (hookOffset === null) break;
    hookOffsets.push(hookOffset);
    if (patchInfo.match_all === false) break;
    searchStart = hookOffset + 1;
  }

  if (!hookOffsets.length) {
    warnings.push(`${patchInfo.name}: hook identifier not found`);
    return;
  }

  const allocatedRanges = [...excludedRanges];
  for (const hookOffset of hookOffsets) {
    const injectionOffset = findTailFreeRegion(out, patchInfo.injection_size, 16, out.length, allocatedRanges);
    if (injectionOffset === null) {
      warnings.push(`${patchInfo.name}: no free tail area for trampoline`);
      return;
    }
    allocatedRanges.push([injectionOffset, injectionOffset + patchInfo.injection_size]);

    for (const writeInfo of patchInfo.writes) {
      const targetOffset = targetBase(writeInfo, hookOffset, injectionOffset) + (writeInfo.target_add || 0);
      if (writeInfo.hex) writeSramCode(out, targetOffset, writeInfo, operations);
      else writeSramU32Value(out, targetOffset, dynamicU32Value(writeInfo.u32_value, hookOffset, injectionOffset), operations, writeInfo.name);
    }
  }
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
  const waitstatePayloadSpan = waitstatePayloadSpanForLayout(originalData, options.waitstate);
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
    saveEmbedded: false,
    batteryless,
    waitstate,
    rtc,
    rtcPersistenceEnabled,
    rtcPayloadSpan,
    waitstatePayloadSpan,
    waitstateFixedWriteRanges: waitstateFixedWriteRangesForLayout(originalData, options.waitstate),
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

function unsupportedSramResult(context, saveType) {
  if (!context.options.deferHeaderFinalization) {
    updateGbaHeaderChecksum(context.rom.bytes, context.operations);
  }
  return {
    bytes: context.rom.bytes,
    result: makeResult(
      saveType,
      "unsupported",
      context.operations,
      context.warnings,
      context.batterylessResult,
      null,
      false,
      null,
      null,
      { requested: true, status: "unsupported" },
    ),
  };
}

function resolveSramPatchInfo(context) {
  if (context.saveType === null) {
    if (context.batteryless && context.batterylessResult === null) {
      context.warnings.push("No known GBA save type found");
      context.batterylessResult = {
        requested: true,
        mode: context.batterylessMode,
        status: "failed",
        countdown: context.batterylessCountdown,
        indicatorMode: context.batterylessIndicatorMode,
      };
    } else if (!context.waitstate && !context.rtc && !context.skipSavePatch) {
      context.warnings.push("No known GBA save type found");
      return unsupportedSramResult(context, null);
    }
    return null;
  }
  context.patchInfo = PATCH_BY_SAVE_TYPE[context.saveType] || null;
  if (context.patchInfo !== null) return null;
  if (context.batteryless && context.batterylessResult === null) {
    context.warnings.push(`${context.saveType} is not supported by the SRAM patcher`);
    context.batterylessResult = {
      requested: true,
      mode: context.batterylessMode,
      status: "failed",
      countdown: context.batterylessCountdown,
      indicatorMode: context.batterylessIndicatorMode,
    };
  } else if (!context.waitstate && !context.rtc && !context.skipSavePatch) {
    context.warnings.push(`${context.saveType} is not supported by the SRAM patcher`);
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
  if (!context.batteryless || context.batterylessResult !== null) return;
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
    context.waitstateFixedWriteRanges,
  );
  if (layout === null) {
    context.batterylessResult = {
      requested: true,
      mode: context.batterylessMode,
      status: "failed",
      countdown: context.batterylessCountdown,
      indicatorMode: context.batterylessIndicatorMode,
    };
    return;
  }
  assignPlannedBatterylessLayout(context, layout, rtcSpan);
}

function applySaveConversion(context) {
  if (context.patchInfo === null || context.skipSavePatch) return;
  const operationCount = context.operations.length;
  if (context.patchInfo.type === "simple") {
    applySimplePatch(
      context.originalData,
      context.rom.bytes,
      context.patchInfo,
      context.operations,
      context.warnings,
      context.flash1mBankSwitchStyle,
    );
  } else if (context.patchInfo.type === "tail_trampoline") {
    const excluded = [
      ...context.batterylessExcludedRanges,
      ...context.rtcExcludedRanges,
      ...context.waitstateExcludedRanges,
      ...context.irqHandlerExcludedRanges,
    ];
    applyTailTrampolinePatch(
      context.originalData,
      context.rom.bytes,
      context.patchInfo,
      context.operations,
      context.warnings,
      rangesWithPrefixGuard(excluded, C.TAIL_TRAMPOLINE_EXCLUDED_PREFIX_GUARD),
    );
  } else if (context.patchInfo.type !== "already_sram") {
    context.warnings.push(`${context.patchInfo.name}: unknown patch type`);
  }
  context.sramPatchApplied = context.operations.length > operationCount;
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
      context.waitstateFixedWriteRanges,
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
    context.waitstateFixedWriteRanges,
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
          && context.batterylessPayloadOffset !== null
          ? RTC_PERSISTENCE_SHARED_SAVE_AREA_FLAG
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
      startupCallbackEntry: context.batterylessResult?.initEntry || 0,
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
  planBatterylessLayout(context);
  applySaveConversion(context);
  planNonBatterylessAddons(context);
  applyRtcAndBatteryless(context);
  applySramWaitstate(context);
  applySramIrq(context);
  finalizeSramHeader(context);
  return completedSramResult(context);
}
