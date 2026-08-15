/*
 * GBA Save Type Patcher - safe WAITCNT initialization patcher.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Portions of this file are derived from SuperFW:
 *   Copyright (C) 2024 David Guillen Fandos <david@davidgf.net>
 *   Source: https://github.com/davidgfnet/superfw
 *   Relevant SuperFW files: src/patchengine.c and src/patchengine.h.
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * The implementation installs an entrypoint initialization and only rewrites
 * structurally verified WAITCNT initialization value literals. Dynamic WAITCNT
 * update paths remain intact: redirecting the register address or suppressing
 * later writes can break games that update prefetch and ROM timing while audio
 * DMA is live.
 * ROM header identifiers are metadata and are never consulted when choosing or
 * applying a WAITCNT patch.
 *
 * No save, IRQ, RTC, DirectSave, or in-game-menu patch operation is applied
 * here. The exported patch path also installs a small entrypoint payload that
 * writes the selected WAITCNT value before continuing to the previous entrypoint.
 */

import { writeU16, u32ToBytes } from "../core/binary.js";
import { makeArmBranchInstruction } from "../core/arm.js";
import {
  alignDown,
  alignUp,
  findTailBlankRegion,
  isBlankByte,
  isBlankRegion,
  overlapsAnyRange,
} from "../core/ranges.js";
import { encodeThumbBlToTarget } from "../core/thumb.js";
import { PATCH_OPERATION_KIND } from "../domain/constants.js";
import { GBA_PAYLOAD_PLACEMENT_LIMIT_BYTES } from "../domain/gba-constants.js";
import { applyPatchHeaderMarker, makePatchHeaderFlags, updateGbaHeaderChecksum } from "./patch-state.js";
import { SRAM_CONSTANTS as C } from "./sram-data.js";
import { PAYLOAD_ALIGNMENT, ensureDirectPayloadRegion, markedPayloadSpan } from "./payload-placement.js";
import { detectRomSaveMetadata } from "./save-type.js";
import {
  findWaitstateSwiSites,
  patchWaitstateStartupLiterals,
  patchWaitstateTimingSensitiveLoops,
} from "./waitcnt-scanner.js";
import { stageWaitstateWrite } from "./waitstate-common.js";
import {
  WAITCNT_ENTRYPOINT_MARKER,
  WAITCNT_ENTRYPOINT_MARKER_BYTES,
  WAITCNT_SWI_RESTORE_ARM_OFFSET,
  WAITCNT_SWI_RESTORE_MARKER,
  WAITCNT_SWI_RESTORE_MARKER_BYTES,
  WAITCNT_SWI_RESTORE_SIZE,
  WAITCNT_SWI_VENEER_MARKER,
  WAITCNT_SWI_VENEER_MARKER_BYTES,
  WAITCNT_SWI_VENEER_SIZE,
  decodeEntrypointAddress,
  encodeArmBranch,
  makeWaitcntSwiRestorePayload,
  makeWaitcntSwiVeneer,
  makeWaitstatePayload,
  writeRomMarker,
} from "./waitstate-payload.js";

const THUMB_BL_REACH = 0x400000;
const LOCAL_VENEER_ALIGNMENT = 0x100;
const GBA_HEADER_END = 0xc0;

function nearestReachableBlankRegion(bytes, sourceOffset, span, excludedRanges) {
  const start = Math.max(GBA_HEADER_END, sourceOffset + 4 - THUMB_BL_REACH);
  const end = Math.min(
    bytes.length,
    GBA_PAYLOAD_PLACEMENT_LIMIT_BYTES,
    sourceOffset + 4 + THUMB_BL_REACH,
  );
  let best = null;
  let runStart = null;
  const considerRun = (runEnd) => {
    if (runStart === null || runEnd - runStart < span) return;
    const minimum = alignUp(runStart, LOCAL_VENEER_ALIGNMENT);
    const maximum = alignDown(runEnd - span, LOCAL_VENEER_ALIGNMENT);
    if (minimum > maximum) return;
    const near = alignDown(sourceOffset, LOCAL_VENEER_ALIGNMENT);
    const candidate = Math.max(minimum, Math.min(maximum, near));
    if (encodeThumbBlToTarget(candidate, sourceOffset) === null) return;
    const distance = Math.abs(candidate - sourceOffset);
    if (best === null || distance < best.distance || (distance === best.distance && candidate < best.offset)) {
      best = { offset: candidate, distance };
    }
  };

  for (let offset = start; offset <= end; offset += 1) {
    const blank = offset < end
      && isBlankByte(bytes[offset])
      && !overlapsAnyRange(offset, offset + 1, excludedRanges);
    if (blank) {
      if (runStart === null) runStart = offset;
      continue;
    }
    considerRun(offset);
    runStart = null;
  }
  return best?.offset ?? null;
}

