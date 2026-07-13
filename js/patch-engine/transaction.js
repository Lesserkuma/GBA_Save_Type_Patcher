// SPDX-License-Identifier: GPL-3.0-or-later

import { sameBytes } from "../core/binary.js";
import { PatchError } from "../core/errors.js";
import { GBA_MAX_ROM_SIZE_BYTES, PATCH_OPERATION_KIND } from "../domain/constants.js";
import { isPatchOperation } from "../domain/contracts.js";
import { PATCH_HEADER } from "../domain/gba-constants.js";
import { computeGbaHeaderChecksum } from "../patchers/patch-state.js";

const OPERATION_KINDS = new Set(Object.values(PATCH_OPERATION_KIND));

/**
 * @typedef {object} PatchOperation
 * @property {string} id
 * @property {string} kind
 * @property {string} component
 * @property {number} offset
 * @property {number} byteLength
 * @property {Uint8Array} expectedBefore
 * @property {Uint8Array} replacement
 * @property {string} labelKey
 * @property {number=} alignment
 * @property {string[]=} dependencies
 * @property {boolean=} allowOverlap
 * @property {Record<string, unknown>=} metadata
 */

/**
 * @typedef {object} PatchPlan
 * @property {1} schemaVersion
 * @property {number} finalLength
 * @property {PatchOperation[]} operations
 * @property {Record<string, unknown>=} metadata
 */

function assertRange(offset, byteLength, limit, code = "PATCH_PLAN_RANGE_ERROR") {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(byteLength) || offset < 0 || byteLength < 0 || offset + byteLength > limit) {
    throw new PatchError("Patch operation is outside the ROM.", {
      code,
      stage: "planValidation",
      context: { offset, byteLength, limit },
    });
  }
}

function validateOperation(operation, ids, finalLength) {
    if (!operation || typeof operation.id !== "string" || ids.has(operation.id) || !OPERATION_KINDS.has(operation.kind)) {
      throw new PatchError("Patch plan has an invalid operation identity or kind.", {
        code: "PATCH_OPERATION_INVALID",
        stage: "planValidation",
        context: { id: operation?.id, kind: operation?.kind },
      });
    }
    ids.add(operation.id);
    if (!(operation.replacement instanceof Uint8Array)) {
      throw new PatchError("Patch replacement must be bytes.", { code: "PATCH_OPERATION_INVALID", stage: "planValidation" });
    }
    if (operation.byteLength !== operation.replacement.length) {
      throw new PatchError("Patch operation length does not match its replacement.", {
        code: "PATCH_OPERATION_LENGTH_MISMATCH",
        stage: "planValidation",
        context: { id: operation.id },
      });
    }
    if (operation.kind === PATCH_OPERATION_KIND.ROM_EXPAND) finalLength = Math.max(finalLength, operation.offset + operation.byteLength);
    assertRange(operation.offset, operation.byteLength, finalLength);
    if (!(operation.expectedBefore instanceof Uint8Array) || operation.expectedBefore.length !== operation.byteLength) {
      throw new PatchError("Patch preimage length does not match the operation.", {
        code: "PATCH_PREIMAGE_LENGTH_MISMATCH",
        stage: "planValidation",
      });
    }
    if (operation.alignment !== undefined
        && (!Number.isSafeInteger(operation.alignment)
          || operation.alignment <= 0
          || operation.offset % operation.alignment !== 0)) {
      throw new PatchError("Patch operation does not satisfy its alignment.", {
        code: "PATCH_OPERATION_ALIGNMENT_ERROR",
        stage: "planValidation",
        context: { id: operation.id, offset: operation.offset, alignment: operation.alignment },
      });
    }
    if (operation.dependencies !== undefined
        && (!Array.isArray(operation.dependencies)
          || operation.dependencies.some((dependency) => typeof dependency !== "string"))) {
      throw new PatchError("Patch operation dependencies are invalid.", {
        code: "PATCH_OPERATION_DEPENDENCIES_INVALID",
        stage: "planValidation",
        context: { id: operation.id },
      });
    }
    return finalLength;
}

