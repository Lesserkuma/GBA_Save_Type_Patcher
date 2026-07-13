// SPDX-License-Identifier: GPL-3.0-or-later

import {
  addFilesToState,
  isRomPatchable,
  removeRom,
  saveFileMatchesRom,
} from "./files.js";
import {
  clearFiles,
  clearZipUrl,
  removeSave,
  replaceZipUrl,
  setImporting,
  state,
  updateRom,
} from "./state.js";
import { makeOutputName } from "./core/rom.js";
import { PatchError } from "./core/errors.js";
import { PATCH_MODES, PATCH_STATUS } from "./domain/constants.js";
import { UI_TEXT, uiMessage } from "./domain/messages.js";
import { assertRetainedOutputBudget } from "./core/memory-budget.js";
import { createZipBlob } from "./zip-writer.js";
import { patchRomInWorker } from "./worker-client.js";
import {
  bindElements,
  getElements,
  hideImportProgress,
  markPatching,
  readValidatedOptions,
  renderOptions,
  renderRomList,
  setImportProgress,
  setStatus,
  syncOptionsFromForm,
} from "./ui.js";

function triggerDownload(blob, fileName) {
  replaceZipUrl(URL.createObjectURL(blob));
  const link = document.createElement("a");
  link.href = state.lastZipUrl;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  // The URL remains alive until the next download or explicit list clear so
  // browsers have enough time to consume it after the synthetic click.
}

async function handleFiles(fileInput) {
  const files = [...fileInput];
  if (!files.length || state.isImporting) return;
  setImporting(state, true);
  renderRomList(state);
  setStatus(UI_TEXT.ADDING_FILES, "neutral");

  try {
    const result = await addFilesToState(files, state, { onProgress: setImportProgress });
    renderRomList(state, { addedIds: new Set(result.addedRomIds) });
    setImportProgress({ current: files.length, total: files.length });
    hideImportProgress(600);
    if (result.saveConflicts.length) {
      setStatus(uiMessage.conflictingSaves(result.saveConflicts), "warning");
    } else if (result.ignored.length) {
      setStatus(uiMessage.ignoredFiles(result.ignored), "warning");
    } else if (result.addedRoms) {
      setStatus(uiMessage.romsAdded(result.addedRoms), "success");
    } else {
      setStatus(UI_TEXT.SAVE_FILES_CACHED, "success");
    }
  } catch (error) {
    hideImportProgress();
    setStatus(error.message || String(error), "error", true);
  } finally {
    setImporting(state, false);
    renderRomList(state);
  }
}

function updateOptionsFromUi() {
  const wasBatteryless = state.options.patchMode === PATCH_MODES.BATTERYLESS_SRAM;
  syncOptionsFromForm(state);
  renderOptions(state);
  if (wasBatteryless !== (state.options.patchMode === PATCH_MODES.BATTERYLESS_SRAM)) renderRomList(state);
}

function resultWarningText(result) {
  return [...new Set((result?.warnings || []).filter((warning) => typeof warning === "string" && warning.trim()))].join("\n");
}

function patchResultStatusCode(result, changed, hasWarnings) {
  if (changed || result.statusCode === PATCH_STATUS.CHANGED) return PATCH_STATUS.CHANGED;
  return hasWarnings ? PATCH_STATUS.SKIPPED : PATCH_STATUS.UNCHANGED;
}

async function readRomBuffer(rom) {
  if (rom.cachedBytes instanceof Uint8Array) return rom.cachedBytes.slice().buffer;
  return rom.file.arrayBuffer();
}

async function patchOneRom(romEntry, options, zipEntries) {
  let rom = romEntry;
  if (!rom.isHeaderValid) {
    updateRom(state, rom.id, {
      error: rom.error || UI_TEXT.INVALID_GBA_HEADER,
      statusCode: PATCH_STATUS.INVALID,
    });
    return;
  }
  if (!isRomPatchable(rom)) {
    return;
  }

  updateRom(state, rom.id, {
    statusCode: PATCH_STATUS.PATCHING,
    error: null,
    warning: null,
  });
  renderRomList(state);
  const romBuffer = await readRomBuffer(rom);
  updateRom(state, rom.id, { cachedBytes: null });
  rom = { ...rom, cachedBytes: null };
  let saveBuffer = null;
  if (options.patchMode === PATCH_MODES.BATTERYLESS_SRAM) {
    if (state.saveConflictsByBaseName.has(rom.baseName)) {
      throw new PatchError(UI_TEXT.SAVE_BASENAME_CONFLICT, {
        code: "SAVE_BASENAME_CONFLICT",
        stage: "fileValidation",
        context: { baseName: rom.baseName },
        isRecoverable: true,
      });
    }
    const saveRecord = state.saveFilesByBaseName.get(rom.baseName);
    if (saveRecord && !saveFileMatchesRom(saveRecord, rom)) {
      throw new PatchError(
        uiMessage.exactSaveSize(saveRecord.name || saveRecord.file.name, rom.saveSizeBytes),
        {
          code: "SAVE_SIZE_MISMATCH",
          stage: "fileValidation",
          context: {
            fileName: saveRecord.name || saveRecord.file.name,
            expectedBytes: rom.saveSizeBytes,
            actualBytes: saveRecord.size ?? saveRecord.file.size,
          },
          isRecoverable: true,
        },
      );
    }
    if (saveRecord) saveBuffer = await saveRecord.file.arrayBuffer();
  }
  const response = await patchRomInWorker({
    romId: rom.id,
    romBuffer,
    saveBuffer,
    outputFileName: makeOutputName(rom.name),
    options,
  });
  const warning = resultWarningText(response.result) || null;
  const changed = (response.result.operations?.length || 0) > 0;
  updateRom(state, rom.id, {
    result: response.result,
    warning,
    statusCode: patchResultStatusCode(response.result, changed, Boolean(warning)),
  });
  if (changed) {
    const outputBytes = new Uint8Array(response.patchedBuffer);
    const retainedBytes = zipEntries.reduce((total, entry) => total + entry.bytes.byteLength, 0);
    assertRetainedOutputBudget(retainedBytes, outputBytes.byteLength);
    zipEntries.push({ name: response.outputFileName, bytes: outputBytes });
  }
}

