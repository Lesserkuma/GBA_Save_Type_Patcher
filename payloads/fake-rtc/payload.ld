/* SPDX-License-Identifier: GPL-3.0-or-later */

ENTRY(payload_probe)
EXTERN(payload_probe payload_reset payload_getstatus payload_gettimedate fake_rtc_menu_run_runtime)

SECTIONS
{
    . = 0x09000000;
    __payload_start = .;
    .text :
    {
        *(.text*)
        *(.rodata*)
        *(.glue_7)
        *(.glue_7t)
    }
    __payload_end = .;
    ASSERT(__payload_start == 0x09000000, "Fake RTC payload link address changed")
    ASSERT(__payload_end - __payload_start <= 0x10000, "Fake RTC payload exceeds 64 KiB")
    /DISCARD/ :
    {
        *(.ARM.exidx*)
        *(.ARM.extab*)
        *(.comment*)
        *(.note*)
        *(.debug*)
    }
}
