// SPDX-License-Identifier: GPL-3.0-only AND MIT

/*
 * Direct 64 KiB Save-FLASH backend for GBA Save Type Patcher.
 *
 * The low-level command protocol is derived from
 * metroid-maniac/gba-flash-patcher (MIT). Custom Type 1/2 command handling
 * follows Lesserkuma/Custom_1M_FLASH_Patcher (GPL-3.0-only).
 *
 * SRAM layout:
 *   0000-7fff inverted 32 KiB base,
 *   8000-dfff six sector-local update logs (8000-801f header/marker),
 *   e000-efff one update-log sector shared by logical sectors six and seven,
 *   f000-ffff one-sector reconstruction scratch.
 *   Each 64-byte log slice accepts both two-byte deltas and compressed
 *   whole-block records; the cheaper representation is selected from the
 *   bytes being written, never from ROM identity.
 * EEPROM layout:
 *   0000-1fff inverted base, 2000-bfff five delta generations, c000 header,
 *   d000 byte-program marker, d100-d4ff per-slot inverted seeds,
 *   e000-ffff two compaction scratch sectors.
 *
 * Power-loss recovery is intentionally outside this backend's contract.
 */

#include "../common/gba_hw.h"

#define SAVE_BASE GBA_SAVE_BASE_ADDRESS
#define SAVE_SIZE 0x10000u
#define SAVE_MAGIC_0 0x5555u
#define SAVE_MAGIC_1 0x2AAAu
#define SECTOR_SIZE 0x1000u
#define SRAM_LOGICAL_SIZE 0x8000u
#define SRAM_HEADER_BASE 0x8000u
#define SRAM_LAYOUT_MARKER_BASE 0xD0u
#define SRAM_PROGRAM_MARKER (SRAM_HEADER_BASE + 0x10u)
#define SRAM_SCRATCH_BASE 0xF000u
#define SRAM_SECTOR_LOG_VERSION 16u
#define SRAM_SECTOR_LOG_COUNT 8u
#define SRAM_SECTOR_LOG_ENTRY_SIZE 2u
#define SRAM_SECTOR_LOG_RLE_TAG_BASE 0x80u
#define SRAM_SECTOR_LOG_RLE_TAG_MASK 0xC0u
#define SRAM_SECTOR_LOG_RLE_LENGTH_MASK 0x3Fu
#define SRAM_SECTOR_LOG_OVERFLOW_TAG 0xC0u
#define SRAM_SECTOR_LOG_OVERFLOW_MARKER 0xC1u
#define SRAM_SECTOR_LOG_HEADER_SIZE 0x20u
#define SRAM_SECTOR_LOG_BLOCK_SIZE 64u
#define SRAM_SECTOR_LOG_BLOCK_COUNT (SECTOR_SIZE / SRAM_SECTOR_LOG_BLOCK_SIZE)
#define SRAM_SECTOR_LOG_BASE SRAM_HEADER_BASE
#define SRAM_FULL_LOG_SECTOR_COUNT 6u
#define SRAM_SECTOR0_LOG_SLICE_SIZE 63u
#define SRAM_FULL_LOG_SLICE_SIZE 64u
#define SRAM_SHARED_LOG_SLICE_SIZE 32u
#define SRAM_SHARED_LOG_BASE 0xE000u
#define SRAM_SHARED_LOG_PARTITION_SIZE 0x800u
#define SRAM_ALIAS_CHUNK 64u
#define SRAM_SECTOR_OVERLAY_SIZE (SRAM_SECTOR_LOG_BLOCK_SIZE / 8u)
#ifndef DIRECT_SRAM_ONLY_BUILD
#define EEPROM_LOGICAL_SIZE 0x2000u
#define EEPROM_DELTA_BASE 0x2000u
#define EEPROM_DELTA_SIZE 0x2000u
#define EEPROM_GENERATIONS 5u
#define EEPROM_HEADER_BASE 0xC000u
#define EEPROM_RESERVE_BASE 0xD000u
#define EEPROM_PROGRAM_MARKER EEPROM_RESERVE_BASE
#define EEPROM_SEED_BASE (EEPROM_RESERVE_BASE + 0x100u)
#define EEPROM_LAYOUT_MARKER_BASE 0xE0u
#define EEPROM_SCRATCH_BASE 0xE000u
#endif
#define SAVE_PROGRAM_TIMEOUT 0x4000u
#define SAVE_ERASE_TIMEOUT 0x01000000u
#define SAVE_COMMAND_ATTEMPTS 2u
#define SAVE_LAYOUT_SRAM 0u
#ifndef DIRECT_SRAM_ONLY_BUILD
#define SAVE_LAYOUT_EEPROM 1u
#endif
#define SAVE_PROTOCOL_STANDARD 0u
#define SAVE_PROTOCOL_CUSTOM_TYPE_1 1u
#define SAVE_PROTOCOL_CUSTOM_TYPE_2 2u
#define HIDDEN __attribute__((visibility("hidden")))
#define NOINLINE __attribute__((noinline))
#define NAKED __attribute__((naked, noinline))
#define FLASH_READER_THUMB_CODE 0x47707800u
#define FLASH_RANGE_READER_HALFWORDS 9u
#define FLASH_READER_STORAGE_HALFWORDS 18u
#define SRAM_COMPARE_INVERTED_HALFWORDS 19u
#define SRAM_BLANK_ZERO_HALFWORDS 18u
#define FLASH_READ_CHUNK 64u
#define SRAM_VERIFY_CHUNK 16u

#ifndef DIRECT_SRAM_ONLY_BUILD
#define DIRECT_EEPROM_LAYOUT_VERSION 5u
/*
 * Leave a tiny, fixed instruction boundary before returning to EEPROM SDK
 * callers.  Save-FLASH completion has already been polled at this point; this
 * does not wait for VCOUNT or mutate IME, DMA, timer, or sound state.
 */
#define EEPROM_RETURN_SETTLE_ITERATIONS 255
#endif
#define STRINGIFY_INNER(value) #value
#define STRINGIFY(value) STRINGIFY_INNER(value)
#define SNAPSHOT_MAGIC 0x33535344u /* "DSS3" */
#define SNAPSHOT_VERSION 3u
#define SNAPSHOT_HEADER_SIZE 16u
#define SNAPSHOT_DATA_BASE SNAPSHOT_HEADER_SIZE
#define SNAPSHOT_SLOT_SIZE 0x8000u
#define SNAPSHOT_RAW 0x52u
#define SNAPSHOT_RLE 0x4Cu
#define SNAPSHOT_PAGE_SIZE 0x400u
#define SNAPSHOT_PAGE_COUNT (SRAM_LOGICAL_SIZE / SNAPSHOT_PAGE_SIZE)
#define SNAPSHOT_INDEX_SIZE (SNAPSHOT_PAGE_COUNT * 2u)
#define SNAPSHOT_GAP_CHUNK 32u
#define SNAPSHOT_RLE_ENCODE_MAX (SRAM_LOGICAL_SIZE * 2u)
#define SNAPSHOT_PROVIDER_MAX 128u
#define SNAPSHOT_TRANSIENT_MAX 8u

typedef uint8_t (*FlashReadByteFn)(const volatile uint8_t *address);
typedef void (*FlashReadRangeFn)(const volatile uint8_t *source,
                                 uint8_t *destination, uint32_t size);
typedef uint32_t (*SramBlankProbeFn)(const volatile uint8_t *marker,
                                     uint8_t *destination, uint32_t size,
                                     const volatile uint8_t *source);
#ifdef DIRECT_SRAM_TRANSACTION_BUILD
typedef uint32_t (*SramCompareInvertedFn)(
    const volatile uint8_t *physical, const uint8_t *logical, uint32_t size);
#endif

typedef struct {
    volatile uint32_t byte_code;
    volatile uint16_t range_code[FLASH_READER_STORAGE_HALFWORDS];
#ifdef DIRECT_SRAM_TRANSACTION_BUILD
    volatile uint16_t compare_inverted_code[SRAM_COMPARE_INVERTED_HALFWORDS];
#endif
} FlashReaderStorage;

typedef FlashReaderStorage *FlashReadFn;

typedef struct {
    uint32_t logical_first;
    uint32_t size;
    uintptr_t source;
} SnapshotProvider;

typedef struct {
    uint32_t logical_first;
    uint32_t size;
    uintptr_t source;
} SnapshotRange;

#define DIRECT_SIGNATURE_ASM R"(.ascii "lk_flash_direct_v17"
)"

#define SRAM_BLANK_ZERO_ASM R"(
    ldrb r0, [r0]
    cmp r0, #255
    bne 2f
    mov r0, #0
    strb r0, [r1]
    add r1, #1
    sub r2, #1
    beq 3f
1:
    ldrb r0, [r3]
    mov r0, #0
    strb r0, [r1]
    add r3, #1
    add r1, #1
    sub r2, #1
    bne 1b
3:
    mvn r0, r0
2:
    bx lr
    .short 0
)"

#define FLASH_RANGE_READER_ASM R"(
    cmp r2, #0
    beq 2f
1:
    ldrb r3, [r0]
    strb r3, [r1]
    add r0, #1
    add r1, #1
    sub r2, #1
    bne 1b
2:
    bx lr
)"

asm(R"(
.section .direct_header, "a", %progbits
.balign 4
.global direct_layout_config
.hidden direct_layout_config
.type direct_layout_config, %object
direct_layout_config: .word 0xFFFFFFFF
.global direct_save_protocol_config
.hidden direct_save_protocol_config
.type direct_save_protocol_config, %object
direct_save_protocol_config: .word 0
.text
.thumb
.balign 2
.global flash_read_range_template
.hidden flash_read_range_template
.type flash_read_range_template, %object
flash_read_range_template:
)" FLASH_RANGE_READER_ASM R"(
.global flash_read_range_template_end
.hidden flash_read_range_template_end
flash_read_range_template_end:
.size flash_read_range_template, flash_read_range_template_end - flash_read_range_template
.balign 2
.global sram_blank_zero_template
.hidden sram_blank_zero_template
.type sram_blank_zero_template, %object
sram_blank_zero_template:
)" SRAM_BLANK_ZERO_ASM R"(
.global sram_blank_zero_template_end
.hidden sram_blank_zero_template_end
sram_blank_zero_template_end:
.size sram_blank_zero_template, sram_blank_zero_template_end - sram_blank_zero_template
)");

extern HIDDEN const uint32_t direct_layout_config;
extern HIDDEN const uint32_t direct_save_protocol_config;
extern HIDDEN const uint16_t
    flash_read_range_template[FLASH_RANGE_READER_HALFWORDS];
extern HIDDEN const uint16_t
    sram_blank_zero_template[SRAM_BLANK_ZERO_HALFWORDS];

#ifdef DIRECT_SRAM_TRANSACTION_BUILD
asm(R"(
.text
.thumb
.balign 2
.global sram_compare_inverted_template
.hidden sram_compare_inverted_template
.type sram_compare_inverted_template, %object
sram_compare_inverted_template:
    push {r4, r5}
    mov r5, #255
    cmp r2, #0
    beq 2f
1:
    ldrb r3, [r0]
    ldrb r4, [r1]
    eor r3, r5
    cmp r3, r4
    bne 3f
    add r0, #1
    add r1, #1
    sub r2, #1
    bne 1b
2:
    mov r0, #1
    pop {r4, r5}
    bx lr
3:
    mov r0, #0
    pop {r4, r5}
    bx lr
.global sram_compare_inverted_template_end
.hidden sram_compare_inverted_template_end
sram_compare_inverted_template_end:
.size sram_compare_inverted_template, sram_compare_inverted_template_end - sram_compare_inverted_template
)" );

extern HIDDEN const uint16_t
    sram_compare_inverted_template[SRAM_COMPARE_INVERTED_HALFWORDS];
#endif

#ifdef DIRECT_SNAPSHOT_BUILD
HIDDEN volatile const uint32_t direct_snapshot_provider_count_config
    __attribute__((section(".direct_header"), used)) = 0;
HIDDEN volatile const uint32_t direct_snapshot_commit_first_config
    __attribute__((section(".direct_header"), used)) = 0;
HIDDEN volatile const uint32_t direct_snapshot_commit_size_config
    __attribute__((section(".direct_header"), used)) = 0;
HIDDEN volatile const uint32_t direct_snapshot_transient_count_config
    __attribute__((section(".direct_header"), used)) = 0;
HIDDEN volatile const SnapshotProvider
    direct_snapshot_providers_config[SNAPSHOT_PROVIDER_MAX]
    __attribute__((section(".direct_header"), used)) = {{0, 0, 0}};
HIDDEN volatile const SnapshotRange
    direct_snapshot_transient_ranges_config[SNAPSHOT_TRANSIENT_MAX]
    __attribute__((section(".direct_header"), used)) = {{0, 0, 0}};
#endif

static uint32_t direct_save_protocol_valid(void)
{
    return direct_save_protocol_config == SAVE_PROTOCOL_STANDARD
        || direct_save_protocol_config == SAVE_PROTOCOL_CUSTOM_TYPE_1
        || direct_save_protocol_config == SAVE_PROTOCOL_CUSTOM_TYPE_2;
}

static uint32_t direct_config_matches(uint32_t layout)
{
    return direct_layout_config == layout && direct_save_protocol_valid();
}

/*
 * GBA Game Pak FLASH data/status reads must be issued by an opcode executing
 * in WRAM.  Each public entry installs byte and sequential-range Thumb readers
 * on its WRAM stack and passes them through the complete call tree.
 */
static NOINLINE FlashReadFn
flash_byte_reader_on_stack(FlashReaderStorage *storage)
{
    storage->byte_code = FLASH_READER_THUMB_CODE;
    return storage;
}

static FlashReadFn flash_range_reader_on_stack(FlashReaderStorage *storage)
{
    uint32_t index;
    for (index = 0; index < FLASH_RANGE_READER_HALFWORDS; ++index)
        storage->range_code[index] = flash_read_range_template[index];
#ifdef DIRECT_SRAM_TRANSACTION_BUILD
    for (index = 0; index < SRAM_COMPARE_INVERTED_HALFWORDS; ++index) {
        storage->compare_inverted_code[index]
            = sram_compare_inverted_template[index];
    }
#endif
    return storage;
}

static FlashReadFn flash_reader_on_stack(FlashReaderStorage *storage)
{
    return flash_range_reader_on_stack(flash_byte_reader_on_stack(storage));
}

#ifndef DIRECT_SNAPSHOT_BUILD
static uint32_t sram_probe_fill_blank_zero(FlashReaderStorage *storage,
                                           uint32_t first,
                                           uint8_t *destination,
                                           uint32_t size)
{
    SramBlankProbeFn probe;
    uint32_t index;
    for (index = 0; index < SRAM_BLANK_ZERO_HALFWORDS; ++index)
        storage->range_code[index] = sram_blank_zero_template[index];
    probe = (SramBlankProbeFn)((uintptr_t)storage->range_code | 1u);
    return probe((const volatile uint8_t *)(SAVE_BASE + SRAM_HEADER_BASE),
                 destination, size,
                 (const volatile uint8_t *)(SAVE_BASE + first));
}
#endif

static uint8_t flash_read(FlashReadFn reader, uint32_t offset)
{
    FlashReadByteFn byte = (FlashReadByteFn)(
        (uintptr_t)&reader->byte_code | 1u);
    return byte((const volatile uint8_t *)(SAVE_BASE + offset));
}

static void flash_read_range(FlashReadFn reader, uint32_t offset,
                             uint8_t *destination, uint32_t size)
{
    FlashReadRangeFn range = (FlashReadRangeFn)(
        (uintptr_t)reader->range_code | 1u);
    range((const volatile uint8_t *)(SAVE_BASE + offset),
          destination, size);
}

/* Copy call-owned input without changing the game's interrupt state. */
static void copy_from_ram(uint8_t *destination,
                          const uint8_t *source, uint32_t size)
{
    uint32_t index;
    for (index = 0; index < size; ++index)
        destination[index] = source[index];
}

