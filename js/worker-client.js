// SPDX-License-Identifier: GPL-3.0-or-later

import { PatchError } from "./core/errors.js";
import { WORKER_PROTOCOL_VERSION } from "./domain/constants.js";
import { isPatchResponse, WORKER_MESSAGE_TYPE } from "./worker/protocol.js";

let worker = null;
const pendingJobs = new Map();

function createRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function rejectAll(error) {
  for (const job of pendingJobs.values()) {
    job.signal?.removeEventListener("abort", job.abort);
    job.reject(error);
  }
  pendingJobs.clear();
}

function terminateWorker(error) {
  if (worker) worker.terminate();
  worker = null;
  rejectAll(error);
}

function handleMessage(event) {
  const message = event.data;
  if (!isPatchResponse(message)) {
    terminateWorker(new PatchError("Worker returned an invalid protocol message.", {
      code: "WORKER_INVALID_RESPONSE",
      stage: "protocol",
    }));
    return;
  }
  const job = pendingJobs.get(message.requestId);
  if (!job) return;
  pendingJobs.delete(message.requestId);
  job.signal?.removeEventListener("abort", job.abort);
  if (message.type === WORKER_MESSAGE_TYPE.PATCH_COMPLETED) {
    job.resolve(message);
    return;
  }
  job.reject(new PatchError(message.error.message, {
    code: message.error.code,
    stage: message.error.stage,
    context: message.error.context,
    isRecoverable: message.error.recoverable,
  }));
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./patch-worker.js", import.meta.url), { type: "module", name: "gba-patcher" });
  worker.addEventListener("message", handleMessage);
  worker.addEventListener("messageerror", () => {
    terminateWorker(new PatchError("Worker message could not be decoded.", {
      code: "WORKER_MESSAGE_ERROR",
      stage: "protocol",
    }));
  });
  worker.addEventListener("error", (event) => {
    terminateWorker(new PatchError(event.message || "Worker failed.", {
      code: "WORKER_FATAL_ERROR",
      stage: "worker",
    }));
  });
  return worker;
}

export function patchRomInWorker(payload, options = {}) {
  return new Promise((resolve, reject) => {
    const requestId = options.requestId || createRequestId();
    if (pendingJobs.has(requestId)) {
      reject(new PatchError("Duplicate worker request ID.", {
        code: "WORKER_DUPLICATE_REQUEST_ID",
        stage: "protocol",
        context: { requestId },
      }));
      return;
    }
    if (options.signal?.aborted) {
      reject(new PatchError("Patch request was cancelled.", {
        code: "WORKER_REQUEST_CANCELLED",
        stage: "worker",
        isRecoverable: true,
      }));
      return;
    }

    const message = {
      protocolVersion: WORKER_PROTOCOL_VERSION,
      type: WORKER_MESSAGE_TYPE.PATCH_REQUEST,
      requestId,
      romId: payload.romId,
      outputFileName: payload.outputFileName,
      romBuffer: payload.romBuffer,
      saveBuffer: payload.saveBuffer ?? null,
      options: payload.options,
    };
    const transfer = [payload.romBuffer];
    if (payload.saveBuffer) transfer.push(payload.saveBuffer);
    const abort = () => {
      const job = pendingJobs.get(requestId);
      if (!job) return;
      pendingJobs.delete(requestId);
      try {
        getWorker().postMessage({
          protocolVersion: WORKER_PROTOCOL_VERSION,
          type: WORKER_MESSAGE_TYPE.CANCEL_REQUEST,
          requestId,
        });
      } finally {
        job.reject(new PatchError("Patch request was cancelled.", {
          code: "WORKER_REQUEST_CANCELLED",
          stage: "worker",
          isRecoverable: true,
        }));
      }
    };
    pendingJobs.set(requestId, {
      resolve,
      reject,
      signal: options.signal,
      abort,
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      getWorker().postMessage(message, transfer);
    } catch (error) {
      pendingJobs.delete(requestId);
      options.signal?.removeEventListener("abort", abort);
      reject(PatchError.from(error, { code: "WORKER_POST_MESSAGE_FAILED", stage: "protocol" }));
    }
  });
}
