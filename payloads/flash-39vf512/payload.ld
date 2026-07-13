/* SPDX-License-Identifier: GPL-3.0-or-later AND MIT */

SECTIONS
{
    . = 0x0;
    __payload_start = .;

    .journal_header :
    {
        KEEP(*(.journal_header))
    }

    .text ALIGN(4) :
    {
        *(.text)
        *(.text.*)
        *(.rodata)
        *(.rodata.*)
    }

    .journal_ram_code ALIGN(4) :
    {
        HIDDEN(__journal_ram_code_start = .);
        KEEP(*(.journal_ram_code))
        . = ALIGN(4);
        HIDDEN(__journal_ram_code_end = .);
    }

    .flash512k_footer ALIGN(4) :
    {
        KEEP(*(.flash512k_footer))
    }

    __payload_end = .;
    ASSERT(__payload_start == 0x0, "Journal payload must link at offset zero")
    ASSERT(__journal_ram_code_end - __journal_ram_code_start <= 0x800,
        "Journal RAM-code section exceeds 2 KiB")
    ASSERT(__payload_end <= 0x40000, "Journal payload exceeds its 256 KiB block")
    ASSERT((__payload_end & 3) == 0, "Journal payload size must be word aligned")

    /DISCARD/ :
    {
        *(*);
    }
}