static void flash_cleanup(void)
{
    volatile uint8_t *save = (volatile uint8_t *)SAVE_BASE;
    if (direct_save_protocol_config == SAVE_PROTOCOL_STANDARD) {
        save[0] = 0xF0u;
    } else if (direct_save_protocol_config == SAVE_PROTOCOL_CUSTOM_TYPE_1
               || direct_save_protocol_config
                    == SAVE_PROTOCOL_CUSTOM_TYPE_2) {
        *(volatile uint8_t *)GBA_SRAM_BANK_SELECT_ADDRESS = 0;
    }
}

/* Command loads and busy polling preserve the caller's exact IRQ state. */
static uint32_t flash_poll_program(FlashReadFn reader, uint32_t offset,
                                   uint8_t value)
{
    uint32_t timeout;
    uint32_t success = 0;
    for (timeout = SAVE_PROGRAM_TIMEOUT; timeout; --timeout) {
        uint8_t first = flash_read(reader, offset);
        if ((first & 0x80u) == (value & 0x80u)) {
            uint8_t second = flash_read(reader, offset);
            uint8_t third = flash_read(reader, offset);
            if (second == value && third == value) {
                success = 1;
                break;
            }
        }
    }
    return success;
}

static uint32_t flash_poll_erase(FlashReadFn reader, uint32_t offset)
{
    uint32_t timeout;
    uint32_t success = 0;
    for (timeout = SAVE_ERASE_TIMEOUT; timeout; --timeout) {
        uint8_t first = flash_read(reader, offset);
        if ((first & 0x80u) != 0) {
            uint8_t second = flash_read(reader, offset);
            uint8_t third = flash_read(reader, offset);
            if (second == 0xFFu && third == 0xFFu) {
                success = 1;
                break;
            }
        }
    }
    return success;
}

static uint32_t flash_program_byte(FlashReadFn reader, uint32_t offset,
                                   uint8_t value)
{
    volatile uint8_t *save = (volatile uint8_t *)SAVE_BASE;
    uint32_t attempt;
    if (!direct_save_protocol_valid() || offset >= SAVE_SIZE)
        return 0;
    if (value == 0xFFu)
        return flash_read(reader, offset) == 0xFFu;
    for (attempt = 0; attempt < SAVE_COMMAND_ATTEMPTS; ++attempt) {
        uint8_t old_value;
        old_value = flash_read(reader, offset);
        if (old_value == value)
            return 1;
        if ((old_value & value) != value)
            return 0;
        save[SAVE_MAGIC_0] = 0xAA;
        save[SAVE_MAGIC_1] = 0x55;
        save[SAVE_MAGIC_0] = 0xA0;
        save[offset] = value;
        if (flash_poll_program(reader, offset, value))
            return 1;
        flash_cleanup();
    }
    return 0;
}

/* Real target hardware rejects CFI and AMD buffered programming.  The common
 * byte-program protocol is used by every Direct backend. */
static uint32_t flash_program_range(FlashReadFn reader, uint32_t offset,
                                    const uint8_t *source, uint32_t size)
{
    uint32_t cursor;
    if ((!source && size != 0) || offset > SAVE_SIZE
        || size > SAVE_SIZE - offset)
        return 0;
    for (cursor = 0u; cursor < size; ++cursor) {
        if (!flash_program_byte(
                reader, offset + cursor, source[cursor]))
            return 0u;
    }
    return 1;
}

/* Program logical bytes through a fixed per-range physical XOR transform. */
static uint32_t flash_program_xor_data(FlashReadFn reader,
                                       uint32_t offset,
                                       const uint8_t *source,
                                       uint32_t size,
                                       uint8_t xor_value)
{
    uint8_t encoded[FLASH_READ_CHUNK];
    uint32_t cursor;
    if ((!source && size != 0u) || offset > SAVE_SIZE
        || size > SAVE_SIZE - offset)
        return 0;
    for (cursor = 0; cursor < size; cursor += sizeof(encoded)) {
        uint32_t part = size - cursor < sizeof(encoded)
            ? size - cursor : sizeof(encoded);
        uint32_t index = 0;
        while (index < part) {
            uint32_t run_first;
            while (index < part
                   && (uint8_t)(source[cursor + index] ^ xor_value) == 0xFFu)
                ++index;
            run_first = index;
            while (index < part
                   && (uint8_t)(source[cursor + index] ^ xor_value)
                       != 0xFFu) {
                encoded[index] = source[cursor + index] ^ xor_value;
                ++index;
            }
            if (index != run_first
                && !flash_program_range(reader, offset + cursor + run_first,
                                        encoded + run_first,
                                        index - run_first))
                return 0;
        }
    }
    return 1;
}

/* SRAM log and Direct snapshot data remain bitwise-NOT encoded. */
static uint32_t flash_program_inverted_data(FlashReadFn reader,
                                             uint32_t offset,
                                             const uint8_t *source,
                                             uint32_t size)
{
    return flash_program_xor_data(reader, offset, source, size, 0xFFu);
}

static uint32_t flash_range_erased(FlashReadFn reader, uint32_t offset,
                                   uint32_t size)
{
    uint8_t values[FLASH_READ_CHUNK];
    uint32_t cursor;
    if (offset >= SAVE_SIZE || size > SAVE_SIZE - offset)
        return 0;
    for (cursor = 0; cursor < size; cursor += sizeof(values)) {
        uint32_t part = size - cursor < sizeof(values)
            ? size - cursor : sizeof(values);
        uint32_t index;
        flash_read_range(reader, offset + cursor, values, part);
        for (index = 0; index < part; ++index) {
            if (values[index] != 0xFFu)
                return 0;
        }
    }
    return 1;
}

static uint32_t flash_erase_unit(FlashReadFn reader, uint32_t offset)
{
    volatile uint8_t *save = (volatile uint8_t *)SAVE_BASE;
    uint32_t attempt;
    uint32_t erase_size;
    uint8_t command;
    if (!direct_save_protocol_valid())
        return 0;
    erase_size = direct_save_protocol_config == SAVE_PROTOCOL_STANDARD
        ? SECTOR_SIZE : 0x800u;
    command = direct_save_protocol_config == SAVE_PROTOCOL_CUSTOM_TYPE_2
        ? 0x50u : 0x30u;
    for (attempt = 0; attempt < SAVE_COMMAND_ATTEMPTS; ++attempt) {
        if (flash_range_erased(reader, offset, erase_size))
            return 1;
        save[SAVE_MAGIC_0] = 0xAA;
        save[SAVE_MAGIC_1] = 0x55;
        save[SAVE_MAGIC_0] = 0x80;
        save[SAVE_MAGIC_0] = 0xAA;
        save[SAVE_MAGIC_1] = 0x55;
        save[offset] = command;
        if (flash_poll_erase(reader, offset)
            && flash_range_erased(reader, offset, erase_size))
            return 1;
        flash_cleanup();
    }
    return 0;
}

static uint32_t flash_erase_sector(FlashReadFn reader, uint32_t offset)
{
    if (offset >= SAVE_SIZE || (offset & (SECTOR_SIZE - 1u)) != 0)
        return 0;
    if (direct_save_protocol_config == SAVE_PROTOCOL_STANDARD) {
        if (!flash_erase_unit(reader, offset))
            return 0;
    } else if (direct_save_protocol_config == SAVE_PROTOCOL_CUSTOM_TYPE_1
               || direct_save_protocol_config
                    == SAVE_PROTOCOL_CUSTOM_TYPE_2) {
        if (!flash_erase_unit(reader, offset)
            || !flash_erase_unit(reader, offset + 0x800u))
            return 0;
    } else {
        return 0;
    }
    return flash_range_erased(reader, offset, SECTOR_SIZE);
}

#ifndef DIRECT_SRAM_ONLY_BUILD
static uint32_t flash_copy(FlashReadFn reader, uint32_t destination,
                           uint32_t source, uint32_t size)
{
    uint8_t expected[FLASH_READ_CHUNK];
    uint8_t actual[FLASH_READ_CHUNK];
    uint32_t cursor;
    for (cursor = 0; cursor < size; cursor += sizeof(expected)) {
        uint32_t part = size - cursor < sizeof(expected)
            ? size - cursor : sizeof(expected);
        flash_read_range(reader, source + cursor, expected, part);
        if (!flash_program_range(
                reader, destination + cursor, expected, part))
            return 0;
    }
    for (cursor = 0; cursor < size; cursor += sizeof(expected)) {
        uint32_t part = size - cursor < sizeof(expected)
            ? size - cursor : sizeof(expected);
        uint32_t index;
        flash_read_range(reader, source + cursor, expected, part);
        flash_read_range(reader, destination + cursor, actual, part);
        for (index = 0; index < part; ++index) {
            if (actual[index] != expected[index])
                return 0;
        }
    }
    return 1;
}
#endif

static uint32_t source_is_save(const uint8_t *source, uint32_t size)
{
    uintptr_t address = (uintptr_t)source;
    return address >= SAVE_BASE && address < SAVE_BASE + SAVE_SIZE
        && size <= SAVE_BASE + SAVE_SIZE - address;
}

static uint32_t source_starts_in_save(const uint8_t *source)
{
    uintptr_t address = (uintptr_t)source;
    return address >= SAVE_BASE && address < SAVE_BASE + SAVE_SIZE;
}

static uint32_t layout_marker_valid(uint32_t marker, uint32_t marker_base)
{
    return marker == marker_base;
}

static const uint8_t sram16_header[16] = {
    'L', 'K', 'S', 'R', SRAM_SECTOR_LOG_VERSION,
    SRAM_SECTOR_LOG_ENTRY_SIZE, SRAM_SECTOR_LOG_COUNT, 0xFFu,
    0x00u, 0x80u, 1u, 0xFFu, 'R', 'S', 'K', 'L'
};

/* 0 invalid, 1 completely blank, 2 inverted sector-log-v16 candidate. */
static uint32_t sram16_state_from_first_byte(uint32_t marker)
{
    if (marker == 0xFFu)
        return 1u;
    return marker == sram16_header[0] ? 2u : 0u;
}

static uint32_t sram16_layout_state(FlashReadFn reader)
{
    uint32_t index;
    uint32_t state = sram16_state_from_first_byte(
        flash_read(reader, SRAM_HEADER_BASE));
    if (state != 2u)
        return state;
    for (index = 0u; index < sizeof(sram16_header); ++index) {
        if (flash_read(reader, SRAM_HEADER_BASE + index)
            != sram16_header[index])
            return 0u;
    }
    return layout_marker_valid(flash_read(reader, SRAM_PROGRAM_MARKER),
                               SRAM_LAYOUT_MARKER_BASE) ? 2u : 0u;
}

static uint32_t sram16_initialize(FlashReadFn reader)
{
    if (sram16_layout_state(reader) != 1u)
        return 0u;
    return flash_program_range(
               reader, SRAM_HEADER_BASE, sram16_header,
               sizeof(sram16_header))
        && flash_program_byte(
            reader, SRAM_PROGRAM_MARKER, SRAM_LAYOUT_MARKER_BASE)
        && sram16_layout_state(reader) == 2u;
}

static uint32_t sram16_slice_base(uint32_t logical_first)
{
    uint32_t sector = logical_first / SECTOR_SIZE;
    uint32_t block = (logical_first & (SECTOR_SIZE - 1u))
        / SRAM_SECTOR_LOG_BLOCK_SIZE;
    if (sector == 0u)
        return SRAM_HEADER_BASE + SRAM_SECTOR_LOG_HEADER_SIZE
            + block * SRAM_SECTOR0_LOG_SLICE_SIZE;
    if (sector < SRAM_FULL_LOG_SECTOR_COUNT)
        return SRAM_SECTOR_LOG_BASE + sector * SECTOR_SIZE
            + block * SRAM_FULL_LOG_SLICE_SIZE;
    return SRAM_SHARED_LOG_BASE
        + (sector - SRAM_FULL_LOG_SECTOR_COUNT)
            * SRAM_SHARED_LOG_PARTITION_SIZE
        + block * SRAM_SHARED_LOG_SLICE_SIZE;
}

static uint32_t sram16_slice_size(uint32_t logical_first)
{
    uint32_t sector = logical_first / SECTOR_SIZE;
    if (sector == 0u)
        return SRAM_SECTOR0_LOG_SLICE_SIZE;
    if (sector < SRAM_FULL_LOG_SECTOR_COUNT)
        return SRAM_FULL_LOG_SLICE_SIZE;
    return SRAM_SHARED_LOG_SLICE_SIZE;
}

static uint32_t sram16_pool_base(uint32_t logical_first)
{
    uint32_t sector = logical_first / SECTOR_SIZE;
    if (sector == 0u)
        return SRAM_HEADER_BASE + SRAM_SECTOR_LOG_HEADER_SIZE;
    if (sector < SRAM_FULL_LOG_SECTOR_COUNT)
        return SRAM_SECTOR_LOG_BASE + sector * SECTOR_SIZE;
    return SRAM_SHARED_LOG_BASE
        + (sector - SRAM_FULL_LOG_SECTOR_COUNT)
            * SRAM_SHARED_LOG_PARTITION_SIZE;
}

static uint32_t sram16_slice_at(uint32_t logical_first, uint32_t index)
{
    return sram16_pool_base(logical_first)
        + index * sram16_slice_size(logical_first);
}

static uint32_t sram16_block_index(uint32_t logical_first)
{
    return (logical_first & (SECTOR_SIZE - 1u))
        / SRAM_SECTOR_LOG_BLOCK_SIZE;
}

#ifdef DIRECT_SRAM_TRANSACTION_BUILD
static uint32_t sram16_blank_slice_matches(
    FlashReadFn reader, const uint8_t *source, uint32_t first, uint32_t size)
{
    SramCompareInvertedFn compare;
    if (!source || size == 0u
        || flash_read(reader, sram16_slice_base(first) + 1u) != 0xFFu)
        return 0u;
    compare = (SramCompareInvertedFn)(
        (uintptr_t)reader->compare_inverted_code | 1u);
    return compare((const volatile uint8_t *)(SAVE_BASE + first),
                   source, size);
}
#endif

#ifndef DIRECT_SRAM_TRANSACTION_BUILD
static uint8_t sram16_rle_byte(FlashReadFn reader, uint32_t position,
                               uint32_t input)
{
    uint32_t physical = input == 0u
        ? position : position + input + 1u;
    return (uint8_t)~flash_read(reader, physical);
}

/* Decode a committed whole-block record, copying only the requested range. */
static uint32_t sram16_decode_rle_block(
    FlashReadFn reader, uint32_t position, uint32_t stored,
    uint32_t local_first, uint8_t *destination, uint32_t size)
{
    uint32_t input = 0u;
    uint32_t output = 0u;
    if (!destination || size == 0u
        || local_first >= SRAM_SECTOR_LOG_BLOCK_SIZE
        || size > SRAM_SECTOR_LOG_BLOCK_SIZE - local_first)
        return 0u;
    while (input < stored && output < SRAM_SECTOR_LOG_BLOCK_SIZE) {
        uint32_t control = sram16_rle_byte(reader, position, input++);
        uint32_t count = control < 0x80u
            ? control + 1u : (control & 0x7Fu) + 3u;
        if (count > SRAM_SECTOR_LOG_BLOCK_SIZE - output)
            return 0u;
        if (control < 0x80u) {
            uint32_t index;
            if (count > stored - input)
                return 0u;
            for (index = 0u; index < count; ++index) {
                uint32_t logical = output + index;
                uint8_t value = sram16_rle_byte(
                    reader, position, input + index);
                if (logical >= local_first
                    && logical < local_first + size)
                    destination[logical - local_first] = value;
            }
            input += count;
        } else {
            uint8_t value;
            uint32_t index;
            if (input >= stored)
                return 0u;
            value = sram16_rle_byte(reader, position, input++);
            for (index = 0u; index < count; ++index) {
                uint32_t logical = output + index;
                if (logical >= local_first
                    && logical < local_first + size)
                    destination[logical - local_first] = value;
            }
        }
        output += count;
    }
    return input == stored && output == SRAM_SECTOR_LOG_BLOCK_SIZE;
}

#else
static uint8_t sram16_rle_slice_byte(const uint8_t *slice,
                                     uint32_t position, uint32_t input)
{
    uint32_t physical = input == 0u
        ? position : position + input + 1u;
    return (uint8_t)~slice[physical];
}

