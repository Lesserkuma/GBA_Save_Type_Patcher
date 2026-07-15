// SPDX-License-Identifier: GPL-3.0-or-later

import { asciiBytes, findBytes, hexToBytes, readU16, readU32, writeU32 } from "../core/binary.js";
import { PatchError } from "../core/errors.js";
import { PATCH_OPERATION_KIND, RTC_TICK_MODES } from "../domain/constants.js";
import { stagePatchOperation } from "../patch-engine/draft.js";
import { ensureDirectPayloadRegion, isFreeRegion, markedPayloadSpan } from "./payload-placement.js";
import { IRQ_HANDLER_CONSTANTS, IRQ_HANDLER_PAYLOAD_HEX } from "./irq-handler-data.js";

const C = IRQ_HANDLER_CONSTANTS;
const GBA_ROM_BASE = 0x08000000;
const IRQ_HANDLER_PAYLOAD = hexToBytes(IRQ_HANDLER_PAYLOAD_HEX);
const IRQ_HANDLER_ROM_MARKER_TEXT = "lk_irq_shared";
const IRQ_HANDLER_ROM_MARKER = asciiBytes(IRQ_HANDLER_ROM_MARKER_TEXT);
const IRQ_SAVE_FLUSH_ENTRY_OFFSET = C.IRQ_SAVE_FLUSH_ENTRY_OFFSET;
const IRQ_FLAG_SAVE_FLUSH = C.IRQ_FLAG_SAVE_FLUSH;
const IRQ_FLAG_SAVE_FLUSH_AUTO = C.IRQ_FLAG_SAVE_FLUSH_AUTO;
const IRQ_FLAG_SAVE_FLUSH_HOTKEY = C.IRQ_FLAG_SAVE_FLUSH_HOTKEY;
const IRQ_FLAG_RTC_VBLANK_TICK = C.IRQ_FLAG_RTC_VBLANK_TICK;
const OLD_IRQ_SLOT = hexToBytes("fc7f0003");
const ORIGINAL_IRQ_SLOT = hexToBytes("f47f0003");
const IRQ_INSTALLER_STUB_SIZE = 9 * 4;
const IRQ_POST_CLEAR_STUB_SIZE = 11 * 4;
const IWRAM_START = 0x03000000;
const IWRAM_END = 0x03008000;
const DMA3_SOURCE_REGISTER = 0x040000d4;

export const IRQ_HANDLER_PAYLOAD_SIZE = C.IRQ_HANDLER_SIZE;

function stageIrqWrite(bytes, operations, name, offset, replacement, details = {}) {
  return stagePatchOperation(bytes, operations, {
    id: `irq-${operations.length}`,
    kind: details.kind || PATCH_OPERATION_KIND.HOOK_REPLACE,
    component: "irq",
    labelKey: details.labelKey || "operation.irq",
    offset,
    byteLength: replacement.length,
    expectedBefore: bytes.slice(offset, offset + replacement.length),
    replacement,
    metadata: {
      name,
      ...(details.codeName !== undefined ? { codeName: details.codeName } : {}),
      ...(details.value !== undefined ? { value: details.value } : {}),
    },
  });
}

function findAlignedMarker(bytes, marker, start = 0, end = bytes.length, alignment = 1) {
  const limit = Math.min(end, bytes.length);
  let pos = Math.max(0, start);
  while (pos < limit) {
    pos = findBytes(bytes, marker, pos, limit);
    if (pos < 0) return null;
    if (alignment <= 1 || pos % alignment === 0) return pos;
    pos += 1;
  }
  return null;
}

function offsetInRanges(offset, ranges) {
  return ranges.some(([start, end]) => start <= offset && offset < end);
}

function decodeEntrypointAddress(bytes) {
  if (bytes.length < 4 || bytes[3] !== 0xea) throw new PatchError("Shared IRQ: unexpected entrypoint instruction");
  const branchWord = readU32(bytes, 0);
  let branchOffset = branchWord & 0x00ffffff;
  if (branchOffset & 0x00800000) branchOffset -= 0x01000000;
  return GBA_ROM_BASE + 8 + (branchOffset << 2);
}

function encodeArmBranch(sourceAddress, targetAddress, link = false) {
  const branchOffset = (targetAddress - sourceAddress - 8) >> 2;
  if (branchOffset < -0x800000 || branchOffset > 0x7fffff) throw new PatchError("Shared IRQ: entrypoint target is outside ARM branch range");
  return ((link ? 0xeb000000 : 0xea000000) | (branchOffset & 0x00ffffff)) >>> 0;
}

export function irqHandlerPayloadSpanForLayout() {
  // Keep one aligned page for installer/post-clear stubs. Payload growth must
  // not silently consume the trampoline area at the end of the marked span.
  return markedPayloadSpan(IRQ_HANDLER_PAYLOAD.length, IRQ_HANDLER_ROM_MARKER.length) + 0x100;
}

function writeIrqHandlerRomMarker(bytes, operations, payloadBase) {
  const marker = IRQ_HANDLER_ROM_MARKER;
  const markerOffset = payloadBase + IRQ_HANDLER_PAYLOAD.length;
  const markerEnd = markerOffset + marker.length;
  const paddingEnd = payloadBase + irqHandlerPayloadSpanForLayout();
  if (markerEnd > paddingEnd || markerEnd > bytes.length) {
    throw new PatchError("Shared IRQ: reserved payload span does not include the ROM marker");
  }
  if (!isFreeRegion(bytes, markerOffset, marker.length)) {
    throw new PatchError("Shared IRQ: ROM marker region is not free");
  }
  stageIrqWrite(bytes, operations, "Shared IRQ ROM marker", markerOffset, marker, {
    kind: PATCH_OPERATION_KIND.LITERAL_REPLACE,
    codeName: "shared_irq_rom_marker",
  });
  return true;
}

