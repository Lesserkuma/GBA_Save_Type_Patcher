// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { readU32 } from "../core/binary.js";
import { cloneDefaultOptions, WORKER_PROTOCOL_VERSION } from "../domain/constants.js";
import { DIRECT_SRAM_LAYOUTS } from "../patchers/direct-abi-signatures.js";
import { IRQ_HANDLER_CONSTANTS } from "../patchers/irq-handler-data.js";
import { RTC_PAYLOAD_CONSTANTS } from "../patchers/rtc-data.js";
import {
  applyRtcForPipeline,
  hasRecognizedRtcHandlerSet,
  RTC_HANDLER_SIGNATURES,
  RTC_PERSISTENCE_MAPPER_CLEANUP_FLAG,
  RTC_PERSISTENCE_SHARED_SAVE_AREA_FLAG,
  RTC_PERSISTENCE_VISOLY_MAPPER_CLEANUP_FLAG,
} from "../patchers/rtc.js";
import { WORKER_MESSAGE_TYPE } from "../worker/protocol.js";

const rtcPersistenceSource = readFileSync(
  new URL("../../payloads/fake-rtc/rtc_persist.c", import.meta.url),
  "utf8",
);
const mapperDriverSource = rtcPersistenceSource.slice(
  rtcPersistenceSource.indexOf("RAM_CODE uint32_t rtc_mapper_cleanup_driver(void)"),
  rtcPersistenceSource.indexOf("RAM_CODE uint32_t rtc_mapper_cleanup_driver_end(void)"),
);
const mapperCleanupSource = rtcPersistenceSource.slice(
  rtcPersistenceSource.indexOf("static void mapper_cleanup(void)"),
  rtcPersistenceSource.indexOf("static uint32_t run_driver", rtcPersistenceSource.indexOf("static void mapper_cleanup(void)")),
);
const visolyMapperDriverSource = rtcPersistenceSource.slice(
  rtcPersistenceSource.indexOf("RAM_CODE uint32_t rtc_visoly_mapper_cleanup_driver(void)"),
  rtcPersistenceSource.indexOf("RAM_CODE uint32_t rtc_visoly_mapper_cleanup_driver_end(void)"),
);
assert.ok(
  mapperDriverSource.includes("GBA_SRAM_BANK_SELECT_ADDRESS")
    && mapperDriverSource.includes('asm volatile("nop\\nnop\\nnop\\nnop"'),
  "modern mapper cleanup must execute with settling instructions in RAM code",
);
assert.ok(
  mapperCleanupSource.includes("rtc_persist_run_from_stack")
    && !mapperCleanupSource.includes("GBA_SRAM_BANK_SELECT_ADDRESS"),
  "RTC cleanup must dispatch the mapper write from RAM instead of GamePak ROM",
);
for (const token of [
  "0x0930ECA8u",
  "0x0802468Au",
  "0x0800ECA8u",
  "0x08ECA800u",
  "0x080268A0u",
  "0x0942468Au",
  "repeat < 2000u",
]) {
  assert.ok(visolyMapperDriverSource.includes(token), `Visoly RTC cleanup: ${token}`);
}
for (const value of ["0x1234u", "0x5678u", "0xABCDu"]) {
  assert.ok(
    visolyMapperDriverSource.includes(
      `*command = ${value};\n    for (repeat = 0; repeat < 2000u; ++repeat)\n        __asm volatile("nop");`,
    ),
    `Visoly RTC cleanup must write ${value} once before its 2000-NOP delay`,
  );
}
assert.equal(
  visolyMapperDriverSource.match(/__asm volatile\("nop"\);/g)?.length,
  3,
  "Visoly RTC cleanup must contain exactly three explicit NOP delay loops",
);
assert.ok(
  visolyMapperDriverSource.includes("execution_address < 0x03000000u")
    && visolyMapperDriverSource.includes("execution_address >= 0x03008000u"),
  "Visoly RTC cleanup must reject a non-IWRAM execution stack before unlocking",
);
assert.ok(
  mapperCleanupSource.indexOf("RTC_PERSIST_FLAG_VISOLY_MAPPER_CLEANUP")
    < mapperCleanupSource.indexOf("RTC_PERSIST_FLAG_MAPPER_CLEANUP"),
  "Visoly cleanup must take precedence over the modern mapper write",
);

