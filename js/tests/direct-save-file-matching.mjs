// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";

import { PATCH_MODES } from "../domain/constants.js";
import { saveFileMatchesRom } from "../files.js";

const eeprom = { saveType: "EEPROM_V124", saveSizeBytes: 512 };
const sram = { saveType: "SRAM_V113", saveSizeBytes: 32768 };
const save = (size) => ({ size });

for (const mode of [PATCH_MODES.FLASH_512K, PATCH_MODES.CUSTOM_FLASH]) {
  for (const size of [512, 8192, 65536, 131072]) {
    assert.equal(saveFileMatchesRom(save(size), eeprom, mode), true);
  }
  for (const size of [32768, 65536, 131072]) {
    assert.equal(saveFileMatchesRom(save(size), sram, mode), true);
  }
}

for (const rom of [eeprom, sram]) {
  assert.equal(saveFileMatchesRom(save(65536), rom, PATCH_MODES.NONE), true);
  assert.equal(saveFileMatchesRom(save(131072), rom, PATCH_MODES.NONE), true);
  assert.equal(saveFileMatchesRom(save(512), rom, PATCH_MODES.NONE), false);
  assert.equal(saveFileMatchesRom(save(8192), rom, PATCH_MODES.NONE), false);
  assert.equal(saveFileMatchesRom(save(32768), rom, PATCH_MODES.NONE), false);
}

console.log("Direct save file matching: ok");
