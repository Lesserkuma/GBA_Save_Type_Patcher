// SPDX-License-Identifier: GPL-3.0-or-later

import { MAX_RETAINED_OUTPUT_BYTES } from "../domain/constants.js";
import { PatchError } from "./errors.js";

export function assertRetainedOutputBudget(
  retainedBytes,
  outputBytes,
  limitBytes = MAX_RETAINED_OUTPUT_BYTES,
) {
  if (![retainedBytes, outputBytes, limitBytes].every(Number.isSafeInteger)
      || retainedBytes < 0
      || outputBytes < 0
      || limitBytes < 0) {
    throw new TypeError("Output memory budget values must be non-negative safe integers.");
  }
  if (retainedBytes + outputBytes > limitBytes) {
    const limitMiB = limitBytes / (1024 * 1024);
    throw new PatchError(`Patched outputs exceed the ${limitMiB} MiB retention budget.`, {
      code: "OUTPUT_MEMORY_LIMIT",
      stage: "outputRetention",
      context: { retainedBytes, outputBytes, limitBytes },
      isRecoverable: true,
    });
  }
}