static uint32_t sram16_decode_rle_slice(
    const uint8_t *slice, uint32_t slice_size,
    uint32_t position, uint32_t stored,
    uint32_t local_first, uint8_t *destination, uint32_t size)
{
    uint32_t input = 0u;
    uint32_t output = 0u;
    if (!slice || !destination || size == 0u
        || position >= slice_size || stored + 1u > slice_size - position
        || local_first >= SRAM_SECTOR_LOG_BLOCK_SIZE
        || size > SRAM_SECTOR_LOG_BLOCK_SIZE - local_first)
        return 0u;
    while (input < stored && output < SRAM_SECTOR_LOG_BLOCK_SIZE) {
        uint32_t control = sram16_rle_slice_byte(
            slice, position, input++);
        uint32_t count = control < 0x80u
            ? control + 1u : (control & 0x7Fu) + 3u;
        if (count > SRAM_SECTOR_LOG_BLOCK_SIZE - output)
            return 0u;
        if (control < 0x80u) {
            uint32_t index;
            if (count > stored - input)
                return 0u;
            for (index = 0u; index < count; ++index) {
                uint32_t logical = output + index;
                uint8_t value = sram16_rle_slice_byte(
                    slice, position, input + index);
                if (logical >= local_first
                    && logical < local_first + size)
                    destination[logical - local_first] = value;
            }
            input += count;
        } else {
            uint8_t value;
            uint32_t index;
            if (input >= stored)
                return 0u;
            value = sram16_rle_slice_byte(slice, position, input++);
            for (index = 0u; index < count; ++index) {
                uint32_t logical = output + index;
                if (logical >= local_first
                    && logical < local_first + size)
                    destination[logical - local_first] = value;
            }
        }
        output += count;
    }
    return input == stored && output == SRAM_SECTOR_LOG_BLOCK_SIZE;
}
#endif

#ifndef DIRECT_SRAM_TRANSACTION_BUILD
/* Decode one primary or overflow slice.  v16 reserves the last two primary
 * bytes as an overflow-present marker.  Overflow slices use their first two
 * bytes as {owner block, tag}; the remaining bytes retain the ordinary
 * delta/RLE grammar. */
static uint32_t sram16_load_sparse_slice(
    FlashReadFn reader, uint32_t position, uint32_t limit,
    uint32_t block_first, uint32_t first, uint8_t *destination,
    uint32_t size, uint8_t *overlay, uint16_t *latest,
    uint32_t *slice_end)
{
    uint8_t entry[SRAM_SECTOR_LOG_ENTRY_SIZE];
    uint32_t cursor;
    while (position <= limit - SRAM_SECTOR_LOG_ENTRY_SIZE) {
        uint32_t logical;
        flash_read_range(reader, position, entry, sizeof(entry));
        if (entry[1] == 0xFFu) {
            *slice_end = position;
            return 1u;
        }
        if ((entry[1] & SRAM_SECTOR_LOG_RLE_TAG_MASK)
            == SRAM_SECTOR_LOG_RLE_TAG_BASE) {
            uint32_t stored = (entry[1]
                & SRAM_SECTOR_LOG_RLE_LENGTH_MASK) + 1u;
            if (stored + 1u > limit - position
                || !sram16_decode_rle_block(
                    reader, position, stored,
                    first - block_first, destination, size))
                return 0u;
            for (cursor = 0u; cursor < size; ++cursor) {
                overlay[cursor >> 3] |= (uint8_t)(1u << (cursor & 7u));
                if (latest)
                    latest[cursor] = 0xFFFFu;
            }
            position += stored + 1u;
            continue;
        }
        if (entry[1] >= SRAM_SECTOR_LOG_BLOCK_SIZE)
            return 0u;
        logical = block_first + entry[1];
        if (logical >= first && logical < first + size) {
            uint32_t target = logical - first;
            destination[target] = (uint8_t)~entry[0];
            overlay[target >> 3] |= (uint8_t)(1u << (target & 7u));
            if (latest)
                latest[target] = (uint16_t)position;
        }
        position += SRAM_SECTOR_LOG_ENTRY_SIZE;
    }
    *slice_end = position;
    return 1u;
}

/* Entry-wise reader used by the Base sparse reader and short transaction
 * writes.  Ordinary blocks touch only their primary slice.  A primary marker
 * causes a bounded 64-header inventory, after which only matching overflow
 * slices are decoded in cyclic allocation order. */
static uint32_t sram16_load_range_sparse(
    FlashReadFn reader, uint32_t first, uint8_t *destination, uint32_t size,
    uint8_t *overlay, uint16_t *latest, uint32_t *log_end,
    uint32_t *log_limit)
{
    uint8_t header[2];
    uint32_t block_first = first & ~(SRAM_SECTOR_LOG_BLOCK_SIZE - 1u);
    uint32_t sector = first / SECTOR_SIZE;
    uint32_t block = sram16_block_index(first);
    uint32_t slice_size = sram16_slice_size(first);
    uint32_t primary = sram16_slice_base(first);
    uint32_t primary_limit = primary + slice_size - 2u;
    uint32_t scan_overflow = 0u;
    uint32_t cursor;
    if (size == 0u || first >= SRAM_LOGICAL_SIZE
        || size > SRAM_LOGICAL_SIZE - first
        || (first + size - 1u) / SRAM_SECTOR_LOG_BLOCK_SIZE
            != first / SRAM_SECTOR_LOG_BLOCK_SIZE
        || sector >= SRAM_SECTOR_LOG_COUNT)
        return 0u;
    flash_read_range(reader, first, destination, size);
    for (cursor = 0u; cursor < size; ++cursor)
        destination[cursor] = (uint8_t)~destination[cursor];
    for (cursor = 0u; cursor < (size + 7u) / 8u; ++cursor)
        overlay[cursor] = 0u;
    if (latest) {
        for (cursor = 0u; cursor < size; ++cursor)
            latest[cursor] = 0xFFFFu;
    }
    flash_read_range(reader, primary, header, sizeof(header));
    if (header[1] == SRAM_SECTOR_LOG_OVERFLOW_TAG) {
        if (header[0] >= SRAM_SECTOR_LOG_BLOCK_COUNT)
            return 0u;
        *log_end = primary;
        *log_limit = primary;
        scan_overflow = 1u;
    } else {
        if (!sram16_load_sparse_slice(
                reader, primary, primary_limit, block_first, first,
                destination, size, overlay, latest, log_end))
            return 0u;
        *log_limit = primary_limit;
        flash_read_range(reader, primary_limit, header, sizeof(header));
        if (header[1] == SRAM_SECTOR_LOG_OVERFLOW_MARKER) {
            if (header[0] != block)
                return 0u;
            scan_overflow = 1u;
        } else if (header[0] != 0xFFu || header[1] != 0xFFu) {
            return 0u;
        }
    }
    if (!scan_overflow)
        return 1u;
    for (cursor = 1u; cursor < SRAM_SECTOR_LOG_BLOCK_COUNT; ++cursor) {
        uint32_t index = (block + cursor) % SRAM_SECTOR_LOG_BLOCK_COUNT;
        uint32_t candidate = sram16_slice_at(first, index);
        flash_read_range(reader, candidate, header, sizeof(header));
        if (header[1] != SRAM_SECTOR_LOG_OVERFLOW_TAG)
            continue;
        if (header[0] >= SRAM_SECTOR_LOG_BLOCK_COUNT)
            return 0u;
        if (header[0] != block)
            continue;
        if (!sram16_load_sparse_slice(
                reader, candidate + 2u, candidate + slice_size,
                block_first, first, destination, size, overlay, latest,
                log_end))
            return 0u;
        *log_limit = candidate + slice_size;
    }
    return 1u;
}

#define sram16_load_range sram16_load_range_sparse
#else
static uint32_t sram16_load_buffer_slice(
    const uint8_t *slice, uint32_t slice_base, uint32_t position,
    uint32_t limit, uint32_t block_first, uint32_t first,
    uint8_t *destination, uint32_t size, uint8_t *overlay,
    uint16_t *latest, uint32_t *slice_end)
{
    uint32_t cursor;
    while (position <= limit - SRAM_SECTOR_LOG_ENTRY_SIZE) {
        uint32_t logical;
        uint8_t value = slice[position];
        uint8_t commit = slice[position + 1u];
        if (commit == 0xFFu) {
            *slice_end = slice_base + position;
            return 1u;
        }
        if ((commit & SRAM_SECTOR_LOG_RLE_TAG_MASK)
            == SRAM_SECTOR_LOG_RLE_TAG_BASE) {
            uint32_t stored = (commit & SRAM_SECTOR_LOG_RLE_LENGTH_MASK) + 1u;
            if (stored + 1u > limit - position
                || !sram16_decode_rle_slice(
                    slice, limit, position, stored,
                    first - block_first, destination, size))
                return 0u;
            for (cursor = 0u; cursor < size; ++cursor) {
                overlay[cursor >> 3] |= (uint8_t)(1u << (cursor & 7u));
                if (latest)
                    latest[cursor] = 0xFFFFu;
            }
            position += stored + 1u;
            continue;
        }
        if (commit >= SRAM_SECTOR_LOG_BLOCK_SIZE)
            return 0u;
        logical = block_first + commit;
        if (logical >= first && logical < first + size) {
            uint32_t target = logical - first;
            destination[target] = (uint8_t)~value;
            overlay[target >> 3] |= (uint8_t)(1u << (target & 7u));
            if (latest)
                latest[target] = (uint16_t)(slice_base + position);
        }
        position += SRAM_SECTOR_LOG_ENTRY_SIZE;
    }
    *slice_end = slice_base + position;
    return 1u;
}

/* Optimized transaction path: one Save-bus range read per occupied slice. */
static uint32_t sram16_load_range(
    FlashReadFn reader, uint32_t first, uint8_t *destination, uint32_t size,
    uint8_t *overlay, uint16_t *latest, uint32_t *log_end,
    uint32_t *log_limit)
{
    uint8_t slice[SRAM_FULL_LOG_SLICE_SIZE];
    uint32_t block_first = first & ~(SRAM_SECTOR_LOG_BLOCK_SIZE - 1u);
    uint32_t sector = first / SECTOR_SIZE;
    uint32_t block = sram16_block_index(first);
    uint32_t slice_size = sram16_slice_size(first);
    uint32_t primary = sram16_slice_base(first);
    uint32_t primary_limit = slice_size - 2u;
    uint32_t scan_overflow = 0u;
    uint32_t cursor;
    if (size == 0u || first >= SRAM_LOGICAL_SIZE
        || size > SRAM_LOGICAL_SIZE - first
        || (first + size - 1u) / SRAM_SECTOR_LOG_BLOCK_SIZE
            != first / SRAM_SECTOR_LOG_BLOCK_SIZE
        || sector >= SRAM_SECTOR_LOG_COUNT)
        return 0u;
    flash_read_range(reader, first, destination, size);
    for (cursor = 0u; cursor < size; ++cursor)
        destination[cursor] = (uint8_t)~destination[cursor];
    for (cursor = 0u; cursor < (size + 7u) / 8u; ++cursor)
        overlay[cursor] = 0u;
    if (latest) {
        for (cursor = 0u; cursor < size; ++cursor)
            latest[cursor] = 0xFFFFu;
    }
    flash_read_range(reader, primary, slice, slice_size);
    if (slice[1] == SRAM_SECTOR_LOG_OVERFLOW_TAG) {
        if (slice[0] >= SRAM_SECTOR_LOG_BLOCK_COUNT)
            return 0u;
        *log_end = primary;
        *log_limit = primary;
        scan_overflow = 1u;
    } else {
        if (!sram16_load_buffer_slice(
                slice, primary, 0u, primary_limit, block_first, first,
                destination, size, overlay, latest, log_end))
            return 0u;
        *log_limit = primary + primary_limit;
        if (slice[primary_limit + 1u]
                == SRAM_SECTOR_LOG_OVERFLOW_MARKER) {
            if (slice[primary_limit] != block)
                return 0u;
            scan_overflow = 1u;
        } else if (slice[primary_limit] != 0xFFu
                   || slice[primary_limit + 1u] != 0xFFu) {
            return 0u;
        }
    }
    if (!scan_overflow)
        return 1u;
    for (cursor = 1u; cursor < SRAM_SECTOR_LOG_BLOCK_COUNT; ++cursor) {
        uint32_t index = (block + cursor) % SRAM_SECTOR_LOG_BLOCK_COUNT;
        uint32_t candidate = sram16_slice_at(first, index);
        flash_read_range(reader, candidate, slice, 2u);
        if (slice[1] != SRAM_SECTOR_LOG_OVERFLOW_TAG)
            continue;
        if (slice[0] >= SRAM_SECTOR_LOG_BLOCK_COUNT)
            return 0u;
        if (slice[0] != block)
            continue;
        flash_read_range(reader, candidate, slice, slice_size);
        if (!sram16_load_buffer_slice(
                slice, candidate, 2u, slice_size, block_first, first,
                destination, size, overlay, latest, log_end))
            return 0u;
        *log_limit = candidate + slice_size;
    }
    return 1u;
}
#endif

static uint32_t sram16_reserve_log(
    FlashReadFn reader, uint32_t block_first, uint32_t needed,
    uint32_t *log_end, uint32_t *log_limit)
{
    uint8_t header[2];
    uint32_t block = sram16_block_index(block_first);
    uint32_t slice_size = sram16_slice_size(block_first);
    uint32_t pool = sram16_pool_base(block_first);
    uint32_t primary = sram16_slice_base(block_first);
    uint32_t current;
    uint32_t order;
    if (needed <= *log_limit - *log_end)
        return 1u;
    if (needed > slice_size - 2u)
        return 0u;
    current = block;
    for (order = 0u; order < SRAM_SECTOR_LOG_BLOCK_COUNT; ++order) {
        uint32_t candidate = pool + order * slice_size;
        if (*log_end >= candidate && *log_end <= candidate + slice_size) {
            current = order;
            break;
        }
    }
    /* Readers apply donors in the fixed cyclic order relative to their owner.
     * Never wrap behind the latest donor: without an erasable sequence field,
     * doing so would make a newer delta decode before an older one. */
    current = (current + SRAM_SECTOR_LOG_BLOCK_COUNT - block)
        % SRAM_SECTOR_LOG_BLOCK_COUNT;
    for (order = current + 1u; order < SRAM_SECTOR_LOG_BLOCK_COUNT; ++order) {
        uint32_t index = (block + order) % SRAM_SECTOR_LOG_BLOCK_COUNT;
        uint32_t candidate = sram16_slice_at(block_first, index);
        uint32_t marker = primary + slice_size - 2u;
        if (!flash_range_erased(reader, candidate, slice_size))
            continue;
        header[0] = (uint8_t)block;
        header[1] = SRAM_SECTOR_LOG_OVERFLOW_TAG;
        if (!flash_program_range(reader, candidate, header, sizeof(header)))
            return 0u;
        flash_read_range(reader, primary, header, sizeof(header));
        if (header[1] != SRAM_SECTOR_LOG_OVERFLOW_TAG) {
            flash_read_range(reader, marker, header, sizeof(header));
            if (header[0] == 0xFFu && header[1] == 0xFFu) {
                header[0] = (uint8_t)block;
                header[1] = SRAM_SECTOR_LOG_OVERFLOW_MARKER;
                if (!flash_program_range(reader, marker, header, sizeof(header)))
                    return 0u;
            } else if (header[0] != block
                       || header[1] != SRAM_SECTOR_LOG_OVERFLOW_MARKER) {
                return 0u;
            }
        }
        *log_end = candidate + 2u;
        *log_limit = candidate + slice_size;
        return 1u;
    }
    return 0u;
}

