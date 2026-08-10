/* SPDX-License-Identifier: GPL-3.0-or-later AND MIT */

SECTIONS
{
    . = 0x0;
    __payload_start = .;

    .direct_header :
    {
        KEEP(*(.direct_header))
    }

    .text ALIGN(4) :
    {
        *(.text)
        *(.text.*)
        *(.rodata)
        *(.rodata.*)
    }

    .direct_footer ALIGN(4) :
    {
        KEEP(*(.direct_footer))
    }

    __payload_end = .;
    ASSERT(__payload_start == 0x0, "Direct payload must link at offset zero")
    ASSERT(__payload_end <= 0x40000, "Direct payload exceeds its 256 KiB block")
    ASSERT((__payload_end & 3) == 0, "Direct payload size must be word aligned")

    /DISCARD/ :
    {
        *(*);
    }
}
