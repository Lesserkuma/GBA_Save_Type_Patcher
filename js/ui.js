// SPDX-License-Identifier: GPL-3.0-or-later

import { DEFAULT_OPTIONS, PATCH_MODES, PATCH_STATUS, RTC_TICK_MODES } from "./domain/constants.js";
import { statusMessage, UI_TEXT, uiMessage } from "./domain/messages.js";
import { PatchError } from "./core/errors.js";
import { saveFileMatchesRom } from "./files.js";
import { replaceOptions, setPatching } from "./state.js";

const elements = {};
let importProgressHideTimer = null;
const DEFAULT_BATTERYLESS_HOTKEY = [...DEFAULT_OPTIONS.batteryless.hotkey];
const BATTERYLESS_HOTKEY_BITS = {
  a: 0x0001,
  b: 0x0002,
  select: 0x0004,
  start: 0x0008,
  right: 0x0010,
  left: 0x0020,
  up: 0x0040,
  down: 0x0080,
  r: 0x0100,
  l: 0x0200,
};

export function bindElements() {
  const requireElement = (selector) => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`Required DOM element ${selector} is missing.`);
    return element;
  };
  Object.assign(elements, {
    dropZone: requireElement("#drop-zone"),
    fileInput: requireElement("#file-input"),
    importProgress: requireElement("#import-progress"),
    importProgressBar: requireElement("#import-progress-bar"),
    importProgressText: requireElement("#import-progress-text"),
    importProgressCount: requireElement("#import-progress-count"),
    romList: requireElement("#rom-list"),
    emptyState: requireElement("#empty-state"),
    saveSummary: requireElement("#save-summary"),
    optionsForm: requireElement("#patch-options"),
    optionsPanel: requireElement("#save-options-panel"),
    otherPatchesPanel: requireElement("#other-patches-panel"),
    batterylessOptions: requireElement("#batteryless-options"),
    flash512kOptions: requireElement("#flash512k-options"),
    sharedHotkeyOptions: requireElement("#shared-hotkey-options"),
    countdownField: requireElement("#countdown-field"),
    batterylessCountdownIndicator: requireElement("#batteryless-countdown-indicator"),
    batterylessAutoFlushCopy: requireElement("#batteryless-auto-flush-copy"),
    sramOptions: requireElement("#sram-options"),
    customFlashOptions: requireElement("#custom-flash-options"),
    rtcOptions: requireElement("#rtc-options"),
    patchButton: requireElement("#patch-button"),
    clearButton: requireElement("#clear-button"),
    statusRegion: requireElement("#status-region"),
  });
  return elements;
}

export function getElements() {
  return elements;
}

export function setStatus(message, tone = "neutral", focus = false) {
  elements.statusRegion.textContent = message;
  elements.statusRegion.dataset.tone = tone;
  if (focus) elements.statusRegion.focus();
}

function setImportProgressHidden(hidden) {
  if (!elements.importProgress) return;
  elements.importProgress.hidden = hidden;
  elements.importProgress.setAttribute("aria-hidden", hidden ? "true" : "false");
  elements.dropZone.dataset.importing = hidden ? "false" : "true";
  if (hidden) {
    elements.dropZone.removeAttribute("aria-busy");
    elements.fileInput.disabled = false;
  } else {
    elements.dropZone.setAttribute("aria-busy", "true");
    elements.fileInput.disabled = true;
  }
}

/** @param {{current?: number, total?: number, fileName?: string}} [progress] */
export function setImportProgress(progress = {}) {
  const { current, total, fileName } = progress;
  if (!elements.importProgress || !Number.isFinite(total) || total <= 0) return;
  if (importProgressHideTimer) {
    window.clearTimeout(importProgressHideTimer);
    importProgressHideTimer = null;
  }

  const safeCurrent = Math.max(0, Math.min(total, Number.isFinite(current) ? current : 0));
  setImportProgressHidden(false);
  elements.importProgressBar.max = total;
  elements.importProgressBar.value = safeCurrent;
  elements.importProgressText.textContent = uiMessage.addingFile(fileName);
  elements.importProgressCount.textContent = uiMessage.progressCount(safeCurrent, total);
}

