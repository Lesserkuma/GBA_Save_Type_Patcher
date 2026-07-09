/*
 * 512K FLASH runtime for GBA Save Type Patcher.
 *
 * Save-flash handling is based on metroid-maniac/gba-flash-patcher 0.0.2.
 * ROM-flash handling and the pause/restore sequence are adapted from
 * metroid-maniac/gba-auto-batteryless-patcher.  Both upstream projects are
 * distributed under the MIT License; see LICENSE in this directory.
 */

typedef unsigned char uint8_t;
typedef unsigned short uint16_t;
typedef unsigned int uint32_t;
typedef unsigned int uintptr_t;

#define ROM_BASE 0x08000000u
#define SAVE_BASE 0x0E000000u
#define MAPPER_LOCK (*(volatile uint8_t *)(SAVE_BASE + 3u))
#define ROM_BANK_SELECT (*(volatile uint8_t *)0x09000000u)
#define SAVE_FLASH_MAGIC_0 0x5555u
#define SAVE_FLASH_MAGIC_1 0x2AAAu
#define SAVE_SCRATCH_OFFSET 0x8000u
#define JOURNAL_ACTIVE_SIZE 0x10000u
#define JOURNAL_RESERVED_SIZE 0x40000u
#define COUNTDOWN_COUNTER (*(volatile uint16_t *)0x03007FFAu)

#define REG_GREENSWAP (*(volatile uint16_t *)0x04000002u)
#define REG_KEYINPUT (*(volatile uint16_t *)0x04000130u)
#define REG_SOUNDCNT_L (*(volatile uint16_t *)0x04000080u)
#define REG_SOUNDCNT_H (*(volatile uint16_t *)0x04000082u)
#define REG_TM0CNT_H (*(volatile uint16_t *)0x04000102u)
#define REG_TM1CNT_H (*(volatile uint16_t *)0x04000106u)
#define REG_DMA0CNT_H (*(volatile uint16_t *)0x040000BAu)
#define REG_DMA1CNT_H (*(volatile uint16_t *)0x040000C6u)
#define REG_DMA2CNT_H (*(volatile uint16_t *)0x040000D2u)
#define REG_DMA3CNT_H (*(volatile uint16_t *)0x040000DEu)
#define REG_IME (*(volatile uint16_t *)0x04000208u)

#define SOUNDCNT_H_DMA_OUTPUT_MASK 0x3300u
#define SOUNDCNT_H_FIFO_RESET_MASK 0x8800u
#define SOUNDCNT_H_FIFO_A_OUTPUT_MASK 0x0300u
#define SOUNDCNT_H_FIFO_B_OUTPUT_MASK 0x3000u
#define SOUNDCNT_H_FIFO_A_TIMER_1 0x0400u
#define SOUNDCNT_H_FIFO_B_TIMER_1 0x4000u
#define TIMER_ENABLE 0x0080u
#define DMA_ENABLE 0x8000u
#define DMA_START_TIMING_MASK 0x3000u
#define DMA_START_SPECIAL 0x3000u
#define KEYINPUT_MASK 0x03FFu

#define INDICATOR_OFF 0u
#define INDICATOR_COUNTDOWN 1u
#define INDICATOR_SAVE 2u
#define SAVE_LAYOUT_SRAM 0u
#define SAVE_LAYOUT_EEPROM 1u
#define JOURNAL_PROGRAM_CHUNK 128u
#define HIDDEN __attribute__((visibility("hidden")))

asm(R"(
.section .journal_header, "a", %progbits
.balign 4
.global flash512k_write_sram_word
flash512k_write_sram_word: .word write_sram_patched + 1
.global flash512k_write_eeprom_word
flash512k_write_eeprom_word: .word write_eeprom_patched + 1
.global flash512k_read_sram_word
flash512k_read_sram_word: .word read_sram_patched + 1
.global flash512k_read_eeprom_word
flash512k_read_eeprom_word: .word read_eeprom_patched + 1
.global flash512k_verify_sram_word
flash512k_verify_sram_word: .word verify_sram_patched + 1
.global flash512k_verify_eeprom_word
flash512k_verify_eeprom_word: .word verify_eeprom_patched + 1
.global flash512k_flush_word
flash512k_flush_word: .word flush_journal_patched + 1

.global journal_base_offset_config
.hidden journal_base_offset_config
.type journal_base_offset_config, %object
journal_base_offset_config: .word 0xffffffff
.global journal_logical_size_config
.hidden journal_logical_size_config
.type journal_logical_size_config, %object
journal_logical_size_config: .word 0
.global journal_layout_config
.hidden journal_layout_config
.type journal_layout_config, %object
journal_layout_config: .word 0
.global journal_countdown_config
.hidden journal_countdown_config
.type journal_countdown_config, %object
journal_countdown_config: .word 100
.global journal_indicator_config
.hidden journal_indicator_config
.type journal_indicator_config, %object
journal_indicator_config: .word 0
.text
)");

