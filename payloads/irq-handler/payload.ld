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
    /* The payload plus its 13-byte host marker already occupies a 0x300-byte
       aligned ROM span. Keep enough tail room for that marker. */
    ASSERT(__payload_end <= 0x2F0, "Shared IRQ payload exceeds its marker-safe code span")
    ASSERT((__payload_end & 3) == 0, "Shared IRQ payload size must be word aligned")
    /DISCARD/ :
    {
        *(*)
    }
}
