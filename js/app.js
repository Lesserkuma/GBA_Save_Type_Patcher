import { addFilesToState, clearRoms, isRomPatchable, removeRom } from "./files.js";
import { state, clearZipUrl } from "./state.js";
import { makeOutputName } from "./core/rom.js";
import { createZipBlob } from "./zip-writer.js";
import { patchRomInWorker } from "./worker-client.js";
import { bindElements, getElements, hideImportProgress, markPatching, readValidatedOptions, renderOptions, renderRomList, setImportProgress, setStatus, syncOptionsFromForm } from "./ui.js";
function triggerDownload(blob, fileName) {
  clearZipUrl();
  state.lastZipUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = state.lastZipUrl;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
}
async function handleFiles(files) {
  const fileList = [...files];
  if (!fileList.length || state.isImporting) return;

  state.isImporting = true;
  renderRomList(state);
  setStatus("Adding files...", "neutral");

  let result = null;
  let importError = null;
  try {
    result = await addFilesToState(fileList, state, { onProgress: setImportProgress });
  } catch (error) {
    importError = error;
  } finally {
    state.isImporting = false;
  }

  if (importError) {
    hideImportProgress();
    renderRomList(state);
    setStatus(importError.message || String(importError), "error");
    return;
  }

  renderRomList(state, { addedIds: new Set(result.addedRomIds) });
  setImportProgress({ current: fileList.length, total: fileList.length });
  hideImportProgress(600);
  if (result.ignored.length) setStatus(`Ignored unsupported files: ${result.ignored.join(", ")}`, "warning");
  else if (result.addedRoms) setStatus(`${result.addedRoms} ROM file(s) added.`, "success");
  else setStatus("Save file(s) cached for Batteryless SRAM mode.", "success");
}
function updateOptionsFromUi() { const wasBatteryless = state.options.patchMode === "batteryless-sram"; syncOptionsFromForm(state); renderOptions(state); const isBatteryless = state.options.patchMode === "batteryless-sram"; if (wasBatteryless !== isBatteryless) renderRomList(state); }
function resultWarningText(result) {
  return [...new Set((result?.warnings || []).filter((warning) => typeof warning === "string" && warning.trim()))].join("\n");
}
function patchResultStatus(result, changed, hasWarnings) {
  const alreadyCompatible = result.status === "already_compatible";
  const alreadyPatched = result.status?.startsWith("already")
    || result.waitstate?.status === "already_patched"
    || result.batteryless?.status === "already_patched"
    || result.rtc?.status === "already_patched";
  let status;
  if (changed) status = result.save_embedded ? "Patched + save embedded" : "Patched";
  else if (alreadyCompatible) status = "Already compatible";
  else if (alreadyPatched) status = "Already patched";
  else status = hasWarnings ? "Skipped" : "No changes";
  return hasWarnings ? `${status} + warning` : status;
}
async function patchAllRoms() {
  if (state.isPatching) return;
  const patchableRoms = state.roms.filter(isRomPatchable);
  if (!patchableRoms.length) {
    if (state.roms.some((rom) => rom.validHeader && rom.alreadyPatched)) {
      setStatus("All valid ROMs are already patched.", "success");
    } else {
      setStatus("Add at least one valid ROM first.", "error");
    }
    return;
  }

  let options;
  try {
    options = readValidatedOptions(state);
  } catch (error) {
    setStatus(error.message, "error");
    return;
  }

  markPatching(state, true);
  setStatus("Patching ROMs…", "neutral");
  const zipEntries = [];
  for (const rom of state.roms) {
    if (!rom.validHeader) {
      rom.error = rom.error || "Invalid GBA header.";
      renderRomList(state);
      continue;
    }
    if (!isRomPatchable(rom)) {
      rom.status = "Already patched";
      rom.error = null;
      rom.warning = null;
      renderRomList(state);
      continue;
    }
    try {
      rom.status = "Patching";
      rom.error = null;
      rom.warning = null;
      renderRomList(state);
      const romBuffer = await rom.file.arrayBuffer();
      let saveBuffer = null;
      if (options.patchMode === "batteryless-sram" && state.saveFilesByBaseName.has(rom.baseName)) {
        saveBuffer = await state.saveFilesByBaseName.get(rom.baseName).file.arrayBuffer();
      }
      const response = await patchRomInWorker({ id: rom.id, romBuffer, saveBuffer, outputName: makeOutputName(rom.name), options });
      rom.result = response.result;
      rom.warning = resultWarningText(response.result) || null;
      const changed = (response.result.operations?.length || 0) > 0;
      rom.status = patchResultStatus(response.result, changed, Boolean(rom.warning));
      if (changed) zipEntries.push({ name: response.outputName, bytes: new Uint8Array(response.patchedBuffer) });
    } catch (error) {
      rom.error = error.message || String(error);
      rom.warning = null;
      rom.status = "Error";
    }
    renderRomList(state);
  }

  markPatching(state, false);
  const hasErrors = state.roms.some((rom) => rom.status === "Error");
  const hasWarnings = state.roms.some((rom) => Boolean(rom.warning));
  if (!zipEntries.length) {
    if (hasErrors) setStatus("No ROMs could be patched. Check the errors in the ROM list.", "error");
    else if (hasWarnings) setStatus("No ROM output was produced. Optional patches were skipped; check the warnings in the ROM list.", "warning");
    else setStatus("No changes were necessary; the selected patch(es) were already present or the ROMs are already compatible.", "success");
    return;
  }
  if (zipEntries.length === 1) {
    triggerDownload(new Blob([zipEntries[0].bytes], { type: "application/octet-stream" }), zipEntries[0].name);
    setStatus(
      hasErrors || hasWarnings ? "Patched ROM downloaded with warnings. Check the ROM list." : "Patched ROM downloaded.",
      hasErrors || hasWarnings ? "warning" : "success",
    );
    return;
  }
  triggerDownload(createZipBlob(zipEntries), "GBA-ROM-Save-Patcher-output.zip");
  setStatus(
    hasErrors || hasWarnings
      ? `${zipEntries.length} patched ROM(s) added to the ZIP with warnings. Check the ROM list.`
      : `${zipEntries.length} patched ROM(s) added to GBA-ROM-Save-Patcher-output.zip.`,
    hasErrors || hasWarnings ? "warning" : "success",
  );
}
function setupDropZone() { const { dropZone, fileInput } = getElements(); dropZone.addEventListener("click", () => fileInput.click()); dropZone.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); fileInput.click(); } }); fileInput.addEventListener("change", async () => { await handleFiles(fileInput.files); fileInput.value = ""; }); for (const name of ["dragenter", "dragover"]) dropZone.addEventListener(name, (event) => { event.preventDefault(); dropZone.dataset.drag = "true"; }); for (const name of ["dragleave", "drop"]) dropZone.addEventListener(name, (event) => { event.preventDefault(); dropZone.dataset.drag = "false"; }); dropZone.addEventListener("drop", async (event) => { await handleFiles(event.dataTransfer.files); }); }
function setupListActions() {
  getElements().romList.addEventListener("click", (event) => {
    const removeButton = event.target.closest("[data-remove-rom]");
    if (removeButton) {
      const card = removeButton.closest(".rom-card");
      const romId = removeButton.dataset.removeRom;
      if (!card || state.isPatching) return;
      card.classList.add("is-removing");
      let removed = false;
      const finishRemoval = () => {
        if (removed) return;
        removed = true;
        removeRom(state, romId);
        renderRomList(state);
        setStatus("ROM removed.", "neutral");
      };
      card.addEventListener("animationend", finishRemoval, { once: true });
      window.setTimeout(finishRemoval, 260);
      return;
    }

    const saveBadge = event.target.closest("[data-save-base]");
    if (saveBadge) {
      state.saveFilesByBaseName.delete(saveBadge.dataset.saveBase);
      renderRomList(state);
      setStatus("Matching save file removed.", "success");
    }
  });
}
function setupControls() { const { optionsForm, patchButton, clearButton } = getElements(); optionsForm.addEventListener("input", updateOptionsFromUi); optionsForm.addEventListener("change", updateOptionsFromUi); patchButton.addEventListener("click", patchAllRoms); clearButton.addEventListener("click", () => { clearRoms(state); state.saveFilesByBaseName.clear(); clearZipUrl(); renderRomList(state); setStatus("List cleared.", "neutral"); }); }
bindElements(); syncOptionsFromForm(state); setupDropZone(); setupListActions(); setupControls(); renderOptions(state); renderRomList(state); setStatus("Drop ROMs and optional .sav files to begin.", "neutral");
