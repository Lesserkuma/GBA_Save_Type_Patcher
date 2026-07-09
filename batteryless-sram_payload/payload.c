/*
 * Batteryless SRAM runtime payload for GBA Save Type Patcher.
 *
 * This payload is based on metroid-maniac's gba-auto-batteryless-patcher:
 * https://github.com/metroid-maniac/gba-auto-batteryless-patcher
 *
 * Original author: Metroid Maniac / metroid-maniac
 * Original license: MIT License
 * Original copyright: Copyright (c) 2023 Metroid Maniac
 *
 * The original project is licensed under the MIT License. Keep this notice
 * with this source file when redistributing modified or unmodified versions.
 */

    #define AGB_ROM  ((unsigned char*)0x8000000)
    #define AGB_SRAM ((volatile unsigned char*)0xE000000)
    #define SRAM_SIZE 64
	#define AGB_SRAM_SIZE (SRAM_SIZE*1024)
    #define AGB_SRAM_WINDOWED(i) (AGB_SRAM + ((i) & (AGB_SRAM_SIZE - 1)))
    #define SRAM_BANK_SEL8  (*(volatile unsigned char*)  0x09000000)
    #define SRAM_BANK_SEL16 (*(volatile unsigned short*) 0x09000000)

    #define SRAM_BANK_SWITCH_STYLE_MODERN 0
    #define SRAM_BANK_SWITCH_STYLE_GBATA  1
    #ifndef SRAM_BANK_SWITCH_STYLE
    #define SRAM_BANK_SWITCH_STYLE SRAM_BANK_SWITCH_STYLE_MODERN
    #endif

    static inline void sram_bank_select(unsigned bank_no)
    {
    #if SRAM_BANK_SWITCH_STYLE == SRAM_BANK_SWITCH_STYLE_GBATA
        SRAM_BANK_SEL16 = 0x8000;
        SRAM_BANK_SEL16 = (unsigned short)(bank_no << 11);
    #else
        SRAM_BANK_SEL8 = (unsigned char)bank_no;
    #endif
    }
    
	#define _FLASH_WRITE(pa, pd) { *(((unsigned short *)AGB_ROM)+((pa)/2)) = pd; __asm("nop"); }