function hasPcRelativeLiteralReference(bytes, literalOffset) {
  const armStart = Math.max(0, literalOffset - 0x1008);
  for (let instructionOffset = literalOffset - 4; instructionOffset >= armStart; instructionOffset -= 4) {
    if (instructionOffset + 4 > bytes.length) continue;
    const instruction = readU32(bytes, instructionOffset);
    if ((instruction & 0x0e5f0000) !== 0x041f0000) continue;
    const immediate = instruction & 0x0fff;
    const target = instructionOffset + 8 + ((instruction & 0x00800000) ? immediate : -immediate);
    if (target === literalOffset) return true;
  }

  const thumbStart = Math.max(0, literalOffset - 0x404);
  for (let instructionOffset = literalOffset - 2; instructionOffset >= thumbStart; instructionOffset -= 2) {
    if (instructionOffset + 2 > bytes.length) continue;
    const instruction = readU16(bytes, instructionOffset);
    if ((instruction & 0xf800) !== 0x4800) continue;
    const target = ((instructionOffset + 4) & ~3) + ((instruction & 0xff) << 2);
    if (target === literalOffset) return true;
  }
  return false;
}

export function patchIrqVectorReferences(out, operations, excludedRanges = []) {
  let count = 0;
  let pos = 0;
  while (true) {
    const matchOffset = findAlignedMarker(out, OLD_IRQ_SLOT, pos, out.length, 4);
    if (matchOffset === null) return count;
    if (offsetInRanges(matchOffset, excludedRanges)) {
      pos = matchOffset + 4;
      continue;
    }
    if (!hasPcRelativeLiteralReference(out, matchOffset)) {
      pos = matchOffset + 4;
      continue;
    }
    stageIrqWrite(out, operations, "Shared IRQ original handler slot", matchOffset, ORIGINAL_IRQ_SLOT, {
      value: 0x03007ff4,
    });
    count += 1;
    pos = matchOffset + 4;
  }
}

function writeConfig(payload, offset, value) {
  if (offset < 0 || offset + 4 > payload.length) throw new PatchError("Shared IRQ: config offset outside payload");
  writeU32(payload, offset, value >>> 0);
}

function indicatorModeValue(indicatorMode) {
  if (indicatorMode === "countdown") return 1;
  if (indicatorMode === "save") return 2;
  return 0;
}

function hotkeyMaskValue(hotkeyMask) {
  return Number.isInteger(hotkeyMask) ? hotkeyMask & 0x03ff : C.IRQ_HOTKEY_MASK;
}

function patchComputedIrqVectorReferences(out, operations, excludedRanges = []) {
  let count = 0;
  for (let offset = 0; offset + 20 <= out.length; offset += 4) {
    if (offsetInRanges(offset, excludedRanges)) continue;
    const loadBase = readU32(out, offset);
    if (((loadBase & 0xffff0fff) >>> 0) !== 0xe3a00403) continue; // mov base, #03000000
    const baseRegister = (loadBase >>> 12) & 0x0f;
    const loadOffset = readU32(out, offset + 4);
    if (((loadOffset & 0xffff0fff) >>> 0) !== 0xe3a00902) continue; // mov addr, #00008000
    const addressRegister = (loadOffset >>> 12) & 0x0f;
    if (baseRegister === addressRegister || baseRegister >= 13 || addressRegister >= 13) continue;

    const subtractFour = (
      0xe2400004
      | (addressRegister << 16)
      | (addressRegister << 12)
    ) >>> 0;
    const addAddress = (
      0xe0800000
      | (baseRegister << 16)
      | (addressRegister << 12)
      | addressRegister
    ) >>> 0;
    const storeBase = (
      0xe5800000
      | (addressRegister << 16)
      | (baseRegister << 12)
    ) >>> 0;
    if (readU32(out, offset + 8) !== subtractFour) continue;
    if (readU32(out, offset + 12) !== addAddress) continue;
    if (readU32(out, offset + 16) !== storeBase) continue;

    const replacement = new Uint8Array(4);
    writeU32(replacement, 0, (subtractFour + 8) >>> 0); // 8000 - 12 = 7FF4
    stageIrqWrite(out, operations, "Shared IRQ computed original handler slot", offset + 8, replacement, {
      value: 0x03007ff4,
    });
    count += 1;
    offset += 16;
  }
  return count;
}

function armPcRelativeLiteralReferences(bytes, literalOffset) {
  const references = [];
  const armStart = Math.max(0, literalOffset - 0x1008);
  for (let instructionOffset = literalOffset - 4; instructionOffset >= armStart; instructionOffset -= 4) {
    if (instructionOffset + 4 > bytes.length) continue;
    const instruction = readU32(bytes, instructionOffset);
    if ((instruction & 0x0e5f0000) !== 0x041f0000) continue;
    const immediate = instruction & 0x0fff;
    const target = instructionOffset + 8 + ((instruction & 0x00800000) ? immediate : -immediate);
    if (target === literalOffset) references.push({ instructionOffset, instruction });
  }
  return references;
}

function thumbPcRelativeLiteralReferences(bytes, literalOffset) {
  const references = [];
  const thumbStart = Math.max(0, literalOffset - 0x404);
  for (let instructionOffset = literalOffset - 2; instructionOffset >= thumbStart; instructionOffset -= 2) {
    if (instructionOffset + 2 > bytes.length) continue;
    const instruction = readU16(bytes, instructionOffset);
    if ((instruction & 0xf800) !== 0x4800) continue;
    const target = ((instructionOffset + 4) & ~3) + ((instruction & 0xff) << 2);
    if (target === literalOffset) references.push({ instructionOffset, instruction });
  }
  return references;
}

function isArmImmediateStore(instruction, baseRegister) {
  return (
    instruction >>> 28 === 0x0e
    && (instruction & 0x0f700fff) === 0x05000000
    && ((instruction >>> 16) & 0x0f) === baseRegister
  );
}

function isArmPcRelativeLoadInto(instruction, targetRegister) {
  return (
    instruction >>> 28 === 0x0e
    && (instruction & 0x0e5f0000) === 0x041f0000
    && ((instruction >>> 12) & 0x0f) === targetRegister
  );
}

/*
 * SDK startup code installs its user IRQ handler only after stacks, IWRAM and
 * copied sections have been initialized. Recognize the complete handoff
 * sequence instead of treating every 03007FFC literal as an installer:
 *
 *   ldr slot, =03007FFC
 *   <load handler>
 *   str handler, [slot]
 *   ldr slot, =main
 *   mov lr, pc
 *   bx  slot
 */
