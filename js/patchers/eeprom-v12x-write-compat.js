// SPDX-License-Identifier: GPL-3.0-or-later AND MIT

import {
  hexToBytes,
  readU32,
  startsWithBytes,
  writeU16,
  writeU32,
} from "../core/binary.js";
import { decodeThumbBlTarget, writeThumbBl } from "../core/thumb.js";
import {
  GBA_IWRAM_END_ADDRESS,
  GBA_IWRAM_START_ADDRESS,
  GBA_ROM_BASE_ADDRESS,
} from "../domain/gba-constants.js";
import {
  EEPROM_V120_RUNTIME_WRAPPER_HEX,
  EEPROM_V120_RUNTIME_WRAPPER_OFFSETS,
} from "./eeprom-v120-wrapper-data.js";
import { DIRECT_EEPROM_V12X_ABI } from "./direct-abi-signatures.js";

const WRAPPER_SIZE = 40;

// The generic SRAM conversion used for EEPROM V120-V122 replaces the first
// 40 bytes of ProgramEepromDword, but leaves the SDK timer setup/cleanup tail
// in place. Some games rely on the setup routine's persistent IRQ state even
// though no physical EEPROM transfer remains.
/* Nintendo SDK V12x ABI layouts. The generated V120/V121 wrapper writes the
 * eight stable source bytes first, then reproduces the SDK timer tail only
 * when every runtime pointer/register invariant is valid. */
const GENERIC_EEPROM_WRITE = DIRECT_EEPROM_V12X_ABI.genericWrite;
const EEPROM_V12X_TIMER_TAIL = DIRECT_EEPROM_V12X_ABI.timerTail;
const EEPROM_V12X_SETUP_PREFIX = DIRECT_EEPROM_V12X_ABI.setupPrefix;
const EEPROM_V12X_CLEANUP_PREFIX = DIRECT_EEPROM_V12X_ABI.cleanupPrefix;
const EEPROM_V12X_CONFIG_PREFIX = DIRECT_EEPROM_V12X_ABI.configPrefix;
const EEPROM_V120_LARGE_TAIL_A = DIRECT_EEPROM_V12X_ABI.largeTailA;
const EEPROM_V120_LARGE_TAIL_B = DIRECT_EEPROM_V12X_ABI.largeTailB;
const EEPROM_V120_LARGE_SETUP = DIRECT_EEPROM_V12X_ABI.largeSetup;
const EEPROM_V120_LARGE_CLEANUP = DIRECT_EEPROM_V12X_ABI.largeCleanup;
const EEPROM_V120_LARGE_TIMER_SELECTOR = DIRECT_EEPROM_V12X_ABI.largeTimerSelector;
const EEPROM_V120_LARGE_TIMER_IRQ = DIRECT_EEPROM_V12X_ABI.largeTimerIrq;
const EEPROM_V120_LARGE_ORIGINAL_HEAD = DIRECT_EEPROM_V12X_ABI.largeOriginalHead;
const EEPROM_V120_LARGE_ORIGINAL_TAIL = DIRECT_EEPROM_V12X_ABI.largeOriginalTail;
const EEPROM_V120_FLASH_RUNTIME_WRAPPER = hexToBytes(
  EEPROM_V120_RUNTIME_WRAPPER_HEX,
);

function iwramAddress(address, alignment = 1) {
  return Number.isInteger(address)
    && address >= GBA_IWRAM_START_ADDRESS
    && address < GBA_IWRAM_END_ADDRESS
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
  gbaRomBase = GBA_ROM_BASE_ADDRESS,
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

  const replacement = EEPROM_V120_FLASH_RUNTIME_WRAPPER.slice();
  writeU32(replacement, EEPROM_V120_RUNTIME_WRAPPER_OFFSETS.setupAddress,
    (gbaRomBase + setupOffset + 1) >>> 0);
  writeU32(replacement, EEPROM_V120_RUNTIME_WRAPPER_OFFSETS.cleanupAddress,
    (gbaRomBase + cleanupOffset + 1) >>> 0);
  writeU32(replacement, EEPROM_V120_RUNTIME_WRAPPER_OFFSETS.payloadAddress,
    payloadTargetAddress);
  writeU32(replacement, EEPROM_V120_RUNTIME_WRAPPER_OFFSETS.timerStateAddress,
    timerIndexAddress);
  writeU32(replacement, EEPROM_V120_RUNTIME_WRAPPER_OFFSETS.configAddress,
    configAddress);
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
  gbaRomBase = GBA_ROM_BASE_ADDRESS,
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
