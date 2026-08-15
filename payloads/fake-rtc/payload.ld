/* SPDX-License-Identifier: GPL-3.0-or-later */

ENTRY(payload_probe)
EXTERN(payload_probe payload_reset payload_getstatus payload_gettimedate
       payload_zodiac_probe payload_zodiac_gettimedate
       payload_zodiac_available_address_config payload_zodiac_status_address_config
       fake_rtc_menu_run_runtime)

SECTIONS
{
    . = 0x09000000;
    __payload_start = .;
    .text :
    {
        *(.text*)
        *(.rtc_flash_ram_code)
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
