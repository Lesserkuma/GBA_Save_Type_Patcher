// SPDX-License-Identifier: GPL-3.0-or-later

export class PatchError extends Error {
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = "PatchError";
    this.code = options.code || "PATCH_ERROR";
    this.stage = options.stage || "patch";
    this.context = options.context && typeof options.context === "object" ? options.context : {};
    this.isRecoverable = options.isRecoverable ?? false;
  }

  static from(error, defaults = {}) {
    if (error instanceof PatchError) return error;
    return new PatchError(error instanceof Error ? error.message : String(error), {
      ...defaults,
      cause: error instanceof Error ? error : undefined,
    });
  }
}
