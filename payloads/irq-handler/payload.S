// SPDX-License-Identifier: GPL-3.0-or-later
//
// Shared GBA user IRQ handler for Fake-RTC and deferred save flushes.
//
// BIOS calls the user handler in ARM state with r0 = 0x04000000.
// [03007FFC] points here, [03007FF4] is kept for the game's original handler.

#include "../common/gba_hw.h"

    .syntax unified
    .arm
    .text
    .align 2

    .equ IRQ_HANDLER_MAGIC, 0x48515249      // "IRQH"
    .equ IRQ_FLAG_RTC, 1
    .equ IRQ_FLAG_SAVE_FLUSH, 2
    .equ IRQ_FLAG_SAVE_FLUSH_AUTO, 4
    .equ IRQ_FLAG_SAVE_FLUSH_HOTKEY, 8
    // Metadata mirrors the host-selected continuous handler entry. The
    // handler does not branch on this flag, keeping Legacy's hot path intact.
    .equ IRQ_FLAG_RTC_VBLANK_TICK, 16
    .equ RTC_STATE_MAGIC, 0x46525443
    .equ RTC_MAX_TIMESTAMP, 0xBC19137F
    .equ KEY_MENU_COMBO_DEFAULT, GBA_KEY_MENU_COMBO_DEFAULT

    .global irq_config_magic
irq_config_magic:
    .word IRQ_HANDLER_MAGIC
    .global irq_original_entrypoint
irq_original_entrypoint:
    .word 0x080000C0
    .global irq_flags
irq_flags:
    .word 0
    .global irq_rtc_menu_entry
irq_rtc_menu_entry:
    .word 0
    .global irq_save_flush_entry
irq_save_flush_entry:
    .word 0
    .global irq_countdown_frames
irq_countdown_frames:
    .word 100
    .global irq_indicator_mode
irq_indicator_mode:
    .word 0
    .global irq_hotkey_mask
irq_hotkey_mask:
    .word KEY_MENU_COMBO_DEFAULT
    .global irq_handler_entry
irq_handler_entry:
    .word 0

    .global irq_bootstrap
    .type irq_bootstrap, %function
