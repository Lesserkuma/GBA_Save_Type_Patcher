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
    ASSERT(__payload_end <= 0x200, "Shared IRQ payload exceeds its 512-byte code span")
    ASSERT((__payload_end & 3) == 0, "Shared IRQ payload size must be word aligned")
    /DISCARD/ :
    {
        *(*)
    }
}
