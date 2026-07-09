ENTRY(payload_probe)
EXTERN(payload_probe payload_reset payload_getstatus payload_gettimedate fake_rtc_menu_run_runtime)

SECTIONS
{
    . = 0x09000000;
    .text :
    {
        *(.text*)
        *(.rodata*)
        *(.glue_7)
        *(.glue_7t)
    }
    /DISCARD/ :
    {
        *(.ARM.exidx*)
        *(.ARM.extab*)
        *(.comment*)
        *(.note*)
        *(.debug*)
    }
}
