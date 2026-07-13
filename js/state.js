// SPDX-License-Identifier: GPL-3.0-or-later

import { cloneDefaultOptions } from "./domain/constants.js";

const initialOptions = /** @type {any} */ (cloneDefaultOptions());

const STATE_ACTION = Object.freeze({
  SET_IMPORTING: "setImporting",
  SET_PATCHING: "setPatching",
  REPLACE_OPTIONS: "replaceOptions",
  ADD_SAVE: "addSave",
  APPEND_ROMS: "appendRoms",
  UPDATE_ROM: "updateRom",
  REMOVE_ROM: "removeRom",
  REMOVE_SAVE: "removeSave",
  CLEAR_FILES: "clearFiles",
  SET_ZIP_URL: "setZipUrl",
});

export const state = {
  roms: [],
  saveFilesByBaseName: new Map(),
  saveConflictsByBaseName: new Map(),
  isPatching: false,
  isImporting: false,
  lastZipUrl: null,
  options: initialOptions,
};

function reduceState(current, action) {
  switch (action.type) {
    case STATE_ACTION.SET_IMPORTING:
      return { ...current, isImporting: action.value === true };
    case STATE_ACTION.SET_PATCHING:
      return { ...current, isPatching: action.value === true };
    case STATE_ACTION.REPLACE_OPTIONS:
      return { ...current, options: structuredClone(action.options) };
    case STATE_ACTION.ADD_SAVE: {
      const saves = new Map(current.saveFilesByBaseName);
      const conflicts = new Map(
        [...current.saveConflictsByBaseName].map(([key, values]) => [key, [...values]]),
      );
      if (saves.has(action.baseName)) {
        conflicts.set(action.baseName, [saves.get(action.baseName), action.record]);
        saves.delete(action.baseName);
      } else if (conflicts.has(action.baseName)) {
        conflicts.get(action.baseName).push(action.record);
      } else {
        saves.set(action.baseName, action.record);
      }
      return { ...current, saveFilesByBaseName: saves, saveConflictsByBaseName: conflicts };
    }
    case STATE_ACTION.APPEND_ROMS: {
      const removableStatuses = action.removeStatuses || new Set();
      const existing = action.roms.length
        ? current.roms.filter((rom) => !removableStatuses.has(rom.statusCode))
        : current.roms;
      return { ...current, roms: [...existing, ...action.roms] };
    }
    case STATE_ACTION.UPDATE_ROM:
      return {
        ...current,
        roms: current.roms.map((rom) => (
          rom.id === action.id ? { ...rom, ...action.changes } : rom
        )),
      };
    case STATE_ACTION.REMOVE_ROM:
      return { ...current, roms: current.roms.filter((rom) => rom.id !== action.id) };
    case STATE_ACTION.REMOVE_SAVE: {
      const saves = new Map(current.saveFilesByBaseName);
      const conflicts = new Map(current.saveConflictsByBaseName);
      saves.delete(action.baseName);
      conflicts.delete(action.baseName);
      return { ...current, saveFilesByBaseName: saves, saveConflictsByBaseName: conflicts };
    }
    case STATE_ACTION.CLEAR_FILES:
      return {
        ...current,
        roms: [],
        saveFilesByBaseName: new Map(),
        saveConflictsByBaseName: new Map(),
      };
    case STATE_ACTION.SET_ZIP_URL:
      return { ...current, lastZipUrl: action.url || null };
    default:
      throw new TypeError(`Unknown state action: ${String(action.type)}.`);
  }
}

function applyStateAction(target, action) {
  Object.assign(target, reduceState(target, action));
  return target;
}

export function setImporting(target, value) {
  return applyStateAction(target, { type: STATE_ACTION.SET_IMPORTING, value });
}

export function setPatching(target, value) {
  return applyStateAction(target, { type: STATE_ACTION.SET_PATCHING, value });
}

export function replaceOptions(target, options) {
  return applyStateAction(target, { type: STATE_ACTION.REPLACE_OPTIONS, options });
}

export function addSave(target, baseName, record) {
  return applyStateAction(target, { type: STATE_ACTION.ADD_SAVE, baseName, record });
}

export function appendRoms(target, roms, removeStatuses = new Set()) {
  return applyStateAction(target, {
    type: STATE_ACTION.APPEND_ROMS,
    roms,
    removeStatuses,
  });
}

export function updateRom(target, id, changes) {
  return applyStateAction(target, { type: STATE_ACTION.UPDATE_ROM, id, changes });
}

export function removeRom(target, id) {
  return applyStateAction(target, { type: STATE_ACTION.REMOVE_ROM, id });
}

export function removeSave(target, baseName) {
  return applyStateAction(target, { type: STATE_ACTION.REMOVE_SAVE, baseName });
}

export function clearFiles(target) {
  return applyStateAction(target, { type: STATE_ACTION.CLEAR_FILES });
}

export function replaceZipUrl(url) {
  clearZipUrl();
  applyStateAction(state, { type: STATE_ACTION.SET_ZIP_URL, url });
}

export function clearZipUrl() {
  if (state.lastZipUrl) URL.revokeObjectURL(state.lastZipUrl);
  applyStateAction(state, { type: STATE_ACTION.SET_ZIP_URL, url: null });
}