function findArmIrqInstallerSites(bytes, excludedRanges = []) {
  const sites = [];
  const seenStores = new Set();
  let pos = 0;
  while (true) {
    const literalOffset = findAlignedMarker(bytes, OLD_IRQ_SLOT, pos, bytes.length, 4);
    if (literalOffset === null) return sites;
    pos = literalOffset + 4;
    if (offsetInRanges(literalOffset, excludedRanges)) continue;

    for (const reference of armPcRelativeLiteralReferences(bytes, literalOffset)) {
      const { instructionOffset, instruction } = reference;
      const storeOffset = instructionOffset + 8;
      if (storeOffset + 16 > bytes.length || seenStores.has(storeOffset)) continue;
      const slotRegister = (instruction >>> 12) & 0x0f;
      const storeInstruction = readU32(bytes, storeOffset);
      if (!isArmImmediateStore(storeInstruction, slotRegister)) continue;
      const handlerRegister = (storeInstruction >>> 12) & 0x0f;
      if (handlerRegister === slotRegister || handlerRegister >= 13) continue;

      const mainLoad = readU32(bytes, storeOffset + 4);
      const setLink = readU32(bytes, storeOffset + 8);
      const branchMain = readU32(bytes, storeOffset + 12);
      if (!isArmPcRelativeLoadInto(mainLoad, slotRegister)) continue;
      if (setLink !== 0xe1a0e00f) continue;
      if (branchMain !== ((0xe12fff10 | slotRegister) >>> 0)) continue;

      seenStores.add(storeOffset);
      sites.push({ literalOffset, storeOffset, slotRegister, handlerRegister });
    }
  }
}

function decodeArmBranchTarget(instruction, instructionOffset) {
  let displacement = instruction & 0x00ffffff;
  if (displacement & 0x00800000) displacement -= 0x01000000;
  return instructionOffset + 8 + (displacement << 2);
}

function decodeArmImmediate(instruction) {
  const value = instruction & 0xff;
  const shift = ((instruction >>> 8) & 0x0f) * 2;
  if (shift === 0) return value;
  return ((value >>> shift) | (value << (32 - shift))) >>> 0;
}

function armDataProcessingDestination(instruction) {
  if (instruction >>> 28 !== 0x0e || ((instruction >>> 26) & 0x03) !== 0) return null;
  const opcode = (instruction >>> 21) & 0x0f;
  if (opcode >= 8 && opcode <= 11) return null; // TST/TEQ/CMP/CMN do not write Rd.
  return (instruction >>> 12) & 0x0f;
}

function resolveArmConstantProducer(bytes, endOffset, register, maxDistance = 0x80) {
  const start = align4(Math.max(0, endOffset - maxDistance));
  for (let offset = endOffset - 4; offset >= start; offset -= 4) {
    const instruction = readU32(bytes, offset);
    if (isArmPcRelativeLoadInto(instruction, register)) {
      const immediate = instruction & 0x0fff;
      const literalOffset = offset + 8 + ((instruction & 0x00800000) ? immediate : -immediate);
      if (literalOffset < 0 || literalOffset + 4 > bytes.length) return null;
      return readU32(bytes, literalOffset);
    }

    const destination = armDataProcessingDestination(instruction);
    if (destination !== register) continue;
    if ((instruction & 0x02000000) === 0) return null;
    const opcode = (instruction >>> 21) & 0x0f;
    const sourceRegister = (instruction >>> 16) & 0x0f;
    const immediate = decodeArmImmediate(instruction);
    if (opcode === 13) return immediate; // mov Rd, #imm
    if (sourceRegister === 15 && opcode === 4) return (GBA_ROM_BASE + offset + 8 + immediate) >>> 0; // add Rd, pc, #imm
    if (sourceRegister === 15 && opcode === 2) return (GBA_ROM_BASE + offset + 8 - immediate) >>> 0; // sub Rd, pc, #imm
    return null;
  }
  return null;
}

function armZeroFillHelperRegisters(bytes, targetOffset) {
  const end = Math.min(bytes.length, targetOffset + 0x50);
  for (let storeOffset = align4(targetOffset); storeOffset + 12 <= end; storeOffset += 4) {
    const store = readU32(bytes, storeOffset);
    let baseRegister;
    let zeroRegister;
    let requiresZeroArgument = false;
    if (((store & 0x0ff00000) >>> 0) === 0x08a00000) { // stmia base!, {value}
      const registerList = store & 0xffff;
      if (registerList === 0 || (registerList & (registerList - 1)) !== 0) continue;
      baseRegister = (store >>> 16) & 0x0f;
      zeroRegister = Math.clz32(registerList) ^ 31;
      const zeroValue = resolveArmConstantProducer(bytes, storeOffset, zeroRegister, 0x20);
      if (zeroValue !== 0) continue;
    } else if (((store & 0x0ff00fff) >>> 0) === 0x04800004) { // str value, [base], #4
      baseRegister = (store >>> 16) & 0x0f;
      zeroRegister = (store >>> 12) & 0x0f;
      requiresZeroArgument = true;
    } else {
      continue;
    }
    if (baseRegister >= 13 || zeroRegister >= 13 || baseRegister === zeroRegister) continue;

    for (let subtractOffset = storeOffset + 4; subtractOffset + 8 <= end; subtractOffset += 4) {
      const subtract = readU32(bytes, subtractOffset);
      const opcode = (subtract >>> 21) & 0x0f;
      const lengthRegister = (subtract >>> 16) & 0x0f;
      if (
        subtract >>> 28 !== 0x0e
        || (subtract & 0x02000000) === 0
        || opcode !== 2
        || (subtract & 0x00100000) === 0
        || ((subtract >>> 12) & 0x0f) !== lengthRegister
        || decodeArmImmediate(subtract) !== 4
      ) continue;
      const loop = readU32(bytes, subtractOffset + 4);
      if (((loop & 0xff000000) >>> 0) !== 0x1a000000) continue;
      if (decodeArmBranchTarget(loop, subtractOffset + 4) !== storeOffset) continue;
      return { baseRegister, lengthRegister, zeroRegister, requiresZeroArgument };
    }
  }
  return null;
}