static uint32_t sram16_read_range(FlashReadFn reader, uint32_t first,
                                  uint8_t *destination, uint32_t size)
{
    uint8_t overlay[SRAM_SECTOR_OVERLAY_SIZE];
    uint32_t cursor;
    if (first > SRAM_LOGICAL_SIZE || size > SRAM_LOGICAL_SIZE - first)
        return 0u;
    for (cursor = 0u; cursor < size;) {
        uint32_t block_left = SRAM_SECTOR_LOG_BLOCK_SIZE
            - ((first + cursor) & (SRAM_SECTOR_LOG_BLOCK_SIZE - 1u));
        uint32_t part = size - cursor < block_left
            ? size - cursor : block_left;
        uint32_t unused_log_end;
        uint32_t unused_log_limit;
        if (!sram16_load_range(
                reader, first + cursor, destination + cursor, part,
                overlay, (uint16_t *)0, &unused_log_end,
                &unused_log_limit))
            return 0u;
        cursor += part;
    }
    return 1u;
}


#ifdef DIRECT_SNAPSHOT_BUILD
typedef struct {
    uint32_t valid;
    uint32_t blank;
    uint32_t header_base;
    uint32_t data_base;
    uint32_t tag;
    uint32_t stored;
    uint32_t fingerprint;
} SnapshotState;

typedef struct {
    FlashReadFn reader;
    SnapshotState state;
    uint32_t input;
    uint32_t output;
    uint32_t remaining;
    uint32_t literal;
    uint8_t run_value;
} SnapshotDecoder;

typedef struct {
    FlashReadFn reader;
    uint32_t output_base;
    uint32_t written;
    uint32_t used;
    uint32_t erased_until;
    uint8_t buffer[64u];
} SnapshotSink;

static uint32_t snapshot_read_u32(const uint8_t *source)
{
    return source[0]
        | ((uint32_t)source[1] << 8)
        | ((uint32_t)source[2] << 16)
        | ((uint32_t)source[3] << 24);
}

static void snapshot_write_u32(uint8_t *destination, uint32_t value)
{
    destination[0] = (uint8_t)value;
    destination[1] = (uint8_t)(value >> 8);
    destination[2] = (uint8_t)(value >> 16);
    destination[3] = (uint8_t)(value >> 24);
}

static uint32_t snapshot_header_at(FlashReadFn reader, uint32_t base,
                                   SnapshotState *state)
{
    uint8_t header[SNAPSHOT_HEADER_SIZE];
    uint32_t stored;
    flash_read_range(reader, base, header, sizeof(header));
    if (snapshot_read_u32(header) != SNAPSHOT_MAGIC
        || header[4] != SNAPSHOT_VERSION
        || (header[5] != SNAPSHOT_RAW && header[5] != SNAPSHOT_RLE))
        return 0;
    stored = header[6] | ((uint32_t)header[7] << 8);
    if ((uint16_t)(stored ^ (header[8] | ((uint32_t)header[9] << 8)))
            != 0xFFFFu
        || header[10] != 0x00u || header[11] != 0x80u
        || stored == 0u
        || (header[5] == SNAPSHOT_RAW && stored != SRAM_LOGICAL_SIZE)
        || (header[5] == SNAPSHOT_RLE
            && (stored <= SNAPSHOT_INDEX_SIZE
                || stored > SNAPSHOT_SLOT_SIZE - SNAPSHOT_HEADER_SIZE)))
        return 0;
    state->valid = 1u;
    state->blank = 0u;
    state->header_base = base;
    state->data_base = base + (header[5] == SNAPSHOT_RAW
        ? 0u : SNAPSHOT_DATA_BASE);
    state->tag = header[5];
    state->stored = stored;
    state->fingerprint = snapshot_read_u32(header + 12);
    return 1;
}

static uint32_t snapshot_locate(FlashReadFn reader, SnapshotState *state)
{
    if (snapshot_header_at(reader, 0u, state)) {
        return 1;
    }
    if (snapshot_header_at(reader, SNAPSHOT_SLOT_SIZE, state))
        return 1;
    /* If the current header does not validate, expose the required
     * logical-zero state and let the next complete transaction replace the
     * physical contents. */
    state->valid = 1u;
    state->blank = 1u;
    state->header_base = 0u;
    state->data_base = 0u;
    state->tag = SNAPSHOT_RAW;
    state->stored = 0u;
    state->fingerprint = 2166136261u;
    return 1;
}

static uint32_t snapshot_decoder_init(SnapshotDecoder *decoder,
                                      FlashReadFn reader,
                                      const SnapshotState *state)
{
    decoder->reader = reader;
    decoder->state = *state;
    decoder->input = state->blank || state->tag == SNAPSHOT_RAW
        ? 0u : SNAPSHOT_INDEX_SIZE;
    decoder->output = 0u;
    decoder->remaining = 0u;
    decoder->literal = 0u;
    decoder->run_value = 0u;
    return state->valid;
}

static uint32_t snapshot_decoder_next(SnapshotDecoder *decoder,
                                      uint8_t *value)
{
    uint32_t control;
    if (decoder->output >= SRAM_LOGICAL_SIZE)
        return 0;
    if (decoder->state.blank) {
        *value = 0u;
        ++decoder->output;
        return 1;
    }
    if (decoder->state.tag == SNAPSHOT_RAW) {
        *value = (uint8_t)~flash_read(
            decoder->reader, decoder->state.data_base + decoder->output);
        ++decoder->output;
        return 1;
    }
    if (decoder->remaining == 0u) {
        if (decoder->input >= decoder->state.stored)
            return 0;
        control = (uint8_t)~flash_read(
            decoder->reader, decoder->state.data_base + decoder->input++);
        decoder->remaining = control < 0x80u
            ? control + 1u : (control & 0x7Fu) + 3u;
        decoder->literal = control < 0x80u;
        if (decoder->remaining > SRAM_LOGICAL_SIZE - decoder->output)
            return 0;
        if (!decoder->literal) {
            if (decoder->input >= decoder->state.stored)
                return 0;
            decoder->run_value = (uint8_t)~flash_read(
                decoder->reader,
                decoder->state.data_base + decoder->input++);
        }
    }
    if (decoder->literal) {
        if (decoder->input >= decoder->state.stored)
            return 0;
        *value = (uint8_t)~flash_read(
            decoder->reader, decoder->state.data_base + decoder->input++);
    } else {
        *value = decoder->run_value;
    }
    --decoder->remaining;
    ++decoder->output;
    return 1;
}

static uint32_t snapshot_decoder_skip(SnapshotDecoder *decoder,
                                      uint32_t size)
{
    while (size != 0u) {
        uint32_t part;
        uint32_t control;
        if (decoder->output > SRAM_LOGICAL_SIZE
            || size > SRAM_LOGICAL_SIZE - decoder->output)
            return 0;
        if (decoder->state.blank || decoder->state.tag == SNAPSHOT_RAW) {
            decoder->output += size;
            return 1;
        }
        if (decoder->remaining == 0u) {
            if (decoder->input >= decoder->state.stored)
                return 0;
            control = (uint8_t)~flash_read(
                decoder->reader,
                decoder->state.data_base + decoder->input++);
            decoder->remaining = control < 0x80u
                ? control + 1u : (control & 0x7Fu) + 3u;
            decoder->literal = control < 0x80u;
            if (decoder->remaining > SRAM_LOGICAL_SIZE - decoder->output)
                return 0;
            if (!decoder->literal) {
                if (decoder->input >= decoder->state.stored)
                    return 0;
                decoder->run_value = (uint8_t)~flash_read(
                    decoder->reader,
                    decoder->state.data_base + decoder->input++);
            }
        }
        part = size < decoder->remaining ? size : decoder->remaining;
        if (decoder->literal) {
            if (part > decoder->state.stored - decoder->input)
                return 0;
            decoder->input += part;
        }
        decoder->remaining -= part;
        decoder->output += part;
        size -= part;
    }
    return 1;
}

static uint32_t snapshot_provider_valid(
    const volatile SnapshotProvider *provider)
{
    uintptr_t end = provider->source + provider->size;
    return provider->size != 0u
        && provider->logical_first < SRAM_LOGICAL_SIZE
        && provider->size <= SRAM_LOGICAL_SIZE - provider->logical_first
        && provider->source >= 0x02000000u && end <= 0x02040000u
        && end >= provider->source;
}

static uint32_t snapshot_configs_valid(void)
{
    uint32_t index;
    uint32_t previous_end = 0u;
    if (direct_snapshot_provider_count_config == 0u
        || direct_snapshot_provider_count_config > SNAPSHOT_PROVIDER_MAX
        || direct_snapshot_transient_count_config > SNAPSHOT_TRANSIENT_MAX
        || direct_snapshot_commit_first_config >= SRAM_LOGICAL_SIZE
        || direct_snapshot_commit_size_config == 0u
        || direct_snapshot_commit_size_config
            > SRAM_LOGICAL_SIZE - direct_snapshot_commit_first_config)
        return 0;
    for (index = 0u; index < direct_snapshot_provider_count_config; ++index) {
        const volatile SnapshotProvider *provider =
            &direct_snapshot_providers_config[index];
        if (!snapshot_provider_valid(provider)
            || (index != 0u && provider->logical_first < previous_end))
            return 0;
        previous_end = provider->logical_first + provider->size;
    }
    previous_end = 0u;
    for (index = 0u; index < direct_snapshot_transient_count_config; ++index) {
        const volatile SnapshotRange *range =
            &direct_snapshot_transient_ranges_config[index];
        uintptr_t end = range->source + range->size;
        if (range->size == 0u || range->logical_first < previous_end
            || range->logical_first >= SRAM_LOGICAL_SIZE
            || range->size > SRAM_LOGICAL_SIZE - range->logical_first
            || range->source < 0x02000000u || end > 0x02040000u
            || end < range->source)
            return 0;
        previous_end = range->logical_first + range->size;
    }
    /* A RAW snapshot occupies the complete 32-KiB slot.  Its 16-byte header
     * therefore aliases logical bytes 0..15.  The semantic analyzer may only
     * enable this backend when those bytes belong to a proven transient-zero
     * range; otherwise an incompressible snapshot could overwrite persistent
     * game data. */
    if (direct_snapshot_transient_count_config == 0u
        || direct_snapshot_transient_ranges_config[0].logical_first != 0u
        || direct_snapshot_transient_ranges_config[0].size
            < SNAPSHOT_HEADER_SIZE)
        return 0;
    return 1;
}

static uint32_t snapshot_sink_emit(SnapshotSink *sink, uint8_t value)
{
    uint32_t index;
    uint32_t programmed = 0u;
    sink->buffer[sink->used++] = (uint8_t)~value;
    if (sink->used != sizeof(sink->buffer))
        return 1;
    for (index = 0u; index < sink->used; ++index)
        programmed |= sink->buffer[index] != 0xFFu;
    while (sink->erased_until
           < sink->output_base + sink->written + sink->used) {
        if (!flash_erase_sector(sink->reader, sink->erased_until))
            return 0;
        sink->erased_until += SECTOR_SIZE;
    }
    if (programmed && !flash_program_range(
        sink->reader, sink->output_base + sink->written,
        sink->buffer, sink->used))
        return 0;
    sink->written += sink->used;
    sink->used = 0u;
    return 1;
}

static uint32_t snapshot_sink_finish(SnapshotSink *sink)
{
    uint32_t index;
    uint32_t programmed = 0u;
    for (index = 0u; index < sink->used; ++index)
        programmed |= sink->buffer[index] != 0xFFu;
    while (sink->erased_until
           < sink->output_base + sink->written + sink->used) {
        if (!flash_erase_sector(sink->reader, sink->erased_until))
            return 0;
        sink->erased_until += SECTOR_SIZE;
    }
    if (programmed && !flash_program_range(
            sink->reader, sink->output_base + sink->written,
            sink->buffer, sink->used))
        return 0;
    sink->written += sink->used;
    sink->used = 0u;
    return 1;
}

static uint32_t snapshot_emit(SnapshotSink *sink, uint8_t value)
{
    return !sink || snapshot_sink_emit(sink, value);
}

static void snapshot_fingerprint_byte(uint32_t *fingerprint,
                                      uint32_t logical, uint8_t value)
{
    uint32_t mixed;
    if (!fingerprint || value == 0u)
        return;
    mixed = ((logical + 1u) * 0x9E3779B1u)
        ^ ((uint32_t)value * 0x85EBCA6Bu);
    mixed ^= mixed >> 16;
    *fingerprint ^= mixed;
    *fingerprint = (*fingerprint << 5) | (*fingerprint >> 27);
}

/* Emit one independently decodable PackBits fragment.  Fragment boundaries
 * are deliberately aligned to semantically derived providers, so gaps and
 * zero ranges never pay a per-byte provider lookup. */
static uint32_t snapshot_encode_bytes(
    SnapshotSink *sink, const uint8_t *source, uint32_t size,
    uint32_t logical_first, uint32_t *produced, uint32_t *fingerprint)
{
    uint32_t at = 0u;
    while (at < size) {
        uint32_t run = 1u;
        while (at + run < size && run < 130u
               && source[at + run] == source[at])
            ++run;
        if (run >= 3u) {
            uint32_t index;
            if (sink) {
                if (!snapshot_emit(sink, (uint8_t)(0x80u | (run - 3u)))
                    || !snapshot_emit(sink, source[at]))
                    return 0;
                for (index = 0u; index < run; ++index)
                    snapshot_fingerprint_byte(
                        fingerprint, logical_first + at + index, source[at]);
            }
            *produced += 2u;
            at += run;
        } else {
            uint32_t first = at;
            uint32_t index;
            at += run;
            while (at < size && at - first < 128u) {
                run = 1u;
                while (at + run < size && run < 130u
                       && source[at + run] == source[at])
                    ++run;
                if (run >= 3u || at - first + run > 128u)
                    break;
                at += run;
            }
            if (sink) {
                if (!snapshot_emit(sink, (uint8_t)(at - first - 1u)))
                    return 0;
                for (index = first; index < at; ++index) {
                    if (!snapshot_emit(sink, source[index]))
                        return 0;
                    snapshot_fingerprint_byte(
                        fingerprint, logical_first + index, source[index]);
                }
            }
            *produced += at - first + 1u;
        }
    }
    return 1;
}

static uint32_t snapshot_encode_zero(
    SnapshotSink *sink, uint32_t size, uint32_t *produced)
{
    while (size != 0u) {
        uint32_t part = size < 130u ? size : 130u;
        if (part >= 3u) {
            if (!snapshot_emit(sink, (uint8_t)(0x80u | (part - 3u)))
                || !snapshot_emit(sink, 0u))
                return 0;
            *produced += 2u;
        } else {
            if (!snapshot_emit(sink, (uint8_t)(part - 1u))
                || !snapshot_emit(sink, 0u)
                || (part == 2u && !snapshot_emit(sink, 0u)))
                return 0;
            *produced += part + 1u;
        }
        size -= part;
    }
    return 1;
}

/* Measurement and writing share this segment stream.  Providers are direct
 * persistent EWRAM spans, transient ranges are logical zero, and only the
 * small uncovered gaps are decoded from the previous snapshot. */