extern HIDDEN const uint32_t journal_base_offset_config;
extern HIDDEN const uint32_t journal_logical_size_config;
extern HIDDEN const uint32_t journal_layout_config;
extern HIDDEN const uint32_t journal_countdown_config;
extern HIDDEN const uint32_t journal_indicator_config;

extern HIDDEN const uint8_t __journal_ram_code_start[];
extern HIDDEN const uint8_t __journal_ram_code_end[];
extern HIDDEN uint32_t journal_rom_identify_1(void);
extern HIDDEN uint32_t journal_rom_erase_1(uint32_t target);
extern HIDDEN uint32_t journal_rom_program_1(uint32_t target, const void *batch);
extern HIDDEN uint32_t journal_rom_identify_2(void);
extern HIDDEN uint32_t journal_rom_erase_2(uint32_t target);
extern HIDDEN uint32_t journal_rom_program_2(uint32_t target, const void *batch);
extern HIDDEN uint32_t journal_rom_identify_3(void);
extern HIDDEN uint32_t journal_rom_erase_3(uint32_t target);
extern HIDDEN uint32_t journal_rom_program_3(uint32_t target, const void *batch);

typedef struct {
    uint32_t type;
} RomFlashDriver;

typedef struct {
    const uint8_t *source;
    uint32_t count;
} RomProgramBatch;

typedef struct {
    const uint8_t *source;
    uint32_t first;
    uint32_t size;
} PendingWrite;

typedef struct {
    uint16_t soundcnt_l;
    uint16_t soundcnt_h;
    uint16_t timer_cnt_h[2];
    uint16_t dma_cnt_h[4];
    uint16_t sound_timer_mask;
} RuntimeBackup;

/*
 * r0/r1 are forwarded to the copied Thumb routine. r2 is its first byte and
 * r3 its exclusive end. This is the original Batteryless run_from_ram
 * strategy: copy exactly one function backwards onto the stack, execute it
 * from RAM, then discard the temporary copy in one step.
 *
 * Keeping this helper in ARM state is intentional. The copied Thumb routine
 * returns with BX LR to the ARM instruction following BX r2, exactly as in
 * batteryless-sram_payload/payload.c.
 */
