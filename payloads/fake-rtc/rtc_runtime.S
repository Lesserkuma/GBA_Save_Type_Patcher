// SPDX-License-Identifier: GPL-3.0-or-later
//
// RTC runtime handlers.
//
// The boot path and optional menu initialize the banked CPU registers. The
// actual RTC handlers then run SuperFW-style:
//   - current timestamp in UNDEF[LR]
//   - speed in UNDEF[SP]
//   - continuous-mode VBlank phase in ABORT[SP]
//   - no SRAM access
//   - no fixed IWRAM/EWRAM state block
//   - no VRAM/OAM/audio use after the menu has been confirmed
//
// gettimedate is a SuperFW-style Thumb/ARM routine with the day-of-month fixed
// to 1..31.

    .syntax unified

    .equ RTC_STATE_MAGIC, 0x46525443   // same sentinel as rtc_state.S
    .equ RTC_TICK_MODE_VBLANK, 0
    .equ RTC_TICK_MODE_READ, 1
    .equ RTC_MENU_ON_BOOT_SHOW, 1
    .equ RTC_MAX_TIMESTAMP, 0xBC19137F // 2099-12-31 23:59:59
    .equ GBA_REG_IE, 0x04000200
    .equ GBA_REG_IME_OFFSET, 8
    .equ GBA_IRQ_ORIGINAL_SLOT, 0x03007FF4
    .equ CPSR_MODE_MASK, 0x1F
    .equ CPSR_MODE_USER, 0x10
    .equ CPSR_IRQ_DISABLE, 0x80
    .extern fake_rtc_menu_run
    .extern fake_rtc_initialize_default
    .extern rtc_persist_load
    .extern rtc_persist_flush_initial

// --------------------------------------------------------------------------
// Probe: this is the only runtime handler that may open the boot menu.
// ABORT[LR] records whether RTC initialization has run, so soft resets keep the
// current RTC value and never repeat cold-boot initialization.
// --------------------------------------------------------------------------
    .section .text.payload_probe, "ax", %progbits
    .thumb
    .thumb_func
    .global payload_probe
    .type payload_probe, %function
payload_probe:
    // Check the ABORT[LR] sentinel without touching RAM.
    bx      pc
    nop
    .arm
1:
    mrs     r3, cpsr

    // BIOS SoftReset resumes the game in User mode, while a cold boot enters
    // System mode. User mode cannot select the banked RTC registers: an MSR
    // below would silently leave the mode unchanged and rtc_state_write would
    // later replace the live User SP/LR with RTC data. Read the state through a
    // private one-shot IRQ without changing the interrupted game's CPU mode.
    and     r2, r3, #CPSR_MODE_MASK
    cmp     r2, #CPSR_MODE_USER
    bne     .Lprobe_check_state
    tst     r3, #CPSR_IRQ_DISABLE
    bne     .Lprobe_user_fallback
    stmdb   sp!, {lr}
    mov     r0, #0                    // Snapshot only; probe must not tick.
    ldr     r3, =rtc_user_snapshot
    mov     lr, pc
    bx      r3
    mov     r2, r0                    // Returned ABORT[LR] sentinel.
    ldmia   sp!, {lr}
    b       .Lprobe_compare_state

.Lprobe_check_state:
    mov     r2, #0x97                 // Abort mode, IRQ disabled
    msr     cpsr_c, r2
    mov     r2, lr
    msr     cpsr_c, r3
    b       .Lprobe_compare_state

.Lprobe_user_fallback:
    // A caller that masks IRQs in CPSR cannot use the synchronous bridge. Keep
    // the call non-destructive instead of touching live User SP/LR registers.
    ldr     r2, =RTC_STATE_MAGIC

.Lprobe_compare_state:
    ldr     r3, =RTC_STATE_MAGIC
    cmp     r2, r3
    add     r3, pc, #1
    bx      r3

    .thumb
    beq     2f
    push    {lr}
    // Cold boot: load the checksummed record at the end of the configured
    // writable 256-KiB block first. Show the menu when configured, using
    // restored values when the record was valid and defaults otherwise.
    // Skipping the menu keeps a restored value or initializes the defaults.
    bl      rtc_persist_load
    ldr     r1, =rtc_menu_on_boot_config
    ldr     r1, [r1]
    cmp     r1, #RTC_MENU_ON_BOOT_SHOW
    beq     .Lprobe_show_boot_menu
    cmp     r0, #0
    bne     .Lprobe_boot_ready
    bl      fake_rtc_initialize_default
    b       .Lprobe_boot_ready

.Lprobe_show_boot_menu:
    bl      fake_rtc_menu_run
    // Persist the initial/menu-confirmed state immediately. Normal game-save
    // flushes update the same record later.
    bl      rtc_persist_flush_initial

.Lprobe_boot_ready:
    pop     {r1}
    movs    r0, #1
    bx      r1

2:
    movs    r0, #1
    bx      lr

    .size payload_probe, . - payload_probe

