// SPDX-License-Identifier: GPL-3.0-or-later AND MIT

import { hexToBytes } from "../core/binary.js";

/*
 * Central registry of byte signatures that are allowed to select a Direct
 * hook ABI.  Every entry below identifies a Nintendo/third-party save-library
 * routine or compiler ABI layout.  Game code, callers, tables, titles and ROM
 * metadata are intentionally forbidden here; those are handled only by CFG
 * and data-flow analysis.
 */
export const DIRECT_SDK_HOOKS = Object.freeze({
  sramWrite: Object.freeze([
    Object.freeze({ name: "WriteSram", marker: hexToBytes("30b5051c0c1c131c0b4a10880b490840"), thunk: "thumb" }),
    Object.freeze({ name: "WriteSram alternate", marker: hexToBytes("80b583b06f4638607960ba6009480949"), thunk: "thumb" }),
    Object.freeze({ name: "WriteSramFast", marker: hexToBytes("04c090e401c0c1e42cc4a0e101c0c1e4"), thunk: "arm" }),
  ]),
  sramRead: Object.freeze({ name: "ReadSram", marker: hexToBytes("70b5a0b0041c0d1c161c084a10880849"), thunk: "thumb" }),
  sramVerify: Object.freeze({ name: "VerifySram", marker: hexToBytes("70b5b0b0041c0d1c161c084a10880849"), thunk: "thumb" }),
  eepromWrite: Object.freeze({ name: "ProgramEepromDword", marker: hexToBytes("70b500040a1c400be02109054118073100231078"), thunk: "thumb" }),
  eepromRead: Object.freeze({ name: "ReadEepromDword", marker: hexToBytes("70b500040a1c400be021090541180731"), thunk: "thumb" }),
  eepromVerify: Object.freeze({ name: "VerifyEepromDword", marker: hexToBytes("30b582b00c1c0004010c002503480068"), thunk: "thumb" }),
  eepromMeta: Object.freeze({ name: "IdentifyEeprom", marker: hexToBytes("0004000c0022042808d1024902480860") }),
});

export const DIRECT_EEPROM_V11X_ANCHOR = hexToBytes("0e48396801600e48796801600d48391c");

export const DIRECT_EEPROM_V11X_LAYOUTS = Object.freeze({
  EEPROM_V110: Object.freeze({
    read: Object.freeze({ offset: 0x48, marker: hexToBytes("b0b5aab06f467960391c0880381c01883f2903d9004897e0") }),
    write: Object.freeze({ offset: 0x198, marker: hexToBytes("80b5aab06f467960391c0880381c01883f2903d90048b3e0") }),
    verify: Object.freeze({ offset: 0x320, marker: hexToBytes("b0b587b06f467960391c0880381c183000210180381c0188") }),
  }),
  EEPROM_V111: Object.freeze({
    read: Object.freeze({ offset: 0x48, marker: hexToBytes("b0b5aab06f467960391c0880381c01883f2903d9004899e0") }),
    write: Object.freeze({ offset: 0x19c, marker: hexToBytes("80b5aab06f467960391c0880381c01883f2903d90048bfe0") }),
    verify: Object.freeze({ offset: 0x33c, marker: hexToBytes("b0b587b06f467960391c0880381c183000210180381c0188") }),
  }),
});

