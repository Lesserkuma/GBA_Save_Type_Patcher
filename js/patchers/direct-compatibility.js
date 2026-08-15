// SPDX-License-Identifier: GPL-3.0-or-later AND MIT

import { PatchError } from "../core/errors.js";
import { analyzeMirroredBatchSnapshot } from "./sram-batched-snapshot-analysis.js";

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
    const mirroredBatchSnapshot = analyzeMirroredBatchSnapshot(bytes, hooks);
    if (mirroredBatchSnapshot) {
      runtime = descriptor.familyRuntimes?.sramMirroredBatch;
      if (!runtime) {
        throw new PatchError(`${descriptor.label}: mirrored SRAM batch capability has no runtime.`);
      }
      profile = "sram-mirrored-batch-snapshot";
      return Object.freeze({
        profile,
        runtime,
        mirroredBatchSnapshot,
      });
    }
    if ((hooks.sramWriteVerify?.length ?? 0) > 0
        || (hooks.sramByteWriteCallers?.length ?? 0) > 0) {
      runtime = descriptor.familyRuntimes?.sramTransaction;
      if (!runtime) {
        throw new PatchError(`${descriptor.label}: SRAM transaction capability has no runtime.`);
      }
      profile = (hooks.sramWriteVerify?.length ?? 0) > 0
        ? "sram-write-verify-transaction"
        : "sram-byte-write-transaction";
    } else {
      /* The transaction runtime changes the stack and timing shape of every
       * write. Select it only for a combined Write/Verify ABI or a proved
       * immediate byte-write call; an ordinary complete SDK hook set remains
       * on the established base runtime. */
      profile = "sram-v16";
    }
  }

  return Object.freeze({
    profile,
    runtime,
    /* EEPROM writes are observably asynchronous on the original medium.
     * Keep a small, deterministic return delay for every EEPROM ABI instead
     * of inferring timing safety from a library label. */
    eepromWriteMode: hooks.family === "eeprom" ? "settled-wrapper" : "direct",
  });
}
