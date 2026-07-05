import { parseRomMetadata, ROM_EXTENSIONS, SAVE_EXTENSION, splitFileName } from "./core/rom.js";
import { findSaveType } from "./patchers/sram.js";

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

export async function addFilesToState(files, state) {
  const ignored = [];
  const additions = [];

  for (const file of files) {
    const { baseName, extension } = splitFileName(file.name);

    if (ROM_EXTENSIONS.has(extension)) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const metadata = parseRomMetadata(bytes.slice(0, 0xc0));
      const saveType = metadata.validHeader ? findSaveType(bytes) : null;
      additions.push({
        id: createId(),
        file,
        name: file.name,
        baseName,
        extension,
        size: file.size,
        title: metadata.title,
        gameCode: metadata.gameCode,
        validHeader: metadata.validHeader,
        saveType,
        status: metadata.validHeader ? "Ready" : "Invalid ROM header",
        error: metadata.validHeader ? null : "Invalid GBA header.",
        result: null,
      });
    } else if (extension === SAVE_EXTENSION) {
      state.saveFilesByBaseName.set(baseName, { file, name: file.name, size: file.size, baseName });
    } else {
      ignored.push(file.name);
    }
  }

  state.roms.push(...additions);
  return { addedRoms: additions.length, addedRomIds: additions.map((rom) => rom.id), ignored };
}

export function removeRom(state, id) {
  state.roms = state.roms.filter((rom) => rom.id !== id);
}

export function clearRoms(state) {
  state.roms = [];
}