const identify1Source = rtcPersistenceSource.slice(
  rtcPersistenceSource.indexOf("RAM_CODE uint32_t rtc_flash_identify_1(uint32_t normalize_mapper)"),
  rtcPersistenceSource.indexOf("RAM_CODE uint32_t rtc_flash_erase_1(uint32_t target)"),
);
const erase1Source = rtcPersistenceSource.slice(
  rtcPersistenceSource.indexOf("RAM_CODE uint32_t rtc_flash_erase_1(uint32_t target)"),
  rtcPersistenceSource.indexOf("RAM_CODE uint32_t rtc_flash_program_1"),
);
const program1Source = rtcPersistenceSource.slice(
  rtcPersistenceSource.indexOf("RAM_CODE uint32_t rtc_flash_program_1"),
  rtcPersistenceSource.indexOf("RAM_CODE uint32_t rtc_flash_identify_2(void)"),
);
const selectDriverStart = rtcPersistenceSource.indexOf(
  "static uint32_t select_flash_driver(FlashDriver *driver)",
);
const selectDriverSource = rtcPersistenceSource.slice(
  selectDriverStart,
  rtcPersistenceSource.indexOf("static uint32_t erase_flash", selectDriverStart),
);
const persistenceFlushSource = rtcPersistenceSource.slice(
  rtcPersistenceSource.indexOf("uint32_t rtc_persist_flush(uint32_t release_mask)"),
  rtcPersistenceSource.indexOf("uint32_t rtc_persist_flush_initial(void)"),
);
assert.ok(
  identify1Source.includes("return RTC_FLASH_PROBE_UNSUPPORTED;"),
  "buffered Intel hardware must remain recognizable as explicitly unsupported",
);
assert.ok(
  identify1Source.includes("if (normalize_mapper)")
    && identify1Source.includes("GBA_SRAM_BANK_SELECT_ADDRESS")
    && identify1Source.indexOf("flash_write(0, 0x0050)")
      < identify1Source.indexOf("original = *(volatile uint32_t *)ROM_BASE"),
  "Intel identification must normalize the mapper in RAM and clear stale status before probing",
);
assert.ok(
  identify1Source.lastIndexOf("flash_write(0, 0x0050)")
    < identify1Source.lastIndexOf("flash_write(0, 0x00FF)"),
  "every successful Intel probe path must finish with clear-status and read-array commands",
);
assert.ok(
  erase1Source.includes("flash_write(target, 0x0070)")
    && erase1Source.includes("if (status & 0x0080u)")
    && erase1Source.includes("status == 0x0080u")
    && erase1Source.includes("ROM_HALFWORDS[target >> 1] == 0xFFFFu"),
  "Intel erase must poll the ready bit, validate the complete status, and verify erased data",
);
assert.ok(
  program1Source.includes("if (value == 0xFFFFu)")
    && program1Source.includes("flash_write(address, 0x0070)")
    && program1Source.includes("if (status & 0x0080u)")
    && program1Source.includes("status != 0x0080u"),
  "Intel program must skip erased words and validate ready plus error status for every write",
);
assert.doesNotMatch(
  rtcPersistenceSource,
  /rtc_flash_(?:identify|erase|program)_4|driver->type\s*(?:==|=)\s*4u|0x00EA|0x01FF/,
  "Fake RTC must not contain a Type 4 erase/program path",
);
const unsupportedAbort = selectDriverSource.indexOf("if (result != RTC_FLASH_PROBE_NONE)");
const type2Probe = selectDriverSource.indexOf("rtc_flash_identify_2");
assert.ok(
  unsupportedAbort >= 0 && unsupportedAbort < type2Probe,
  "unsupported Type 4 must fail closed before probing another driver",
);
assert.ok(
  selectDriverSource.indexOf("rtc_persist_flags_config & RTC_PERSIST_FLAG_MAPPER_CLEANUP")
    < selectDriverSource.indexOf("rtc_flash_identify_1"),
  "Intel identification must receive the structural mapper-normalization flag",
);
assert.ok(
  persistenceFlushSource.indexOf("select_flash_driver(&driver)")
    < persistenceFlushSource.indexOf("erase_flash(&driver, base)"),
  "driver rejection must happen before the first persistence erase",
);

