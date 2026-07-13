// SPDX-License-Identifier: GPL-3.0-or-later AND MIT

/*
 * Fake-RTC persistence in writable GamePak ROM flash.
 *
 * The ROM command sequences and the copy-to-RAM execution model are adapted
 * from metroid-maniac/gba-auto-batteryless-patcher (MIT). Flash commands must
 * never execute from GamePak ROM, so every small driver below is copied to the
 * current RAM stack before it is entered.
 */

#include "../common/gba_hw.h"

#define ROM_BASE ((volatile uint8_t *)GBA_ROM_BASE_ADDRESS)
#define ROM_HALFWORDS ((volatile uint16_t *)GBA_ROM_BASE_ADDRESS)
#define RTC_PERSIST_BLOCK_SIZE 0x40000u
#define RTC_PERSIST_HALF_SIZE 0x20000u
#define RTC_PERSIST_RECORD_SIZE 32u
#define RTC_PERSIST_DISABLED 0xFFFFFFFFu
#define RTC_PERSIST_FLAG_CUSTOM_BACKEND 1u
#define RTC_PERSIST_FLAG_SHARED_SAVE_AREA 2u
#define RTC_PERSIST_MAGIC 0x31544352u /* "RCT1" */
#define RTC_PERSIST_COMMIT 0x46525443u /* same bytes as volatile RTC sentinel */
#define RTC_PERSIST_VERSION 1u
#define RTC_PERSIST_CHECK_XOR 0xA55A3CC3u
#define RTC_MAX_TIMESTAMP 0xBC19137Fu
#define RTC_MAX_SPEED 9999u
#define FLASH_TIMEOUT 0x01000000u
#define PROGRAM_TIMEOUT 0x00004000u
#define RAM_CODE __attribute__((section(".rtc_flash_ram_code"), aligned(4), noinline, used))
#define HIDDEN __attribute__((visibility("hidden")))

asm(R"(
.section .text.rtc_persist_config, "ax", %progbits
.balign 4
.global rtc_persist_block_offset_config
.type rtc_persist_block_offset_config, %object
rtc_persist_block_offset_config: .word 0xffffffff
.size rtc_persist_block_offset_config, .-rtc_persist_block_offset_config
.global rtc_persist_flags_config
.type rtc_persist_flags_config, %object
rtc_persist_flags_config: .word 0
.size rtc_persist_flags_config, .-rtc_persist_flags_config
.text

.arm
.balign 4
.global rtc_persist_run_from_stack
.hidden rtc_persist_run_from_stack
.type rtc_persist_run_from_stack, %function
rtc_persist_run_from_stack:
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
.size rtc_persist_run_from_stack, .-rtc_persist_run_from_stack

.global rtc_persist_irq_lock
.hidden rtc_persist_irq_lock
.type rtc_persist_irq_lock, %function
rtc_persist_irq_lock:
    mrs r0, cpsr
    orr r1, r0, #0x80
    msr cpsr_c, r1
    bx lr
.size rtc_persist_irq_lock, .-rtc_persist_irq_lock

.global rtc_persist_irq_restore
.hidden rtc_persist_irq_restore
.type rtc_persist_irq_restore, %function
rtc_persist_irq_restore:
    mrs r1, cpsr
    bic r1, r1, #0x80
    and r0, r0, #0x80
    orr r1, r1, r0
    msr cpsr_c, r1
    bx lr
.size rtc_persist_irq_restore, .-rtc_persist_irq_restore
.thumb
)");

extern const uint32_t rtc_persist_block_offset_config;
extern const uint32_t rtc_persist_flags_config;
extern uint32_t rtc_state_snapshot_persistent(uint32_t *timestamp_out,
                                               uint32_t *packed_state_out);
extern uint32_t rtc_state_restore_persistent(uint32_t timestamp,
                                              uint32_t packed_state);
extern HIDDEN uint32_t rtc_persist_run_from_stack(
    uint32_t argument0, uint32_t argument1,
    const void *function_start, const void *function_end);
