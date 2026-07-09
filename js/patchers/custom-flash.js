import { asciiBytes, copyBytes, fillBytes, findBytes, hexToBytes, readAscii, readU32, sameBytes, startsWithBytes, writeU16 } from "../core/binary.js";
import { PatchError } from "../core/errors.js";
import { findSaveType } from "./sram.js";
import { applyWaitstateToBytes } from "./waitstate.js";
import { applyPatchHeaderMarker, makePatchHeaderFlags, PATCH_SAVE_MEDIUM } from "./patch-state.js";

const GBA_ROM_BASE = 0x08000000;
const SAVE_CHIP_TYPES = { 1: "SST25VF064C, SST49LF080A, 0xFFFF", 2: "SST39VF6401B" };
const PTR_ADD = { FLASH1M_V103:0x10, FLASH1M_V102:0x10, FLASH512_V133:0x10, FLASH512_V131:0x10, FLASH512_V130:0x10, FLASH_V126:0x0c, FLASH_V125:0x0c, FLASH_V124:0x0c, FLASH_V123:0x0c, FLASH_V121:0x0c, FLASH_V120:0x0c };
const SUPPORTED = Object.keys(PTR_ADD);
const FLASH_1M = new Set(["FLASH1M_V103", "FLASH1M_V102"]);
const OLD_512 = new Set(["FLASH_V121", "FLASH_V120"]);
const CODE = {
  program: hexToBytes("FEB400B5021CF70000001F231A401203E0273F05174310263602E0221203131C5532120255322A331B02AA33AA24147055251D70A02515700D1C0C783C70C0463D78AC42FBD101310137013E002EEDD101BC8646FEBC00207047"),
  bank: hexToBytes("90221205002802D1002010707047012010707047"),
  erase1m: hexToBytes("7EB400B5011C0009F700000048001F22011C1140E0221205C9021143E0221203131C5532120255322A331B02AA33AA24147055251D7080251570147055251D7030250D70C0460D78FF2DFBD1011C01221140002901D10130D9E701BC86467EBC00207047"),
  id1m: hexToBytes("09200002C23070475061746368206279204C4B00"),
  erase512: hexToBytes("7EB400B5011C000948001F22011C1140E0221205C9021143E0221203131C5532120255322A331B02AA33AA24147055251D7080251570147055251D7030250D70C0460D78FF2DFBD1011C01221140002901D10130D9E701BC86467EBC00207047"),
  id512: hexToBytes("04B490221205002802D10020107002E000201070FFE7D4200002BF3004BC70475061746368206279204C4B00"),
};
const AGBCC_BANK = hexToBytes("0006000E054BAA211970054A55211170B0211970E021090508707047");
const GCC_BANK = hexToBytes("AA225521054B1A70054A1170B0221A70E0230006000E1B0518707047");
const GCC_READ = hexToBytes("AA2555261C4B1D701C4D2E70B0251D70E02300011B05000E1870");
const ID_MARKERS = { old: hexToBytes("90B593B06F46391D081C"), agbcc: hexToBytes("034A101C08E000005555000EAA2A000E"), gcc: hexToBytes("11A9881A423811000988013B02321152") };
const BL_PLACEHOLDER = hexToBytes("F7000000");

export function customFlashSaveSize(libraryNames) {
  const names = Array.from(libraryNames || []);
  const has1M = names.some((name) => FLASH_1M.has(name));
  const has512K = names.some((name) => !FLASH_1M.has(name));
  if (has1M && has512K) throw new PatchError("Custom FLASH found conflicting 512K and 1M FLASH libraries.");
  return has1M ? 131072 : 65536;
}

