/*
 * GBA Save Type Patcher - SuperFW WAITCNT patch port.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Portions of this file are derived from SuperFW:
 *   Copyright (C) 2024 David Guillen Fandos <david@davidgf.net>
 *   Source: https://github.com/davidgfnet/superfw
 *   Relevant SuperFW files: src/patchengine.c, src/patchengine.h,
 *     src/patcher.c, and the SuperFW patch database format/data used for
 *     WAITCNT/wcnt_ops.
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * The WAITCNT implementation below mirrors SuperFW for the WAITCNT-only
 * part of patching:
 *   - first use the bundled SuperFW patch database and apply only wcnt_ops;
 *   - execute patch opcodes with the same payload/opcode semantics as
 *     superfw-master/src/patcher.c apply_patch_ops();
 *   - when no database entry exists, fall back to the WAITCNT scanner from
 *     superfw-master/src/patchengine.c, matching only 0x04000204 literals
 *     referenced by PC-relative Thumb/ARM LDR instructions.
 *
 * No save, IRQ, RTC, DirectSave, or in-game-menu patch operation is applied
 * here. The exported patch path also installs a small entrypoint payload that
 * writes the selected WAITCNT value before continuing to the previous entrypoint.
 */

import { PATCH_OPERATION_KIND } from "../domain/constants.js";
import { applyPatchHeaderMarker, makePatchHeaderFlags, updateGbaHeaderChecksum } from "./patch-state.js";
import { SRAM_CONSTANTS as C } from "./sram-data.js";
import { PAYLOAD_ALIGNMENT, ensureDirectPayloadRegion, markedPayloadSpan } from "./payload-placement.js";
import { detectRomSaveMetadata } from "./save-type.js";
import {
  collectSuperfwFixedWriteRanges,
  getSuperfwDbEntryForRom,
  superfwProgramRelocationSpan,
  waitstateFixedWriteRangesForLayout,
} from "./superfw-db-parser.js";
import { applySuperfwWaitcntDbOps } from "./superfw-opcode-interpreter.js";
import { applySuperfwPatchengineWaitcnt, patchWaitstateStartupLiterals } from "./waitcnt-scanner.js";
import { stageWaitstateWrite, u32ToBytes } from "./waitstate-common.js";
import {
  WAITCNT_ENTRYPOINT_MARKER,
  WAITCNT_ENTRYPOINT_MARKER_BYTES,
  WAITCNT_SWI_RESTORE_MARKER,
  WAITCNT_SWI_RESTORE_MARKER_BYTES,
  decodeEntrypointAddress,
  encodeArmBranch,
  makeWaitstatePayload,
  writeRomMarker,
} from "./waitstate-payload.js";
import { findTailFreeRegion, isFreeRegion, rangesOverlap } from "./waitstate-planner.js";

export { waitstateFixedWriteRangesForLayout };
export {
  batterylessPowerBoundaryGuardRanges,
  ensureWaitstateBatterylessPosition,
} from "./waitstate-planner.js";

function runSuperfwWaitcntPatch(inputBytes, operations, warnings, options = {}) {
  const original = new Uint8Array(inputBytes);
  const dbEntry = getSuperfwDbEntryForRom(original);
  if (dbEntry !== null) {
    const before = operations.length;
    const patched = applySuperfwWaitcntDbOps(original, dbEntry, operations, {
      warnings,
      programBaseOffset: options.programBaseOffset ?? null,
      programMarkerSize: WAITCNT_SWI_RESTORE_MARKER_BYTES.length,
      excludedRanges: options.excludedRanges || [],
    });
    const appliedWrites = operations.length - before;
    return {
      bytes: patched.bytes,
      waitstate: {
        requested: true,
        status: appliedWrites ? "patched" : "unchanged",
        source: "superfw_patch_database",
        patches: appliedWrites,
        superfwWcntOps: dbEntry.wcntOps,
        programRelocations: patched.programRelocations,
      },
    };
  }

  const before = operations.length;
  const patched = applySuperfwPatchengineWaitcnt(
    original,
    operations,
    options.excludedRanges || [],
  );
  const appliedWrites = operations.length - before;
  return {
    bytes: patched.bytes,
    waitstate: {
      requested: true,
      status: appliedWrites ? "patched" : "unchanged",
      source: "superfw_patchengine",
      patches: appliedWrites,
      literalZeroes: patched.patches,
    },
  };
}

export function waitstatePayloadSpanForLayout(inputBytes, waitstateOptions = {}) {
  if (!waitstateOptions?.enabled) return 0;

  const entrypointSpan = markedPayloadSpan(
    C.WAITSTATE_PAYLOAD_SIZE,
    WAITCNT_ENTRYPOINT_MARKER_BYTES.length,
  );
  const dbEntry = inputBytes ? getSuperfwDbEntryForRom(inputBytes) : null;
  return entrypointSpan + superfwProgramRelocationSpan(
    dbEntry,
    WAITCNT_SWI_RESTORE_MARKER_BYTES.length,
  );
}

function failedWaitstateResult(value) {
  return { requested: true, status: "failed", value, directWrites: 0 };
}

