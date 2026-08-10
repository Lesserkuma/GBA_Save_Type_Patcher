// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";

import { cloneDefaultOptions, WORKER_PROTOCOL_VERSION } from "../domain/constants.js";
import { DIRECT_SRAM_LAYOUTS } from "../patchers/direct-abi-signatures.js";
import {
  RTC_HANDLER_SIGNATURES,
  RTC_PERSISTENCE_CUSTOM_BACKEND_FLAG,
  RTC_PERSISTENCE_SHARED_SAVE_AREA_FLAG,
} from "../patchers/rtc.js";
import { WORKER_MESSAGE_TYPE } from "../worker/protocol.js";

function writeU16(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = value >>> 8;
}

function repairHeaderChecksum(bytes) {
  let sum = 0;
  for (let offset = 0xa0; offset <= 0xbc; offset += 1) sum += bytes[offset];
  bytes[0xbd] = (-(sum + 0x19)) & 0xff;
}

function syntheticRtcSramRom() {
  const bytes = new Uint8Array(0x100000);
  const saveType = "SRAM_F_V102";
  const layout = DIRECT_SRAM_LAYOUTS[saveType];
  const saveLibraryBase = 0x200;

  // Ordinary GBA entrypoint branch and fixed header byte.
  bytes.set([0x2e, 0x00, 0x00, 0xea], 0);
  bytes[0xb2] = 0x96;
  bytes.set(new TextEncoder().encode(saveType), 0x100);
  bytes.set(layout.read.marker, saveLibraryBase + layout.read.offset);
  bytes.set(layout.write.marker, saveLibraryBase + layout.write.offset);
  bytes.set(layout.verify.marker, saveLibraryBase + layout.verify.offset);

  let signatureOffset = 0x1000;
  for (const name of ["probe", "reset", "getstatus", "gettimedate"]) {
    RTC_HANDLER_SIGNATURES[name].forEach((rawValue, index) => {
      writeU16(bytes, signatureOffset + index * 2, rawValue || 0xffff);
    });
    signatureOffset += 0x200;
  }
  repairHeaderChecksum(bytes);
  return bytes;
}

const pendingResponses = new Map();
let workerMessageHandler = null;
globalThis.self = {
  addEventListener(type, callback) {
    assert.equal(type, "message");
    workerMessageHandler = callback;
  },
  postMessage(message) {
    const resolve = pendingResponses.get(message.requestId);
    if (!resolve) return;
    pendingResponses.delete(message.requestId);
    resolve(message);
  },
};

await import("../patch-worker.js");
assert.equal(typeof workerMessageHandler, "function");

async function patchMode(patchMode, persistenceEnabled = true) {
  const options = cloneDefaultOptions();
  options.patchMode = patchMode;
  options.rtc.enabled = true;
  options.rtc.tickMode = "read";
  options.rtc.saveOnGlobalHotkey = persistenceEnabled;
  options.batteryless.hotkeyMask = 0x204;
  if (patchMode === "custom-flash") options.customFlash.saveChipType = 1;

  const requestId = `rtc-${patchMode}-${persistenceEnabled ? "on" : "off"}`;
  const response = new Promise((resolve) => pendingResponses.set(requestId, resolve));
  const rom = syntheticRtcSramRom();
  workerMessageHandler({
    data: {
      protocolVersion: WORKER_PROTOCOL_VERSION,
      type: WORKER_MESSAGE_TYPE.PATCH_REQUEST,
      requestId,
      romId: requestId,
      outputFileName: `${requestId}.gba`,
      romBuffer: rom.buffer,
      saveBuffer: null,
      options,
    },
  });
  return response;
}

for (const mode of ["sram", "flash512k", "custom-flash", "none", "batteryless-sram"]) {
  const response = await patchMode(mode);
  assert.equal(response.type, WORKER_MESSAGE_TYPE.PATCH_COMPLETED, response.error?.message);
  const { result } = response;
  assert.equal(result.rtc.statusCode, "changed", `${mode}: Fake RTC`);
  assert.equal(result.irqHandler.statusCode, "changed", `${mode}: shared IRQ`);
  assert.ok(result.rtc.persistenceFlushEntry > 0, `${mode}: persistence flush entry`);
  assert.equal(result.rtc.persistence.size, 0x40000, `${mode}: persistence size`);
  assert.ok(
    !result.warnings.some((warning) => warning.includes("only available with Batteryless SRAM")),
    `${mode}: obsolete warning`,
  );

  if (mode === "batteryless-sram") {
    assert.equal(result.rtc.persistence.flags, RTC_PERSISTENCE_SHARED_SAVE_AREA_FLAG);
    continue;
  }
  assert.ok(
    result.reservedRanges.some(([start, end]) => end - start === 0x40000),
    `${mode}: standalone persistence reserve`,
  );
  assert.equal(
    result.rtc.persistence.flags,
    mode === "custom-flash" ? RTC_PERSISTENCE_CUSTOM_BACKEND_FLAG : 0,
    `${mode}: persistence backend flags`,
  );
  assert.equal(
    result.irqHandler.saveFlushEntry,
    result.rtc.persistenceFlushEntry,
    `${mode}: menu-close flush callback`,
  );
  assert.equal(result.irqHandler.saveFlushHotkey, true, `${mode}: menu-close flush enabled`);
  assert.equal(result.irqHandler.saveFlushAuto, false, `${mode}: no unrelated automatic flush`);
}

const disabledResponse = await patchMode("sram", false);
assert.equal(disabledResponse.type, WORKER_MESSAGE_TYPE.PATCH_COMPLETED);
assert.equal(disabledResponse.result.rtc.persistence, null);
assert.deepEqual(disabledResponse.result.reservedRanges ?? [], []);
assert.equal(disabledResponse.result.irqHandler.saveFlushEntry, 0);
assert.equal(disabledResponse.result.irqHandler.saveFlushHotkey, false);

console.log("Fake RTC persistence across save modes: PASS");
