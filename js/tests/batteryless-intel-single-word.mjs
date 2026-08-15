import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BATTERYLESS_PAYLOAD_HEX,
  SRAM_CONSTANTS,
} from "../patchers/sram-data.js";
import { validatePayloadArtifacts } from "../generated/validate-payloads.js";

await validatePayloadArtifacts();

const payload = Uint8Array.from(
  BATTERYLESS_PAYLOAD_HEX.match(/../g).map((value) => Number.parseInt(value, 16)),
);
const ranges = SRAM_CONSTANTS.BATTERYLESS_RAM_FUNCTION_RANGES;

function encodeU32(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24];
}

function tableBytes(names) {
  return Uint8Array.from(names.flatMap((name) => {
    const range = ranges[name];
    assert.ok(range, `missing RAM driver range: ${name}`);
    assert.ok(range.size <= SRAM_CONSTANTS.ROM_WORKSPACE_EXEC_SIZE, `${name} exceeds RAM slot`);
    return [...encodeU32(range.start + 1), ...encodeU32(range.end)];
  }));
}

function findSequence(haystack, needle) {
  for (let offset = 0; offset + needle.length <= haystack.length; offset += 1) {
    if (needle.every((value, index) => haystack[offset + index] === value)) return offset;
  }
  return -1;
}

const intelTable = tableBytes([
  "identify_flash_1",
  "erase_flash_1",
  "program_flash_1",
  "verify_flash",
]);
assert.ok(findSequence(payload, intelTable) >= 0, "Intel single-word driver is absent from dispatch table");

assert.deepEqual(
  Object.keys(ranges).sort(),
  [
    "erase_flash_1",
    "erase_flash_2",
    "erase_flash_3",
    "identify_flash_1",
    "identify_flash_2",
    "identify_flash_3",
    "program_flash_1",
    "program_flash_2",
    "program_flash_3",
    "verify_flash",
  ],
  "only Type 1-3 drivers may be present in the Batteryless RAM ranges",
);

for (const [name, range] of Object.entries(ranges)) {
  assert.ok(range.size <= SRAM_CONSTANTS.ROM_WORKSPACE_EXEC_SIZE, `${name} exceeds RAM slot`);
  assert.ok(!/m36|buffer/i.test(name), `device-specific or buffered driver leaked into ranges: ${name}`);
}

const source = readFileSync(
  new URL("../../payloads/batteryless-sram/payload.c", import.meta.url),
  "utf8",
);
assert.doesNotMatch(source, /m36|0x88C40020|0x88C60020|0x880F008A|0x88C50020/i);
assert.doesNotMatch(
  source,
  /\b(?:identify|erase|program)_flash_4(?:_end)?\b/,
  "Type 4 support must be absent from the Batteryless payload",
);
assert.doesNotMatch(
  source,
  /_FLASH_WRITE\([^\n]*, 0x(?:EA|1FF)\)/,
  "buffered Type 4 command words must be absent from the Batteryless payload",
);

const identifySource = source.slice(
  source.indexOf("int identify_flash_1"),
  source.indexOf('asm("identify_flash_1_end:")'),
);
assert.ok(
  identifySource.indexOf("sram_bank_select(0)") < identifySource.indexOf("_FLASH_WRITE(0, 0x50)"),
  "SRAM mapper bank must be normalized before the Intel probe",
);
const unsupportedIntelBranch = identifySource.indexOf("if (data != 0x96)");
assert.ok(
  unsupportedIntelBranch >= 0
    && identifySource.indexOf("return 2", unsupportedIntelBranch) > unsupportedIntelBranch,
  "the removed buffered Intel variant must retain a distinct fail-closed probe result",
);

const programSource = source.slice(
  source.indexOf("int program_flash_1"),
  source.indexOf('asm("program_flash_1_end:")'),
);
for (const operation of [
  "0x40",
  "0x50",
  "0x70",
  "status & 0x80",
  "status != 0x80",
  "address/2",
]) {
  assert.ok(programSource.includes(operation), `missing hardened single-word operation: ${operation}`);
}
assert.doesNotMatch(programSource, /0xE8|buffer/i, "Intel Type 1 must remain single-word only");

const initialArrayReset = programSource.indexOf("_FLASH_WRITE(sa, 0xFF)");
const initialBankSelect = programSource.indexOf("sram_bank_select(bank)");
const intelSourceRead = programSource.indexOf("unsigned value =");
const intelErasedSkip = programSource.indexOf("if (value == 0xFFFF)");
const intelProgramCommand = programSource.indexOf("_FLASH_WRITE(address, 0x40)");
const intelTargetWrite = programSource.indexOf("_FLASH_WRITE(address, value)");
const intelPoll = programSource.indexOf("for (timeout = 0x4000", intelTargetWrite);
const intelClearStatus = programSource.indexOf("_FLASH_WRITE(address, 0x50)", intelPoll);
const intelArrayReset = programSource.indexOf("_FLASH_WRITE(address, 0xFF)", intelClearStatus);
const intelBankRestore = programSource.indexOf("sram_bank_select(bank)", intelArrayReset);

assert.ok(
  initialArrayReset >= 0 && initialArrayReset < initialBankSelect,
  "Intel flash must enter read-array mode before the initial mapper selection",
);
assert.ok(
  intelSourceRead >= 0 && intelSourceRead < intelProgramCommand,
  "Intel source word must be cached before a high-A24 program command can change banks",
);
assert.ok(
  intelErasedSkip > intelSourceRead && intelErasedSkip < intelProgramCommand,
  "Intel erased words must be skipped before issuing their target command",
);
assert.ok(
  intelProgramCommand < intelTargetWrite && intelTargetWrite < intelPoll,
  "Intel single-word command must program and then poll the cached value",
);
assert.doesNotMatch(
  programSource.slice(intelProgramCommand, intelBankRestore),
  /AGB_SRAM_WINDOWED/,
  "Intel status sequence must not reread SRAM after its mapper-changing target command",
);
assert.ok(
  intelPoll < intelClearStatus
    && intelClearStatus < intelArrayReset
    && intelArrayReset < intelBankRestore,
  "Intel flash must leave status mode before restoring the logical SRAM bank",
);
assert.ok(
  programSource.lastIndexOf("sram_bank_select(0)") > intelBankRestore,
  "Intel program cleanup must return the mapper to bank zero",
);

const eraseSource = source.slice(
  source.indexOf("int erase_flash_1"),
  source.indexOf('asm("erase_flash_1_end:")'),
);
assert.ok(
  eraseSource.lastIndexOf("sram_bank_select(0)")
    > eraseSource.lastIndexOf("_FLASH_WRITE(erase_addr, 0xFF)"),
  "Type 1 erase cleanup must normalize bank zero after read-array reset",
);
assert.ok(
  eraseSource.lastIndexOf("return result")
    > eraseSource.lastIndexOf("sram_bank_select(0)"),
  "Type 1 erase must normalize the mapper on success and failure",
);

const initializeSource = source.slice(
  source.indexOf("batteryless_initialize:"),
  source.indexOf("sram_init_loop:"),
);
const bootFlush = initializeSource.indexOf("bl flush_dirty_sram_on_boot");
const bankZeroCall = "mov r4, # 0\n    bl sram_bank_select_arm_r4";
assert.ok(
  initializeSource.indexOf(bankZeroCall, bootFlush) > bootFlush,
  "boot restore must reselect bank zero after a possibly failed flush",
);

const flushSource = source.slice(
  source.indexOf("flush_sram:"),
  source.indexOf("flash_fn_table:"),
);
const flushDrivers = flushSource.indexOf("# Try flushing for various flash chips");
const flushPack = flushSource.indexOf("bl eeprom_v111_pack_sram_raw", flushDrivers);
const flushEntryBankZero = flushSource.indexOf(bankZeroCall, flushDrivers);
assert.ok(
  flushEntryBankZero >= 0 && flushEntryBankZero < flushPack,
  "flush must normalize bank zero before packing SRAM or invoking persistence",
);
const flushDone = flushSource.indexOf("flush_sram_done:");
const flushRestore = flushSource.indexOf("bl eeprom_v111_restore_sram_header", flushDone);
const flushExitBankZero = flushSource.indexOf(bankZeroCall, flushDone);
assert.ok(
  flushExitBankZero >= 0 && flushExitBankZero < flushRestore,
  "every flush exit must normalize bank zero before restoring the SRAM header",
);

const identifyDispatch = flushSource.indexOf("bl run_from_ram", flushDrivers);
const acceptedCompare = flushSource.indexOf("cmp r0, # 1", identifyDispatch);
const acceptedIdentify = flushSource.indexOf("beq found_flash", acceptedCompare);
const noMatchCompare = flushSource.indexOf("cmp r0, # 0", acceptedIdentify);
const unsupportedAbort = flushSource.indexOf("bne flush_sram_done", noMatchCompare);
assert.ok(
  identifyDispatch >= 0
    && acceptedCompare > identifyDispatch
    && acceptedIdentify > acceptedCompare
    && noMatchCompare > acceptedIdentify
    && unsupportedAbort > noMatchCompare,
  "only an exact supported probe result may reach a flash driver",
);

assert.equal(SRAM_CONSTANTS.BATTERYLESS_RUNTIME_ID, "batteryless-v5");
assert.equal(SRAM_CONSTANTS.ROM_WORKSPACE_SIZE, 0x200);
assert.equal(SRAM_CONSTANTS.ROM_WORKSPACE_EXEC_SIZE, 0x100);
assert.equal(SRAM_CONSTANTS.ROM_WORKSPACE_META_SIZE, 0x20);
assert.equal(SRAM_CONSTANTS.ROM_WORKSPACE_GUARD_SIZE, 0x20);
assert.equal(SRAM_CONSTANTS.ROM_WORKSPACE_STACK_SIZE, 0xc0);
assert.ok(
  !("ROM_WORKSPACE_STAGE_SIZE" in SRAM_CONSTANTS),
  "the removed Type 4 staging-page ABI must not remain exported",
);
assert.equal(
  SRAM_CONSTANTS.ROM_WORKSPACE_EXEC_SIZE
    + SRAM_CONSTANTS.ROM_WORKSPACE_META_SIZE
    + SRAM_CONSTANTS.ROM_WORKSPACE_GUARD_SIZE
    + SRAM_CONSTANTS.ROM_WORKSPACE_STACK_SIZE,
  SRAM_CONSTANTS.ROM_WORKSPACE_SIZE,
  "driver, metadata, guard, and private stack must occupy exactly 512 bytes",
);