// --------------------------------------------------------------------------
// Privileged snapshot bridge for callers resumed in User mode by BIOS
// SoftReset. The bridge temporarily lets only VBlank through and points the
// shared handler's private original-handler slot at rtc_user_snapshot_irq.
// That IRQ-side stub can read banked state, writes it into this function's
// stack frame, acknowledges IF, and returns to the unchanged User context.
// Input: r0 = 0 for a non-ticking probe, 1 for a GetTimeDate read.
// Output: r0 = init sentinel, r1 = sanitized timestamp.
// --------------------------------------------------------------------------
    .section .text.rtc_user_snapshot, "ax", %progbits
    .arm
    .align 2
    .type rtc_user_snapshot, %function
rtc_user_snapshot:
    stmdb   sp!, {r4-r7, lr}
    sub     sp, sp, #16
    mov     r4, sp                    // Shared IRQ restores this pointer.
    str     r0, [r4, #12]
    mov     r3, #0
    str     r3, [r4, #8]             // Completion flag.

    ldr     r6, =GBA_REG_IE
    ldrh    r7, [r6]
    ldrh    r12, [r6, #GBA_REG_IME_OFFSET]
    strh    r3, [r6, #GBA_REG_IME_OFFSET]

    ldr     r2, =GBA_IRQ_ORIGINAL_SLOT
    ldr     r5, [r2]
    ldr     r3, =rtc_user_snapshot_irq
    str     r3, [r2]

    mov     r3, #1
    strh    r3, [r6]                 // Allow only VBlank during the request.
    strh    r3, [r6, #GBA_REG_IME_OFFSET]
1:
    ldr     r3, [r4, #8]
    cmp     r3, #0
    beq     1b

    mov     r3, #0
    strh    r3, [r6, #GBA_REG_IME_OFFSET]
    ldr     r2, =GBA_IRQ_ORIGINAL_SLOT
    str     r5, [r2]
    strh    r7, [r6]
    strh    r12, [r6, #GBA_REG_IME_OFFSET]

    ldr     r0, [r4]
    ldr     r1, [r4, #4]
    add     sp, sp, #16
    ldmia   sp!, {r4-r7, lr}
    bx      lr
    .size rtc_user_snapshot, . - rtc_user_snapshot

    .section .text.rtc_user_snapshot_irq, "ax", %progbits
    .arm
    .align 2
    .type rtc_user_snapshot_irq, %function
rtc_user_snapshot_irq:
    stmdb   sp!, {r4, r12, lr}
    ldr     r0, [r4, #12]
    ldr     r3, =rtc_snapshot_privileged
    mov     lr, pc
    bx      r3
    str     r1, [r4]                 // ABORT[LR] sentinel
    str     r0, [r4, #4]             // UNDEF[LR] timestamp
    mov     r3, #1
    str     r3, [r4, #8]
    ldr     r1, =GBA_REG_IE
    strh    r3, [r1, #2]             // REG_IF = VBlank
    ldmia   sp!, {r4, r12, lr}
    bx      lr
    .size rtc_user_snapshot_irq, . - rtc_user_snapshot_irq

// Read and optionally advance the banked RTC state from a privileged mode.
// Input: r0 = 0 for snapshot only, nonzero for one legacy read tick.
// Output: r0 = sanitized timestamp, r1 = ABORT[LR] init sentinel.
    .section .text.rtc_snapshot_privileged, "ax", %progbits
    .arm
    .align 2
    .type rtc_snapshot_privileged, %function
rtc_snapshot_privileged:
    mrs     r12, cpsr
    mov     r2, #0x9B                 // Undefined mode, IRQ disabled
    msr     cpsr_c, r2

    cmp     r0, #0
    beq     .Lprivileged_snapshot
    ldr     r2, =rtc_tick_mode_config
    ldr     r2, [r2]
    cmp     r2, #RTC_TICK_MODE_READ
    bne     .Lprivileged_snapshot

    mov     r2, #0x97                 // Abort mode, IRQ disabled
    msr     cpsr_c, r2
    mov     r3, sp, lsr #18           // cached speed
    mov     r1, sp, lsl #14
    mov     r1, r1, lsr #14           // fractional phase
    mov     r2, #0x1100
    add     r2, r2, #0x25             // 4389 phase units per frame
    mul     r2, r3, r2
    add     r1, r1, r2
    mov     r2, r1, lsr #18
    mov     r1, r1, lsl #14
    mov     r1, r1, lsr #14
    orr     sp, r1, r3, lsl #18

    mov     r1, #0x9B                 // Undefined mode, IRQ disabled
    msr     cpsr_c, r1
    add     lr, lr, r2

.Lprivileged_snapshot:
    ldr     r2, =RTC_MAX_TIMESTAMP
    cmp     lr, r2
    movhi   lr, #0
    mov     r0, lr

    mov     r2, #0x97                 // Abort mode, IRQ disabled
    msr     cpsr_c, r2
    mov     r1, lr                    // Read init sentinel as second result.
    msr     cpsr_c, r12
    bx      lr
    .size rtc_snapshot_privileged, . - rtc_snapshot_privileged

// --------------------------------------------------------------------------
// Reset: keep the initialized RTC value. Some games call reset during init;
// wiping UNDEF[LR] here would discard the current value. So this is a
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
// Output: returns 1, fills year/month/day/hour/min/sec in BCD, and writes
// dayOfWeek as 0=Sunday through 6=Saturday.
// --------------------------------------------------------------------------
    .section .text.payload_gettimedate, "ax", %progbits
    .align 2
    .global rtc_tick_mode_config
    .type rtc_tick_mode_config, %object
rtc_tick_mode_config:
    .word   RTC_TICK_MODE_VBLANK
    .size rtc_tick_mode_config, . - rtc_tick_mode_config

    .global rtc_menu_on_boot_config
    .type rtc_menu_on_boot_config, %object
rtc_menu_on_boot_config:
    .word   RTC_MENU_ON_BOOT_SHOW
    .size rtc_menu_on_boot_config, . - rtc_menu_on_boot_config

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
    mrs     r12, cpsr
    and     r2, r12, #CPSR_MODE_MASK
    cmp     r2, #CPSR_MODE_USER
    bne     .Lgettime_privileged
    tst     r12, #CPSR_IRQ_DISABLE
    bne     .Lgettime_zero

    mov     r0, #1                    // GetTimeDate advances legacy mode.
    ldr     r3, =rtc_user_snapshot
    mov     lr, pc
    bx      r3
    ldr     r2, =RTC_STATE_MAGIC
    cmp     r0, r2
    movne   r1, #0
    mov     r5, r1
    b       .Lgettime_to_thumb

.Lgettime_privileged:
    mov     r0, #1
    ldr     r3, =rtc_snapshot_privileged
    mov     lr, pc
    bx      r3
    mov     r5, r0
    b       .Lgettime_to_thumb

.Lgettime_zero:
    mov     r5, #0

.Lgettime_to_thumb:
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
    // SiiRTC stores the weekday as 0=Sunday through 6=Saturday.
    // 2000-01-01 was a Saturday, so add 6 before taking modulo 7.
    movs    r0, r5
    adds    r0, #6
    movs    r1, #7
    swi     0x6
    strb    r1, [r4, #3]

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

// --------------------------------------------------------------------------
// Zodiac/Wizard-derived compact seven-byte RTC adapters.
//
// This RTC family does not expose the four SiiRTC entry points. Its main-loop
// hook polls a cached availability word and asks a separate routine for seven
// raw BCD bytes. The patcher derives the availability and status addresses
// from each ROM's handler cluster and writes them into the config words below.
//
// The availability adapter invokes the regular probe/menu only once per cold
// boot. Subsequent main-loop calls take the inexpensive cached path. SoftReset
// preserves both this game-owned RAM flag and the banked-register RTC state.
// --------------------------------------------------------------------------
    .section .text.payload_zodiac_probe, "ax", %progbits
    .thumb
    .thumb_func
    .global payload_zodiac_probe
    .type payload_zodiac_probe, %function
payload_zodiac_probe:
    push    {r4, lr}
    ldr     r4, =payload_zodiac_available_address_config
    ldr     r4, [r4]
    ldrb    r0, [r4]
    cmp     r0, #0
    bne     1f

    bl      payload_probe
    movs    r0, #1
    strb    r0, [r4]
    ldr     r4, =payload_zodiac_status_address_config
    ldr     r4, [r4]
    movs    r1, #0x40
    strb    r1, [r4]

1:
    movs    r0, #1
    pop     {r4, pc}
    .size payload_zodiac_probe, . - payload_zodiac_probe

// Input: r0 = destination for year/month/day/weekday/hour/minute/second BCD.
// The shared GetTimeDate implementation already writes exactly those seven
// bytes. Its SiiRTC success return is translated to the Zodiac routine's zero.
    .section .text.payload_zodiac_gettimedate, "ax", %progbits
    .thumb
    .thumb_func
    .global payload_zodiac_gettimedate
    .type payload_zodiac_gettimedate, %function
payload_zodiac_gettimedate:
    push    {r4, lr}
    bl      payload_gettimedate
    movs    r0, #0
    pop     {r4, pc}
    .size payload_zodiac_gettimedate, . - payload_zodiac_gettimedate

    .section .text.payload_zodiac_config, "ax", %progbits
    .align 2
    .global payload_zodiac_available_address_config
    .type payload_zodiac_available_address_config, %object
payload_zodiac_available_address_config:
    .word   0
    .size payload_zodiac_available_address_config, . - payload_zodiac_available_address_config

    .global payload_zodiac_status_address_config
    .type payload_zodiac_status_address_config, %object
payload_zodiac_status_address_config:
    .word   0
    .size payload_zodiac_status_address_config, . - payload_zodiac_status_address_config
