// SPDX-License-Identifier: GPL-3.0-or-later

export const APP_VERSION = "1.12";
export const WORKER_PROTOCOL_VERSION = 5;

export {
  GBA_MAX_ROM_SIZE_BYTES,
  GBA_PAYLOAD_PLACEMENT_LIMIT_BYTES,
} from "./gba-constants.js";
export const MAX_FILE_COUNT = 64;
export const MAX_TOTAL_INPUT_BYTES = 512 * 1024 * 1024;
export const MAX_RETAINED_OUTPUT_BYTES = MAX_TOTAL_INPUT_BYTES;
export const MAX_SAVE_FILE_SIZE_BYTES = 128 * 1024;
export const DOCUMENTED_SAVE_SIZES_BYTES = new Set([512, 8 * 1024, 32 * 1024, 64 * 1024, 128 * 1024]);

export const PATCH_MODES = Object.freeze({
  NONE: "none",
  SRAM: "sram",
  BATTERYLESS_SRAM: "batteryless-sram",
  FLASH_512K: "flash512k",
  CUSTOM_FLASH: "custom-flash",
});

export const CUSTOM_FLASH_SAVE_CHIP_MODELS = Object.freeze({
  TYPE_1: "customType1",
  TYPE_2: "customType2",
});

export const CUSTOM_FLASH_SAVE_CHIP_TYPES = Object.freeze({
  TYPE_1: 1,
  TYPE_2: 2,
});

const CUSTOM_FLASH_TYPE_BY_MODEL = Object.freeze({
  [CUSTOM_FLASH_SAVE_CHIP_MODELS.TYPE_1]: CUSTOM_FLASH_SAVE_CHIP_TYPES.TYPE_1,
  [CUSTOM_FLASH_SAVE_CHIP_MODELS.TYPE_2]: CUSTOM_FLASH_SAVE_CHIP_TYPES.TYPE_2,
});

const CUSTOM_FLASH_MODEL_BY_TYPE = Object.freeze({
  [CUSTOM_FLASH_SAVE_CHIP_TYPES.TYPE_1]: CUSTOM_FLASH_SAVE_CHIP_MODELS.TYPE_1,
  [CUSTOM_FLASH_SAVE_CHIP_TYPES.TYPE_2]: CUSTOM_FLASH_SAVE_CHIP_MODELS.TYPE_2,
});

export function customFlashSaveChipTypeFromModel(model) {
  return Object.hasOwn(CUSTOM_FLASH_TYPE_BY_MODEL, model)
    ? CUSTOM_FLASH_TYPE_BY_MODEL[model]
    : null;
}

export function customFlashSaveChipModelFromType(type) {
  return Object.hasOwn(CUSTOM_FLASH_MODEL_BY_TYPE, type)
    ? CUSTOM_FLASH_MODEL_BY_TYPE[type]
    : null;
}

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

export const PATCH_REASON_CODE = Object.freeze({
  AMBIGUOUS_SAVE_TYPE: "AMBIGUOUS_SAVE_TYPE",
  UNSUPPORTED_SAVE_TYPE: "UNSUPPORTED_SAVE_TYPE",
  INCOMPATIBLE_SAVE_SIZE: "INCOMPATIBLE_SAVE_SIZE",
  ROM_CAPACITY: "ROM_CAPACITY",
  SAVE_WRITE_ROUTINE_UNPROVEN: "SAVE_WRITE_ROUTINE_UNPROVEN",
  INCOMPLETE_HOOK_SET: "INCOMPLETE_HOOK_SET",
  DIRECT_SRAM_PRIVATE_WORKSPACE_UNPROVEN: "DIRECT_SRAM_PRIVATE_WORKSPACE_UNPROVEN",
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
  sram: Object.freeze({ flash1mBankSwitchStyle: "modern" }),
  customFlash: Object.freeze({ saveChipModel: CUSTOM_FLASH_SAVE_CHIP_MODELS.TYPE_1 }),
  waitstate: Object.freeze({ enabled: false, mode: "supercard_exact" }),
  rtc: Object.freeze({
    enabled: false,
    tickMode: RTC_TICK_MODES.VBLANK,
    showMenuOnBoot: true,
    saveOnGlobalHotkey: true,
  }),
});

export function cloneDefaultOptions() {
  return structuredClone(DEFAULT_OPTIONS);
}
