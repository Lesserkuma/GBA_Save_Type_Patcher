// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";

import { patchSramBytes } from "../patchers/sram.js";
import {
  FLASH1M_BANK_SWITCH_MODERN_PATCH_HEX,
  PATCH_BY_SAVE_TYPE,
} from "../patchers/sram-data.js";

const modernPatch = Buffer.from(FLASH1M_BANK_SWITCH_MODERN_PATCH_HEX, "hex");
const switchMarker = Buffer.from(
  PATCH_BY_SAVE_TYPE.FLASH1M_V103.steps[0].identifier.marker,
  "hex",
);

// The 24-byte SDK routine prepares the mapper address, copies its eight-byte
// write/settling/return tail to the stack, restores SP, and enters that even
// RAM address without changing the current Thumb state. LR remains untouched,
// so the RAM tail's BX LR interworks back to either an ARM caller (bit 0 clear)
// or a Thumb caller (bit 0 set).
assert.equal(modernPatch.length, 24);
assert.equal(modernPatch.readUInt16LE(0), 0xa103); // adr r1, RAM tail
assert.equal(modernPatch.readUInt16LE(2), 0xc90c); // ldmia r1!, {r2, r3}
assert.equal(modernPatch.readUInt16LE(4), 0xb40c); // push {r2, r3}
assert.equal(modernPatch.readUInt16LE(6), 0x2290); // mov r2, #0x90
assert.equal(modernPatch.readUInt16LE(8), 0x0512); // lsl r2, #20
assert.equal(modernPatch.readUInt16LE(10), 0x4669); // mov r1, sp
assert.equal(modernPatch.readUInt16LE(12), 0xb002); // add sp, #8
// MOV pc keeps the current Thumb state for the even, word-aligned stack
// address. BX would interpret its clear bit 0 as an ARM-state target.
assert.equal(modernPatch.readUInt16LE(14), 0x468f); // mov pc, r1
assert.equal(modernPatch.readUInt16LE(16), 0x7010); // RAM: strb r0, [r2]
assert.equal(modernPatch.readUInt16LE(18), 0x46c0); // RAM: nop
assert.equal(modernPatch.readUInt16LE(20), 0x46c0); // RAM: nop
assert.equal(modernPatch.readUInt16LE(22), 0x4770); // RAM: bx lr

const returnState = (lr) => (lr & 1 ? "thumb" : "arm");
assert.equal(returnState(0x08001234), "arm");
assert.equal(returnState(0x08001235), "thumb");

const markerOffset = 0x100;
const input = new Uint8Array(0x2000).fill(0xff);
PATCH_BY_SAVE_TYPE.FLASH1M_V103.steps.forEach((step, index) => {
  const marker = Buffer.from(step.identifier.marker, "hex");
  input.set(marker, markerOffset + index * 0x200);
});
const patched = patchSramBytes(input, {
  saveTypeOverride: "FLASH1M_V103",
  flash1mBankSwitchStyle: "modern",
});

assert.equal(patched.result.savePatch.status, "patched");
assert.deepEqual(
  Buffer.from(patched.bytes.slice(markerOffset, markerOffset + modernPatch.length)),
  modernPatch,
);

function installIdentifier(bytes, identifier, base) {
  if (identifier.marker) {
    bytes.set(Buffer.from(identifier.marker, "hex"), base);
    return;
  }
  for (const [relative, value] of identifier.checks) bytes[base + relative] = value;
}

// A recognizable read routine without its required write partner must be a
// completely atomic failure. This includes Batteryless mode, where layout
// planning could otherwise pad the ROM before discovering the missing hook.
const atomicPatchInfo = PATCH_BY_SAVE_TYPE.EEPROM_V120;
assert.equal(atomicPatchInfo.type, "simple");
assert.ok(atomicPatchInfo.steps.length >= 2);
for (const batteryless of [false, true]) {
  const partial = new Uint8Array(0x41003).fill(0xff);
  installIdentifier(partial, atomicPatchInfo.steps[0].identifier, 0x200);
  const before = new Uint8Array(partial);
  const result = patchSramBytes(partial, {
    saveTypeOverride: "EEPROM_V120",
    batteryless,
    batterylessMode: "auto",
  });
  assert.deepEqual(result.bytes, before);
  assert.deepEqual(result.result.operations, []);
  assert.equal(result.result.savePatch.status, "failed");
  assert.equal(result.result.savePatch.reasonCode, "INCOMPLETE_HOOK_SET");
  if (batteryless) {
    assert.equal(result.result.batteryless.status, "failed");
    assert.equal(result.result.batteryless.reasonCode, "INCOMPLETE_HOOK_SET");
  }
}