export function hideImportProgress(delayMs = 0) {
  if (importProgressHideTimer) window.clearTimeout(importProgressHideTimer);
  const hide = () => {
    importProgressHideTimer = null;
    setImportProgressHidden(true);
    if (elements.importProgressBar) elements.importProgressBar.value = 0;
    if (elements.importProgressCount) elements.importProgressCount.textContent = "0 / 0";
    if (elements.importProgressText) elements.importProgressText.textContent = UI_TEXT.ADDING_FILES;
  };
  if (delayMs > 0) importProgressHideTimer = window.setTimeout(hide, delayMs);
  else hide();
}

export function renderOptions(state) {
  const isSram = state.options.patchMode === "sram";
  const isBatteryless = state.options.patchMode === "batteryless-sram";
  const isFlash512k = state.options.patchMode === "flash512k";
  const isCustomFlash = state.options.patchMode === "custom-flash";
  const isRtc = state.options.rtc.enabled;
  elements.batterylessOptions.hidden = !isBatteryless;
  if (elements.flash512kOptions) elements.flash512kOptions.hidden = !(isFlash512k || isCustomFlash);
  if (elements.sharedHotkeyOptions) elements.sharedHotkeyOptions.hidden = !(isBatteryless || isRtc);
  if (elements.rtcOptions) elements.rtcOptions.hidden = !isRtc;
  if (elements.sramOptions) elements.sramOptions.hidden = !(isSram || isBatteryless);
  elements.customFlashOptions.hidden = state.options.patchMode !== "custom-flash";
  const isAutoModeEnabled = state.options.batteryless.mode === "auto";
  const isBatterylessAutoMode = isBatteryless && isAutoModeEnabled;
  if (elements.batterylessCountdownIndicator) {
    elements.batterylessCountdownIndicator.disabled = !isAutoModeEnabled;
    elements.batterylessCountdownIndicator.closest("label")?.classList.toggle("is-disabled", !isAutoModeEnabled);
  }
  for (const hotkey of formControlsToArray(elements.optionsForm.elements.batterylessHotkey)) {
    hotkey.closest("label")?.classList.toggle("is-checked", hotkey.checked);
  }
  elements.countdownField.hidden = !isBatterylessAutoMode;
  if (elements.batterylessAutoFlushCopy) elements.batterylessAutoFlushCopy.hidden = !isBatterylessAutoMode;
  elements.optionsPanel.classList.toggle("no-extra-options", state.options.patchMode === "none");
  elements.otherPatchesPanel.classList.toggle("no-extra-options", !isRtc);
}

function createRomCard() {
  const item = document.createElement("li");
  item.className = "rom-card";

  const fileColumn = document.createElement("div");
  fileColumn.className = "rom-file-column";
  const nameWrap = document.createElement("div");
  nameWrap.className = "rom-title";
  const icon = document.createElement("span");
  icon.className = "rom-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "\u{1F3AE}";
  const name = document.createElement("span");
  name.className = "rom-name";
  name.dataset.role = "name";
  const saveBadge = document.createElement("button");
  saveBadge.type = "button";
  saveBadge.className = "save-badge";
  saveBadge.textContent = UI_TEXT.SAVE_BADGE;
  saveBadge.hidden = true;
  saveBadge.title = UI_TEXT.REMOVE_MATCHING_SAVE;
  saveBadge.dataset.role = "save";
  nameWrap.append(icon, name, saveBadge);
  const errorMessage = document.createElement("div");
  errorMessage.className = "rom-error-message";
  errorMessage.dataset.role = "error";
  fileColumn.append(nameWrap, errorMessage);

  const libraryBadge = document.createElement("span");
  libraryBadge.className = "library-badge";
  libraryBadge.dataset.role = "library";
  const saveTypeBadge = document.createElement("span");
  saveTypeBadge.className = "save-type-badge";
  saveTypeBadge.dataset.role = "saveType";
  const status = document.createElement("span");
  status.className = "rom-status";
  status.dataset.role = "status";
  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "ghost-button small";
  removeButton.dataset.role = "remove";
  removeButton.textContent = UI_TEXT.REMOVE;

  item.append(fileColumn, libraryBadge, saveTypeBadge, status, removeButton);
  return item;
}

