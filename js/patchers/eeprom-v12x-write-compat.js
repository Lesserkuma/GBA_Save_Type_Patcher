// SPDX-License-Identifier: GPL-3.0-or-later AND MIT

import {
  hexToBytes,
  readU16,
  readU32,
  startsWithBytes,
  writeU16,
  writeU32,
} from "../core/binary.js";

const GBA_ROM_BASE = 0x08000000;
const GBA_IWRAM_START = 0x03000000;
const GBA_IWRAM_END = 0x03008000;
const GBA_REG_IF = 0x04000202;
const WRAPPER_SIZE = 40;

// The generic SRAM conversion used for EEPROM V120-V122 replaces the first
// 40 bytes of ProgramEepromDword, but leaves the SDK timer setup/cleanup tail
// in place. Some games rely on the setup routine's persistent IRQ state even
// though no physical EEPROM transfer remains.
const GENERIC_EEPROM_WRITE = hexToBytes(
  "70b500040a1c400be021090541180731002310780870013301320139072bf8d9002070bc02bc0847",
);
const EEPROM_V12X_TIMER_TAIL = hexToBytes(
  "0e48fff7b5fe0024d021090501230c4a08881840002808d110780028f8d0088801210840002800d1064cfff7e5fe201c29b030bc02bc0847",
);
const EEPROM_V12X_SETUP_PREFIX = hexToBytes(
  "f0b54f464646c0b4184a194989460988118000264a461680164b98461d686e80",
);
const EEPROM_V12X_CLEANUP_PREFIX = hexToBytes(
  "0b4b002119800b4a1068018002301060018002381060084a0848007808218140",
);
const EEPROM_V12X_CONFIG_PREFIX = hexToBytes("0a00bdffc2000000");

/* A larger V120/V121 ProgramEepromDword layout keeps the SDK timeout timer
 * around the physical EEPROM transfer.  The FLASH replacement completes too
 * quickly for games that use that timer edge to pace IRQ work, so the exact
 * layout below needs one fresh timer event before cleanup.  Cleanup still
 * precedes the slower FLASH payload so that payload cannot receive additional
 * callbacks from the SDK's temporary timeout timer. */
const EEPROM_V120_LARGE_TAIL_A = hexToBytes(
  "69464318843300201880023b00212a88023500201a80023b520801300006000e0f28f7d9481c0006010e0329efd900210148021c006808e0",
);
const EEPROM_V120_LARGE_TAIL_B = hexToBytes(
  "1c80023b6408481c0006010e1068007a8142f5d300201880023b01201880d021090513480068007a02048620c0031218120c6846fff716ff0e48fff7bffe0024d021090501230c4a08881840002808d110780028f8d0088801210840002800d1064cfff7ddfe201c29b030bc02bc0847",
);
const EEPROM_V120_LARGE_SETUP = hexToBytes(
  "30b5114a114b1988118000251d80104c1049097808228a40218811432180012119800d490d700d4a0188118002300c4b196802880a8002311960408808800239196030bc01bc0047",
);
const EEPROM_V120_LARGE_CLEANUP = hexToBytes(
  "0b4908680022028002300860028002380860084b1a80084a084800780821814010888843108006480088188070470000",
);
const EEPROM_V120_LARGE_TIMER_SELECTOR = hexToBytes(
  "0a1c0006010e032914d806480170064900788000054bc018086005481060002009e00000",
);
const EEPROM_V120_LARGE_TIMER_IRQ = hexToBytes(
  "06490888002808d00888013808800004002802d10249012008707047",
);
const EEPROM_V120_LARGE_ORIGINAL_HEAD = hexToBytes(
  "30b5a9b00d1c0004040c034800688088844205d3014859e0",
);
const EEPROM_V120_LARGE_ORIGINAL_TAIL = hexToBytes("0f480068007a4000");
const EEPROM_V120_FLASH_TIMING_WRAPPER = hexToBytes(
  "70b504000d00114800780826864010490e80104800f000f80d490888304209d10e4908880b490988884203d10c4908780028f1d000f000f820002900064b00f003f870bc02bc08471847c04600000000000000000000000000000000000000000000000000000000",
);

