#include <stdint.h>
#include "fake_rtc_menu.h"
#include "menu_assets_generated.h"

extern void rtc_state_write(uint32_t timestamp, uint32_t speed);
extern uint32_t rtc_state_read(uint32_t *timestamp_out, uint8_t *speed_out);
extern void rtc_state_read_runtime(uint32_t *timestamp_out, uint32_t *speed_out);
extern uint32_t rtc_state_is_initialized(void);

#ifndef FAKE_RTC_DEFAULT_TIMESTAMP
#define FAKE_RTC_DEFAULT_TIMESTAMP 0u
#endif

#ifndef FAKE_RTC_DEFAULT_SPEED
#define FAKE_RTC_DEFAULT_SPEED 0u
#endif

#define FAKE_RTC_TICK_SECONDS 1u
#define FAKE_RTC_STATUS_24H 0x40u
#define FAKE_RTC_MAX_TIMESTAMP 3155759999u /* 2099-12-31 23:59:59 */


#define REG_DISPCNT (*(volatile uint16_t*)0x04000000)
#define REG_VCOUNT   (*(volatile uint16_t*)0x04000006)
#define REG_KEYINPUT (*(volatile uint16_t*)0x04000130)
#define REG_SOUNDCNT_L (*(volatile uint16_t*)0x04000080)
#define REG_SOUNDCNT_H (*(volatile uint16_t*)0x04000082)
#define REG_DMA0CNT_H (*(volatile uint16_t*)0x040000BA)
#define REG_DMA1CNT_H (*(volatile uint16_t*)0x040000C6)
#define REG_DMA2CNT_H (*(volatile uint16_t*)0x040000D2)
#define REG_DMA3CNT_H (*(volatile uint16_t*)0x040000DE)
#define REG_TM0CNT_H (*(volatile uint16_t*)0x04000102)
#define REG_TM1CNT_H (*(volatile uint16_t*)0x04000106)

#define MEM_BG_PALETTE  ((volatile uint16_t*)0x05000000)
#define MEM_OBJ_PALETTE ((volatile uint16_t*)0x05000200)
#define MEM_VRAM_OBJ    ((volatile uint16_t*)0x06010000)
#define MEM_OAM         ((volatile ObjAttr*)0x07000000)

#define BG_MODE_MASK 0x0007
#define BG_MODE_BITMAP_FIRST 3u
#define BG_MODE_BITMAP_LAST 5u
#define MODE_0       0x0000
#define FORCED_BLANK 0x0080
#define OBJ_ON       0x1000
#define OBJ_1D_MAP   0x0040

#define KEY_A     0x0001
#define KEY_B     0x0002
#define KEY_SELECT 0x0004
#define KEY_START 0x0008
#define KEY_RIGHT 0x0010
#define KEY_LEFT  0x0020
#define KEY_UP    0x0040
#define KEY_DOWN  0x0080
#define KEY_R     0x0100
#define KEY_L     0x0200
#define KEY_MENU_COMBO (KEY_L | KEY_R | KEY_SELECT | KEY_START)

#define ATTR0_4BPP   0x0000
#define ATTR0_SQUARE 0x0000
#define ATTR0_WIDE   0x4000
#define ATTR0_TALL   0x8000
#define ATTR0_HIDE   0x0200
#define ATTR0_MODE_MASK 0x0300
#define ATTR0_COLOR_256 0x2000
#define ATTR1_SIZE_8 0x0000
#define ATTR1_SIZE_32x16 (2u << 14)
#define ATTR2_PRIO0  0x0000
#define ATTR2_PRIO3  0x0C00
#define ATTR2_PALBANK(n) (((n) & 15) << 12)
#define ATTR2_TILE_MASK 0x03FF

#define OBJ_TILE_COUNT 1024u
#define OBJ_TILE_BITMAP_MODE_MIN 512u
#define OBJ_TILE_HALFWORDS 16u
#define MENU_RUNTIME_OBJ_TILES_COUNT (MENU_RUNTIME_OBJ_TILES_SIZE_HALFWORDS / OBJ_TILE_HALFWORDS)
#define MENU_RUNTIME_OBJ_TILE_BASE_ALIGNMENT 8u
#define MENU_RUNTIME_OBJ_TILE_BASE_INVALID 0xFFFFu

#define SOUNDCNT_H_DMA_OUTPUT_MASK 0x3300u
#define SOUNDCNT_H_FIFO_RESET_MASK 0x8800u
#define SOUNDCNT_H_FIFO_A_OUTPUT_MASK 0x0300u
#define SOUNDCNT_H_FIFO_B_OUTPUT_MASK 0x3000u
#define SOUNDCNT_H_FIFO_A_TIMER_1 0x0400u
#define SOUNDCNT_H_FIFO_B_TIMER_1 0x4000u
#define DMA_ENABLE 0x8000u
#define DMA_START_TIMING_MASK 0x3000u
#define DMA_START_SPECIAL 0x3000u
#define TIMER_ENABLE 0x0080u