function updateRomCard(item, rom, state, isAdded) {
  item.dataset.id = rom.id;
  item.classList.toggle("is-added", isAdded);
  delete item.dataset.state;
  if (rom.error || rom.statusCode === PATCH_STATUS.FAILED) item.dataset.state = "error";
  else if (rom.warning) item.dataset.state = "warning";
  else if (rom.statusCode === PATCH_STATUS.CHANGED) {
    item.dataset.state = "success";
  }

  item.querySelector('[data-role="name"]').textContent = rom.name;
  const saveBadge = item.querySelector('[data-role="save"]');
  const saveRecord = state.saveFilesByBaseName.get(rom.baseName);
  const hasSave = state.options.patchMode === PATCH_MODES.BATTERYLESS_SRAM
    && !state.saveConflictsByBaseName.has(rom.baseName)
    && saveFileMatchesRom(saveRecord, rom);
  saveBadge.hidden = !hasSave;
  if (hasSave) saveBadge.dataset.saveBase = rom.baseName;
  else delete saveBadge.dataset.saveBase;

  const errorMessage = item.querySelector('[data-role="error"]');
  errorMessage.hidden = !rom.error;
  errorMessage.textContent = rom.error || "";

  const libraryBadge = item.querySelector('[data-role="library"]');
  libraryBadge.textContent = rom.saveType || UI_TEXT.UNKNOWN_LIBRARY;
  libraryBadge.hidden = !rom.saveType;

  const saveTypeBadge = item.querySelector('[data-role="saveType"]');
  saveTypeBadge.textContent = rom.saveTypeLabel || UI_TEXT.UNKNOWN_SAVE_TYPE;
  saveTypeBadge.hidden = !rom.isHeaderValid;

  const status = item.querySelector('[data-role="status"]');
  const displayStatus = rom.error ? statusMessage(PATCH_STATUS.FAILED) : statusMessage(rom.statusCode);
  status.textContent = rom.warning ? uiMessage.statusWithWarning(displayStatus) : displayStatus;
  status.title = rom.error || rom.warning || displayStatus;
  if (rom.error) status.setAttribute("aria-label", uiMessage.ariaError(rom.error));
  else if (rom.warning) status.setAttribute("aria-label", uiMessage.ariaWarning(rom.warning));
  else status.removeAttribute("aria-label");

  const removeButton = item.querySelector('[data-role="remove"]');
  removeButton.dataset.removeRom = rom.id;
  removeButton.disabled = state.isPatching;
}

export function renderRomList(state, options = {}) {
  elements.emptyState.hidden = state.roms.length > 0;
  elements.clearButton.disabled = state.isPatching || state.isImporting || state.roms.length === 0;
  elements.patchButton.disabled = state.isPatching || state.isImporting || state.roms.length === 0;
  elements.romList.setAttribute("aria-busy", state.isPatching || state.isImporting ? "true" : "false");

  const summaryParts = [];
  if (state.saveFilesByBaseName.size) summaryParts.push(uiMessage.matchingSaves(state.saveFilesByBaseName.size));
  if (state.saveConflictsByBaseName.size) {
    summaryParts.push(uiMessage.saveConflictsSummary(state.saveConflictsByBaseName.size));
  }
  elements.saveSummary.hidden = summaryParts.length === 0;
  elements.saveSummary.textContent = summaryParts.join(". ");

  const existing = new Map(
    [...elements.romList.querySelectorAll(".rom-card")].map((item) => [item.dataset.id, item]),
  );
  const activeIds = new Set(state.roms.map((rom) => rom.id));
  for (const [id, item] of existing) {
    if (!activeIds.has(id)) item.remove();
  }
  for (const rom of state.roms) {
    const item = existing.get(rom.id) || createRomCard();
    updateRomCard(item, rom, state, options.addedIds?.has(rom.id) ?? false);
    elements.romList.append(item);
  }
}