function writeU16(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = value >>> 8;
}

function repairHeaderChecksum(bytes) {
  let sum = 0;
  for (let offset = 0xa0; offset <= 0xbc; offset += 1) sum += bytes[offset];
  bytes[0xbd] = (-(sum + 0x19)) & 0xff;
}

function syntheticRtcSramRom() {
  const bytes = new Uint8Array(0x100000);
  const saveType = "SRAM_F_V102";
  const layout = DIRECT_SRAM_LAYOUTS[saveType];
  const saveLibraryBase = 0x200;

  // Ordinary GBA entrypoint branch and fixed header byte.
  bytes.set([0x2e, 0x00, 0x00, 0xea], 0);
  bytes[0xb2] = 0x96;
  bytes.set(new TextEncoder().encode(saveType), 0x100);
  bytes.set(layout.read.marker, saveLibraryBase + layout.read.offset);
  bytes.set(layout.write.marker, saveLibraryBase + layout.write.offset);
  bytes.set(layout.verify.marker, saveLibraryBase + layout.verify.offset);

  let signatureOffset = 0x1000;
  for (const name of ["probe", "reset", "getstatus", "gettimedate"]) {
    RTC_HANDLER_SIGNATURES[name].forEach((rawValue, index) => {
      writeU16(bytes, signatureOffset + index * 2, rawValue || 0xffff);
    });
    signatureOffset += 0x200;
  }
  repairHeaderChecksum(bytes);
  return bytes;
}

const pendingResponses = new Map();
let workerMessageHandler = null;
globalThis.self = {
  addEventListener(type, callback) {
    assert.equal(type, "message");
    workerMessageHandler = callback;
  },
  postMessage(message) {
    const resolve = pendingResponses.get(message.requestId);
    if (!resolve) return;
    pendingResponses.delete(message.requestId);
    resolve(message);
  },
};

await import("../patch-worker.js");
assert.equal(typeof workerMessageHandler, "function");

async function patchMode(
  patchMode,
  persistenceEnabled = true,
  flash1mBankSwitchStyle = "modern",
  rtcTickMode = "read",
  showMenuOnBoot = true,
) {
  const options = cloneDefaultOptions();
  options.patchMode = patchMode;
  options.rtc.enabled = true;
  options.rtc.tickMode = rtcTickMode;
  options.rtc.showMenuOnBoot = showMenuOnBoot;
  options.rtc.saveOnGlobalHotkey = persistenceEnabled;
  options.batteryless.hotkeyMask = 0x204;
  options.sram.flash1mBankSwitchStyle = flash1mBankSwitchStyle;
  if (patchMode === "custom-flash") options.customFlash.saveChipType = 1;

  const requestId = [
    "rtc",
    patchMode,
    flash1mBankSwitchStyle,
    persistenceEnabled ? "on" : "off",
    rtcTickMode,
    showMenuOnBoot ? "menu" : "skip-menu",
  ].join("-");
  const response = new Promise((resolve) => pendingResponses.set(requestId, resolve));
  const rom = syntheticRtcSramRom();
  workerMessageHandler({
    data: {
      protocolVersion: WORKER_PROTOCOL_VERSION,
      type: WORKER_MESSAGE_TYPE.PATCH_REQUEST,
      requestId,
      romId: requestId,
      outputFileName: `${requestId}.gba`,
      romBuffer: rom.buffer,
      saveBuffer: null,
      options,
    },
  });
  return response;
}

assert.equal(RTC_PAYLOAD_CONSTANTS.RTC_PERSIST_FLAG_MAPPER_CLEANUP, 1);
assert.equal(RTC_PAYLOAD_CONSTANTS.RTC_PERSIST_FLAG_VISOLY_MAPPER_CLEANUP, 4);
assert.equal(RTC_PAYLOAD_CONSTANTS.RTC_MENU_ON_BOOT_SKIP, 0);
assert.equal(RTC_PAYLOAD_CONSTANTS.RTC_MENU_ON_BOOT_SHOW, 1);
assert.equal(
  Object.hasOwn(RTC_PAYLOAD_CONSTANTS, "RTC_PERSIST_FLAG_CUSTOM_BACKEND"),
  false,
  "obsolete custom-backend ABI name must not remain generated",
);