extern HIDDEN uint32_t rtc_persist_irq_lock(void);
extern HIDDEN void rtc_persist_irq_restore(uint32_t cpsr);

typedef struct {
    uint32_t magic;
    uint32_t version;
    uint32_t timestamp;
    uint32_t packed_state;
    uint32_t timestamp_inverse;
    uint32_t packed_state_inverse;
    uint32_t checksum;
    uint32_t commit;
} RtcPersistRecord;

typedef struct {
    const uint8_t *source;
    uint32_t count;
} ProgramBatch;

typedef struct {
    uint16_t soundcnt_l;
    uint16_t soundcnt_h;
    uint16_t timer0;
    uint16_t timer1;
    uint16_t dma[4];
} RuntimeBackup;

typedef struct {
    uint32_t type;
} FlashDriver;

static inline __attribute__((always_inline)) void flash_write(uint32_t offset,
                                                               uint16_t value)
{
    ROM_HALFWORDS[offset >> 1] = value;
    __asm volatile("nop");
}

static inline __attribute__((always_inline)) uint16_t batch_halfword(
    const ProgramBatch *batch, uint32_t byte_index)
{
    return (uint16_t)((uint16_t)batch->source[byte_index]
        | ((uint16_t)batch->source[byte_index + 1u] << 8));
}

RAM_CODE uint32_t rtc_flash_identify_1(void)
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

    flash_write(0x59u, 0x0042);
    special = ROM_BASE[0xB2];
    flash_write(0x59u, 0x0096);
    flash_write(0, 0x00FF);
    if (special != 0x96u) {
        volatile uint32_t delay;
        for (delay = 0; delay != 1024u; ++delay)
            __asm volatile("nop");
        return 2; /* Batteryless type 4. */
    }
    return 1;
}

RAM_CODE uint32_t rtc_flash_erase_1(uint32_t target)
{
    volatile uint32_t timeout;
    flash_write(target, 0x00FF);
    flash_write(target, 0x0060);
    flash_write(target, 0x00D0);
    flash_write(target, 0x0020);
    flash_write(target, 0x00D0);
    for (timeout = FLASH_TIMEOUT; timeout; --timeout) {
        __asm volatile("nop");
        if (ROM_HALFWORDS[target >> 1] == 0x0080u)
            break;
    }
    flash_write(target, 0x00FF);
    return timeout != 0 && ROM_HALFWORDS[target >> 1] == 0xFFFFu;
}

RAM_CODE uint32_t rtc_flash_program_1(uint32_t target,
                                      const ProgramBatch *batch)
{
    volatile uint32_t timeout;
    uint32_t index;
    uint16_t status = 0;

    flash_write(target, 0x00FF);
    flash_write(target, 0x0060);
    flash_write(target, 0x00D0);
    for (timeout = PROGRAM_TIMEOUT; timeout; --timeout) {
        status = ROM_HALFWORDS[target >> 1];
        if (status & 0x0080u)
            break;
    }
    flash_write(target, 0x00FF);
    if (!timeout || status != 0x0080u)
        return 0;

    for (index = 0; index < batch->count; index += 2u) {
        uint32_t address = target + index;
        uint16_t value = batch_halfword(batch, index);
        flash_write(address, 0x0040);
        flash_write(address, value);
        for (timeout = PROGRAM_TIMEOUT; timeout; --timeout) {
            status = ROM_HALFWORDS[address >> 1];
            if (status & 0x0080u)
                break;
        }
        if (!timeout) {
            flash_write(target, 0x00FF);
            return 0;
        }
    }
    flash_write(target, 0x00FF);
    for (index = 0; index < batch->count; index += 2u) {
        if (ROM_HALFWORDS[(target + index) >> 1] != batch_halfword(batch, index))
            return 0;
    }
    return 1;
}