asm(R"(
.text
.arm
.balign 4
.global journal_run_from_ram
.hidden journal_run_from_ram
.type journal_run_from_ram, %function
journal_run_from_ram:
    push {r4, r5, lr}
    mov r4, sp
    bic r2, r2, #1
    bic r3, r3, #1
1:
    ldr r5, [r3, #-4]!
    push {r5}
    cmp r2, r3
    bne 1b
    add r2, sp, #1
    mov lr, pc
    bx r2
    mov sp, r4
    pop {r4, r5, lr}
    bx lr
.size journal_run_from_ram, .-journal_run_from_ram

.global journal_irq_delivery_enabled
.hidden journal_irq_delivery_enabled
.type journal_irq_delivery_enabled, %function
journal_irq_delivery_enabled:
    mrs r1, cpsr
    tst r1, #0x80
    movne r0, #0
    bxne lr
    mov r1, #0x04000000
    add r1, r1, #0x200
    ldrh r0, [r1, #8]
    cmp r0, #0
    movne r0, #1
    bx lr
.size journal_irq_delivery_enabled, .-journal_irq_delivery_enabled
.thumb
)");

extern HIDDEN uint32_t journal_run_from_ram(
    uint32_t argument0, uint32_t argument1,
    const void *function_start, const void *function_end);
extern HIDDEN uint32_t journal_irq_delivery_enabled(void);

static uint32_t config_valid(void)
{
    uint32_t base = journal_base_offset_config;
    uint32_t size = journal_logical_size_config;
    uint32_t layout = journal_layout_config;
    uint32_t countdown = journal_countdown_config;
    uint32_t indicator = journal_indicator_config;

    if (base == 0xFFFFFFFFu || base >= 0x02000000u)
        return 0;
    if ((base & (JOURNAL_RESERVED_SIZE - 1u)) != 0)
        return 0;
    if (base + JOURNAL_RESERVED_SIZE > 0x02000000u)
        return 0;
    if (!((size == 0x8000u && layout == SAVE_LAYOUT_SRAM) ||
          (size == 0x2000u && layout == SAVE_LAYOUT_EEPROM)))
        return 0;
    if (countdown == 0 || countdown > 255u)
        return 0;
    return indicator <= INDICATOR_SAVE;
}

static volatile uint16_t *journal_slots(void)
{
    return (volatile uint16_t *)(ROM_BASE + journal_base_offset_config);
}

static uint16_t encode_slot(uint8_t value)
{
    return (uint16_t)(((uint16_t)(value ^ 0xFFu) << 8) | value);
}

/* 0 = empty, 1 = valid, -1 = malformed. */
static int decode_slot(uint16_t word, uint8_t *value)
{
    uint8_t low;
    uint8_t high;
    if (word == 0xFFFFu)
        return 0;
    low = (uint8_t)word;
    high = (uint8_t)(word >> 8);
    if (high != (uint8_t)(low ^ 0xFFu))
        return -1;
    *value = low;
    return 1;
}

static uint32_t save_physical_index(uint32_t index)
{
    if (journal_layout_config == SAVE_LAYOUT_EEPROM)
        return index ^ 7u;
    return index;
}

static volatile uint8_t *save_address(uint32_t index)
{
    return (volatile uint8_t *)(SAVE_BASE + save_physical_index(index));
}

static int overlay_read_byte(uint32_t index, uint8_t *value)
{
    uint16_t word;
    int state;
    if (index >= journal_logical_size_config)
        return 0;
    word = journal_slots()[index];
    state = decode_slot(word, value);
    if (state < 0)
        return 0;
    if (state == 0)
        *value = *save_address(index);
    return 1;
}

static uint16_t direct_sound_timer_mask(uint16_t soundcnt_h)
{
    uint16_t mask = 0;
    if (soundcnt_h & SOUNDCNT_H_FIFO_A_OUTPUT_MASK)
        mask |= (soundcnt_h & SOUNDCNT_H_FIFO_A_TIMER_1) ? 2u : 1u;
    if (soundcnt_h & SOUNDCNT_H_FIFO_B_OUTPUT_MASK)
        mask |= (soundcnt_h & SOUNDCNT_H_FIFO_B_TIMER_1) ? 2u : 1u;
    return mask;
}

static uint32_t is_direct_sound_dma(uint32_t channel, uint16_t cnt_h)
{
    return (channel == 1u || channel == 2u)
        && (cnt_h & DMA_ENABLE)
        && ((cnt_h & DMA_START_TIMING_MASK) == DMA_START_SPECIAL);
}

static void pause_non_sound_dma(uint16_t backup[4])
{
    backup[0] = REG_DMA0CNT_H;
    REG_DMA0CNT_H = 0;
    backup[1] = REG_DMA1CNT_H;
    if (!is_direct_sound_dma(1u, backup[1]))
        REG_DMA1CNT_H = 0;
    backup[2] = REG_DMA2CNT_H;
    if (!is_direct_sound_dma(2u, backup[2]))
        REG_DMA2CNT_H = 0;
    backup[3] = REG_DMA3CNT_H;
    REG_DMA3CNT_H = 0;
}

static void restore_non_sound_dma(const uint16_t backup[4])
{
    REG_DMA3CNT_H = backup[3];
    if (!is_direct_sound_dma(2u, backup[2]))
        REG_DMA2CNT_H = backup[2];
    if (!is_direct_sound_dma(1u, backup[1]))
        REG_DMA1CNT_H = backup[1];
    REG_DMA0CNT_H = backup[0];
}

static void runtime_pause(RuntimeBackup *backup)
{
    backup->soundcnt_l = REG_SOUNDCNT_L;
    backup->soundcnt_h = (uint16_t)(REG_SOUNDCNT_H & ~SOUNDCNT_H_FIFO_RESET_MASK);
    backup->sound_timer_mask = direct_sound_timer_mask(backup->soundcnt_h);
    backup->timer_cnt_h[0] = REG_TM0CNT_H;
    backup->timer_cnt_h[1] = REG_TM1CNT_H;

    REG_SOUNDCNT_H = (uint16_t)(backup->soundcnt_h & ~SOUNDCNT_H_DMA_OUTPUT_MASK);
    REG_SOUNDCNT_L = 0;
    if (backup->sound_timer_mask & 1u)
        REG_TM0CNT_H = (uint16_t)(backup->timer_cnt_h[0] & ~TIMER_ENABLE);
    if (backup->sound_timer_mask & 2u)
        REG_TM1CNT_H = (uint16_t)(backup->timer_cnt_h[1] & ~TIMER_ENABLE);

    /* Keep this ordering identical to Batteryless flush_sram: save and stop
     * each DMA channel in ascending order, but leave active Direct Sound FIFO
     * DMA1/DMA2 channels armed while their source timers are stopped. */
    pause_non_sound_dma(backup->dma_cnt_h);
}

static void runtime_restore(const RuntimeBackup *backup)
{
    /* Exact Batteryless restore order: DMA3..DMA0, sound controls, then the
     * selected Direct Sound timers in reverse order. */
    restore_non_sound_dma(backup->dma_cnt_h);

    REG_SOUNDCNT_H = backup->soundcnt_h;
    REG_SOUNDCNT_L = backup->soundcnt_l;
    if (backup->sound_timer_mask & 2u)
        REG_TM1CNT_H = backup->timer_cnt_h[1];
    if (backup->sound_timer_mask & 1u)
        REG_TM0CNT_H = backup->timer_cnt_h[0];
}

static uint32_t run_rom_function(uint32_t argument0, uint32_t argument1,
                                 uintptr_t function_start,
                                 uintptr_t function_end)
{
    uintptr_t section_start = (uintptr_t)__journal_ram_code_start;
    uintptr_t section_end = (uintptr_t)__journal_ram_code_end;
    uint16_t dma_backup[4];
    uint16_t old_ime;
    uint32_t result;

    function_start &= ~1u;
    function_end &= ~1u;
    if (function_start < section_start || function_end > section_end ||
        function_start >= function_end || ((function_end - function_start) & 3u))
        return 0;

    /* A GamePak flash command must not be interrupted by a ROM-resident IRQ
     * handler or an unrelated DMA. Keep only this copied RAM routine atomic;
     * restoring IME here lets the game refill Direct Sound between chunks. */
    old_ime = REG_IME;
    REG_IME = 0;
    pause_non_sound_dma(dma_backup);
    result = journal_run_from_ram(argument0, argument1,
                                  (const void *)function_start,
                                  (const void *)function_end);
    restore_non_sound_dma(dma_backup);
    REG_IME = old_ime;
    return result;
}

static uint32_t identify_rom_flash_1(void)
{
    return run_rom_function(0, 0,
                            (uintptr_t)journal_rom_identify_1,
                            (uintptr_t)journal_rom_erase_1);
}

static uint32_t identify_rom_flash_2(void)
{
    return run_rom_function(0, 0,
                            (uintptr_t)journal_rom_identify_2,
                            (uintptr_t)journal_rom_erase_2);
}

static uint32_t identify_rom_flash_3(void)
{
    return run_rom_function(0, 0,
                            (uintptr_t)journal_rom_identify_3,
                            (uintptr_t)journal_rom_erase_3);
}

static void prepare_rom_flash_access(void);

static uint32_t erase_rom_flash(uint32_t type, uint32_t target)
{
    prepare_rom_flash_access();
    if (type == 1u)
        return run_rom_function(target, 0,
                                (uintptr_t)journal_rom_erase_1,
                                (uintptr_t)journal_rom_program_1);
    if (type == 2u)
        return run_rom_function(target, 0,
                                (uintptr_t)journal_rom_erase_2,
                                (uintptr_t)journal_rom_program_2);
    if (type == 3u)
        return run_rom_function(target, 0,
                                (uintptr_t)journal_rom_erase_3,
                                (uintptr_t)journal_rom_program_3);
    return 0;
}

static uint32_t program_rom_flash_slots(uint32_t type, uint32_t target,
                                        const uint8_t *source, uint32_t count)
{
    RomProgramBatch batch;

    if (!count || count > JOURNAL_PROGRAM_CHUNK)
        return 0;
    batch.source = source;
    batch.count = count;
    prepare_rom_flash_access();
    if (type == 1u)
        return run_rom_function(target, (uintptr_t)&batch,
                                (uintptr_t)journal_rom_program_1,
                                (uintptr_t)journal_rom_identify_2);
    if (type == 2u)
        return run_rom_function(target, (uintptr_t)&batch,
                                (uintptr_t)journal_rom_program_2,
                                (uintptr_t)journal_rom_identify_3);
    if (type == 3u)
        return run_rom_function(target, (uintptr_t)&batch,
                                (uintptr_t)journal_rom_program_3,
                                (uintptr_t)__journal_ram_code_end);
    return 0;
}

static void prepare_rom_flash_access(void)
{
    /*
     * Match the Batteryless startup state before touching GamePak flash.
     * The 369-in-1-style mapper snoops the write at SAVE+3, while ordinary
     * FLASH512 ignores it without an unlock sequence. The bank-zero write is
     * likewise the normal Batteryless mapper selection primitive.
     */
    MAPPER_LOCK = 0x80;
    __asm volatile("nop");
    ROM_BANK_SELECT = 0;
    __asm volatile("nop");
}

static uint32_t select_rom_driver(RomFlashDriver *driver)
{
    uint32_t first_probe;
    driver->type = 0;
    prepare_rom_flash_access();
    first_probe = identify_rom_flash_1();
    if (first_probe == 1u) {
        driver->type = 1;
        return 1;
    }
    /* Type 1's shared family probe recognized unsupported Type 4. */
    if (first_probe == 2u)
        return 0;
    if (identify_rom_flash_2()) {
        driver->type = 2;
        return 1;
    }
    if (identify_rom_flash_3()) {
        driver->type = 3;
        return 1;
    }
    return 0;
}

static uint32_t probe_rom_flash_type(void)
{
    RomFlashDriver driver;
    if (!select_rom_driver(&driver))
        return 0;
    return driver.type;
}

static void save_flash_reset(void)
{
    volatile uint8_t *save = (volatile uint8_t *)SAVE_BASE;
    save[SAVE_FLASH_MAGIC_0] = 0xAA;
    save[SAVE_FLASH_MAGIC_1] = 0x55;
    save[SAVE_FLASH_MAGIC_0] = 0xF0;
}

static void save_flash_erase_sector(volatile uint8_t *target)
{
    volatile uint8_t *save = (volatile uint8_t *)SAVE_BASE;
    save[SAVE_FLASH_MAGIC_0] = 0xAA;
    save[SAVE_FLASH_MAGIC_1] = 0x55;
    save[SAVE_FLASH_MAGIC_0] = 0x80;
    save[SAVE_FLASH_MAGIC_0] = 0xAA;
    save[SAVE_FLASH_MAGIC_1] = 0x55;
    *target = 0x30;
    __asm volatile("nop");
    while (*target != 0xFF)
        ;
    save_flash_reset();
}

static void save_flash_program_byte(volatile uint8_t *target, uint8_t value)
{
    volatile uint8_t *save = (volatile uint8_t *)SAVE_BASE;
    save[SAVE_FLASH_MAGIC_0] = 0xAA;
    save[SAVE_FLASH_MAGIC_1] = 0x55;
    save[SAVE_FLASH_MAGIC_0] = 0xA0;
    *target = value;
    __asm volatile("nop");
    while (*target != value)
        ;
    save_flash_reset();
}

static uint32_t slots_are_well_formed(uint32_t *has_dirty)
{
    volatile uint16_t *slots = journal_slots();
    uint32_t logical = journal_logical_size_config;
    uint32_t slot_count = JOURNAL_ACTIVE_SIZE >> 1;
    uint32_t index;
    uint8_t ignored;
    *has_dirty = 0;
    for (index = 0; index < logical; ++index) {
        int state = decode_slot(slots[index], &ignored);
        if (state < 0)
            return 0;
        if (state > 0)
            *has_dirty = 1;
    }
    for (; index < slot_count; ++index) {
        if (slots[index] != 0xFFFFu)
            return 0;
    }
    return 1;
}

/* Pending data has priority over an older Journal slot.  Return 0 for the
 * native Save FLASH value, 1 for an overlay value, and -1 for a malformed
 * Journal slot. */
static int journal_overlay_value(uint32_t index, const PendingWrite *pending,
                                 uint8_t *value)
{
    volatile uint16_t *slots = journal_slots();
    if (pending && index >= pending->first &&
        index - pending->first < pending->size) {
        *value = pending->source[index - pending->first];
        return 1;
    }
    return decode_slot(slots[index], value);
}

static uint32_t sector_needs_commit(uint32_t first, uint32_t count,
                                    const PendingWrite *pending)
{
    uint32_t index;
    uint8_t value;
    for (index = 0; index < count; ++index) {
        int state = journal_overlay_value(first + index, pending, &value);
        if (state != 0)
            return 1;
    }
    return 0;
}

static uint32_t save_sector_is_erased(volatile uint8_t *sector, uint32_t count)
{
    uint32_t index;
    for (index = 0; index < count; ++index) {
        if (sector[index] != 0xFFu)
            return 0;
    }
    return 1;
}

static uint32_t flush_save_sector(uint32_t first, uint32_t count,
                                  const PendingWrite *pending)
{
    volatile uint8_t *sector = (volatile uint8_t *)(SAVE_BASE + first);
    volatile uint8_t *scratch =
        (volatile uint8_t *)(SAVE_BASE + SAVE_SCRATCH_OFFSET + first);
    uint32_t index;
    uint32_t has_changes = 0;
    uint32_t needs_erase = 0;
    uint32_t scratch_used = 0;
    uint32_t success = 0;

    /* Flash can program 1 -> 0 without an erase.  Most initial save creation
     * therefore needs neither a sector erase nor the scratch area. */
    for (index = 0; index < count; ++index) {
        uint8_t value;
        int state = journal_overlay_value(first + index, pending, &value);
        uint8_t old_value;
        if (state < 0)
            return 0;
        if (!state)
            continue;
        old_value = *save_address(first + index);
        if (value == old_value)
            continue;
        has_changes = 1;
        if ((old_value & value) != value)
            needs_erase = 1;
    }
    if (!has_changes)
        return 1;

    if (!needs_erase) {
        for (index = 0; index < count; ++index) {
            uint8_t value;
            int state = journal_overlay_value(first + index, pending, &value);
            if (state > 0 && *save_address(first + index) != value)
                save_flash_program_byte(save_address(first + index), value);
        }
        for (index = 0; index < count; ++index) {
            uint8_t value;
            int state = journal_overlay_value(first + index, pending, &value);
            if (state < 0 || (state > 0 && *save_address(first + index) != value))
                return 0;
        }
        return 1;
    }

    /* A 4 KiB stack buffer is unsafe for games with a small System stack.
     * Preserve only bytes which are not supplied by Journal/pending data in
     * the matching upper Save-FLASH sector.  Successful flushes leave this
     * scratch sector erased, so the normal path avoids a redundant erase. */
    if (!save_sector_is_erased(scratch, count))
        save_flash_erase_sector(scratch);
    if (!save_sector_is_erased(scratch, count))
        return 0;

    for (index = 0; index < count; ++index) {
        uint8_t value;
        int state = journal_overlay_value(first + index, pending, &value);
        if (state < 0)
            goto cleanup;
        if (!state) {
            value = *save_address(first + index);
            if (value != 0xFFu) {
                scratch_used = 1;
                save_flash_program_byte(&scratch[index], value);
            }
        }
    }
    for (index = 0; index < count; ++index) {
        uint8_t value;
        int state = journal_overlay_value(first + index, pending, &value);
        uint8_t expected = state > 0 ? 0xFFu : *save_address(first + index);
        if (state < 0 || scratch[index] != expected)
            goto cleanup;
    }

    save_flash_erase_sector(sector);
    for (index = 0; index < count; ++index) {
        uint8_t value;
        int state = journal_overlay_value(first + index, pending, &value);
        if (state < 0)
            goto cleanup;
        if (!state)
            value = scratch[index];
        if (value != 0xFFu)
            save_flash_program_byte(save_address(first + index), value);
    }
    for (index = 0; index < count; ++index) {
        uint8_t value;
        int state = journal_overlay_value(first + index, pending, &value);
        if (state < 0)
            goto cleanup;
        if (!state)
            value = scratch[index];
        if (*save_address(first + index) != value)
            goto cleanup;
    }
    success = 1;

cleanup:
    if (scratch_used) {
        save_flash_erase_sector(scratch);
        if (!save_sector_is_erased(scratch, count))
            success = 0;
    }
    return success;
}

static uint32_t erase_and_verify_journal(uint32_t type)
{
    volatile uint16_t *slots = journal_slots();
    uint32_t index;

    if (!erase_rom_flash(type, journal_base_offset_config))
        return 0;
    for (index = 0; index < (JOURNAL_ACTIVE_SIZE >> 1); ++index) {
        if (slots[index] != 0xFFFFu)
            return 0;
    }
    return 1;
}

static void wait_for_hotkey_release(uint32_t release_mask)
{
    release_mask &= KEYINPUT_MASK;
    while (release_mask && !(REG_KEYINPUT & release_mask))
        ;
}

static uint32_t flush_journal_inner(uint32_t release_mask,
                                    const PendingWrite *pending)
{
    RuntimeBackup backup;
    uint16_t old_ime;
    uint32_t journal_dirty = 0;
    uint32_t dirty;
    uint32_t reset_save_flash = 0;
    uint32_t success = 0;
    uint32_t rom_flash_type;
    uint32_t logical_per_sector;
    uint32_t first;
    uint16_t previous_greenswap = REG_GREENSWAP;

    if (!config_valid())
        return 0;
    if (pending && (!pending->source || !pending->size ||
        pending->first > journal_logical_size_config ||
        pending->size > journal_logical_size_config - pending->first))
        return 0;

    /* A commit mutates both Save FLASH and the ROM Journal as one operation.
     * Shared-IRQ calls already arrive with CPU IRQs masked; collision flushes
     * reached from a game save hook need the equivalent IME protection. */
    old_ime = REG_IME;
    REG_IME = 0;

    /* The complete 64 KiB Journal validation is slow enough to starve a
     * game's Direct Sound refill while this VBlank callback owns the CPU.
     * Pause before that scan, just as Batteryless does before any flash work. */
    if (journal_indicator_config == INDICATOR_SAVE)
        REG_GREENSWAP = 1;
    runtime_pause(&backup);

    if (!slots_are_well_formed(&journal_dirty))
        goto restore;
    dirty = journal_dirty || pending;
    if (!dirty) {
        success = 1;
        goto restore;
    }

    reset_save_flash = 1;
    rom_flash_type = probe_rom_flash_type();
    if (!rom_flash_type)
        goto restore;

    logical_per_sector = 0x1000u;
    for (first = 0; first < journal_logical_size_config; first += logical_per_sector) {
        uint32_t count = logical_per_sector;
        if (count > journal_logical_size_config - first)
            count = journal_logical_size_config - first;
        if (sector_needs_commit(first, count, pending) &&
            !flush_save_sector(first, count, pending))
            goto restore;
    }

    if (journal_dirty && !erase_and_verify_journal(rom_flash_type))
        goto restore;
    success = 1;

restore:
    if (reset_save_flash)
        save_flash_reset();
    if (journal_indicator_config == INDICATOR_SAVE)
        REG_GREENSWAP = previous_greenswap;
    if (success) {
        COUNTDOWN_COUNTER = 0;
        if (journal_indicator_config == INDICATOR_COUNTDOWN)
            REG_GREENSWAP = 0;
    } else {
        COUNTDOWN_COUNTER = (uint16_t)journal_countdown_config;
        if (journal_indicator_config == INDICATOR_COUNTDOWN)
            REG_GREENSWAP = 1;
    }
    /* The shared IRQ supplies its active-low combo only for a manual flush.
     * The save indicator is already finished, but Direct Sound and the game
     * remain paused until the combo is released. */
    wait_for_hotkey_release(release_mask);
    runtime_restore(&backup);
    REG_IME = old_ime;
    return success;
}

static uint32_t preflight_write(const uint8_t *source, uint32_t first,
                                uint32_t size, uint32_t *changed,
                                uint32_t *collision)
{
    volatile uint16_t *slots = journal_slots();
    uint32_t index;
    *changed = 0;
    *collision = 0;
    if (first > journal_logical_size_config ||
        size > journal_logical_size_config - first)
        return 0;

    for (index = 0; index < size; ++index) {
        uint8_t visible;
        uint8_t slot_value;
        int state = decode_slot(slots[first + index], &slot_value);
        if (state < 0 || !overlay_read_byte(first + index, &visible))
            return 0;
        if (source[index] == visible)
            continue;
        *changed = 1;
        if (state > 0)
            *collision = 1;
    }
    return 1;
}

static uint32_t append_slots(const uint8_t *source, uint32_t first, uint32_t size)
{
    RomFlashDriver driver;
    RuntimeBackup backup;
    uint8_t chunk[JOURNAL_PROGRAM_CHUNK];
    volatile uint16_t *slots = journal_slots();
    uint32_t index;
    uint32_t success = 0;
    uint32_t pause_runtime = !journal_irq_delivery_enabled();
    uint16_t previous_greenswap = REG_GREENSWAP;

    /* Keep the automatic flush safely behind this append even though normal
     * game IRQs may now run between the atomic ROM-program chunks. */
    COUNTDOWN_COUNTER = (uint16_t)journal_countdown_config;
    if (journal_indicator_config == INDICATOR_SAVE)
        REG_GREENSWAP = 1;
    if (pause_runtime)
        runtime_pause(&backup);
    if (!select_rom_driver(&driver))
        goto restore;

    index = 0;
    while (index < size) {
        uint8_t visible;
        if (!overlay_read_byte(first + index, &visible))
            goto restore;
        if (source[index] == visible) {
            ++index;
            continue;
        } else {
            uint32_t run_first = index;
            uint32_t chunk_count = 0;
            uint32_t verify_index;

            while (index < size && chunk_count < JOURNAL_PROGRAM_CHUNK) {
                if (!overlay_read_byte(first + index, &visible))
                    goto restore;
                if (source[index] == visible)
                    break;
                if (slots[first + index] != 0xFFFFu)
                    goto restore;
                chunk[chunk_count++] = source[index++];
            }
            if (!program_rom_flash_slots(
                    driver.type,
                    journal_base_offset_config + ((first + run_first) << 1),
                    chunk, chunk_count))
                goto restore;
            for (verify_index = 0; verify_index < chunk_count; ++verify_index) {
                if (slots[first + run_first + verify_index] !=
                    encode_slot(chunk[verify_index]))
                    goto restore;
            }
        }
    }
    success = 1;

restore:
    if (journal_indicator_config == INDICATOR_SAVE)
        REG_GREENSWAP = previous_greenswap;
    if (pause_runtime)
        runtime_restore(&backup);
    if (success) {
        COUNTDOWN_COUNTER = (uint16_t)journal_countdown_config;
        if (journal_indicator_config == INDICATOR_COUNTDOWN)
            REG_GREENSWAP = 1;
    } else {
        /* A failed probe/program may still have left valid slots behind. */
        COUNTDOWN_COUNTER = (uint16_t)journal_countdown_config;
        if (journal_indicator_config == INDICATOR_COUNTDOWN)
            REG_GREENSWAP = 1;
    }
    return success;
}

static uint32_t journal_write_core(const uint8_t *source, uint32_t first, uint32_t size)
{
    uint32_t changed;
    uint32_t collision;
    if (!config_valid())
        return 0;
    for (;;) {
        if (!preflight_write(source, first, size, &changed, &collision))
            return 0;
        if (!changed)
            return 1;
        if (!collision)
            return append_slots(source, first, size);
        /* Source data in Save FLASH could be destroyed while committing an
         * earlier target sector. Preserve native copy semantics by retaining
         * the old flush/retry path only for that unusual overlap. */
        if ((uintptr_t)source < SAVE_BASE + 0x10000u &&
            (uintptr_t)source + size > SAVE_BASE) {
            if (!flush_journal_inner(0, (const PendingWrite *)0))
                return 0;
        } else {
            PendingWrite pending;
            pending.source = source;
            pending.first = first;
            pending.size = size;
            return flush_journal_inner(0, &pending);
        }
    }
}

static uint32_t read_core(uint8_t *destination, uint32_t first, uint32_t size)
{
    uint32_t index;
    if (!config_valid() || first > journal_logical_size_config ||
        size > journal_logical_size_config - first)
        return 0;
    for (index = 0; index < size; ++index) {
        if (!overlay_read_byte(first + index, &destination[index]))
            return 0;
    }
    return 1;
}

static int verify_core(const uint8_t *source, uint32_t first, uint32_t size)
{
    uint32_t index;
    if (!config_valid() || first > journal_logical_size_config ||
        size > journal_logical_size_config - first)
        return (int)first;
    for (index = 0; index < size; ++index) {
        uint8_t visible;
        if (!overlay_read_byte(first + index, &visible) || source[index] != visible)
            return (int)(first + index);
    }
    return -1;
}

uint32_t flush_journal_patched(uint32_t release_mask)
{
    /* Shared IRQ calls this Thumb entry in System mode with IRQ disabled.
     * r0 is zero for countdown flushes and the combo mask for manual flushes. */
    return flush_journal_inner(release_mask, (const PendingWrite *)0);
}

void write_sram_patched(uint8_t *source, uint8_t *destination, uint32_t size)
{
    (void)journal_write_core(source, (uintptr_t)destination & 0x7FFFu, size);
}

void read_sram_patched(uint8_t *source, uint8_t *destination, uint32_t size)
{
    (void)read_core(destination, (uintptr_t)source & 0x7FFFu, size);
}

uint8_t *verify_sram_patched(uint8_t *source, uint8_t *target, uint32_t size)
{
    int error = verify_core(source, (uintptr_t)target & 0x7FFFu, size);
    return error < 0 ? (uint8_t *)0 : (uint8_t *)(SAVE_BASE | (uint32_t)error);
}

uint32_t write_eeprom_patched(uint16_t address, uint8_t *source)
{
    uint32_t success = journal_write_core(source, (uint32_t)address << 3, 8);
    return success ? 0 : 1;
}

uint32_t read_eeprom_patched(uint16_t address, uint8_t *destination)
{
    uint16_t old_ime = REG_IME;
    uint32_t success;
    REG_IME = 0;
    success = read_core(destination, (uint32_t)address << 3, 8);
    REG_IME = old_ime;
    return success ? 0 : 1;
}

uint32_t verify_eeprom_patched(uint16_t address, uint8_t *source)
{
    return verify_core(source, (uint32_t)address << 3, 8) < 0 ? 0 : 1;
}

asm(R"(
.section .flash512k_footer, "a", %progbits
.balign 4
.global flash512k_signature
.type flash512k_signature, %object
flash512k_signature:
.ascii "thx Maniac"
.byte 0, 0
.ascii "lk_flash512k"
.size flash512k_signature, .-flash512k_signature
.text
)");
