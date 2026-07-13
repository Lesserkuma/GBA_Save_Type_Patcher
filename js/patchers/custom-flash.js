// SPDX-License-Identifier: GPL-3.0-only

import { asciiBytes, findBytes, hexToBytes, readAscii, readU32, startsWithBytes, writeU16 } from "../core/binary.js";
import { PatchError } from "../core/errors.js";
import { PATCH_OPERATION_KIND } from "../domain/constants.js";
import { stagePatchOperation } from "../patch-engine/draft.js";
import { findSaveType } from "./sram.js";
import { applyWaitstateToBytes } from "./waitstate.js";
import { applyPatchHeaderMarker, makePatchHeaderFlags, PATCH_SAVE_MEDIUM } from "./patch-state.js";
import * as CUSTOM_JOURNAL_DATA from "./custom-journal-data.js";
import {
  STANDARD_JOURNAL_DESCRIPTOR,
  defineJournalDescriptor,
  patchJournalConvertedSave,
} from "./flash512k.js";

const GBA_ROM_BASE = 0x08000000;
const SAVE_CHIP_TYPES = { 1: "SST25VF064C, SST49LF080A, 0xFFFF", 2: "SST39VF6401B" };
const PTR_ADD = {
  FLASH1M_V103: 0x10,
  FLASH1M_V102: 0x10,
  FLASH512_V133: 0x10,
  FLASH512_V131: 0x10,
  FLASH512_V130: 0x10,
  FLASH_V126: 0x0c,
  FLASH_V125: 0x0c,
  FLASH_V124: 0x0c,
  FLASH_V123: 0x0c,
  FLASH_V121: 0x0c,
  FLASH_V120: 0x0c,
};
const SUPPORTED = Object.keys(PTR_ADD);
const FLASH_1M = new Set(["FLASH1M_V103", "FLASH1M_V102"]);
const OLD_512 = new Set(["FLASH_V121", "FLASH_V120"]);
const CODE = {
  program: hexToBytes(
    "FEB400B5021CF70000001F231A401203E0273F05174310263602E0221203131C5"
    + "532120255322A331B02AA33AA24147055251D70A02515700D1C0C783C70C0463D"
    + "78AC42FBD101310137013E002EEDD101BC8646FEBC00207047",
  ),
  bank: hexToBytes("90221205002802D1002010707047012010707047"),
  erase1m: hexToBytes(
    "7EB400B5011C0009F700000048001F22011C1140E0221205C9021143E022120313"
    + "1C5532120255322A331B02AA33AA24147055251D7080251570147055251D703025"
    + "0D70C0460D78FF2DFBD1011C01221140002901D10130D9E701BC86467EBC0020"
    + "7047",
  ),
  id1m: hexToBytes("09200002C23070475061746368206279204C4B00"),
  erase512: hexToBytes(
    "7EB400B5011C000948001F22011C1140E0221205C9021143E0221203131C553212"
    + "0255322A331B02AA33AA24147055251D7080251570147055251D7030250D70C046"
    + "0D78FF2DFBD1011C01221140002901D10130D9E701BC86467EBC00207047",
  ),
  // FLASH512 identifies directly in the unbanked 64-KiB window. The former
  // prologue wrote bank value 0 to 0x09000000 and is intentionally absent.
  id512: hexToBytes("D4200002BF3070475061746368206279204C4B00"),
};
const AGBCC_BANK = hexToBytes("0006000E054BAA211970054A55211170B0211970E021090508707047");
const GCC_BANK = hexToBytes("AA225521054B1A70054A1170B0221A70E0230006000E1B0518707047");
const GCC_READ = hexToBytes("AA2555261C4B1D701C4D2E70B0251D70E02300011B05000E1870");
const ID_MARKERS = {
  old: hexToBytes("90B593B06F46391D081C"),
  agbcc: hexToBytes("034A101C08E000005555000EAA2A000E"),
  gcc: hexToBytes("11A9881A423811000988013B02321152"),
};
const BL_PLACEHOLDER = hexToBytes("F7000000");

export const CUSTOM_JOURNAL_DESCRIPTOR = defineJournalDescriptor(CUSTOM_JOURNAL_DATA, {
  id: "custom-journal-v2",
  label: "Custom FLASH journal",
});
if (findBytes(CUSTOM_JOURNAL_DESCRIPTOR.payload, STANDARD_JOURNAL_DESCRIPTOR.signature) >= 0
    || findBytes(STANDARD_JOURNAL_DESCRIPTOR.payload, CUSTOM_JOURNAL_DESCRIPTOR.signature) >= 0) {
  throw new Error("Standard and Custom journal signatures must be mutually exclusive.");
}