typedef struct {
    uint16_t attr0;
    uint16_t attr1;
    uint16_t attr2;
    uint16_t pad;
} ObjAttr;

typedef struct {
    uint16_t year;
    uint8_t month;
    uint8_t day;
    uint8_t hour;
    uint8_t minute;
    uint8_t second;
    uint8_t speed;
} RtcFields;


typedef struct {
    uint16_t soundcnt_l;
    uint16_t soundcnt_h;
} AudioBackup;

typedef struct {
    uint16_t dispcnt;
    uint16_t soundcnt_l;
    uint16_t soundcnt_h;
    uint16_t sound_timer_mask;
    uint16_t timer_cnt_h[2];
    uint16_t dma_cnt_h[4];
    uint16_t obj_palette[16];
    ObjAttr oam[128];
} RuntimeBackup;

static const uint8_t kDaysPerMonth[2][12] = {
    {31,28,31,30,31,30,31,31,30,31,30,31},
    {31,29,31,30,31,30,31,31,30,31,30,31},
};

static const uint16_t kDateCharX[18] = {
    20, 28, 36, 44,
    52,        /* first '/' 1px left */
    60, 68,
    76,        /* second '/' 1px left */
    85, 93,
    109, 116,
    125,
    132, 140,
    149,
    156, 164,
};
static const uint16_t kSpeedCharX[3] = {189, 197, 205};
static const uint16_t kFieldArrowX[7] = {48, 72, 97, 120, 144, 168, 209};
static const uint16_t kTextY = 79;
static const uint16_t kArrowY = 70;
static const uint8_t kObjWidthTiles[3][4] = {
    {1, 2, 4, 8},
    {2, 4, 4, 8},
    {1, 1, 2, 4},
};
static const uint8_t kObjHeightTiles[3][4] = {
    {1, 2, 4, 8},
    {1, 1, 2, 4},
    {2, 4, 4, 8},
};

static void wait_vblank(void);

enum {
    FIELD_YEAR = 0,
    FIELD_MONTH,
    FIELD_DAY,
    FIELD_HOUR,
    FIELD_MINUTE,
    FIELD_SECOND,
    FIELD_SPEED,
    FIELD_COUNT,
};

typedef struct {
    uint16_t top;
    uint16_t bottom;
} GlyphTilePair;

#define GLYPH_ARROW MENU_OBJ_TILE_ARROW

static inline uint8_t is_leap_year(uint16_t year) {
    return (uint8_t)((year & 3u) == 0u);
}

static uint8_t runtime_state_for_menu(uint32_t raw_timestamp, uint32_t raw_speed, uint32_t *timestamp_out, uint8_t *speed_out) {
    uint8_t speed = (uint8_t)(raw_speed & 0xFFu);
    uint32_t adjusted_timestamp;

    if (raw_timestamp <= FAKE_RTC_MAX_TIMESTAMP) {
        *timestamp_out = raw_timestamp;
        *speed_out = speed;
        return 1;
    }

    adjusted_timestamp = raw_timestamp + ((uint32_t)speed * FAKE_RTC_TICK_SECONDS);
    if (adjusted_timestamp < raw_timestamp && adjusted_timestamp <= FAKE_RTC_MAX_TIMESTAMP) {
        *timestamp_out = adjusted_timestamp;
        *speed_out = speed;
        return 1;
    }

    return 0;
}

static uint8_t days_in_month(uint16_t year, uint8_t month) {
    if (month < 1) month = 1;
    if (month > 12) month = 12;
    return kDaysPerMonth[is_leap_year(year)][month - 1];
}

static void clamp_day(RtcFields *f) {
    uint8_t dim = days_in_month(f->year, f->month);
    if (f->day < 1) f->day = dim;
    if (f->day > dim) f->day = dim;
}

static void mem_copy16(volatile uint16_t *dst, const uint16_t *src, uint32_t halfwords) {
    uint32_t i;
    for (i = 0; i < halfwords; ++i) dst[i] = src[i];
}

static void mem_copy16_from_volatile(uint16_t *dst, volatile const uint16_t *src, uint32_t halfwords) {
    uint32_t i;
    for (i = 0; i < halfwords; ++i) dst[i] = src[i];
}


static void mem_fill16(volatile uint16_t *dst, uint16_t value, uint32_t halfwords) {
    uint32_t i;
    for (i = 0; i < halfwords; ++i) dst[i] = value;
}