export function planWaitstateForLayout(
  inputBytes,
  waitstateOptions = {},
  excludedRanges = [],
  scanExcludedRanges = [],
) {
  const entrypointSpan = markedPayloadSpan(
    C.WAITSTATE_PAYLOAD_SIZE,
    WAITCNT_ENTRYPOINT_MARKER_BYTES.length,
  );
  const swiSites = findWaitstateSwiSites(
    inputBytes,
    scanExcludedRanges,
    waitstateOptions.scanLimit,
  );
  const swiRestoreSpan = swiSites.length
    ? markedPayloadSpan(WAITCNT_SWI_RESTORE_SIZE, WAITCNT_SWI_RESTORE_MARKER_BYTES.length)
    : 0;
  const veneerSpan = markedPayloadSpan(
    WAITCNT_SWI_VENEER_SIZE,
    WAITCNT_SWI_VENEER_MARKER_BYTES.length,
  );
  const localVeneers = [];
  const reservedRanges = [...excludedRanges];
  for (const site of swiSites.filter((candidate) => candidate.mode === "thumb-bl")) {
    const offset = nearestReachableBlankRegion(
      inputBytes,
      site.instructionOffset,
      veneerSpan,
      reservedRanges,
    );
    if (offset === null) {
      return {
        error: `Waitstate: no reachable blank region for SWI restore at 0x${site.instructionOffset.toString(16)}`,
        entrypointSpan,
        swiRestoreSpan,
        totalPayloadSpan: entrypointSpan + swiRestoreSpan,
        swiSites,
        localVeneers,
        fixedWriteRanges: localVeneers.map((veneer) => [veneer.offset, veneer.offset + veneer.span]),
        scanExcludedRanges: [...scanExcludedRanges],
      };
    }
    localVeneers.push({ instructionOffset: site.instructionOffset, offset, span: veneerSpan });
    reservedRanges.push([offset, offset + veneerSpan]);
  }
  return {
    error: null,
    entrypointSpan,
    swiRestoreSpan,
    totalPayloadSpan: entrypointSpan + swiRestoreSpan,
    swiSites,
    localVeneers,
    fixedWriteRanges: localVeneers.map((veneer) => [veneer.offset, veneer.offset + veneer.span]),
    scanExcludedRanges: [...scanExcludedRanges],
  };
}

export function waitstateFixedWriteRangesForLayout(
  inputBytes,
  waitstateOptions = {},
  excludedRanges = [],
  scanExcludedRanges = [],
) {
  if (!waitstateOptions?.enabled || !(inputBytes instanceof Uint8Array)) return [];
  return planWaitstateForLayout(
    inputBytes,
    waitstateOptions,
    excludedRanges,
    scanExcludedRanges,
  ).fixedWriteRanges;
}
export {
  batterylessPowerBoundaryGuardRanges,
  ensureWaitstateBatterylessPosition,
} from "./waitstate-planner.js";

export function waitstatePayloadSpanForLayout(inputBytes, waitstateOptions = {}) {
  if (!waitstateOptions?.enabled) return 0;
  if (!(inputBytes instanceof Uint8Array)) {
    return markedPayloadSpan(
      C.WAITSTATE_PAYLOAD_SIZE,
      WAITCNT_ENTRYPOINT_MARKER_BYTES.length,
    );
  }
  return planWaitstateForLayout(inputBytes, waitstateOptions).totalPayloadSpan;
}

function failedWaitstateResult(value) {
  return { requested: true, status: "failed", value, directWrites: 0 };
}

