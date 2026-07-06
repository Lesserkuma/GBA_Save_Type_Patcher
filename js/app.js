import { addFilesToState, clearRoms, removeRom } from "./files.js";
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
async function patchAllRoms() { if (state.isPatching) return; let options; try { options = readValidatedOptions(state); } catch (error) { setStatus(error.message, "error"); return; } const validRoms = state.roms.filter((rom) => rom.validHeader); if (!validRoms.length) { setStatus("Add at least one valid ROM first.", "error"); return; } markPatching(state, true); setStatus("Patching ROMs…", "neutral"); const zipEntries = []; for (const rom of state.roms) { if (!rom.validHeader) { rom.error = rom.error || "Invalid GBA header."; renderRomList(state); continue; } try { rom.status = "Patching"; rom.error = null; renderRomList(state); const romBuffer = await rom.file.arrayBuffer(); let saveBuffer = null; if (options.patchMode === "batteryless-sram" && state.saveFilesByBaseName.has(rom.baseName)) saveBuffer = await state.saveFilesByBaseName.get(rom.baseName).file.arrayBuffer(); const response = await patchRomInWorker({ id: rom.id, romBuffer, saveBuffer, outputName: makeOutputName(rom.name), options }); rom.result = response.result; const changed = (response.result.operations?.length || 0) > 0; const alreadyPatched = response.result.status?.startsWith("already") || response.result.waitstate?.status === "already_patched" || response.result.batteryless?.status === "already_patched"; rom.status = !changed && alreadyPatched ? "Already patched" : response.result.save_embedded ? "Patched + save embedded" : "Patched"; if (changed) zipEntries.push({ name: response.outputName, bytes: new Uint8Array(response.patchedBuffer) }); } catch (error) { rom.error = error.message || String(error); rom.status = "Error"; } renderRomList(state); } markPatching(state, false); if (!zipEntries.length) { const hasErrors = state.roms.some((rom) => rom.status === "Error"); setStatus(hasErrors ? "No ROMs could be patched. Check the errors in the ROM list." : "No changes were necessary; the selected patch(es) were already present.", hasErrors ? "error" : "success"); return; } if (zipEntries.length === 1) {
    triggerDownload(new Blob([zipEntries[0].bytes], { type: "application/octet-stream" }), zipEntries[0].name);
    setStatus("Patched ROM downloaded.", "success");
    return;
  }
  triggerDownload(createZipBlob(zipEntries), "GBA-ROM-Save-Patcher-output.zip");
  setStatus(`${zipEntries.length} patched ROM(s) added to GBA-ROM-Save-Patcher-output.zip.`, "success");
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
bindElements(); setupDropZone(); setupListActions(); setupControls(); renderOptions(state); renderRomList(state); setStatus("Drop ROMs and optional .sav files to begin.", "neutral");