static NOINLINE uint32_t snapshot_encode_segments(
    FlashReadFn reader, const SnapshotState *previous, SnapshotSink *sink,
    uint32_t *stored, uint32_t *fingerprint, uint16_t *page_offsets)
{
    SnapshotDecoder decoder;
    uint8_t gap[SNAPSHOT_GAP_CHUNK];
    uint32_t logical = 0u;
    uint32_t provider = 0u;
    uint32_t transient = 0u;
    uint32_t produced = 0u;
    if (fingerprint)
        *fingerprint = 0x6D2B79F5u;
    if (!snapshot_decoder_init(&decoder, reader, previous))
        return 0;
    while (logical < SRAM_LOGICAL_SIZE) {
        const volatile SnapshotProvider *provider_config = provider
                < direct_snapshot_provider_count_config
            ? &direct_snapshot_providers_config[provider] : 0;
        const volatile SnapshotRange *transient_config = transient
                < direct_snapshot_transient_count_config
            ? &direct_snapshot_transient_ranges_config[transient] : 0;
        uint32_t provider_first = provider_config
            ? provider_config->logical_first : SRAM_LOGICAL_SIZE;
        uint32_t transient_first = transient_config
            ? transient_config->logical_first : SRAM_LOGICAL_SIZE;
        uint32_t page_left = SNAPSHOT_PAGE_SIZE
            - (logical & (SNAPSHOT_PAGE_SIZE - 1u));
        if (page_offsets && (logical & (SNAPSHOT_PAGE_SIZE - 1u)) == 0u)
            page_offsets[logical / SNAPSHOT_PAGE_SIZE] = (uint16_t)produced;
        if (transient_config && logical >= transient_first
            && logical < transient_first + transient_config->size) {
            uint32_t size = transient_first + transient_config->size - logical;
            if (size > page_left)
                size = page_left;
            if (!snapshot_decoder_skip(&decoder, size)
                || !snapshot_encode_zero(sink, size, &produced))
                return 0;
            logical += size;
            if (logical == transient_first + transient_config->size)
                ++transient;
        } else if (provider_config && logical >= provider_first
                   && logical < provider_first + provider_config->size) {
            uint32_t size = provider_first + provider_config->size - logical;
            const uint8_t *source = (const uint8_t *)(
                provider_config->source + logical - provider_first);
            if (size > page_left)
                size = page_left;
            if (!snapshot_decoder_skip(&decoder, size)
                || !snapshot_encode_bytes(
                    sink, source, size, logical, &produced, fingerprint))
                return 0;
            logical += size;
            if (logical == provider_first + provider_config->size)
                ++provider;
        } else {
            uint32_t end = provider_first < transient_first
                ? provider_first : transient_first;
            uint32_t size = end - logical;
            if (size > sizeof(gap))
                size = sizeof(gap);
            if (size > page_left)
                size = page_left;
            if (size == 0u)
                return 0;
            if (previous->blank) {
                if (!snapshot_decoder_skip(&decoder, size)
                    || !snapshot_encode_zero(sink, size, &produced))
                    return 0;
            } else {
                uint32_t index;
                for (index = 0u; index < size; ++index) {
                    if (!snapshot_decoder_next(&decoder, &gap[index]))
                        return 0;
                }
                if (!snapshot_encode_bytes(
                        sink, gap, size, logical, &produced, fingerprint))
                    return 0;
            }
            logical += size;
        }
    }
    *stored = produced;
    return produced <= SNAPSHOT_RLE_ENCODE_MAX
        && (!sink || snapshot_sink_finish(sink));
}

static uint32_t snapshot_sink_zero(SnapshotSink *sink, uint32_t size)
{
    while (size != 0u && sink->used != 0u) {
        if (!snapshot_sink_emit(sink, 0u))
            return 0;
        --size;
    }
    while (size != 0u) {
        uint32_t part = size;
        while (sink->erased_until
               < sink->output_base + sink->written + part) {
            if (!flash_erase_sector(sink->reader, sink->erased_until))
                return 0;
            sink->erased_until += SECTOR_SIZE;
        }
        sink->written += part;
        size -= part;
    }
    return 1;
}

static uint32_t snapshot_raw_bytes(
    SnapshotSink *sink, const uint8_t *source, uint32_t size,
    uint32_t logical_first, uint32_t *fingerprint)
{
    uint32_t index;
    for (index = 0u; index < size; ++index) {
        if (!snapshot_sink_emit(sink, source[index]))
            return 0;
        snapshot_fingerprint_byte(
            fingerprint, logical_first + index, source[index]);
    }
    return 1;
}

static NOINLINE uint32_t snapshot_write_raw_segments(
    FlashReadFn reader, const SnapshotState *previous, SnapshotSink *sink,
    uint32_t *fingerprint)
{
    SnapshotDecoder decoder;
    uint8_t gap[16];
    uint32_t logical = 0u;
    uint32_t provider = 0u;
    uint32_t transient = 0u;
    *fingerprint = 0x6D2B79F5u;
    if (!snapshot_decoder_init(&decoder, reader, previous))
        return 0;
    while (logical < SRAM_LOGICAL_SIZE) {
        const volatile SnapshotProvider *provider_config = provider
                < direct_snapshot_provider_count_config
            ? &direct_snapshot_providers_config[provider] : 0;
        const volatile SnapshotRange *transient_config = transient
                < direct_snapshot_transient_count_config
            ? &direct_snapshot_transient_ranges_config[transient] : 0;
        uint32_t provider_first = provider_config
            ? provider_config->logical_first : SRAM_LOGICAL_SIZE;
        uint32_t transient_first = transient_config
            ? transient_config->logical_first : SRAM_LOGICAL_SIZE;
        if (transient_config && logical >= transient_first
            && logical < transient_first + transient_config->size) {
            uint32_t size = transient_first + transient_config->size - logical;
            if (!snapshot_decoder_skip(&decoder, size)
                || !snapshot_sink_zero(sink, size))
                return 0;
            logical += size;
            ++transient;
        } else if (provider_config && logical >= provider_first
                   && logical < provider_first + provider_config->size) {
            uint32_t size = provider_first + provider_config->size - logical;
            const uint8_t *source = (const uint8_t *)(
                provider_config->source + logical - provider_first);
            if (!snapshot_decoder_skip(&decoder, size)
                || !snapshot_raw_bytes(
                    sink, source, size, logical, fingerprint))
                return 0;
            logical += size;
            ++provider;
        } else {
            uint32_t end = provider_first < transient_first
                ? provider_first : transient_first;
            uint32_t size = end - logical;
            if (size > sizeof(gap))
                size = sizeof(gap);
            if (size == 0u)
                return 0;
            if (previous->blank) {
                if (!snapshot_decoder_skip(&decoder, size)
                    || !snapshot_sink_zero(sink, size))
                    return 0;
            } else {
                uint32_t index;
                for (index = 0u; index < size; ++index) {
                    if (!snapshot_decoder_next(&decoder, &gap[index]))
                        return 0;
                }
                if (!snapshot_raw_bytes(
                        sink, gap, size, logical, fingerprint))
                    return 0;
            }
            logical += size;
        }
    }
    return snapshot_sink_finish(sink);
}

static uint32_t snapshot_provider_source_matches(
    const uint8_t *source, uint32_t first, uint32_t size)
{
    uint32_t index;
    uintptr_t source_address = (uintptr_t)source;
    for (index = 0u; index < direct_snapshot_provider_count_config; ++index) {
        const volatile SnapshotProvider *provider =
            &direct_snapshot_providers_config[index];
        uintptr_t expected;
        if (first < provider->logical_first
            || first >= provider->logical_first + provider->size
            || size > provider->size
                - (first - provider->logical_first))
            continue;
        expected = provider->source + first - provider->logical_first;
        if (source_address == expected)
            return 1;
    }
    return 0;
}

static uint32_t snapshot_transient_source_matches(
    const uint8_t *source, uint32_t first, uint32_t size)
{
    uint32_t index;
    uintptr_t source_address = (uintptr_t)source;
    for (index = 0u; index < direct_snapshot_transient_count_config; ++index) {
        const volatile SnapshotRange *range =
            &direct_snapshot_transient_ranges_config[index];
        uintptr_t expected;
        if (first < range->logical_first
            || first >= range->logical_first + range->size
            || size > range->size - (first - range->logical_first))
            continue;
        expected = range->source + first - range->logical_first;
        if (source_address == expected)
            return 1;
    }
    return 0;
}

/* If the semantic segment layout guarantees that even incompressible source
 * bytes fit, the expensive data-dependent measurement pass is unnecessary.
 * This bound is derived solely from the configured provider/range geometry;
 * it does not assume anything about a particular ROM or save image. */
static NOINLINE uint32_t snapshot_rle_always_fits(void)
{
    uint32_t logical = 0u;
    uint32_t provider = 0u;
    uint32_t transient = 0u;
    uint32_t produced = 0u;
    while (logical < SRAM_LOGICAL_SIZE) {
        const volatile SnapshotProvider *provider_config = provider
                < direct_snapshot_provider_count_config
            ? &direct_snapshot_providers_config[provider] : 0;
        const volatile SnapshotRange *transient_config = transient
                < direct_snapshot_transient_count_config
            ? &direct_snapshot_transient_ranges_config[transient] : 0;
        uint32_t provider_first = provider_config
            ? provider_config->logical_first : SRAM_LOGICAL_SIZE;
        uint32_t transient_first = transient_config
            ? transient_config->logical_first : SRAM_LOGICAL_SIZE;
        uint32_t page_left = SNAPSHOT_PAGE_SIZE
            - (logical & (SNAPSHOT_PAGE_SIZE - 1u));
        uint32_t size;
        if (transient_config && logical >= transient_first
            && logical < transient_first + transient_config->size) {
            size = transient_first + transient_config->size - logical;
            if (size > page_left)
                size = page_left;
            {
                uint32_t remainder = size;
                while (remainder >= 130u) {
                    produced += 2u;
                    remainder -= 130u;
                }
                if (remainder != 0u)
                    produced += remainder < 3u ? remainder + 1u : 2u;
            }
            logical += size;
            if (logical == transient_first + transient_config->size)
                ++transient;
        } else if (provider_config && logical >= provider_first
                   && logical < provider_first + provider_config->size) {
            size = provider_first + provider_config->size - logical;
            if (size > page_left)
                size = page_left;
            produced += size + (size + 127u) / 128u;
            logical += size;
            if (logical == provider_first + provider_config->size)
                ++provider;
        } else {
            uint32_t end = provider_first < transient_first
                ? provider_first : transient_first;
            size = end - logical;
            if (size > SNAPSHOT_GAP_CHUNK)
                size = SNAPSHOT_GAP_CHUNK;
            if (size > page_left)
                size = page_left;
            if (size == 0u)
                return 0;
            produced += size + 1u;
            logical += size;
        }
        if (produced > SNAPSHOT_SLOT_SIZE - SNAPSHOT_HEADER_SIZE
                - SNAPSHOT_INDEX_SIZE)
            return 0;
    }
    return 1;
}

static NOINLINE uint32_t snapshot_commit(FlashReadFn reader,
                                         const uint8_t *commit_source)
{
    SnapshotState previous;
    SnapshotSink sink;
    uint16_t page_offsets[SNAPSHOT_PAGE_COUNT];
    uint8_t *header = (uint8_t *)page_offsets;
    uint32_t rle_size;
    uint32_t written;
    uint32_t index;
    uint32_t fingerprint;
    uint32_t target_base;
    uint32_t tag;
    uint32_t stored;
    uint32_t measured;
    if (!snapshot_configs_valid() || !snapshot_locate(reader, &previous)
        || !snapshot_provider_source_matches(
            commit_source, direct_snapshot_commit_first_config,
            direct_snapshot_commit_size_config))
        return 0;
    measured = !snapshot_rle_always_fits();
    if (measured) {
        if (!snapshot_encode_segments(
                reader, &previous, (SnapshotSink *)0,
                &rle_size, (uint32_t *)0, page_offsets))
            return 0;
        tag = rle_size + SNAPSHOT_INDEX_SIZE
                <= SNAPSHOT_SLOT_SIZE - SNAPSHOT_HEADER_SIZE
            ? SNAPSHOT_RLE : SNAPSHOT_RAW;
    } else {
        rle_size = 0u;
        tag = SNAPSHOT_RLE;
    }
    target_base = previous.blank
        ? 0u : previous.header_base ^ SNAPSHOT_SLOT_SIZE;
    sink.reader = reader;
    sink.output_base = target_base + (tag == SNAPSHOT_RLE
        ? SNAPSHOT_DATA_BASE + SNAPSHOT_INDEX_SIZE : 0u);
    sink.written = 0u;
    sink.used = 0u;
    sink.erased_until = target_base;
    if (tag == SNAPSHOT_RLE) {
        if (!snapshot_encode_segments(
                reader, &previous, &sink, &written,
                &fingerprint, page_offsets)
            || (measured && written != rle_size))
            return 0;
        stored = written + SNAPSHOT_INDEX_SIZE;
        for (index = 0u; index < SNAPSHOT_PAGE_COUNT; ++index)
            page_offsets[index] = (uint16_t)~page_offsets[index];
        if (!flash_program_range(
                reader, target_base + SNAPSHOT_DATA_BASE,
                (const uint8_t *)page_offsets,
                SNAPSHOT_INDEX_SIZE))
            return 0;
    } else {
        if (!snapshot_write_raw_segments(
                reader, &previous, &sink, &fingerprint)
            || sink.written != SRAM_LOGICAL_SIZE)
            return 0;
        stored = SRAM_LOGICAL_SIZE;
    }
    for (index = 0u; index < SNAPSHOT_HEADER_SIZE; ++index)
        header[index] = 0xFFu;
    snapshot_write_u32(header, SNAPSHOT_MAGIC);
    header[4] = SNAPSHOT_VERSION;
    header[5] = (uint8_t)tag;
    header[6] = (uint8_t)stored;
    header[7] = (uint8_t)(stored >> 8);
    header[8] = (uint8_t)~stored;
    header[9] = (uint8_t)~(stored >> 8);
    header[10] = 0x00u;
    header[11] = 0x80u;
    snapshot_write_u32(header + 12, fingerprint);
    if (!previous.blank
        && !flash_erase_sector(reader, previous.header_base))
        return 0;
    return flash_program_range(
        reader, target_base, header, SNAPSHOT_HEADER_SIZE);
}

static uint32_t snapshot_range_has_provider(uint32_t first, uint32_t size);

static NOINLINE uint32_t snapshot_sram_write(FlashReadFn reader,
                                    const uint8_t *source,
                                    uint32_t first, uint32_t size)
{
    if (!snapshot_configs_valid())
        return 0;
    if (snapshot_range_has_provider(first, size))
        return snapshot_provider_source_matches(source, first, size);
    {
        SnapshotState state;
        uint32_t index;
        if (!snapshot_transient_source_matches(source, first, size)
            || !snapshot_locate(reader, &state))
            return 0;
        if (!state.blank)
            return 1;
        for (index = 0u; index < size; ++index) {
            if (source[index] != 0u)
                return 0;
        }
        return 1;
    }
}

static uint32_t snapshot_sram_read(FlashReadFn reader, uint32_t first,
                                   uint8_t *destination, uint32_t size)
{
    SnapshotState state;
    uint32_t index;
    if (!snapshot_configs_valid() || !snapshot_locate(reader, &state))
        return 0;
    if (state.blank) {
        if (snapshot_transient_source_matches(destination, first, size))
            return 1;
        for (index = 0u; index < size; ++index)
            destination[index] = 0u;
        return 1;
    }
    if (state.tag == SNAPSHOT_RAW) {
        flash_read_range(reader, state.data_base + first, destination, size);
        for (index = 0u; index < size; ++index)
            destination[index] = (uint8_t)~destination[index];
        for (index = 0u; index < direct_snapshot_transient_count_config;
             ++index) {
            const volatile SnapshotRange *range =
                &direct_snapshot_transient_ranges_config[index];
            uint32_t overlap_first = first > range->logical_first
                ? first : range->logical_first;
            uint32_t range_end = range->logical_first + range->size;
            uint32_t request_end = first + size;
            uint32_t overlap_end = request_end < range_end
                ? request_end : range_end;
            uint32_t logical;
            for (logical = overlap_first; logical < overlap_end; ++logical)
                destination[logical - first] = 0u;
        }
        return 1;
    }
    {
        uint32_t cursor = 0u;
        while (cursor < size) {
            uint32_t logical = first + cursor;
            uint32_t page = logical / SNAPSHOT_PAGE_SIZE;
            uint32_t page_first = page * SNAPSHOT_PAGE_SIZE;
            uint32_t page_end = page_first + SNAPSHOT_PAGE_SIZE;
            uint32_t wanted_end = first + size < page_end
                ? first + size : page_end;
            uint32_t offset_at = page * 2u;
            uint32_t input = (uint8_t)~flash_read(
                reader, state.data_base + offset_at);
            uint32_t input_end;
            uint32_t output = page_first;
            input |= (uint32_t)(uint8_t)~flash_read(
                reader, state.data_base + offset_at + 1u) << 8;
            if (page + 1u < SNAPSHOT_PAGE_COUNT) {
                input_end = (uint8_t)~flash_read(
                    reader, state.data_base + offset_at + 2u);
                input_end |= (uint32_t)(uint8_t)~flash_read(
                    reader, state.data_base + offset_at + 3u) << 8;
            } else {
                input_end = state.stored - SNAPSHOT_INDEX_SIZE;
            }
            if (input >= input_end
                || input_end > state.stored - SNAPSHOT_INDEX_SIZE)
                return 0;
            input += SNAPSHOT_INDEX_SIZE;
            input_end += SNAPSHOT_INDEX_SIZE;
            while (input < input_end && output < wanted_end) {
                uint32_t control = (uint8_t)~flash_read(
                    reader, state.data_base + input++);
            uint32_t count = control < 0x80u
                ? control + 1u : (control & 0x7Fu) + 3u;
            uint32_t run_end = output + count;
                uint32_t copy_first = output < logical ? logical : output;
            uint32_t copy_end = run_end > wanted_end ? wanted_end : run_end;
                if (run_end > page_end)
                return 0;
            if (control < 0x80u) {
                    if (count > input_end - input)
                    return 0;
                if (copy_first < copy_end) {
                    uint32_t copy_size = copy_end - copy_first;
                    flash_read_range(reader,
                                     state.data_base + input
                                         + copy_first - output,
                                         destination + copy_first - first,
                                     copy_size);
                    for (index = copy_first - first;
                         index < copy_end - first; ++index)
                        destination[index] = (uint8_t)~destination[index];
                }
                input += count;
            } else {
                uint8_t value;
                    if (input >= input_end)
                    return 0;
                value = (uint8_t)~flash_read(
                    reader, state.data_base + input++);
                for (index = copy_first; index < copy_end; ++index)
                    destination[index - first] = value;
            }
            output = run_end;
        }
            if (output != page_end || input != input_end)
                return 0;
            cursor = wanted_end - first;
        }
        return 1;
    }
}