static void obj_set_hide(volatile ObjAttr *oam, uint32_t index) {
    oam[index].attr0 = ATTR0_HIDE;
    oam[index].attr1 = 0;
    oam[index].attr2 = 0;
    oam[index].pad = 0;
}


static void obj_set_8x8(volatile ObjAttr *oam, uint32_t index, uint16_t x, uint16_t y, uint16_t tile_index) {
    oam[index].attr0 = (uint16_t)((y & 0x00FFu) | ATTR0_4BPP | ATTR0_SQUARE);
    oam[index].attr1 = (uint16_t)((x & 0x01FFu) | ATTR1_SIZE_8);
    oam[index].attr2 = (uint16_t)((tile_index & 0x03FFu) | ATTR2_PRIO0 | ATTR2_PALBANK(0));
    oam[index].pad = 0;
}

static void obj_set_32x16_bg(volatile ObjAttr *oam, uint32_t index, uint16_t x, uint16_t y, uint16_t tile_index) {
    oam[index].attr0 = (uint16_t)((y & 0x00FFu) | ATTR0_4BPP | ATTR0_WIDE);
    oam[index].attr1 = (uint16_t)((x & 0x01FFu) | ATTR1_SIZE_32x16);
    oam[index].attr2 = (uint16_t)((tile_index & 0x03FFu) | ATTR2_PRIO0 | ATTR2_PALBANK(0));
    oam[index].pad = 0;
}

static uint32_t fields_to_timestamp(const RtcFields *f) {
    uint32_t days = 0;
    uint16_t year;
    uint8_t month;
    for (year = 2000; year < f->year; ++year) {
        days += (uint32_t)(is_leap_year(year) ? 366u : 365u);
    }
    for (month = 1; month < f->month; ++month) {
        days += (uint32_t)days_in_month(f->year, month);
    }
    days += (uint32_t)(f->day - 1u);
    return (((days * 24u + f->hour) * 60u + f->minute) * 60u + f->second);
}

static void timestamp_to_fields(uint32_t timestamp, uint8_t speed, RtcFields *out) {
    uint32_t days = timestamp / 86400u;
    uint32_t rem = timestamp % 86400u;
    uint16_t year = 2000;
    uint8_t month = 1;

    while (1) {
        uint32_t dy = is_leap_year(year) ? 366u : 365u;
        if (days < dy) break;
        days -= dy;
        ++year;
        if (year > 2099) {
            year = 2099;
            days = 364;
            break;
        }
    }
    while (1) {
        uint8_t dm = days_in_month(year, month);
        if (days < dm) break;
        days -= dm;
        ++month;
    }

    out->year = year;
    out->month = month;
    out->day = (uint8_t)(days + 1u);
    out->hour = (uint8_t)(rem / 3600u);
    rem %= 3600u;
    out->minute = (uint8_t)(rem / 60u);
    out->second = (uint8_t)(rem % 60u);
    out->speed = speed;
}

static GlyphTilePair glyph_pair_for_char(char c) {
    switch (c) {
        case '0': return (GlyphTilePair){MENU_OBJ_TILE_0_TOP, MENU_OBJ_TILE_0_BOTTOM};
        case '1': return (GlyphTilePair){MENU_OBJ_TILE_1_TOP, MENU_OBJ_TILE_1_BOTTOM};
        case '2': return (GlyphTilePair){MENU_OBJ_TILE_2_TOP, MENU_OBJ_TILE_2_BOTTOM};
        case '3': return (GlyphTilePair){MENU_OBJ_TILE_3_TOP, MENU_OBJ_TILE_3_BOTTOM};
        case '4': return (GlyphTilePair){MENU_OBJ_TILE_4_TOP, MENU_OBJ_TILE_4_BOTTOM};
        case '5': return (GlyphTilePair){MENU_OBJ_TILE_5_TOP, MENU_OBJ_TILE_5_BOTTOM};
        case '6': return (GlyphTilePair){MENU_OBJ_TILE_6_TOP, MENU_OBJ_TILE_6_BOTTOM};
        case '7': return (GlyphTilePair){MENU_OBJ_TILE_7_TOP, MENU_OBJ_TILE_7_BOTTOM};
        case '8': return (GlyphTilePair){MENU_OBJ_TILE_8_TOP, MENU_OBJ_TILE_8_BOTTOM};
        case '9': return (GlyphTilePair){MENU_OBJ_TILE_9_TOP, MENU_OBJ_TILE_9_BOTTOM};
        case '/': return (GlyphTilePair){MENU_OBJ_TILE_SLASH_TOP, MENU_OBJ_TILE_SLASH_BOTTOM};
        case ':': return (GlyphTilePair){MENU_OBJ_TILE_COLON_TOP, MENU_OBJ_TILE_COLON_BOTTOM};
        case '-': return (GlyphTilePair){MENU_OBJ_TILE_DASH_TOP, MENU_OBJ_TILE_DASH_BOTTOM};
        case 'x':
        case 'X': return (GlyphTilePair){MENU_OBJ_TILE_X_TOP, MENU_OBJ_TILE_X_BOTTOM};
        default: return (GlyphTilePair){MENU_OBJ_TILE_DASH_TOP, MENU_OBJ_TILE_DASH_BOTTOM};
    }
}

