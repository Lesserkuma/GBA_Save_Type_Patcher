const elements = {};
let importProgressHideTimer = null;

export function bindElements() {
  Object.assign(elements, {
    dropZone: document.querySelector("#drop-zone"),
    fileInput: document.querySelector("#file-input"),
    importProgress: document.querySelector("#import-progress"),
    importProgressBar: document.querySelector("#import-progress-bar"),
    importProgressText: document.querySelector("#import-progress-text"),
    importProgressCount: document.querySelector("#import-progress-count"),
    romList: document.querySelector("#rom-list"),
    emptyState: document.querySelector("#empty-state"),
    saveSummary: document.querySelector("#save-summary"),
    optionsForm: document.querySelector("#patch-options"),
    optionsPanel: document.querySelector("#save-options-panel"),
    batterylessOptions: document.querySelector("#batteryless-options"),
    countdownField: document.querySelector("#countdown-field"),
    customFlashOptions: document.querySelector("#custom-flash-options"),
    waitstateOptions: document.querySelector("#waitstate-options"),
    patchButton: document.querySelector("#patch-button"),
    clearButton: document.querySelector("#clear-button"),
    statusRegion: document.querySelector("#status-region"),
  });
  return elements;
}

export function getElements() {
  return elements;
}

export function setStatus(message, tone = "neutral") {
  elements.statusRegion.textContent = message;
  elements.statusRegion.dataset.tone = tone;
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

export function setImportProgress({ current, total, fileName } = {}) {
  if (!elements.importProgress || !Number.isFinite(total) || total <= 0) return;
  if (importProgressHideTimer) {
    window.clearTimeout(importProgressHideTimer);
    importProgressHideTimer = null;
  }

  const safeCurrent = Math.max(0, Math.min(total, Number.isFinite(current) ? current : 0));
  setImportProgressHidden(false);
  elements.importProgressBar.max = total;
  elements.importProgressBar.value = safeCurrent;
  elements.importProgressText.textContent = fileName ? `Adding ${fileName}` : "Adding files...";
  elements.importProgressCount.textContent = `${safeCurrent} / ${total}`;
}

export function hideImportProgress(delayMs = 0) {
  if (importProgressHideTimer) window.clearTimeout(importProgressHideTimer);
  const hide = () => {
    importProgressHideTimer = null;
    setImportProgressHidden(true);
    if (elements.importProgressBar) elements.importProgressBar.value = 0;
    if (elements.importProgressCount) elements.importProgressCount.textContent = "0 / 0";
    if (elements.importProgressText) elements.importProgressText.textContent = "Adding files...";
  };
  if (delayMs > 0) importProgressHideTimer = window.setTimeout(hide, delayMs);
  else hide();
}

export function renderOptions(state) {
  const isBatteryless = state.options.patchMode === "batteryless-sram";
  elements.batterylessOptions.hidden = !isBatteryless;
  elements.customFlashOptions.hidden = state.options.patchMode !== "custom-flash";
  if (elements.waitstateOptions) elements.waitstateOptions.hidden = !state.options.waitstate.enabled;
  elements.countdownField.hidden = !isBatteryless || state.options.batteryless.mode !== "auto";
  elements.optionsPanel.classList.toggle("no-extra-options", state.options.patchMode === "sram" || state.options.patchMode === "none");
}

export function renderRomList(state, options = {}) {
  elements.romList.innerHTML = "";
  elements.emptyState.hidden = state.roms.length > 0;
  elements.clearButton.disabled = state.isPatching || state.isImporting || state.roms.length === 0;
  elements.patchButton.disabled = state.isPatching || state.isImporting || state.roms.length === 0;
  if (elements.saveSummary) {
    elements.saveSummary.hidden = true;
    elements.saveSummary.textContent = "";
  }

  for (const rom of state.roms) {
    const item = document.createElement("li");
    item.className = "rom-card";
    if (options.addedIds?.has(rom.id)) item.classList.add("is-added");
    item.dataset.id = rom.id;
    if (rom.error) item.dataset.state = "error";
    else if (["patched", "already"].some((prefix) => rom.status.toLowerCase().startsWith(prefix))) item.dataset.state = "success";

    const fileColumn = document.createElement("div");
    fileColumn.className = "rom-file-column";

    const nameWrap = document.createElement("div");
    nameWrap.className = "rom-title";

    const icon = document.createElement("span");
    icon.className = "rom-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "🎮";

    const name = document.createElement("span");
    name.className = "rom-name";
    name.textContent = rom.name;
    nameWrap.append(icon, name);

    if (state.options.patchMode === "batteryless-sram" && state.saveFilesByBaseName.has(rom.baseName)) {
      const saveBadge = document.createElement("button");
      saveBadge.type = "button";
      saveBadge.className = "save-badge";
      saveBadge.textContent = "+SAVE";
      saveBadge.dataset.saveBase = rom.baseName;
      saveBadge.title = "Remove this matching .sav file";
      nameWrap.append(saveBadge);
    }

    fileColumn.append(nameWrap);
    if (rom.error) {
      const errorMessage = document.createElement("div");
      errorMessage.className = "rom-error-message";
      errorMessage.textContent = rom.error;
      fileColumn.append(errorMessage);
    }

    const libraryBadge = document.createElement("span");
    libraryBadge.className = "library-badge";
    libraryBadge.textContent = rom.saveType || "UNKNOWN";
    libraryBadge.hidden = !rom.saveType;

    const status = document.createElement("span");
    status.className = "rom-status";
    status.textContent = rom.error ? "Error" : rom.status;
    status.title = rom.error || rom.status;
    if (rom.error) status.setAttribute("aria-label", `Error: ${rom.error}`);

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "ghost-button small";
    removeButton.dataset.removeRom = rom.id;
    removeButton.disabled = state.isPatching;
    removeButton.textContent = "Remove";

    item.append(fileColumn, libraryBadge, status, removeButton);
    elements.romList.append(item);
  }
}

export function syncOptionsFromForm(state) {
  const f = elements.optionsForm;
  const delayInput = f.elements.countdownFrames;
  const parsedDelay = Number.parseInt(delayInput.value, 10);
  if (Number.isFinite(parsedDelay)) {
    const clampedDelay = Math.max(0, Math.min(255, parsedDelay));
    if (String(parsedDelay) === delayInput.value.trim() && clampedDelay !== parsedDelay) delayInput.value = String(clampedDelay);
  }

  state.options.patchMode = f.elements.patchMode.value;
  state.options.batteryless.mode = f.elements.batterylessMode.value;
  state.options.batteryless.countdownFrames = Number.parseInt(delayInput.value, 10);
  state.options.batteryless.indicator = f.elements.indicator.value;
  state.options.customFlash.saveChipType = f.elements.saveChipType.value;
  state.options.waitstate.enabled = f.elements.waitstateEnabled.checked;
  state.options.waitstate.mode = "supercard_exact";
}

export function readValidatedOptions(state) {
  const options = structuredClone(state.options);

  if (options.patchMode === "batteryless-sram" && options.batteryless.mode === "auto") {
    if (!Number.isInteger(options.batteryless.countdownFrames) || options.batteryless.countdownFrames < 0 || options.batteryless.countdownFrames > 255) {
      throw new Error("Delay Value must be a number from 0 to 255.");
    }
  } else {
    options.batteryless.countdownFrames = 102;
  }

  options.waitstate = options.waitstate.enabled
    ? { enabled: true, mode: "supercard_exact" }
    : { enabled: false, mode: "supercard_exact" };

  if (options.patchMode === "none" && !options.waitstate.enabled) {
    throw new Error("Select Waitstate or choose a save type patch mode.");
  }

  return options;
}

export function markPatching(state, isPatching) {
  state.isPatching = isPatching;
  renderRomList(state);
  elements.patchButton.textContent = isPatching ? "Patching…" : "Patch ROMs";
}
