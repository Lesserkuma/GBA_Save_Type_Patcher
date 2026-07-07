// SPDX-License-Identifier: GPL-3.0-or-later
//
// RTC runtime handlers.
//
// The menu is only a boot/configuration front-end. After it has initialized the
// banked CPU registers, the actual RTC handlers run SuperFW-style:
//   - current timestamp in UNDEF[LR]
//   - speed in UNDEF[SP]
//   - no SRAM access
//   - no fixed IWRAM/EWRAM state block
//   - no VRAM/OAM/audio use after the menu has been confirmed
//
// gettimedate is a SuperFW-style Thumb/ARM routine with the day-of-month fixed
// to 1..31.

    .syntax unified

    .equ RTC_STATE_MAGIC, 0x46525443  // same sentinel as rtc_state.S
    .equ RTC_MENU_OPTION_SKIP_SOFT_RESET, 1
    .equ RTC_TICK_SHIFT, 0            // seconds advanced per read/frame = speed
    .equ RTC_MAX_TIMESTAMP, 0xBC19137F // 2099-12-31 23:59:59
    .extern fake_rtc_menu_run
    .extern rtc_menu_options

// --------------------------------------------------------------------------
// Probe: this is the only runtime handler that may open the menu. ABORT[LR]
// records whether the menu has run before; rtc_menu_options decides whether
// that sentinel should skip the menu on soft reset.
// --------------------------------------------------------------------------
    .section .text.payload_probe, "ax", %progbits
    .thumb
    .thumb_func
    .global payload_probe
    .type payload_probe, %function
payload_probe:
    // Check ABORT[LR] sentinel without touching RAM.
    bx      pc
    nop
    .arm
1:
    mrs     r3, cpsr
    mov     r2, #0x97          // Abort mode, IRQ disabled
    msr     cpsr_c, r2
    mov     r2, lr
    msr     cpsr_c, r3
    ldr     r3, =rtc_menu_options
    ldr     r3, [r3]
    tst     r3, #RTC_MENU_OPTION_SKIP_SOFT_RESET
    moveq   r2, #0
    ldr     r3, =RTC_STATE_MAGIC
    cmp     r2, r3
    add     r3, pc, #1
    bx      r3

    .thumb
    beq     2f
    push    {lr}
    bl      fake_rtc_menu_run
    pop     {r1}
    movs    r0, #1
    bx      r1

2:
    movs    r0, #1
    bx      lr
    .size payload_probe, . - payload_probe

// --------------------------------------------------------------------------
// Reset: keep the menu-selected RTC value. Some games call reset during init;
// wiping UNDEF[LR] here would discard the user's menu selection. So this is a
// resource-free success return.
// --------------------------------------------------------------------------
    .section .text.payload_reset, "ax", %progbits
    .thumb
    .thumb_func
    .global payload_reset
    .type payload_reset, %function
payload_reset:
    movs    r0, #1
    bx      lr
    .size payload_reset, . - payload_reset

// --------------------------------------------------------------------------
// GetStatus: SuperFW-style, overwrite only status with 24-hour flag.
// --------------------------------------------------------------------------
    .section .text.payload_getstatus, "ax", %progbits
    .thumb
    .thumb_func
    .global payload_getstatus
    .type payload_getstatus, %function
payload_getstatus:
    movs    r1, #0x40
    strb    r1, [r0, #7]
    movs    r0, #1
    bx      lr
    .size payload_getstatus, . - payload_getstatus

// --------------------------------------------------------------------------
// GetTimeDate: SuperFW-style runtime conversion.
// Input: r0 = SiiRtcInfo*.
// Output: returns 1 and fills year/month/day/hour/min/sec in BCD.
// --------------------------------------------------------------------------
    .section .text.payload_gettimedate, "ax", %progbits
    .thumb
    .thumb_func
    .global payload_gettimedate
    .type payload_gettimedate, %function
payload_gettimedate:
    push    {r4, r5, lr}
    movs    r4, r0

    // Switch to ARM mode to access banked CPU registers.
    bx      pc
    nop

    .arm
1:
    mrs     r3, cpsr
    mov     r2, #0x9B          // Undefined mode, IRQ disabled
    msr     cpsr_c, r2
    add     lr, lr, sp, lsl #RTC_TICK_SHIFT

    // Wrap after 2099-12-31 23:59:59.
    // If the tick goes beyond the valid RTC range, the next visible value is
    // exactly 2000-01-01 00:00:00, not a modulo carry into the new epoch.
    ldr     r2, =RTC_MAX_TIMESTAMP
    cmp     lr, r2
    movhi   lr, #0

    mov     r5, lr
    msr     cpsr_c, r3

    add     r2, pc, #1
    bx      r2

    .thumb
    // seconds
    movs    r1, #60
    bl      div_ts_bcd
    strb    r0, [r4, #6]

    // minutes
    movs    r1, #60
    bl      div_ts_bcd
    strb    r0, [r4, #5]

    // hours
    movs    r1, #24
    bl      div_ts_bcd
    strb    r0, [r4, #4]

    // r5 now contains days since 2000-01-01.
    movs    r0, #0             // year offset from 2000

year_loop:
    movs    r1, #180
    adds    r1, #185           // 365
    adr     r2, months
    lsls    r3, r0, #30        // every 4th year is leap, relative to 2000
    bne     year_not_leap
    adds    r1, #1             // 366
    adds    r2, #12            // leap-year month table
year_not_leap:
    subs    r5, r5, r1
    bcc     year_done
    adds    r0, #1
    b       year_loop

year_done:
    adds    r5, r5, r1         // undo underflow

    // r0 = year offset, r5 = day-of-year, r2 = month table
    bl      bcdconv
    strb    r0, [r4, #0]

    movs    r0, #0             // month index

month_loop:
    ldrb    r1, [r2, r0]
    adds    r0, #1             // month number 1..12
    subs    r5, r5, r1
    bcs     month_loop

    adds    r5, r5, r1         // day offset in month, 0..30

    bl      bcdconv
    strb    r0, [r4, #1]

    movs    r0, r5
    adds    r0, #1             // day-of-month 1..31
    bl      bcdconv
    strb    r0, [r4, #2]

    pop     {r4, r5}
    movs    r0, #1
    pop     {pc}

// Unsigned divide r5 by r1. Quotient stays in r5. Remainder is returned
// as BCD in r0. We intentionally do not use BIOS SWI 0x6 here: that division
// is signed, so timestamps >= 0x80000000 (2068-01-19 03:14:08) become
// negative and break the conversion.
div_ts_bcd:
    movs    r0, #0             // remainder
    movs    r2, #0             // quotient
    movs    r3, #32            // bit counter

udiv_loop:
    lsls    r5, r5, #1         // next dividend bit -> carry
    adcs    r0, r0, r0         // remainder = (remainder << 1) | carry
    lsls    r2, r2, #1         // quotient <<= 1
    cmp     r0, r1
    bcc     udiv_no_sub
    subs    r0, r0, r1
    adds    r2, #1

udiv_no_sub:
    subs    r3, #1
    bne     udiv_loop

    movs    r5, r2             // quotient
    // r0 is the unsigned remainder; fall through to BCD conversion.

// Convert binary number in r0 to BCD.
bcdconv:
    movs    r1, #10
    swi     0x6
    lsls    r0, r0, #4
    orrs    r0, r1
    bx      lr

    .align 2
months:
    .byte   31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31
    .byte   31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31

    .size payload_gettimedate, . - payload_gettimedate