// Every expected rejection is fail-atomic, not only an incomplete SDK set.
const unsupported = new Uint8Array(0x1003).fill(0x5a);
const unsupportedBefore = new Uint8Array(unsupported);
const unsupportedResult = patchSramBytes(unsupported, {
  saveTypeOverride: "FLASH_V999",
});
assert.deepEqual(unsupportedResult.bytes, unsupportedBefore);
assert.deepEqual(unsupportedResult.result.operations, []);
assert.equal(unsupportedResult.result.savePatch.reasonCode, "UNSUPPORTED_SAVE_TYPE");

const noWriter = new Uint8Array(0x41003).fill(0xff);
new DataView(noWriter.buffer).setUint32(0, 0xea00002e, true);
const noWriterBefore = new Uint8Array(noWriter);
const noWriterResult = patchSramBytes(noWriter, {
  saveTypeOverride: "SRAM_V110",
  batteryless: true,
  batterylessMode: "auto",
});
assert.deepEqual(noWriterResult.bytes, noWriterBefore);
assert.deepEqual(noWriterResult.result.operations, []);
assert.equal(noWriterResult.result.batteryless.reasonCode, "SAVE_WRITE_ROUTINE_UNPROVEN");

const fullRom = new Uint8Array(0x2000000).fill(0x5a);
atomicPatchInfo.steps.forEach((step, index) => {
  installIdentifier(fullRom, step.identifier, 0x200 + index * 0x400);
});
const fullRomBefore = new Uint8Array(fullRom);
const capacityResult = patchSramBytes(fullRom, {
  saveTypeOverride: "EEPROM_V120",
  batteryless: true,
  batterylessMode: "auto",
});
assert.deepEqual(capacityResult.bytes, fullRomBefore);
assert.deepEqual(capacityResult.result.operations, []);
assert.equal(capacityResult.result.batteryless.reasonCode, "ROM_CAPACITY");

const complete = new Uint8Array(0x2000).fill(0xff);
atomicPatchInfo.steps.forEach((step, index) => {
  installIdentifier(complete, step.identifier, 0x200 + index * 0x400);
});
const completeResult = patchSramBytes(complete, {
  saveTypeOverride: "EEPROM_V120",
});
assert.equal(completeResult.result.savePatch.status, "patched");
assert.ok(completeResult.result.operations.length > 0);

// The early 512-Kibit FLASH libraries select the structurally present BFD4
// descriptor. Their inactive AT29LV512 path is neither selected nor patched.
const earlyFlashOffsets = [0x200, 0x800, 0x1000];
const atmelProgramOffset = 0x1800;
const atmelProgram = Buffer.from(
  "80b594b06f467960391c0880381c01880f2903d9",
  "hex",
);
for (const saveType of ["FLASH_V120", "FLASH_V121"]) {
  const patchInfo = PATCH_BY_SAVE_TYPE[saveType];
  assert.equal(patchInfo.type, "simple");
  assert.equal(patchInfo.steps.length, 3);
  for (const step of patchInfo.steps) assert.match(step.name, /BFD4/);

  const earlyFlash = new Uint8Array(0x3000).fill(0xff);
  patchInfo.steps.forEach((step, index) => {
    installIdentifier(earlyFlash, step.identifier, earlyFlashOffsets[index]);
  });
  earlyFlash.set(atmelProgram, atmelProgramOffset);
  const atmelBefore = earlyFlash.slice(
    atmelProgramOffset,
    atmelProgramOffset + atmelProgram.length,
  );

  const converted = patchSramBytes(earlyFlash, { saveTypeOverride: saveType });
  assert.equal(converted.result.savePatch.status, "patched", saveType);
  const saveOperations = converted.result.operations.filter(
    (operation) => operation.component === "saveType",
  );
  assert.deepEqual(
    saveOperations.map((operation) => operation.metadata.name),
    patchInfo.steps.map((step) => step.name),
  );
  assert.ok(saveOperations.every((operation) => operation.metadata.name.includes("BFD4")));
  patchInfo.steps.forEach((step, index) => {
    const expected = Buffer.from(step.writes[0].hex, "hex");
    assert.deepEqual(
      Buffer.from(converted.bytes.slice(
        earlyFlashOffsets[index],
        earlyFlashOffsets[index] + expected.length,
      )),
      expected,
      `${saveType}: ${step.name}`,
    );
  });
  assert.deepEqual(
    converted.bytes.slice(atmelProgramOffset, atmelProgramOffset + atmelBefore.length),
    atmelBefore,
  );
  assert.deepEqual(
    Buffer.from(patchInfo.steps[0].writes[0].hex, "hex"),
    Buffer.from("00b5d4200002bf21084302bc0847", "hex"),
  );

  // The read-ID routine plus an inactive Atmel routine is not a complete BFD4
  // hook set; failure remains typed and byte-for-byte atomic.
  const partial = new Uint8Array(0x3000).fill(0xff);
  installIdentifier(partial, patchInfo.steps[0].identifier, earlyFlashOffsets[0]);
  partial.set(atmelProgram, atmelProgramOffset);
  const partialBefore = new Uint8Array(partial);
  const rejected = patchSramBytes(partial, { saveTypeOverride: saveType });
  assert.deepEqual(rejected.bytes, partialBefore);
  assert.deepEqual(rejected.result.operations, []);
  assert.equal(rejected.result.savePatch.status, "failed");
  assert.equal(rejected.result.savePatch.reasonCode, "INCOMPLETE_HOOK_SET");
}