function validateDependencies(operations, ids) {
  for (const operation of operations) {
    for (const dependency of operation.dependencies || []) {
      if (!ids.has(dependency) || dependency === operation.id) {
        throw new PatchError("Patch operation references an unknown dependency.", {
          code: "PATCH_OPERATION_DEPENDENCY_UNKNOWN",
          stage: "planValidation",
          context: { id: operation.id, dependency },
        });
      }
    }
  }
}

function validateOverlaps(operations) {
  for (let currentIndex = 1; currentIndex < operations.length; currentIndex += 1) {
    const current = operations[currentIndex];
    for (let previousIndex = currentIndex - 1; previousIndex >= 0; previousIndex -= 1) {
      const previous = operations[previousIndex];
      if (previous.offset + previous.byteLength <= current.offset) continue;
      if (!previous.allowOverlap && !current.allowOverlap) {
        throw new PatchError("Patch operations overlap.", {
          code: "PATCH_OPERATION_OVERLAP",
          stage: "planValidation",
          context: { first: previous.id, second: current.id },
        });
      }
    }
  }
}

export function validatePatchPlan(plan, inputLength) {
  if (!plan || plan.schemaVersion !== 1 || !Array.isArray(plan.operations)) {
    throw new PatchError("Invalid patch plan.", { code: "PATCH_PLAN_INVALID", stage: "planValidation" });
  }
  const sorted = [...plan.operations].sort((a, b) => a.offset - b.offset || a.byteLength - b.byteLength);
  const ids = new Set();
  let finalLength = plan.finalLength ?? inputLength;
  if (!Number.isSafeInteger(finalLength) || finalLength < inputLength) {
    throw new PatchError("Patch plan has an invalid final ROM length.", {
      code: "PATCH_PLAN_FINAL_LENGTH_INVALID",
      stage: "planValidation",
      context: { inputLength, finalLength },
    });
  }
  for (const operation of sorted) finalLength = validateOperation(operation, ids, finalLength);
  validateDependencies(sorted, ids);
  validateOverlaps(sorted);
  return { ...plan, operations: sorted, finalLength };
}

export function applyPatchPlan(inputBytes, plan) {
  const validated = validatePatchPlan(plan, inputBytes.length);
  const output = new Uint8Array(validated.finalLength);
  output.fill(0xff);
  output.set(inputBytes);
  for (const operation of validated.operations) {
    const actual = output.slice(operation.offset, operation.offset + operation.byteLength);
    if (!sameBytes(actual, operation.expectedBefore)) {
      throw new PatchError("Patch preimage does not match.", {
        code: "PATCH_PREIMAGE_MISMATCH",
        stage: "apply",
        context: { operationId: operation.id, offset: operation.offset },
      });
    }
    output.set(operation.replacement, operation.offset);
  }
  verifyPatchResult(inputBytes, output, validated);
  return output;
}

export function verifyPatchResult(inputBytes, outputBytes, validatedPlan) {
  const explained = new Uint8Array(outputBytes.length);
  for (const operation of validatedPlan.operations) {
    explained.fill(1, operation.offset, operation.offset + operation.byteLength);
    const actual = outputBytes.slice(operation.offset, operation.offset + operation.byteLength);
    if (!sameBytes(actual, operation.replacement)) {
      throw new PatchError("Applied bytes do not match the patch plan.", {
        code: "PATCH_POSTIMAGE_MISMATCH",
        stage: "postApply",
        context: { operationId: operation.id },
      });
    }
  }
  for (let offset = 0; offset < outputBytes.length; offset += 1) {
    const before = offset < inputBytes.length ? inputBytes[offset] : 0xff;
    const isExpansion = offset >= inputBytes.length;
    if ((isExpansion || before !== outputBytes[offset]) && !explained[offset]) {
      throw new PatchError("Output contains an unexplained byte change.", {
        code: "PATCH_DIFF_UNEXPLAINED",
        stage: "postApply",
        context: { offset },
      });
    }
  }
  if (validatedPlan.metadata?.verifyHeaderChecksum && outputBytes.length > 0xbd) {
    const expectedChecksum = computeGbaHeaderChecksum(outputBytes);
    if (outputBytes[0xbd] !== expectedChecksum) {
      throw new PatchError("GBA header checksum is invalid after applying the patch plan.", {
        code: "PATCH_HEADER_CHECKSUM_INVALID",
        stage: "postApply",
        context: { expectedChecksum, actualChecksum: outputBytes[0xbd] },
      });
    }
  }
  if (validatedPlan.metadata?.expectedHeaderMarker !== undefined
      && outputBytes[PATCH_HEADER.markerOffset] !== validatedPlan.metadata.expectedHeaderMarker) {
    throw new PatchError("GBA header marker does not match the patch plan.", {
      code: "PATCH_HEADER_MARKER_INVALID",
      stage: "postApply",
      context: {
        expectedMarker: validatedPlan.metadata.expectedHeaderMarker,
        actualMarker: outputBytes[PATCH_HEADER.markerOffset],
      },
    });
  }
}