const persistenceFlagCases = Object.freeze([
  { mode: "sram", style: "modern", flags: RTC_PERSISTENCE_MAPPER_CLEANUP_FLAG },
  { mode: "sram", style: "gbata", flags: 0 },
  { mode: "sram", style: "visoly", flags: RTC_PERSISTENCE_VISOLY_MAPPER_CLEANUP_FLAG },
  { mode: "flash512k", style: "modern", flags: 0 },
  {
    mode: "custom-flash",
    style: "gbata",
    flags: RTC_PERSISTENCE_MAPPER_CLEANUP_FLAG,
  },
  { mode: "none", style: "modern", flags: 0 },
  {
    mode: "batteryless-sram",
    style: "modern",
    flags: RTC_PERSISTENCE_MAPPER_CLEANUP_FLAG
      | RTC_PERSISTENCE_SHARED_SAVE_AREA_FLAG,
  },
  {
    mode: "batteryless-sram",
    style: "gbata",
    flags: RTC_PERSISTENCE_SHARED_SAVE_AREA_FLAG,
  },
  {
    mode: "batteryless-sram",
    style: "visoly",
    flags: RTC_PERSISTENCE_VISOLY_MAPPER_CLEANUP_FLAG
      | RTC_PERSISTENCE_SHARED_SAVE_AREA_FLAG,
  },
]);

for (const { mode, style, flags } of persistenceFlagCases) {
  const response = await patchMode(mode, true, style);
  assert.equal(response.type, WORKER_MESSAGE_TYPE.PATCH_COMPLETED, response.error?.message);
  const { result } = response;
  const label = `${mode}/${style}`;
  assert.equal(result.rtc.statusCode, "changed", `${mode}: Fake RTC`);
  assert.equal(result.rtc.showMenuOnBoot, true, `${mode}: boot menu shown by default`);
  assert.equal(result.irqHandler.statusCode, "changed", `${mode}: shared IRQ`);
  assert.equal(
    Object.hasOwn(result.irqHandler, "shortIrqHandler"),
    false,
    `${mode}: no host-selectable short IRQ contract`,
  );
  assert.ok(result.rtc.persistenceFlushEntry > 0, `${mode}: persistence flush entry`);
  assert.equal(result.rtc.persistence.size, 0x40000, `${mode}: persistence size`);
  assert.ok(
    !result.warnings.some((warning) => warning.includes("only available with Batteryless SRAM")),
    `${mode}: obsolete warning`,
  );
  assert.equal(
    result.rtc.persistence.flags,
    flags,
    `${label}: persistence mapper/shared flags`,
  );
  assert.equal(
    readU32(
      new Uint8Array(response.patchedBuffer),
      result.rtc.payloadOffset + RTC_PAYLOAD_CONSTANTS.RTC_MENU_ON_BOOT_CONFIG_OFFSET,
    ),
    RTC_PAYLOAD_CONSTANTS.RTC_MENU_ON_BOOT_SHOW,
    `${label}: embedded boot-menu default`,
  );
  assert.equal(
    readU32(
      new Uint8Array(response.patchedBuffer),
      result.rtc.payloadOffset + RTC_PAYLOAD_CONSTANTS.RTC_PERSIST_FLAGS_CONFIG_OFFSET,
    ),
    flags,
    `${label}: embedded persistence flags`,
  );

  if (mode === "batteryless-sram") {
    continue;
  }
  assert.ok(
    result.reservedRanges.some(([start, end]) => end - start === 0x40000),
    `${mode}: standalone persistence reserve`,
  );
  assert.equal(
    result.irqHandler.saveFlushEntry,
    result.rtc.persistenceFlushEntry,
    `${mode}: menu-close flush callback`,
  );
  assert.equal(result.irqHandler.saveFlushHotkey, true, `${mode}: menu-close flush enabled`);
  assert.equal(result.irqHandler.saveFlushAuto, false, `${mode}: no unrelated automatic flush`);
}

