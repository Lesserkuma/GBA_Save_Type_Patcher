// SPDX-License-Identifier: GPL-3.0-or-later AND MIT

/*
 * ROM-flash drivers for the 512K FLASH journal runtime.
 *
 * Adapted from metroid-maniac/gba-auto-batteryless-patcher:
 * https://github.com/metroid-maniac/gba-auto-batteryless-patcher
 *
 * Original author: Metroid Maniac / metroid-maniac
 * Original license: MIT License
 * Original copyright: Copyright (c) 2023 Metroid Maniac
 *
 * Only Batteryless flash types 1, 2, and 3 are supported here.  Type 4 is
 * intentionally absent.  Each function in this translation unit is copied
 * individually to the GBA stack and executed through the same run_from_ram
 * mechanism as the proven Batteryless payload.  Consequently these functions
 * must not call code or read data outside their own copied function range.
 */

typedef unsigned char uint8_t;
typedef unsigned short uint16_t;
typedef unsigned int uint32_t;

#define ROM_BASE ((volatile uint8_t *)0x08000000u)
#define ROM_HALFWORDS ((volatile uint16_t *)0x08000000u)

#define RAM_CODE __attribute__((section(".journal_ram_code"), aligned(4), noinline, used))

typedef struct {
    const uint8_t *source;
    uint32_t count;
} RomProgramBatch;

static inline __attribute__((always_inline)) void flash_write(uint32_t byte_offset, uint16_t value)
{
    ROM_HALFWORDS[byte_offset >> 1] = value;
    __asm volatile("nop");
}

#ifdef CUSTOM_SAVE_BACKEND
/*
 * Custom cartridge A24 decoding treats every ROM write in 0x09xxxxxx as a
 * Save-FLASH bank selection.  This cleanup is inlined into each independently
 * copied RAM driver, after the ROM chip has returned to read-array mode.
 */
static inline __attribute__((always_inline)) void custom_restore_save_bank_zero(void)
{
    *(volatile uint8_t *)0x09000000u = 0;
    __asm volatile("b 1f\n1:" ::: "memory");
}
#endif

RAM_CODE uint32_t journal_rom_identify_1(void)
{
    uint32_t original = *(volatile uint32_t *)ROM_BASE;
    uint32_t identified;
    uint8_t special;

    flash_write(0, 0x00FF);
    flash_write(0, 0x0090);
    identified = *(volatile uint32_t *)ROM_BASE;
    flash_write(0, 0x00FF);
    if (original == identified)
        return 0;

    /* This distinguishes Batteryless type 1 from the unsupported type 4. */
    flash_write(0x59, 0x0042);
    special = ROM_BASE[0xB2];
    flash_write(0x59, 0x0096);
    flash_write(0, 0x00FF);
    if (special != 0x96) {
        volatile uint32_t delay;
        for (delay = 0; delay < 1024; ++delay)
            __asm volatile("nop");
        /* Unsupported Type 4: tell the caller not to try Types 2 or 3. */
        return 2;
    }
    return 1;
}

RAM_CODE uint32_t journal_rom_erase_1(uint32_t target)
{
    volatile uint32_t timeout;
#ifdef CUSTOM_SAVE_BACKEND
    uint32_t result;
#endif

    flash_write(target, 0x00FF);
    flash_write(target, 0x0060);
    flash_write(target, 0x00D0);
    flash_write(target, 0x0020);
    flash_write(target, 0x00D0);
    for (timeout = 0x01000000u; timeout; --timeout) {
        __asm volatile("nop");
        if (ROM_HALFWORDS[target >> 1] == 0x0080)
            break;
    }
    flash_write(target, 0x00FF);
#ifdef CUSTOM_SAVE_BACKEND
    result = timeout != 0 && ROM_HALFWORDS[target >> 1] == 0xFFFF;
    custom_restore_save_bank_zero();
    return result;
#else
    return timeout != 0 && ROM_HALFWORDS[target >> 1] == 0xFFFF;
#endif
}

