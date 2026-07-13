// SPDX-License-Identifier: GPL-3.0-or-later

import { PATCH_STATUS } from "./constants.js";

const STATUS_MESSAGES = Object.freeze({
  [PATCH_STATUS.READY]: "Ready",
  [PATCH_STATUS.PATCHING]: "Patching...",
  [PATCH_STATUS.CHANGED]: "Patched",
  [PATCH_STATUS.UNCHANGED]: "No changes",
  [PATCH_STATUS.UNSUPPORTED]: "Unsupported",
  [PATCH_STATUS.SKIPPED]: "Skipped",
  [PATCH_STATUS.FAILED]: "Error",
  [PATCH_STATUS.INVALID]: "Invalid ROM header",
});

export const UI_TEXT = Object.freeze({
  ADDING_FILES: "Adding files...",
  INVALID_GBA_HEADER: "Invalid GBA header.",
  TOTAL_INPUT_LIMIT: "The selected files exceed the 512 MiB input memory budget.",
  SAVE_BASENAME_CONFLICT: "Multiple save files have the same basename.",
  REMOVE: "Remove",
  REMOVE_MATCHING_SAVE: "Remove this matching .sav file",
  PATCHING: "Patching...",
  PATCH_ROMS: "Patch ROMs",
  READY_PROMPT: "Drop ROMs and optional .sav files to begin.",
  SAVE_BADGE: "+SAVE",
  UNKNOWN_LIBRARY: "UNKNOWN",
  UNKNOWN_SAVE_TYPE: "Unknown",
  ADD_FILES_FIRST: "Add at least one valid ROM first.",
  SAVE_FILES_CACHED: "Save file(s) cached for Batteryless SRAM mode.",
  PATCHING_ROMS: "Patching ROMs...",
  NO_PATCH_OUTPUT_ERROR: "No ROMs could be patched. Check the errors in the ROM list.",
  NO_PATCH_OUTPUT_WARNING: "No ROM output was produced. Check the warnings in the ROM list.",
  NO_CHANGES: "No changes were necessary.",
  DOWNLOAD_COMPLETE: "Patched ROM downloaded.",
  DOWNLOAD_WITH_WARNINGS: "Patched ROM downloaded with warnings.",
  ROM_REMOVED: "ROM removed.",
  SAVE_REMOVED: "Matching save file removed.",
  LIST_CLEARED: "List cleared.",
  BATTERYLESS_DELAY_INVALID: "Flush delay must be a number from 0 to 255.",
  JOURNAL_DELAY_INVALID: "Journal flush delay must be a number from 1 to 255.",
  JOURNAL_INDICATOR_INVALID: "Journal save indicator must be save, countdown, or off.",
  CUSTOM_FLASH_MODEL_INVALID: "Select a valid custom Flash chip model.",
  RTC_TICK_MODE_INVALID: "Select a valid Fake RTC clock update mode.",
  HOTKEY_REQUIRED: "Select at least one hotkey button.",
  PATCH_SELECTION_REQUIRED: "Select an optional patch or choose a save type patch mode.",
});

export const uiMessage = Object.freeze({
  addingFile: (fileName) => fileName ? `Adding ${fileName}` : UI_TEXT.ADDING_FILES,
  progressCount: (current, total) => `${current} / ${total}`,
  statusWithWarning: (status) => `${status} + warning`,
  ariaError: (message) => `Error: ${message}`,
  ariaWarning: (message) => `Warning: ${message}`,
  matchingSaves: (count) => `${count} matching save file(s) available`,
  saveConflictsSummary: (count) => `${count} save basename conflict(s) must be resolved`,
  fileCountLimit: (count) => `At most ${count} files can be loaded at once.`,
  romSizeLimit: (name) => `${name}: ROM size must be between 192 bytes and 32 MiB.`,
  saveSizeLimit: (name) => `${name}: save files larger than 128 KiB are not accepted.`,
  suspiciousHeader: (issues) => `Suspicious GBA header: ${issues.join(", ")}.`,
  ambiguousSignatures: (candidates) => `Ambiguous save signatures: ${candidates.join(", ")}.`,
  conflictingSaves: (baseNames) => `Conflicting save files: ${baseNames.join(", ")}. Remove duplicates before patching.`,
  ignoredFiles: (fileNames) => `Ignored unsupported files: ${fileNames.join(", ")}`,
  romsAdded: (count) => `${count} ROM file(s) added.`,
  exactSaveSize: (name, size) => `${name}: save size must be exactly ${size} bytes.`,
  zipComplete: (count, withWarnings) => `${count} patched ROM(s) added to the ZIP${withWarnings ? " with warnings" : ""}.`,
  unsupportedPatchMode: (mode) => `Unsupported patch mode: ${mode}.`,
  startupFailed: (message) => `Application startup failed: ${message}`,
});

export function statusMessage(statusCode) {
  return STATUS_MESSAGES[statusCode] || "Unknown status";
}