function updateArmConstants(constants, bytes, instructionOffset, instruction) {
  if (isArmPcRelativeLoadInto(instruction, (instruction >>> 12) & 0x0f)) {
    const destination = (instruction >>> 12) & 0x0f;
    const immediate = instruction & 0x0fff;
    const literalOffset = instructionOffset + 8 + ((instruction & 0x00800000) ? immediate : -immediate);
    constants[destination] = literalOffset >= 0 && literalOffset + 4 <= bytes.length
      ? readU32(bytes, literalOffset)
      : null;
    return;
  }

  const destination = armDataProcessingDestination(instruction);
  if (destination === null) return;
  if ((instruction & 0x02000000) === 0) {
    constants[destination] = null;
    return;
  }
  const opcode = (instruction >>> 21) & 0x0f;
  const sourceRegister = (instruction >>> 16) & 0x0f;
  const immediate = decodeArmImmediate(instruction);
  const source = sourceRegister === 15
    ? (GBA_ROM_BASE + instructionOffset + 8) >>> 0
    : constants[sourceRegister];
  if (opcode === 13) constants[destination] = immediate;
  else if (source !== null && source !== undefined && opcode === 4) constants[destination] = (source + immediate) >>> 0;
  else if (source !== null && source !== undefined && opcode === 2) constants[destination] = (source - immediate) >>> 0;
  else constants[destination] = null;
}

function findArmCalledIwramCpuClear(bytes, start, end) {
  const scanStart = align4(Math.max(0, start));
  const scanEnd = Math.min(bytes.length, end);
  const constants = new Array(16).fill(null);
  for (let offset = scanStart; offset + 4 <= scanEnd; offset += 4) {
    const instruction = readU32(bytes, offset);
    if (((instruction & 0xff000000) >>> 0) === 0xeb000000) {
      const targetOffset = decodeArmBranchTarget(instruction, offset);
      const helper = targetOffset >= 0 && targetOffset < bytes.length
        ? armZeroFillHelperRegisters(bytes, targetOffset)
        : null;
      if (helper) {
        const clearStart = constants[helper.baseRegister];
        const clearLength = constants[helper.lengthRegister];
        const clearValue = helper.requiresZeroArgument
          ? constants[helper.zeroRegister]
          : 0;
        if (clearStart !== null && clearLength !== null) {
          const clearEnd = clearStart + clearLength;
          if (clearValue === 0 && clearStart < IWRAM_END && clearEnd > 0x03007ff4) {
            return { offset, endOffset: offset + 4, clearStart, clearEnd, targetOffset };
          }
        }
      }
      constants[14] = null;
      continue;
    }
    updateArmConstants(constants, bytes, offset, instruction);
  }
  return null;
}

function findArmFullIwramCpuClear(bytes, start, end) {
  const scanStart = align4(Math.max(0, start));
  const scanEnd = Math.min(bytes.length, end);
  for (let offset = scanStart; offset + 24 <= scanEnd; offset += 4) {
    const loadBase = readU32(bytes, offset);
    if (((loadBase & 0xffff0fff) >>> 0) !== 0xe3a00403) continue; // mov base, #03000000
    const baseRegister = (loadBase >>> 12) & 0x0f;

    const loadZero = readU32(bytes, offset + 4);
    if (((loadZero & 0xffff0fff) >>> 0) !== 0xe3a00000) continue; // mov value, #0
    const zeroRegister = (loadZero >>> 12) & 0x0f;

    const loadLength = readU32(bytes, offset + 8);
    if (((loadLength & 0xffff0fff) >>> 0) !== 0xe3a00902) continue; // mov count, #00008000
    const lengthRegister = (loadLength >>> 12) & 0x0f;
    if (baseRegister >= 13 || zeroRegister >= 13 || lengthRegister >= 13) continue;

    const store = readU32(bytes, offset + 12);
    if (((store & 0xfff00000) >>> 0) !== 0xe8a00000) continue; // stmia base!, {value}
    if (((store >>> 16) & 0x0f) !== baseRegister || (store & 0xffff) !== (1 << zeroRegister)) continue;

    const subtractFour = (
      0xe2500004
      | (lengthRegister << 16)
      | (lengthRegister << 12)
    ) >>> 0;
    if (readU32(bytes, offset + 16) !== subtractFour) continue;
    const loop = readU32(bytes, offset + 20);
    if (((loop & 0xff000000) >>> 0) !== 0x1a000000) continue;
    if (decodeArmBranchTarget(loop, offset + 20) !== offset + 12) continue;
    return {
      offset,
      endOffset: offset + 24,
      clearStart: IWRAM_START,
      clearEnd: IWRAM_END,
    };
  }
  return null;
}

function findArmDestructiveIwramClear(bytes, start, end) {
  return findArmFullIwramCpuClear(bytes, start, end)
    || findArmCalledIwramCpuClear(bytes, start, end);
}

/*
 * A few CRT variants install an IRQ handler, clear all of IWRAM (including
 * the vector), copy their runtime sections, and only then call main. Hook the
 * final handoff so the shared vector is restored after the destructive phase.
 */
function findArmPostClearHandoffSites(bytes, excludedRanges = []) {
  const sites = [];
  const seenBranches = new Set();
  let pos = 0;
  while (true) {
    const literalOffset = findAlignedMarker(bytes, OLD_IRQ_SLOT, pos, bytes.length, 4);
    if (literalOffset === null) return sites;
    pos = literalOffset + 4;
    if (offsetInRanges(literalOffset, excludedRanges)) continue;

    for (const reference of armPcRelativeLiteralReferences(bytes, literalOffset)) {
      const slotRegister = (reference.instruction >>> 12) & 0x0f;
      const storeOffset = reference.instructionOffset + 8;
      if (storeOffset + 4 > bytes.length) continue;
      const storeInstruction = readU32(bytes, storeOffset);
      if (!isArmImmediateStore(storeInstruction, slotRegister)) continue;

      const clear = findArmDestructiveIwramClear(bytes, storeOffset + 4, storeOffset + 0x100);
      if (!clear) continue;
      const handlerRegister = (storeInstruction >>> 12) & 0x0f;
      const originalHandlerAddress = resolveArmConstantProducer(bytes, storeOffset, handlerRegister);
      const handoffEnd = Math.min(bytes.length, storeOffset + 0x200);
      for (let offset = align4(clear.endOffset); offset + 12 <= handoffEnd; offset += 4) {
        const mainLoad = readU32(bytes, offset);
        const mainRegister = (mainLoad >>> 12) & 0x0f;
        if (mainRegister >= 13 || !isArmPcRelativeLoadInto(mainLoad, mainRegister)) continue;
        if (readU32(bytes, offset + 4) !== 0xe1a0e00f) continue; // mov lr, pc
        if (readU32(bytes, offset + 8) !== ((0xe12fff10 | mainRegister) >>> 0)) continue;
        const branchOffset = offset + 8;
        if (seenBranches.has(branchOffset)) break;
        seenBranches.add(branchOffset);
        sites.push({ literalOffset, branchOffset, mainRegister, originalHandlerAddress });
        break;
      }
    }
  }
}