const EEPROM_V120_FLASH_TIMING_OFFSETS = Object.freeze({
  setupCall: 0x14,
  cleanupCall: 0x34,
  timerIndexAddress: 0x4c,
  ifAddress: 0x50,
  configAddress: 0x54,
  payloadAddress: 0x58,
  timerCountAddress: 0x5c,
  timeoutFlagAddress: 0x60,
});

function decodeThumbBlTarget(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  const high = readU16(bytes, offset);
  const low = readU16(bytes, offset + 2);
  if ((high & 0xf800) !== 0xf000 || (low & 0xf800) !== 0xf800) return null;

  let displacement = ((high & 0x07ff) << 12) | ((low & 0x07ff) << 1);
  if (displacement & 0x00400000) displacement -= 0x00800000;
  return offset + 4 + displacement;
}

function writeThumbBl(replacement, replacementOffset, sourceOffset, targetOffset) {
  const delta = targetOffset - sourceOffset - 4;
  if ((delta & 1) !== 0 || delta < -0x400000 || delta > 0x3ffffe) return false;
  writeU16(replacement, replacementOffset, 0xf000 | ((delta >> 12) & 0x07ff));
  writeU16(replacement, replacementOffset + 2, 0xf800 | ((delta >> 1) & 0x07ff));
  return true;
}

function iwramAddress(address, alignment = 1) {
  return Number.isInteger(address)
    && address >= GBA_IWRAM_START
    && address < GBA_IWRAM_END
    && address % alignment === 0;
}

/**
 * Builds the FLASH-only timing wrapper for the exact large Nintendo SDK
 * EEPROM V120/V121 writer. The normalization preimage is required so a
 * coincidental tail match after the generic SRAM conversion cannot opt in.
 */