static NOINLINE uint32_t snapshot_visible_read(
    FlashReadFn reader, const uint8_t *source, uint32_t first,
    uint8_t *destination, uint32_t size)
{
    uint32_t index;
    (void)reader;
    if (!snapshot_provider_source_matches(source, first, size))
        return 0;
    for (index = 0u; index < size; ++index)
        destination[index] = *(const volatile uint8_t *)(
            (uintptr_t)source + index);
    return 1;
}

static uint32_t snapshot_range_has_provider(uint32_t first, uint32_t size)
{
    uint32_t index;
    for (index = 0u; index < direct_snapshot_provider_count_config; ++index) {
        const volatile SnapshotProvider *segment =
            &direct_snapshot_providers_config[index];
        if (first >= segment->logical_first
            && first < segment->logical_first + segment->size
            && size <= segment->size - (first - segment->logical_first))
            return 1;
    }
    return 0;
}

#endif

static uint32_t sram16_program_entry(FlashReadFn reader,
                                     uint32_t position,
                                     uint32_t logical,
                                     uint8_t value)
{
    uint8_t encoded = (uint8_t)~value;
    uint8_t commit = (uint8_t)(logical
        & (SRAM_SECTOR_LOG_BLOCK_SIZE - 1u));
    if (encoded != 0xFFu
        && !flash_program_byte(reader, position, encoded))
        return 0u;
    return flash_program_byte(reader, position + 1u, commit);
}

static void sram16_rle_measure(const uint8_t *source,
                               uint32_t *stored, uint32_t *cost)
{
    uint32_t at = 0u;
    uint32_t bytes = 0u;
    uint32_t commands = 0u;
    while (at < SRAM_SECTOR_LOG_BLOCK_SIZE) {
        uint32_t run = 1u;
        while (at + run < SRAM_SECTOR_LOG_BLOCK_SIZE
               && source[at + run] == source[at])
            ++run;
        if (run >= 3u) {
            ++commands;
            if (source[at] != 0u)
                ++commands;
            bytes += 2u;
            at += run;
        } else {
            uint32_t first = at;
            uint32_t index;
            at += run;
            while (at < SRAM_SECTOR_LOG_BLOCK_SIZE) {
                run = 1u;
                while (at + run < SRAM_SECTOR_LOG_BLOCK_SIZE
                       && source[at + run] == source[at])
                    ++run;
                if (run >= 3u)
                    break;
                at += run;
            }
            if (at - first > 1u)
                ++commands;
            ++bytes;
            for (index = first; index < at; ++index) {
                if (source[index] != 0u)
                    ++commands;
                ++bytes;
            }
        }
    }
    *stored = bytes;
    *cost = commands + 1u;
}

static uint32_t sram16_program_rle_byte(FlashReadFn reader,
                                        uint32_t position,
                                        uint32_t output, uint8_t value)
{
    uint32_t target = output == 0u
        ? position : position + output + 1u;
    return flash_program_byte(reader, target, (uint8_t)~value);
}

static uint32_t sram16_program_rle_block(FlashReadFn reader,
                                         uint32_t position,
                                         const uint8_t *source,
                                         uint32_t stored)
{
    uint32_t at = 0u;
    uint32_t output = 0u;
    if (!source || stored == 0u
        || stored > SRAM_SECTOR_LOG_RLE_LENGTH_MASK + 1u)
        return 0u;
    while (at < SRAM_SECTOR_LOG_BLOCK_SIZE) {
        uint32_t run = 1u;
        while (at + run < SRAM_SECTOR_LOG_BLOCK_SIZE
               && source[at + run] == source[at])
            ++run;
        if (run >= 3u) {
            uint8_t control = (uint8_t)(0x80u | (run - 3u));
            if (!sram16_program_rle_byte(
                    reader, position, output++, control)
                || !sram16_program_rle_byte(
                    reader, position, output++, source[at]))
                return 0u;
            at += run;
        } else {
            uint32_t first = at;
            uint32_t index;
            at += run;
            while (at < SRAM_SECTOR_LOG_BLOCK_SIZE) {
                run = 1u;
                while (at + run < SRAM_SECTOR_LOG_BLOCK_SIZE
                       && source[at + run] == source[at])
                    ++run;
                if (run >= 3u)
                    break;
                at += run;
            }
            if (!sram16_program_rle_byte(
                    reader, position, output++,
                    (uint8_t)(at - first - 1u)))
                return 0u;
            for (index = first; index < at; ++index) {
                if (!sram16_program_rle_byte(
                        reader, position, output++, source[index]))
                    return 0u;
            }
        }
    }
    return output == stored
        && flash_program_byte(
            reader, position + 1u,
            (uint8_t)(SRAM_SECTOR_LOG_RLE_TAG_BASE | (stored - 1u)));
}

/* Rewrite one visible 4-KiB sector through the dedicated scratch sector. */
static NOINLINE uint32_t sram16_rewrite_base_sector(
    FlashReadFn reader, uint32_t sector_first, uint32_t update_first,
    const uint8_t *update, uint32_t update_size)
{
    uint8_t visible[SRAM_SECTOR_LOG_BLOCK_SIZE];
    uint8_t physical[SRAM_SECTOR_LOG_BLOCK_SIZE];
    uint8_t overlay[SRAM_SECTOR_OVERLAY_SIZE];
    uint32_t cursor;
    if ((sector_first & (SECTOR_SIZE - 1u)) != 0u
        || sector_first >= SRAM_LOGICAL_SIZE
        || (update_size != 0u
            && (!update || update_first < sector_first
                || update_first > sector_first + SECTOR_SIZE
                || update_size
                    > sector_first + SECTOR_SIZE - update_first)))
        return 0u;
    if (!flash_erase_sector(reader, SRAM_SCRATCH_BASE))
        return 0u;
    for (cursor = 0u; cursor < SECTOR_SIZE;
         cursor += SRAM_SECTOR_LOG_BLOCK_SIZE) {
        uint32_t logical = sector_first + cursor;
        uint32_t unused_log_end;
        uint32_t unused_log_limit;
        uint32_t overlap_first;
        uint32_t overlap_end;
        uint32_t index;
        if (!sram16_load_range(
                reader, logical, visible, sizeof(visible), overlay,
                (uint16_t *)0, &unused_log_end, &unused_log_limit))
            return 0u;
        overlap_first = logical;
        overlap_end = logical;
        if (update_size != 0u) {
            overlap_first = logical > update_first ? logical : update_first;
            overlap_end = logical + sizeof(visible);
            if (overlap_end > update_first + update_size)
                overlap_end = update_first + update_size;
        }
        if (overlap_first < overlap_end) {
            for (index = overlap_first; index < overlap_end; ++index)
                visible[index - logical] = update[index - update_first];
        }
        if (!flash_program_inverted_data(
                reader, SRAM_SCRATCH_BASE + cursor,
                visible, sizeof(visible)))
            return 0u;
    }
    if (!flash_erase_sector(reader, sector_first))
        return 0u;
    for (cursor = 0u; cursor < SECTOR_SIZE;
         cursor += sizeof(physical)) {
        flash_read_range(reader, SRAM_SCRATCH_BASE + cursor,
                         physical, sizeof(physical));
        if (!flash_program_range(reader, sector_first + cursor,
                                 physical, sizeof(physical)))
            return 0u;
    }
    if (!flash_erase_sector(reader, SRAM_SCRATCH_BASE))
        return 0u;
    return 1u;
}

/*
 * Sectors six and seven share one physical erase unit for their logs.  When
 * either half fills, compact the sibling first if it has records, then erase
 * the shared log sector.  Thus an erase can never discard a live overlay.
 */
static NOINLINE uint32_t sram16_rebuild_sector(
    FlashReadFn reader, uint32_t sector_first, uint32_t update_first,
    const uint8_t *update, uint32_t update_size)
{
    uint32_t sector = sector_first / SECTOR_SIZE;
    uint32_t log_sector;
    if (sector >= SRAM_SECTOR_LOG_COUNT
        || !sram16_rewrite_base_sector(
            reader, sector_first, update_first, update, update_size))
        return 0u;
    if (sector >= SRAM_FULL_LOG_SECTOR_COUNT) {
        uint32_t sibling = sector == SRAM_FULL_LOG_SECTOR_COUNT
            ? sector + 1u : sector - 1u;
        uint32_t sibling_log = SRAM_SHARED_LOG_BASE
            + (sibling - SRAM_FULL_LOG_SECTOR_COUNT)
                * SRAM_SHARED_LOG_PARTITION_SIZE;
        if (!flash_range_erased(
                reader, sibling_log, SRAM_SHARED_LOG_PARTITION_SIZE)
            && !sram16_rewrite_base_sector(
                reader, sibling * SECTOR_SIZE, sibling * SECTOR_SIZE,
                (const uint8_t *)0, 0u))
            return 0u;
        log_sector = SRAM_SHARED_LOG_BASE;
    } else {
        log_sector = SRAM_SECTOR_LOG_BASE + sector * SECTOR_SIZE;
    }
    if (!flash_erase_sector(reader, log_sector))
        return 0u;
    if (sector == 0u && !sram16_initialize(reader))
        return 0u;
    return 1u;
}

#ifdef DIRECT_SRAM_TRANSACTION_BUILD
/* Short SDK transactions are metadata updates, not fragments of the bulk
 * writer.  Decode only their requested bytes and only the occupied prefix of
 * the append-only log.  This keeps late-VBlank writes bounded without changing
 * the physical format or weakening exact readback semantics. */
static uint32_t sram16_write_partial(
    FlashReadFn reader, const uint8_t *source, uint32_t first, uint32_t size)
{
    uint8_t visible[SRAM_SECTOR_LOG_BLOCK_SIZE];
    uint8_t overlay[SRAM_SECTOR_OVERLAY_SIZE];
    uint8_t log_changes[SRAM_SECTOR_OVERLAY_SIZE];
    uint8_t record_updates[SRAM_SECTOR_OVERLAY_SIZE];
    uint16_t latest[SRAM_SECTOR_LOG_BLOCK_SIZE];
    uint32_t block_first = first
        & ~(SRAM_SECTOR_LOG_BLOCK_SIZE - 1u);
    uint32_t log_end;
    uint32_t log_limit;
    uint32_t log_count = 0u;
    uint32_t changed = 0u;
    uint32_t cursor;
    uint32_t sector = block_first / SECTOR_SIZE;
    if (!source || size == 0u || size >= SRAM_SECTOR_LOG_BLOCK_SIZE
        || first >= SRAM_LOGICAL_SIZE
        || size > SRAM_LOGICAL_SIZE - first
        || (first + size - 1u) / SRAM_SECTOR_LOG_BLOCK_SIZE
            != first / SRAM_SECTOR_LOG_BLOCK_SIZE)
        return 0u;
    if (!sram16_load_range(
            reader, first, visible, size, overlay, latest, &log_end,
            &log_limit))
        return 0u;
    for (cursor = 0u; cursor < sizeof(log_changes); ++cursor) {
        log_changes[cursor] = 0u;
        record_updates[cursor] = 0u;
    }
    for (cursor = 0u; cursor < size; ++cursor) {
        uint8_t mask = (uint8_t)(1u << (cursor & 7u));
        uint8_t old_physical;
        uint8_t new_physical;
        if (visible[cursor] == source[cursor])
            continue;
        changed = 1u;
        old_physical = (uint8_t)~visible[cursor];
        new_physical = (uint8_t)~source[cursor];
        if ((overlay[cursor >> 3] & mask) != 0u
            && latest[cursor] != 0xFFFFu
            && (old_physical & new_physical) == new_physical) {
            record_updates[cursor >> 3] |= mask;
        } else if ((overlay[cursor >> 3] & mask) != 0u
                   || (old_physical & new_physical) != new_physical) {
            log_changes[cursor >> 3] |= mask;
            ++log_count;
        }
    }
    if (!changed)
        return 1u;
    if (sector >= SRAM_SECTOR_LOG_COUNT
        || (log_count != 0u && !sram16_reserve_log(
            reader, block_first,
            log_count * SRAM_SECTOR_LOG_ENTRY_SIZE,
            &log_end, &log_limit))) {
        return sram16_rebuild_sector(
            reader, first & ~(SECTOR_SIZE - 1u), first, source, size);
    }
    for (cursor = 0u; cursor < size;) {
        uint32_t run_first;
        while (cursor < size
               && (visible[cursor] == source[cursor]
                   || (log_changes[cursor >> 3]
                       & (1u << (cursor & 7u))) != 0u
                   || (record_updates[cursor >> 3]
                       & (1u << (cursor & 7u))) != 0u))
            ++cursor;
        run_first = cursor;
        while (cursor < size
               && visible[cursor] != source[cursor]
               && (log_changes[cursor >> 3]
                   & (1u << (cursor & 7u))) == 0u
               && (record_updates[cursor >> 3]
                   & (1u << (cursor & 7u))) == 0u)
            ++cursor;
        if (cursor != run_first
            && !flash_program_inverted_data(
                reader, first + run_first, source + run_first,
                cursor - run_first))
            return 0u;
    }
    for (cursor = 0u; cursor < size; ++cursor) {
        if ((record_updates[cursor >> 3]
             & (1u << (cursor & 7u))) == 0u)
            continue;
        if (latest[cursor] == 0xFFFFu
            || !flash_program_byte(
                reader, latest[cursor],
                (uint8_t)~source[cursor]))
            return 0u;
    }
    for (cursor = 0u; cursor < size; ++cursor) {
        if ((log_changes[cursor >> 3]
             & (1u << (cursor & 7u))) == 0u)
            continue;
        if (!sram16_program_entry(
                reader, log_end, first + cursor, source[cursor]))
            return 0u;
        log_end += SRAM_SECTOR_LOG_ENTRY_SIZE;
    }
    return 1u;
}
#endif