function formControlsToArray(controls) {
  if (!controls) return [];
  if (typeof controls.length === "number") return Array.from(controls);
  return [controls];
}

function checkedValues(controls) {
  return formControlsToArray(controls)
    .filter((control) => control.checked)
    .map((control) => control.value);
}

function normalizeHotkeyKeys(keys) {
  const normalized = [];
  const seen = new Set();
  for (const key of Array.isArray(keys) ? keys : []) {
    const value = String(key).toLowerCase();
    if (!(value in BATTERYLESS_HOTKEY_BITS) || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function hotkeyMaskFromKeys(keys) {
  return normalizeHotkeyKeys(keys).reduce((mask, key) => mask | BATTERYLESS_HOTKEY_BITS[key], 0);
}

export function syncOptionsFromForm(state) {
  const f = elements.optionsForm;
  const delayInput = f.elements.countdownFrames;
  const parsedDelay = Number.parseInt(delayInput.value, 10);
  if (Number.isFinite(parsedDelay)) {
    const clampedDelay = Math.max(0, Math.min(255, parsedDelay));
    if (String(parsedDelay) === delayInput.value.trim() && clampedDelay !== parsedDelay) delayInput.value = String(clampedDelay);
  }

  const options = structuredClone(state.options);
  options.patchMode = f.elements.patchMode.value;
  options.batteryless.mode = f.elements.batterylessMode.value;
  const sharedHotkey = checkedValues(f.elements.batterylessHotkey);
  options.batteryless.hotkey = sharedHotkey;
  options.batteryless.countdownFrames = Number.parseInt(delayInput.value, 10);
  options.batteryless.indicator = f.elements.indicator.value;
  if (options.batteryless.mode !== "auto" && options.batteryless.indicator === "countdown") {
    options.batteryless.indicator = "save";
    f.elements.indicator.value = "save";
  }
  options.batteryless.lastBlock = f.elements.batterylessLastBlock?.value || "usable";
  options.flash512k ||= {};
  options.flash512k.countdownFrames = Number.parseInt(f.elements.flash512kCountdownFrames.value, 10);
  options.flash512k.indicator = f.elements.flash512kIndicator.value;
  options.customFlash.saveChipModel = f.elements.saveChipModel.value;
  options.sram.flash1mBankSwitchStyle = f.elements.flash1mBankSwitchStyle?.value || "modern";
  options.waitstate.enabled = f.elements.waitstateEnabled.checked;
  options.waitstate.mode = "supercard_exact";
  options.rtc.enabled = f.elements.rtcEnabled.checked;
  options.rtc.tickMode = f.elements.rtcTickMode.value;
  options.rtc.saveOnGlobalHotkey = f.elements.rtcSaveOnGlobalHotkey.value !== "disabled";
  replaceOptions(state, options);
}

export function readValidatedOptions(state) {
  const options = structuredClone(state.options);
  const supportedPatchModes = new Set(Object.values(PATCH_MODES));
  const optionError = (message, field) => new PatchError(message, {
    code: "OPTIONS_INVALID",
    stage: "optionValidation",
    context: { field },
    isRecoverable: true,
  });
  if (!supportedPatchModes.has(options.patchMode)) {
    throw optionError(uiMessage.unsupportedPatchMode(options.patchMode), "patchMode");
  }

  if (options.patchMode === "batteryless-sram" && options.batteryless.mode === "auto") {
    if (!Number.isInteger(options.batteryless.countdownFrames) || options.batteryless.countdownFrames < 0 || options.batteryless.countdownFrames > 255) {
      throw optionError(UI_TEXT.BATTERYLESS_DELAY_INVALID, "batteryless.countdownFrames");
    }
  } else {
    options.batteryless.countdownFrames = DEFAULT_OPTIONS.batteryless.countdownFrames;
  }
  if (options.batteryless.mode !== "auto" && options.batteryless.indicator === "countdown") options.batteryless.indicator = "save";

  options.flash512k ||= structuredClone(DEFAULT_OPTIONS.flash512k);
  if (["flash512k", "custom-flash"].includes(options.patchMode)) {
    if (!Number.isInteger(options.flash512k.countdownFrames) || options.flash512k.countdownFrames < 1 || options.flash512k.countdownFrames > 255) {
      throw optionError(UI_TEXT.JOURNAL_DELAY_INVALID, "flash512k.countdownFrames");
    }
    if (!["save", "countdown", "off"].includes(options.flash512k.indicator)) {
      throw optionError(UI_TEXT.JOURNAL_INDICATOR_INVALID, "flash512k.indicator");
    }
  } else {
    options.flash512k.countdownFrames = DEFAULT_OPTIONS.flash512k.countdownFrames;
  }

  options.customFlash = options.customFlash || {};
  if (options.patchMode === "custom-flash") {
    const chipTypeByModel = { sst25vf064cFamily: 1, sst39vf6401b: 2 };
    const chipType = chipTypeByModel[options.customFlash.saveChipModel];
    if (!chipType) throw optionError(UI_TEXT.CUSTOM_FLASH_MODEL_INVALID, "customFlash.saveChipModel");
    options.customFlash.saveChipType = chipType;
  }

  options.sram = options.sram || {};
  options.sram.flash1mBankSwitchStyle = options.sram.flash1mBankSwitchStyle === "gbata" ? "gbata" : "modern";

  options.batteryless.lastBlock = options.batteryless.lastBlock === "keep-empty" ? "keep-empty" : "usable";
  options.batteryless.hotkey = normalizeHotkeyKeys(options.batteryless.hotkey);
  const needsHotkey = options.patchMode === "batteryless-sram" || options.rtc?.enabled;
  if (!options.batteryless.hotkey.length) {
    if (needsHotkey) throw optionError(UI_TEXT.HOTKEY_REQUIRED, "batteryless.hotkey");
    options.batteryless.hotkey = DEFAULT_BATTERYLESS_HOTKEY;
  }
  options.batteryless.hotkeyMask = hotkeyMaskFromKeys(options.batteryless.hotkey);

  options.waitstate = options.waitstate.enabled
    ? { enabled: true, mode: "supercard_exact" }
    : { enabled: false, mode: "supercard_exact" };

  const rtcEnabled = options.rtc?.enabled === true;
  const rtcTickMode = options.rtc?.tickMode ?? DEFAULT_OPTIONS.rtc.tickMode;
  const rtcSaveOnGlobalHotkey = options.rtc?.saveOnGlobalHotkey !== false;
  if (!Object.values(RTC_TICK_MODES).includes(rtcTickMode)) {
    throw optionError(UI_TEXT.RTC_TICK_MODE_INVALID, "rtc.tickMode");
  }
  options.rtc = {
    enabled: rtcEnabled,
    tickMode: rtcTickMode,
    saveOnGlobalHotkey: rtcSaveOnGlobalHotkey,
  };

  if (options.patchMode === "none" && !options.waitstate.enabled && !options.rtc.enabled) {
    throw optionError(UI_TEXT.PATCH_SELECTION_REQUIRED, "patchMode");
  }

  return options;
}

export function markPatching(state, isPatching) {
  setPatching(state, isPatching);
  renderRomList(state);
  elements.patchButton.textContent = isPatching ? UI_TEXT.PATCHING : UI_TEXT.PATCH_ROMS;
}