function resolveWaitstateLayout(work, options, excludedRanges, structuralPlan) {
  if (structuralPlan.error) return { error: structuralPlan.error };
  const { entrypointSpan, swiRestoreSpan, totalPayloadSpan, fixedWriteRanges } = structuralPlan;
  for (const veneer of structuralPlan.localVeneers) {
    if (
      !isBlankRegion(work, veneer.offset, veneer.span)
      || overlapsAnyRange(veneer.offset, veneer.offset + veneer.span, excludedRanges)
    ) {
      return { error: `Waitstate: reserved SWI veneer region at 0x${veneer.offset.toString(16)} is no longer free` };
    }
  }
  let payloadOffset = options.payloadOffset ?? null;
  if (payloadOffset === null && options.payloadOffsetRequired) {
    return { error: "Waitstate: no free code block for entrypoint payload found" };
  }
  if (payloadOffset === null) {
    payloadOffset = findTailBlankRegion(
      work,
      totalPayloadSpan,
      PAYLOAD_ALIGNMENT,
      GBA_PAYLOAD_PLACEMENT_LIMIT_BYTES,
      [...excludedRanges, ...fixedWriteRanges],
    );
  } else if (
    payloadOffset < 0
    || payloadOffset % PAYLOAD_ALIGNMENT
    || payloadOffset + totalPayloadSpan > GBA_PAYLOAD_PLACEMENT_LIMIT_BYTES
    || !isBlankRegion(work, payloadOffset, totalPayloadSpan)
    || overlapsAnyRange(payloadOffset, payloadOffset + totalPayloadSpan, fixedWriteRanges)
  ) {
    payloadOffset = null;
  }
  if (payloadOffset === null) {
    return { error: "Waitstate: no free tail area for entrypoint payload found" };
  }
  return {
    payloadOffset,
    entrypointSpan,
    swiRestoreSpan,
    swiRestoreOffset: swiRestoreSpan ? payloadOffset + entrypointSpan : null,
    totalPayloadSpan,
  };
}

function installWaitstateEntrypoint(context) {
  const payload = makeWaitstatePayload(context.value, context.nextEntrypoint);
  const branch = encodeArmBranch(C.GBA_ROM_BASE, C.GBA_ROM_BASE + context.payloadOffset);
  stageWaitstateWrite(context.work, context.operations, "Waitstate Entrypoint", 0, u32ToBytes(branch), {
    codeName: "waitstate_entrypoint",
    value: branch,
  });
  stageWaitstateWrite(
    context.work,
    context.operations,
    "WAITCNT entrypoint block",
    context.payloadOffset,
    payload,
    {
      kind: PATCH_OPERATION_KIND.PAYLOAD_INSTALL,
      codeName: "waitcnt_entrypoint",
      value: context.value & 0xffff,
    },
  );
  writeRomMarker(
    context.work,
    context.operations,
    context.payloadOffset,
    payload.length,
    markedPayloadSpan(payload.length, WAITCNT_ENTRYPOINT_MARKER_BYTES.length),
    WAITCNT_ENTRYPOINT_MARKER,
    "WAITCNT entrypoint ROM marker",
    "waitcnt_entrypoint_rom_marker",
  );
}

