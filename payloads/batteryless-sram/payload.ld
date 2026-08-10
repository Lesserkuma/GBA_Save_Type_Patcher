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
    ASSERT(batteryless_marker >= batteryless_bootvector,
           "Batteryless marker must follow the boot-vector destination")
    ASSERT((batteryless_marker - batteryless_bootvector) <= 0x2000,
           "Batteryless boot-vector destination is more than 0x2000 bytes before the marker")
    ASSERT((batteryless_marker - batteryless_bootvector) == 4,
           "Batteryless ARM boot stub must immediately precede the marker")
    /DISCARD/ :
    {
        *(*)
    }
}