static void draw_glyph(volatile ObjAttr *oam, uint16_t *sprite_index, uint16_t x, uint16_t y, uint16_t tile_base, char c) {
    GlyphTilePair pair = glyph_pair_for_char(c);
    if (pair.top != MENU_OBJ_TILE_NONE) {
        obj_set_8x8(oam, (*sprite_index)++, x, y, (uint16_t)(tile_base + pair.top));
    }
    if (pair.bottom != MENU_OBJ_TILE_NONE) {
        obj_set_8x8(oam, (*sprite_index)++, x, (uint16_t)(y + 8u), (uint16_t)(tile_base + pair.bottom));
    }
}

static void audio_backup_and_mute(AudioBackup *backup) {
    uint16_t soundcnt_h = (uint16_t)(REG_SOUNDCNT_H & ~SOUNDCNT_H_FIFO_RESET_MASK);
    backup->soundcnt_l = REG_SOUNDCNT_L;
    backup->soundcnt_h = soundcnt_h;
    REG_SOUNDCNT_H = (uint16_t)(soundcnt_h & ~SOUNDCNT_H_DMA_OUTPUT_MASK);
    REG_SOUNDCNT_L = 0;
}

static void audio_restore(const AudioBackup *backup) {
    REG_SOUNDCNT_H = backup->soundcnt_h;
    REG_SOUNDCNT_L = backup->soundcnt_l;
}

static void oam_backup(ObjAttr *dst) {
    uint32_t i;
    for (i = 0; i < 128u; ++i) {
        dst[i].attr0 = MEM_OAM[i].attr0;
        dst[i].attr1 = MEM_OAM[i].attr1;
        dst[i].attr2 = MEM_OAM[i].attr2;
        dst[i].pad = MEM_OAM[i].pad;
    }
}

static void oam_restore(const ObjAttr *src) {
    uint32_t i;
    for (i = 0; i < 128u; ++i) {
        MEM_OAM[i].attr0 = src[i].attr0;
        MEM_OAM[i].attr1 = src[i].attr1;
        MEM_OAM[i].attr2 = src[i].attr2;
        MEM_OAM[i].pad = src[i].pad;
    }
}

static uint8_t obj_range_overlaps(uint16_t start_a, uint16_t count_a, uint16_t start_b, uint16_t count_b) {
    uint32_t end_a = (uint32_t)start_a + count_a;
    uint32_t end_b = (uint32_t)start_b + count_b;
    return (uint8_t)(start_a < end_b && start_b < end_a);
}

static uint16_t obj_tile_span(const ObjAttr *obj, uint16_t dispcnt) {
    uint16_t attr0 = obj->attr0;
    uint16_t attr1 = obj->attr1;
    uint16_t shape = (uint16_t)(attr0 >> 14);
    uint16_t size = (uint16_t)(attr1 >> 14);
    uint16_t width_tiles;
    uint16_t height_tiles;
    uint16_t depth = (attr0 & ATTR0_COLOR_256) ? 2u : 1u;

    if (shape >= 3u) return 0;
    width_tiles = kObjWidthTiles[shape][size];
    height_tiles = kObjHeightTiles[shape][size];

    if (dispcnt & OBJ_1D_MAP) {
        return (uint16_t)(width_tiles * height_tiles * depth);
    }

    return (uint16_t)(((height_tiles - 1u) * 32u) + (width_tiles * depth));
}

static uint8_t runtime_tile_window_overlaps_oam(const RuntimeBackup *backup, uint16_t tile_base) {
    uint32_t i;
    uint16_t tile_count = (uint16_t)MENU_RUNTIME_OBJ_TILES_COUNT;
    for (i = 0; i < 128u; ++i) {
        uint16_t attr0 = backup->oam[i].attr0;
        uint16_t obj_tile;
        uint16_t obj_span;

        if ((attr0 & ATTR0_MODE_MASK) == ATTR0_HIDE) continue;

        obj_tile = (uint16_t)(backup->oam[i].attr2 & ATTR2_TILE_MASK);
        obj_span = obj_tile_span(&backup->oam[i], backup->dispcnt);
        if (obj_span == 0) continue;
        if (obj_range_overlaps(tile_base, tile_count, obj_tile, obj_span)) return 1;
    }
    return 0;
}