function installWaitstateSwiRestore(context) {
  if (!context.structuralPlan.swiSites.length) return 0;
  if (context.layout.swiRestoreOffset === null) {
    throw new Error("Waitstate: SWI restore sites exist without a central restore payload");
  }

  const liveSites = findWaitstateSwiSites(
    context.work,
    [...context.structuralPlan.scanExcludedRanges, ...context.excludedRanges],
    context.scanLimit,
  );
  const liveKeys = new Set(
    liveSites.map((site) => `${site.mode}:${site.instructionOffset}`),
  );
  for (const site of context.structuralPlan.swiSites) {
    if (!liveKeys.has(`${site.mode}:${site.instructionOffset}`)) {
      throw new Error(`Waitstate: SWI call at 0x${site.instructionOffset.toString(16)} changed before patching`);
    }
  }

  const restorePayload = makeWaitcntSwiRestorePayload();
  stageWaitstateWrite(
    context.work,
    context.operations,
    "WAITCNT SWI restore block",
    context.layout.swiRestoreOffset,
    restorePayload,
    {
      kind: PATCH_OPERATION_KIND.PAYLOAD_INSTALL,
      codeName: "waitcnt_swi_restore",
    },
  );
  writeRomMarker(
    context.work,
    context.operations,
    context.layout.swiRestoreOffset,
    restorePayload.length,
    context.layout.swiRestoreSpan,
    WAITCNT_SWI_RESTORE_MARKER,
    "WAITCNT SWI restore ROM marker",
    "waitcnt_swi_restore_rom_marker",
  );

  const armRestoreOffset = context.layout.swiRestoreOffset + WAITCNT_SWI_RESTORE_ARM_OFFSET;
  let patched = 0;
  for (const site of context.structuralPlan.swiSites) {
    if (site.mode === "arm-swi") {
      const branch = makeArmBranchInstruction(
        C.GBA_ROM_BASE + site.instructionOffset,
        C.GBA_ROM_BASE + armRestoreOffset,
        true,
      );
      if (branch === null) {
        throw new Error(`Waitstate: ARM SWI restore target is out of range at 0x${site.instructionOffset.toString(16)}`);
      }
      stageWaitstateWrite(
        context.work,
        context.operations,
        "WAITCNT ARM SWI redirect",
        site.instructionOffset,
        u32ToBytes(branch),
        { codeName: "waitcnt_swi_arm_redirect", value: armRestoreOffset },
      );
      patched += 1;
      continue;
    }

    const veneer = context.structuralPlan.localVeneers.find(
      (candidate) => candidate.instructionOffset === site.instructionOffset,
    );
    if (!veneer) {
      throw new Error(`Waitstate: missing Thumb SWI veneer for 0x${site.instructionOffset.toString(16)}`);
    }
    const veneerBytes = makeWaitcntSwiVeneer(
      C.GBA_ROM_BASE + veneer.offset,
      C.GBA_ROM_BASE + armRestoreOffset,
    );
    stageWaitstateWrite(
      context.work,
      context.operations,
      "WAITCNT Thumb SWI veneer",
      veneer.offset,
      veneerBytes,
      {
        kind: PATCH_OPERATION_KIND.PAYLOAD_INSTALL,
        codeName: "waitcnt_swi_thumb_veneer",
        value: armRestoreOffset,
      },
    );
    writeRomMarker(
      context.work,
      context.operations,
      veneer.offset,
      veneerBytes.length,
      veneer.span,
      WAITCNT_SWI_VENEER_MARKER,
      "WAITCNT SWI veneer ROM marker",
      "waitcnt_swi_veneer_rom_marker",
    );
    const encoded = encodeThumbBlToTarget(veneer.offset, site.instructionOffset);
    if (encoded === null) {
      throw new Error(`Waitstate: Thumb SWI veneer is out of range at 0x${site.instructionOffset.toString(16)}`);
    }
    const redirect = new Uint8Array(4);
    writeU16(redirect, 0, encoded[0]);
    writeU16(redirect, 2, encoded[1]);
    stageWaitstateWrite(
      context.work,
      context.operations,
      "WAITCNT Thumb SWI redirect",
      site.instructionOffset,
      redirect,
      { codeName: "waitcnt_swi_thumb_redirect", value: veneer.offset },
    );
    patched += 1;
  }
  return patched;
}

function completedWaitstateResult(
  value,
  nextEntrypoint,
  layout,
  directWrites,
  timingLoopPatches,
  swiPatches,
) {
  return {
    requested: true,
    status: "patched",
    value,
    payloadOffset: layout.payloadOffset,
    size: layout.totalPayloadSpan,
    payloadSpan: layout.totalPayloadSpan,
    nextEntrypoint,
    directWrites,
    source: "entrypoint_and_structural_patches",
    startupLiteralPatches: directWrites,
    timingLoopPatches,
    swiPatches,
  };
}

export function applyWaitstatePatch(rom, operations, warnings, waitstateValue = C.WAITSTATE_DEFAULT_VALUE, options = {}) {
  const excludedRanges = [...(options.excludedRanges || [])];
  const previousOperationCount = operations.length;
  let localOperations = [...operations];
  const localWarnings = [];
  let work = new Uint8Array(rom.bytes);
  try {
    const nextEntrypoint = decodeEntrypointAddress(work);
    const structuralPlan = options.structuralPlan || planWaitstateForLayout(
      work,
      { ...options, enabled: true },
      excludedRanges,
      options.scanExcludedRanges || excludedRanges,
    );
    const layout = resolveWaitstateLayout(work, options, excludedRanges, structuralPlan);
    if (layout.error) {
      localWarnings.push(layout.error);
      warnings.push(...localWarnings);
      return failedWaitstateResult(waitstateValue);
    }
    const payloadRange = [[layout.payloadOffset, layout.payloadOffset + layout.totalPayloadSpan]];
    const directWrites = patchWaitstateStartupLiterals(
      work,
      waitstateValue,
      localOperations,
      [...excludedRanges, ...payloadRange],
      options.scanLimit,
    );
    const timingLoopPatches = patchWaitstateTimingSensitiveLoops(
      work,
      localOperations,
      [...excludedRanges, ...payloadRange, ...structuralPlan.fixedWriteRanges],
    );
    const swiPatches = installWaitstateSwiRestore({
      work,
      operations: localOperations,
      excludedRanges: payloadRange,
      scanLimit: options.scanLimit,
      layout,
      structuralPlan,
    });
    installWaitstateEntrypoint({
      work,
      operations: localOperations,
      payloadOffset: layout.payloadOffset,
      value: waitstateValue,
      nextEntrypoint,
    });
    rom.bytes = work;
    operations.push(...localOperations.slice(previousOperationCount));
    warnings.push(...localWarnings);
    return completedWaitstateResult(
      waitstateValue,
      nextEntrypoint,
      layout,
      directWrites,
      timingLoopPatches,
      swiPatches,
    );
  } catch (error) {
    localWarnings.push(`Waitstate: ${error.message}`);
    warnings.push(...localWarnings);
    return failedWaitstateResult(waitstateValue);
  }
}