export function operationKind(operation) {
  if (operation.kind && OPERATION_KINDS.has(operation.kind)) return operation.kind;
  throw new PatchError("Patch operation kind must be explicit.", {
    code: "PATCH_OPERATION_KIND_REQUIRED",
    stage: "planNormalization",
    context: { id: operation?.id ?? null },
  });
}

const OPERATION_CONTRACT_KEYS = new Set([
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

function assertCanonicalMetadata(value, path = "metadata") {
  if (value === null || value === undefined || typeof value !== "object") return;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertCanonicalMetadata(item, `${path}[${index}]`));
    return;
  }
  for (const [key, nestedValue] of Object.entries(value)) {
    if (key.includes("_")) {
      throw new PatchError(`Patch operation field is not canonical camelCase: ${path}.${key}.`, {
        code: "PATCH_OPERATION_FIELD_INVALID",
        stage: "planNormalization",
        context: { key, path },
      });
    }
    assertCanonicalMetadata(nestedValue, `${path}.${key}`);
  }
}

export function normalizeOperations(operations) {
  if (!Array.isArray(operations)) {
    throw new PatchError("Patch operations must be an array.", {
      code: "PATCH_OPERATION_CONTRACT_INVALID",
      stage: "planNormalization",
    });
  }
  return operations.map((operation) => {
    operationKind(operation);
    const unexpectedKeys = Object.keys(operation || {})
      .filter((key) => !OPERATION_CONTRACT_KEYS.has(key));
    if (unexpectedKeys.length) {
      throw new PatchError(`Patch operation contains non-canonical fields: ${unexpectedKeys.join(", ")}.`, {
        code: "PATCH_OPERATION_FIELD_INVALID",
        stage: "planNormalization",
        context: { unexpectedKeys },
      });
    }
    assertCanonicalMetadata(operation.metadata);
    if (!isPatchOperation(operation)) {
      throw new PatchError("Patch operation does not satisfy the canonical contract.", {
        code: "PATCH_OPERATION_CONTRACT_INVALID",
        stage: "planNormalization",
        context: { id: operation?.id ?? null },
      });
    }
    return {
      ...operation,
      ...(operation.dependencies === undefined
        ? {}
        : { dependencies: [...operation.dependencies] }),
    };
  });
}

function validateReportedDependencies(operations) {
  const ids = new Set();
  for (const operation of operations) {
    if (operation.dependencies !== undefined
        && (!Array.isArray(operation.dependencies)
          || operation.dependencies.some((dependency) => typeof dependency !== "string"))) {
      throw new PatchError("Patch operation dependencies are invalid.", {
        code: "PATCH_OPERATION_DEPENDENCIES_INVALID",
        stage: "planValidation",
        context: { id: operation.id },
      });
    }
    if (operation.allowOverlap !== undefined && typeof operation.allowOverlap !== "boolean") {
      throw new PatchError("Patch operation overlap permission is invalid.", {
        code: "PATCH_OPERATION_CONTRACT_INVALID",
        stage: "planValidation",
        context: { id: operation.id },
      });
    }
    if (ids.has(operation.id)) {
      throw new PatchError("Patch operation IDs must be unique.", {
        code: "PATCH_OPERATION_INVALID",
        stage: "planValidation",
        context: { id: operation.id },
      });
    }
    ids.add(operation.id);
  }
  validateDependencies(operations, ids);
}