export function buildEepromV120FlashTimingHook(
  bytes,
  writeOffset,
  payloadTargetAddress,
  originalWritePrefix,
  gbaRomBase = GBA_ROM_BASE,
) {
  if (
    !Number.isSafeInteger(writeOffset)
    || (writeOffset & 3) !== 0
    || writeOffset < 0
    || writeOffset + 0xe4 > bytes.length
    || !(originalWritePrefix instanceof Uint8Array)
    || originalWritePrefix.length !== GENERIC_EEPROM_WRITE.length
    || !startsWithBytes(bytes, writeOffset, GENERIC_EEPROM_WRITE)
    || !startsWithBytes(bytes, writeOffset + 0x28, EEPROM_V120_LARGE_TAIL_A)
    || !startsWithBytes(bytes, writeOffset + 0x64, EEPROM_V120_LARGE_TAIL_B)
    || !startsWithBytes(originalWritePrefix, 0, EEPROM_V120_LARGE_ORIGINAL_HEAD)
    || !startsWithBytes(originalWritePrefix, 0x20, EEPROM_V120_LARGE_ORIGINAL_TAIL)
    || readU32(originalWritePrefix, 0x1c) !== 0x000080ff
    || readU32(bytes, writeOffset + 0xe0) !== 0x0000c001
  ) {
    return null;
  }

  const setupOffset = decodeThumbBlTarget(bytes, writeOffset + 0x9e);
  const cleanupOffset = decodeThumbBlTarget(bytes, writeOffset + 0xc6);
  const selectorOffset = setupOffset === null ? null : setupOffset - 0x38;
  const timerIrqOffset = setupOffset === null ? null : setupOffset - 0x5c;
  if (
    setupOffset !== writeOffset - 0x1e0
    || cleanupOffset !== writeOffset - 0x17c
    || selectorOffset !== writeOffset - 0x218
    || timerIrqOffset !== writeOffset - 0x23c
    || !startsWithBytes(bytes, selectorOffset, EEPROM_V120_LARGE_TIMER_SELECTOR)
    || !startsWithBytes(bytes, timerIrqOffset, EEPROM_V120_LARGE_TIMER_IRQ)
    || !startsWithBytes(bytes, setupOffset, EEPROM_V120_LARGE_SETUP)
    || !startsWithBytes(bytes, cleanupOffset, EEPROM_V120_LARGE_CLEANUP)
  ) {
    return null;
  }

  const originalWorkAddress = readU32(originalWritePrefix, 0x18);
  const configAddress = readU32(bytes, writeOffset + 0xd8);
  const configOffset = configAddress - gbaRomBase;
  const backupAddress = readU32(bytes, setupOffset + 0x48);
  const timerIndexAddress = readU32(bytes, setupOffset + 0x54);
  const timeoutFlagAddress = readU32(bytes, setupOffset + 0x58);
  const timerCountAddress = readU32(bytes, setupOffset + 0x5c);
  const timerRegistersAddress = readU32(bytes, setupOffset + 0x60);
  const timerIrqAddress = readU32(bytes, selectorOffset + 0x30);
  if (
    originalWorkAddress !== readU32(bytes, writeOffset + 0x60)
    || originalWorkAddress !== readU32(bytes, writeOffset + 0xd4)
    || timeoutFlagAddress !== readU32(bytes, writeOffset + 0xdc)
    || readU32(bytes, setupOffset + 0x4c) !== 0x04000208
    || readU32(bytes, cleanupOffset + 0x34) !== 0x04000208
    || readU32(bytes, setupOffset + 0x50) !== 0x04000200
    || readU32(bytes, cleanupOffset + 0x38) !== 0x04000200
    || timerIndexAddress !== readU32(bytes, selectorOffset + 0x24)
    || timerRegistersAddress !== readU32(bytes, selectorOffset + 0x28)
    || readU32(bytes, selectorOffset + 0x2c) !== 0x04000100
    || (timerIrqAddress & 1) !== 1
    || ((timerIrqAddress & ~1) >>> 0) - gbaRomBase !== timerIrqOffset
    || timerCountAddress !== readU32(bytes, timerIrqOffset + 0x1c)
    || timeoutFlagAddress !== readU32(bytes, timerIrqOffset + 0x20)
    || timerIndexAddress !== readU32(bytes, cleanupOffset + 0x3c)
    || timerRegistersAddress !== readU32(bytes, cleanupOffset + 0x30)
    || backupAddress !== readU32(bytes, cleanupOffset + 0x40)
    || timerCountAddress !== timerIndexAddress + 2
    || timeoutFlagAddress !== timerIndexAddress + 4
    || timerRegistersAddress !== timerIndexAddress + 8
    || backupAddress !== timerIndexAddress + 12
    || !iwramAddress(originalWorkAddress, 4)
    || !iwramAddress(timerIndexAddress)
    || !iwramAddress(timerCountAddress, 2)
    || !iwramAddress(timeoutFlagAddress)
    || !iwramAddress(timerRegistersAddress, 4)
    || !iwramAddress(backupAddress, 2)
    || (configAddress & 3) !== 0
    || configOffset < 0
    || !startsWithBytes(bytes, configOffset, EEPROM_V12X_CONFIG_PREFIX)
  ) {
    return null;
  }

  if (!Number.isSafeInteger(payloadTargetAddress) || (payloadTargetAddress & 1) !== 1) return null;
  const payloadTargetOffset = (payloadTargetAddress & ~1) - gbaRomBase;
  if (payloadTargetOffset < 0 || payloadTargetOffset >= bytes.length) return null;

  const replacement = EEPROM_V120_FLASH_TIMING_WRAPPER.slice();
  const offsets = EEPROM_V120_FLASH_TIMING_OFFSETS;
  if (!writeThumbBl(
    replacement,
    offsets.setupCall,
    writeOffset + offsets.setupCall,
    setupOffset,
  )) return null;
  if (!writeThumbBl(
    replacement,
    offsets.cleanupCall,
    writeOffset + offsets.cleanupCall,
    cleanupOffset,
  )) return null;
  writeU32(replacement, offsets.timerIndexAddress, timerIndexAddress);
  writeU32(replacement, offsets.ifAddress, GBA_REG_IF);
  writeU32(replacement, offsets.configAddress, configAddress);
  writeU32(replacement, offsets.payloadAddress, payloadTargetAddress);
  writeU32(replacement, offsets.timerCountAddress, timerCountAddress);
  writeU32(replacement, offsets.timeoutFlagAddress, timeoutFlagAddress);

  return {
    replacement,
    setupOffset,
    cleanupOffset,
    configAddress,
    timerIndexAddress,
    timerCountAddress,
    timeoutFlagAddress,
  };
}

