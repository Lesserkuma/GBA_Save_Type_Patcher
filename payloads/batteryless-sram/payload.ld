/* SPDX-License-Identifier: GPL-3.0-or-later AND MIT */

SECTIONS
{
    . = 0x0;
    __payload_start = .;
    /* Everything must be in one section to make relative loads as painless as possible */
    .text :
    {
        *(.text)
    }
    __payload_end = .;
    ASSERT(__payload_start == 0x0, "Batteryless payload must link at offset zero")
    ASSERT(__payload_end <= 0x40000, "Batteryless payload exceeds its 256 KiB block")
    ASSERT((__payload_end & 3) == 0, "Batteryless payload size must be word aligned")
    /DISCARD/ :
    {
        *(*)
    }
}