function cloneCode(type) { const code = Object.fromEntries(Object.entries(CODE).map(([k, v]) => [k, new Uint8Array(v)])); if (type === 2) { code.erase1m[0x40] = 0x50; code.erase512[0x3c] = 0x50; } return code; }
function addOperation(operations, library, fn, offset, size) { operations.push({ name: `${library}: ${fn}`, library, function: fn, offset, size }); }
function patchThumbBlPlaceholder(body, functionOffset, targetOffset) { const placeholderOffset = findBytes(body, BL_PLACEHOLDER); if (placeholderOffset < 0) throw new PatchError("Thumb BL placeholder not found"); const delta = (((functionOffset + placeholderOffset) - targetOffset) >> 1) + 2; const encoded = (((0x1000000 - delta) & 0xffffff) | (0xf7 << 24)) >>> 0; writeU16(body, placeholderOffset, (encoded >>> 16) & 0xffff); writeU16(body, placeholderOffset + 2, encoded & 0xffff); }
function functionSizeFromTail(out, offset, head, tail) { if (offset < 0 || offset + head.length > out.length) return null; if (!startsWithBytes(out, offset, head)) return null; const tailOffset = findBytes(out, tail, offset); return tailOffset < 0 ? null : tailOffset - offset + tail.length; }
function replaceFunction(out, operations, library, fn, offset, size, code) { if (code.length > size) throw new PatchError(`${library}: ${fn} does not have enough room for new code`); fillBytes(out, offset, size, 0); copyBytes(out, offset, code); addOperation(operations, library, fn, offset, size); }
function readFunctionPointer(out, library, tableAdd, fn, warnings) { const pointerOffset = library.base_offset + tableAdd; if (pointerOffset < 0 || pointerOffset + 4 > out.length) { warnings.push(`${library.name}: ${fn} pointer is outside the ROM`); return null; } const functionOffset = readU32(out, pointerOffset) - GBA_ROM_BASE - 1; if (functionOffset < 0 || functionOffset >= out.length) { warnings.push(`${library.name}: ${fn} address is invalid`); return null; } return functionOffset; }

function findFlashLibraries(out) {
  const hits = [];
  for (const name of SUPPORTED) {
    const marker = asciiBytes(name);
    let pos = 0;
    while (true) {
      const stringOffset = findBytes(out, marker, pos);
      if (stringOffset < 0) break;
      const pointerOffset = stringOffset + PTR_ADD[name];
      if (pointerOffset + 4 <= out.length) hits.push({ name, string_offset: stringOffset, base_offset: readU32(out, pointerOffset) - GBA_ROM_BASE });
      pos = stringOffset + marker.length;
    }
  }
  return hits;
}