static uint8_t obj_vram_window_is_zero(uint16_t tile_base) {
    volatile const uint16_t *src = MEM_VRAM_OBJ + ((uint32_t)tile_base * OBJ_TILE_HALFWORDS);
    uint32_t i;
    for (i = 0; i < MENU_RUNTIME_OBJ_TILES_SIZE_HALFWORDS; ++i) {
        if (src[i] != 0) return 0;
    }
    return 1;
}

static uint16_t runtime_obj_tile_min_base(uint16_t dispcnt) {
    uint16_t mode = (uint16_t)(dispcnt & BG_MODE_MASK);
    if (mode >= BG_MODE_BITMAP_FIRST && mode <= BG_MODE_BITMAP_LAST) return OBJ_TILE_BITMAP_MODE_MIN;
    return 0;
}

static uint16_t select_runtime_obj_tile_base(const RuntimeBackup *backup) {
    uint16_t tile_count = (uint16_t)MENU_RUNTIME_OBJ_TILES_COUNT;
    uint16_t align = MENU_RUNTIME_OBJ_TILE_BASE_ALIGNMENT;
    uint16_t min_base = runtime_obj_tile_min_base(backup->dispcnt);
    uint16_t max_base;
    uint16_t tile_base;

    if (tile_count > (uint16_t)(OBJ_TILE_COUNT - min_base)) return MENU_RUNTIME_OBJ_TILE_BASE_INVALID;

    max_base = (uint16_t)(OBJ_TILE_COUNT - tile_count);
    max_base = (uint16_t)(max_base & (uint16_t)~(align - 1u));
    tile_base = max_base;

    for (;;) {
        if (
            !runtime_tile_window_overlaps_oam(backup, tile_base)
            && obj_vram_window_is_zero(tile_base)
        ) {
            return tile_base;
        }
        if ((uint16_t)(tile_base - min_base) < align) break;
        tile_base = (uint16_t)(tile_base - align);
    }

    return MENU_RUNTIME_OBJ_TILE_BASE_INVALID;
}

static uint8_t is_direct_sound_dma(uint32_t channel, uint16_t cnt_h) {
    return (uint8_t)(
        (channel == 1u || channel == 2u)
        && (cnt_h & DMA_ENABLE)
        && ((cnt_h & DMA_START_TIMING_MASK) == DMA_START_SPECIAL)
    );
}

static uint16_t direct_sound_timer_mask(uint16_t soundcnt_h) {
    uint16_t mask = 0;

    if (soundcnt_h & SOUNDCNT_H_FIFO_A_OUTPUT_MASK) {
        mask |= (soundcnt_h & SOUNDCNT_H_FIFO_A_TIMER_1) ? 2u : 1u;
    }
    if (soundcnt_h & SOUNDCNT_H_FIFO_B_OUTPUT_MASK) {
        mask |= (soundcnt_h & SOUNDCNT_H_FIFO_B_TIMER_1) ? 2u : 1u;
    }

    return mask;
}

static void runtime_backup_and_pause(RuntimeBackup *backup) {
    backup->dispcnt = REG_DISPCNT;
    backup->soundcnt_l = REG_SOUNDCNT_L;
    backup->soundcnt_h = (uint16_t)(REG_SOUNDCNT_H & ~SOUNDCNT_H_FIFO_RESET_MASK);
    backup->sound_timer_mask = direct_sound_timer_mask(backup->soundcnt_h);
    backup->timer_cnt_h[0] = REG_TM0CNT_H;
    backup->timer_cnt_h[1] = REG_TM1CNT_H;
    backup->dma_cnt_h[0] = REG_DMA0CNT_H;
    backup->dma_cnt_h[1] = REG_DMA1CNT_H;
    backup->dma_cnt_h[2] = REG_DMA2CNT_H;
    backup->dma_cnt_h[3] = REG_DMA3CNT_H;

    REG_SOUNDCNT_H = (uint16_t)(backup->soundcnt_h & ~SOUNDCNT_H_DMA_OUTPUT_MASK);
    REG_SOUNDCNT_L = 0;
    if (backup->sound_timer_mask & 1u) REG_TM0CNT_H = (uint16_t)(backup->timer_cnt_h[0] & ~TIMER_ENABLE);
    if (backup->sound_timer_mask & 2u) REG_TM1CNT_H = (uint16_t)(backup->timer_cnt_h[1] & ~TIMER_ENABLE);

    REG_DMA0CNT_H = 0;
    if (!is_direct_sound_dma(1u, backup->dma_cnt_h[1])) REG_DMA1CNT_H = 0;
    if (!is_direct_sound_dma(2u, backup->dma_cnt_h[2])) REG_DMA2CNT_H = 0;
    REG_DMA3CNT_H = 0;

    wait_vblank();
    mem_copy16_from_volatile(backup->obj_palette, MEM_OBJ_PALETTE, 16);
    oam_backup(backup->oam);
}

