// SPDX-License-Identifier: GPL-3.0-or-later

export const GBA_EWRAM_START_ADDRESS = 0x02000000;
export const GBA_EWRAM_END_ADDRESS = 0x02040000;
export const GBA_IWRAM_START_ADDRESS = 0x03000000;
export const GBA_IWRAM_END_ADDRESS = 0x03008000;
export const GBA_ROM_BASE_ADDRESS = 0x08000000;
export const GBA_ROM_LAST_MIRROR_BASE_ADDRESS = 0x0c000000;
export const GBA_MAX_ROM_SIZE_BYTES = 0x02000000;
export const GBA_SAVE_MEMORY_START_ADDRESS = 0x0e000000;
export const GBA_SAVE_MEMORY_END_ADDRESS = 0x0e010000;

export const GBA_HEADER_SIZE = 0xc0;
export const GBA_HEADER_CHECKSUM_START = 0xa0;
export const GBA_HEADER_CHECKSUM_END = 0xbc;
export const GBA_HEADER_CHECKSUM_OFFSET = 0xbd;

export const PATCH_HEADER = Object.freeze({
  markerOffset: 0xbe,
  markerValue: 0x4c,
  saveSizeMask: 0x07,
  saveMediumMask: 0x18,
  saveMediumShift: 3,
  flagBatteryless: 0x20,
  flagWaitstate: 0x40,
  flagFakeRtc: 0x80,
  saveSizeCodes: Object.freeze({
    none: 0,
    512: 1,
    8192: 2,
    32768: 3,
    65536: 4,
    131072: 5,
  }),
});
