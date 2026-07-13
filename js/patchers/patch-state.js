// SPDX-License-Identifier: GPL-3.0-or-later

import { PatchError } from "../core/errors.js";
import { PATCH_OPERATION_KIND } from "../domain/constants.js";
import { stagePatchOperation } from "../patch-engine/draft.js";
import {
  GBA_HEADER_CHECKSUM_END,
  GBA_HEADER_CHECKSUM_OFFSET,
  GBA_HEADER_CHECKSUM_START,
  GBA_HEADER_SIZE,
  PATCH_HEADER,
} from "../domain/gba-constants.js";

export const PATCH_SAVE_MEDIUM = Object.freeze({
  NONE: 0,
  SRAM: 1,
  EEPROM: 2,
  FLASH: 3,
});

function patchSucceeded(result) {
  return result?.status === "patched";
}

export function patchHeaderSaveSizeCode(saveSize) {
  if (saveSize === null || saveSize === undefined) return PATCH_HEADER.saveSizeCodes.none;
  const code = PATCH_HEADER.saveSizeCodes[String(saveSize)];
  if (code === undefined) {
    throw new PatchError(`Unsupported patch-marker save size: ${saveSize}.`, {
      code: "PATCH_MARKER_UNKNOWN_SAVE_SIZE",
      stage: "headerFinalization",
      context: { saveSize },
    });
  }
  return code;
}

export function makePatchHeaderFlags(options = {}) {
  let flags = 0;
  const saveMedium = options.saveMedium;
  const saveSize = options.saveSize;
  const batteryless = options.batteryless;

  if (saveSize !== undefined) {
    flags = (flags & ~PATCH_HEADER.saveSizeMask) | patchHeaderSaveSizeCode(saveSize);
  }
  if (saveMedium !== undefined) {
    const medium = Number.isInteger(saveMedium) ? saveMedium : PATCH_SAVE_MEDIUM[String(saveMedium).toUpperCase()];
    if (!Object.values(PATCH_SAVE_MEDIUM).includes(medium)) {
      throw new PatchError(`Unsupported patch-marker save medium: ${saveMedium}.`, {
        code: "PATCH_MARKER_UNKNOWN_SAVE_MEDIUM",
        stage: "headerFinalization",
        context: { saveMedium },
      });
    }
    flags = (flags & ~PATCH_HEADER.saveMediumMask) | ((medium << PATCH_HEADER.saveMediumShift) & PATCH_HEADER.saveMediumMask);
  }
  if (batteryless !== undefined) {
    flags = batteryless ? flags | PATCH_HEADER.flagBatteryless : flags & ~PATCH_HEADER.flagBatteryless;
  }
  if (patchSucceeded(options.waitstateResult)) flags |= PATCH_HEADER.flagWaitstate;
  if (patchSucceeded(options.rtcResult)) flags |= PATCH_HEADER.flagFakeRtc;

  return flags & 0xff;
}

export function applyPatchHeaderMarker(bytes, operations, flags) {
  if (bytes.length < GBA_HEADER_SIZE) return;
  const markerValue = PATCH_HEADER.markerValue | ((flags & 0xff) << 8);
  const oldBytes = bytes.slice(PATCH_HEADER.markerOffset, PATCH_HEADER.markerOffset + 2);
  stagePatchOperation(bytes, operations, {
    id: `header-marker-${operations.length}`,
    kind: PATCH_OPERATION_KIND.HEADER_MARKER_WRITE,
    component: "header",
    labelKey: "operation.headerMarker",
    offset: PATCH_HEADER.markerOffset,
    byteLength: 2,
    expectedBefore: oldBytes,
    replacement: Uint8Array.of(PATCH_HEADER.markerValue, flags & 0xff),
    metadata: {
      name: "Patch marker in GBA header",
      value: markerValue,
    },
  });
}

export function computeGbaHeaderChecksum(bytes) {
  if (bytes.length <= GBA_HEADER_CHECKSUM_OFFSET) return null;
  let sum = 0;
  for (let offset = GBA_HEADER_CHECKSUM_START; offset <= GBA_HEADER_CHECKSUM_END; offset += 1) {
    sum = (sum + bytes[offset]) & 0xff;
  }
  return (-(sum + 0x19)) & 0xff;
}

export function updateGbaHeaderChecksum(bytes, operations) {
  const checksum = computeGbaHeaderChecksum(bytes);
  if (checksum === null) return null;
  const oldChecksum = bytes[GBA_HEADER_CHECKSUM_OFFSET] & 0xff;
  if (oldChecksum === checksum) return checksum;

  stagePatchOperation(bytes, operations, {
    id: `header-checksum-${operations.length}`,
    kind: PATCH_OPERATION_KIND.HEADER_CHECKSUM_WRITE,
    component: "header",
    labelKey: "operation.headerChecksum",
    offset: GBA_HEADER_CHECKSUM_OFFSET,
    byteLength: 1,
    expectedBefore: Uint8Array.of(oldChecksum),
    replacement: Uint8Array.of(checksum),
    metadata: {
      name: "GBA header checksum",
      value: checksum,
      oldValue: oldChecksum,
    },
  });
  return checksum;
}
