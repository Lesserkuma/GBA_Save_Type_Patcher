// SPDX-License-Identifier: GPL-3.0-or-later
//
// Fake-RTC volatile runtime state in banked CPU registers.
//
// This follows the same general idea as SuperFW's RTC patch: use otherwise
// unused banked CPU-mode registers instead of reserving IWRAM/EWRAM.
//
// Layout:
//   UNDEF[LR] = current timestamp, seconds since 2000-01-01 00:00:00
//   UNDEF[SP] = speed 0..9999, stored as a word-sized value
//   ABORT[LR] = init sentinel, written after menu confirmation
//   ABORT[SP] = cached speed in bits 18..31, sub-second phase in bits 0..17
//
// Soft resets preserve the banked registers. A compact copy can additionally
// be exported to ROM flash and restored after a cold boot by rtc_persist.c.

    .syntax unified
    .text
    .arm
    .align 2

    .equ RTC_STATE_MAGIC, 0x46525443  // 'CTRF' little-endian bytes
    .equ RTC_MAX_SPEED, 9999

    .global rtc_state_write
    .type rtc_state_write, %function
rtc_state_write:
    // r0 = current timestamp, r1 = speed
    mrs     r2, cpsr
    ldr     r3, =RTC_MAX_SPEED
    cmp     r1, r3
    movhi   r1, r3

    mov     r3, #0x9B          // Undefined mode, IRQ disabled
    msr     cpsr_c, r3
    mov     lr, r0             // UNDEF[LR] = timestamp
    mov     sp, r1             // UNDEF[SP] = speed, clamped to 0..9999

    mov     r3, #0x97          // Abort mode, IRQ disabled
    msr     cpsr_c, r3
    mov     sp, r1, lsl #18    // Cache speed and restart at phase zero.
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
    // r0 = uint32_t *timestamp_out, r1 = uint16_t *speed_out
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
    strh    r5, [r1]
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

    .global rtc_state_snapshot_persistent
    .type rtc_state_snapshot_persistent, %function
rtc_state_snapshot_persistent:
    // r0 = uint32_t *timestamp_out, r1 = uint32_t *packed_state_out
    // packed state uses the runtime ABORT[SP] layout:
    //   speed bits 18..31, fixed-point phase bits 0..17.
    // Returns 1 only for initialized, internally consistent state.
    push    {r4, r5, r6}
    mrs     r2, cpsr

    mov     r3, #0x97          // Abort mode, IRQ disabled
    msr     cpsr_c, r3
    mov     r4, lr             // sentinel
    mov     r5, sp             // packed speed/phase

    mov     r3, #0x9B          // Undefined mode, IRQ disabled
    msr     cpsr_c, r3
    mov     r6, lr             // timestamp
    mov     r3, sp             // canonical speed

    msr     cpsr_c, r2

    ldr     r2, =RTC_STATE_MAGIC
    cmp     r4, r2
    bne     1f
    mov     r2, r5, lsr #18
    cmp     r2, r3
    bne     1f
    ldr     r2, =RTC_MAX_SPEED
    cmp     r3, r2
    bhi     1f

    str     r6, [r0]
    str     r5, [r1]
    mov     r0, #1
    pop     {r4, r5, r6}
    bx      lr

1:
    mov     r0, #0
    pop     {r4, r5, r6}
    bx      lr
    .size rtc_state_snapshot_persistent, . - rtc_state_snapshot_persistent

    .global rtc_state_restore_persistent
    .type rtc_state_restore_persistent, %function
rtc_state_restore_persistent:
    // r0 = timestamp, r1 = packed speed/phase. Returns 1 on success.
    mov     r3, r1, lsr #18
    ldr     r2, =RTC_MAX_SPEED
    cmp     r3, r2
    bhi     1f

    mrs     r2, cpsr
    mov     r12, #0x9B         // Undefined mode, IRQ disabled
    msr     cpsr_c, r12
    mov     lr, r0
    mov     sp, r3

    mov     r12, #0x97         // Abort mode, IRQ disabled
    msr     cpsr_c, r12
    mov     sp, r1
    ldr     lr, =RTC_STATE_MAGIC

    msr     cpsr_c, r2
    mov     r0, #1
    bx      lr

1:
    mov     r0, #0
    bx      lr
    .size rtc_state_restore_persistent, . - rtc_state_restore_persistent
