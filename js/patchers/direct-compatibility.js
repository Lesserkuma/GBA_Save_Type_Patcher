// SPDX-License-Identifier: GPL-3.0-or-later AND MIT

import { PatchError } from "../core/errors.js";
import { analyzeBatchedSramSnapshot } from "./sram-batched-snapshot-analysis.js";

/**
 * Build the complete Direct-backend strategy from save-library ABI evidence,
 * semantically derived hook capabilities, and nothing else.  In particular,
 * this module deliberately has no GBA-header parser and accepts no metadata.
 */
export function analyzeDirectCompatibility(bytes, hooks, descriptor) {
  if (!(bytes instanceof Uint8Array) || !hooks || !descriptor) {
    throw new PatchError("Direct compatibility analysis received invalid input.");
  }
  if (hooks.family !== "sram" && hooks.family !== "eeprom") {
    throw new PatchError("Direct compatibility analysis found no supported save family.");
  }

  let profile;
  let runtime = descriptor;
  if (hooks.family === "eeprom") {
    profile = hooks.eepromRuntimeTimer === true
      ? "eeprom-v120-runtime-timer"
      : "eeprom-v5";
  } else {
    const batchedSnapshot = analyzeBatchedSramSnapshot(bytes, hooks);
    if (batchedSnapshot) {
      runtime = descriptor.familyRuntimes?.sramBatched;
      if (!runtime) {
        throw new PatchError(`${descriptor.label}: batched SRAM capability has no runtime.`);
      }
      profile = "sram-batched-snapshot";
      return Object.freeze({
        profile,
        runtime,
        batchedSnapshot,
      });
    }
    if ((hooks.sramWriteVerify?.length ?? 0) > 0) {
      runtime = descriptor.familyRuntimes?.sramTransaction;
      if (!runtime) {
        throw new PatchError(`${descriptor.label}: SRAM transaction capability has no runtime.`);
      }
      profile = "sram-transaction-v16";
    } else {
      profile = "sram-v16";
    }
  }

  return Object.freeze({
    profile,
    runtime,
    eepromWriteMode: hooks.family === "eeprom"
      && (hooks.eepromRuntimeTimer === true
        || hooks.sourceSaveType === "EEPROM_V122")
      ? "settled-wrapper"
      : "direct",
  });
}
