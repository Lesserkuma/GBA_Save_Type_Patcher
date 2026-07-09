SECTIONS
{
    . = 0x0;

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

    /DISCARD/ :
    {
        *(*);
    }
}
