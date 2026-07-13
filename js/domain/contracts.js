// SPDX-License-Identifier: GPL-3.0-or-later

import {
  PATCH_MODES,
  PATCH_OPERATION_KIND,
  PATCH_STATUS,
  RTC_TICK_MODES,
} from "./constants.js";

/** @typedef {{medium: string, size: number|null, library: string|null, label: string}} SaveMetadata */
/** @typedef {{id: string, name: string, baseName: string, size: number, statusCode: string}} RomEntry */
/** @typedef {{schemaVersion: 1, finalLength: number, metadata: object}} PatchPlanSummary */
/** @typedef {{id: string, kind: string, component: string, offset: number, byteLength: number, labelKey: string}} PatchOperation */
/** @typedef {{patchMode: string, batteryless: object, flash512k: object, customFlash: object, sram: object, waitstate: object, rtc: object}} PatchOptions */
/**
 * @typedef {{statusCode: string, operations: PatchOperation[], warnings: string[],
 * inputSha256: string, outputSha256: string, patchPlan: PatchPlanSummary}} PatchResult
 */

const PATCH_MODE_VALUES = new Set(Object.values(PATCH_MODES));
const OPERATION_KIND_VALUES = new Set(Object.values(PATCH_OPERATION_KIND));
const RESULT_STATUS_VALUES = new Set([
  PATCH_STATUS.CHANGED,
  PATCH_STATUS.UNCHANGED,
  PATCH_STATUS.UNSUPPORTED,
  PATCH_STATUS.SKIPPED,
  PATCH_STATUS.FAILED,
]);
const HOTKEY_VALUES = new Set(["a", "b", "select", "start", "right", "left", "up", "down", "r", "l"]);
const PATCH_OPTION_KEYS = new Set(["patchMode", "batteryless", "flash512k", "customFlash", "sram", "waitstate", "rtc"]);
const BATTERYLESS_OPTION_KEYS = new Set(["mode", "countdownFrames", "indicator", "lastBlock", "hotkey", "hotkeyMask"]);
const FLASH512K_OPTION_KEYS = new Set(["countdownFrames", "indicator"]);
const CUSTOM_FLASH_OPTION_KEYS = new Set(["saveChipModel", "saveChipType"]);
const SRAM_OPTION_KEYS = new Set(["flash1mBankSwitchStyle"]);
const WAITSTATE_OPTION_KEYS = new Set(["enabled", "mode"]);
const RTC_OPTION_KEYS = new Set(["enabled", "tickMode", "saveOnGlobalHotkey"]);
const PATCH_OPERATION_KEYS = new Set([
  "id", "kind", "component", "offset", "byteLength", "expectedBefore",
  "replacement", "labelKey", "alignment", "dependencies", "allowOverlap", "metadata",
]);

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hasOnlyKeys(value, allowedKeys) {
  return isRecord(value) && Object.keys(value).every((key) => allowedKeys.has(key));
}