static uint32_t sram16_write_buffer(FlashReadFn reader,
                                    const uint8_t *source,
                                    uint32_t first, uint32_t size)
{
    uint8_t visible[SRAM_SECTOR_LOG_BLOCK_SIZE];
    uint8_t desired[SRAM_SECTOR_LOG_BLOCK_SIZE];
    uint8_t overlay[SRAM_SECTOR_OVERLAY_SIZE];
    uint8_t log_changes[SRAM_SECTOR_OVERLAY_SIZE];
    uint8_t record_updates[SRAM_SECTOR_OVERLAY_SIZE];
    uint16_t latest[SRAM_SECTOR_LOG_BLOCK_SIZE];
    uint32_t block_first = first
        & ~(SRAM_SECTOR_LOG_BLOCK_SIZE - 1u);
    uint32_t update_at = first - block_first;
    uint32_t log_end;
    uint32_t log_limit;
    uint32_t log_count = 0u;
    uint32_t normal_cost = 0u;
    uint32_t rle_stored;
    uint32_t rle_cost;
#ifdef DIRECT_SRAM_TRANSACTION_BUILD
    uint32_t changed = 0u;
#endif
    uint32_t cursor;
    uint32_t sector = block_first / SECTOR_SIZE;
    if (!source || size == 0u || size > sizeof(visible)
        || first >= SRAM_LOGICAL_SIZE
        || size > SRAM_LOGICAL_SIZE - first
        || (first + size - 1u) / SRAM_SECTOR_LOG_BLOCK_SIZE
            != first / SRAM_SECTOR_LOG_BLOCK_SIZE)
        return 0u;
    if (!sram16_load_range(
            reader, block_first, visible, sizeof(visible),
            overlay, latest, &log_end, &log_limit))
        return 0u;
    copy_from_ram(desired, visible, sizeof(desired));
    copy_from_ram(desired + update_at, source, size);
#ifdef DIRECT_SRAM_TRANSACTION_BUILD
    for (cursor = 0u; cursor < sizeof(visible); ++cursor)
        changed |= visible[cursor] != desired[cursor];
    if (!changed)
        return 1u;
#endif
    for (cursor = 0u; cursor < sizeof(log_changes); ++cursor) {
        log_changes[cursor] = 0u;
        record_updates[cursor] = 0u;
    }
    for (cursor = 0u; cursor < sizeof(visible); ++cursor) {
        uint8_t mask = (uint8_t)(1u << (cursor & 7u));
        uint8_t old_physical;
        uint8_t new_physical;
        if (visible[cursor] == desired[cursor])
            continue;
        old_physical = (uint8_t)~visible[cursor];
        new_physical = (uint8_t)~desired[cursor];
        if ((overlay[cursor >> 3] & mask) != 0u
            && latest[cursor] != 0xFFFFu
            && (old_physical & new_physical) == new_physical) {
            record_updates[cursor >> 3] |= mask;
            if (new_physical != 0xFFu)
                ++normal_cost;
        } else if ((overlay[cursor >> 3] & mask) != 0u
                   || (old_physical & new_physical) != new_physical) {
            log_changes[cursor >> 3] |= mask;
            ++log_count;
            ++normal_cost;
            if (new_physical != 0xFFu)
                ++normal_cost;
        } else if (new_physical != 0xFFu) {
            ++normal_cost;
        }
    }
    sram16_rle_measure(desired, &rle_stored, &rle_cost);
    /* A partial write is often the first or last fragment of a larger
     * sequential transfer.  Recording a whole-block image here would consume
     * the slice before the adjacent fragment arrives and can force an
     * otherwise unnecessary 4-KiB reconstruction. */
    if (update_at == 0u && size == SRAM_SECTOR_LOG_BLOCK_SIZE
        && rle_cost < normal_cost
        && sram16_reserve_log(
            reader, block_first, rle_stored + 1u,
            &log_end, &log_limit))
        return sram16_program_rle_block(
            reader, log_end, desired, rle_stored);
    if (sector >= SRAM_SECTOR_LOG_COUNT
        || (log_count != 0u && !sram16_reserve_log(
            reader, block_first,
            log_count * SRAM_SECTOR_LOG_ENTRY_SIZE,
            &log_end, &log_limit))) {
        return sram16_rebuild_sector(
            reader, first & ~(SECTOR_SIZE - 1u), first, source, size);
    }
    for (cursor = 0u; cursor < sizeof(visible);) {
        uint32_t run_first;
        while (cursor < sizeof(visible)
               && (visible[cursor] == desired[cursor]
                   || (log_changes[cursor >> 3]
                       & (1u << (cursor & 7u))) != 0u
                   || (record_updates[cursor >> 3]
                       & (1u << (cursor & 7u))) != 0u))
            ++cursor;
        run_first = cursor;
        while (cursor < sizeof(visible)
               && visible[cursor] != desired[cursor]
               && (log_changes[cursor >> 3]
                   & (1u << (cursor & 7u))) == 0u
               && (record_updates[cursor >> 3]
                   & (1u << (cursor & 7u))) == 0u)
            ++cursor;
        if (cursor != run_first
            && !flash_program_inverted_data(
                reader, block_first + run_first, desired + run_first,
                cursor - run_first))
            return 0u;
    }
    for (cursor = 0u; cursor < sizeof(visible); ++cursor) {
        if ((record_updates[cursor >> 3]
             & (1u << (cursor & 7u))) == 0u)
            continue;
        if (latest[cursor] == 0xFFFFu
            || !flash_program_byte(
                reader, latest[cursor],
                (uint8_t)~desired[cursor]))
            return 0u;
    }
    for (cursor = 0u; cursor < sizeof(visible); ++cursor) {
        if ((log_changes[cursor >> 3]
             & (1u << (cursor & 7u))) == 0u)
            continue;
        if (!sram16_program_entry(
                reader, log_end, block_first + cursor, desired[cursor]))
            return 0u;
        log_end += SRAM_SECTOR_LOG_ENTRY_SIZE;
    }
    return 1u;
}

#ifdef DIRECT_SRAM_TRANSACTION_BUILD
static uint32_t sram16_write_buffer_fast(
    FlashReadFn reader, const uint8_t *source,
    uint32_t first, uint32_t size, uint32_t fast_blank)
{
    if (!fast_blank)
        return sram16_write_partial(reader, source, first, size);
    if (fast_blank
        && sram16_blank_slice_matches(reader, source, first, size))
        return 1u;
    return sram16_write_buffer(reader, source, first, size);
}
#endif

static NOINLINE uint32_t sram16_write_alias(
    FlashReadFn reader, uint32_t source_first, uint32_t first,
    uint32_t size)
{
    uint8_t staged[SRAM_ALIAS_CHUNK];
    uint32_t backwards = first > source_first
        && first < source_first + size;
    uint32_t cursor = backwards ? size : 0u;
    while ((!backwards && cursor < size)
           || (backwards && cursor != 0u)) {
        uint32_t part = backwards
            ? (cursor < sizeof(staged) ? cursor : sizeof(staged))
            : (size - cursor < sizeof(staged)
               ? size - cursor : sizeof(staged));
        uint32_t at = backwards ? cursor - part : cursor;
        uint32_t target_room = backwards
            ? (((first + cursor - 1u)
                & (SRAM_SECTOR_LOG_BLOCK_SIZE - 1u)) + 1u)
            : (SRAM_SECTOR_LOG_BLOCK_SIZE
               - ((first + cursor)
                  & (SRAM_SECTOR_LOG_BLOCK_SIZE - 1u)));
        if (part > target_room) {
            part = target_room;
            at = backwards ? cursor - part : cursor;
        }
        if (!sram16_read_range(reader, source_first + at, staged, part)
            || !sram16_write_buffer(reader, staged, first + at, part))
            return 0u;
        cursor = backwards ? at : cursor + part;
    }
    return 1u;
}

static NOINLINE uint32_t __attribute__((unused))
sram16_write_core(FlashReadFn reader, const uint8_t *source,
                  uint32_t first, uint32_t size)
{
    uint32_t source_alias;
    uint32_t state;
    uint32_t cursor;
    if (!direct_config_matches(SAVE_LAYOUT_SRAM) || (!source && size != 0u)
        || first > SRAM_LOGICAL_SIZE || size > SRAM_LOGICAL_SIZE - first)
        return 0u;
    if (size == 0u)
        return 1u;
    source_alias = source_is_save(source, size);
    if (source_starts_in_save(source) && (!source_alias
        || ((uintptr_t)source & (SRAM_LOGICAL_SIZE - 1u))
            > SRAM_LOGICAL_SIZE - size))
        return 0u;
    state = sram16_layout_state(reader);
    if (state == 1u) {
        if (!sram16_initialize(reader))
            return 0u;
        state = 2u;
    }
    if (state != 2u)
        return 0u;
    if (source_alias)
        return sram16_write_alias(
            reader, (uintptr_t)source & (SRAM_LOGICAL_SIZE - 1u),
            first, size);
    for (cursor = 0u; cursor < size;) {
        uint32_t block_left = SRAM_SECTOR_LOG_BLOCK_SIZE
            - ((first + cursor) & (SRAM_SECTOR_LOG_BLOCK_SIZE - 1u));
        uint32_t part = size - cursor < block_left
            ? size - cursor : block_left;
#ifdef DIRECT_SRAM_TRANSACTION_BUILD
        if (!sram16_write_buffer_fast(
                reader, source + cursor, first + cursor, part,
                size >= SRAM_SECTOR_LOG_BLOCK_SIZE))
#else
        if (!sram16_write_buffer(
                reader, source + cursor, first + cursor, part))
#endif
            return 0u;
        cursor += part;
    }
    return 1u;
}

#ifndef DIRECT_SRAM_ONLY_BUILD
static const uint8_t eeprom_header[16] = {
    'L', 'K', 'E', 'D', DIRECT_EEPROM_LAYOUT_VERSION,
    EEPROM_GENERATIONS, 7, 0xFF,
    0x00, 0x20, 1, 0xFF, 'D', 'E', 'K', 'L'
};

/* 0 unknown, 1 blank control sector, 2 inverted Direct EEPROM v5. */
static uint32_t eeprom_layout_state(FlashReadFn reader)
{
    uint8_t visible[sizeof(eeprom_header)];
    uint32_t index;
    flash_read_range(reader, EEPROM_HEADER_BASE, visible, sizeof(visible));
    if (visible[0] == 0xFFu)
        return 1u;
    for (index = 0; index < sizeof(eeprom_header); ++index) {
        if (visible[index] != eeprom_header[index])
            return 0;
    }
    return layout_marker_valid(flash_read(reader, EEPROM_PROGRAM_MARKER),
                               EEPROM_LAYOUT_MARKER_BASE) ? 2u : 0u;
}

static uint32_t eeprom_initialize(FlashReadFn reader)
{
    if (eeprom_layout_state(reader) != 1u)
        return 0;
    if (!flash_program_byte(
            reader, EEPROM_PROGRAM_MARKER, EEPROM_LAYOUT_MARKER_BASE)
        || !flash_program_range(
            reader, EEPROM_HEADER_BASE, eeprom_header,
            sizeof(eeprom_header)))
        return 0;
    return eeprom_layout_state(reader) == 2u;
}

static uint32_t eeprom_slot_empty(FlashReadFn reader,
                                  uint32_t logical_first,
                                  uint32_t generation);

static uint8_t eeprom_slot_seed(FlashReadFn reader,
                                uint32_t logical_first)
{
    return flash_read(reader, EEPROM_SEED_BASE + (logical_first >> 3));
}

static void eeprom_visible_slot(FlashReadFn reader, uint32_t logical_first,
                                uint8_t *destination,
                                uint32_t state)
{
    uint8_t physical[8];
    uint8_t seed;
    uint32_t generation;
    uint32_t index;
    flash_read_range(reader, logical_first, physical, sizeof(physical));
    seed = state == 2u ? eeprom_slot_seed(reader, logical_first) : 0xFFu;
    for (index = 0; index < 8u; ++index) {
        destination[index] = (uint8_t)~physical[7u - index]
            ^ (uint8_t)~seed;
    }
    if (state != 2u)
        return;
    for (generation = 0; generation < EEPROM_GENERATIONS; ++generation) {
        if (eeprom_slot_empty(reader, logical_first, generation))
            break;
        flash_read_range(reader,
                         EEPROM_DELTA_BASE
                             + generation * EEPROM_DELTA_SIZE + logical_first,
                         physical, sizeof(physical));
        for (index = 0; index < 8u; ++index) {
            uint8_t encoded = physical[7u - index];
            destination[index] ^= (uint8_t)~encoded;
        }
    }
}

static uint32_t eeprom_slot_empty(FlashReadFn reader,
                                  uint32_t logical_first,
                                  uint32_t generation)
{
    uint8_t physical[8];
    uint32_t index;
    flash_read_range(reader,
                     EEPROM_DELTA_BASE + generation * EEPROM_DELTA_SIZE
                         + logical_first,
                     physical, sizeof(physical));
    for (index = 0; index < 8u; ++index) {
        if (physical[index] != 0xFFu)
            return 0;
    }
    return 1;
}

static uint32_t eeprom_compact_sector(FlashReadFn reader,
                                      uint32_t logical_sector)
{
    uint32_t state = eeprom_layout_state(reader);
    uint32_t scratch = EEPROM_SCRATCH_BASE + logical_sector;
    uint32_t generation;
    uint32_t index;
    uint8_t visible[8];
    if (!direct_config_matches(SAVE_LAYOUT_EEPROM)
        || state != 2u || logical_sector >= EEPROM_LOGICAL_SIZE
        || (logical_sector & (SECTOR_SIZE - 1u)) != 0)
        return 0;
    if (!flash_erase_sector(reader, scratch))
        return 0;
    for (index = 0; index < SECTOR_SIZE; index += 8u) {
        uint8_t physical[8];
        uint32_t byte_index;
        uint8_t seed = eeprom_slot_seed(reader, logical_sector + index);
        eeprom_visible_slot(reader, logical_sector + index, visible, state);
        for (byte_index = 0; byte_index < 8u; ++byte_index)
            physical[7u - byte_index] = visible[byte_index] ^ seed;
        if (!flash_program_range(
                reader, scratch + index, physical, sizeof(physical)))
            return 0;
    }
    for (index = 0; index < SECTOR_SIZE; index += 8u) {
        uint8_t physical[8];
        uint32_t byte_index;
        uint8_t seed = eeprom_slot_seed(reader, logical_sector + index);
        eeprom_visible_slot(reader, logical_sector + index, visible, state);
        flash_read_range(reader, scratch + index, physical, sizeof(physical));
        for (byte_index = 0; byte_index < 8u; ++byte_index) {
            if ((physical[7u - byte_index] ^ seed)
                != visible[byte_index])
                return 0;
        }
    }
    if (!flash_erase_sector(reader, logical_sector)
        || !flash_copy(reader, logical_sector, scratch, SECTOR_SIZE))
        return 0;
    for (generation = 0; generation < EEPROM_GENERATIONS; ++generation) {
        if (!flash_erase_sector(reader, EEPROM_DELTA_BASE
                                + generation * EEPROM_DELTA_SIZE
                                + logical_sector))
            return 0;
    }
    return flash_erase_sector(reader, scratch);
}