RAM_CODE uint32_t rtc_flash_erase_4(uint32_t target)
{
    volatile uint32_t timeout;
    volatile uint32_t delay;
    flash_write(target, 0x00FF);
    flash_write(target, 0x0060);
    flash_write(target, 0x00D0);
    flash_write(target, 0x0020);
    flash_write(target, 0x00D0);
    for (timeout = FLASH_TIMEOUT; timeout; --timeout) {
        __asm volatile("nop");
        if (ROM_HALFWORDS[target >> 1] & 0x0080u)
            break;
    }
    flash_write(target, 0x00FF);
    for (delay = 0; delay != 1024u; ++delay)
        __asm volatile("nop");
    return timeout != 0 && ROM_HALFWORDS[target >> 1] == 0xFFFFu;
}

RAM_CODE uint32_t rtc_flash_program_4(uint32_t target,
                                      const ProgramBatch *batch)
{
    volatile uint32_t timeout;
    uint32_t page = target & ~0x3FFu;
    uint32_t index;

    flash_write(page, 0x00EA);
    for (timeout = PROGRAM_TIMEOUT; timeout; --timeout) {
        if (ROM_HALFWORDS[page >> 1] & 0x0080u)
            break;
    }
    if (!timeout) {
        flash_write(page, 0x00FF);
        return 0;
    }
    flash_write(page, 0x01FF);
    for (index = 0; index != 0x400u; index += 2u) {
        uint32_t address = page + index;
        uint16_t value = 0xFFFFu;
        if (address >= target && address - target < batch->count)
            value = batch_halfword(batch, address - target);
        flash_write(address, value);
    }
    flash_write(page, 0x00D0);
    for (timeout = FLASH_TIMEOUT; timeout; --timeout) {
        if (ROM_HALFWORDS[page >> 1] & 0x0080u)
            break;
    }
    flash_write(page, 0x00FF);
    if (!timeout)
        return 0;
    for (index = 0; index < batch->count; index += 2u) {
        if (ROM_HALFWORDS[(target + index) >> 1] != batch_halfword(batch, index))
            return 0;
    }
    return 1;
}

RAM_CODE uint32_t rtc_flash_identify_2(void)
{
    uint32_t original = *(volatile uint32_t *)ROM_BASE;
    uint32_t identified;
    flash_write(0, 0x00F0);
    flash_write(0xAAAu, 0x00A9);
    flash_write(0x555u, 0x0056);
    flash_write(0xAAAu, 0x0090);
    identified = *(volatile uint32_t *)ROM_BASE;
    flash_write(0, 0x00F0);
    return original != identified;
}

RAM_CODE uint32_t rtc_flash_erase_2(uint32_t target)
{
    volatile uint32_t timeout;
    flash_write(target, 0x00F0);
    flash_write(0xAAAu, 0x00A9);
    flash_write(0x555u, 0x0056);
    flash_write(0xAAAu, 0x0080);
    flash_write(0xAAAu, 0x00A9);
    flash_write(0x555u, 0x0056);
    flash_write(target, 0x0030);
    for (timeout = FLASH_TIMEOUT; timeout; --timeout) {
        __asm volatile("nop");
        if (ROM_HALFWORDS[target >> 1] == 0xFFFFu)
            break;
    }
    flash_write(target, 0x00F0);
    return timeout != 0 && ROM_HALFWORDS[target >> 1] == 0xFFFFu;
}

RAM_CODE uint32_t rtc_flash_program_2(uint32_t target,
                                      const ProgramBatch *batch)
{
    volatile uint32_t timeout;
    uint32_t index;
    for (index = 0; index < batch->count; index += 2u) {
        uint32_t address = target + index;
        uint16_t value = batch_halfword(batch, index);
        flash_write(0xAAAu, 0x00A9);
        flash_write(0x555u, 0x0056);
        flash_write(0xAAAu, 0x00A0);
        flash_write(address, value);
        for (timeout = PROGRAM_TIMEOUT; timeout; --timeout) {
            if (ROM_HALFWORDS[address >> 1] == value)
                break;
        }
        if (!timeout) {
            flash_write(target, 0x00F0);
            return 0;
        }
    }
    flash_write(target, 0x00F0);
    return 1;
}