const skippedBootMenuResponse = await patchMode("sram", false, "modern", "read", false);
assert.equal(skippedBootMenuResponse.type, WORKER_MESSAGE_TYPE.PATCH_COMPLETED);
assert.equal(skippedBootMenuResponse.result.rtc.showMenuOnBoot, false);
assert.equal(
  readU32(
    new Uint8Array(skippedBootMenuResponse.patchedBuffer),
    skippedBootMenuResponse.result.rtc.payloadOffset
      + RTC_PAYLOAD_CONSTANTS.RTC_MENU_ON_BOOT_CONFIG_OFFSET,
  ),
  RTC_PAYLOAD_CONSTANTS.RTC_MENU_ON_BOOT_SKIP,
  "Skip must be written into the embedded RTC boot-menu configuration",
);

for (const style of ["modern", "gbata", "visoly"]) {
  const disabledResponse = await patchMode("sram", false, style);
  assert.equal(disabledResponse.type, WORKER_MESSAGE_TYPE.PATCH_COMPLETED);
  assert.equal(disabledResponse.result.rtc.persistence, null);
  assert.deepEqual(disabledResponse.result.reservedRanges ?? [], []);
  assert.equal(disabledResponse.result.irqHandler.saveFlushEntry, 0);
  assert.equal(disabledResponse.result.irqHandler.saveFlushHotkey, false);
  assert.equal(
    readU32(
      new Uint8Array(disabledResponse.patchedBuffer),
      disabledResponse.result.rtc.payloadOffset
        + RTC_PAYLOAD_CONSTANTS.RTC_PERSIST_FLAGS_CONFIG_OFFSET,
    ),
    0,
    `disabled ${style} persistence must not enable mapper cleanup`,
  );
}

const batterylessIrqResponse = await patchMode("batteryless-sram", true, "modern");
assert.equal(batterylessIrqResponse.type, WORKER_MESSAGE_TYPE.PATCH_COMPLETED);
assert.equal(batterylessIrqResponse.result.irqHandler.statusCode, "changed");
assert.equal(Object.hasOwn(batterylessIrqResponse.result.irqHandler, "shortIrqHandler"), false);
assert.equal(
  batterylessIrqResponse.result.irqHandler.handlerEntry,
  batterylessIrqResponse.result.irqHandler.runtimeBase
    + IRQ_HANDLER_CONSTANTS.IRQ_HANDLER_OFFSET,
);

const batterylessContinuousIrqResponse = await patchMode(
  "batteryless-sram",
  true,
  "modern",
  "vblank",
);
assert.equal(batterylessContinuousIrqResponse.type, WORKER_MESSAGE_TYPE.PATCH_COMPLETED);
assert.equal(batterylessContinuousIrqResponse.result.irqHandler.statusCode, "changed");
assert.equal(Object.hasOwn(batterylessContinuousIrqResponse.result.irqHandler, "shortIrqHandler"), false);
assert.equal(
  batterylessContinuousIrqResponse.result.irqHandler.handlerEntry,
  batterylessContinuousIrqResponse.result.irqHandler.runtimeBase
    + IRQ_HANDLER_CONSTANTS.IRQ_HANDLER_CONTINUOUS_OFFSET,
);

function writeU32(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = value >>> 24;
}

function writeHalfwords(bytes, offset, values) {
  values.forEach((value, index) => writeU16(bytes, offset + index * 2, value));
}

function thumbLiteralLoad(instructionOffset, register, literalOffset) {
  const pc = (instructionOffset + 4) & ~3;
  const displacement = literalOffset - pc;
  assert.equal(displacement & 3, 0, "Thumb literal displacement alignment");
  assert.ok(displacement >= 0 && displacement <= 0x3fc, "Thumb literal displacement range");
  return 0x4800 | (register << 8) | (displacement >>> 2);
}

function writeThumbBl(bytes, instructionOffset, targetOffset) {
  const displacement = targetOffset - (instructionOffset + 4);
  assert.equal(displacement & 1, 0, "Thumb BL target alignment");
  assert.ok(displacement >= -0x400000 && displacement < 0x400000, "Thumb BL target range");
  const encoded = displacement & 0x7fffff;
  writeU16(bytes, instructionOffset, 0xf000 | ((encoded >>> 12) & 0x7ff));
  writeU16(bytes, instructionOffset + 2, 0xf800 | ((encoded >>> 1) & 0x7ff));
}

