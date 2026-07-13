// SPDX-License-Identifier: GPL-3.0-or-later

import { PatchError } from "../core/errors.js";
import { PATCH_OPERATION_KIND } from "../domain/constants.js";
import { stagePatchOperation, stageRomExpansion } from "../patch-engine/draft.js";
import {
  GBA_MAX_ROM_SIZE,
  PATCH_BLOCK_ALIGNMENT,
  PAYLOAD_ALIGNMENT,
  alignDown,
  alignUp,
  isFreeRegion,
  lastNonFreeEnd,
  normalizeExcludedRanges,
  rangesOverlap,
} from "./payload-placement.js";

export const RTC_PERSISTENCE_BLOCK_SIZE = PATCH_BLOCK_ALIGNMENT;
export const RTC_PERSISTENCE_FORBIDDEN_ROM_OFFSET = 0x01000000;

function placementError(message, context = {}) {
  return new PatchError(message, {
    code: "RTC_PERSISTENCE_PLACEMENT_INVALID",
    stage: "placement",
    context,
  });
}

function validateSpan(name, value) {
  if (!Number.isSafeInteger(value) || value < 0 || value % PAYLOAD_ALIGNMENT) {
    throw placementError(`${name} span must be a non-negative 0x100-byte multiple.`, {
      name,
      value,
    });
  }
}

function validatedSpans(spans = {}) {
  const normalized = {
    rtcSpan: spans.rtcSpan ?? 0,
    waitstateSpan: spans.waitstateSpan ?? 0,
    irqSpan: spans.irqSpan ?? 0,
  };
  validateSpan("RTC", normalized.rtcSpan);
  validateSpan("Waitstate", normalized.waitstateSpan);
  validateSpan("Shared IRQ", normalized.irqSpan);
  return normalized;
}

/**
 * Pack the add-ons backwards from a 256 KiB code-block boundary. Their ROM
 * order is always Fake RTC, Waitstate, Shared IRQ.
 */
export function layoutStandaloneRtcAddonsAtBlockEnd(codeBlockEnd, spans = {}) {
  if (!Number.isSafeInteger(codeBlockEnd)
      || codeBlockEnd <= 0
      || codeBlockEnd % PATCH_BLOCK_ALIGNMENT) {
    throw placementError("Standalone RTC code-block end is invalid.", { codeBlockEnd });
  }
  const { rtcSpan, waitstateSpan, irqSpan } = validatedSpans(spans);
  const totalAddonSpan = rtcSpan + waitstateSpan + irqSpan;
  if (totalAddonSpan > PATCH_BLOCK_ALIGNMENT) {
    throw placementError("Standalone RTC add-ons do not fit in one code block.", {
      totalAddonSpan,
      codeBlockSize: PATCH_BLOCK_ALIGNMENT,
    });
  }
  let cursor = codeBlockEnd;
  let irqPayloadOffset = null;
  let waitstatePayloadOffset = null;
  let rtcPayloadOffset = null;

  if (irqSpan) {
    irqPayloadOffset = alignDown(cursor - irqSpan, PAYLOAD_ALIGNMENT);
    cursor = irqPayloadOffset;
  }
  if (waitstateSpan) {
    waitstatePayloadOffset = alignDown(cursor - waitstateSpan, PAYLOAD_ALIGNMENT);
    cursor = waitstatePayloadOffset;
  }
  if (rtcSpan) {
    rtcPayloadOffset = alignDown(cursor - rtcSpan, PAYLOAD_ALIGNMENT);
    cursor = rtcPayloadOffset;
  }

  return {
    prefixOffset: cursor,
    rtcPayloadOffset,
    waitstatePayloadOffset,
    irqPayloadOffset,
  };
}

function reserveContainsForbiddenOffset(start, end) {
  return start <= RTC_PERSISTENCE_FORBIDDEN_ROM_OFFSET
    && RTC_PERSISTENCE_FORBIDDEN_ROM_OFFSET < end;
}

/** Locate an already-erased code-block tail plus its following writable block. */
export function findStandaloneRtcPersistenceLayout(bytes, spans = {}, excludedRanges = []) {
  if (!(bytes instanceof Uint8Array)) throw placementError("Standalone RTC placement requires ROM bytes.");
  const normalizedSpans = validatedSpans(spans);
  if (normalizedSpans.rtcSpan + normalizedSpans.waitstateSpan + normalizedSpans.irqSpan
      > PATCH_BLOCK_ALIGNMENT) return null;
  if (bytes.length > GBA_MAX_ROM_SIZE) return null;
  const normalizedRanges = normalizeExcludedRanges(excludedRanges);
  const contentEnd = lastNonFreeEnd(bytes);
  const firstCodeBlockStart = alignDown(Math.max(0, contentEnd - 1), PATCH_BLOCK_ALIGNMENT);

  for (
    let codeBlockStart = firstCodeBlockStart;
    codeBlockStart + PATCH_BLOCK_ALIGNMENT + RTC_PERSISTENCE_BLOCK_SIZE <= bytes.length;
    codeBlockStart += PATCH_BLOCK_ALIGNMENT
  ) {
    const codeBlockEnd = codeBlockStart + PATCH_BLOCK_ALIGNMENT;
    const persistenceBlockOffset = codeBlockEnd;
    const persistenceBlockEnd = persistenceBlockOffset + RTC_PERSISTENCE_BLOCK_SIZE;
    const addonLayout = layoutStandaloneRtcAddonsAtBlockEnd(codeBlockEnd, normalizedSpans);

    if (addonLayout.prefixOffset < codeBlockStart) continue;
    if (reserveContainsForbiddenOffset(persistenceBlockOffset, persistenceBlockEnd)) continue;
    if (rangesOverlap(addonLayout.prefixOffset, codeBlockEnd, normalizedRanges)) continue;
    if (rangesOverlap(persistenceBlockOffset, persistenceBlockEnd, normalizedRanges)) continue;
    if (!isFreeRegion(bytes, addonLayout.prefixOffset, codeBlockEnd - addonLayout.prefixOffset)) continue;
    if (!isFreeRegion(bytes, persistenceBlockOffset, RTC_PERSISTENCE_BLOCK_SIZE)) continue;

    return {
      ...addonLayout,
      codeBlockStart,
      codeBlockEnd,
      persistenceBlockOffset,
      persistenceRange: [persistenceBlockOffset, persistenceBlockEnd],
    };
  }
  return null;
}

