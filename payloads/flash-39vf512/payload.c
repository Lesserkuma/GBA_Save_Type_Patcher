// SPDX-License-Identifier: GPL-3.0-or-later AND MIT

/*
 * 512K FLASH runtime for GBA Save Type Patcher.
 *
 * Save-flash handling is based on metroid-maniac/gba-flash-patcher 0.0.2.
 * ROM-flash handling and the pause/restore sequence are adapted from
 * metroid-maniac/gba-auto-batteryless-patcher.  Both upstream projects are
 * distributed under the MIT License; see LICENSE in this directory.
 */

#include "../common/gba_hw.h"

#define ROM_BASE GBA_ROM_BASE_ADDRESS
#define SAVE_BASE GBA_SAVE_BASE_ADDRESS
#define SAVE_FLASH_MAGIC_0 0x5555u
#define SAVE_FLASH_MAGIC_1 0x2AAAu
#define SAVE_SCRATCH_OFFSET 0x8000u
#define JOURNAL_ACTIVE_SIZE 0x10000u
#define JOURNAL_RESERVED_SIZE 0x40000u
#define COUNTDOWN_COUNTER GBA_REG16(GBA_COUNTDOWN_COUNTER_ADDRESS)

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
#define INDICATOR_OFF 0u
#define INDICATOR_COUNTDOWN 1u
#define INDICATOR_SAVE 2u
#define SAVE_LAYOUT_SRAM 0u
#define SAVE_LAYOUT_EEPROM 1u
#define JOURNAL_PROGRAM_CHUNK 128u
#define SAVE_PROGRAM_TIMEOUT 0x4000u
#define SAVE_ERASE_TIMEOUT 0x01000000u
#define ROM_WORKSPACE_EWRAM_START 0x02000000u
#define ROM_WORKSPACE_EWRAM_END 0x02040000u
#define ROM_WORKSPACE_SIZE 0x400u
#define ROM_WORKSPACE_ALIGNMENT 0x400u
#define ROM_WORKSPACE_EXEC_OFFSET 0x000u
#define ROM_WORKSPACE_EXEC_SIZE 0x100u
#define ROM_WORKSPACE_META_OFFSET 0x100u
#define ROM_WORKSPACE_META_SIZE 0x020u
#define ROM_WORKSPACE_GUARD_OFFSET 0x120u
#define ROM_WORKSPACE_GUARD_SIZE 0x020u
#define ROM_WORKSPACE_STACK_BOTTOM 0x140u
#define ROM_WORKSPACE_STACK_TOP 0x400u
#define ROM_WORKSPACE_STACK_SIZE 0x2C0u
#define ROM_WORKSPACE_STACK_SAFETY_BELOW 0x1000u
#define ROM_WORKSPACE_STACK_SAFETY_ABOVE 0x0100u
#define ROM_WORKSPACE_GUARD_WORD 0xA55A3CC3u
#define HIDDEN __attribute__((visibility("hidden")))

#ifdef CUSTOM_SAVE_BACKEND
#define JOURNAL_EXTRA_CONFIG_ASM R"(
.global journal_save_chip_type_config
.hidden journal_save_chip_type_config
.type journal_save_chip_type_config, %object
journal_save_chip_type_config: .word 0
)"
#define JOURNAL_SIGNATURE_ASM R"(.ascii "lk_custom_journal_v2"
)"
#else
#define JOURNAL_EXTRA_CONFIG_ASM ""
#define JOURNAL_SIGNATURE_ASM R"(.ascii "thx Maniac"
.byte 0, 0
.ascii "lk_fl512k_v2"
)"
#endif

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
)" JOURNAL_EXTRA_CONFIG_ASM R"(
.text
)");