function writeZodiacCluster(bytes, rawOptions) {
  const options = typeof rawOptions === "number"
    ? { orchestratorOffset: rawOptions }
    : rawOptions;
  const {
    orchestratorOffset,
    probeOffset,
    rawTimeOffset,
    setupOffset,
    writeHelperOffset,
    readHelperOffset,
    statusAddress,
    availableAddress,
    pointerCopyInstruction = 0x1c06,
  } = options;
  const rawBufferAddress = availableAddress + 1;
  const probeLiteral = (probeOffset + 0x23) & ~3;
  const rawLiteral = (rawTimeOffset + 0x83) & ~3;
  const setupLiteral = (setupOffset + 0x83) & ~3;

  // Independent concrete Zodiac/Wizard-style fixture. It deliberately uses
  // actual instructions and values instead of importing production patterns.
  writeU16(bytes, orchestratorOffset, 0xb500);
  writeThumbBl(bytes, orchestratorOffset + 2, probeOffset);
  writeHalfwords(bytes, orchestratorOffset + 6, [0x2800, 0xd101]);
  writeThumbBl(bytes, orchestratorOffset + 10, setupOffset);
  writeHalfwords(bytes, probeOffset, [
    thumbLiteralLoad(probeOffset, 0, probeLiteral),
    0x6800, 0x2800, 0xd000, 0x2001, 0x4770,
  ]);
  writeHalfwords(bytes, rawTimeOffset, [
    0xb570,
    pointerCopyInstruction,
    thumbLiteralLoad(rawTimeOffset + 4, 1, rawLiteral),
    0x2201,
    0x800a,
    thumbLiteralLoad(rawTimeOffset + 10, 5, rawLiteral + 4),
    0x2007, 0x8028, 0x800a, 0x2405, 0x800c, 0x2065,
  ]);
  writeThumbBl(bytes, rawTimeOffset + 24, writeHelperOffset);
  writeHalfwords(bytes, rawTimeOffset + 28, [0x802c, 0x1c34, 0x2503]);
  writeThumbBl(bytes, rawTimeOffset + 34, readHelperOffset);
  writeHalfwords(bytes, rawTimeOffset + 38, [0x7020, 0x3401]);
  writeThumbBl(bytes, rawTimeOffset + 42, readHelperOffset);
  writeHalfwords(bytes, rawTimeOffset + 46, [0x7020, 0x3401]);
  writeThumbBl(bytes, rawTimeOffset + 50, readHelperOffset);
  writeHalfwords(bytes, rawTimeOffset + 54, [0x7020, 0x2000, 0xbc70, 0xbc02, 0x4708]);

  writeHalfwords(bytes, setupOffset, [
    0xb530,
    thumbLiteralLoad(setupOffset + 2, 0, setupLiteral),
    0x2101, 0x8001, 0x3804, 0x8001, 0x2505, 0x8005,
    thumbLiteralLoad(setupOffset + 16, 4, setupLiteral + 4),
    0x2007, 0x8020, 0x2063,
  ]);
  writeThumbBl(bytes, setupOffset + 24, writeHelperOffset);
  writeU16(bytes, setupOffset + 28, 0x8025);
  writeThumbBl(bytes, setupOffset + 30, readHelperOffset);
  writeU16(bytes, setupOffset + 34, thumbLiteralLoad(setupOffset + 34, 1, setupLiteral + 8));
  writeU16(bytes, setupOffset + 36, 0x6008);
  writeThumbBl(bytes, setupOffset + 38, probeOffset);
  writeU16(bytes, setupOffset + 42, thumbLiteralLoad(setupOffset + 42, 1, setupLiteral + 12));
  writeU16(bytes, setupOffset + 44, 0x6008);
  writeU16(bytes, setupOffset + 46, thumbLiteralLoad(setupOffset + 46, 0, setupLiteral + 16));
  writeThumbBl(bytes, setupOffset + 48, rawTimeOffset);
  writeHalfwords(bytes, setupOffset + 52, [0x2000, 0xbc30, 0xbc02, 0x4708]);

  writeU16(bytes, writeHelperOffset, 0x4770);
  writeU16(bytes, readHelperOffset, 0x4770);

  writeU32(bytes, probeLiteral, statusAddress);
  writeU32(bytes, rawLiteral, 0x080000c4);
  writeU32(bytes, rawLiteral + 4, 0x080000c6);
  writeU32(bytes, setupLiteral, 0x080000c8);
  writeU32(bytes, setupLiteral + 4, 0x080000c6);
  writeU32(bytes, setupLiteral + 8, statusAddress);
  writeU32(bytes, setupLiteral + 12, availableAddress);
  writeU32(bytes, setupLiteral + 16, rawBufferAddress);
  return { ...options, rawBufferAddress };
}