RAM_CODE uint32_t rtc_flash_identify_3(void)
{
    uint32_t original = *(volatile uint32_t *)ROM_BASE;
    uint32_t identified;
    flash_write(0, 0x00F0);
    flash_write(0xAAAu, 0x00AA);
    flash_write(0x555u, 0x0055);
    flash_write(0xAAAu, 0x0090);
    identified = *(volatile uint32_t *)ROM_BASE;
    flash_write(0, 0x00F0);
    return original != identified;
}

RAM_CODE uint32_t rtc_flash_erase_3(uint32_t target)
{
    volatile uint32_t timeout;
    flash_write(target, 0x00F0);
    flash_write(0xAAAu, 0x00AA);
    flash_write(0x555u, 0x0055);
    flash_write(0xAAAu, 0x0080);
    flash_write(0xAAAu, 0x00AA);
    flash_write(0x555u, 0x0055);
    flash_write(target, 0x0030);
    for (timeout = FLASH_TIMEOUT; timeout; --timeout) {
        __asm volatile("nop");
        if (ROM_HALFWORDS[target >> 1] == 0xFFFFu)
            break;
    }
    flash_write(target, 0x00F0);
    return timeout != 0 && ROM_HALFWORDS[target >> 1] == 0xFFFFu;
}

RAM_CODE uint32_t rtc_flash_program_3(uint32_t target,
                                      const ProgramBatch *batch)
{
    volatile uint32_t timeout;
    uint32_t index;
    for (index = 0; index < batch->count; index += 2u) {
        uint32_t address = target + index;
        uint16_t value = batch_halfword(batch, index);
        flash_write(0xAAAu, 0x00AA);
        flash_write(0x555u, 0x0055);
        flash_write(0xAAAu, 0x00A0);
        flash_write(address, value);
        for (timeout = PROGRAM_TIMEOUT; timeout; --timeout) {
            if (ROM_HALFWORDS[address >> 1] == value)
                break;
        }
        if (!timeout) {
            flash_write(target, 0x00F0);
            return 0;
        }
    }
    flash_write(target, 0x00F0);
    return 1;
}

RAM_CODE uint32_t rtc_flash_ram_code_end(void)
{
    return 0;
}

static void runtime_pause(RuntimeBackup *backup)
{
    backup->soundcnt_l = REG_SOUNDCNT_L;
    backup->soundcnt_h = (uint16_t)(REG_SOUNDCNT_H & ~0x8800u);
    backup->timer0 = REG_TM0CNT_H;
    backup->timer1 = REG_TM1CNT_H;
    backup->dma[0] = REG_DMA0CNT_H;
    backup->dma[1] = REG_DMA1CNT_H;
    backup->dma[2] = REG_DMA2CNT_H;
    backup->dma[3] = REG_DMA3CNT_H;

    REG_SOUNDCNT_H = (uint16_t)(backup->soundcnt_h & ~0x3300u);
    REG_SOUNDCNT_L = 0;
    REG_TM0CNT_H = (uint16_t)(backup->timer0 & ~0x0080u);
    REG_TM1CNT_H = (uint16_t)(backup->timer1 & ~0x0080u);
    REG_DMA0CNT_H = 0;
    REG_DMA1CNT_H = 0;
    REG_DMA2CNT_H = 0;
    REG_DMA3CNT_H = 0;
}

static void runtime_restore(const RuntimeBackup *backup)
{
    REG_DMA3CNT_H = backup->dma[3];
    REG_DMA2CNT_H = backup->dma[2];
    REG_DMA1CNT_H = backup->dma[1];
    REG_DMA0CNT_H = backup->dma[0];
    REG_SOUNDCNT_H = backup->soundcnt_h;
    REG_SOUNDCNT_L = backup->soundcnt_l;
    REG_TM1CNT_H = backup->timer1;
    REG_TM0CNT_H = backup->timer0;
}

