// SPDX-License-Identifier: GPL-3.0-or-later

import { hexToBytes } from "../core/binary.js";
import { PatchError } from "../core/errors.js";
import { BATTERYLESS_PAYLOAD_GBATA_HEX, BATTERYLESS_PAYLOAD_HEX } from "../patchers/sram-data.js";
import { FLASH512K_PAYLOAD_HEX as FLASH_JOURNAL_HEX } from "../patchers/flash512k-data.js";
import { FLASH512K_PAYLOAD_HEX as CUSTOM_FLASH_JOURNAL_HEX } from "../patchers/custom-journal-data.js";
import { RTC_PAYLOAD_HEX } from "../patchers/rtc-data.js";
import { IRQ_HANDLER_PAYLOAD_HEX } from "../patchers/irq-handler-data.js";
import { PAYLOAD_MANIFESTS } from "./payload-manifests.js";

const ARTIFACTS = Object.freeze({
  batterylessSram: BATTERYLESS_PAYLOAD_HEX,
  batterylessSramGbata: BATTERYLESS_PAYLOAD_GBATA_HEX,
  flashJournal: FLASH_JOURNAL_HEX,
  customFlashJournal: CUSTOM_FLASH_JOURNAL_HEX,
  fakeRtc: RTC_PAYLOAD_HEX,
  sharedIrq: IRQ_HANDLER_PAYLOAD_HEX,
});

function bytesToHex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256(bytes) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

function assertManifest(manifest) {
  if (
    !manifest
    || manifest.schemaVersion !== 1
    || !manifest.payloadId
    || !Number.isInteger(manifest.payloadVersion)
    || !manifest.licenseExpression
    || !/^[0-9a-f]{64}$/.test(manifest.sourceSha256)
    || !/^[0-9a-f]{64}$/.test(manifest.binarySha256)
    || !manifest.toolchain?.gcc
    || !manifest.toolchain?.binutils
    || !Number.isInteger(manifest.size)
    || !Number.isInteger(manifest.alignment)
    || manifest.alignment <= 0
    || (manifest.alignment & (manifest.alignment - 1)) !== 0
    || !manifest.symbols
    || !manifest.configOffsets
    || !Array.isArray(manifest.relocations)
  ) {
    throw new PatchError("Payload manifest is incomplete.", {
      code: "PAYLOAD_MANIFEST_INVALID",
      stage: "initialization",
      context: { payloadId: manifest?.payloadId },
    });
  }
}

let validationPromise;

export function validatePayloadArtifacts() {
  validationPromise ||= Promise.all(Object.entries(ARTIFACTS).map(async ([key, hex]) => {
    const manifest = PAYLOAD_MANIFESTS[key];
    assertManifest(manifest);
    const bytes = hexToBytes(hex);
    if (bytes.length !== manifest.size || await sha256(bytes) !== manifest.binarySha256) {
      throw new PatchError(`Payload ${manifest.payloadId} does not match its manifest.`, {
        code: "PAYLOAD_HASH_MISMATCH",
        stage: "initialization",
        context: { payloadId: manifest.payloadId, expectedSize: manifest.size, actualSize: bytes.length },
      });
    }
  }));
  return validationPromise;
}