const ZODIAC_VARIANT_A = Object.freeze({
  orchestratorOffset: 0x1000,
  probeOffset: 0x10c4,
  rawTimeOffset: 0x1200,
  setupOffset: 0x1500,
  writeHelperOffset: 0x1800,
  readHelperOffset: 0x1840,
  statusAddress: 0x03005547,
  availableAddress: 0x03005504,
});

const ZODIAC_VARIANT_B = Object.freeze({
  orchestratorOffset: 0x6202,
  probeOffset: 0x65a2,
  rawTimeOffset: 0x6d42,
  setupOffset: 0x7242,
  writeHelperOffset: 0x7802,
  readHelperOffset: 0x79c2,
  statusAddress: 0x0203f127,
  availableAddress: 0x0203f080,
  pointerCopyInstruction: 0x4606,
});

function syntheticZodiacRom(variants = [ZODIAC_VARIANT_A]) {
  const bytes = new Uint8Array(0x40000);
  return {
    bytes,
    clusters: variants.map((variant) => writeZodiacCluster(bytes, variant)),
  };
}

function applyZodiacFixture(bytes) {
  const rom = { bytes: new Uint8Array(bytes) };
  const operations = [];
  const warnings = [];
  const rtc = applyRtcForPipeline(
    rom,
    operations,
    warnings,
    { enabled: true, tickMode: "read", saveOnGlobalHotkey: false },
    { payloadOffset: 0x20000 },
  );
  return { rom, operations, warnings, rtc };
}

function assertJumpHook(bytes, handler) {
  const literalOffset = (handler.offset & 3) === 0 ? 4 : 6;
  assert.deepEqual(
    [...bytes.slice(handler.offset, handler.offset + 4)],
    [literalOffset === 4 ? 0x00 : 0x01, 0x4b, 0x18, 0x47],
  );
  if (literalOffset === 6) {
    assert.deepEqual([...bytes.slice(handler.offset + 4, handler.offset + 6)], [0xc0, 0x46]);
  }
  assert.equal(readU32(bytes, handler.offset + literalOffset), (handler.target | 1) >>> 0);
  for (let offset = literalOffset + 4; offset < handler.size; offset += 2) {
    assert.deepEqual([...bytes.slice(handler.offset + offset, handler.offset + offset + 2)], [0xc0, 0x46]);
  }
}

const zodiacFixture = syntheticZodiacRom();
assert.equal(hasRecognizedRtcHandlerSet(zodiacFixture.bytes), true);
const zodiacPatched = applyZodiacFixture(zodiacFixture.bytes);
assert.equal(zodiacPatched.rtc.status, "patched");
assert.equal(zodiacPatched.rtc.handlerFamily, "zodiac-wizard");
assert.equal(zodiacPatched.warnings.length, 0);
assert.deepEqual(
  zodiacPatched.rtc.handlers.map(({ name, offset, size }) => ({ name, offset, size })),
  [
    { name: "probe", offset: zodiacFixture.clusters[0].probeOffset, size: 0x0c },
    { name: "gettimedate", offset: zodiacFixture.clusters[0].rawTimeOffset, size: 0x0c },
  ],
);
const symbolBase = RTC_PAYLOAD_CONSTANTS.RTC_ORIGINAL_PAYLOAD_LINK_ADDR;
function assertZodiacPayloadConfiguration(patched, cluster) {
  const symbols = RTC_PAYLOAD_CONSTANTS.RTC_ORIGINAL_PAYLOAD_SYMBOLS;
  const availableConfigOffset = symbols.payload_zodiac_available_address_config - symbolBase;
  const statusConfigOffset = symbols.payload_zodiac_status_address_config - symbolBase;
  assert.equal(
    readU32(patched.rom.bytes, patched.rtc.payloadOffset + availableConfigOffset),
    cluster.availableAddress,
  );
  assert.equal(
    readU32(patched.rom.bytes, patched.rtc.payloadOffset + statusConfigOffset),
    cluster.statusAddress,
  );
}