/*
 * Some CRTs enter with IRQs disabled, clear the complete 32 KiB IWRAM before
 * copying their runtime, and install the game's Thumb IRQ manager only from
 * main.  A reset bootstrap necessarily disappears during that clear.  Anchor
 * this variant to the active ROM entrypoint and require both a proven
 * destructive IWRAM clear and the exact ARM handoff used by the CRT:
 *
 *   ldr main, =entry
 *   mov lr, pc
 *   bx  main
 *
 * The post-clear trampoline can safely start with an empty original-handler
 * slot; the later Thumb installer is relocated to 03007FF4 independently.
 */
function findArmEntrypointPostClearHandoffSites(
  bytes,
  entrypointOffset,
  excludedRanges = [],
) {
  if (
    !Number.isSafeInteger(entrypointOffset)
    || entrypointOffset < 0
    || entrypointOffset + 4 > bytes.length
    || offsetInRanges(entrypointOffset, excludedRanges)
  ) return [];

  const startupEnd = Math.min(bytes.length, entrypointOffset + 0x400);
  const clear = findArmDestructiveIwramClear(bytes, entrypointOffset, startupEnd);
  if (
    !clear
    || clear.clearStart !== IWRAM_START
    || clear.clearEnd < IWRAM_END
  ) return [];

  const handoffEnd = Math.min(startupEnd, clear.endOffset + 0x200);
  for (let offset = align4(clear.endOffset); offset + 12 <= handoffEnd; offset += 4) {
    if (offsetInRanges(offset, excludedRanges) || offsetInRanges(offset + 8, excludedRanges)) continue;
    const mainLoad = readU32(bytes, offset);
    const mainRegister = (mainLoad >>> 12) & 0x0f;
    if (mainRegister >= 13 || !isArmPcRelativeLoadInto(mainLoad, mainRegister)) continue;
    if (readU32(bytes, offset + 4) !== 0xe1a0e00f) continue; // mov lr, pc
    if (readU32(bytes, offset + 8) !== ((0xe12fff10 | mainRegister) >>> 0)) continue;

    const mainAddress = resolveArmConstantProducer(bytes, offset + 4, mainRegister, 4);
    if (mainAddress === null) continue;
    const mainOffset = (mainAddress & ~1) - GBA_ROM_BASE;
    if (mainOffset < 0 || mainOffset >= bytes.length) continue;

    return [{
      literalOffset: null,
      branchOffset: offset + 8,
      mainRegister,
      originalHandlerAddress: 0,
    }];
  }
  return [];
}

function findThumbIrqInstallerSites(bytes, excludedRanges = []) {
  const sites = [];
  const seenStores = new Set();
  let pos = 0;
  while (true) {
    const literalOffset = findAlignedMarker(bytes, OLD_IRQ_SLOT, pos, bytes.length, 4);
    if (literalOffset === null) return sites;
    pos = literalOffset + 4;
    if (offsetInRanges(literalOffset, excludedRanges)) continue;

    for (const reference of thumbPcRelativeLiteralReferences(bytes, literalOffset)) {
      const slotRegister = (reference.instruction >>> 8) & 0x07;
      const storeOffset = reference.instructionOffset + 2;
      if (storeOffset + 2 > bytes.length || seenStores.has(storeOffset)) continue;
      const storeInstruction = readU16(bytes, storeOffset);
      if ((storeInstruction & 0xf800) !== 0x6000) continue;
      if ((storeInstruction & 0x07c0) !== 0) continue;
      if (((storeInstruction >>> 3) & 0x07) !== slotRegister) continue;
      const handlerRegister = storeInstruction & 0x07;
      if (handlerRegister === slotRegister) continue;
      seenStores.add(storeOffset);
      sites.push({ literalOffset, storeOffset, slotRegister, handlerRegister });
    }
  }
}

function hasNearbyThumbLiteralValue(bytes, referenceOffset, value, radius = 0x100) {
  const start = align4(Math.max(0, referenceOffset - radius));
  const end = Math.min(bytes.length - 4, referenceOffset + radius);
  for (let literalOffset = start; literalOffset <= end; literalOffset += 4) {
    if (readU32(bytes, literalOffset) !== value) continue;
    if (thumbPcRelativeLiteralReferences(bytes, literalOffset).some((reference) => (
      Math.abs(reference.instructionOffset - referenceOffset) <= radius
    ))) return true;
  }
  return false;
}

/*
 * Preserve 03007FFC across source-fixed DMA3 fills that end exactly at the top
 * of IWRAM. The destination, control value and proven Thumb IRQ installer must
 * all belong to the same small routine; unrelated DMA constants are ignored.
 */
function patchUpperIwramDmaFills(bytes, operations, thumbSites, excludedRanges = []) {
  let count = 0;
  for (let literalOffset = 0; literalOffset + 4 <= bytes.length; literalOffset += 4) {
    if (offsetInRanges(literalOffset, excludedRanges)) continue;
    const control = readU32(bytes, literalOffset);
    if (((control & 0xffff0000) >>> 0) !== 0x85000000) continue;
    const encodedWords = control & 0xffff;
    const words = encodedWords === 0 ? 0x4000 : encodedWords;
    if (words <= 1) continue;

    const controlReferences = thumbPcRelativeLiteralReferences(bytes, literalOffset);
    const provenReference = controlReferences.find((reference) => {
      const belongsToIrqStartup = thumbSites.some((site) => (
        Math.abs(site.storeOffset - reference.instructionOffset) <= 0x400
      ));
      if (!belongsToIrqStartup) return false;

      // Preserve the established full-IWRAM-clear handling. Some launchers
      // keep the destination in a register loaded outside the local literal
      // pool, but 0x2000 32-bit words is itself an exact 32 KiB IWRAM span.
      if (control === 0x85002000) return true;

      if (!hasNearbyThumbLiteralValue(bytes, reference.instructionOffset, DMA3_SOURCE_REGISTER)) return false;

      const destination = IWRAM_END - words * 4;
      return destination >= IWRAM_START
        && destination < IWRAM_END
        && hasNearbyThumbLiteralValue(bytes, reference.instructionOffset, destination);
    });
    if (!provenReference) continue;

    const replacement = new Uint8Array(4);
    const replacementControl = (0x85000000 | (words - 1)) >>> 0;
    writeU32(replacement, 0, replacementControl);
    stageIrqWrite(bytes, operations, "Shared IRQ preserve vector across upper IWRAM DMA fill", literalOffset, replacement, {
      kind: PATCH_OPERATION_KIND.LITERAL_REPLACE,
      value: replacementControl,
    });
    count += 1;
  }
  return count;
}