static void custom_backend_cleanup(void)
{
    if (rtc_persist_flags_config & RTC_PERSIST_FLAG_CUSTOM_BACKEND) {
        *(volatile uint8_t *)GBA_SRAM_BANK_SELECT_ADDRESS = 0;
        __asm volatile("b 1f\n1:" ::: "memory");
    }
}

static uint32_t run_driver(uint32_t argument0, uint32_t argument1,
                           uintptr_t start, uintptr_t end)
{
    uint32_t result = rtc_persist_run_from_stack(
        argument0, argument1, (const void *)start, (const void *)end);
    custom_backend_cleanup();
    return result;
}

static uint32_t select_flash_driver(FlashDriver *driver)
{
    uint32_t first = run_driver(0, 0,
        (uintptr_t)rtc_flash_identify_1, (uintptr_t)rtc_flash_erase_1);
    if (first == 1u) {
        driver->type = 1;
        return 1;
    }
    if (first == 2u) {
        driver->type = 4;
        return 1;
    }
    if (run_driver(0, 0,
            (uintptr_t)rtc_flash_identify_2, (uintptr_t)rtc_flash_erase_2)) {
        driver->type = 2;
        return 1;
    }
    if (run_driver(0, 0,
            (uintptr_t)rtc_flash_identify_3, (uintptr_t)rtc_flash_erase_3)) {
        driver->type = 3;
        return 1;
    }
    driver->type = 0;
    return 0;
}

static uint32_t erase_flash(const FlashDriver *driver, uint32_t target)
{
    if (driver->type == 1u)
        return run_driver(target, 0,
            (uintptr_t)rtc_flash_erase_1, (uintptr_t)rtc_flash_program_1);
    if (driver->type == 4u)
        return run_driver(target, 0,
            (uintptr_t)rtc_flash_erase_4, (uintptr_t)rtc_flash_program_4);
    if (driver->type == 2u)
        return run_driver(target, 0,
            (uintptr_t)rtc_flash_erase_2, (uintptr_t)rtc_flash_program_2);
    if (driver->type == 3u)
        return run_driver(target, 0,
            (uintptr_t)rtc_flash_erase_3, (uintptr_t)rtc_flash_program_3);
    return 0;
}

static uint32_t program_record(const FlashDriver *driver, uint32_t target,
                               const RtcPersistRecord *record)
{
    ProgramBatch batch;
    uintptr_t start;
    uintptr_t end;
    batch.source = (const uint8_t *)record;
    batch.count = sizeof(*record);
    if (driver->type == 1u) {
        start = (uintptr_t)rtc_flash_program_1;
        end = (uintptr_t)rtc_flash_erase_4;
    } else if (driver->type == 4u) {
        start = (uintptr_t)rtc_flash_program_4;
        end = (uintptr_t)rtc_flash_identify_2;
    } else if (driver->type == 2u) {
        start = (uintptr_t)rtc_flash_program_2;
        end = (uintptr_t)rtc_flash_identify_3;
    } else if (driver->type == 3u) {
        start = (uintptr_t)rtc_flash_program_3;
        end = (uintptr_t)rtc_flash_ram_code_end;
    } else {
        return 0;
    }
    return run_driver(target, (uintptr_t)&batch, start, end);
}

static uint32_t persistence_config_valid(void)
{
    uint32_t base = rtc_persist_block_offset_config;
    if (base == RTC_PERSIST_DISABLED || (base & (RTC_PERSIST_BLOCK_SIZE - 1u)))
        return 0;
    if (base >= 0x02000000u || base + RTC_PERSIST_BLOCK_SIZE > 0x02000000u)
        return 0;
    return !(base <= 0x01000000u
        && 0x01000000u < base + RTC_PERSIST_BLOCK_SIZE);
}

static uint32_t record_checksum(uint32_t timestamp, uint32_t packed_state)
{
    return RTC_PERSIST_MAGIC ^ RTC_PERSIST_VERSION ^ timestamp ^ packed_state
        ^ RTC_PERSIST_CHECK_XOR;
}

