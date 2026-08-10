// SPDX-License-Identifier: GPL-3.0-or-later AND MIT

import { hexToBytes, u32ToBytes } from "../core/binary.js";
import { PATCH_OPERATION_KIND } from "../domain/constants.js";
import { stageNamedPatchWrite } from "../patch-engine/draft.js";

export function stageSramWrite(bytes, operations, name, offset, replacement, details = {}) {
  return stageNamedPatchWrite(bytes, operations, {
    idPrefix: "save-type",
    kind: details.kind || PATCH_OPERATION_KIND.HOOK_REPLACE,
    component: details.component || "saveType",
    labelKey: details.labelKey || "operation.saveType",
    name,
    offset,
    replacement,
    metadata: {
      ...(details.codeName === undefined ? {} : { codeName: details.codeName }),
      ...(details.sourceOffset === undefined ? {} : { sourceOffset: details.sourceOffset }),
      ...(details.value === undefined ? {} : { value: details.value }),
    },
    allowOverlap: details.allowOverlap === true,
  });
}

export function writeSramCode(out, targetOffset, writeInfo, operations, operationName = null) {
  const newCode = hexToBytes(writeInfo.hex);
  stageSramWrite(out, operations, operationName || writeInfo.name, targetOffset, newCode, {
    kind: PATCH_OPERATION_KIND.HOOK_REPLACE,
    codeName: writeInfo.code_name,
    sourceOffset: writeInfo.source_offset,
  });
}

export function writeSramU32Value(out, offset, value, operations, name) {
  stageSramWrite(out, operations, name, offset, u32ToBytes(value), {
    kind: PATCH_OPERATION_KIND.LITERAL_REPLACE,
    value: value >>> 0,
  });
}

// Compatibility exports retained for callers that imported the previous helper names.
export {
  findAlignedBytes as findAlignedMarker,
} from "../core/binary.js";
export {
  addPrefixGuardToRanges as rangesWithPrefixGuard,
  alignDown,
  alignUp,
  findTailBlankRegion as findTailFreeRegion,
  isBlankByte as isFreeByte,
  isBlankRegion as isFreeRegion,
  overlapsAnyRange as rangesOverlap,
} from "../core/ranges.js";