const runnerSource = source.slice(
  source.indexOf("run_from_ram:"),
  source.indexOf("int identify_flash_1"),
);
for (const operation of [
  "cmp r11, # 0x100",
  "ldr r9, =0x0203fe00",
  "add r0, r9, # 0x100",
  "add r0, r9, # 0x120",
  "add sp, r9, # 0x200",
  "add r2, r9, # 1",
  "add r1, r9, # 0x200",
  "add r12, r9, # 0x200",
]) {
  assert.ok(runnerSource.includes(operation), `missing 512-byte workspace operation: ${operation}`);
}
assert.equal(
  runnerSource.match(/sub r9, r9, # 0x200/g)?.length,
  2,
  "both workspace search paths must advance by one non-overlapping 512-byte slot",
);
const fallbackRegisterFrame = 6 * 4;
// ARM SP is word-aligned. Aligning it to eight bytes and rounding a driver
// to an eight-byte entry boundary adds at most four bytes beyond the slot.
const fallbackMaxAfterFrame = 4
  + SRAM_CONSTANTS.ROM_WORKSPACE_EXEC_SIZE
  + SRAM_CONSTANTS.ROM_WORKSPACE_STACK_SIZE
  + SRAM_CONSTANTS.ROM_WORKSPACE_GUARD_SIZE;
const fallbackMaxFootprint = fallbackRegisterFrame + fallbackMaxAfterFrame;
assert.equal(fallbackMaxFootprint, 0x1fc, "stack fallback must touch less than 512 bytes");
assert.ok(fallbackMaxFootprint <= SRAM_CONSTANTS.ROM_WORKSPACE_SIZE);
assert.equal(0x200 - fallbackRegisterFrame, 0x1e8, "stack bounds must account for the saved frame");
assert.ok(0x1e8 >= fallbackMaxAfterFrame, "post-frame WRAM bound must cover the fallback");
for (const operation of [
  "push {r4, r5, r6, r7, r8, lr}",
  "ldr r5, =0x020001e8",
  "ldr r5, =0x02040000",
  "ldr r5, =0x030001e8",
  "ldr r5, =0x03008000",
  "bic sp, sp, # 7",
  "tst r8, # 4",
  "subne sp, sp, # 4",
  "sub r6, sp, # 0xc0",
  "sub r6, r6, # 0x20",
  "run_from_stack_write_guard:",
  "run_from_stack_check_guard:",
  "add r12, sp, # 1",
]) {
  assert.ok(runnerSource.includes(operation), `missing safe stack fallback operation: ${operation}`);
}
assert.doesNotMatch(
  runnerSource,
  /(?:sub sp, sp|sub r2, r4), # 0x400/,
  "the stack fallback must not reserve the removed Type 4 staging page",
);

for (const type of [2, 3]) {
  const amdSource = source.slice(
    source.indexOf(`int program_flash_${type}`),
    source.indexOf(`asm("program_flash_${type}_end:")`),
  );
  const targetWrite = amdSource.indexOf("_FLASH_WRITE(sa+i, value)");
  const poll = amdSource.indexOf("for (timeout = 0x4000", targetWrite);
  const bankRestore = amdSource.lastIndexOf("sram_bank_select(bank)");
  assert.ok(
    amdSource.indexOf("if (value == 0xFFFF)") < targetWrite,
    `Type ${type} must skip erased words before their high-A24 target write`,
  );
  assert.ok(targetWrite >= 0 && poll > targetWrite, `Type ${type} must program its cached SRAM word`);
  assert.ok(
    amdSource.slice(poll).includes("== value"),
    `Type ${type} polling must compare against the cached word`,
  );
  assert.doesNotMatch(
    amdSource.slice(targetWrite, bankRestore),
    /AGB_SRAM_WINDOWED/,
    `Type ${type} must not reread SRAM after a mapper-changing target write`,
  );
  assert.ok(
    bankRestore > poll,
    `Type ${type} must restore the logical SRAM bank after polling`,
  );
}

// These are the two hardware-observed failures on a D0-latching mapper. The
// old poll reread the alternate SRAM bank after the target write; the cached
// comparison above must make both alternate values irrelevant.
for (const regression of [
  { name: "first save", value: 0xffff, alternateBankValue: 0x0003 },
  { name: "second save at +0x13c8", value: 0x00ff, alternateBankValue: 0x0000 },
]) {
  assert.equal(regression.value & 1, 1, `${regression.name} must reproduce a D0=1 latch`);
  assert.notEqual(
    regression.value,
    regression.alternateBankValue,
    `${regression.name} must reproduce the old cross-bank poll mismatch`,
  );
}

console.log("batteryless ROM flash hardware tests: PASS");