export function customFlashSaveSize(libraryNames) {
  const names = Array.from(libraryNames || []);
  const has1M = names.some((name) => FLASH_1M.has(name));
  const has512K = names.some((name) => !FLASH_1M.has(name));
  if (has1M && has512K) throw new PatchError("Custom FLASH found conflicting 512K and 1M FLASH libraries.");
  return has1M ? 131072 : 65536;
}

function cloneCode(type) {
  const code = Object.fromEntries(
    Object.entries(CODE).map(([key, value]) => [key, new Uint8Array(value)]),
  );
  if (type === 2) {
    code.erase1m[0x40] = 0x50;
    code.erase512[0x3c] = 0x50;
  }
  return code;
}

function patchThumbBlPlaceholder(body, functionOffset, targetOffset) {
  const placeholderOffset = findBytes(body, BL_PLACEHOLDER);
  if (placeholderOffset < 0) throw new PatchError("Thumb BL placeholder not found");
  const delta = (((functionOffset + placeholderOffset) - targetOffset) >> 1) + 2;
  const encoded = (((0x1000000 - delta) & 0xffffff) | (0xf7 << 24)) >>> 0;
  writeU16(body, placeholderOffset, (encoded >>> 16) & 0xffff);
  writeU16(body, placeholderOffset + 2, encoded & 0xffff);
}

function functionSizeFromTail(out, offset, head, tail) {
  if (offset < 0 || offset + head.length > out.length) return null;
  if (!startsWithBytes(out, offset, head)) return null;
  const tailOffset = findBytes(out, tail, offset);
  return tailOffset < 0 ? null : tailOffset - offset + tail.length;
}
function replaceFunction(out, operations, library, fn, offset, size, code, kind = PATCH_OPERATION_KIND.HOOK_REPLACE) {
  if (code.length > size) throw new PatchError(`${library}: ${fn} does not have enough room for new code`);
  const replacement = new Uint8Array(size);
  replacement.set(code);
  stagePatchOperation(out, operations, {
    id: `custom-flash-${operations.length}`,
    kind,
    component: "customFlash",
    offset,
    byteLength: replacement.length,
    expectedBefore: out.slice(offset, offset + replacement.length),
    replacement,
    labelKey: "operation.customFlash",
    metadata: {
      name: `${library}: ${fn}`,
      library,
      function: fn,
    },
  });
}
function readFunctionPointer(out, library, tableAdd, fn, warnings) {
  const pointerOffset = library.baseOffset + tableAdd;
  if (pointerOffset < 0 || pointerOffset + 4 > out.length) {
    warnings.push(`${library.name}: ${fn} pointer is outside the ROM`);
    return null;
  }
  const functionOffset = readU32(out, pointerOffset) - GBA_ROM_BASE - 1;
  if (functionOffset < 0 || functionOffset >= out.length) {
    warnings.push(`${library.name}: ${fn} address is invalid`);
    return null;
  }
  return functionOffset;
}

function findFlashLibraries(out) {
  const hits = [];
  for (const name of SUPPORTED) {
    const marker = asciiBytes(name);
    let pos = 0;
    while (true) {
      const stringOffset = findBytes(out, marker, pos);
      if (stringOffset < 0) break;
      const pointerOffset = stringOffset + PTR_ADD[name];
      if (pointerOffset + 4 <= out.length) hits.push({ name, stringOffset, baseOffset: readU32(out, pointerOffset) - GBA_ROM_BASE });
      pos = stringOffset + marker.length;
    }
  }
  return hits;
}

function customFlashContext(inputBytes, options) {
  const data = new Uint8Array(inputBytes);
  if (data.length < 0xc0 || data[0xb2] !== 0x96) throw new PatchError("Invalid GBA header.");
  const type = options.saveChipType;
  if (!Number.isInteger(type) || ![1, 2].includes(type)) {
    throw new PatchError("Custom FLASH save chip type must be integer 1 or 2.");
  }
  const out = new Uint8Array(data);
  return {
    data,
    out,
    options,
    type,
    code: cloneCode(type),
    operations: [],
    warnings: [],
    gccUsed: false,
    setBank: null,
    libraries: findFlashLibraries(out),
  };
}

function journalFallback(context) {
  if (context.libraries.length) return null;
  const sourceSaveType = findSaveType(context.data);
  if (sourceSaveType?.startsWith("SRAM") || sourceSaveType?.startsWith("EEPROM")) {
    return patchJournalConvertedSave(context.data, context.options, CUSTOM_JOURNAL_DESCRIPTOR);
  }
  throw new PatchError(
    sourceSaveType
      ? `${sourceSaveType} is not supported by Custom FLASH.`
      : "Custom FLASH could not detect a supported save library.",
  );
}