irq_bootstrap:
    mov     r0, #GBA_IO_BASE_ADDRESS
    adr     r1, irq_handler_entry
    ldr     r1, [r1]
    str     r1, [r0, #-4]       // [03007FFC] = shared handler
    adr     r1, irq_original_entrypoint
    ldr     pc, [r1]
    .size irq_bootstrap, . - irq_bootstrap

    .global irq_handler
    .type irq_handler, %function
    .global irq_handler_continuous
    .type irq_handler_continuous, %function
irq_handler_continuous:
    stmfd   sp!, {r0-r12, lr}
    mov     r8, r0              // IO base, expected 0x04000000
    adr     r9, irq_flags
    ldr     r10, [r9]

    // Direct Sound can raise IRQs far more often than VBlank.  Polling the
    // hotkey from ROM for every one of those IRQs starves games when WAITCNT
    // selects slow Game Pak timings, so keep the non-VBlank path minimal.
    ldr     r1, [r8, #0x200]    // IE in low half, IF in high half
    tst     r1, #0x00010000     // pending VBlank IRQ?
    beq     irq_chain_original
    tst     r1, #0x00000001     // VBlank IRQ enabled?
    beq     irq_vblank_common   // Preserve existing stale-IF hotkey semantics.

    // One hardware frame contributes exactly 4389/262144 seconds. Scale that
    // fraction by speed on every VBlank, committing every whole second to the
    // timestamp. This spreads fast clocks across frames instead of applying
    // one large speed-sized jump per second. ABORT[SP] caches speed in bits
    // 18..31 and keeps the fractional phase in bits 0..17.
    mov     r1, #0x97           // Abort mode, IRQ disabled
    msr     cpsr_c, r1
    ldr     r2, =RTC_STATE_MAGIC
    cmp     lr, r2
    bne     irq_rtc_tick_restore

    mov     r3, sp, lsr #18     // cached speed
    mov     r1, sp, lsl #14
    mov     r1, r1, lsr #14     // fractional phase
    mov     r2, #0x1100
    add     r2, r2, #0x25       // 0x1100 + 0x25 = 4389
    mul     r2, r3, r2          // per-frame phase scaled by speed
    add     r1, r1, r2
    mov     r2, r1, lsr #18     // whole timestamp seconds to commit
    mov     r1, r1, lsl #14
    mov     r1, r1, lsr #14     // remaining fractional phase
    orr     sp, r1, r3, lsl #18
    cmp     r2, #0
    beq     irq_rtc_tick_restore

    mov     r1, #0x9B           // Undefined mode, IRQ disabled
    msr     cpsr_c, r1
    add     lr, lr, r2          // Commit the whole seconds accrued this frame.
    ldr     r2, =RTC_MAX_TIMESTAMP
    cmp     lr, r2
    movhi   lr, #0              // Wrap to 2000-01-01 00:00:00.

irq_rtc_tick_restore:
    mov     r1, #0x92           // IRQ mode, IRQ disabled
    msr     cpsr_c, r1
    b       irq_vblank_common
    .size irq_handler_continuous, . - irq_handler_continuous

// Legacy Fake RTC and save-only configurations retain the original handler
// entry and therefore execute no additional work on their VBlank hot path.
irq_handler:
    stmfd   sp!, {r0-r12, lr}
    mov     r8, r0              // IO base, expected 0x04000000
    adr     r9, irq_flags
    ldr     r10, [r9]

    ldr     r1, [r8, #0x200]    // IE in low half, IF in high half
    tst     r1, #0x00010000     // pending VBlank IRQ?
    beq     irq_chain_original

irq_vblank_common:
    tst     r10, #(IRQ_FLAG_RTC | IRQ_FLAG_SAVE_FLUSH_HOTKEY)
    beq     irq_check_countdown

    add     r7, r8, #0x100
    ldrh    r1, [r7, #0x30]     // KEYINPUT, active low
    adr     r2, irq_hotkey_mask
    ldr     r2, [r2]
    cmp     r2, #0
    beq     irq_check_countdown
    tst     r1, r2
    bne     irq_check_countdown

    bl      irq_call_original_once

    adr     r0, irq_hotkey_mask
    ldr     r0, [r0]            // RTC consumes the configured combo while paused.
    tst     r10, #IRQ_FLAG_RTC
    blne    irq_call_rtc_menu

    // Persist the value just confirmed in the RTC menu. Save-only setups keep
    // their old behavior because the menu call above is skipped.
    tst     r10, #IRQ_FLAG_SAVE_FLUSH
    beq     irq_hotkey_no_save_flush
    tst     r10, #IRQ_FLAG_SAVE_FLUSH_HOTKEY
    beq     irq_hotkey_no_save_flush
    adr     r0, irq_hotkey_mask
    ldr     r0, [r0]            // Manual callback consumes release while paused.
    bl      irq_call_save_flush
irq_hotkey_no_save_flush:

    bl      irq_wait_hotkey_release
    b       irq_return

irq_check_countdown:
    tst     r10, #IRQ_FLAG_SAVE_FLUSH_AUTO
    beq     irq_chain_original

    ldrh    r1, [r8, #-6]       // [03007FFA] countdown counter
    cmp     r1, #0
    beq     irq_chain_original
    subs    r1, r1, #1
    strh    r1, [r8, #-6]
    bne     irq_chain_original

    mov     r0, #0              // Automatic flush must not wait for a hotkey.
    bl      irq_call_save_flush

irq_chain_original:
    ldr     r1, [r8, #-12]      // [03007FF4] original game handler slot
    cmp     r1, #0
    beq     irq_return
    ldmfd   sp!, {r0-r12, lr}
    ldr     pc, [r0, #-12]

irq_return:
    ldmfd   sp!, {r0-r12, lr}
    bx      lr
    .size irq_handler, . - irq_handler

irq_call_original_once:
    ldr     r1, [r8, #-12]      // [03007FF4] original game handler slot
    cmp     r1, #0
    bxeq    lr

    stmfd   sp!, {r7-r10, lr}
    mov     r0, r8
    mov     lr, pc
    bx      r1
    ldmfd   sp!, {r7-r10, lr}
    mov     r0, r8
    bx      lr

irq_call_save_flush:
    adr     r2, irq_save_flush_entry
    ldr     r12, [r2]
    cmp     r12, #0
    bxeq    lr

    adr     r2, irq_indicator_mode
    ldr     r2, [r2]
    cmp     r2, #1
    moveq   r3, #1
    strheq  r3, [r8, #0x02]     // Green Swap indicator

    mov     r3, #0x9F           // System mode, IRQ disabled
    msr     cpsr_c, r3
    push    {lr}
    adr     r1, irq_wait_save_callback_release
    mov     lr, pc
    bx      r12
    pop     {lr}
    mov     r3, #0x92           // IRQ mode, IRQ disabled
    msr     cpsr_c, r3

    adr     r2, irq_indicator_mode
    ldr     r2, [r2]
    cmp     r2, #1
    ldrheq  r3, [r8, #-6]       // Keep countdown indicator on after a failed/retried flush.
    cmpeq   r3, #0
    strheq  r3, [r8, #0x02]
    bx      lr

irq_call_rtc_menu:
    adr     r2, irq_rtc_menu_entry
    ldr     r1, [r2]
    cmp     r1, #0
    bxeq    lr

    mov     r3, #0x9F           // System mode, IRQ disabled
    msr     cpsr_c, r3
    push    {lr}
    mov     lr, pc
    bx      r1
    pop     {lr}
    mov     r3, #0x92           // IRQ mode, IRQ disabled
    msr     cpsr_c, r3
    bx      lr

// Callback helper for Batteryless SRAM. Its flush keeps the active-low mask
// in r8 and tail-calls here before restoring Direct Sound/DMA. Returning via
// lr resumes the Batteryless restore path. Journal callbacks ignore r1 and
// implement the same lifecycle internally.
irq_wait_save_callback_release:
    cmp     r8, #0
    bxeq    lr
    add     r2, r0, #0x100      // Batteryless keeps r0 at the I/O base here.
1:
    ldrh    r1, [r2, #0x30]
    tst     r1, r8
    beq     1b
    bx      lr

irq_wait_hotkey_release:
    adr     r2, irq_hotkey_mask
    ldr     r2, [r2]
    cmp     r2, #0
    bxeq    lr
    add     r7, r8, #0x100
1:
    ldrh    r1, [r7, #0x30]
    tst     r1, r2
    beq     1b
    bx      lr
