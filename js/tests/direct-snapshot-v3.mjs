// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  exportDirectSramSave,
  inspectConvertedFlashSave,
  prepareDirectSave,
} from "../save-layouts/converted-flash.js";

const SLOT_SIZE = 0x8000;
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const payloadSource = await readFile(
  path.join(repository, "payloads/flash-direct/payload.c"), "utf8",
);

for (const required of [
  "snapshot_mirror_prepare",
  "snapshot_mirror_copy",
  "snapshot_persistent_reader",
  "snapshot_commit_core",
]) {
  assert.match(payloadSource, new RegExp(`\\b${required}\\b`), `missing ${required}`);
}
const mirrorCopy = payloadSource.indexOf(
  "snapshot_mirror_copy(mirror + first, effective_source, size)",
);
const terminalCommit = payloadSource.indexOf("return snapshot_commit(reader);", mirrorCopy);
assert.ok(mirrorCopy >= 0 && terminalCommit > mirrorCopy,
  "the terminal write must enter the mirror before committing");
const headerTail = payloadSource.indexOf(
  "target_base + 1u, header + 1u",
);
const commitMarker = payloadSource.indexOf(
  "flash_program_byte(reader, target_base, header[0])",
  headerTail,
);
const oldInvalidation = payloadSource.indexOf(
  "flash_erase_sector(reader, previous.header_base)",
  commitMarker,
);
assert.ok(headerTail >= 0 && commitMarker > headerTail && oldInvalidation > commitMarker,
  "snapshot commit must write header tail, one-byte marker, then invalidate old slot");

class MirrorRuntimeModel {
  constructor(physical = new Uint8Array(SLOT_SIZE * 2).fill(0xff), {
    commitFirst = 0x4008,
    commitSize = 4,
  } = {}) {
    this.physical = new Uint8Array(physical);
    try {
      this.mirror = exportDirectSramSave(this.physical);
    } catch {
      this.mirror = new Uint8Array(SLOT_SIZE);
    }
    this.dirty = false;
    this.commitFirst = commitFirst;
    this.commitSize = commitSize;
    this.commits = 0;
  }

  write(first, source) {
    const sourceBytes = source?.saveOffset === undefined
      ? new Uint8Array(source)
      : this.mirror.slice(source.saveOffset, source.saveOffset + source.size);
    const before = this.mirror.slice(first, first + sourceBytes.length);
    this.mirror.set(sourceBytes, first);
    if (!Buffer.from(before).equals(Buffer.from(sourceBytes))) this.dirty = true;
    if (first === this.commitFirst && sourceBytes.length === this.commitSize && this.dirty) {
      this.physical = prepareDirectSave(
        this.mirror,
        "sram",
        "direct-sram-snapshot-v3",
      );
      this.dirty = false;
      this.commits += 1;
    }
  }

  read(first, size) {
    return this.mirror.slice(first, first + size);
  }

  verify(first, expected) {
    const visible = this.read(first, expected.length);
    return visible.findIndex((value, index) => value !== expected[index]);
  }
}

const runtime = new MirrorRuntimeModel();
assert.deepEqual(runtime.read(0, SLOT_SIZE), new Uint8Array(SLOT_SIZE),
  "an erased/invalid header hydrates logical zero");
const staged = Uint8Array.from([1, 2, 3, 4, 5, 6]);
runtime.write(0x100, staged);
staged.fill(0xee);
assert.deepEqual(runtime.read(0x100, 6), Uint8Array.from([1, 2, 3, 4, 5, 6]));
assert.equal(runtime.verify(0x100, Uint8Array.from([1, 2, 3, 4, 5, 6])), -1);
assert.equal(runtime.commits, 0, "non-terminal writes stay ordered in the mirror");

runtime.write(0x102, { saveOffset: 0x100, size: 6 });
assert.deepEqual(
  runtime.read(0x100, 8),
  Uint8Array.from([1, 2, 1, 2, 3, 4, 5, 6]),
  "overlapping Save aliases use memmove semantics",
);
runtime.write(0x4008, Uint8Array.from([9, 8, 7, 6]));
assert.equal(runtime.commits, 1);
assert.equal(runtime.dirty, false);
assert.deepEqual(exportDirectSramSave(runtime.physical), runtime.mirror,
  "the terminal write is part of the committed immutable image");