extern HIDDEN const uint32_t journal_base_offset_config;
extern HIDDEN const uint32_t journal_logical_size_config;
extern HIDDEN const uint32_t journal_layout_config;
extern HIDDEN const uint32_t journal_countdown_config;
extern HIDDEN const uint32_t journal_indicator_config;
#ifdef CUSTOM_SAVE_BACKEND
extern HIDDEN const uint32_t journal_save_chip_type_config;
#endif

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

typedef struct {
    volatile uint32_t *base;
    uint32_t fill_word;
} RomWorkspace;

/*
 * r0/r1 are forwarded to the copied Thumb routine. r2 is its first byte and
 * r3 its exclusive end. This is the original Batteryless run_from_ram
 * strategy: copy exactly one function backwards onto the stack, execute it
 * from RAM, then discard the temporary copy in one step.
 *
 * Keeping this helper in ARM state is intentional. The copied Thumb routine
 * returns with BX LR to the ARM instruction following BX r2, exactly as in
 * payloads/batteryless-sram/payload.c.
 */
asm(R"(
.text
.arm
.balign 4
.global journal_run_from_stack
.hidden journal_run_from_stack
.type journal_run_from_stack, %function
journal_run_from_stack:
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
.size journal_run_from_stack, .-journal_run_from_stack

.global journal_call_workspace
.hidden journal_call_workspace
.type journal_call_workspace, %function
journal_call_workspace:
    push {r4, lr}
    mov r4, sp
    mov sp, r3
    orr r2, r2, #1
    mov lr, pc
    bx r2
    mov sp, r4
    pop {r4, lr}
    bx lr
.size journal_call_workspace, .-journal_call_workspace

.global journal_irq_lock
.hidden journal_irq_lock
.type journal_irq_lock, %function
journal_irq_lock:
    mrs r0, cpsr
    orr r1, r0, #0x80
    msr cpsr_c, r1
    bx lr
.size journal_irq_lock, .-journal_irq_lock

.global journal_irq_restore
.hidden journal_irq_restore
.type journal_irq_restore, %function
journal_irq_restore:
    mrs r1, cpsr
    bic r1, r1, #0x80
    and r0, r0, #0x80
    orr r1, r1, r0
    msr cpsr_c, r1
    bx lr
.size journal_irq_restore, .-journal_irq_restore

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

extern HIDDEN uint32_t journal_run_from_stack(
    uint32_t argument0, uint32_t argument1,
    const void *function_start, const void *function_end);
extern HIDDEN uint32_t journal_call_workspace(
    uint32_t argument0, uint32_t argument1,
    void *exec_slot, void *stack_top);
extern HIDDEN uint32_t journal_irq_lock(void);
extern HIDDEN void journal_irq_restore(uint32_t cpsr);
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
#ifdef CUSTOM_SAVE_BACKEND
    if (journal_save_chip_type_config != 1u &&
        journal_save_chip_type_config != 2u)
        return 0;
#endif
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

static uint8_t save_backend_read(uint32_t offset)
{
    if (offset >= 0x10000u)
        return 0;
    return *(volatile uint8_t *)(SAVE_BASE + offset);
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
        *value = save_backend_read(save_physical_index(index));
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

static inline __attribute__((always_inline)) uintptr_t current_stack_pointer(void)
{
    uintptr_t value;
    __asm__ volatile("mov %0, sp" : "=r"(value));
    return value;
}

static inline __attribute__((always_inline)) uint32_t ranges_overlap(
    uintptr_t first_start, uintptr_t first_end,
    uintptr_t second_start, uintptr_t second_end)
{
    return first_start < second_end && second_start < first_end;
}

static inline __attribute__((always_inline)) uint32_t workspace_conflicts(
    uintptr_t base, uintptr_t stack_pointer,
    uintptr_t exclude_start, uintptr_t exclude_end)
{
    uintptr_t end = base + ROM_WORKSPACE_SIZE;
    uint32_t channel;

    if (stack_pointer >= ROM_WORKSPACE_EWRAM_START &&
        stack_pointer < ROM_WORKSPACE_EWRAM_END) {
        uintptr_t stack_start = stack_pointer > ROM_WORKSPACE_STACK_SAFETY_BELOW
            ? stack_pointer - ROM_WORKSPACE_STACK_SAFETY_BELOW
            : ROM_WORKSPACE_EWRAM_START;
        uintptr_t stack_end = stack_pointer + ROM_WORKSPACE_STACK_SAFETY_ABOVE;
        if (stack_end > ROM_WORKSPACE_EWRAM_END)
            stack_end = ROM_WORKSPACE_EWRAM_END;
        if (ranges_overlap(base, end, stack_start, stack_end))
            return 1;
    }

    if (exclude_start < exclude_end &&
        ranges_overlap(base, end, exclude_start, exclude_end))
        return 1;

    for (channel = 0; channel != 4u; ++channel) {
        uintptr_t source = REG_DMA_SAD(channel);
        uintptr_t destination = REG_DMA_DAD(channel);
        if ((source >= base && source < end) ||
            (destination >= base && destination < end))
            return 1;
    }
    return 0;
}

static inline __attribute__((always_inline)) uint32_t workspace_is_homogeneous(
    uintptr_t base, uint32_t *fill_word)
{
    volatile const uint32_t *words = (volatile const uint32_t *)base;
    uint32_t fill = words[0];
    uint32_t index;

    if (fill != 0u && fill != 0xFFFFFFFFu)
        return 0;
    for (index = 1; index != ROM_WORKSPACE_SIZE / 4u; ++index) {
        if (words[index] != fill)
            return 0;
    }
    *fill_word = fill;
    return 1;
}

static uint32_t workspace_find(RomWorkspace *workspace,
                               uintptr_t exclude_start,
                               uintptr_t exclude_end)
{
    uintptr_t stack_pointer = current_stack_pointer();
    uintptr_t base = ROM_WORKSPACE_EWRAM_END - ROM_WORKSPACE_SIZE;

    for (;;) {
        if (!workspace_conflicts(base, stack_pointer,
                                 exclude_start, exclude_end) &&
            workspace_is_homogeneous(base, &workspace->fill_word)) {
            workspace->base = (volatile uint32_t *)base;
            return 1;
        }
        if (base == ROM_WORKSPACE_EWRAM_START)
            break;
        base -= ROM_WORKSPACE_ALIGNMENT;
    }
    return 0;
}

static uint32_t workspace_restore(const RomWorkspace *workspace)
{
    uint32_t index;
    for (index = 0; index != ROM_WORKSPACE_SIZE / 4u; ++index)
        workspace->base[index] = workspace->fill_word;
    for (index = 0; index != ROM_WORKSPACE_SIZE / 4u; ++index) {
        if (workspace->base[index] != workspace->fill_word)
            return 0;
    }
    return 1;
}

static uint32_t workspace_run(const RomWorkspace *workspace,
                              uint32_t argument0, uint32_t argument1,
                              uintptr_t function_start,
                              uintptr_t function_end)
{
    volatile uint32_t *base = workspace->base;
    volatile uint32_t *meta = base + ROM_WORKSPACE_META_OFFSET / 4u;
    volatile uint32_t *guard = base + ROM_WORKSPACE_GUARD_OFFSET / 4u;
    const uint32_t *source = (const uint32_t *)function_start;
    uint32_t size = function_end - function_start;
    uint32_t result;
    uint32_t index;
    uint32_t guard_ok = 1;

    meta[0] = 0x4B53574Au; /* "JWSK" */
    meta[1] = workspace->fill_word;
    meta[2] = size;
    meta[3] = argument0;
    meta[4] = argument1;
    meta[5] = function_start;
    meta[6] = function_end;
    meta[7] = ROM_WORKSPACE_GUARD_WORD;
    for (index = 0; index != ROM_WORKSPACE_GUARD_SIZE / 4u; ++index)
        guard[index] = ROM_WORKSPACE_GUARD_WORD ^ index;
    for (index = 0; index != size / 4u; ++index)
        base[index] = source[index];

    result = journal_call_workspace(
        argument0, argument1,
        (void *)((uintptr_t)base + ROM_WORKSPACE_EXEC_OFFSET),
        (void *)((uintptr_t)base + ROM_WORKSPACE_STACK_TOP));

    for (index = 0; index != ROM_WORKSPACE_GUARD_SIZE / 4u; ++index) {
        if (guard[index] != (ROM_WORKSPACE_GUARD_WORD ^ index))
            guard_ok = 0;
    }
    if (!workspace_restore(workspace) || !guard_ok)
        return 0;
    return result;
}

/* Run ROM-resident orchestration on the private workspace stack. Unlike
 * workspace_run(), this does not copy code into the exec slot: the worker
 * itself never executes while GamePak flash is in command mode. Its nested
 * flash drivers still use their own, separately selected workspace. */
static uint32_t workspace_stack_run(const RomWorkspace *workspace,
                                    uint32_t argument0, uint32_t argument1,
                                    uintptr_t function_entry)
{
    volatile uint32_t *base = workspace->base;
    volatile uint32_t *meta = base + ROM_WORKSPACE_META_OFFSET / 4u;
    volatile uint32_t *guard = base + ROM_WORKSPACE_GUARD_OFFSET / 4u;
    uint32_t result;
    uint32_t index;
    uint32_t guard_ok = 1;

    meta[0] = 0x4B535746u; /* "FWSK" */
    meta[1] = workspace->fill_word;
    meta[2] = argument0;
    meta[3] = argument1;
    meta[4] = function_entry;
    meta[5] = ROM_WORKSPACE_STACK_TOP;
    meta[6] = 0;
    meta[7] = ROM_WORKSPACE_GUARD_WORD;
    for (index = 0; index != ROM_WORKSPACE_GUARD_SIZE / 4u; ++index)
        guard[index] = ROM_WORKSPACE_GUARD_WORD ^ index;

    result = journal_call_workspace(
        argument0, argument1, (void *)function_entry,
        (void *)((uintptr_t)base + ROM_WORKSPACE_STACK_TOP));

    for (index = 0; index != ROM_WORKSPACE_GUARD_SIZE / 4u; ++index) {
        if (guard[index] != (ROM_WORKSPACE_GUARD_WORD ^ index))
            guard_ok = 0;
    }
    if (!workspace_restore(workspace) || !guard_ok)
        return 0;
    return result;
}

static uint32_t run_rom_function(uint32_t argument0, uint32_t argument1,
                                 uintptr_t function_start,
                                 uintptr_t function_end,
                                 uintptr_t exclude_start,
                                 uint32_t exclude_size)
{
    uintptr_t section_start = (uintptr_t)__journal_ram_code_start;
    uintptr_t section_end = (uintptr_t)__journal_ram_code_end;
    uintptr_t exclude_end = exclude_start + exclude_size;
    RuntimeBackup backup;
    RomWorkspace workspace;
    uint32_t old_cpsr;
    uint16_t old_ime;
    uint32_t result;

    function_start &= ~1u;
    function_end &= ~1u;
    if (function_start < section_start || function_end > section_end ||
        function_start >= function_end || ((function_end - function_start) & 3u) ||
        function_end - function_start > ROM_WORKSPACE_EXEC_SIZE ||
        exclude_end < exclude_start)
        return 0;

    /* A GamePak flash command must not be interrupted by a ROM-resident IRQ
     * handler or an unrelated DMA. Keep only this copied RAM routine atomic;
     * restoring IME here lets the game refill Direct Sound between chunks. */
    old_cpsr = journal_irq_lock();
    old_ime = REG_IME;
    REG_IME = 0;
    runtime_pause(&backup);
    if (workspace_find(&workspace, exclude_start, exclude_end) &&
        !workspace_conflicts((uintptr_t)workspace.base,
                             current_stack_pointer(),
                             exclude_start, exclude_end) &&
        workspace_is_homogeneous((uintptr_t)workspace.base,
                                 &workspace.fill_word)) {
        result = workspace_run(&workspace, argument0, argument1,
                               function_start, function_end);
    } else {
        result = journal_run_from_stack(argument0, argument1,
                                        (const void *)function_start,
                                        (const void *)function_end);
    }
    runtime_restore(&backup);
    REG_IME = old_ime;
    journal_irq_restore(old_cpsr);
    return result;
}

static uint32_t identify_rom_flash_1(void)
{
    return run_rom_function(0, 0,
                            (uintptr_t)journal_rom_identify_1,
                            (uintptr_t)journal_rom_erase_1, 0, 0);
}

static uint32_t identify_rom_flash_2(void)
{
    return run_rom_function(0, 0,
                            (uintptr_t)journal_rom_identify_2,
                            (uintptr_t)journal_rom_erase_2, 0, 0);
}

static uint32_t identify_rom_flash_3(void)
{
    return run_rom_function(0, 0,
                            (uintptr_t)journal_rom_identify_3,
                            (uintptr_t)journal_rom_erase_3, 0, 0);
}

static uint32_t erase_rom_flash(uint32_t type, uint32_t target)
{
    if (type == 1u)
        return run_rom_function(target, 0,
                                (uintptr_t)journal_rom_erase_1,
                                (uintptr_t)journal_rom_program_1, 0, 0);
    if (type == 2u)
        return run_rom_function(target, 0,
                                (uintptr_t)journal_rom_erase_2,
                                (uintptr_t)journal_rom_program_2, 0, 0);
    if (type == 3u)
        return run_rom_function(target, 0,
                                (uintptr_t)journal_rom_erase_3,
                                (uintptr_t)journal_rom_program_3, 0, 0);
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
    if (type == 1u)
        return run_rom_function(target, (uintptr_t)&batch,
                                (uintptr_t)journal_rom_program_1,
                                (uintptr_t)journal_rom_identify_2,
                                (uintptr_t)source, count);
    if (type == 2u)
        return run_rom_function(target, (uintptr_t)&batch,
                                (uintptr_t)journal_rom_program_2,
                                (uintptr_t)journal_rom_identify_3,
                                (uintptr_t)source, count);
    if (type == 3u)
        return run_rom_function(target, (uintptr_t)&batch,
                                (uintptr_t)journal_rom_program_3,
                                (uintptr_t)__journal_ram_code_end,
                                (uintptr_t)source, count);
    return 0;
}

static uint32_t select_rom_driver(RomFlashDriver *driver)
{
    uint32_t first_probe;
    driver->type = 0;
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

static void save_backend_prepare(void)
{
}

static void save_backend_reset(void)
{
#ifndef CUSTOM_SAVE_BACKEND
    volatile uint8_t *save = (volatile uint8_t *)SAVE_BASE;
    save[SAVE_FLASH_MAGIC_0] = 0xAA;
    save[SAVE_FLASH_MAGIC_1] = 0x55;
    save[SAVE_FLASH_MAGIC_0] = 0xF0;
#endif
}

static uint32_t save_backend_program_byte(uint32_t offset, uint8_t value)
{
    volatile uint8_t *save = (volatile uint8_t *)SAVE_BASE;
    uint32_t timeout;
    if (offset >= 0x10000u)
        return 0;
    save[SAVE_FLASH_MAGIC_0] = 0xAA;
    save[SAVE_FLASH_MAGIC_1] = 0x55;
    save[SAVE_FLASH_MAGIC_0] = 0xA0;
    save[offset] = value;
    __asm volatile("nop");
    for (timeout = SAVE_PROGRAM_TIMEOUT; timeout; --timeout) {
        if (save[offset] == value) {
            save_backend_reset();
            return 1;
        }
    }
    save_backend_reset();
    return 0;
}

static uint32_t save_backend_range_is_erased(uint32_t offset, uint32_t size)
{
    uint32_t index;
    if (offset >= 0x10000u || size > 0x10000u - offset)
        return 0;
    for (index = 0; index < size; ++index) {
        if (save_backend_read(offset + index) != 0xFFu)
            return 0;
    }
    return 1;
}

static uint32_t save_backend_erase_command(uint32_t offset)
{
    volatile uint8_t *save = (volatile uint8_t *)SAVE_BASE;
    uint32_t timeout;
    uint8_t command = 0x30;
#ifdef CUSTOM_SAVE_BACKEND
    command = journal_save_chip_type_config == 2u ? 0x50 : 0x30;
#endif
    save[SAVE_FLASH_MAGIC_0] = 0xAA;
    save[SAVE_FLASH_MAGIC_1] = 0x55;
    save[SAVE_FLASH_MAGIC_0] = 0x80;
    save[SAVE_FLASH_MAGIC_0] = 0xAA;
    save[SAVE_FLASH_MAGIC_1] = 0x55;
    save[offset] = command;
    __asm volatile("nop");
    for (timeout = SAVE_ERASE_TIMEOUT; timeout; --timeout) {
        if (save[offset] == 0xFFu) {
            save_backend_reset();
            return 1;
        }
    }
    save_backend_reset();
    return 0;
}

static uint32_t save_backend_erase_sector_4k(uint32_t offset)
{
    if (offset >= 0x10000u || (offset & 0xFFFu) != 0)
        return 0;
    save_backend_prepare();
#ifdef CUSTOM_SAVE_BACKEND
    /* Custom command protocol from Lesserkuma/Custom_1M_FLASH_Patcher,
     * GPL-3.0. Each logical 4 KiB sector comprises two 2 KiB erase units. */
    if (!save_backend_erase_command(offset) ||
        !save_backend_erase_command(offset + 0x800u))
        return 0;
#else
    if (!save_backend_erase_command(offset))
        return 0;
#endif
    return save_backend_range_is_erased(offset, 0x1000u);
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

static uint32_t flush_save_sector(uint32_t first, uint32_t count,
                                  const PendingWrite *pending)
{
    uint32_t sector_offset = first;
    uint32_t scratch_offset = SAVE_SCRATCH_OFFSET + first;
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
        old_value = save_backend_read(save_physical_index(first + index));
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
            uint32_t offset = save_physical_index(first + index);
            if (state > 0 && save_backend_read(offset) != value &&
                !save_backend_program_byte(offset, value))
                return 0;
        }
        for (index = 0; index < count; ++index) {
            uint8_t value;
            int state = journal_overlay_value(first + index, pending, &value);
            if (state < 0 || (state > 0 &&
                save_backend_read(save_physical_index(first + index)) != value))
                return 0;
        }
        return 1;
    }

    /* A 4 KiB stack buffer is unsafe for games with a small System stack.
     * Preserve only bytes which are not supplied by Journal/pending data in
     * the matching upper Save-FLASH sector.  Successful flushes leave this
     * scratch sector erased, so the normal path avoids a redundant erase. */
    if (!save_backend_range_is_erased(scratch_offset, count) &&
        !save_backend_erase_sector_4k(scratch_offset))
        return 0;
    if (!save_backend_range_is_erased(scratch_offset, count))
        return 0;

    for (index = 0; index < count; ++index) {
        uint8_t value;
        int state = journal_overlay_value(first + index, pending, &value);
        if (state < 0)
            goto cleanup;
        if (!state) {
            value = save_backend_read(save_physical_index(first + index));
            if (value != 0xFFu) {
                scratch_used = 1;
                if (!save_backend_program_byte(
                        SAVE_SCRATCH_OFFSET + save_physical_index(first + index),
                        value))
                    goto cleanup;
            }
        }
    }
    for (index = 0; index < count; ++index) {
        uint8_t value;
        int state = journal_overlay_value(first + index, pending, &value);
        uint8_t expected = state > 0 ? 0xFFu :
            save_backend_read(save_physical_index(first + index));
        if (state < 0 || save_backend_read(
                SAVE_SCRATCH_OFFSET + save_physical_index(first + index)) != expected)
            goto cleanup;
    }

    if (!save_backend_erase_sector_4k(sector_offset))
        goto cleanup;
    for (index = 0; index < count; ++index) {
        uint8_t value;
        int state = journal_overlay_value(first + index, pending, &value);
        if (state < 0)
            goto cleanup;
        if (!state)
            value = save_backend_read(
                SAVE_SCRATCH_OFFSET + save_physical_index(first + index));
        if (value != 0xFFu && !save_backend_program_byte(
                save_physical_index(first + index), value))
            goto cleanup;
    }
    for (index = 0; index < count; ++index) {
        uint8_t value;
        int state = journal_overlay_value(first + index, pending, &value);
        if (state < 0)
            goto cleanup;
        if (!state)
            value = save_backend_read(
                SAVE_SCRATCH_OFFSET + save_physical_index(first + index));
        if (save_backend_read(save_physical_index(first + index)) != value)
            goto cleanup;
    }
    success = 1;

cleanup:
    if (scratch_used) {
        if (!save_backend_erase_sector_4k(scratch_offset) ||
            !save_backend_range_is_erased(scratch_offset, count))
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

    if (journal_indicator_config == INDICATOR_SAVE)
        REG_GREENSWAP = 1;

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
        save_backend_reset();
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
    return success;
}

static uint32_t flush_journal_with_workspace(
    uint32_t release_mask, const PendingWrite *pending)
{
    RuntimeBackup backup;
    RomWorkspace workspace;
    uintptr_t exclude_start = 0;
    uintptr_t exclude_end = 0;
    uint16_t old_ime = REG_IME;
    uint32_t result = 0;

    if (pending && pending->source && pending->size) {
        exclude_start = (uintptr_t)pending->source;
        exclude_end = exclude_start + pending->size;
        if (exclude_end < exclude_start)
            return 0;
    }

    /* Keep the complete Journal worker off games' small System stacks. Pause
     * first so candidate revalidation and the final exact restore bracket all
     * DMA-visible workspace mutations. */
    REG_IME = 0;
    runtime_pause(&backup);
    if (workspace_find(&workspace, exclude_start, exclude_end) &&
        !workspace_conflicts((uintptr_t)workspace.base,
                             current_stack_pointer(),
                             exclude_start, exclude_end) &&
        workspace_is_homogeneous((uintptr_t)workspace.base,
                                 &workspace.fill_word)) {
        result = workspace_stack_run(
            &workspace, release_mask, (uintptr_t)pending,
            (uintptr_t)flush_journal_inner);
    } else {
        /* Preserve the pre-workspace compatibility path when no homogeneous
         * EWRAM block exists. Nested ROM drivers retain their own one-shot
         * stack-copy fallback before the first flash command. */
        result = flush_journal_inner(release_mask, pending);
    }
    runtime_restore(&backup);
    REG_IME = old_ime;
    if (!result) {
        COUNTDOWN_COUNTER = (uint16_t)journal_countdown_config;
        if (journal_indicator_config == INDICATOR_COUNTDOWN)
            REG_GREENSWAP = 1;
    }
    return result;
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
            if (!flush_journal_with_workspace(0, (const PendingWrite *)0))
                return 0;
        } else {
            PendingWrite pending;
            pending.source = source;
            pending.first = first;
            pending.size = size;
            return flush_journal_with_workspace(0, &pending);
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
    return flush_journal_with_workspace(
        release_mask, (const PendingWrite *)0);
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
)" JOURNAL_SIGNATURE_ASM R"(
.size flash512k_signature, .-flash512k_signature
.text
)");