function align4(value) {
  return (value + 3) & ~3;
}

function makeArmIrqInstallerStub(site, handlerAddress) {
  const scratchRegister = [12, 3, 2, 4, 5, 6, 7, 8, 9, 10, 11]
    .find((register) => register !== site.slotRegister && register !== site.handlerRegister);
  if (scratchRegister === undefined) throw new PatchError("Shared IRQ: no scratch register for startup hook");

  const stub = new Uint8Array(IRQ_INSTALLER_STUB_SIZE);
  const originalStore = (
    0xe5800000
    | (site.slotRegister << 16)
    | (site.handlerRegister << 12)
  ) >>> 0;
  const pushScratch = (0xe52d0004 | (scratchRegister << 12)) >>> 0;
  const loadSharedHandler = (0xe59f0008 | (scratchRegister << 12)) >>> 0;
  const storeSharedHandler = (
    0xe5800008
    | (site.slotRegister << 16)
    | (scratchRegister << 12)
  ) >>> 0;
  const popScratch = (0xe49d0004 | (scratchRegister << 12)) >>> 0;
  [
    originalStore,
    pushScratch,
    loadSharedHandler,
    storeSharedHandler,
    popScratch,
    0xe12fff1e, // bx lr; every recognized startup site replaces lr before main.
    handlerAddress,
  ].forEach((word, index) => writeU32(stub, index * 4, word));
  return stub;
}

function installArmIrqStartupHooks(bytes, operations, sites, payloadBase, handlerAddress) {
  const markerEnd = payloadBase + IRQ_HANDLER_PAYLOAD.length + IRQ_HANDLER_ROM_MARKER.length;
  const stubBase = align4(markerEnd);
  if (sites.length === 0) return { count: 0, nextStubOffset: stubBase };
  const groupsByLayout = new Map();
  for (const site of sites) {
    const key = `${site.slotRegister}:${site.handlerRegister}`;
    if (!groupsByLayout.has(key)) groupsByLayout.set(key, []);
    groupsByLayout.get(key).push(site);
  }
  const siteGroups = [...groupsByLayout.values()];
  const stubEnd = stubBase + siteGroups.length * IRQ_INSTALLER_STUB_SIZE;
  const payloadEnd = payloadBase + irqHandlerPayloadSpanForLayout();
  if (stubEnd > payloadEnd) {
    throw new PatchError(`Shared IRQ: ${siteGroups.length} startup hook register layouts exceed the reserved payload span`);
  }
  if (!isFreeRegion(bytes, stubBase, stubEnd - stubBase)) {
    throw new PatchError("Shared IRQ: startup hook region is not free");
  }

  const stubAddresses = new Map();
  siteGroups.forEach((group, index) => {
    const site = group[0];
    const stubOffset = stubBase + index * IRQ_INSTALLER_STUB_SIZE;
    const stubAddress = (GBA_ROM_BASE + stubOffset) >>> 0;
    const stub = makeArmIrqInstallerStub(site, handlerAddress);
    stageIrqWrite(bytes, operations, "Shared IRQ post-CRT startup hook", stubOffset, stub, {
      kind: PATCH_OPERATION_KIND.PAYLOAD_INSTALL,
      codeName: "shared_irq_post_crt_stub",
      value: stubAddress,
    });
    stubAddresses.set(`${site.slotRegister}:${site.handlerRegister}`, stubAddress);
  });

  sites.forEach((site) => {
    const stubAddress = stubAddresses.get(`${site.slotRegister}:${site.handlerRegister}`);
    const branch = new Uint8Array(4);
    writeU32(branch, 0, encodeArmBranch(
      (GBA_ROM_BASE + site.storeOffset) >>> 0,
      stubAddress,
      true,
    ));
    stageIrqWrite(bytes, operations, "Shared IRQ startup installer branch", site.storeOffset, branch, {
      value: stubAddress,
    });
  });
  return { count: sites.length, nextStubOffset: stubEnd };
}

