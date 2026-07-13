// SPDX-License-Identifier: GPL-3.0-or-later

import { WORKER_PROTOCOL_VERSION } from "../domain/constants.js";
import { PatchError } from "../core/errors.js";
import { hasOnlyKeys, isPatchOptions, isPatchResult, isRecord } from "../domain/contracts.js";

const PATCH_REQUEST_KEYS = new Set([
  "protocolVersion", "type", "requestId", "romId", "outputFileName",
  "romBuffer", "saveBuffer", "options",
]);
const CANCEL_REQUEST_KEYS = new Set(["protocolVersion", "type", "requestId"]);
const PATCH_COMPLETED_KEYS = new Set([
  "protocolVersion", "type", "requestId", "outputFileName", "patchedBuffer", "result",
]);
const PATCH_FAILED_KEYS = new Set(["protocolVersion", "type", "requestId", "error"]);
const SERIALIZED_ERROR_KEYS = new Set(["code", "stage", "message", "context", "recoverable"]);

export const WORKER_MESSAGE_TYPE = Object.freeze({
  PATCH_REQUEST: "patchRequest",
  PATCH_COMPLETED: "patchCompleted",
  PATCH_FAILED: "patchFailed",
  CANCEL_REQUEST: "cancelRequest",
});

export function isPatchRequest(message) {
  return Boolean(
    isRecord(message)
      && hasOnlyKeys(message, PATCH_REQUEST_KEYS)
      && message.protocolVersion === WORKER_PROTOCOL_VERSION
      && message.type === WORKER_MESSAGE_TYPE.PATCH_REQUEST
      && typeof message.requestId === "string"
      && message.requestId.length >= 8
      && typeof message.romId === "string"
      && typeof message.outputFileName === "string"
      && message.romBuffer instanceof ArrayBuffer
      && (message.saveBuffer === undefined || message.saveBuffer === null || message.saveBuffer instanceof ArrayBuffer)
      && isPatchOptions(message.options),
  );
}

export function isCancelRequest(message) {
  return Boolean(
    isRecord(message)
      && hasOnlyKeys(message, CANCEL_REQUEST_KEYS)
      && message.protocolVersion === WORKER_PROTOCOL_VERSION
      && message.type === WORKER_MESSAGE_TYPE.CANCEL_REQUEST
      && typeof message.requestId === "string"
      && message.requestId.length >= 8,
  );
}

export function isPatchResponse(message) {
  if (!isRecord(message) || message.protocolVersion !== WORKER_PROTOCOL_VERSION || typeof message.requestId !== "string") {
    return false;
  }
  if (message.type === WORKER_MESSAGE_TYPE.PATCH_COMPLETED) {
    return hasOnlyKeys(message, PATCH_COMPLETED_KEYS)
      && message.patchedBuffer instanceof ArrayBuffer
      && typeof message.outputFileName === "string"
      && message.outputFileName.length > 0
      && isPatchResult(message.result);
  }
  return message.type === WORKER_MESSAGE_TYPE.PATCH_FAILED
    && hasOnlyKeys(message, PATCH_FAILED_KEYS)
    && isSerializedPatchError(message.error);
}

export function isSerializedPatchError(error) {
  return Boolean(
    isRecord(error)
      && hasOnlyKeys(error, SERIALIZED_ERROR_KEYS)
      && typeof error.code === "string"
      && typeof error.stage === "string"
      && typeof error.message === "string"
      && isRecord(error.context)
      && typeof error.recoverable === "boolean",
  );
}

export function assertPatchRequest(message) {
  if (!isPatchRequest(message)) {
    throw new PatchError(`Worker request does not match protocol version ${WORKER_PROTOCOL_VERSION}.`, {
      code: "WORKER_INVALID_REQUEST",
      stage: "protocol",
      context: { receivedType: message?.type, receivedVersion: message?.protocolVersion },
    });
  }
  return message;
}

export function assertCancelRequest(message) {
  if (!isCancelRequest(message)) {
    throw new PatchError(`Worker cancel request does not match protocol version ${WORKER_PROTOCOL_VERSION}.`, {
      code: "WORKER_INVALID_CANCEL_REQUEST",
      stage: "protocol",
      context: { receivedVersion: message?.protocolVersion },
    });
  }
  return message;
}

export function serializePatchError(error, fallbackStage = "patch") {
  const patchError = PatchError.from(error, { code: "PATCH_FAILED", stage: fallbackStage });
  return {
    code: patchError.code,
    stage: patchError.stage,
    message: patchError.message,
    context: patchError.context,
    recoverable: patchError.isRecoverable,
  };
}