RAM_CODE uint32_t journal_rom_program_1(uint32_t target,
                                        const RomProgramBatch *batch)
{
    volatile uint32_t timeout;
    uint32_t index;
    uint16_t status = 0;
#ifdef CUSTOM_SAVE_BACKEND
    uint32_t result;
#endif

    /*
     * Batteryless erase_flash_1 always unlocks the target block with 60/D0
     * before erasing it. Journal appends deliberately avoid an erase while
     * slots are still blank, so each independently copied batch unlocks the
     * block once.  It then follows Batteryless's proven multi-word program
     * loop instead of repeating unlock and RAM-code copying for every byte.
     */
    flash_write(target, 0x00FF);
    flash_write(target, 0x0060);
    flash_write(target, 0x00D0);
    for (timeout = 0x4000u; timeout; --timeout) {
        __asm volatile("nop");
        status = ROM_HALFWORDS[target >> 1];
        if (status & 0x0080u)
            break;
    }
    flash_write(target, 0x00FF);
    if (!timeout || status != 0x0080u) {
#ifdef CUSTOM_SAVE_BACKEND
        result = 0;
        goto cleanup;
#else
        return 0;
#endif
    }

    for (index = 0; index < batch->count; ++index) {
        uint32_t address = target + (index << 1);
        uint8_t value = batch->source[index];
        uint16_t word = (uint16_t)(((uint16_t)(value ^ 0xFFu) << 8) | value);

        flash_write(address, 0x0040);
        flash_write(address, word);
        status = 0;
        for (timeout = 0x4000u; timeout; --timeout) {
            __asm volatile("nop");
            status = ROM_HALFWORDS[address >> 1];
            if (status & 0x0080u)
                break;
        }
        if (!timeout) {
            flash_write(target, 0x00FF);
#ifdef CUSTOM_SAVE_BACKEND
            result = 0;
            goto cleanup;
#else
            return 0;
#endif
        }
    }
    flash_write(target, 0x00FF);
    for (index = 0; index < batch->count; ++index) {
        uint8_t value = batch->source[index];
        uint16_t word = (uint16_t)(((uint16_t)(value ^ 0xFFu) << 8) | value);
        if (ROM_HALFWORDS[(target >> 1) + index] != word) {
#ifdef CUSTOM_SAVE_BACKEND
            result = 0;
            goto cleanup;
#else
            return 0;
#endif
        }
    }
#ifdef CUSTOM_SAVE_BACKEND
    result = 1;
cleanup:
    flash_write(target, 0x00FF);
    custom_restore_save_bank_zero();
    return result;
#else
    return 1;
#endif
}

RAM_CODE uint32_t journal_rom_identify_2(void)
{
    uint32_t original = *(volatile uint32_t *)ROM_BASE;
    uint32_t identified;

    flash_write(0, 0x00F0);
    flash_write(0xAAA, 0x00A9);
    flash_write(0x555, 0x0056);
    flash_write(0xAAA, 0x0090);
    identified = *(volatile uint32_t *)ROM_BASE;
    flash_write(0, 0x00F0);
    return original != identified;
}

RAM_CODE uint32_t journal_rom_erase_2(uint32_t target)
{
#ifdef CUSTOM_SAVE_BACKEND
    uint32_t result;
#endif
    flash_write(target, 0x00F0);
    flash_write(0xAAA, 0x00A9);
    flash_write(0x555, 0x0056);
    flash_write(0xAAA, 0x0080);
    flash_write(0xAAA, 0x00A9);
    flash_write(0x555, 0x0056);
    flash_write(target, 0x0030);
    for (;;) {
        __asm volatile("nop");
        if (ROM_HALFWORDS[target >> 1] == 0xFFFF)
            break;
    }
    flash_write(target, 0x00F0);
#ifdef CUSTOM_SAVE_BACKEND
    result = ROM_HALFWORDS[target >> 1] == 0xFFFF;
    custom_restore_save_bank_zero();
    return result;
#else
    return ROM_HALFWORDS[target >> 1] == 0xFFFF;
#endif
}