const laterFlashTypes = ["FLASH_V123", "FLASH_V124", "FLASH_V125", "FLASH_V126"];
const flash512Types = ["FLASH512_V130", "FLASH512_V131", "FLASH512_V133"];
const allFlash512Types = ["FLASH_V120", "FLASH_V121", ...laterFlashTypes, ...flash512Types];
const selectBfd4Thumb = Buffer.from("d4231b02bf200343", "hex");
const select321bThumb = "1b231b0232200343";
const inactive321bProgram = Buffer.from(
  "f0b590b00f1c0004040c034800684089",
  "hex",
);

// Every supported 512-Kibit FLASH library selects the same BFD4 descriptor.
// The later SDKs used to select 321B and patch that descriptor's program
// routine; their BFD4 erase entries were already shared. Exercise the complete
// BFD4 hook set and keep the inactive 321B implementation byte-identical.
for (const saveType of laterFlashTypes) {
  const patchInfo = PATCH_BY_SAVE_TYPE[saveType];
  assert.equal(patchInfo.type, "simple");
  assert.equal(patchInfo.steps.length, 3);
  assert.ok(patchInfo.steps.every((step) => step.name.includes("BFD4")));
  assert.deepEqual(Buffer.from(patchInfo.steps[0].writes[0].hex, "hex"), selectBfd4Thumb);

  const offsets = [0x400, 0x1000, 0x2000];
  const inactiveOffset = 0x3000;
  const fixture = new Uint8Array(0x4000).fill(0xff);
  patchInfo.steps.forEach((step, index) => {
    installIdentifier(fixture, step.identifier, offsets[index]);
  });
  fixture.set(inactive321bProgram, inactiveOffset);
  const inactiveBefore = fixture.slice(inactiveOffset, inactiveOffset + inactive321bProgram.length);

  const converted = patchSramBytes(fixture, { saveTypeOverride: saveType });
  assert.equal(converted.result.savePatch.status, "patched", saveType);
  assert.deepEqual(
    Buffer.from(converted.bytes.slice(offsets[0], offsets[0] + selectBfd4Thumb.length)),
    selectBfd4Thumb,
    `${saveType}: select BFD4`,
  );
  assert.deepEqual(
    Buffer.from(converted.bytes.slice(
      offsets[2],
      offsets[2] + Buffer.from(patchInfo.steps[2].writes[0].hex, "hex").length,
    )),
    Buffer.from(patchInfo.steps[2].writes[0].hex, "hex"),
    `${saveType}: program BFD4`,
  );
  assert.deepEqual(
    converted.bytes.slice(inactiveOffset, inactiveOffset + inactiveBefore.length),
    inactiveBefore,
    `${saveType}: inactive 321B program routine`,
  );
}