function patchCustomBankSwitch(context, library) {
  if (!FLASH_1M.has(library.name)) return;
  let offset = findBytes(context.out, AGBCC_BANK);
  if (offset < 0) {
    offset = findBytes(context.out, GCC_BANK);
    context.gccUsed = offset >= 0;
  }
  if (offset < 0) {
    context.warnings.push(`${library.name}: SwitchFlashBank does not match a supported implementation`);
    return;
  }
  context.setBank = offset;
  replaceFunction(
    context.out,
    context.operations,
    library.name,
    "SwitchFlashBank",
    offset,
    0x1c,
    context.code.bank,
    PATCH_OPERATION_KIND.BANK_SWITCH_PATCH,
  );
  if (!context.gccUsed) return;
  const readOffset = findBytes(context.out, GCC_READ);
  if (readOffset < 0) return;
  const body = hexToBytes("00011B05000E01B404B4F700000004BC01BCC046C046C046C046");
  patchThumbBlPlaceholder(body, readOffset, context.setBank);
  replaceFunction(
    context.out,
    context.operations,
    library.name,
    "ReadFlash GCC bank call",
    readOffset,
    0x1a,
    body,
  );
}

function eraseFunctionShape(context, library) {
  if (FLASH_1M.has(library.name)) {
    return {
      head: context.gccUsed ? hexToBytes("F0B54F46") : hexToBytes("F0B590B0"),
      tail: context.gccUsed
        ? hexToBytes("04020004AA2A000E")
        : hexToBytes("10B0F0BC02BC0847"),
      body: new Uint8Array(context.code.erase1m),
    };
  }
  if (OLD_512.has(library.name)) {
    return {
      head: hexToBytes("80B594B06F46391C0880381C01880F29"),
      tail: hexToBytes("14B080BC02BC0847"),
      body: new Uint8Array(context.code.erase512),
    };
  }
  return {
    head: hexToBytes("70B5464640B490B0"),
    tail: hexToBytes("10B008BC984670BC02BC0847"),
    body: new Uint8Array(context.code.erase512),
  };
}

function patchCustomErase(context, library) {
  const tableOffset = ["FLASH1M_V103", "FLASH512_V133"].includes(library.name)
    ? 0x0c
    : 0x08;
  const eraseOffset = readFunctionPointer(
    context.out,
    library,
    tableOffset,
    "EraseFlashSector",
    context.warnings,
  );
  if (eraseOffset === null) return null;
  const shape = eraseFunctionShape(context, library);
  if (FLASH_1M.has(library.name)) {
    if (context.setBank === null) return null;
    patchThumbBlPlaceholder(shape.body, eraseOffset, context.setBank);
  }
  const size = functionSizeFromTail(context.out, eraseOffset, shape.head, shape.tail);
  if (size === null) {
    context.warnings.push(`${library.name}: EraseFlashSector does not match a supported implementation`);
    return null;
  }
  replaceFunction(
    context.out,
    context.operations,
    library.name,
    "EraseFlashSector",
    eraseOffset,
    size,
    shape.body,
  );
  return eraseOffset;
}

function programFunctionShape(context, library) {
  if (FLASH_1M.has(library.name)) {
    return {
      head: context.gccUsed ? hexToBytes("F0B557464E46") : hexToBytes("F0B590B00F1C"),
      tail: context.gccUsed
        ? hexToBytes("000EFF8000001847")
        : hexToBytes("10B0F0BC02BC0847"),
    };
  }
  if (OLD_512.has(library.name)) {
    return { head: hexToBytes("90B5A0B0"), tail: hexToBytes("20B090BC02BC0847") };
  }
  return {
    head: hexToBytes("F0B54F464646C0B498B0"),
    tail: hexToBytes("18B018BC9846A146F0BC02BC0847"),
  };
}

function patchCustomProgram(context, library, eraseOffset) {
  const tableOffset = ["FLASH1M_V103", "FLASH512_V133"].includes(library.name)
    ? 0x04
    : 0x00;
  const programOffset = readFunctionPointer(
    context.out,
    library,
    tableOffset,
    "ProgramFlashSector",
    context.warnings,
  );
  if (programOffset === null || eraseOffset === null) return;
  const shape = programFunctionShape(context, library);
  const body = new Uint8Array(context.code.program);
  patchThumbBlPlaceholder(body, programOffset, eraseOffset);
  const size = functionSizeFromTail(context.out, programOffset, shape.head, shape.tail);
  if (size === null) {
    context.warnings.push(`${library.name}: ProgramFlashSector does not match a supported implementation`);
    return;
  }
  replaceFunction(
    context.out,
    context.operations,
    library.name,
    "ProgramFlashSector",
    programOffset,
    size,
    body,
  );
}