static void runtime_restore(const RuntimeBackup *backup, uint16_t tile_base) {
    wait_vblank();
    if (tile_base != MENU_RUNTIME_OBJ_TILE_BASE_INVALID) {
        mem_fill16(MEM_VRAM_OBJ + ((uint32_t)tile_base * OBJ_TILE_HALFWORDS), 0, MENU_RUNTIME_OBJ_TILES_SIZE_HALFWORDS);
    }
    mem_copy16(MEM_OBJ_PALETTE, backup->obj_palette, 16);
    oam_restore(backup->oam);

    REG_DMA0CNT_H = backup->dma_cnt_h[0];
    if (!is_direct_sound_dma(1u, backup->dma_cnt_h[1])) REG_DMA1CNT_H = backup->dma_cnt_h[1];
    if (!is_direct_sound_dma(2u, backup->dma_cnt_h[2])) REG_DMA2CNT_H = backup->dma_cnt_h[2];
    REG_DMA3CNT_H = backup->dma_cnt_h[3];

    if (backup->sound_timer_mask & 1u) REG_TM0CNT_H = backup->timer_cnt_h[0];
    if (backup->sound_timer_mask & 2u) REG_TM1CNT_H = backup->timer_cnt_h[1];
    REG_SOUNDCNT_H = backup->soundcnt_h;
    REG_SOUNDCNT_L = backup->soundcnt_l;
    REG_DISPCNT = backup->dispcnt;
}

static uint16_t runtime_menu_dispcnt(uint16_t game_dispcnt) {
    return (uint16_t)((game_dispcnt | OBJ_ON | OBJ_1D_MAP) & (uint16_t)~FORCED_BLANK);
}

static uint16_t draw_runtime_background(uint16_t tile_base, uint16_t sprite_index) {
    uint32_t row;
    uint32_t col;

    mem_copy16(MEM_OBJ_PALETTE, menu_obj_palette, 16);
    mem_copy16(
        MEM_VRAM_OBJ + ((uint32_t)tile_base * OBJ_TILE_HALFWORDS),
        menu_obj_tiles,
        MENU_OBJ_TILES_SIZE_HALFWORDS
    );
    mem_copy16(
        MEM_VRAM_OBJ + ((uint32_t)tile_base * OBJ_TILE_HALFWORDS) + MENU_OBJ_TILES_SIZE_HALFWORDS,
        menu_runtime_bg_tiles,
        MENU_RUNTIME_BG_TILES_SIZE_HALFWORDS
    );

    for (row = 0; row < MENU_RUNTIME_BG_ROWS; ++row) {
        for (col = 0; col < MENU_RUNTIME_BG_COLS; ++col) {
            uint32_t map_index = row * MENU_RUNTIME_BG_COLS + col;
            uint16_t tile_start = menu_runtime_bg_tile_starts[map_index];
            if (tile_start == MENU_OBJ_TILE_NONE) continue;
            obj_set_32x16_bg(
                MEM_OAM,
                sprite_index++,
                (uint16_t)(col * 32u),
                (uint16_t)(row * 16u),
                (uint16_t)(tile_base + tile_start)
            );
        }
    }

    return sprite_index;
}

static void clear_oam(void) {
    uint32_t i;
    for (i = 0; i < 128u; ++i) obj_set_hide(MEM_OAM, i);
}

static void draw_background(void) {
    REG_DISPCNT = FORCED_BLANK;
    clear_oam();
    mem_copy16(MEM_BG_PALETTE, menu_obj_palette, 16);
    draw_runtime_background(0, MENU_RUNTIME_TEXT_SPRITES_RESERVED);
    REG_DISPCNT = (uint16_t)(MODE_0 | OBJ_ON | OBJ_1D_MAP);
}

static void wait_vblank(void) {
    while (REG_VCOUNT >= 160u) { }
    while (REG_VCOUNT < 160u) { }
}

static uint16_t read_keys(void) {
    return (uint16_t)(~REG_KEYINPUT) & 0x03FFu;
}

static void wait_keys_release(uint16_t key_mask) {
    while (read_keys() & key_mask) {
        wait_vblank();
    }
}

static void wait_hotkey_release(void) {
    while ((read_keys() & KEY_MENU_COMBO) == KEY_MENU_COMBO) {
        wait_vblank();
    }
}

