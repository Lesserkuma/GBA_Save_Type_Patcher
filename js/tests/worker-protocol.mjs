// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";

import { WORKER_PROTOCOL_VERSION } from "../domain/constants.js";
import { isPatchResponse, WORKER_MESSAGE_TYPE } from "../worker/protocol.js";

const result = {
  statusCode: "changed",
  operations: [],
  warnings: [],
  inputSha256: "0".repeat(64),
  outputSha256: "1".repeat(64),
  patchPlan: { schemaVersion: 1, finalLength: 192, metadata: {} },
};
const response = {
  protocolVersion: WORKER_PROTOCOL_VERSION,
  type: WORKER_MESSAGE_TYPE.PATCH_COMPLETED,
  requestId: "request-1",
  outputFileName: "game.gba",
  patchedBuffer: new ArrayBuffer(192),
  convertedSaveBuffer: null,
  convertedSaveFileName: null,
  result,
};

assert.equal(isPatchResponse(response), true);
assert.equal(isPatchResponse({
  ...response,
  convertedSaveBuffer: new ArrayBuffer(65536),
  convertedSaveFileName: "game.sav",
}), true);
for (const invalid of [
  { convertedSaveBuffer: new ArrayBuffer(1), convertedSaveFileName: null },
  { convertedSaveBuffer: null, convertedSaveFileName: "game.sav" },
  { convertedSaveBuffer: new ArrayBuffer(1), convertedSaveFileName: "" },
  { requestId: "short" },
]) {
  assert.equal(isPatchResponse({ ...response, ...invalid }), false);
}

console.log("Worker protocol v4: ok");
