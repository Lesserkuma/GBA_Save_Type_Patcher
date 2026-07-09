import { patchSramBytes } from "./patchers/sram.js";
import { patchCustomFlashBytes } from "./patchers/custom-flash.js";
import { applyWaitstateToBytes } from "./patchers/waitstate.js";
import { applyRtcForPipeline } from "./patchers/rtc.js";
import { applyIrqHandlerForPipeline } from "./patchers/irq-handler.js";
import { updateGbaHeaderChecksum } from "./patchers/patch-state.js";


function ensureResultArrays(patched) {
  patched.result.operations = patched.result.operations || [];
  patched.result.warnings = patched.result.warnings || [];
}

function applyRtcStandalonePatch(patched, rtcOptions = {}) {
  if (!rtcOptions?.enabled) return patched;
  ensureResultArrays(patched);
  const operationCountBeforeRtc = patched.result.operations.length;
  const rom = { bytes: patched.bytes };
  const rtc = applyRtcForPipeline(rom, patched.result.operations, patched.result.warnings, rtcOptions);
  patched.bytes = rom.bytes;
  patched.result.rtc = rtc;

  if (patched.result.operations.length > operationCountBeforeRtc) patched.result.status = "patched";
  else if (rtc?.status === "already_patched" && patched.result.status === "unchanged") patched.result.status = "already_rtc";
  return patched;
}

function applyWaitstateStandalonePatch(patched, waitstateOptions = {}) {
  if (!waitstateOptions?.enabled) return patched;
  ensureResultArrays(patched);
  const wait = applyWaitstateToBytes(patched.bytes, waitstateOptions);
  patched.bytes = wait.bytes;
  patched.result.operations.push(...(wait.result.operations || []));
  patched.result.warnings.push(...(wait.result.warnings || []));
  patched.result.waitstate = wait.result.waitstate;

  if (wait.result.operations?.length) patched.result.status = "patched";
  else if (wait.result.waitstate?.status === "already_patched" && patched.result.status === "unchanged") patched.result.status = "already_patched";
  return patched;
}

function applyStandaloneAddonPatches(patched, options = {}) {
  // Target layout without Batteryless SRAM: [last ROM data] [Fake RTC] [Waitstate] [Shared IRQ] [free space].
  patched = applyRtcStandalonePatch(patched, options.rtc);
  patched = applyWaitstateStandalonePatch(patched, options.waitstate);
  const rtcMenuEntry = patched.result.rtc?.runtime_menu_entry || 0;
  if (rtcMenuEntry) {
    ensureResultArrays(patched);
    const operationCountBeforeIrq = patched.result.operations.length;
    const rom = { bytes: patched.bytes };
    const irqHandler = applyIrqHandlerForPipeline(rom, patched.result.operations, patched.result.warnings, {
      enabled: true,
      rtcMenuEntry,
      hotkeyMask: options.batteryless?.hotkeyMask,
    });
    patched.bytes = rom.bytes;
    patched.result.irq_handler = irqHandler;
    if (patched.result.operations.length > operationCountBeforeIrq) patched.result.status = "patched";
  }
  return patched;
}

function finalizeHeaderChecksum(patched) {
  ensureResultArrays(patched);
  updateGbaHeaderChecksum(patched.bytes, patched.result.operations);
  if (patched.result.operations.length) patched.result.status = patched.result.status === "unchanged" ? "patched" : patched.result.status;
  return patched;
}

function firstWarning(result) {
  return result?.warnings?.[0] || "This ROM could not be patched.";
}

function ensureSuccessfulPatch(result) {
  if (result?.batteryless?.status === "failed") throw new Error(firstWarning(result));
  if (result?.waitstate?.status === "failed") throw new Error(firstWarning(result));
  if (result?.rtc?.status === "failed") throw new Error(firstWarning(result));
  if (result?.irq_handler?.status === "failed") throw new Error(firstWarning(result));
  if (result?.status === "unsupported") throw new Error(firstWarning(result));
  if (result?.status === "unchanged" && !result.operations?.length) throw new Error("This ROM could not be patched.");
}

self.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type !== "PATCH_ROM") return;

  try {
    const romBytes = new Uint8Array(message.romBuffer);
    let patched;

    if (message.options.patchMode === "custom-flash") {
      patched = patchCustomFlashBytes(romBytes, {
        saveChipType: message.options.customFlash.saveChipType,
        waitstate: { enabled: false },
      });
      patched = applyStandaloneAddonPatches(patched, message.options);
    } else if (message.options.patchMode === "none") {
      patched = { bytes: romBytes, result: { operations: [], warnings: [], status: "unchanged" } };
      patched = applyStandaloneAddonPatches(patched, message.options);
    } else {
      patched = patchSramBytes(romBytes, {
        batteryless: message.options.patchMode === "batteryless-sram",
        batterylessMode: message.options.batteryless.mode,
        batterylessCountdown: message.options.batteryless.countdownFrames,
        batterylessIndicatorMode: message.options.batteryless.indicator,
        batterylessLastBlock: message.options.batteryless.lastBlock,
        batterylessHotkeyMask: message.options.batteryless.hotkeyMask,
        flash1mBankSwitchStyle: message.options.sram?.flash1mBankSwitchStyle || "modern",
        saveBuffer: message.saveBuffer || null,
        waitstate: message.options.waitstate,
        rtc: message.options.rtc,
      });
    }

    patched = finalizeHeaderChecksum(patched);
    ensureSuccessfulPatch(patched.result);
    self.postMessage({
      type: "PATCH_DONE",
      id: message.id,
      outputName: message.outputName,
      patchedBuffer: patched.bytes.buffer,
      result: patched.result,
    }, [patched.bytes.buffer]);
  } catch (error) {
    self.postMessage({ type: "PATCH_ERROR", id: message.id, message: error.message || String(error) });
  }
});