RAM_CODE uint32_t journal_rom_program_2(uint32_t target,
                                        const RomProgramBatch *batch)
{
    uint32_t index;
#ifdef CUSTOM_SAVE_BACKEND
    uint32_t result;
#endif

    for (index = 0; index < batch->count; ++index) {
        uint32_t address = target + (index << 1);
        uint8_t value = batch->source[index];
        uint16_t word = (uint16_t)(((uint16_t)(value ^ 0xFFu) << 8) | value);

        flash_write(0xAAA, 0x00A9);
        flash_write(0x555, 0x0056);
        flash_write(0xAAA, 0x00A0);
        flash_write(address, word);
        for (;;) {
            __asm volatile("nop");
            if (ROM_HALFWORDS[address >> 1] == word)
                break;
        }
    }
    flash_write(target, 0x00F0);
    for (index = 0; index < batch->count; ++index) {
        uint8_t value = batch->source[index];
        uint16_t word = (uint16_t)(((uint16_t)(value ^ 0xFFu) << 8) | value);
        if (ROM_HALFWORDS[(target >> 1) + index] != word) {
#ifdef CUSTOM_SAVE_BACKEND
            result = 0;
            goto cleanup;
#else
            return 0;
#endif
        }
    }
#ifdef CUSTOM_SAVE_BACKEND
    result = 1;
cleanup:
    flash_write(target, 0x00F0);
    custom_restore_save_bank_zero();
    return result;
#else
    return 1;
#endif
}

RAM_CODE uint32_t journal_rom_identify_3(void)
{
    uint32_t original = *(volatile uint32_t *)ROM_BASE;
    uint32_t identified;

    flash_write(0, 0x00F0);
    flash_write(0xAAA, 0x00AA);
    flash_write(0x555, 0x0055);
    flash_write(0xAAA, 0x0090);
    identified = *(volatile uint32_t *)ROM_BASE;
    flash_write(0, 0x00F0);
    return original != identified;
}

RAM_CODE uint32_t journal_rom_erase_3(uint32_t target)
{
#ifdef CUSTOM_SAVE_BACKEND
    uint32_t result;
#endif
    flash_write(target, 0x00F0);
    flash_write(0xAAA, 0x00AA);
    flash_write(0x555, 0x0055);
    flash_write(0xAAA, 0x0080);
    flash_write(0xAAA, 0x00AA);
    flash_write(0x555, 0x0055);
    flash_write(target, 0x0030);
    for (;;) {
        __asm volatile("nop");
        if (ROM_HALFWORDS[target >> 1] == 0xFFFF)
            break;
    }
    flash_write(target, 0x00F0);
#ifdef CUSTOM_SAVE_BACKEND
    result = ROM_HALFWORDS[target >> 1] == 0xFFFF;
    custom_restore_save_bank_zero();
    return result;
#else
    return ROM_HALFWORDS[target >> 1] == 0xFFFF;
#endif
}

RAM_CODE uint32_t journal_rom_program_3(uint32_t target,
                                        const RomProgramBatch *batch)
{
    uint32_t index;
#ifdef CUSTOM_SAVE_BACKEND
    uint32_t result;
#endif

    for (index = 0; index < batch->count; ++index) {
        uint32_t address = target + (index << 1);
        uint8_t value = batch->source[index];
        uint16_t word = (uint16_t)(((uint16_t)(value ^ 0xFFu) << 8) | value);

        flash_write(0xAAA, 0x00AA);
        flash_write(0x555, 0x0055);
        flash_write(0xAAA, 0x00A0);
        flash_write(address, word);
        for (;;) {
            __asm volatile("nop");
            if (ROM_HALFWORDS[address >> 1] == word)
                break;
        }
    }
    flash_write(target, 0x00F0);
    for (index = 0; index < batch->count; ++index) {
        uint8_t value = batch->source[index];
        uint16_t word = (uint16_t)(((uint16_t)(value ^ 0xFFu) << 8) | value);
        if (ROM_HALFWORDS[(target >> 1) + index] != word) {
#ifdef CUSTOM_SAVE_BACKEND
            result = 0;
            goto cleanup;
#else
            return 0;
#endif
        }
    }
#ifdef CUSTOM_SAVE_BACKEND
    result = 1;
cleanup:
    flash_write(target, 0x00F0);
    custom_restore_save_bank_zero();
    return result;
#else
    return 1;
#endif
}