const reopened = new MirrorRuntimeModel(runtime.physical);
assert.deepEqual(reopened.mirror, runtime.mirror);
reopened.write(0x4008, Uint8Array.from([9, 8, 7, 6]));
assert.equal(reopened.commits, 0, "an unchanged transaction causes no physical commit");

function relocatedToSecondSlot(physical) {
  const relocated = new Uint8Array(physical.length).fill(0xff);
  relocated.set(physical.subarray(0, SLOT_SIZE), SLOT_SIZE);
  return relocated;
}

function deterministicNoise() {
  const bytes = new Uint8Array(SLOT_SIZE);
  let state = 0x6d2b79f5;
  for (let index = 16; index < bytes.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

for (const canonical of [
  new Uint8Array(SLOT_SIZE),
  Uint8Array.from({ length: SLOT_SIZE }, (_, index) => (
    index < 16 ? 0 : ((index >>> 7) ^ (index >>> 11)) & 0xff
  )),
  deterministicNoise(),
]) {
  const physical = prepareDirectSave(canonical, "sram", "direct-sram-snapshot-v3");
  assert.deepEqual(exportDirectSramSave(physical), canonical);
  assert.deepEqual(exportDirectSramSave(relocatedToSecondSlot(physical)), canonical);
  assert.equal(inspectConvertedFlashSave(physical).format, "direct-sram-snapshot-v3");

  const customReadback = new Uint8Array(0x20000).fill(0xa5);
  customReadback.set(physical);
  assert.equal(inspectConvertedFlashSave(customReadback).format, "direct-sram-snapshot-v3");
  assert.deepEqual(exportDirectSramSave(customReadback), canonical);
  const normalized = prepareDirectSave(customReadback, "sram", "direct-sram-snapshot-v3");
  assert.equal(normalized.length, SLOT_SIZE * 2);
  assert.deepEqual(exportDirectSramSave(normalized), canonical);
}

const unsafeRaw = deterministicNoise();
unsafeRaw[0] = 0x5a;
assert.throws(
  () => prepareDirectSave(unsafeRaw, "sram", "direct-sram-snapshot-v3"),
  /header span is not logically blank/,
);

const ambiguous = prepareDirectSave(
  new Uint8Array(SLOT_SIZE), "sram", "direct-sram-snapshot-v3",
);
ambiguous.set(ambiguous.subarray(0, SLOT_SIZE), SLOT_SIZE);
assert.throws(() => exportDirectSramSave(ambiguous), /ambiguous/);

// A power cut before the one-byte commit marker leaves the prior slot as the
// only structurally valid generation.  This models both data-only and partial
// header-tail interruptions without introducing another physical format.
const oldCanonical = Uint8Array.from(
  { length: SLOT_SIZE }, (_, index) => (index < 16 ? 0 : index & 0x1f),
);
const newCanonical = Uint8Array.from(
  { length: SLOT_SIZE }, (_, index) => (index < 16 ? 0 : (index * 7) & 0xff),
);
const oldPhysical = prepareDirectSave(
  oldCanonical, "sram", "direct-sram-snapshot-v3",
);
const newPhysical = prepareDirectSave(
  newCanonical, "sram", "direct-sram-snapshot-v3",
);
for (const headerTailBytes of [0, 5, 15]) {
  const interrupted = new Uint8Array(oldPhysical);
  interrupted.set(newPhysical.subarray(16, SLOT_SIZE), SLOT_SIZE + 16);
  interrupted.set(
    newPhysical.subarray(1, 1 + headerTailBytes),
    SLOT_SIZE + 1,
  );
  assert.deepEqual(
    exportDirectSramSave(interrupted),
    oldCanonical,
    `interrupted header tail (${headerTailBytes} bytes) must retain old generation`,
  );
}

const oversizedRle = prepareDirectSave(
  new Uint8Array(SLOT_SIZE), "sram", "direct-sram-snapshot-v3",
);
oversizedRle[6] = 0xf1;
oversizedRle[7] = 0x7f;
oversizedRle[8] = 0x0e;
oversizedRle[9] = 0x80;
assert.throws(() => exportDirectSramSave(oversizedRle), /snapshot lengths/);

console.log("Direct snapshot v3: ok");