static void render_menu_from_index(const RtcFields *f, uint8_t selected_field, uint16_t sprite_index, uint16_t tile_base, uint16_t sprite_limit) {
    volatile ObjAttr *oam = MEM_OAM;
    char datetime_chars[18];
    uint32_t i;
    datetime_chars[0]  = (char)('0' + ((f->year / 1000u) % 10u));
    datetime_chars[1]  = (char)('0' + ((f->year / 100u) % 10u));
    datetime_chars[2]  = (char)('0' + ((f->year / 10u) % 10u));
    datetime_chars[3]  = (char)('0' + (f->year % 10u));
    datetime_chars[4]  = '/';
    datetime_chars[5]  = (char)('0' + (f->month / 10u));
    datetime_chars[6]  = (char)('0' + (f->month % 10u));
    datetime_chars[7]  = '/';
    datetime_chars[8]  = (char)('0' + (f->day / 10u));
    datetime_chars[9]  = (char)('0' + (f->day % 10u));
    datetime_chars[10] = (char)('0' + (f->hour / 10u));
    datetime_chars[11] = (char)('0' + (f->hour % 10u));
    datetime_chars[12] = ':';
    datetime_chars[13] = (char)('0' + (f->minute / 10u));
    datetime_chars[14] = (char)('0' + (f->minute % 10u));
    datetime_chars[15] = ':';
    datetime_chars[16] = (char)('0' + (f->second / 10u));
    datetime_chars[17] = (char)('0' + (f->second % 10u));

    for (i = 0; i < 18u; ++i) {
        draw_glyph(oam, &sprite_index, kDateCharX[i], kTextY, tile_base, datetime_chars[i]);
    }
    {
        uint8_t speed = f->speed;
        uint8_t hundreds = (uint8_t)(speed / 100u);
        uint8_t tens = (uint8_t)((speed / 10u) % 10u);
        uint8_t ones = (uint8_t)(speed % 10u);
        uint8_t digit_start = 2u;

        if (hundreds != 0u) {
            digit_start = 0u;
        } else if (tens != 0u) {
            digit_start = 1u;
        }

        if (digit_start == 0u) {
            draw_glyph(oam, &sprite_index, kSpeedCharX[0], kTextY, tile_base, (char)('0' + hundreds));
        }
        if (digit_start <= 1u) {
            draw_glyph(oam, &sprite_index, kSpeedCharX[1], kTextY, tile_base, (char)('0' + tens));
        }
        draw_glyph(oam, &sprite_index, kSpeedCharX[2], kTextY, tile_base, (char)('0' + ones));

        draw_glyph(oam, &sprite_index, 213u, kTextY, tile_base, 'x');
    }
    obj_set_8x8(oam, sprite_index++, (uint16_t)(kFieldArrowX[selected_field] - 4u), kArrowY, (uint16_t)(tile_base + GLYPH_ARROW));
    for (; sprite_index < sprite_limit; ++sprite_index) obj_set_hide(oam, sprite_index);
}

static void render_menu(const RtcFields *f, uint8_t selected_field) {
    render_menu_from_index(f, selected_field, 0, 0, 128u);
}

static void apply_delta(RtcFields *f, uint8_t selected_field, int delta) {
    switch (selected_field) {
        case FIELD_YEAR:
            if (delta > 0) {
                f->year = (uint16_t)(f->year >= 2099u ? 2000u : f->year + 1u);
            } else {
                f->year = (uint16_t)(f->year <= 2000u ? 2099u : f->year - 1u);
            }
            clamp_day(f);
            break;
        case FIELD_MONTH:
            if (delta > 0) f->month = (uint8_t)(f->month >= 12u ? 1u : f->month + 1u);
            else f->month = (uint8_t)(f->month <= 1u ? 12u : f->month - 1u);
            clamp_day(f);
            break;
        case FIELD_DAY: {
            uint8_t dim = days_in_month(f->year, f->month);
            if (delta > 0) f->day = (uint8_t)(f->day >= dim ? 1u : f->day + 1u);
            else f->day = (uint8_t)(f->day <= 1u ? dim : f->day - 1u);
            break;
        }
        case FIELD_HOUR:
            if (delta > 0) f->hour = (uint8_t)(f->hour >= 23u ? 0u : f->hour + 1u);
            else f->hour = (uint8_t)(f->hour <= 0u ? 23u : f->hour - 1u);
            break;
        case FIELD_MINUTE:
            if (delta > 0) f->minute = (uint8_t)(f->minute >= 59u ? 0u : f->minute + 1u);
            else f->minute = (uint8_t)(f->minute <= 0u ? 59u : f->minute - 1u);
            break;
        case FIELD_SECOND:
            if (delta > 0) f->second = (uint8_t)(f->second >= 59u ? 0u : f->second + 1u);
            else f->second = (uint8_t)(f->second <= 0u ? 59u : f->second - 1u);
            break;
        case FIELD_SPEED:
            if (delta > 0) f->speed = (uint8_t)(f->speed == 255u ? 0u : f->speed + 1u);
            else f->speed = (uint8_t)(f->speed == 0u ? 255u : f->speed - 1u);
            break;
        default:
            break;
    }
}