function isIntegerBetween(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function isSha256Hex(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function hasOnlyCanonicalKeys(value, seen = new Set()) {
  if (value === null || value === undefined || typeof value !== "object") return true;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return true;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((item) => hasOnlyCanonicalKeys(item, seen));
  return Object.entries(value).every(
    ([key, nested]) => !key.includes("_") && hasOnlyCanonicalKeys(nested, seen),
  );
}

export function isPatchOptions(options) {
  if (!isRecord(options)
      || !hasOnlyKeys(options, PATCH_OPTION_KEYS)
      || !PATCH_MODE_VALUES.has(options.patchMode)
      || !isRecord(options.batteryless)
      || !isRecord(options.flash512k)
      || !isRecord(options.customFlash)
      || !isRecord(options.sram)
      || !isRecord(options.waitstate)
      || !isRecord(options.rtc)) return false;

  const batteryless = options.batteryless;
  if (!hasOnlyKeys(batteryless, BATTERYLESS_OPTION_KEYS)
      || !hasOnlyKeys(options.flash512k, FLASH512K_OPTION_KEYS)
      || !hasOnlyKeys(options.customFlash, CUSTOM_FLASH_OPTION_KEYS)
      || !hasOnlyKeys(options.sram, SRAM_OPTION_KEYS)
      || !hasOnlyKeys(options.waitstate, WAITSTATE_OPTION_KEYS)
      || !hasOnlyKeys(options.rtc, RTC_OPTION_KEYS)
      || !["auto", "keypad"].includes(batteryless.mode)
      || !isIntegerBetween(batteryless.countdownFrames, 0, 255)
      || !["save", "countdown", "off"].includes(batteryless.indicator)
      || !["usable", "keep-empty"].includes(batteryless.lastBlock)
      || !Array.isArray(batteryless.hotkey)
      || batteryless.hotkey.some((key) => !HOTKEY_VALUES.has(key))
      || (batteryless.hotkeyMask !== undefined && !isIntegerBetween(batteryless.hotkeyMask, 0, 0x03ff))) return false;

  if (!isIntegerBetween(options.flash512k.countdownFrames, 1, 255)
      || !["save", "countdown", "off"].includes(options.flash512k.indicator)
      || !["sst25vf064cFamily", "sst39vf6401b"].includes(options.customFlash.saveChipModel)
      || !["modern", "gbata"].includes(options.sram.flash1mBankSwitchStyle)
      || typeof options.waitstate.enabled !== "boolean"
      || options.waitstate.mode !== "supercard_exact"
      || typeof options.rtc.enabled !== "boolean"
      || typeof options.rtc.saveOnGlobalHotkey !== "boolean"
      || !Object.values(RTC_TICK_MODES).includes(options.rtc.tickMode)) return false;

  if (options.patchMode === PATCH_MODES.CUSTOM_FLASH
      && ![1, 2].includes(options.customFlash.saveChipType)) return false;
  return true;
}

export function isPatchOperation(operation) {
  return Boolean(
    isRecord(operation)
      && hasOnlyKeys(operation, PATCH_OPERATION_KEYS)
      && typeof operation.id === "string"
      && operation.id.length > 0
      && OPERATION_KIND_VALUES.has(operation.kind)
      && typeof operation.component === "string"
      && operation.component.length > 0
      && Number.isSafeInteger(operation.offset)
      && operation.offset >= 0
      && Number.isSafeInteger(operation.byteLength)
      && operation.byteLength >= 0
      && typeof operation.labelKey === "string"
      && operation.expectedBefore instanceof Uint8Array
      && operation.expectedBefore.length === operation.byteLength
      && operation.replacement instanceof Uint8Array
      && operation.replacement.length === operation.byteLength
      && isRecord(operation.metadata)
      && (operation.alignment === undefined
        || (Number.isSafeInteger(operation.alignment) && operation.alignment > 0))
      && (operation.dependencies === undefined
        || (Array.isArray(operation.dependencies)
          && operation.dependencies.every((dependency) => typeof dependency === "string")))
      && (operation.allowOverlap === undefined || typeof operation.allowOverlap === "boolean"),
  );
}

export function isPatchResult(result) {
  return Boolean(
    isRecord(result)
      && hasOnlyCanonicalKeys(result)
      && RESULT_STATUS_VALUES.has(result.statusCode)
      && Array.isArray(result.operations)
      && result.operations.every(isPatchOperation)
      && Array.isArray(result.warnings)
      && result.warnings.every((warning) => typeof warning === "string")
      && isSha256Hex(result.inputSha256)
      && isSha256Hex(result.outputSha256)
      && isRecord(result.patchPlan)
      && result.patchPlan.schemaVersion === 1
      && Number.isSafeInteger(result.patchPlan.finalLength)
      && result.patchPlan.finalLength >= 0
      && isRecord(result.patchPlan.metadata),
  );
}