asm(R"(.text

original_entrypoint:
    .word 0x080000c0
flush_mode:
    .word 0
save_size:
    .word 0x20000
    .word patched_entrypoint
    .word write_sram_patched + 1
    .word write_eeprom_patched + 1
    .word write_flash_patched + 1
    .word write_eeprom_v111_posthook + 1
    .word sram_bank_select_payload_entry + 1
storage_mode:
    .word 0
indicator_mode:
    .word 0
flush_sram_entry:
    .word flush_sram

.thumb
# If you are writing a manual batteryless save patch, you can branch here
# Return via LR, only LR is trashed

.type flush_sram_manual_entry, %function
flush_sram_manual_entry:
    push {r0, r1, r2, r3, r4}
    push {lr}

    ldr r4, =0x04000208
    ldrh r0, [r4]
    push {r0}
    mov r0, # 0
    strh r0, [r4]

    adr r0, flush_sram_manual_entry_ref
    ldr r1, [r0]
    add r0, r1
    mov lr, pc
    bx r0

    pop {r0}
    strh r0, [r4]

    pop {r0}
    mov lr, r0
    pop {r0, r1, r2, r3, r4}
# feel free to put any housekeeping before you return to your injected branch here
    bx lr
.balign 4
flush_sram_manual_entry_ref:
    .word flush_sram_no_hotkey - flush_sram_manual_entry_ref
.ltorg

.thumb
.type sram_bank_select_payload_entry, %function
sram_bank_select_payload_entry:
    push {r0, r1, r2, r3, r4}
    push {lr}
    bl install_sram_bank_select_tail_thumb
    ldr r0, [sp, # 4]
    ldr r3, =0x0203fc01
    bl sram_bank_select_bx_r3
    pop {r0}
    mov lr, r0
    pop {r0, r1, r2, r3, r4}
    bx lr

sram_bank_select_bx_r3:
    bx r3

install_sram_bank_select_tail_thumb:
    push {r0, r1, r2, r3}
    adr r0, sram_bank_select_tail_start
    adr r2, sram_bank_select_tail_end
    ldr r1, =0x0203fc00
1:
    ldrb r3, [r0]
    strb r3, [r1]
    add r0, # 1
    add r1, # 1
    cmp r0, r2
    blo 1b
    pop {r0, r1, r2, r3}
    bx lr

.balign 4
# Keep this tail exactly 24 bytes. The web patcher replaces it with a
# GBATA-style tail when SRAM Options -> 1M Bank Switch is set to GBATA-style.
sram_bank_select_tail_start:
    .hword 0x4a04
    .hword 0x2800
    .hword 0xd002
    .hword 0x2101
    .hword 0x7011
    .hword 0x4770
    .hword 0x2100
    .hword 0x7011
    .hword 0x4770
    .hword 0x46c0
    .hword 0x0000
    .hword 0x0900
sram_bank_select_tail_end:

.ltorg

.arm
sram_bank_select_arm_r4:
    stmfd sp!, {r0, r1, r2, r3, lr}
    adr r0, sram_bank_select_tail_start
    adr r2, sram_bank_select_tail_end
    ldr r1, =0x0203fc00
1:
    ldrb r3, [r0], # 1
    strb r3, [r1], # 1
    cmp r0, r2
    blo 1b
    mov r0, r4
    ldr r3, =0x0203fc01
    mov lr, pc
    bx r3
    ldmfd sp!, {r0, r1, r2, r3, lr}
    bx lr

.ltorg

.arm
eeprom_v111_pack_sram_raw:
    stmfd sp!, {r0, r1, r2, r3, r4, r5, lr}
    mov r0, # 0x0e000000
    mov r1, # 0x0e000000
    add r1, r1, # 0x200
    mov r2, # 0x0e000000
    mov r5, # 0xfe
    lsl r5, r5, # 8
    add r2, r2, r5
    mov r4, # 0
    mov r5, # 2
    lsl r5, r5, # 8
1:
    ldrb r3, [r0]
    strb r3, [r2], # 1
    ldrb r3, [r1, # 14]
    strb r3, [r0], # 1
    add r1, r1, # 16
    add r4, r4, # 1
    cmp r4, r5
    blo 1b
    ldmfd sp!, {r0, r1, r2, r3, r4, r5, lr}
    bx lr

eeprom_v111_restore_sram_header:
    stmfd sp!, {r0, r1, r2, r3, r4, lr}
    mov r0, # 0x0e000000
    mov r1, # 0x0e000000
    mov r2, # 0xfe
    lsl r2, r2, # 8
    add r1, r1, r2
    mov r2, # 0
    mov r4, # 2
    lsl r4, r4, # 8
1:
    ldrb r3, [r1], # 1
    strb r3, [r0], # 1
    add r2, r2, # 1
    cmp r2, r4
    blo 1b
    ldmfd sp!, {r0, r1, r2, r3, r4, lr}
    bx lr

eeprom_v111_expand_sram_raw:
    stmfd sp!, {r0, r1, r2, r3, r4, r5, r6, lr}
    mov r0, # 0x0e000000
    mov r1, # 0x0e000000
    add r1, r1, # 0x200
    mov r2, # 0
    mov r5, # 0
    mov r6, # 2
    lsl r6, r6, # 8
1:
    ldrb r3, [r0], # 1
    mov r4, # 8
2:
    lsl r5, r5, # 1
    orr r5, r5, r3, lsr # 7
    and r5, r5, # 0xff
    strb r5, [r1], # 1
    mov lr, # 0xff
    strb lr, [r1], # 1
    lsl r3, r3, # 1
    subs r4, r4, # 1
    bne 2b
    add r2, r2, # 1
    cmp r2, r6
    blo 1b
    ldmfd sp!, {r0, r1, r2, r3, r4, r5, r6, lr}
    bx lr

.ltorg

patched_entrypoint:
    mov r1, # 0x0e000000
    # Lock 369in1 mapper
    mov r4, # 0x80
    strb r4, [r1, # 3]
    mov r4, # 0
    bl sram_bank_select_arm_r4
    bl flush_dirty_sram_on_boot

    adrl r0, flash_save_sector
    mov r1, # 0x0e000000
    ldr r2, save_size
    mov r5, # 0
sram_init_loop:
    ldrb r4, [r0], # 1
    strb r4, [r1], # 1
    add r5, # 1
    cmp r5, r2
    bhs sram_init_done
    mov r4, # 1
    lsl r4, # 16
    cmp r5, r4
    bne sram_init_continue
    sub r1, r1, r4
    mov r4, # 1
    bl sram_bank_select_arm_r4
sram_init_continue:
    b sram_init_loop
sram_init_done:
    ldr r4, storage_mode
    cmp r4, # 1
    blne sram_init_storage_done
    bl eeprom_v111_expand_sram_raw
sram_init_storage_done:
    
    # Set bank to 0 for banking-unaware software
    mov r4, # 0
    bl sram_bank_select_arm_r4

    ldr pc, original_entrypoint

.thumb
# r0 = sector number, # r1 = source data 0x1000 bytes

.type write_flash_patched, %function
write_flash_patched:
    mov r3, r0
    lsr r3, # 4
    lsl r0, # 12
	mov r2, # 0x0e
	lsl r2, # 24
	orr r0, r2
    cmp r3, # 0
    beq 1f
    mov r2, # 0x0f
    lsl r2, # 16
    add r0, r2
1:
	mov r2, # 0x1
	lsl r2, # 12
	mov r3, r0
	mov r0, r1
	mov r1, r3
	
	b write_sram_patched


# r0 = src, r1 = dst, r2 = size. Check if change before writing, only install irq if change
# unoptimised as hell, but I don't care for now.

.type write_sram_patched, %function
write_sram_patched:
    push {lr}
    push {r4, r5, r6, r7}

    # Only mapper selection and arming the first dirty write need to be
    # atomic. Keeping IME disabled for a complete 32/64 KiB copy starves
    # Direct Sound games such as Kururin long enough to expose stale samples.
    ldr r6, =0x04000208
    ldrh r7, [r6]
    mov r3, # 0
    strh r3, [r6]
    
    # Writes will never span both SRAM banks, so only needed to write once.
    lsr r5, r1, # 20
    mov r3, # 1
    and r5, r3
    push {r0}
    mov r0, r5
    bl sram_bank_select_payload_entry
    pop {r0}
    push {r5}
    cmp r5, # 0
    beq 1f
    mov r3, # 0x10
    lsl r3, # 16
    sub r1, r3
1:
    mov r3, # 0
    strh r7, [r6]
    
    add r2, r0
write_sram_patched_loop:
    # Check if the each byte to write to sram is different - if it is, write it then set a flag
    ldrb r4, [r0]
    ldrb r5, [r1]
    cmp r4, r5
    beq write_sram_patched_skip_byte
    cmp r3, # 0
    bne write_sram_patched_store_byte

    # The first changed byte starts a new dirty interval. Re-select the SRAM
    # bank and reset the auto-flush countdown before allowing that byte to
    # become visible to the Shared IRQ handler.
    mov r3, # 1
    mov r5, # 0
    strh r5, [r6]
    ldr r5, [sp]
    push {r0}
    mov r0, r5
    bl sram_bank_select_payload_entry
    pop {r0}

    push {r0, r1}
    adr r0, write_sram_patched_flush_mode_ref
    ldr r1, [r0]
    add r0, r1
    ldrh r0, [r0]
    cmp r0, # 0
    bne write_sram_patched_first_change_armed
    bl install_countdown_handler
write_sram_patched_first_change_armed:
    pop {r0, r1}
    strh r7, [r6]

write_sram_patched_store_byte:
    strb r4, [r1]
write_sram_patched_skip_byte:
    add r0, # 1
    add r1, # 1
    cmp r0, r2
    blo write_sram_patched_loop

    b write_sram_patched_exit

    .balign 4
write_sram_patched_flush_mode_ref:
    .word flush_mode - write_sram_patched_flush_mode_ref

write_sram_patched_exit:
    strh r7, [r6]
    add sp, # 4
    mov r0, # 0
    pop {r4, r5, r6, r7}
    pop {r1}
    bx r1

    .ltorg

# r0 = eeprom address, r1 = src data (needs byte swapping, 8 bytes)

.type write_eeprom_patched, %function
write_eeprom_patched:
    push {lr}
    push {r4, r5}

    # Match the normal EEPROM->SRAM patch exactly: SRAM offset is
    # (u16)eeprom_address << 3, and the 8 bytes are written in reverse order.
    lsl r0, # 16
    mov r2, r1
    lsr r0, # 13
    mov r1, # 0x0e
    lsl r1, # 24
    add r1, r0
    add r1, # 7
    mov r3, # 0
    mov r5, # 0
write_eeprom_patched_loop:
    ldrb r0, [r2]
    ldrb r4, [r1]
    cmp r0, r4
    beq write_eeprom_patched_skip_byte
    mov r5, # 1
    strb r0, [r1]
write_eeprom_patched_skip_byte:
    add r3, # 1
    add r2, # 1
    sub r1, # 1
    cmp r3, # 7
    bls write_eeprom_patched_loop

    cmp r5, # 0
    beq write_eeprom_patched_exit

    adr r0, write_eeprom_patched_flush_mode_ref
    ldr r1, [r0]
    add r0, r1
    ldrh r0, [r0]
    cmp r0, # 0
    bne write_eeprom_patched_exit

    bl install_countdown_handler

write_eeprom_patched_exit:
    mov r0, # 0
    pop {r4, r5}
    pop {r1}
    bx r1

    .balign 4
write_eeprom_patched_flush_mode_ref:
    .word flush_mode - write_eeprom_patched_flush_mode_ref


.type write_eeprom_patched, %function
write_eeprom_v111_posthook:
    push {r0}
    bl install_countdown_handler
    pop {r0}
    bx r0
    
install_countdown_handler:
    push {r0, r1, r2, r3, r4, r5, r6, r7}
    push {lr}
    mov r2, # 102
    cmp r2, # 0
    bne install_countdown_use_configured
    bl mark_dirty_sram_on_softreset
    mov r2, # 1

install_countdown_use_configured:
    mov r1, # 0x04
    lsl r1, # 24
    sub r1, # 0x10
    strh r2, [r1, # 0x0a]
    adr r0, install_countdown_indicator_mode_ref
    ldr r3, [r0]
    add r0, r3
    ldr r0, [r0]
    cmp r0, # 1
    bne install_countdown_no_indicator
    mov r0, # 1
    strh r0, [r1, # 0x12]
install_countdown_no_indicator:

    pop {r0}
    mov lr, r0
    pop {r0, r1, r2, r3, r4, r5, r6, r7}
    bx lr

mark_dirty_sram_on_softreset:
    adr r0, mark_dirty_sram_save_size_ref
    ldr r1, [r0]
    add r0, r1
    ldr r0, [r0]
    mov r1, # 1
    lsl r1, r1, # 15
    cmp r0, r1
    bhi mark_dirty_sram_done
    mov r0, # 0x0e
    lsl r0, r0, # 24
    mov r1, # 0xfd
    lsl r1, r1, # 8
    add r0, r0, r1
    mov r1, # 0x42
    strb r1, [r0, # 0]
    mov r1, # 0x4c
    strb r1, [r0, # 1]
    mov r1, # 0x44
    strb r1, [r0, # 2]
    mov r1, # 0x30
    strb r1, [r0, # 3]
mark_dirty_sram_done:
    bx lr

    .balign 4
mark_dirty_sram_save_size_ref:
    .word save_size - mark_dirty_sram_save_size_ref
install_countdown_indicator_mode_ref:
    .word indicator_mode - install_countdown_indicator_mode_ref

    .ltorg

.arm
flush_dirty_sram_on_boot:
    stmfd sp!, {r0, r1, r2, r3, r4, lr}
    ldr r0, save_size
    mov r1, # 1
    lsl r1, r1, # 15
    cmp r0, r1
    bhi flush_dirty_sram_boot_done
    mov r4, # 0x0e000000
    mov r0, # 0xfd
    lsl r0, r0, # 8
    add r4, r4, r0
    ldrb r0, [r4, # 0]
    cmp r0, # 0x42
    bne flush_dirty_sram_boot_done
    ldrb r0, [r4, # 1]
    cmp r0, # 0x4c
    bne flush_dirty_sram_boot_done
    ldrb r0, [r4, # 2]
    cmp r0, # 0x44
    bne flush_dirty_sram_boot_done
    ldrb r0, [r4, # 3]
    cmp r0, # 0x30
    bne flush_dirty_sram_boot_done
    bl flush_sram_no_hotkey
    mov r0, # 0
    strb r0, [r4, # 0]
    strb r0, [r4, # 1]
    strb r0, [r4, # 2]
    strb r0, [r4, # 3]
flush_dirty_sram_boot_done:
    ldmfd sp!, {r0, r1, r2, r3, r4, lr}
    bx lr

# Ensure interrupts are disabled and there is plenty of stack space before calling
.global flush_sram
flush_sram:
    stmfd sp!, {r8, r9}
    mov r8, r0
    mov r9, r1
    mov r0, # 0x04000000
    ldr r1, indicator_mode
    cmp r1, # 2
    bne flush_sram_no_enable_save_indicator
    mov r1, # 1
    strh r1, [r0, # 0x02]
flush_sram_no_enable_save_indicator:

    # Pause Direct Sound before issuing flash commands. Keep FIFO reset bits
    # clear when saving/restoring SOUNDCNT_H; they are write-only triggers.
    ldrh r3, [r0, # 0x0080]
    push {r3}
    ldrh r3, [r0, # 0x0082]
    mov r2, # 0x88
    lsl r2, # 8
    bic r3, r2
    push {r3}
    add r12, r0, # 0x0100
    ldrh r3, [r12, # 0x02]
    push {r3}
    ldrh r3, [r12, # 0x06]
    push {r3}

    ldrh r3, [r0, # 0x0082]
    mov r2, # 0x88
    lsl r2, # 8
    bic r3, r2
    mov r1, # 0
    mov r2, # 0x03
    lsl r2, # 8
    tst r3, r2
    beq flush_sram_audio_no_a
    mov r2, # 0x04
    lsl r2, # 8
    tst r3, r2
    moveq r1, # 1
    movne r1, # 2
flush_sram_audio_no_a:
    mov r2, # 0x30
    lsl r2, # 8
    tst r3, r2
    beq flush_sram_audio_no_b
    mov r2, # 0x40
    lsl r2, # 8
    tst r3, r2
    orreq r1, r1, # 1
    orrne r1, r1, # 2
flush_sram_audio_no_b:
    push {r1}

    mov r2, # 0x33
    lsl r2, # 8
    bic r3, r3, r2
    strh r3, [r0, # 0x0082]
    mov r2, # 0
    strh r2, [r0, # 0x0080]

    mov r2, # 0x80
    tst r1, # 1
    beq flush_sram_audio_no_stop_tm0
    ldrh r3, [r12, # 0x02]
    bic r3, r3, r2
    strh r3, [r12, # 0x02]
flush_sram_audio_no_stop_tm0:
    tst r1, # 2
    beq flush_sram_audio_no_stop_tm1
    ldrh r3, [r12, # 0x06]
    bic r3, r3, r2
    strh r3, [r12, # 0x06]
flush_sram_audio_no_stop_tm1:

    # save DMAs state then disable non-sound DMAs
    ldrh r3, [r0, # 0x00BA]
    push {r3}
    strh r0, [r0, # 0x00BA]
    ldrh r3, [r0, # 0x00C6]
    push {r3}
    mov r2, # 0x80
    lsl r2, # 8
    tst r3, r2
    beq 1f
    mov r2, # 0x30
    lsl r2, # 8
    mov r1, r3
    and r1, r2
    cmp r1, r2
    beq 2f
1:
    strh r0, [r0, # 0x00C6]
2:
    ldrh r3, [r0, # 0x00d2]
    push {r3}
    mov r2, # 0x80
    lsl r2, # 8
    tst r3, r2
    beq 3f
    mov r2, # 0x30
    lsl r2, # 8
    mov r1, r3
    and r1, r2
    cmp r1, r2
    beq 4f
3:
    strh r0, [r0, # 0x00d2]
4:
    ldrh r3, [r0, # 0x00de]
    push {r3}
    strh r0, [r0, # 0x00de]

    push {lr}
    
    # Try flushing for various flash chips
    push {r4, r5, r6, r7}
    adrl r4, flash_save_sector
    sub r4, # 0x08000000
    ldr r5, save_size
    ldr r0, storage_mode
    cmp r0, # 1
    blne flush_sram_no_pack
    bl eeprom_v111_pack_sram_raw
flush_sram_no_pack:
    adr r6, flash_fn_table 
    adrl r7, original_entrypoint 
    
try_flash:

    ldm r6!, {r2, r3}
    cmp r2, # 0
    beq flush_sram_done
    add r2, r7
    add r3, r7
    bl run_from_ram
    cmp r0, #0
    bne found_flash
    add r6, # 16
    b try_flash
    
found_flash:
    ldm r6!, {r2, r3}
    mov r0, r4
    mov r1, r5
    add r2, r7
    add r3, r7
    bl run_from_ram
    ldm r6!, {r2, r3}
    mov r0, r4
    mov r1, r5
    add r2, r7
    add r3, r7
    bl run_from_ram
    bl flush_sram_mark_success

flush_sram_done:
    ldr r0, storage_mode
    cmp r0, # 1
    blne flush_sram_no_restore
    bl eeprom_v111_restore_sram_header
flush_sram_no_restore:
    pop {r4, r5, r6, r7}

    mov r0, #0x04000000
    bl flush_sram_finish_indicator_and_wait
    pop {lr}

    # restore DMAs state
    pop {r3}
    strh r3, [r0, # 0x00de]
    pop {r3}
    mov r2, # 0x80
    lsl r2, # 8
    tst r3, r2
    beq 5f
    mov r2, # 0x30
    lsl r2, # 8
    mov r1, r3
    and r1, r2
    cmp r1, r2
    beq 6f
5:
    strh r3, [r0, # 0x00d2]
6:
    pop {r3}
    mov r2, # 0x80
    lsl r2, # 8
    tst r3, r2
    beq 7f
    mov r2, # 0x30
    lsl r2, # 8
    mov r1, r3
    and r1, r2
    cmp r1, r2
    beq 8f
7:
    strh r3, [r0, # 0x00c6]
8:
    pop {r3}
    strh r3, [r0, # 0x00ba]

    # Restore sound controls before restarting timers; DMA controls are already
    # back in their previous state at this point.
    pop {r1}
    pop {r2}
    pop {r3}
    pop {r12}
    strh r12, [r0, # 0x0082]
    pop {r12}
    strh r12, [r0, # 0x0080]

    add r12, r0, # 0x0100
    tst r1, # 2
    beq flush_sram_audio_no_restore_tm1
    strh r2, [r12, # 0x06]
flush_sram_audio_no_restore_tm1:
    tst r1, # 1
    beq flush_sram_audio_no_restore_tm0
    strh r3, [r12, # 0x02]
flush_sram_audio_no_restore_tm0:

    ldmfd sp!, {r8, r9}
    bx lr
    
flash_fn_table:
.word identify_flash_1
.word identify_flash_1_end
.word erase_flash_1
.word erase_flash_1_end
.word program_flash_1
.word program_flash_1_end
.word identify_flash_4
.word identify_flash_4_end
.word erase_flash_4
.word erase_flash_4_end
.word program_flash_4 
.word program_flash_4_end
.word identify_flash_2
.word identify_flash_2_end
.word erase_flash_2
.word erase_flash_2_end
.word program_flash_2
.word program_flash_2_end
.word identify_flash_3
.word identify_flash_3_end
.word erase_flash_3 
.word erase_flash_3_end
.word program_flash_3
.word program_flash_3_end
.zero 12

run_from_ram:
    push {r4, r5, lr}
    mov r4, sp
    bic r2, # 1
    
run_from_ram_loop:    
    ldr r5, [r3, # -4]!
    push {r5}
    cmp r2, r3
    bne run_from_ram_loop
    
    add r2, sp, # 1
    mov lr, pc
    bx r2
    
    mov sp, r4
    pop {r4, r5, lr}
    bx lr
)");

int identify_flash_1()
{
    unsigned rom_data, data;
	//stop_dma_interrupts();
	rom_data = *(unsigned *)AGB_ROM;
	
	// Type 1 or 4
	_FLASH_WRITE(0, 0xFF);
	_FLASH_WRITE(0, 0x90);
	data = *(unsigned *)AGB_ROM;
	_FLASH_WRITE(0, 0xFF);
	if (rom_data != data) {
		// Check if the chip is responding to this command
		// which then needs a different write command later
		_FLASH_WRITE(0x59, 0x42);
		data = *(unsigned char *)(AGB_ROM+0xB2);
		_FLASH_WRITE(0x59, 0x96);
		_FLASH_WRITE(0, 0xFF);
		if (data != 0x96) {
			//resume_interrupts();
            	
            for (volatile int i = 0; i < 1024; ++i)
                __asm("nop");
            
            
			return 0;
		}
		//resume_interrupts();
		return 1;
	}
    return 0;
}
asm("identify_flash_1_end:");

void erase_flash_1(unsigned sa, unsigned save_size)
{
    volatile unsigned timeout;

    // Erase at each possible 64 KiB boundary within a 128 KiB save area.
    for (unsigned i = 0; i < save_size && i < 0x20000; i += AGB_SRAM_SIZE) {
        unsigned erase_addr = sa + i;

        _FLASH_WRITE(erase_addr, 0xFF);
        _FLASH_WRITE(erase_addr, 0x60);
        _FLASH_WRITE(erase_addr, 0xD0);
        _FLASH_WRITE(erase_addr, 0x20);
        _FLASH_WRITE(erase_addr, 0xD0);
        for (timeout = 0x1000000; timeout; --timeout) {
            __asm("nop");
            if (*(((unsigned short *)AGB_ROM)+(erase_addr/2)) == 0x80) {
                break;
            }
        }
        _FLASH_WRITE(erase_addr, 0xFF);
    }
}
asm("erase_flash_1_end:");

void program_flash_1(unsigned sa, unsigned save_size)
{    
    volatile unsigned timeout;

    // Write data
    sram_bank_select(0);
    for (int i=0; i<save_size; i+=2) {
        if (i == AGB_SRAM_SIZE)
            sram_bank_select(1);
        _FLASH_WRITE(sa+i, 0x40);
        _FLASH_WRITE(sa+i, (*(unsigned char *)(AGB_SRAM_WINDOWED(i+1))) << 8 | (*(unsigned char *)(AGB_SRAM_WINDOWED(i))));
        for (timeout = 0x4000; timeout; --timeout) {
            __asm("nop");
            if (*(((unsigned short *)AGB_ROM)+(sa/2)) == 0x80) {
                break;
            }
        }
        if (timeout == 0) {
            _FLASH_WRITE(sa, 0xFF);
            sram_bank_select(0);
            return;
        }
    }
    _FLASH_WRITE(sa, 0xFF);
    sram_bank_select(0);
}
asm("program_flash_1_end:");

int identify_flash_2()
{
    unsigned rom_data, data;
	//stop_dma_interrupts();
	rom_data = *(unsigned *)AGB_ROM;
    
    _FLASH_WRITE(0, 0xF0);
	_FLASH_WRITE(0xAAA, 0xA9);
	_FLASH_WRITE(0x555, 0x56);
	_FLASH_WRITE(0xAAA, 0x90);
	data = *(unsigned *)AGB_ROM;
	_FLASH_WRITE(0, 0xF0);
	if (rom_data != data) {
		//resume_interrupts();
		return 1;
	}
    return 0;
}
asm("identify_flash_2_end:");

void erase_flash_2(unsigned sa, unsigned save_size)
{
    // Erase at each possible 64 KiB boundary within a 128 KiB save area.
    for (unsigned i = 0; i < save_size && i < 0x20000; i += AGB_SRAM_SIZE) {
        unsigned erase_addr = sa + i;

        _FLASH_WRITE(erase_addr, 0xF0);
        _FLASH_WRITE(0xAAA, 0xA9);
        _FLASH_WRITE(0x555, 0x56);
        _FLASH_WRITE(0xAAA, 0x80);
        _FLASH_WRITE(0xAAA, 0xA9);
        _FLASH_WRITE(0x555, 0x56);
        _FLASH_WRITE(erase_addr, 0x30);
        while (1) {
            __asm("nop");
            if (*(((unsigned short *)AGB_ROM)+(erase_addr/2)) == 0xFFFF) {
                break;
            }
        }
        _FLASH_WRITE(erase_addr, 0xF0);
    }
}
asm("erase_flash_2_end:");

void program_flash_2(unsigned sa, unsigned save_size)
{
    // Write data
    sram_bank_select(0);
    for (int i=0; i<save_size; i+=2) {
        if (i == AGB_SRAM_SIZE)
            sram_bank_select(1);
        _FLASH_WRITE(0xAAA, 0xA9);
        _FLASH_WRITE(0x555, 0x56);
        _FLASH_WRITE(0xAAA, 0xA0);
        _FLASH_WRITE(sa+i, (*(unsigned char *)(AGB_SRAM_WINDOWED(i+1))) << 8 | (*(unsigned char *)(AGB_SRAM_WINDOWED(i))));
        while (1) {
            __asm("nop");
            if (*(((unsigned short *)AGB_ROM)+((sa+i)/2)) == ((*(unsigned char *)(AGB_SRAM_WINDOWED(i+1))) << 8 | (*(unsigned char *)(AGB_SRAM_WINDOWED(i))))) {
                break;
            }
        }
    }
    _FLASH_WRITE(sa, 0xF0);
    sram_bank_select(0);
}
asm("program_flash_2_end:");

int identify_flash_3()
{
    unsigned rom_data, data;
	//stop_dma_interrupts();
	rom_data = *(unsigned *)AGB_ROM;
    
    _FLASH_WRITE(0, 0xF0);
	_FLASH_WRITE(0xAAA, 0xAA);
	_FLASH_WRITE(0x555, 0x55);
	_FLASH_WRITE(0xAAA, 0x90);
	data = *(unsigned *)AGB_ROM;
	_FLASH_WRITE(0, 0xF0);
	if (rom_data != data) {
		//resume_interrupts();
        return 1;
	}
    return 0;
}
asm("identify_flash_3_end:");

void erase_flash_3(unsigned sa, unsigned save_size)
{
    // Erase at each possible 64 KiB boundary within a 128 KiB save area.
    for (unsigned i = 0; i < save_size && i < 0x20000; i += AGB_SRAM_SIZE) {
        unsigned erase_addr = sa + i;

        _FLASH_WRITE(erase_addr, 0xF0);
        _FLASH_WRITE(0xAAA, 0xAA);
        _FLASH_WRITE(0x555, 0x55);
        _FLASH_WRITE(0xAAA, 0x80);
        _FLASH_WRITE(0xAAA, 0xAA);
        _FLASH_WRITE(0x555, 0x55);
        _FLASH_WRITE(erase_addr, 0x30);
        while (1) {
            __asm("nop");
            if (*(((unsigned short *)AGB_ROM)+(erase_addr/2)) == 0xFFFF) {
                break;
            }
        }
        _FLASH_WRITE(erase_addr, 0xF0);
    }
}
asm("erase_flash_3_end:");

void program_flash_3(unsigned sa, unsigned save_size)
{
    // Write data
    sram_bank_select(0);
    for (int i=0; i<save_size; i+=2) {
        if (i == AGB_SRAM_SIZE)
            sram_bank_select(1);
        _FLASH_WRITE(0xAAA, 0xAA);
        _FLASH_WRITE(0x555, 0x55);
        _FLASH_WRITE(0xAAA, 0xA0);
        _FLASH_WRITE(sa+i, (*(unsigned char *)(AGB_SRAM_WINDOWED(i+1))) << 8 | (*(unsigned char *)(AGB_SRAM_WINDOWED(i))));
        while (1) {
            __asm("nop");
            if (*(((unsigned short *)AGB_ROM)+((sa+i)/2)) == ((*(unsigned char *)(AGB_SRAM_WINDOWED(i+1))) << 8 | (*(unsigned char *)(AGB_SRAM_WINDOWED(i))))) {
                break;
            }
        }
    }
    _FLASH_WRITE(sa, 0xF0);   
    sram_bank_select(0);
}
asm("program_flash_3_end:");

int identify_flash_4()
{
    unsigned rom_data, data;
	//stop_dma_interrupts();
	rom_data = *(unsigned *)AGB_ROM;
	
	// Type 1 or 4
	_FLASH_WRITE(0, 0xFF);
	_FLASH_WRITE(0, 0x90);
	data = *(unsigned *)AGB_ROM;
	_FLASH_WRITE(0, 0xFF);
	if (rom_data != data) {
		// Check if the chip is responding to this command
		// which then needs a different write command later
		_FLASH_WRITE(0x59, 0x42);
		data = *(unsigned char *)(AGB_ROM+0xB2);
		_FLASH_WRITE(0x59, 0x96);
		_FLASH_WRITE(0, 0xFF);
		if (data != 0x96) {
			//resume_interrupts();
            
            for (volatile int i = 0; i < 1024; ++i)
                __asm("nop");
            
			return 1;
		}
	}
    return 0;
}
asm("identify_flash_4_end:");

void erase_flash_4(unsigned sa, unsigned save_size)
{
    // Erase at each possible 64 KiB boundary within a 128 KiB save area.
    for (unsigned i = 0; i < save_size && i < 0x20000; i += AGB_SRAM_SIZE) {
        unsigned erase_addr = sa + i;

        _FLASH_WRITE(erase_addr, 0xFF);
        _FLASH_WRITE(erase_addr, 0x60);
        _FLASH_WRITE(erase_addr, 0xD0);
        _FLASH_WRITE(erase_addr, 0x20);
        _FLASH_WRITE(erase_addr, 0xD0);
        while (1) {
            __asm("nop");
            if ((*(((unsigned short *)AGB_ROM)+(erase_addr/2)) & 0x80) == 0x80) {
                break;
            }
        }
        _FLASH_WRITE(erase_addr, 0xFF);

        for (volatile int delay = 0; delay < 1024; ++delay)
            __asm("nop");
    }
}
asm("erase_flash_4_end:");

void program_flash_4(unsigned sa, unsigned save_size)
{
    // Write data
    int c = 0;
    sram_bank_select(0);
    while (c < save_size) {
        if (c == AGB_SRAM_SIZE)
            sram_bank_select(1);
        _FLASH_WRITE(sa+c, 0xEA);
        while (1) {
            __asm("nop");
            if ((*(((unsigned short *)AGB_ROM)+((sa+c)/2)) & 0x80) == 0x80) {
                break;
            }
        }
        _FLASH_WRITE(sa+c, 0x1FF);
        for (int i=0; i<1024; i+=2) {
            _FLASH_WRITE(sa+c+i, (*(unsigned char *)(AGB_SRAM_WINDOWED(c+i+1))) << 8 | (*(unsigned char *)(AGB_SRAM_WINDOWED(c+i))));
        }
        _FLASH_WRITE(sa+c, 0xD0);
        while (1) {
            __asm("nop");
            if ((*(((unsigned short *)AGB_ROM)+((sa+c)/2)) & 0x80) == 0x80) {
                break;
            }
        }
        _FLASH_WRITE(sa+c, 0xFF);
        c += 1024;
    }
    
    	
    for (volatile int i = 0; i < 1024; ++i)
        __asm("nop");
    sram_bank_select(0);
}
asm("program_flash_4_end:");

asm(R"(
.arm

# Calls outside the Shared IRQ path do not carry a hotkey mask.
flush_sram_no_hotkey:
    mov r0, # 0
    b flush_sram

# A recognized ROM flash driver completed both erase and program passes.
# Clear the mirrored Shared-IRQ countdown before returning to the common
# finish path, so a manual flush cannot be repeated by the old timer.
flush_sram_mark_success:
    mov r0, # 0x04000000
    mov r1, # 0
    strh r1, [r0, # -0x06]
    ldr r2, indicator_mode
    cmp r2, # 1
    bne flush_sram_mark_success_done
    strh r1, [r0, # 0x02]
flush_sram_mark_success_done:
    bx lr

# r0 = I/O base, r8 = active-low Shared-IRQ combo (zero for automatic calls),
# r9 = Shared-IRQ release-wait helper.
# Finish Green Swap first, then keep Direct Sound/DMA paused until a manual
# combo is no longer held. The outer Shared-IRQ wait remains a fallback.
flush_sram_finish_indicator_and_wait:
    ldr r1, indicator_mode
    cmp r1, # 2
    bne flush_sram_finish_wait
    mov r1, # 0
    strh r1, [r0, # 0x02]

flush_sram_finish_wait:
    cmp r8, # 0
    bxeq lr
    bx r9

# The following footer must come last.
.balign 4
.ascii "thx Maniac"
.byte 0
.byte 0
.ascii "lk_batteryless"
# Size of payload
.hword (.+2)
.balign 4
    flash_save_sector:
.end

)");