function resolveWaitstateLayout(work, options, excludedRanges) {
  const entrypointSpan = markedPayloadSpan(
    C.WAITSTATE_PAYLOAD_SIZE,
    WAITCNT_ENTRYPOINT_MARKER_BYTES.length,
  );
  const dbEntry = getSuperfwDbEntryForRom(work);
  const programSpan = superfwProgramRelocationSpan(
    dbEntry,
    WAITCNT_SWI_RESTORE_MARKER_BYTES.length,
  );
  const totalPayloadSpan = entrypointSpan + programSpan;
  const fixedWriteRanges = collectSuperfwFixedWriteRanges(dbEntry);
  let payloadOffset = options.payloadOffset ?? null;
  if (payloadOffset === null && options.payloadOffsetRequired) {
    return { error: "Waitstate: no free code block for entrypoint payload found" };
  }
  if (payloadOffset === null) {
    payloadOffset = findTailFreeRegion(
      work,
      totalPayloadSpan,
      PAYLOAD_ALIGNMENT,
      work.length,
      [...excludedRanges, ...fixedWriteRanges],
    );
  } else if (
    payloadOffset < 0
    || payloadOffset % PAYLOAD_ALIGNMENT
    || !isFreeRegion(work, payloadOffset, totalPayloadSpan)
    || rangesOverlap(payloadOffset, payloadOffset + totalPayloadSpan, fixedWriteRanges)
  ) {
    payloadOffset = null;
  }
  if (payloadOffset === null) {
    return { error: "Waitstate: no free tail area for entrypoint payload found" };
  }
  return { payloadOffset, entrypointSpan, programSpan, totalPayloadSpan };
}

function applySuperfwWithFallback(work, layout, excludedRanges, previousOperations) {
  const operations = [...previousOperations];
  const warnings = [];
  const programBaseOffset = layout.payloadOffset + layout.entrypointSpan;
  let result = runSuperfwWaitcntPatch(work, operations, warnings, {
    programBaseOffset: layout.programSpan ? programBaseOffset : null,
    excludedRanges,
  });
  if (!warnings.some((message) => message.includes("could not relocate"))) {
    return { work: result.bytes, operations, warnings, waitstate: result.waitstate };
  }
  const fallbackOperations = [...previousOperations];
  const fallbackWarnings = [];
  result = runSuperfwWaitcntPatch(work, fallbackOperations, fallbackWarnings, { excludedRanges });
  return {
    work: result.bytes,
    operations: fallbackOperations,
    warnings: fallbackWarnings,
    waitstate: { ...result.waitstate, programRelocationStatus: "fixed_address_fallback" },
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
  for (const relocation of context.waitstate?.programRelocations || []) {
    writeRomMarker(
      context.work,
      context.operations,
      relocation.newOffset,
      relocation.size,
      relocation.span,
      WAITCNT_SWI_RESTORE_MARKER,
      "WAITCNT SWI restore ROM marker",
      "waitcnt_swi_restore_rom_marker",
    );
  }
}

function completedWaitstateResult(value, nextEntrypoint, layout, directWrites, waitstate) {
  return {
    requested: true,
    status: "patched",
    value,
    payloadOffset: layout.payloadOffset,
    size: layout.totalPayloadSpan,
    payloadSpan: layout.totalPayloadSpan,
    nextEntrypoint,
    directWrites,
    source: waitstate?.source,
    superfwPatches: waitstate?.patches,
    superfwProgramRelocationStatus: waitstate?.programRelocationStatus,
    superfwProgramRelocations: waitstate?.programRelocations,
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
    const layout = resolveWaitstateLayout(work, options, excludedRanges);
    if (layout.error) {
      localWarnings.push(layout.error);
      warnings.push(...localWarnings);
      return failedWaitstateResult(waitstateValue);
    }
    const superfw = applySuperfwWithFallback(work, layout, excludedRanges, localOperations);
    work = superfw.work;
    localOperations = superfw.operations;
    localWarnings.push(...superfw.warnings);
    const payloadRange = [[layout.payloadOffset, layout.payloadOffset + layout.totalPayloadSpan]];
    const directWrites = patchWaitstateStartupLiterals(
      work,
      waitstateValue,
      localOperations,
      [...excludedRanges, ...payloadRange],
      options.scanLimit,
    );
    installWaitstateEntrypoint({
      work,
      operations: localOperations,
      payloadOffset: layout.payloadOffset,
      value: waitstateValue,
      nextEntrypoint,
      waitstate: superfw.waitstate,
    });
    rom.bytes = work;
    operations.push(...localOperations.slice(previousOperationCount));
    warnings.push(...localWarnings);
    return completedWaitstateResult(
      waitstateValue,
      nextEntrypoint,
      layout,
      directWrites,
      superfw.waitstate,
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
  const payloadSpan = waitstatePayloadSpanForLayout(rom.bytes, waitstateOptions);
  const excludedRanges = [...(context.excludedRanges || [])];
  const placementExcludedRanges = [
    ...excludedRanges,
    ...waitstateFixedWriteRangesForLayout(rom.bytes, waitstateOptions),
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
    scanLimit: waitstateOptions.scanLimit ?? C.WAITSTATE_DIRECT_SCAN_LIMIT,
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

  const payloadOffset = ensureDirectPayloadRegion(rom, operations, warnings, waitstatePayloadSpanForLayout(rom.bytes, waitstateOptions), "Waitstate");
  waitstate = payloadOffset === null
    ? { requested: true, status: "failed", value: waitstateOptions.value ?? C.WAITSTATE_DEFAULT_VALUE, directWrites: 0 }
    : applyWaitstatePatch(rom, operations, warnings, waitstateOptions.value ?? C.WAITSTATE_DEFAULT_VALUE, {
      payloadOffset,
      payloadOffsetRequired: true,
      scanLimit: waitstateOptions.scanLimit ?? C.WAITSTATE_DIRECT_SCAN_LIMIT,
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