static uint32_t record_valid(const volatile RtcPersistRecord *record)
{
    uint32_t timestamp = record->timestamp;
    uint32_t packed = record->packed_state;
    uint32_t speed = packed >> 18;
    return record->magic == RTC_PERSIST_MAGIC
        && record->version == RTC_PERSIST_VERSION
        && record->commit == RTC_PERSIST_COMMIT
        && timestamp <= RTC_MAX_TIMESTAMP
        && speed <= RTC_MAX_SPEED
        && record->timestamp_inverse == ~timestamp
        && record->packed_state_inverse == ~packed
        && record->checksum == record_checksum(timestamp, packed);
}

static void make_record(RtcPersistRecord *record, uint32_t timestamp,
                        uint32_t packed_state)
{
    record->magic = RTC_PERSIST_MAGIC;
    record->version = RTC_PERSIST_VERSION;
    record->timestamp = timestamp;
    record->packed_state = packed_state;
    record->timestamp_inverse = ~timestamp;
    record->packed_state_inverse = ~packed_state;
    record->checksum = record_checksum(timestamp, packed_state);
    record->commit = RTC_PERSIST_COMMIT;
}

uint32_t rtc_persist_load(void)
{
    const volatile RtcPersistRecord *record;
    if (!persistence_config_valid())
        return 0;
    record = (const volatile RtcPersistRecord *)(
        GBA_ROM_BASE_ADDRESS + rtc_persist_block_offset_config
        + RTC_PERSIST_BLOCK_SIZE - RTC_PERSIST_RECORD_SIZE);
    if (!record_valid(record))
        return 0;
    return rtc_state_restore_persistent(record->timestamp, record->packed_state);
}

uint32_t rtc_persist_flush(uint32_t release_mask)
{
    RuntimeBackup backup;
    RtcPersistRecord record;
    FlashDriver driver;
    uint32_t timestamp;
    uint32_t packed_state;
    uint32_t base;
    uint32_t record_offset;
    uint32_t old_cpsr;
    uint16_t old_ime;
    uint32_t result = 0;
    uint32_t offset;
    (void)release_mask;

    if (!persistence_config_valid())
        return 0;
    if (!rtc_state_snapshot_persistent(&timestamp, &packed_state)
        || timestamp > RTC_MAX_TIMESTAMP)
        return 0;
    make_record(&record, timestamp, packed_state);
    base = rtc_persist_block_offset_config;
    record_offset = base + RTC_PERSIST_BLOCK_SIZE - sizeof(record);

    old_cpsr = rtc_persist_irq_lock();
    old_ime = REG_IME;
    REG_IME = 0;
    runtime_pause(&backup);

    if (!select_flash_driver(&driver))
        goto restore;

    /* Always issue exactly two half-block erases. On a 128-KiB-sector module
     * this covers both halves; on a larger sector the repeated erase remains
     * before any subsequent programming. */
    if (!erase_flash(&driver, base)
        || !erase_flash(&driver, base + RTC_PERSIST_HALF_SIZE))
        goto restore;

    for (offset = 0; offset < RTC_PERSIST_BLOCK_SIZE; offset += 4u) {
        if (*(volatile uint32_t *)(GBA_ROM_BASE_ADDRESS + base + offset)
            != 0xFFFFFFFFu)
            goto restore;
    }

    if (!program_record(&driver, record_offset, &record))
        goto restore;
    if (!record_valid((const volatile RtcPersistRecord *)(
            GBA_ROM_BASE_ADDRESS + record_offset)))
        goto restore;
    result = 1;

restore:
    custom_backend_cleanup();
    runtime_restore(&backup);
    REG_IME = old_ime;
    rtc_persist_irq_restore(old_cpsr);
    return result;
}

uint32_t rtc_persist_flush_initial(void)
{
    /* A shared Batteryless/Journal block may contain live save data. Its owner
     * must perform the coordinated erase/commit sequence on the next save;
     * a cold-boot menu confirmation must never erase that block by itself. */
    if (rtc_persist_flags_config & RTC_PERSIST_FLAG_SHARED_SAVE_AREA)
        return 1;
    return rtc_persist_flush(0);
}
