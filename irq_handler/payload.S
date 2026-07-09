// SPDX-License-Identifier: GPL-3.0-or-later
//
// Shared GBA user IRQ handler for Fake-RTC and deferred save flushes.
//
// BIOS calls the user handler in ARM state with r0 = 0x04000000.
// [03007FFC] points here, [03007FF4] is kept for the game's original handler.

    .syntax unified
    .arm
    .text
    .align 2

    .equ IRQ_HANDLER_MAGIC, 0x48515249      // "IRQH"
    .equ IRQ_FLAG_RTC, 1
    .equ IRQ_FLAG_SAVE_FLUSH, 2
    .equ IRQ_FLAG_SAVE_FLUSH_AUTO, 4
    .equ IRQ_FLAG_SAVE_FLUSH_HOTKEY, 8
    .equ KEY_MENU_COMBO_DEFAULT, 0x030C     // L+R+SELECT+START, active low

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
    .word 102
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
    mov     r0, #0x04000000
    adr     r1, irq_handler_entry
    ldr     r1, [r1]
    str     r1, [r0, #-4]       // [03007FFC] = shared handler
    adr     r1, irq_original_entrypoint
    ldr     pc, [r1]
    .size irq_bootstrap, . - irq_bootstrap

    .global irq_handler
    .type irq_handler, %function
irq_handler:
    stmfd   sp!, {r0-r12, lr}
    mov     r8, r0              // IO base, expected 0x04000000
    adr     r9, irq_flags
    ldr     r10, [r9]

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

    tst     r10, #IRQ_FLAG_SAVE_FLUSH
    beq     irq_hotkey_no_save_flush
    tst     r10, #IRQ_FLAG_SAVE_FLUSH_HOTKEY
    beq     irq_hotkey_no_save_flush
    adr     r0, irq_hotkey_mask
    ldr     r0, [r0]            // Manual callback consumes release while paused.
    bl      irq_call_save_flush
irq_hotkey_no_save_flush:

    adr     r0, irq_hotkey_mask
    ldr     r0, [r0]            // RTC consumes the configured combo while paused.
    tst     r10, #IRQ_FLAG_RTC
    blne    irq_call_rtc_menu

    bl      irq_wait_hotkey_release
    b       irq_return

irq_check_countdown:
    ldr     r1, [r8, #0x200]    // IE in low half, IF in high half
    tst     r1, #0x00010000     // pending VBlank IRQ?
    beq     irq_chain_original
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
