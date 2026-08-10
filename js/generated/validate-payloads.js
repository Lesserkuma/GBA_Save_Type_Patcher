// SPDX-License-Identifier: GPL-3.0-or-later

import { hexToBytes } from "../core/binary.js";
import { sha256Hex } from "../core/hash.js";
import { PatchError } from "../core/errors.js";
import { BATTERYLESS_PAYLOAD_GBATA_HEX, BATTERYLESS_PAYLOAD_HEX } from "../patchers/sram-data.js";
import { FLASH_DIRECT_PAYLOAD_HEX } from "../patchers/flash-direct-data.js";
import { FLASH_DIRECT_PAYLOAD_HEX as FLASH_DIRECT_SNAPSHOT_HEX } from "../patchers/flash-direct-snapshot-data.js";
import { FLASH_DIRECT_PAYLOAD_HEX as FLASH_DIRECT_TRANSACTION_HEX } from "../patchers/flash-direct-transaction-data.js";
import { EEPROM_V120_RUNTIME_WRAPPER_HEX } from "../patchers/eeprom-v120-wrapper-data.js";
import { RTC_PAYLOAD_HEX } from "../patchers/rtc-data.js";
import { IRQ_HANDLER_PAYLOAD_HEX } from "../patchers/irq-handler-data.js";
import { PAYLOAD_MANIFESTS } from "./payload-manifests.js";

const ARTIFACTS = Object.freeze({
  batterylessSram: [BATTERYLESS_PAYLOAD_HEX, "GPL-3.0-or-later AND MIT"],
  batterylessSramGbata: [BATTERYLESS_PAYLOAD_GBATA_HEX, "GPL-3.0-or-later AND MIT"],
  flashDirect: [FLASH_DIRECT_PAYLOAD_HEX, "GPL-3.0-only AND MIT"],
  flashDirectSnapshot: [FLASH_DIRECT_SNAPSHOT_HEX, "GPL-3.0-only AND MIT"],
  flashDirectTransaction: [FLASH_DIRECT_TRANSACTION_HEX, "GPL-3.0-only AND MIT"],
  eepromV120Wrapper: [EEPROM_V120_RUNTIME_WRAPPER_HEX, "GPL-3.0-or-later AND MIT"],
  fakeRtc: [RTC_PAYLOAD_HEX, "GPL-3.0-or-later AND MIT"],
  sharedIrq: [IRQ_HANDLER_PAYLOAD_HEX, "GPL-3.0-or-later"],
});

function assertManifest(manifest, expectedLicenseExpression) {
  if (
    !manifest
    || manifest.schemaVersion !== 3
    || !manifest.payloadId
    || manifest.licenseExpression !== expectedLicenseExpression
    || !/^[0-9a-f]{64}$/.test(manifest.binarySha256)
    || !Number.isInteger(manifest.size)
    || manifest.size <= 0
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
  validationPromise ||= (async () => {
    const artifactKeys = Object.keys(ARTIFACTS);
    const manifestKeys = Object.keys(PAYLOAD_MANIFESTS);
    const manifestKeySet = new Set(manifestKeys);
    if (artifactKeys.length !== manifestKeys.length
        || artifactKeys.some((key) => !manifestKeySet.has(key))) {
      throw new PatchError("Payload manifest set does not match the executable artifacts.", {
        code: "PAYLOAD_MANIFEST_INVALID",
        stage: "initialization",
      });
    }
    await Promise.all(Object.entries(ARTIFACTS).map(async ([key, artifact]) => {
      const [hex, licenseExpression] = artifact;
      const manifest = PAYLOAD_MANIFESTS[key];
      assertManifest(manifest, licenseExpression);
      const bytes = hexToBytes(hex);
      if (bytes.length !== manifest.size || await sha256Hex(bytes) !== manifest.binarySha256) {
        throw new PatchError(`Payload ${manifest.payloadId} does not match its manifest.`, {
          code: "PAYLOAD_HASH_MISMATCH",
          stage: "initialization",
          context: { payloadId: manifest.payloadId, expectedSize: manifest.size, actualSize: bytes.length },
        });
      }
    }));
  })();
  return validationPromise;
}