assert.equal(
  zodiacPatched.rtc.handlers[0].target,
  zodiacPatched.rtc.runtimeBase
    + RTC_PAYLOAD_CONSTANTS.RTC_ORIGINAL_PAYLOAD_SYMBOLS.payload_zodiac_probe
    - symbolBase,
);
assert.equal(
  zodiacPatched.rtc.handlers[1].target,
  zodiacPatched.rtc.runtimeBase
    + RTC_PAYLOAD_CONSTANTS.RTC_ORIGINAL_PAYLOAD_SYMBOLS.payload_zodiac_gettimedate
    - symbolBase,
);
zodiacPatched.rtc.handlers.forEach((handler) => assertJumpHook(zodiacPatched.rom.bytes, handler));
assertZodiacPayloadConfiguration(zodiacPatched, zodiacFixture.clusters[0]);

// Same RTC ABI, but deliberately different function spacing, halfword-only
// entry alignment, and EWRAM state. Recognition and payload configuration must
// remain entirely content-driven.
const shiftedZodiacFixture = syntheticZodiacRom([ZODIAC_VARIANT_B]);
assert.equal(hasRecognizedRtcHandlerSet(shiftedZodiacFixture.bytes), true);
const shiftedZodiacPatched = applyZodiacFixture(shiftedZodiacFixture.bytes);
assert.equal(shiftedZodiacPatched.rtc.status, "patched");
assert.equal(shiftedZodiacPatched.rtc.handlerFamily, "zodiac-wizard");
assert.deepEqual(
  shiftedZodiacPatched.rtc.handlers.map(({ name, offset, size }) => ({ name, offset, size })),
  [
    { name: "probe", offset: ZODIAC_VARIANT_B.probeOffset, size: 0x0c },
    { name: "gettimedate", offset: ZODIAC_VARIANT_B.rawTimeOffset, size: 0x0c },
  ],
);
shiftedZodiacPatched.rtc.handlers.forEach(
  (handler) => assertJumpHook(shiftedZodiacPatched.rom.bytes, handler),
);
assertZodiacPayloadConfiguration(shiftedZodiacPatched, shiftedZodiacFixture.clusters[0]);

const zodiacMutated = new Uint8Array(zodiacFixture.bytes);
writeU16(zodiacMutated, zodiacFixture.clusters[0].rawTimeOffset + 22, 0x2064);
assert.equal(hasRecognizedRtcHandlerSet(zodiacMutated), false);
const failedMutation = applyZodiacFixture(zodiacMutated);
assert.equal(failedMutation.rtc.status, "failed");
assert.equal(failedMutation.operations.length, 0);
assert.deepEqual(failedMutation.rom.bytes, zodiacMutated);

const zodiacDuplicate = syntheticZodiacRom([ZODIAC_VARIANT_A, ZODIAC_VARIANT_B]);
assert.equal(hasRecognizedRtcHandlerSet(zodiacDuplicate.bytes), false);
const failedDuplicate = applyZodiacFixture(zodiacDuplicate.bytes);
assert.equal(failedDuplicate.rtc.status, "failed");
assert.equal(failedDuplicate.operations.length, 0);
assert.deepEqual(failedDuplicate.rom.bytes, zodiacDuplicate.bytes);
assert.ok(failedDuplicate.warnings.some((warning) => warning.includes("found 2")));

const ambiguousFamilies = syntheticRtcSramRom();
writeZodiacCluster(ambiguousFamilies, ZODIAC_VARIANT_B);
assert.equal(hasRecognizedRtcHandlerSet(ambiguousFamilies), false);
const failedAmbiguousFamilies = applyZodiacFixture(ambiguousFamilies);
assert.equal(failedAmbiguousFamilies.rtc.status, "failed");
assert.equal(failedAmbiguousFamilies.operations.length, 0);
assert.deepEqual(failedAmbiguousFamilies.rom.bytes, ambiguousFamilies);
assert.ok(failedAmbiguousFamilies.warnings.some((warning) => warning.includes("ambiguous")));

assert.equal(
  hasRecognizedRtcHandlerSet(zodiacFixture.bytes, [[
    zodiacFixture.clusters[0].probeOffset,
    zodiacFixture.clusters[0].probeOffset + 4,
  ]]),
  false,
);

console.log("Fake RTC persistence and handler families: PASS");