static void load_menu_fields(RtcFields *fields) {
    uint32_t menu_timestamp = FAKE_RTC_DEFAULT_TIMESTAMP;
    uint8_t menu_speed = (uint8_t)(FAKE_RTC_DEFAULT_SPEED & 0xFFu);
    uint32_t runtime_timestamp = 0;
    uint32_t runtime_speed = 0xFFFFFFFFu;

    if (rtc_state_is_initialized()) {
        rtc_state_read_runtime(&runtime_timestamp, &runtime_speed);
        runtime_state_for_menu(runtime_timestamp, runtime_speed, &menu_timestamp, &menu_speed);
    }

    timestamp_to_fields(menu_timestamp, menu_speed, fields);
}

static void fake_rtc_menu_loop(uint16_t first_menu_sprite, uint8_t wait_for_hotkey_release, uint16_t tile_base, uint16_t sprite_limit, uint8_t initial_rendered, RtcFields fields) {
    uint16_t prev_keys = 0;
    uint16_t hold_up = 0;
    uint16_t hold_down = 0;
    uint32_t menu_timestamp = FAKE_RTC_DEFAULT_TIMESTAMP;
    uint8_t menu_speed = (uint8_t)(FAKE_RTC_DEFAULT_SPEED & 0xFFu);
    uint8_t selected = 0;

    if (!initial_rendered) render_menu_from_index(&fields, selected, first_menu_sprite, tile_base, sprite_limit);
    if (wait_for_hotkey_release) wait_hotkey_release();

    for (;;) {
        uint16_t keys;
        wait_vblank();
        keys = read_keys();

        if ((keys & KEY_LEFT) && !(prev_keys & KEY_LEFT)) {
            selected = (uint8_t)((selected == 0u) ? (FIELD_COUNT - 1u) : (selected - 1u));
        }
        if ((keys & KEY_RIGHT) && !(prev_keys & KEY_RIGHT)) {
            selected = (uint8_t)((selected + 1u) % FIELD_COUNT);
        }
        if ((keys & KEY_UP) && !(prev_keys & KEY_UP)) {
            apply_delta(&fields, selected, +1);
            hold_up = 0;
        } else if (keys & KEY_UP) {
            hold_up++;
            if (hold_up > 10u) apply_delta(&fields, selected, +1);
        } else {
            hold_up = 0;
        }

        if ((keys & KEY_DOWN) && !(prev_keys & KEY_DOWN)) {
            apply_delta(&fields, selected, -1);
            hold_down = 0;
        } else if (keys & KEY_DOWN) {
            hold_down++;
            if (hold_down > 10u) apply_delta(&fields, selected, -1);
        } else {
            hold_down = 0;
        }

        render_menu_from_index(&fields, selected, first_menu_sprite, tile_base, sprite_limit);

        if ((keys & KEY_A) && !(prev_keys & KEY_A)) {
            menu_speed = (uint8_t)(fields.speed & 0xFFu);
            menu_timestamp = fields_to_timestamp(&fields);
            rtc_state_write(
                menu_timestamp - ((uint32_t)menu_speed * FAKE_RTC_TICK_SECONDS),
                menu_speed
            );
            wait_keys_release(KEY_A);
            break;
        }

        prev_keys = keys;
    }
}

void fake_rtc_menu_run(void) {
    AudioBackup audio_backup;
    RtcFields fields;

    load_menu_fields(&fields);
    audio_backup_and_mute(&audio_backup);
    draw_background();
    fake_rtc_menu_loop(0, 0, 0, MENU_RUNTIME_TEXT_SPRITES_RESERVED, 0, fields);
    audio_restore(&audio_backup);
}

void fake_rtc_menu_run_runtime(void) {
    RuntimeBackup backup;
    RtcFields fields;
    uint16_t tile_base;

    load_menu_fields(&fields);
    runtime_backup_and_pause(&backup);
    tile_base = select_runtime_obj_tile_base(&backup);
    if (tile_base == MENU_RUNTIME_OBJ_TILE_BASE_INVALID) {
        runtime_restore(&backup, tile_base);
        return;
    }
    wait_vblank();
    draw_runtime_background(tile_base, MENU_RUNTIME_TEXT_SPRITES_RESERVED);
    render_menu_from_index(&fields, 0, 0, tile_base, MENU_RUNTIME_TEXT_SPRITES_RESERVED);
    REG_DISPCNT = runtime_menu_dispcnt(backup.dispcnt);
    fake_rtc_menu_loop(0, 1, tile_base, MENU_RUNTIME_TEXT_SPRITES_RESERVED, 1, fields);
    runtime_restore(&backup, tile_base);
}