// FLASH512 V130+ keeps its public wrapper but redirects the private helper
// program patch from the 321B descriptor to BFD4. The offsets are structural
// properties of the respective SDK layouts, not ROM-identity decisions.
for (const saveType of flash512Types) {
  const patchInfo = PATCH_BY_SAVE_TYPE[saveType];
  assert.equal(patchInfo.type, "simple");
  assert.equal(patchInfo.steps.length, 2);
  assert.ok(patchInfo.steps.every((step) => step.name.includes("BFD4")));

  const wrapperOffset = 0x400;
  const helperOffset = 0x1200;
  const bfd4ProgramAdd = saveType === "FLASH512_V133" ? 764 : 596;
  const former321bProgramAdd = saveType === "FLASH512_V133" ? 1116 : 948;
  const fixture = new Uint8Array(0x3000).fill(0xff);
  installIdentifier(fixture, patchInfo.steps[0].identifier, wrapperOffset);
  installIdentifier(fixture, patchInfo.steps[1].identifier, helperOffset);
  fixture.set(inactive321bProgram, helperOffset + former321bProgramAdd);
  const inactiveBefore = fixture.slice(
    helperOffset + former321bProgramAdd,
    helperOffset + former321bProgramAdd + inactive321bProgram.length,
  );

  const selectWrite = patchInfo.steps[1].writes.find((write) => write.name.includes("select_bfd4"));
  const programWrite = patchInfo.steps[1].writes.find((write) => write.name.includes("program_bfd4"));
  assert.ok(selectWrite, `${saveType}: BFD4 selector`);
  assert.ok(programWrite, `${saveType}: BFD4 program hook`);
  assert.equal(programWrite.target_add, bfd4ProgramAdd);
  assert.deepEqual(Buffer.from(selectWrite.hex, "hex"), selectBfd4Thumb);

  const converted = patchSramBytes(fixture, { saveTypeOverride: saveType });
  assert.equal(converted.result.savePatch.status, "patched", saveType);
  assert.deepEqual(
    Buffer.from(converted.bytes.slice(helperOffset, helperOffset + selectBfd4Thumb.length)),
    selectBfd4Thumb,
    `${saveType}: select BFD4`,
  );
  assert.deepEqual(
    Buffer.from(converted.bytes.slice(
      helperOffset + bfd4ProgramAdd,
      helperOffset + bfd4ProgramAdd + Buffer.from(programWrite.hex, "hex").length,
    )),
    Buffer.from(programWrite.hex, "hex"),
    `${saveType}: program BFD4`,
  );
  assert.deepEqual(
    converted.bytes.slice(
      helperOffset + former321bProgramAdd,
      helperOffset + former321bProgramAdd + inactiveBefore.length,
    ),
    inactiveBefore,
    `${saveType}: inactive 321B program routine`,
  );

  const batterylessFixture = new Uint8Array(0x41003).fill(0xff);
  new DataView(batterylessFixture.buffer).setUint32(0, 0xea00002e, true);
  installIdentifier(batterylessFixture, patchInfo.steps[0].identifier, wrapperOffset);
  installIdentifier(batterylessFixture, patchInfo.steps[1].identifier, helperOffset);
  batterylessFixture.set(inactive321bProgram, helperOffset + former321bProgramAdd);
  const batterylessInactiveBefore = batterylessFixture.slice(
    helperOffset + former321bProgramAdd,
    helperOffset + former321bProgramAdd + inactive321bProgram.length,
  );
  const batterylessConverted = patchSramBytes(batterylessFixture, {
    saveTypeOverride: saveType,
    batteryless: true,
    batterylessMode: "auto",
  });
  assert.equal(batterylessConverted.result.batteryless.status, "patched", saveType);
  assert.deepEqual(
    batterylessConverted.result.batteryless.hooks,
    [{
      name: "FLASH512 BFD4 helper program",
      offset: helperOffset + bfd4ProgramAdd,
    }],
    `${saveType}: only the selected BFD4 writer is hooked`,
  );
  assert.deepEqual(
    batterylessConverted.bytes.slice(
      helperOffset + former321bProgramAdd,
      helperOffset + former321bProgramAdd + batterylessInactiveBefore.length,
    ),
    batterylessInactiveBefore,
    `${saveType}: Batteryless leaves inactive 321B untouched`,
  );
}

const serializedFlash512Profiles = JSON.stringify(
  Object.fromEntries(allFlash512Types.map((saveType) => [saveType, PATCH_BY_SAVE_TYPE[saveType]])),
);
assert.doesNotMatch(serializedFlash512Profiles, /1f3d|3d1f/i);
assert.equal(serializedFlash512Profiles.includes(select321bThumb), false);

console.log("SRAM bank-switch and atomic hook-set tests: PASS");