function idFunctionShape(context, library) {
  if (OLD_512.has(library.name)) {
    const markerOffset = findBytes(context.out, ID_MARKERS.old);
    return {
      offset: markerOffset,
      head: hexToBytes("90B593B0"),
      tail: hexToBytes("13B090BC02BC0847"),
    };
  }
  const markerOffset = findBytes(
    context.out,
    context.gccUsed ? ID_MARKERS.gcc : ID_MARKERS.agbcc,
  );
  return {
    offset: markerOffset >= 0 ? markerOffset - (context.gccUsed ? 0x1c : 0x20) : -1,
    head: hexToBytes("30B591B0"),
    tail: hexToBytes("11B030BC02BC0847"),
  };
}

function patchCustomReadId(context, library) {
  const shape = idFunctionShape(context, library);
  const size = functionSizeFromTail(context.out, shape.offset, shape.head, shape.tail);
  if (shape.offset < 0 || size === null) {
    context.warnings.push(`${library.name}: ReadFlashId does not match a supported implementation`);
    return;
  }
  replaceFunction(
    context.out,
    context.operations,
    library.name,
    "ReadFlashId",
    shape.offset,
    size,
    FLASH_1M.has(library.name) ? context.code.id1m : context.code.id512,
  );
}

function patchCustomLibrary(context, library) {
  if (library.baseOffset < 0 || library.baseOffset >= context.out.length) {
    context.warnings.push(`${library.name}: invalid base offset`);
    return;
  }
  patchCustomBankSwitch(context, library);
  const eraseOffset = patchCustomErase(context, library);
  patchCustomProgram(context, library, eraseOffset);
  patchCustomReadId(context, library);
}

function validateCustomPlan(context, has1M) {
  if (!has1M && context.warnings.length && context.operations.length) {
    throw new PatchError(
      `Custom FLASH could not build one complete atomic FLASH512 patch plan: ${context.warnings.join("; ")}`,
    );
  }
  if (!has1M && context.warnings.length) {
    throw new PatchError(
      `Custom FLASH found an unsupported or damaged native FLASH512 library: ${context.warnings.join("; ")}`,
    );
  }
  if (!has1M && context.operations.some(
    (operation) => operation.kind === PATCH_OPERATION_KIND.BANK_SWITCH_PATCH,
  )) {
    throw new PatchError("Custom FLASH produced an invalid native FLASH512 bank-switch plan.");
  }
  if (!context.operations.length) {
    throw new PatchError(
      `Custom FLASH could not build a patch plan${context.warnings.length ? `: ${context.warnings.join("; ")}` : "."}`,
    );
  }
}

function applyCustomWaitstate(context) {
  if (!context.options.waitstate?.enabled) return { bytes: context.out, waitstate: null };
  const wait = applyWaitstateToBytes(context.out, context.options.waitstate);
  context.operations.push(...wait.result.operations);
  context.warnings.push(...wait.result.warnings);
  return { bytes: wait.bytes, waitstate: wait.result.waitstate };
}

function customFlashResult(context, bytes, waitstate, has1M, targetSaveSize) {
  if (!context.options.deferHeaderFinalization && context.operations.length) {
    const flags = makePatchHeaderFlags({
      saveMedium: PATCH_SAVE_MEDIUM.FLASH,
      saveSize: targetSaveSize,
      batteryless: false,
      waitstateResult: waitstate,
    });
    applyPatchHeaderMarker(bytes, context.operations, flags);
  }
  const result = {
    mode: "custom-flash",
    status: "patched",
    saveType: [...new Set(context.libraries.map((library) => library.name))].join(","),
    sourceSaveType: findSaveType(context.data),
    detectedSaveType: findSaveType(bytes),
    targetSaveType: has1M ? "FLASH1M" : "FLASH512",
    logicalSaveSizeBytes: targetSaveSize,
    targetSaveSizeBytes: targetSaveSize,
    bankSwitchMode: has1M ? "flash1m" : "none",
    flashJournal: null,
    saveChipType: context.type,
    saveChipName: SAVE_CHIP_TYPES[context.type],
    flashLibraries: context.libraries,
    operations: context.operations,
    warnings: context.warnings,
    title: readAscii(bytes, 0xa0, 12),
    gameCode: readAscii(bytes, 0xac, 4),
  };
  if (waitstate) result.waitstate = waitstate;
  return { bytes, result };
}

export function patchCustomFlashBytes(inputBytes, options = {}) {
  const context = customFlashContext(inputBytes, options);
  const fallback = journalFallback(context);
  if (fallback) return fallback;
  const has1M = context.libraries.some((library) => FLASH_1M.has(library.name));
  const targetSaveSize = customFlashSaveSize(
    context.libraries.map((library) => library.name),
  );
  for (const library of context.libraries) patchCustomLibrary(context, library);
  validateCustomPlan(context, has1M);
  const patched = applyCustomWaitstate(context);
  return customFlashResult(context, patched.bytes, patched.waitstate, has1M, targetSaveSize);
}

export { SAVE_CHIP_TYPES };