function makeArmPostClearInstallerStub(site, handlerAddress) {
  const scratchRegisters = [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    .filter((register) => register !== site.mainRegister);
  if (scratchRegisters.length < 2) throw new PatchError("Shared IRQ: no scratch registers for post-clear hook");
  const handlerRegister = scratchRegisters[0];
  const slotRegister = scratchRegisters[1];
  const savedRegisters = (1 << handlerRegister) | (1 << slotRegister);
  const stub = new Uint8Array(IRQ_POST_CLEAR_STUB_SIZE);
  [
    (0xe92d0000 | savedRegisters) >>> 0, // push scratch registers
    (0xe59f0018 | (slotRegister << 12)) >>> 0,
    (0xe59f0010 | (handlerRegister << 12)) >>> 0,
    (0xe5800000 | (slotRegister << 16) | (handlerRegister << 12)) >>> 0,
    (0xe59f0010 | (handlerRegister << 12)) >>> 0,
    (0xe5800008 | (slotRegister << 16) | (handlerRegister << 12)) >>> 0,
    (0xe8bd0000 | savedRegisters) >>> 0, // pop scratch registers
    (0xe12fff10 | site.mainRegister) >>> 0,
    site.originalHandlerAddress || 0,
    0x03007ff4,
    handlerAddress,
  ].forEach((word, index) => writeU32(stub, index * 4, word));
  return stub;
}

function installArmPostClearHooks(bytes, operations, sites, payloadBase, handlerAddress, stubBase) {
  if (sites.length === 0) return 0;
  const groupsByMainRegister = new Map();
  for (const site of sites) {
    const key = `${site.mainRegister}:${site.originalHandlerAddress || 0}`;
    if (!groupsByMainRegister.has(key)) groupsByMainRegister.set(key, []);
    groupsByMainRegister.get(key).push(site);
  }
  const siteGroups = [...groupsByMainRegister.values()];
  const stubEnd = stubBase + siteGroups.length * IRQ_POST_CLEAR_STUB_SIZE;
  const payloadEnd = payloadBase + irqHandlerPayloadSpanForLayout();
  if (stubEnd > payloadEnd) {
    throw new PatchError(`Shared IRQ: ${siteGroups.length} post-clear hook layouts exceed the reserved payload span`);
  }
  if (!isFreeRegion(bytes, stubBase, stubEnd - stubBase)) {
    throw new PatchError("Shared IRQ: post-clear hook region is not free");
  }

  const stubAddresses = new Map();
  siteGroups.forEach((group, index) => {
    const site = group[0];
    const stubOffset = stubBase + index * IRQ_POST_CLEAR_STUB_SIZE;
    const stubAddress = (GBA_ROM_BASE + stubOffset) >>> 0;
    stageIrqWrite(bytes, operations, "Shared IRQ post-clear startup hook", stubOffset, makeArmPostClearInstallerStub(site, handlerAddress), {
      kind: PATCH_OPERATION_KIND.PAYLOAD_INSTALL,
      codeName: "shared_irq_post_clear_stub",
      value: stubAddress,
    });
    stubAddresses.set(`${site.mainRegister}:${site.originalHandlerAddress || 0}`, stubAddress);
  });

  sites.forEach((site) => {
    const stubAddress = stubAddresses.get(`${site.mainRegister}:${site.originalHandlerAddress || 0}`);
    const branch = new Uint8Array(4);
    writeU32(branch, 0, encodeArmBranch(
      (GBA_ROM_BASE + site.branchOffset) >>> 0,
      stubAddress,
    ));
    stageIrqWrite(bytes, operations, "Shared IRQ post-clear handoff branch", site.branchOffset, branch, {
      value: stubAddress,
    });
  });
  return sites.length;
}

function rtcTickModeValue(options) {
  if (!options.rtcMenuEntry) return null;
  return options.rtcTickMode === RTC_TICK_MODES.READ
    ? RTC_TICK_MODES.READ
    : RTC_TICK_MODES.VBLANK;
}

function irqFlags(options) {
  const saveFlushEntry = options.saveFlushEntry ?? 0;
  const saveFlushAuto = options.saveFlushAuto ?? false;
  const saveFlushHotkey = options.saveFlushHotkey ?? Boolean(saveFlushEntry);
  const rtcTickMode = rtcTickModeValue(options);
  return (
    (options.rtcMenuEntry ? C.IRQ_FLAG_RTC : 0)
    | (options.rtcMenuEntry && rtcTickMode === RTC_TICK_MODES.VBLANK ? IRQ_FLAG_RTC_VBLANK_TICK : 0)
    | (saveFlushEntry ? IRQ_FLAG_SAVE_FLUSH : 0)
    | (saveFlushEntry && saveFlushAuto ? IRQ_FLAG_SAVE_FLUSH_AUTO : 0)
    | (saveFlushEntry && saveFlushHotkey ? IRQ_FLAG_SAVE_FLUSH_HOTKEY : 0)
  ) >>> 0;
}

function saveFlushEntryValue(options) {
  return (options.saveFlushEntry ?? 0) >>> 0;
}

function configuredIrqPayload(bytes, payloadBase, options) {
  const originalEntrypoint = decodeEntrypointAddress(bytes);
  const payload = new Uint8Array(IRQ_HANDLER_PAYLOAD);
  const payloadAddress = (GBA_ROM_BASE + payloadBase) >>> 0;
  const rtcTickMode = rtcTickModeValue(options);
  const handlerOffset = rtcTickMode === RTC_TICK_MODES.VBLANK
    ? C.IRQ_HANDLER_CONTINUOUS_OFFSET
    : C.IRQ_HANDLER_OFFSET;
  const handlerAddress = (payloadAddress + handlerOffset) >>> 0;
  const startupHandlerAddress = (payloadAddress + C.IRQ_HANDLER_STARTUP_OFFSET) >>> 0;
  const installHandlerAddress = options.startupCallbackEntry
    ? startupHandlerAddress
    : handlerAddress;
  const bootstrapAddress = (payloadAddress + C.IRQ_BOOTSTRAP_OFFSET) >>> 0;
  const flags = irqFlags(options);
  const hotkeyMask = hotkeyMaskValue(options.hotkeyMask);
  const saveFlushEntry = saveFlushEntryValue(options);
  writeConfig(payload, C.IRQ_ORIGINAL_ENTRYPOINT_OFFSET, originalEntrypoint);
  writeConfig(payload, C.IRQ_FLAGS_OFFSET, flags);
  writeConfig(payload, C.IRQ_RTC_MENU_ENTRY_OFFSET, options.rtcMenuEntry || 0);
  writeConfig(payload, IRQ_SAVE_FLUSH_ENTRY_OFFSET, saveFlushEntry);
  writeConfig(payload, C.IRQ_COUNTDOWN_FRAMES_OFFSET, options.countdownFrames || 0);
  writeConfig(payload, C.IRQ_INDICATOR_MODE_OFFSET, indicatorModeValue(options.indicatorMode));
  writeConfig(payload, C.IRQ_HOTKEY_MASK_OFFSET, hotkeyMask);
  writeConfig(payload, C.IRQ_HANDLER_ENTRY_OFFSET, handlerAddress);
  writeConfig(payload, C.IRQ_STARTUP_CALLBACK_ENTRY_OFFSET, options.startupCallbackEntry || 0);
  return {
    payload,
    payloadAddress,
    handlerAddress,
    startupHandlerAddress,
    installHandlerAddress,
    bootstrapAddress,
    originalEntrypoint,
    flags,
    hotkeyMask,
    saveFlushEntry,
    rtcTickMode,
  };
}

function installedIrqResult(
  payloadBase,
  configured,
  irqReferences,
  startupHooks,
  postClearHooks,
  entrypointHook,
  iwramClearPatches,
  startupCallbackEntry,
) {
  return {
    requested: true,
    status: "patched",
    payloadOffset: payloadBase,
    runtimeBase: configured.payloadAddress,
    size: IRQ_HANDLER_PAYLOAD.length,
    payloadSpan: irqHandlerPayloadSpanForLayout(),
    flags: configured.flags,
    saveFlushEntry: configured.saveFlushEntry,
    rtcTickMode: configured.rtcTickMode,
    handlerEntry: configured.handlerAddress,
    startupHandlerEntry: configured.startupHandlerAddress,
    installHandlerEntry: configured.installHandlerAddress,
    bootstrapEntry: configured.bootstrapAddress,
    originalEntrypoint: configured.originalEntrypoint,
    hotkeyMask: configured.hotkeyMask,
    irqReferences,
    startupHooks,
    postClearHooks,
    entrypointHook,
    iwramClearPatches,
    startupCallbackEntry,
    installMode: entrypointHook
      ? (startupHooks || postClearHooks ? "multiPhase" : "entrypoint")
      : "postCrt",
  };
}

function installIrqHandler(rom, operations, warnings, options, context) {
  const previousOperationCount = operations.length;
  const localOperations = [...operations];
  const localWarnings = [];
  const workRom = { bytes: new Uint8Array(rom.bytes) };
  const excludedRanges = [...(context.excludedRanges || [])];
  try {
    const payloadSpan = irqHandlerPayloadSpanForLayout();
    const payloadBase = context.payloadOffset ?? ensureDirectPayloadRegion(
      workRom,
      localOperations,
      localWarnings,
      payloadSpan,
      "Shared IRQ",
      excludedRanges,
    );
    if (payloadBase === null) {
      warnings.push(...localWarnings);
      return { requested: true, status: "failed", size: IRQ_HANDLER_PAYLOAD.length };
    }
    excludedRanges.push([payloadBase, payloadBase + payloadSpan]);
    if (payloadBase + IRQ_HANDLER_PAYLOAD.length > workRom.bytes.length) {
      throw new PatchError("Shared IRQ: payload placement is outside the ROM");
    }
    const startupEntrypoint = context.entrypointSource
      ? decodeEntrypointAddress(context.entrypointSource)
      : decodeEntrypointAddress(workRom.bytes);
    const entrypointOffset = startupEntrypoint - GBA_ROM_BASE;
    const startupSites = findArmIrqInstallerSites(workRom.bytes, excludedRanges);
    const postClearSites = findArmPostClearHandoffSites(workRom.bytes, excludedRanges);
    for (const site of findArmEntrypointPostClearHandoffSites(
      workRom.bytes,
      entrypointOffset,
      excludedRanges,
    )) {
      if (!postClearSites.some((candidate) => candidate.branchOffset === site.branchOffset)) {
        postClearSites.push(site);
      }
    }
    const thumbStartupSites = findThumbIrqInstallerSites(workRom.bytes, excludedRanges);
    const hasActiveEntrypointInstaller = startupSites.some((site) => (
      site.storeOffset >= entrypointOffset
      && site.storeOffset <= entrypointOffset + 0x1000
    ));
    const hasActiveThumbReinstaller = thumbStartupSites.some((site) => (
      site.storeOffset >= entrypointOffset
      && site.storeOffset <= entrypointOffset + 0x20000
    ));
    const startupCallbackEntry = hasActiveEntrypointInstaller && hasActiveThumbReinstaller
      ? (options.startupCallbackEntry || 0)
      : 0;
    const configured = configuredIrqPayload(workRom.bytes, payloadBase, {
      ...options,
      startupCallbackEntry,
    });
    stageIrqWrite(workRom.bytes, localOperations, "Shared IRQ payload", payloadBase, configured.payload, {
      kind: PATCH_OPERATION_KIND.PAYLOAD_INSTALL,
      codeName: "shared_irq_handler",
      value: configured.payloadAddress,
    });
    writeIrqHandlerRomMarker(workRom.bytes, localOperations, payloadBase);
    const startupHookResult = installArmIrqStartupHooks(
      workRom.bytes,
      localOperations,
      startupSites,
      payloadBase,
      configured.installHandlerAddress,
    );
    const postClearHooks = installArmPostClearHooks(
      workRom.bytes,
      localOperations,
      postClearSites,
      payloadBase,
      configured.installHandlerAddress,
      startupHookResult.nextStubOffset,
    );

    // Whole-ROM scans can find an ARM installer in an inactive multicart
    // image. Only add the reset bootstrap when no proven installer belongs to
    // the entrypoint's own nearby startup context.
    const entrypointHook = !hasActiveEntrypointInstaller;
    if (entrypointHook) {
      const entrypointBranch = encodeArmBranch(GBA_ROM_BASE, configured.bootstrapAddress);
      const entrypointBytes = new Uint8Array(4);
      writeU32(entrypointBytes, 0, entrypointBranch);
      stageIrqWrite(workRom.bytes, localOperations, "Shared IRQ Entrypoint", 0, entrypointBytes, {
        value: entrypointBranch,
      });
    } else if (startupCallbackEntry && context.entrypointSource?.length >= 4) {
      stageIrqWrite(
        workRom.bytes,
        localOperations,
        "Shared IRQ deferred-startup original entrypoint",
        0,
        context.entrypointSource.slice(0, 4),
        { value: startupEntrypoint },
      );
    }

    const iwramClearPatches = patchUpperIwramDmaFills(
      workRom.bytes,
      localOperations,
      thumbStartupSites,
      excludedRanges,
    );
    const computedIrqReferences = patchComputedIrqVectorReferences(
      workRom.bytes,
      localOperations,
      excludedRanges,
    );
    const irqReferences = computedIrqReferences + patchIrqVectorReferences(
      workRom.bytes,
      localOperations,
      excludedRanges,
    );
    rom.bytes = workRom.bytes;
    operations.push(...localOperations.slice(previousOperationCount));
    warnings.push(...localWarnings);
    return installedIrqResult(
      payloadBase,
      configured,
      irqReferences,
      startupHookResult.count,
      postClearHooks,
      entrypointHook,
      iwramClearPatches,
      startupCallbackEntry,
    );
  } catch (error) {
    localWarnings.push(error.message || String(error));
    warnings.push(...localWarnings);
    return { requested: true, status: "failed", size: IRQ_HANDLER_PAYLOAD.length };
  }
}

export function applyIrqHandlerForPipeline(rom, operations, warnings, options = {}, context = {}) {
  if (!options.enabled) return null;
  return installIrqHandler(rom, operations, warnings, options, context);
}