function stagePersistenceExpansion(rom, operations, oldSize, newSize) {
  const byteLength = newSize - oldSize;
  const erasedBytes = new Uint8Array(byteLength).fill(0xff);
  stageRomExpansion(rom, operations, {
    id: `rtc-persistence-expand-${operations.length}`,
    kind: PATCH_OPERATION_KIND.ROM_EXPAND,
    component: "rtcPersistence",
    offset: oldSize,
    byteLength,
    expectedBefore: erasedBytes,
    replacement: new Uint8Array(erasedBytes),
    labelKey: "operation.romExpand",
    metadata: {
      name: "Fake RTC persistence ROM expansion",
      value: newSize,
    },
  });
}

function stagePersistenceReserve(rom, operations, layout) {
  const replacement = new Uint8Array(RTC_PERSISTENCE_BLOCK_SIZE).fill(0xff);
  stagePatchOperation(rom.bytes, operations, {
    id: `rtc-persistence-${operations.length}`,
    kind: PATCH_OPERATION_KIND.CONFIG_WRITE,
    component: "rtcPersistence",
    offset: layout.persistenceBlockOffset,
    byteLength: replacement.length,
    expectedBefore: rom.bytes.slice(
      layout.persistenceBlockOffset,
      layout.persistenceBlockOffset + replacement.length,
    ),
    replacement,
    labelKey: "operation.rtc",
    alignment: RTC_PERSISTENCE_BLOCK_SIZE,
    metadata: {
      name: "Fake RTC persistence reserve initialized",
      value: 0xff,
      codeName: "rtc_persistence_reserve",
    },
  });
}

/**
 * Find or expand for the complete standalone layout, then atomically publish
 * its staged expansion and full-FF persistence reserve to the caller.
 */
export function ensureStandaloneRtcPersistenceLayout(
  rom,
  operations,
  warnings,
  spans = {},
  excludedRanges = [],
) {
  if (!(rom?.bytes instanceof Uint8Array) || !Array.isArray(operations) || !Array.isArray(warnings)) {
    throw placementError("Standalone RTC placement received an invalid planning context.");
  }
  const normalizedSpans = validatedSpans(spans);
  const totalAddonSpan = normalizedSpans.rtcSpan
    + normalizedSpans.waitstateSpan
    + normalizedSpans.irqSpan;
  if (totalAddonSpan > PATCH_BLOCK_ALIGNMENT) {
    warnings.push("Fake RTC persistence: add-on payloads do not fit in one 256 KiB code block");
    return null;
  }

  const previousOperationCount = operations.length;
  const workRom = { bytes: new Uint8Array(rom.bytes) };
  const localOperations = [...operations];
  let failureWarning = null;

  while (true) {
    if (workRom.bytes.length > GBA_MAX_ROM_SIZE) {
      failureWarning = "Fake RTC persistence: ROM is larger than 32 MiB";
      break;
    }

    const layout = findStandaloneRtcPersistenceLayout(
      workRom.bytes,
      normalizedSpans,
      excludedRanges,
    );
    if (layout !== null) {
      stagePersistenceReserve(workRom, localOperations, layout);
      rom.bytes = workRom.bytes;
      operations.push(...localOperations.slice(previousOperationCount));
      return layout;
    }

    if (workRom.bytes.length >= GBA_MAX_ROM_SIZE) {
      failureWarning = "Fake RTC persistence: no free payload-plus-reserve area and ROM is already 32 MiB";
      break;
    }

    const oldSize = workRom.bytes.length;
    const newSize = Math.min(
      alignUp(oldSize, PATCH_BLOCK_ALIGNMENT) + PATCH_BLOCK_ALIGNMENT,
      GBA_MAX_ROM_SIZE,
    );
    if (newSize <= oldSize) {
      failureWarning = "Fake RTC persistence: ROM could not be expanded";
      break;
    }
    stagePersistenceExpansion(workRom, localOperations, oldSize, newSize);
  }

  if (failureWarning) warnings.push(failureWarning);
  return null;
}