async function patchAllRoms() {
  if (state.isPatching) return;
  const patchableRoms = state.roms.filter(isRomPatchable);
  if (!patchableRoms.length) {
    setStatus(UI_TEXT.ADD_FILES_FIRST, "error");
    return;
  }

  let options;
  try {
    options = readValidatedOptions(state);
  } catch (error) {
    setStatus(error.message || String(error), "error", true);
    return;
  }

  const zipEntries = [];
  markPatching(state, true);
  setStatus(UI_TEXT.PATCHING_ROMS, "neutral");
  try {
    for (const rom of state.roms) {
      try {
        await patchOneRom(rom, options, zipEntries);
      } catch (error) {
        updateRom(state, rom.id, {
          error: error.message || String(error),
          warning: null,
          statusCode: PATCH_STATUS.FAILED,
        });
      }
      renderRomList(state);
    }
  } finally {
    markPatching(state, false);
  }

  const hasErrors = state.roms.some((rom) => rom.statusCode === PATCH_STATUS.FAILED);
  const hasWarnings = state.roms.some((rom) => Boolean(rom.warning));
  if (!zipEntries.length) {
    if (hasErrors) setStatus(UI_TEXT.NO_PATCH_OUTPUT_ERROR, "error");
    else if (hasWarnings) setStatus(UI_TEXT.NO_PATCH_OUTPUT_WARNING, "warning");
    else setStatus(UI_TEXT.NO_CHANGES, "success");
    return;
  }
  if (zipEntries.length === 1) {
    triggerDownload(new Blob([zipEntries[0].bytes], { type: "application/octet-stream" }), zipEntries[0].name);
    setStatus(
      hasErrors || hasWarnings ? UI_TEXT.DOWNLOAD_WITH_WARNINGS : UI_TEXT.DOWNLOAD_COMPLETE,
      hasErrors || hasWarnings ? "warning" : "success",
    );
    return;
  }
  triggerDownload(createZipBlob(zipEntries), "GBA-ROM-Save-Patcher-output.zip");
  setStatus(
    uiMessage.zipComplete(zipEntries.length, hasErrors || hasWarnings),
    hasErrors || hasWarnings ? "warning" : "success",
  );
}

function setupDropZone() {
  const { dropZone, fileInput } = getElements();
  dropZone.addEventListener("keydown", (event) => {
    if (!["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    fileInput.click();
  });
  fileInput.addEventListener("change", async () => {
    await handleFiles(fileInput.files);
    fileInput.value = "";
  });
  for (const eventName of ["dragenter", "dragover"]) {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.dataset.drag = "true";
    });
  }
  for (const eventName of ["dragleave", "drop"]) {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.dataset.drag = "false";
    });
  }
  dropZone.addEventListener("drop", (event) => handleFiles(event.dataTransfer.files));
}

function setupListActions() {
  getElements().romList.addEventListener("click", (event) => {
    const removeButton = event.target.closest("[data-remove-rom]");
    if (removeButton) {
      const card = removeButton.closest(".rom-card");
      const nextFocusId = card?.nextElementSibling?.dataset.id || card?.previousElementSibling?.dataset.id;
      const romId = removeButton.dataset.removeRom;
      if (!card || state.isPatching) return;
      removeRom(state, romId);
      renderRomList(state);
      if (nextFocusId) getElements().romList.querySelector(`[data-id="${CSS.escape(nextFocusId)}"] [data-remove-rom]`)?.focus();
      else getElements().dropZone.focus();
      setStatus(UI_TEXT.ROM_REMOVED, "neutral");
      return;
    }

    const saveBadge = event.target.closest("[data-save-base]");
    if (saveBadge) {
      const cardId = saveBadge.closest(".rom-card")?.dataset.id;
      removeSave(state, saveBadge.dataset.saveBase);
      renderRomList(state);
      if (cardId) getElements().romList.querySelector(`[data-id="${CSS.escape(cardId)}"] [data-remove-rom]`)?.focus();
      setStatus(UI_TEXT.SAVE_REMOVED, "success");
    }
  });
}

function setupControls() {
  const { optionsForm, clearButton } = getElements();
  optionsForm.addEventListener("input", updateOptionsFromUi);
  optionsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    patchAllRoms();
  });
  clearButton.addEventListener("click", () => {
    clearFiles(state);
    clearZipUrl();
    renderRomList(state);
    setStatus(UI_TEXT.LIST_CLEARED, "neutral");
    getElements().dropZone.focus();
  });
}

bindElements();
syncOptionsFromForm(state);
setupDropZone();
setupListActions();
setupControls();
renderOptions(state);
renderRomList(state);
setStatus(UI_TEXT.READY_PROMPT, "neutral");