static uint32_t eeprom_write_core(FlashReadFn reader, uint32_t logical_first,
                                  const uint8_t *source)
{
    uint8_t input[8];
    uint8_t old_value[8];
    uint8_t encoded[8];
    uint8_t physical[8];
    uint32_t generation;
    uint32_t state;
    uint32_t index;
    uint32_t changed = 0;
    uint32_t programmed = 1;
    if (!direct_config_matches(SAVE_LAYOUT_EEPROM)
        || !source
        || logical_first > EEPROM_LOGICAL_SIZE - 8u
        || (logical_first & 7u) != 0)
        return 0;
    copy_from_ram(input, source, sizeof(input));
    state = eeprom_layout_state(reader);
    if (state == 0u)
        return 0;
    if (state == 1u) {
        if (!eeprom_initialize(reader))
            return 0;
        state = 2u;
    }
    eeprom_visible_slot(reader, logical_first, old_value, state);
    for (index = 0; index < 8u; ++index) {
        if (old_value[index] != input[index])
            changed = 1;
    }
    if (!changed)
        return 1;
    /*
     * In v5 an untouched EEPROM dword is logical zero because both its
     * physical base and seed are erased: L = ~B XOR ~S.  One inverted seed
     * byte therefore represents any uniform non-zero first value without
     * touching the canonical base.  Compaction preserves the transform.
     */
    if (old_value[0] == 0u && input[0] != 0u
        && eeprom_slot_seed(reader, logical_first) == 0xFFu
        && eeprom_slot_empty(reader, logical_first, 0u)) {
        uint32_t uniform = 1u;
        for (index = 1; index < 8u; ++index) {
            if (old_value[index] != 0u || input[index] != input[0])
                uniform = 0u;
        }
        if (uniform) {
            if (!flash_program_byte(reader,
                    EEPROM_SEED_BASE + (logical_first >> 3),
                    (uint8_t)~input[0]))
                return 0;
            eeprom_visible_slot(reader, logical_first, old_value, state);
            for (index = 0; index < 8u; ++index) {
                if (old_value[index] != input[index])
                    return 0;
            }
            return 1;
        }
    }
    for (generation = 0; generation < EEPROM_GENERATIONS; ++generation) {
        if (eeprom_slot_empty(reader, logical_first, generation))
            break;
    }
    if (generation == EEPROM_GENERATIONS) {
        uint32_t base_reusable = 1u;

        /*
         * Each programmed zero in any physical layer XORs one visible bit.
         * Once the five delta slots are occupied, use still-erased bits in
         * the canonical base as one more in-place XOR layer before paying for
         * a full 4 KiB sector compaction.  This keeps the v5 layout and read
         * path unchanged.  A power cut during this optimization can expose a
         * partial new value; Direct saves intentionally do not promise
         * power-loss atomicity.
         */
        flash_read_range(reader, logical_first, physical, sizeof(physical));
        for (index = 0; index < 8u; ++index) {
            uint8_t toggle = old_value[index] ^ input[index];
            uint8_t stored = physical[7u - index];
            if ((stored & toggle) != toggle)
                base_reusable = 0u;
            physical[7u - index] = stored & (uint8_t)~toggle;
        }
        if (base_reusable) {
            if (!flash_program_range(
                    reader, logical_first, physical, sizeof(physical)))
                return 0;
            eeprom_visible_slot(reader, logical_first, old_value, state);
            for (index = 0; index < 8u; ++index) {
                if (old_value[index] != input[index])
                    return 0;
            }
            return 1;
        }
        {
            uint32_t sector = logical_first & ~(SECTOR_SIZE - 1u);
            if (!eeprom_compact_sector(reader, sector))
                return 0;
        }
        state = 2u;
        generation = 0;
        eeprom_visible_slot(reader, logical_first, old_value, state);
    }
    for (index = 0; index < 8u; ++index) {
        encoded[index] = (uint8_t)~(old_value[index] ^ input[index]);
        physical[7u - index] = encoded[index];
    }
    if (!flash_program_range(
            reader,
            EEPROM_DELTA_BASE + generation * EEPROM_DELTA_SIZE
                + logical_first,
            physical, sizeof(physical)))
        programmed = 0;
    flash_read_range(reader,
                     EEPROM_DELTA_BASE + generation * EEPROM_DELTA_SIZE
                         + logical_first,
                     physical, sizeof(physical));
    for (index = 0; index < 8u; ++index) {
        if (physical[7u - index] != encoded[index])
            programmed = 0;
    }
    eeprom_visible_slot(reader, logical_first, old_value, state);
    for (index = 0; index < 8u; ++index) {
        if (old_value[index] != input[index])
            programmed = 0;
    }
    return programmed;
}

static uint32_t eeprom_read_core(FlashReadFn reader, uint32_t logical_first,
                                 uint8_t *destination)
{
    uint32_t state;
    if (!direct_config_matches(SAVE_LAYOUT_EEPROM)
        || logical_first > EEPROM_LOGICAL_SIZE - 8u
        || (logical_first & 7u) != 0)
        return 0;
    state = eeprom_layout_state(reader);
    if (state == 0u)
        return 0;
    eeprom_visible_slot(reader, logical_first, destination, state);
    return 1;
}
#endif

static uint32_t write_sram_result(FlashReadFn reader,
                                  uint8_t *source, uint8_t *destination,
                                  uint32_t size)
{
    uint32_t first = (uintptr_t)destination & (SRAM_LOGICAL_SIZE - 1u);
#ifdef DIRECT_SNAPSHOT_BUILD
    if (!direct_config_matches(SAVE_LAYOUT_SRAM)
        || (source == (uint8_t *)0 && size != 0u)
        || first > SRAM_LOGICAL_SIZE
        || size > SRAM_LOGICAL_SIZE - first)
        return 0u;
    /* The commit already validates its source/provider relationship.  Route
     * it directly so the general non-final-write frame is not retained below
     * the game's public SRAM wrapper. */
    if (first == direct_snapshot_commit_first_config
        && size == direct_snapshot_commit_size_config)
        return snapshot_commit(reader, source);
    return snapshot_sram_write(reader, source, first, size);
#else
    return sram16_write_core(reader, source, first, size);
#endif
}

/* Nintendo SRAM libraries select the slowest Save-bus timing at every public
 * read, write, and verify entry and leave it selected on return.  Preserve
 * that ABI side effect even when a semantic wrapper combines WriteSram and
 * VerifySram into one Direct transaction. */
static void sram_apply_sdk_waitstate(void)
{
    REG_WAITCNT = (uint16_t)((REG_WAITCNT & 0xFFFCu) | 3u);
}

uint32_t write_sram_cached_patched(uint8_t *source, uint8_t *destination,
                                   uint32_t size, uint8_t *cache)
{
    FlashReaderStorage reader_storage;
    FlashReadFn reader;
    uint32_t result = size == 0u ? 0xFFFFFFFFu : 0u;
    (void)cache;
    sram_apply_sdk_waitstate();
    reader = flash_reader_on_stack(&reader_storage);
    (void)write_sram_result(reader, source, destination, size);
    if (size != 0u)
        result = source[size - 1u];
    return result;
}

NAKED uint32_t write_sram_patched(
    uint8_t *source __attribute__((unused)),
    uint8_t *destination __attribute__((unused)),
    uint32_t size __attribute__((unused)))
{
    __asm volatile(
        "mov r3, #0\n"
        "b write_sram_cached_patched\n");
}

/*
 * Some callers wrap the Nintendo WriteSram/VerifySram pair and expose only a
 * zero/-1 transaction result.  The patcher redirects such wrappers here only
 * after proving the argument flow and both return branches.  Every physical
 * program/erase operation is already polled and read back by the writer, so a
 * second decode of the complete logical range cannot add error coverage.
 */
uint32_t write_verify_sram_patched(uint8_t *destination, uint8_t *source,
                                   uint32_t size)
{
    FlashReaderStorage reader_storage;
    FlashReadFn reader;
    sram_apply_sdk_waitstate();
    reader = flash_reader_on_stack(&reader_storage);
    return write_sram_result(reader, source, destination, size)
        ? 0u : 0xFFFFFFFFu;
}

uint32_t read_sram_cached_patched(uint8_t *source, uint8_t *destination,
                                  uint32_t size, uint8_t *cache)
{
    FlashReaderStorage reader_storage;
    FlashReadFn reader;
    uint32_t first = (uintptr_t)source & (SRAM_LOGICAL_SIZE - 1u);
    uint32_t result = 0xFFFFFFFFu;
    (void)cache;
    sram_apply_sdk_waitstate();
#ifdef DIRECT_SNAPSHOT_BUILD
    reader = flash_reader_on_stack(&reader_storage);
#else
    reader = flash_byte_reader_on_stack(&reader_storage);
#endif
    if (!direct_config_matches(SAVE_LAYOUT_SRAM)
        || first > SRAM_LOGICAL_SIZE || size > SRAM_LOGICAL_SIZE - first)
        return result;
#ifdef DIRECT_SNAPSHOT_BUILD
    if (snapshot_sram_read(reader, first, destination, size) && size != 0u)
        result = destination[size - 1u];
#else
    {
        uint32_t marker;
        uint32_t state;
        if (size == 0u)
            return result;
        /*
         * Some reproduction save chips do not power up in array-read mode.
         * Normalize the mode before reading either the layout marker or data:
         * command modes can leave the marker visible while changing reads at
         * other addresses.
         */
        flash_cleanup();
        marker = flash_read(reader, SRAM_HEADER_BASE);
        state = sram16_state_from_first_byte(marker);
        if (state == 1u) {
            (void)sram_probe_fill_blank_zero(&reader_storage, first,
                                              destination, size);
            return destination[size - 1u];
        }
        if (state == 0u)
            return result;
        (void)flash_range_reader_on_stack(reader);
        if (sram16_layout_state(reader) == 2u
            && sram16_read_range(reader, first, destination, size)) {
            result = destination[size - 1u];
        }
    }
#endif
    return result;
}

NAKED uint32_t read_sram_patched(
    uint8_t *source __attribute__((unused)),
    uint8_t *destination __attribute__((unused)),
    uint32_t size __attribute__((unused)))
{
    __asm volatile(
        "mov r3, #0\n"
        "b read_sram_cached_patched\n");
}

/*
 * Some games combine the Nintendo SDK SRAM routines with small direct-read
 * helpers for stable metadata.  The patcher recognizes the helper by its
 * instruction structure and redirects it here, so the bytes pass through the
 * same logical FLASH layout as every other SRAM read.
 */
static uint32_t read_sram_triplet_core(uint16_t *metadata, uint32_t key,
                                       uint32_t unused, uint8_t *cache)
{
    uint8_t bytes[3];
    uint32_t first = key * 3u + 1u;
    (void)unused;
    bytes[0] = 0xFFu;
    bytes[1] = 0xFFu;
    bytes[2] = 0xFFu;
    if (!metadata || first > SRAM_LOGICAL_SIZE - sizeof(bytes))
        return 0xFF00u;
    (void)read_sram_cached_patched((uint8_t *)(SAVE_BASE + first), bytes,
                                   sizeof(bytes), cache);
    metadata[1] = (uint16_t)key;
    metadata[3] = bytes[0];
    metadata[2] = (uint16_t)(bytes[1] | ((uint16_t)bytes[2] << 8));
    return (uint32_t)bytes[2] << 8;
}

uint32_t read_sram_triplet_patched(uint16_t *metadata, uint32_t key,
                                   uint32_t unused)
{
    return read_sram_triplet_core(metadata, key, unused, (uint8_t *)0);
}

uint32_t read_sram_triplet_cached_patched(uint16_t *metadata, uint32_t key,
                                          uint32_t unused, uint8_t *cache)
{
    return read_sram_triplet_core(metadata, key, unused, cache);
}

uint8_t *verify_sram_cached_patched(uint8_t *source, uint8_t *target,
                                    uint32_t size, uint8_t *cache)
{
    FlashReaderStorage reader_storage;
    FlashReadFn reader;
#ifdef DIRECT_SNAPSHOT_BUILD
    uint8_t expected[FLASH_READ_CHUNK];
    uint8_t visible[FLASH_READ_CHUNK];
#else
    uint8_t visible[SRAM_VERIFY_CHUNK];
    uint32_t state;
#endif
    uint32_t first = (uintptr_t)target & (SRAM_LOGICAL_SIZE - 1u);
    uint32_t cursor;
    (void)cache;
    sram_apply_sdk_waitstate();
    reader = flash_reader_on_stack(&reader_storage);
    if (!direct_config_matches(SAVE_LAYOUT_SRAM) || (!source && size != 0)
        || first > SRAM_LOGICAL_SIZE || size > SRAM_LOGICAL_SIZE - first)
        return (uint8_t *)(SAVE_BASE + first);
#ifdef DIRECT_SNAPSHOT_BUILD
    /* Only analyzer-proven transaction-local probes may verify without
     * persistent readback.  Unknown non-provider ranges fail closed. */
    {
        SnapshotState transient_state;
        uint32_t index;
        if (snapshot_transient_source_matches(source, first, size)
            && snapshot_locate(reader, &transient_state)) {
            if (!transient_state.blank)
                return (uint8_t *)0;
            for (index = 0u; index < size; ++index) {
                if (source[index] != 0u)
                    return target + index;
            }
            return (uint8_t *)0;
        }
    }
#endif
#ifndef DIRECT_SNAPSHOT_BUILD
    state = sram16_layout_state(reader);
    if (state == 0u)
        return (uint8_t *)(SAVE_BASE + first);
    for (cursor = 0; cursor < size; cursor += sizeof(visible)) {
        uint32_t part = size - cursor < sizeof(visible)
            ? size - cursor : sizeof(visible);
        uint32_t chunk_left = SRAM_SECTOR_LOG_BLOCK_SIZE
            - ((first + cursor)
               & (SRAM_SECTOR_LOG_BLOCK_SIZE - 1u));
        uint32_t index;
        if (part > chunk_left)
            part = chunk_left;
        if (state == 1u) {
            for (index = 0u; index < part; ++index)
                visible[index] = 0u;
        } else if (!sram16_read_range(
                       reader, first + cursor, visible, part)) {
            return target + cursor;
        }
        for (index = 0; index < part; ++index) {
            if (source[cursor + index] != visible[index])
                return target + cursor + index;
        }
    }
#else
    for (cursor = 0; cursor < size; cursor += sizeof(visible)) {
        uint32_t part = size - cursor < sizeof(visible)
            ? size - cursor : sizeof(visible);
        uint32_t index;
        copy_from_ram(expected, source + cursor, part);
        if (!snapshot_visible_read(reader, source + cursor,
                                   first + cursor, visible, part))
            return target + cursor;
        for (index = 0; index < part; ++index) {
            if (expected[index] != visible[index])
                return target + cursor + index;
        }
    }
#endif
    return (uint8_t *)0;
}

NAKED uint8_t *verify_sram_patched(
    uint8_t *source __attribute__((unused)),
    uint8_t *target __attribute__((unused)),
    uint32_t size __attribute__((unused)))
{
    __asm volatile(
        "mov r3, #0\n"
        "b verify_sram_cached_patched\n");
}

uint8_t *verify_sram_fast_patched(uint8_t *source, uint8_t *target,
                                  uint32_t size)
{
    (void)source;
    (void)size;
    sram_apply_sdk_waitstate();
    return direct_config_matches(SAVE_LAYOUT_SRAM)
        ? (uint8_t *)0 : target;
}

#ifndef DIRECT_SRAM_ONLY_BUILD
static uint32_t write_eeprom_common(uint16_t address, uint8_t *source)
{
    FlashReaderStorage reader_storage;
    FlashReadFn reader = flash_reader_on_stack(&reader_storage);
    uint32_t success = eeprom_write_core(reader, (uint32_t)address << 3,
                                         source);
    return success ? 0u : 1u;
}

uint32_t write_eeprom_patched(uint16_t address, uint8_t *source)
{
    return write_eeprom_common(address, source);
}

uint32_t read_eeprom_patched(uint16_t address, uint8_t *destination)
{
    FlashReaderStorage reader_storage;
    FlashReadFn reader = flash_reader_on_stack(&reader_storage);
    uint32_t success = eeprom_read_core(reader, (uint32_t)address << 3,
                                        destination);
    return success ? 0u : 1u;
}

uint32_t verify_eeprom_patched(uint16_t address, uint8_t *source)
{
    FlashReaderStorage reader_storage;
    FlashReadFn reader = flash_reader_on_stack(&reader_storage);
    uint8_t expected[8];
    uint8_t visible[8];
    uint32_t index;
    if (!source)
        return 1;
    copy_from_ram(expected, source, sizeof(expected));
    if (!eeprom_read_core(reader, (uint32_t)address << 3, visible))
        return 1;
    for (index = 0; index < 8u; ++index) {
        if (visible[index] != expected[index])
            return 1;
    }
    return 0;
}

/* Keep this ABI-only wrapper after every established payload entry point. */
NAKED uint32_t write_eeprom_settled_patched(
    uint16_t address __attribute__((unused)),
    uint8_t *source __attribute__((unused)))
{
    __asm volatile(
        "push {r4, lr}\n"
        "bl write_eeprom_patched\n"
        "mov r4, #" STRINGIFY(EEPROM_RETURN_SETTLE_ITERATIONS) "\n"
        "1:\n"
        "nop\n"
        "sub r4, #1\n"
        "bne 1b\n"
        "pop {r4}\n"
        "pop {r1}\n"
        "bx r1\n");
}
#endif

asm(R"(
.section .direct_footer, "a", %progbits
.balign 4
.global direct_signature
.type direct_signature, %object
direct_signature:
)" DIRECT_SIGNATURE_ASM R"(
.size direct_signature, .-direct_signature
.balign 4
.text
)");