export function waitstatePrefixSizeForBatteryless(waitstateOptions, inputBytes = null) {
  return waitstatePayloadSpanForLayout(inputBytes, waitstateOptions);
}

export function applyWaitstateForPipeline(rom, operations, warnings, waitstateOptions = {}, context = {}) {
  if (!waitstateOptions.enabled) return null;

  const value = waitstateOptions.value ?? C.WAITSTATE_DEFAULT_VALUE;
  const excludedRanges = [...(context.excludedRanges || [])];
  const structuralPlan = context.structuralPlan || planWaitstateForLayout(
    rom.bytes,
    waitstateOptions,
    excludedRanges,
    context.scanExcludedRanges || [],
  );
  if (structuralPlan.error) {
    warnings.push(structuralPlan.error);
    return { requested: true, status: "failed", value, directWrites: 0 };
  }
  const payloadSpan = structuralPlan.totalPayloadSpan;
  const placementExcludedRanges = [
    ...excludedRanges,
    ...structuralPlan.fixedWriteRanges,
  ];
  let payloadOffset = context.waitstatePayloadOffset ?? context.payloadOffset ?? null;

  if (payloadOffset === null && context.batterylessPayloadOffset !== null && context.batterylessPayloadOffset !== undefined) {
    payloadOffset = context.batterylessPayloadOffset - payloadSpan;
  }

  if (payloadOffset === null) {
    payloadOffset = ensureDirectPayloadRegion(rom, operations, warnings, payloadSpan, "Waitstate", placementExcludedRanges);
  }

  if (payloadOffset === null) {
    return { requested: true, status: "failed", value, directWrites: 0 };
  }

  return applyWaitstatePatch(rom, operations, warnings, value, {
    excludedRanges,
    payloadOffset,
    payloadOffsetRequired: true,
    scanLimit: waitstateOptions.scanLimit,
    structuralPlan,
  });
}

export function applyWaitstateToBytes(inputBytes, waitstateOptions = {}) {
  const rom = { bytes: new Uint8Array(inputBytes) };
  const sourceSaveMetadata = detectRomSaveMetadata(rom.bytes);
  const operations = [];
  const warnings = [];
  let waitstate;

  if (!waitstateOptions?.enabled) {
    return { bytes: rom.bytes, result: { waitstate: null, operations, warnings, status: "unchanged" } };
  }

  const structuralPlan = planWaitstateForLayout(rom.bytes, waitstateOptions);
  const payloadOffset = structuralPlan.error ? null : ensureDirectPayloadRegion(
      rom,
      operations,
      warnings,
      structuralPlan.totalPayloadSpan,
      "Waitstate",
      structuralPlan.fixedWriteRanges,
    );
  if (structuralPlan.error) warnings.push(structuralPlan.error);
  waitstate = payloadOffset === null
    ? { requested: true, status: "failed", value: waitstateOptions.value ?? C.WAITSTATE_DEFAULT_VALUE, directWrites: 0 }
    : applyWaitstatePatch(rom, operations, warnings, waitstateOptions.value ?? C.WAITSTATE_DEFAULT_VALUE, {
      payloadOffset,
      payloadOffsetRequired: true,
      scanLimit: waitstateOptions.scanLimit,
      structuralPlan,
    });

  if (waitstate.status === "patched") {
    applyPatchHeaderMarker(rom.bytes, operations, makePatchHeaderFlags({
      saveMedium: sourceSaveMetadata.medium,
      saveSize: sourceSaveMetadata.size,
      batteryless: false,
      waitstateResult: waitstate,
    }));
  }
  updateGbaHeaderChecksum(rom.bytes, operations);
  return { bytes: rom.bytes, result: { waitstate, operations, warnings, status: operations.length ? "patched" : waitstate.status } };
}
