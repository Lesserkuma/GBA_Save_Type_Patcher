// SPDX-License-Identifier: GPL-3.0-or-later

import { normalizeOperations } from "../patch-engine/transaction.js";
import { PatchError } from "../core/errors.js";

const STATUS_MAP = Object.freeze({
  patched: "changed",
  unchanged: "unchanged",
  unsupported: "unsupported",
  skipped: "skipped",
  failed: "failed",
});

function statusCode(status) {
  const code = STATUS_MAP[status];
  if (!code) {
    throw new PatchError(`Unknown internal patch status: ${status}.`, {
      code: "PATCH_RESULT_STATUS_INVALID",
      stage: "resultContract",
      context: { status },
    });
  }
  return code;
}

function canonicalContractValue(value) {
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return value;
  if (Array.isArray(value)) return value.map(canonicalContractValue);
  const canonical = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (key.includes("_")) {
      throw new PatchError(`Patch result field is not canonical camelCase: ${key}.`, {
        code: "PATCH_RESULT_FIELD_INVALID",
        stage: "resultContract",
        context: { key },
      });
    }
    if (key === "status") canonical.statusCode = statusCode(nestedValue);
    else canonical[key] = canonicalContractValue(nestedValue);
  }
  return canonical;
}

export function normalizePatchResult(result) {
  const source = result || { status: "unchanged" };
  const { operations: sourceOperations, ...sourceFields } = source;
  const canonical = canonicalContractValue(sourceFields);
  const {
    statusCode: _statusCode,
    ...contractFields
  } = canonical;
  return {
    ...contractFields,
    statusCode: statusCode(source.status || "unchanged"),
    operations: normalizeOperations(sourceOperations),
    inputSha256: canonical.inputSha256 ?? null,
    outputSha256: canonical.outputSha256 ?? null,
    saveEmbedded: canonical.saveEmbedded ?? false,
    targetSaveSizeBytes: canonical.targetSaveSizeBytes ?? null,
    bankSwitchMode: canonical.bankSwitchMode ?? "none",
    flashJournal: canonical.flashJournal ?? null,
    irqHandler: canonical.irqHandler ?? null,
  };
}
