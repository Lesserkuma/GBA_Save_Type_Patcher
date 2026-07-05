import { patchSramBytes } from "./patchers/sram.js";
import { patchCustomFlashBytes } from "./patchers/custom-flash.js";
import { applyWaitstateToBytes } from "./patchers/waitstate.js";

function firstWarning(result) {
  return result?.warnings?.[0] || "This ROM could not be patched.";
}

function ensureSuccessfulPatch(result) {
  if (result?.batteryless?.status === "failed") throw new Error(firstWarning(result));
  if (result?.waitstate?.status === "failed") throw new Error(firstWarning(result));
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
        waitstate: message.options.waitstate,
      });
    } else if (message.options.patchMode === "none") {
      patched = applyWaitstateToBytes(romBytes, message.options.waitstate);
    } else {
      patched = patchSramBytes(romBytes, {
        batteryless: message.options.patchMode === "batteryless-sram",
        batterylessMode: message.options.batteryless.mode,
        batterylessCountdown: message.options.batteryless.countdownFrames,
        batterylessIndicatorMode: message.options.batteryless.indicator,
        saveBuffer: message.saveBuffer || null,
        waitstate: message.options.waitstate,
      });
    }

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