export const DIRECT_SRAM_LAYOUTS = Object.freeze({
  SRAM_F_V100: Object.freeze({
    read: Object.freeze({ offset: 0, marker: hexToBytes("80b583b06f4638607960ba60094809490a88094b111c1940") }),
    write: Object.freeze({ offset: 0x58, marker: hexToBytes("80b583b06f4638607960ba60094809490a88094b111c1940") }),
    verify: Object.freeze({ offset: 0xb0, marker: hexToBytes("90b583b06f4638607960ba60094809490a88094b111c1940") }),
  }),
  SRAM_F_V102: Object.freeze({
    read: Object.freeze({ offset: 0, marker: hexToBytes("30b5051c0c1c131c0b4a10880b490840032108431080013b") }),
    write: Object.freeze({ offset: 0x40, marker: hexToBytes("30b5051c0c1c131c0b4a10880b490840032108431080013b") }),
    verify: Object.freeze({ offset: 0x80, marker: hexToBytes("30b5051c0c1c131c0a4a10880a490840032108431080013b") }),
  }),
  SRAM_F_V103: Object.freeze({
    readbackVerify: true,
    read: Object.freeze({ offset: 0, marker: hexToBytes("30b5051c0c1c131c0b4a10880b490840032108431080013b") }),
    write: Object.freeze({ offset: 0x40, marker: hexToBytes("30b5051c0c1c131c0b4a10880b490840032108431080013b") }),
    verify: Object.freeze({ offset: 0x80, marker: hexToBytes("30b5051c0c1c131c0a4a10880a490840032108431080013b") }),
  }),
  SRAM_F_V110: Object.freeze({
    read: Object.freeze({ offset: 0, marker: hexToBytes("30b5051c0c1c131c0b4a10880b490840032108431080013b") }),
    write: Object.freeze({ offset: 0x40, marker: hexToBytes("f0b5041c0e1c151c034a1088034908400321084310800ae0") }),
    verify: Object.freeze({ offset: 0xb0, marker: hexToBytes("30b5051c0c1c131c0a4a10880a490840032108431080013b") }),
  }),
  SRAM_V110: Object.freeze({
    read: Object.freeze({ offset: 0, marker: hexToBytes("90b5a7b06f4638607960ba60174817490a88174b111c1940") }),
    write: Object.freeze({ offset: 0xd8, marker: hexToBytes("80b583b06f4638607960ba60094809490a88094b111c1940") }),
    verify: Object.freeze({ offset: 0x178, marker: hexToBytes("90b5b7b06f4638607960ba60174817490a88174b111c1940") }),
  }),
});

export const DIRECT_EEPROM_V12X_ABI = Object.freeze({
  genericWrite: hexToBytes("70b500040a1c400be021090541180731002310780870013301320139072bf8d9002070bc02bc0847"),
  timerTail: hexToBytes("0e48fff7b5fe0024d021090501230c4a08881840002808d110780028f8d0088801210840002800d1064cfff7e5fe201c29b030bc02bc0847"),
  setupPrefix: hexToBytes("f0b54f464646c0b4184a194989460988118000264a461680164b98461d686e80"),
  cleanupPrefix: hexToBytes("0b4b002119800b4a1068018002301060018002381060084a0848007808218140"),
  configPrefix: hexToBytes("0a00bdffc2000000"),
  largeTailA: hexToBytes("69464318843300201880023b00212a88023500201a80023b520801300006000e0f28f7d9481c0006010e0329efd900210148021c006808e0"),
  largeTailB: hexToBytes("1c80023b6408481c0006010e1068007a8142f5d300201880023b01201880d021090513480068007a02048620c0031218120c6846fff716ff0e48fff7bffe0024d021090501230c4a08881840002808d110780028f8d0088801210840002800d1064cfff7ddfe201c29b030bc02bc0847"),
  largeSetup: hexToBytes("30b5114a114b1988118000251d80104c1049097808228a40218811432180012119800d490d700d4a0188118002300c4b196802880a8002311960408808800239196030bc01bc0047"),
  largeCleanup: hexToBytes("0b4908680022028002300860028002380860084b1a80084a084800780821814010888843108006480088188070470000"),
  largeTimerSelector: hexToBytes("0a1c0006010e032914d806480170064900788000054bc018086005481060002009e00000"),
  largeTimerIrq: hexToBytes("06490888002808d00888013808800004002802d10249012008707047"),
  largeOriginalHead: hexToBytes("30b5a9b00d1c0004040c034800688088844205d3014859e0"),
  largeOriginalTail: hexToBytes("0f480068007a4000"),
});