/**
 * Builds a compatibility hook only for the exact Nintendo SDK EEPROM
 * V120-V122 write-wrapper layout whose timer helpers are known and intact.
 * Returns null for every unproven layout so callers retain their old hook.
 */
export function buildEepromV12xWriteCompatHook(
  bytes,
  writeOffset,
  payloadTargetAddress,
  gbaRomBase = GBA_ROM_BASE,
) {
  if (
    !Number.isSafeInteger(writeOffset)
    || (writeOffset & 3) !== 0
    || writeOffset < 0
    || writeOffset + 0xd8 > bytes.length
    || !startsWithBytes(bytes, writeOffset, GENERIC_EEPROM_WRITE)
    || !startsWithBytes(bytes, writeOffset + 0x94, EEPROM_V12X_TIMER_TAIL)
  ) {
    return null;
  }

  const setupOffset = decodeThumbBlTarget(bytes, writeOffset + 0x96);
  const cleanupOffset = decodeThumbBlTarget(bytes, writeOffset + 0xbe);
  if (
    setupOffset !== writeOffset - 0x1fc
    || cleanupOffset !== writeOffset - 0x174
    || !startsWithBytes(bytes, setupOffset, EEPROM_V12X_SETUP_PREFIX)
    || !startsWithBytes(bytes, cleanupOffset, EEPROM_V12X_CLEANUP_PREFIX)
  ) {
    return null;
  }

  const configAddress = readU32(bytes, writeOffset + 0xd0);
  const configOffset = configAddress - gbaRomBase;
  if (
    (configAddress & 3) !== 0
    || configOffset < 0
    || !startsWithBytes(bytes, configOffset, EEPROM_V12X_CONFIG_PREFIX)
  ) {
    return null;
  }

  if (!Number.isSafeInteger(payloadTargetAddress) || (payloadTargetAddress & 1) !== 1) return null;
  const payloadTargetOffset = (payloadTargetAddress & ~1) - gbaRomBase;
  if (payloadTargetOffset < 0 || payloadTargetOffset >= bytes.length) return null;

  const replacement = new Uint8Array(WRAPPER_SIZE);
  // push {r4-r6,lr}; preserve arguments; load the original SDK timer config
  writeU16(replacement, 0x00, 0xb570);
  writeU16(replacement, 0x02, 0x1c04);
  writeU16(replacement, 0x04, 0x1c0d);
  writeU16(replacement, 0x06, 0x4807);
  if (!writeThumbBl(replacement, 0x08, writeOffset + 0x08, setupOffset)) return null;
  // Complete the SDK bookkeeping immediately. The physical EEPROM wait no
  // longer exists, so leaving its timer live around a replacement writer can
  // expose that unrelated code to an SDK timer interrupt.
  if (!writeThumbBl(replacement, 0x0c, writeOffset + 0x0c, cleanupOffset)) return null;
  writeU16(replacement, 0x10, 0x1c20);
  writeU16(replacement, 0x12, 0x1c29);
  if (!writeThumbBl(replacement, 0x14, writeOffset + 0x14, payloadTargetOffset)) return null;
  // Return the replacement writer's result directly.
  writeU16(replacement, 0x18, 0xbc70);
  writeU16(replacement, 0x1a, 0xbc02);
  writeU16(replacement, 0x1c, 0x4708);
  writeU16(replacement, 0x1e, 0x46c0);
  writeU16(replacement, 0x20, 0x46c0);
  writeU16(replacement, 0x22, 0x46c0);
  writeU32(replacement, 0x24, configAddress);

  return {
    replacement,
    setupOffset,
    cleanupOffset,
    configAddress,
  };
}
