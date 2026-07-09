// SPDX-License-Identifier: GPL-3.0-or-later
//
// Fake-RTC volatile runtime state in banked CPU registers.
//
// This follows the same general idea as SuperFW's RTC patch: use otherwise
// unused banked CPU-mode registers instead of reserving IWRAM/EWRAM.
//
// Layout:
//   UNDEF[LR] = current timestamp, seconds since 2000-01-01 00:00:00
//   UNDEF[SP] = speed byte, stored as a word-sized value
//   ABORT[LR] = init sentinel, written after menu confirmation
//
// This is intentionally volatile. It is not meant to survive resets or power
// cycles. No SRAM/backup memory is touched.

    .syntax unified
    .text
    .arm
    .align 2

    .equ RTC_STATE_MAGIC, 0x46525443  // 'CTRF' little-endian bytes

    .global rtc_state_write
    .type rtc_state_write, %function
rtc_state_write:
    // r0 = current timestamp, r1 = speed
    mrs     r2, cpsr

    mov     r3, #0x9B          // Undefined mode, IRQ disabled
    msr     cpsr_c, r3
    mov     lr, r0             // UNDEF[LR] = timestamp
    mov     sp, r1             // UNDEF[SP] = speed

    mov     r3, #0x97          // Abort mode, IRQ disabled
    msr     cpsr_c, r3
    ldr     lr, =RTC_STATE_MAGIC

    msr     cpsr_c, r2
    bx      lr
    .size rtc_state_write, . - rtc_state_write

    .global rtc_state_read_runtime
    .type rtc_state_read_runtime, %function
rtc_state_read_runtime:
    // r0 = uint32_t *timestamp_out, r1 = uint32_t *speed_out
    mrs     r2, cpsr

    mov     r3, #0x9B          // Undefined mode, IRQ disabled
    msr     cpsr_c, r3
    mov     r3, lr             // r3 = UNDEF[LR] timestamp
    mov     r12, sp            // r12 = UNDEF[SP] speed word

    msr     cpsr_c, r2
    str     r3, [r0]
    str     r12, [r1]
    bx      lr
    .size rtc_state_read_runtime, . - rtc_state_read_runtime

    .global rtc_state_read
    .type rtc_state_read, %function
rtc_state_read:
    // r0 = uint32_t *timestamp_out, r1 = uint8_t *speed_out
    // returns 1 if initialized, 0 otherwise.
    push    {r4, r5}
    mrs     r2, cpsr

    mov     r3, #0x97          // Abort mode, IRQ disabled
    msr     cpsr_c, r3
    mov     r4, lr             // r4 = sentinel

    mov     r3, #0x9B          // Undefined mode, IRQ disabled
    msr     cpsr_c, r3
    mov     r3, lr             // r3 = timestamp
    mov     r5, sp             // r5 = speed

    msr     cpsr_c, r2

    ldr     r2, =RTC_STATE_MAGIC
    cmp     r4, r2
    bne     1f

    str     r3, [r0]
    strb    r5, [r1]
    mov     r0, #1
    pop     {r4, r5}
    bx      lr

1:
    mov     r0, #0
    pop     {r4, r5}
    bx      lr
    .size rtc_state_read, . - rtc_state_read

    .global rtc_state_is_initialized
    .type rtc_state_is_initialized, %function
rtc_state_is_initialized:
    mrs     r2, cpsr
    mov     r3, #0x97          // Abort mode, IRQ disabled
    msr     cpsr_c, r3
    mov     r0, lr
    msr     cpsr_c, r2

    ldr     r1, =RTC_STATE_MAGIC
    cmp     r0, r1
    moveq   r0, #1
    movne   r0, #0
    bx      lr
    .size rtc_state_is_initialized, . - rtc_state_is_initialized
