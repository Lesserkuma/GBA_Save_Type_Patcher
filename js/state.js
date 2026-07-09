export const state = {
  roms: [],
  saveFilesByBaseName: new Map(),
  isPatching: false,
  isImporting: false,
  lastZipUrl: null,
  options: {
    patchMode: "sram",
    batteryless: {
      mode: "auto",
      countdownFrames: 102,
      indicator: "save",
      lastBlock: "usable",
      hotkey: ["select", "l"],
    },
    flash512k: {
      countdownFrames: 100,
      indicator: "save",
    },
    sram: { flash1mBankSwitchStyle: "modern" },
    customFlash: { saveChipType: "1" },
    waitstate: { enabled: false },
    rtc: { enabled: false },
  },
};
export function clearZipUrl() { if (state.lastZipUrl) URL.revokeObjectURL(state.lastZipUrl); state.lastZipUrl = null; }