function validateReportedOverlaps(operations) {
  const writes = operations.filter((operation) => (
    operation.kind !== PATCH_OPERATION_KIND.ROM_EXPAND
    && operation.byteLength > 0
  ));
  for (let currentIndex = 1; currentIndex < writes.length; currentIndex += 1) {
    const current = writes[currentIndex];
    for (let previousIndex = 0; previousIndex < currentIndex; previousIndex += 1) {
      const previous = writes[previousIndex];
      const overlaps = previous.offset < current.offset + current.byteLength
        && current.offset < previous.offset + previous.byteLength;
      if (overlaps && !previous.allowOverlap && !current.allowOverlap) {
        throw new PatchError("Reported patch operations overlap without permission.", {
          code: "PATCH_OPERATION_OVERLAP",
          stage: "planValidation",
          context: { first: previous.id, second: current.id },
        });
      }
    }
  }
}

function replayReportedOperations(inputBytes, operations) {
  validateReportedDependencies(operations);
  validateReportedOverlaps(operations);
  let output = new Uint8Array(inputBytes);
  for (const operation of operations) {
    if (operation.alignment !== undefined
        && (!Number.isSafeInteger(operation.alignment)
          || operation.alignment <= 0
          || operation.offset % operation.alignment !== 0)) {
      throw new PatchError("Patch operation does not satisfy its alignment.", {
        code: "PATCH_OPERATION_ALIGNMENT_ERROR",
        stage: "planValidation",
        context: { id: operation.id, offset: operation.offset, alignment: operation.alignment },
      });
    }
    if (operation.kind === PATCH_OPERATION_KIND.ROM_EXPAND) {
      const expansionIsErased = operation.expectedBefore.every((value) => value === 0xff)
        && operation.replacement.every((value) => value === 0xff);
      const finalLength = operation.offset + operation.byteLength;
      if (operation.offset !== output.length
          || operation.byteLength <= 0
          || finalLength > GBA_MAX_ROM_SIZE_BYTES
          || !expansionIsErased) {
        throw new PatchError("ROM expansion is not a contiguous erased extension.", {
          code: "PATCH_DRAFT_EXPANSION_INVALID",
          stage: "planValidation",
          context: { id: operation.id, offset: operation.offset, inputLength: output.length },
        });
      }
      const expanded = new Uint8Array(finalLength);
      expanded.set(output);
      expanded.set(operation.replacement, operation.offset);
      output = expanded;
      continue;
    }
    assertRange(operation.offset, operation.byteLength, output.length, "PATCH_OPERATION_RANGE_ERROR");
    const actual = output.slice(operation.offset, operation.offset + operation.byteLength);
    if (!sameBytes(actual, operation.expectedBefore)) {
      throw new PatchError("Reported patch preimage does not match.", {
        code: "PATCH_PREIMAGE_MISMATCH",
        stage: "planValidation",
        context: { operationId: operation.id, offset: operation.offset },
      });
    }
    output.set(operation.replacement, operation.offset);
  }
  return output;
}

function operationRegion(operation) {
  return [operation.offset, operation.offset + operation.byteLength];
}

function mergedOperationRegions(operations) {
  const regions = operations
    .filter((operation) => operation.byteLength > 0)
    .map(operationRegion)
    .sort((first, second) => first[0] - second[0] || first[1] - second[1]);
  const merged = [];
  for (const region of regions) {
    const previous = merged.at(-1);
    if (!previous || region[0] > previous[1]) merged.push([...region]);
    else previous[1] = Math.max(previous[1], region[1]);
  }
  return merged;
}

function splitRegionAtInputEnd(region, inputLength) {
  const [start, end] = region;
  if (start < inputLength && end > inputLength) return [[start, inputLength], [inputLength, end]];
  return [region];
}

function operationMetadataForRegion(operations, start, end) {
  const sources = operations.filter((operation) => operation.offset < end && operation.offset + operation.byteLength > start);
  const kinds = [...new Set(sources.map((operation) => operation.kind))];
  const components = [...new Set(sources.map((operation) => operation.component))];
  return {
    kind: kinds.length === 1 ? kinds[0] : PATCH_OPERATION_KIND.HOOK_REPLACE,
    component: components.length === 1 ? components[0] : "patch",
    sourceOperationIds: sources.map((operation) => operation.id),
    sourceKinds: kinds,
  };
}

