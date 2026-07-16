// SPDX-License-Identifier: GPL-3.0-or-later

export const APP_VERSION = "1.9";
export const WORKER_PROTOCOL_VERSION = 2;

export const GBA_MAX_ROM_SIZE_BYTES = 32 * 1024 * 1024;
export const MAX_FILE_COUNT = 64;
export const MAX_TOTAL_INPUT_BYTES = 512 * 1024 * 1024;
export const MAX_RETAINED_OUTPUT_BYTES = MAX_TOTAL_INPUT_BYTES;
export const MAX_SAVE_FILE_SIZE_BYTES = 128 * 1024;
export const DOCUMENTED_SAVE_SIZES_BYTES = new Set([512, 8 * 1024, 32 * 1024, 64 * 1024, 128 * 1024]);

export const PATCH_MODES = Object.freeze({
  NONE: "none",
  SRAM: "sram",
  BATTERYLESS_SRAM: "batteryless-sram",
  FLASH_JOURNAL: "flash512k",
  CUSTOM_FLASH: "custom-flash",
});

export const PATCH_STATUS = Object.freeze({
  READY: "ready",
  PATCHING: "patching",
  CHANGED: "changed",
  UNCHANGED: "unchanged",
  UNSUPPORTED: "unsupported",
  SKIPPED: "skipped",
  FAILED: "failed",
  INVALID: "invalid",
});

export const RTC_TICK_MODES = Object.freeze({
  VBLANK: "vblank",
  READ: "read",
});

export const PATCH_OPERATION_KIND = Object.freeze({
  ROM_EXPAND: "romExpand",
  PAYLOAD_INSTALL: "payloadInstall",
  HOOK_REPLACE: "hookReplace",
  LITERAL_REPLACE: "literalReplace",
  HEADER_MARKER_WRITE: "headerMarkerWrite",
  HEADER_CHECKSUM_WRITE: "headerChecksumWrite",
  CONFIG_WRITE: "configWrite",
  SAVE_EMBED: "saveEmbed",
  BANK_SWITCH_PATCH: "bankSwitchPatch",
});

export const DEFAULT_OPTIONS = Object.freeze({
  patchMode: PATCH_MODES.SRAM,
  batteryless: Object.freeze({
    mode: "auto",
    countdownFrames: 100,
    indicator: "save",
    lastBlock: "usable",
    hotkey: Object.freeze(["select", "l"]),
  }),
  flash512k: Object.freeze({ countdownFrames: 100, indicator: "save" }),
  sram: Object.freeze({ flash1mBankSwitchStyle: "modern" }),
  customFlash: Object.freeze({ saveChipModel: "sst25vf064cFamily" }),
  waitstate: Object.freeze({ enabled: false, mode: "supercard_exact" }),
  rtc: Object.freeze({
    enabled: false,
    tickMode: RTC_TICK_MODES.VBLANK,
    saveOnGlobalHotkey: true,
  }),
});

export function cloneDefaultOptions() {
  return structuredClone(DEFAULT_OPTIONS);
}