export function patchCustomFlashBytes(inputBytes, options = {}) {
  const data = new Uint8Array(inputBytes);
  if (data.length < 0xc0 || data[0xb2] !== 0x96) throw new PatchError("Invalid GBA header.");
  const type = Number(options.saveChipType || 1);
  const code = cloneCode(type);
  const out = new Uint8Array(data);
  const beforePatch = new Uint8Array(out);
  const operations = [];
  const warnings = [];
  let gccUsed = false;
  let setBank = null;
  const libs = findFlashLibraries(out);
  if (!libs.length) throw new PatchError("Custom FLASH requires a 512K FLASH or 1M FLASH ROM.");
  const has1M = libs.some((library) => FLASH_1M.has(library.name));
  const targetSaveSize = customFlashSaveSize(libs.map((library) => library.name));

  for (const lib of libs) {
    if (lib.base_offset < 0 || lib.base_offset >= out.length) { warnings.push(`${lib.name}: invalid base offset`); continue; }
    if (FLASH_1M.has(lib.name)) {
      let offset = findBytes(out, AGBCC_BANK);
      if (offset < 0) { offset = findBytes(out, GCC_BANK); gccUsed = offset >= 0; }
      if (offset < 0) { warnings.push(`${lib.name}: SwitchFlashBank is stubbed or already patched`); continue; }
      setBank = offset;
      replaceFunction(out, operations, lib.name, "SwitchFlashBank", offset, 0x1c, code.bank);
      if (gccUsed) {
        const readOffset = findBytes(out, GCC_READ);
        if (readOffset >= 0) { const body = hexToBytes("00011B05000E01B404B4F700000004BC01BCC046C046C046C046"); patchThumbBlPlaceholder(body, readOffset, setBank); replaceFunction(out, operations, lib.name, "ReadFlash GCC bank call", readOffset, 0x1a, body); }
      }
    }

    const eraseAdd = ["FLASH1M_V103", "FLASH512_V133"].includes(lib.name) ? 0x0c : 0x08;
    const eraseOffset = readFunctionPointer(out, lib, eraseAdd, "EraseFlashSector", warnings);
    if (eraseOffset === null) continue;
    let head, tail, body;
    if (FLASH_1M.has(lib.name)) { head = gccUsed ? hexToBytes("F0B54F46") : hexToBytes("F0B590B0"); tail = gccUsed ? hexToBytes("04020004AA2A000E") : hexToBytes("10B0F0BC02BC0847"); body = new Uint8Array(code.erase1m); if (setBank === null) continue; patchThumbBlPlaceholder(body, eraseOffset, setBank); }
    else { if (OLD_512.has(lib.name)) { head = hexToBytes("80B594B06F46391C0880381C01880F29"); tail = hexToBytes("14B080BC02BC0847"); } else { head = hexToBytes("70B5464640B490B0"); tail = hexToBytes("10B008BC984670BC02BC0847"); } body = new Uint8Array(code.erase512); }
    const eraseSize = functionSizeFromTail(out, eraseOffset, head, tail);
    if (eraseSize === null) { warnings.push(`${lib.name}: EraseFlashSector is stubbed or already patched`); continue; }
    replaceFunction(out, operations, lib.name, "EraseFlashSector", eraseOffset, eraseSize, body);

    const progAdd = ["FLASH1M_V103", "FLASH512_V133"].includes(lib.name) ? 0x04 : 0x00;
    const progOffset = readFunctionPointer(out, lib, progAdd, "ProgramFlashSector", warnings);
    if (progOffset === null) continue;
    if (FLASH_1M.has(lib.name)) { head = gccUsed ? hexToBytes("F0B557464E46") : hexToBytes("F0B590B00F1C"); tail = gccUsed ? hexToBytes("000EFF8000001847") : hexToBytes("10B0F0BC02BC0847"); }
    else if (OLD_512.has(lib.name)) { head = hexToBytes("90B5A0B0"); tail = hexToBytes("20B090BC02BC0847"); }
    else { head = hexToBytes("F0B54F464646C0B498B0"); tail = hexToBytes("18B018BC9846A146F0BC02BC0847"); }
    body = new Uint8Array(code.program);
    patchThumbBlPlaceholder(body, progOffset, eraseOffset);
    const progSize = functionSizeFromTail(out, progOffset, head, tail);
    if (progSize === null) { warnings.push(`${lib.name}: ProgramFlashSector is stubbed or already patched`); continue; }
    replaceFunction(out, operations, lib.name, "ProgramFlashSector", progOffset, progSize, body);

    let markerOffset, idOffset;
    if (OLD_512.has(lib.name)) { markerOffset = findBytes(out, ID_MARKERS.old); idOffset = markerOffset; head = hexToBytes("90B593B0"); tail = hexToBytes("13B090BC02BC0847"); }
    else if (gccUsed) { markerOffset = findBytes(out, ID_MARKERS.gcc); idOffset = markerOffset >= 0 ? markerOffset - 0x1c : -1; head = hexToBytes("30B591B0"); tail = hexToBytes("11B030BC02BC0847"); }
    else { markerOffset = findBytes(out, ID_MARKERS.agbcc); idOffset = markerOffset >= 0 ? markerOffset - 0x20 : -1; head = hexToBytes("30B591B0"); tail = hexToBytes("11B030BC02BC0847"); }
    const idSize = functionSizeFromTail(out, idOffset, head, tail);
    if (idOffset < 0 || idSize === null) { warnings.push(`${lib.name}: ReadFlashId is stubbed or already patched`); continue; }
    replaceFunction(out, operations, lib.name, "ReadFlashId", idOffset, idSize, FLASH_1M.has(lib.name) ? code.id1m : code.id512);
  }

  let bytes = out;
  let waitstate = null;
  if (options.waitstate?.enabled) {
    const wait = applyWaitstateToBytes(bytes, options.waitstate);
    bytes = wait.bytes;
    operations.push(...wait.result.operations);
    warnings.push(...wait.result.warnings);
    waitstate = wait.result.waitstate;
  }
  if (!options.deferHeaderFinalization && operations.length) {
    const headerFlags = makePatchHeaderFlags(bytes, {
      saveMedium: PATCH_SAVE_MEDIUM.FLASH,
      saveSize: targetSaveSize,
      batteryless: false,
      waitstateResult: waitstate,
    });
    applyPatchHeaderMarker(bytes, operations, headerFlags);
  }
  const changed = !sameBytes(bytes, beforePatch);
  const status = changed ? "patched" : "already_patched";
  const result = { mode: "custom-flash", status, save_type: [...new Set(libs.map((h) => h.name))].join(","), detected_save_type: findSaveType(bytes), target_save_type: has1M ? "FLASH1M" : "FLASH512", logical_save_size: targetSaveSize, save_chip_type: type, save_chip_name: SAVE_CHIP_TYPES[type], flash_libraries: libs, operations, warnings, title: readAscii(bytes, 0xa0, 12), game_code: readAscii(bytes, 0xac, 4) };
  if (waitstate) result.waitstate = waitstate;
  return { bytes, result };
}

export { SAVE_CHIP_TYPES };