/**
 * Replays complete specialized-patcher operations against the original input,
 * cross-checks the private planning copy, and composes the canonical,
 * non-overlapping plan that alone may produce the final ROM.
 *
 * @param {Uint8Array} inputBytes
 * @param {Uint8Array} plannedOutputBytes
 * @param {object[]} reportedOperations
 * @returns {PatchPlan}
 */
export function createPatchPlan(inputBytes, plannedOutputBytes, reportedOperations) {
  if (!(inputBytes instanceof Uint8Array) || !(plannedOutputBytes instanceof Uint8Array)) {
    throw new TypeError("Patch plan input and output must be Uint8Array values.");
  }
  if (plannedOutputBytes.length < inputBytes.length) {
    throw new PatchError("Patch plans cannot shrink a ROM.", {
      code: "PATCH_PLAN_SHRINK_UNSUPPORTED",
      stage: "planCreation",
    });
  }
  const normalized = normalizeOperations(reportedOperations);
  const replayedOutput = replayReportedOperations(inputBytes, normalized);
  if (!sameBytes(replayedOutput, plannedOutputBytes)) {
    throw new PatchError("Private patch output differs from the reported operation replay.", {
      code: "PATCH_DRAFT_OUTPUT_MISMATCH",
      stage: "planCreation",
    });
  }
  const regions = mergedOperationRegions(normalized)
    .flatMap((region) => splitRegionAtInputEnd(region, inputBytes.length));
  const operations = regions.map(([start, end], index) => {
    const metadata = operationMetadataForRegion(normalized, start, end);
    const byteLength = end - start;
    const isExpansion = start >= inputBytes.length;
    const expectedBefore = isExpansion
      ? new Uint8Array(byteLength).fill(0xff)
      : inputBytes.slice(start, end);
    return {
      id: `transaction-region-${index}`,
      kind: isExpansion ? PATCH_OPERATION_KIND.ROM_EXPAND : metadata.kind,
      component: metadata.component,
      offset: start,
      byteLength,
      expectedBefore,
      replacement: replayedOutput.slice(start, end),
      labelKey: isExpansion ? "operation.romExpand" : "operation.transactionRegion",
      metadata: {
        sourceOperationIds: metadata.sourceOperationIds,
        sourceKinds: metadata.sourceKinds,
      },
    };
  });
  return {
    schemaVersion: 1,
    finalLength: plannedOutputBytes.length,
    operations,
    metadata: {
      inputLength: inputBytes.length,
      reportedOperationCount: normalized.length,
      verifyHeaderChecksum: plannedOutputBytes.length > 0xbd,
      ...(normalized.some((operation) => operation.kind === PATCH_OPERATION_KIND.HEADER_MARKER_WRITE)
        ? { expectedHeaderMarker: PATCH_HEADER.markerValue }
        : {}),
    },
  };
}

export function verifyOperationCoverage(inputBytes, outputBytes, operations) {
  const normalized = normalizeOperations(operations);
  const replayedOutput = replayReportedOperations(inputBytes, normalized);
  if (!sameBytes(replayedOutput, outputBytes)) {
    throw new PatchError("Patch output differs from the reported operation replay.", {
      code: "PATCH_DRAFT_OUTPUT_MISMATCH",
      stage: "postApply",
    });
  }
  const explained = new Uint8Array(outputBytes.length);
  for (const operation of normalized) {
    assertRange(operation.offset, operation.byteLength, outputBytes.length, "PATCH_OPERATION_RANGE_ERROR");
    explained.fill(1, operation.offset, operation.offset + operation.byteLength);
  }
  for (let offset = 0; offset < outputBytes.length; offset += 1) {
    const before = offset < inputBytes.length ? inputBytes[offset] : 0xff;
    const isExpansion = offset >= inputBytes.length;
    if ((isExpansion || before !== outputBytes[offset]) && !explained[offset]) {
      throw new PatchError("Patch output contains an unexplained byte change.", {
        code: "PATCH_DIFF_UNEXPLAINED",
        stage: "postApply",
        context: { offset },
      });
    }
  }
  return normalized;
}
