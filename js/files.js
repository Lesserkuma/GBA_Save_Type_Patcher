// SPDX-License-Identifier: GPL-3.0-or-later

import {
  DOCUMENTED_SAVE_SIZES_BYTES,
  GBA_MAX_ROM_SIZE_BYTES,
  MAX_FILE_COUNT,
  MAX_SAVE_FILE_SIZE_BYTES,
  MAX_TOTAL_INPUT_BYTES,
  PATCH_STATUS,
} from "./domain/constants.js";
import { PatchError } from "./core/errors.js";
import { UI_TEXT, uiMessage } from "./domain/messages.js";
import { GBA_HEADER_STATUS, parseRomMetadata, ROM_EXTENSIONS, SAVE_EXTENSION, splitFileName } from "./core/rom.js";
import { detectRomSaveMetadata } from "./patchers/save-type.js";
import { addSave, appendRoms, removeRom as removeStateRom } from "./state.js";

const AUTO_REMOVE_PATCH_STATUSES = new Set([PATCH_STATUS.CHANGED]);

function yieldToBrowser() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

function assertInputLimits(files, state) {
  if (files.length + state.roms.length + state.saveFilesByBaseName.size > MAX_FILE_COUNT) {
    throw new PatchError(uiMessage.fileCountLimit(MAX_FILE_COUNT), {
      code: "FILE_COUNT_LIMIT",
      stage: "fileValidation",
      isRecoverable: true,
    });
  }
  const existingBytes = state.roms.reduce((sum, rom) => sum + rom.size, 0)
    + [...state.saveFilesByBaseName.values()].reduce((sum, save) => sum + save.size, 0);
  const incomingBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (existingBytes + incomingBytes > MAX_TOTAL_INPUT_BYTES) {
    throw new PatchError(UI_TEXT.TOTAL_INPUT_LIMIT, {
      code: "TOTAL_INPUT_SIZE_LIMIT",
      stage: "fileValidation",
      context: { existingBytes, incomingBytes, limitBytes: MAX_TOTAL_INPUT_BYTES },
      isRecoverable: true,
    });
  }
}

function validateFileSize(file, extension) {
  if (ROM_EXTENSIONS.has(extension) && (file.size < 0xc0 || file.size > GBA_MAX_ROM_SIZE_BYTES)) {
    throw new PatchError(uiMessage.romSizeLimit(file.name), {
      code: "ROM_SIZE_LIMIT",
      stage: "fileValidation",
      context: { fileName: file.name, sizeBytes: file.size },
      isRecoverable: true,
    });
  }
  if (extension === SAVE_EXTENSION && file.size > MAX_SAVE_FILE_SIZE_BYTES) {
    throw new PatchError(uiMessage.saveSizeLimit(file.name), {
      code: "SAVE_SIZE_LIMIT",
      stage: "fileValidation",
      context: { fileName: file.name, sizeBytes: file.size },
      isRecoverable: true,
    });
  }
}

function addSaveFile(state, file, baseName) {
  const record = {
    file,
    name: file.name.normalize("NFC"),
    size: file.size,
    baseName,
    sizeWarning: !DOCUMENTED_SAVE_SIZES_BYTES.has(file.size),
  };
  addSave(state, baseName, record);
}

function romWarning(metadata, saveMetadata) {
  const warnings = [];
  if (metadata.headerStatus === GBA_HEADER_STATUS.SUSPICIOUS) {
    warnings.push(uiMessage.suspiciousHeader(metadata.issues));
  }
  if (saveMetadata.confidence === "ambiguous") {
    warnings.push(uiMessage.ambiguousSignatures(saveMetadata.ambiguousCandidates));
  }
  return warnings.join(" ") || null;
}

export async function addFilesToState(inputFiles, state, options = {}) {
  const files = [...inputFiles];
  assertInputLimits(files, state);
  const ignored = [];
  const additions = [];
  const total = files.length;

  for (const [index, file] of files.entries()) {
    options.onProgress?.({ current: index, total, fileName: file.name });
    await yieldToBrowser();
    const { baseName, extension } = splitFileName(file.name);
    if (!ROM_EXTENSIONS.has(extension) && extension !== SAVE_EXTENSION) {
      ignored.push(file.name);
      continue;
    }
    validateFileSize(file, extension);

    if (ROM_EXTENSIONS.has(extension)) {
      const headerBytes = new Uint8Array(await file.slice(0, 0xc0).arrayBuffer());
      const metadata = await parseRomMetadata(headerBytes);
      const romBytes = metadata.isHeaderValid ? new Uint8Array(await file.arrayBuffer()) : null;
      const saveMetadata = romBytes
        ? detectRomSaveMetadata(romBytes)
        : { library: null, medium: "none", size: null, label: "Unknown" };
      additions.push({
        id: createId(),
        file,
        name: file.name.normalize("NFC"),
        baseName,
        extension,
        size: file.size,
        cachedBytes: romBytes,
        title: metadata.title,
        gameCode: metadata.gameCode,
        headerStatus: metadata.headerStatus,
        headerIssues: metadata.issues,
        isHeaderValid: metadata.isHeaderValid,
        saveType: saveMetadata?.library ?? null,
        saveTypeLabel: saveMetadata?.label ?? "Unknown",
        saveSizeBytes: saveMetadata?.size ?? null,
        statusCode: metadata.isHeaderValid ? PATCH_STATUS.READY : PATCH_STATUS.INVALID,
        error: metadata.isHeaderValid ? null : "Invalid GBA header.",
        warning: romWarning(metadata, saveMetadata),
        result: null,
      });
    } else {
      addSaveFile(state, file, baseName);
    }

    options.onProgress?.({ current: index + 1, total, fileName: file.name });
    await yieldToBrowser();
  }

  appendRoms(state, additions, AUTO_REMOVE_PATCH_STATUSES);
  return {
    addedRoms: additions.length,
    addedRomIds: additions.map((rom) => rom.id),
    ignored,
    saveConflicts: [...state.saveConflictsByBaseName.keys()],
  };
}

export function isRomPatchable(rom) {
  return Boolean(rom?.isHeaderValid);
}

export function saveFileMatchesRom(saveRecord, rom) {
  const actualSize = saveRecord?.size ?? saveRecord?.file?.size;
  return Number.isSafeInteger(actualSize)
    && Number.isSafeInteger(rom?.saveSizeBytes)
    && actualSize === rom.saveSizeBytes;
}

export function removeRom(state, id) {
  removeStateRom(state, id);
}
