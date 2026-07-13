// SPDX-License-Identifier: GPL-3.0-or-later

import { sameBytes } from "../core/binary.js";
import { PatchError } from "../core/errors.js";
import { isPatchOperation } from "../domain/contracts.js";

const DRAFT_OPERATION_KEYS = new Set([
  "id",
  "kind",
  "component",
  "offset",
  "byteLength",
  "expectedBefore",
  "replacement",
  "labelKey",
  "alignment",
  "dependencies",
  "allowOverlap",
  "metadata",
]);

function draftError(message, code, context = {}) {
  return new PatchError(message, {
    code,
    stage: "patchPlanning",
    context,
  });
}

function validateDraftOperation(operation) {
  const unexpectedKeys = Object.keys(operation || {}).filter((key) => !DRAFT_OPERATION_KEYS.has(key));
  if (unexpectedKeys.length || !isPatchOperation(operation)) {
    throw draftError("Patch draft operation is not canonical.", "PATCH_DRAFT_OPERATION_INVALID", {
      unexpectedKeys,
    });
  }
}

function declareSequentialOverlaps(operations, operation) {
  if (operation.kind === "romExpand" || operation.byteLength === 0) return operation;
  const end = operation.offset + operation.byteLength;
  const overlappingIds = operations
    .filter((previous) => (
      previous.kind !== "romExpand"
      && previous.byteLength > 0
      && previous.offset < end
      && operation.offset < previous.offset + previous.byteLength
    ))
    .map((previous) => previous.id);
  if (overlappingIds.length === 0) return operation;
  return {
    ...operation,
    dependencies: [...new Set([...(operation.dependencies || []), ...overlappingIds])],
    allowOverlap: true,
  };
}

/**
 * Records a complete operation before applying it to a private planning copy.
 * The caller's bytes and operation list stay unchanged if validation fails.
 */
export function stagePatchOperation(bytes, operations, operation) {
  if (!(bytes instanceof Uint8Array) || !Array.isArray(operations)) {
    throw new TypeError("Patch draft requires Uint8Array bytes and an operation array.");
  }
  const stagedOperation = declareSequentialOverlaps(operations, operation);
  validateDraftOperation(stagedOperation);
  const end = stagedOperation.offset + stagedOperation.byteLength;
  if (end > bytes.length) {
    throw draftError("Patch draft operation is outside the planning copy.", "PATCH_DRAFT_RANGE_ERROR", {
      offset: stagedOperation.offset,
      byteLength: stagedOperation.byteLength,
      availableBytes: bytes.length,
    });
  }
  const actual = bytes.slice(stagedOperation.offset, end);
  if (!sameBytes(actual, stagedOperation.expectedBefore)) {
    throw draftError("Patch draft preimage does not match.", "PATCH_DRAFT_PREIMAGE_MISMATCH", {
      id: stagedOperation.id,
      offset: stagedOperation.offset,
    });
  }
  operations.push(stagedOperation);
  bytes.set(stagedOperation.replacement, stagedOperation.offset);
  return stagedOperation;
}

/** Records a ROM extension before replacing the caller's private planning copy. */
export function stageRomExpansion(rom, operations, operation) {
  if (!(rom?.bytes instanceof Uint8Array) || !Array.isArray(operations)) {
    throw new TypeError("ROM expansion draft requires ROM bytes and an operation array.");
  }
  validateDraftOperation(operation);
  const isErasedExtension = operation.expectedBefore.every((value) => value === 0xff)
    && operation.replacement.every((value) => value === 0xff);
  if (
    operation.kind !== "romExpand"
    || operation.offset !== rom.bytes.length
    || operation.byteLength <= 0
    || !isErasedExtension
  ) {
    throw draftError("ROM expansion draft is not a contiguous erased extension.", "PATCH_DRAFT_EXPANSION_INVALID", {
      offset: operation.offset,
      byteLength: operation.byteLength,
      inputLength: rom.bytes.length,
    });
  }
  const expanded = new Uint8Array(operation.offset + operation.byteLength);
  expanded.set(rom.bytes);
  expanded.set(operation.replacement, operation.offset);
  operations.push(operation);
  rom.bytes = expanded;
  return operation;
}
