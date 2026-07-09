import { parseRomMetadata, ROM_EXTENSIONS, SAVE_EXTENSION, splitFileName } from "./core/rom.js";
import { detectRomSaveMetadata } from "./patchers/save-type.js";
import { decodePatchHeaderSaveMetadata, hasPatchHeaderMarker } from "./patchers/patch-state.js";

const AUTO_REMOVE_PATCH_STATUSES = new Set(["Patched", "Patched + warning"]);

function yieldToBrowser() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();

  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

export async function addFilesToState(files, state, options = {}) {
  const ignored = [];
  const additions = [];
  const total = files.length;

  for (const [index, file] of files.entries()) {
    options.onProgress?.({ current: index, total, fileName: file.name });
    await yieldToBrowser();

    const { baseName, extension } = splitFileName(file.name);

    if (ROM_EXTENSIONS.has(extension)) {
      // Reject invalid files after reading only the small GBA header. Valid
      // ROMs are read in full only when save-type detection actually needs it.
      const headerBytes = new Uint8Array(await file.slice(0, 0xc0).arrayBuffer());
      const metadata = parseRomMetadata(headerBytes);
      const alreadyPatched = metadata.validHeader && hasPatchHeaderMarker(headerBytes);
      const romBytes = metadata.validHeader && !alreadyPatched
        ? new Uint8Array(await file.arrayBuffer())
        : null;
      const saveMetadata = alreadyPatched
        ? decodePatchHeaderSaveMetadata(headerBytes)
        : romBytes
          ? detectRomSaveMetadata(romBytes)
          : { library: null, medium: "none", size: null, label: "Unknown" };
      additions.push({
        id: createId(),
        file,
        name: file.name,
        baseName,
        extension,
        size: file.size,
        title: metadata.title,
        gameCode: metadata.gameCode,
        headerValid: metadata.validHeader,
        validHeader: metadata.validHeader,
        alreadyPatched,
        saveType: saveMetadata.library,
        saveTypeLabel: saveMetadata.label,
        saveSize: saveMetadata.size,
        status: alreadyPatched ? "Already patched" : metadata.validHeader ? "Ready" : "Invalid ROM header",
        error: metadata.validHeader ? null : "Invalid GBA header.",
        warning: null,
        result: null,
      });
    } else if (extension === SAVE_EXTENSION) {
      state.saveFilesByBaseName.set(baseName, { file, name: file.name, size: file.size, baseName });
    } else {
      ignored.push(file.name);
    }

    options.onProgress?.({ current: index + 1, total, fileName: file.name });
    await yieldToBrowser();
  }

  if (additions.length) {
    state.roms = state.roms.filter((rom) => !AUTO_REMOVE_PATCH_STATUSES.has(rom.status));
  }
  state.roms.push(...additions);
  return { addedRoms: additions.length, addedRomIds: additions.map((rom) => rom.id), ignored };
}

export function isRomPatchable(rom) {
  return Boolean(rom?.validHeader && !rom.alreadyPatched);
}

export function removeRom(state, id) {
  state.roms = state.roms.filter((rom) => rom.id !== id);
}

export function clearRoms(state) {
  state.roms = [];
}
