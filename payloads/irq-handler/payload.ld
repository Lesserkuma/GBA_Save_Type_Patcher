/* SPDX-License-Identifier: GPL-3.0-or-later */

SECTIONS
{
    . = 0x0;
    __payload_start = .;
    .text :
    {
        *(.text*)
        *(.rodata*)
    }
    __payload_end = .;
    ASSERT(__payload_start == 0x0, "Shared IRQ payload must link at offset zero")
    /* The host reserves an aligned payload page plus a separate page for its
       installer stubs. Keep the 13-byte marker inside the payload page. */
    ASSERT(__payload_end <= 0x3F0, "Shared IRQ payload exceeds its marker-safe code span")
    ASSERT((__payload_end & 3) == 0, "Shared IRQ payload size must be word aligned")
    /DISCARD/ :
    {
        *(*)
    }
}
