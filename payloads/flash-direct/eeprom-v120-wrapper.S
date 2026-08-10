/* SPDX-License-Identifier: GPL-3.0-or-later AND MIT
 *
 * Universal Nintendo SDK EEPROM V120/V121 aftermath wrapper.
 *
 * This code is copied into the original ProgramEepromDword body.  The
 * patcher fills the SDK routine/state literal slots at the end from the
 * semantically validated cluster.  Fixed GBA hardware literals are private
 * compile-time constants.  No title, game code, ROM address, or caller image
 * is part of this ABI.
 */

.syntax unified
.cpu arm7tdmi
.thumb
.section .text
.balign 4

.global eeprom_v120_wrapper_start
.global eeprom_v120_wrapper_end
.global eeprom_v120_setup_address
.global eeprom_v120_cleanup_address
.global eeprom_v120_payload_address
.global eeprom_v120_timer_state_address
.global eeprom_v120_config_address

.thumb_func
eeprom_v120_wrapper_start:
    push    {r4-r7, lr}
    sub     sp, #8
    movs    r4, r0
    movs    r5, r1

    /* The save is authoritative.  Preserve its result across the optional
     * SDK timer aftermath.  The payload stabilizes the eight source bytes
     * before issuing its first FLASH command. */
    ldr     r3, eeprom_v120_payload_address
    bl      .Lcall_r3
    movs    r7, r0

    /* Validate all mutable SDK state before touching IF, IE, IME or a timer. */
    ldr     r1, eeprom_v120_timer_state_address
    ldrb    r0, [r1]
    cmp     r0, #3
    bhi     .Lreturn_result
    movs    r6, #8
    lsls    r6, r6, r0

    lsls    r2, r0, #2
    ldr     r3, .Leeprom_v120_timer_base_address
    adds    r2, r2, r3
    ldr     r3, [r1, #8]
    cmp     r3, r2
    bne     .Lreturn_result
    ldrh    r3, [r1, #2]
    cmp     r3, #0
    bne     .Lreturn_result
    ldr     r3, [r2]
    cmp     r3, #0
    bne     .Lreturn_result
    ldrb    r0, [r1, #4]
    cmp     r0, #0
    bne     .Lreturn_result

    ldr     r1, .Leeprom_v120_if_address
    ldrh    r0, [r1]
    tst     r0, r6
    bne     .Lreturn_result

    /* Save the hardware values that the validated setup may alter.  The
     * original cleanup owns its SDK bookkeeping; these copies make the
     * bounded-timeout hardware restoration explicit. */
    ldr     r1, eeprom_v120_timer_state_address
    ldr     r2, [r1, #8]
    ldr     r0, [r2]
    str     r0, [sp, #0]
    ldr     r2, .Leeprom_v120_ie_address
    ldrh    r0, [r2]
    str     r0, [sp, #4]

    /* Only the selected IF bit is acknowledged; unrelated pending IRQs are
     * preserved.  Setup/cleanup are the original, validated SDK routines. */
    ldr     r1, .Leeprom_v120_if_address
    strh    r6, [r1]
    ldr     r0, eeprom_v120_config_address
    ldr     r3, eeprom_v120_setup_address
    bl      .Lcall_r3

    ldr     r1, .Leeprom_v120_vcount_address
    ldrh    r4, [r1]
    movs    r5, #0

.Lwait:
    ldr     r1, .Leeprom_v120_if_address
    ldrh    r0, [r1]
    tst     r0, r6
    bne     .Lcleanup

    ldr     r1, eeprom_v120_timer_state_address
    ldrh    r0, [r1, #2]
    ldr     r2, eeprom_v120_config_address
    ldrh    r2, [r2]
    cmp     r0, r2
    bne     .Ltimeout
    ldrb    r0, [r1, #4]
    cmp     r0, #0
    bne     .Ltimeout

    /* A wrap followed by the original scanline bounds the wait to one video
     * frame without introducing a synthetic minimum delay. */
    ldr     r1, .Leeprom_v120_vcount_address
    ldrh    r0, [r1]
    cmp     r5, #0
    bne     .Lafter_wrap
    cmp     r0, r4
    bhs     .Lwait
    movs    r5, #1
    b       .Lwait
.Lafter_wrap:
    cmp     r0, r4
    blo     .Lwait
    b       .Ltimeout

.Lcleanup:
    ldr     r3, eeprom_v120_cleanup_address
    bl      .Lcall_r3
    b       .Lreturn_result

.Ltimeout:
    /* Let the SDK undo its normal setup first, then restore the exact
     * pre-setup writable state.  IF is write-one-to-clear, so only our
     * selected bit can be acknowledged; unrelated pending bits survive. */
    ldr     r3, eeprom_v120_cleanup_address
    bl      .Lcall_r3
    ldr     r1, eeprom_v120_timer_state_address
    ldr     r2, [r1, #8]
    ldr     r0, [sp, #0]
    str     r0, [r2]
    ldr     r2, .Leeprom_v120_ie_address
    ldr     r0, [sp, #4]
    strh    r0, [r2]
    ldr     r1, .Leeprom_v120_if_address
    strh    r6, [r1]

.Lreturn_result:
    movs    r0, r7
    add     sp, #8
    pop     {r4-r7}
    pop     {r1}
    bx      r1

.Lcall_r3:
    bx      r3

.balign 4
eeprom_v120_setup_address:
    .word   0
eeprom_v120_cleanup_address:
    .word   0
eeprom_v120_payload_address:
    .word   0
eeprom_v120_timer_state_address:
    .word   0
eeprom_v120_config_address:
    .word   0
.Leeprom_v120_if_address:
    .word   0x04000202
.Leeprom_v120_ie_address:
    .word   0x04000200
.Leeprom_v120_vcount_address:
    .word   0x04000006
.Leeprom_v120_timer_base_address:
    .word   0x04000100
eeprom_v120_wrapper_end:
