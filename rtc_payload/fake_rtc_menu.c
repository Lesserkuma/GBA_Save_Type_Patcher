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
#define REG_BG0CNT   (*(volatile uint16_t*)0x04000008)
#define REG_BG0HOFS  (*(volatile uint16_t*)0x04000010)
#define REG_BG0VOFS  (*(volatile uint16_t*)0x04000012)
#define REG_KEYINPUT (*(volatile uint16_t*)0x04000130)
#define REG_SOUNDCNT_L (*(volatile uint16_t*)0x04000080)
#define REG_SOUNDCNT_H (*(volatile uint16_t*)0x04000082)

#define MEM_BG_PALETTE  ((volatile uint16_t*)0x05000000)
#define MEM_OBJ_PALETTE ((volatile uint16_t*)0x05000200)
#define MEM_VRAM_BG     ((volatile uint16_t*)0x06000000)
#define MEM_VRAM_OBJ    ((volatile uint16_t*)0x06010000)
#define MEM_OAM         ((volatile ObjAttr*)0x07000000)

#define MODE_0       0x0000
#define FORCED_BLANK 0x0080
#define BG0_ON       0x0100
#define OBJ_ON       0x1000
#define OBJ_1D_MAP   0x0040

#define BG_COLOR_16     0x0000
#define BG_CHAR_BASE(n) (((n) & 3) << 2)
#define BG_SCREEN_BASE(n) (((n) & 31) << 8)
#define BG_SIZE_0 0x0000
#define BG_PRIORITY_0 0x0000
#define MENU_BG_SCREENBLOCK 28u

#define KEY_A     0x0001
#define KEY_B     0x0002
#define KEY_SELECT 0x0004
#define KEY_START 0x0008
#define KEY_RIGHT 0x0010
#define KEY_LEFT  0x0020
#define KEY_UP    0x0040
#define KEY_DOWN  0x0080

#define ATTR0_4BPP   0x0000
#define ATTR0_SQUARE 0x0000
#define ATTR0_TALL   0x8000
#define ATTR0_HIDE   0x0200
#define ATTR1_SIZE_8 0x0000
#define ATTR2_PRIO0  0x0000
#define ATTR2_PALBANK(n) (((n) & 15) << 12)

#define SOUNDCNT_H_DMA_OUTPUT_MASK 0x3300u
#define SOUNDCNT_H_FIFO_RESET_MASK 0x8800u

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

static void draw_glyph(volatile ObjAttr *oam, uint16_t *sprite_index, uint16_t x, uint16_t y, char c) {
    GlyphTilePair pair = glyph_pair_for_char(c);
    if (pair.top != MENU_OBJ_TILE_NONE) {
        obj_set_8x8(oam, (*sprite_index)++, x, y, pair.top);
    }
    if (pair.bottom != MENU_OBJ_TILE_NONE) {
        obj_set_8x8(oam, (*sprite_index)++, x, (uint16_t)(y + 8u), pair.bottom);
    }
}

static void copy_bg_map_active(void) {
    volatile uint16_t *screen = MEM_VRAM_BG + (MENU_BG_SCREENBLOCK * 2048u / 2u);
    uint32_t y;
    mem_fill16(screen, MENU_BG_BLANK_TILE_INDEX, 32u * 32u);
    for (y = 0; y < MENU_BG_MAP_ACTIVE_H; ++y) {
        mem_copy16(
            screen + ((MENU_BG_MAP_ACTIVE_Y + y) * 32u) + MENU_BG_MAP_ACTIVE_X,
            &menu_bg_map_active[y * MENU_BG_MAP_ACTIVE_W],
            MENU_BG_MAP_ACTIVE_W
        );
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

static void draw_background(void) {
    /* Force blank while touching VRAM/palette/OAM, and reset scroll so the
       tiled background matches the mockup even if the game had BG0 scrolled. */
    REG_DISPCNT = FORCED_BLANK;
    REG_BG0HOFS = 0;
    REG_BG0VOFS = 0;
    mem_copy16(MEM_BG_PALETTE, menu_bg_palette, 16);
    mem_copy16(MEM_OBJ_PALETTE, menu_obj_palette, 16);
    mem_copy16(MEM_VRAM_BG, (const uint16_t*)menu_bg_tiles, MENU_BG_TILES_SIZE_HALFWORDS);
    copy_bg_map_active();
    mem_copy16(MEM_VRAM_OBJ, (const uint16_t*)menu_obj_tiles, MENU_OBJ_TILES_SIZE_HALFWORDS);
    REG_BG0CNT = (uint16_t)(BG_PRIORITY_0 | BG_CHAR_BASE(0) | BG_SCREEN_BASE(MENU_BG_SCREENBLOCK) | BG_COLOR_16 | BG_SIZE_0);
    REG_DISPCNT = (uint16_t)(MODE_0 | BG0_ON | OBJ_ON | OBJ_1D_MAP);
}

static void clear_oam(void) {
    uint32_t i;
    for (i = 0; i < 128u; ++i) obj_set_hide(MEM_OAM, i);
}

static void wait_vblank(void) {
    while (REG_VCOUNT >= 160u) { }
    while (REG_VCOUNT < 160u) { }
}

static uint16_t read_keys(void) {
    return (uint16_t)(~REG_KEYINPUT) & 0x03FFu;
}

static void render_menu(const RtcFields *f, uint8_t selected_field) {
    volatile ObjAttr *oam = MEM_OAM;
    char datetime_chars[18];
    uint32_t i;
    uint16_t sprite_index = 0;
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
        draw_glyph(oam, &sprite_index, kDateCharX[i], kTextY, datetime_chars[i]);
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
            draw_glyph(oam, &sprite_index, kSpeedCharX[0], kTextY, (char)('0' + hundreds));
        }
        if (digit_start <= 1u) {
            draw_glyph(oam, &sprite_index, kSpeedCharX[1], kTextY, (char)('0' + tens));
        }
        draw_glyph(oam, &sprite_index, kSpeedCharX[2], kTextY, (char)('0' + ones));

        /* The multiplier glyph is visually one pixel too high in the source strip. */
        draw_glyph(oam, &sprite_index, 213u, (uint16_t)(kTextY + 1u), 'x');
    }
    obj_set_8x8(oam, sprite_index++, (uint16_t)(kFieldArrowX[selected_field] - 4u), kArrowY, GLYPH_ARROW);
    for (; sprite_index < 128u; ++sprite_index) obj_set_hide(oam, sprite_index);
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

void fake_rtc_menu_run(void) {
    uint16_t prev_keys = 0;
    uint16_t hold_up = 0;
    uint16_t hold_down = 0;
    RtcFields fields;
    AudioBackup audio_backup;
    uint32_t menu_timestamp = FAKE_RTC_DEFAULT_TIMESTAMP;
    uint8_t menu_speed = (uint8_t)(FAKE_RTC_DEFAULT_SPEED & 0xFFu);
    uint8_t selected = 0;
    uint32_t runtime_timestamp = 0;
    uint32_t runtime_speed = 0xFFFFFFFFu;

    if (rtc_state_is_initialized()) {
        rtc_state_read_runtime(&runtime_timestamp, &runtime_speed);
        runtime_state_for_menu(runtime_timestamp, runtime_speed, &menu_timestamp, &menu_speed);
    }

    audio_backup_and_mute(&audio_backup);
    draw_background();
    clear_oam();
    timestamp_to_fields(menu_timestamp, menu_speed, &fields);
    render_menu(&fields, selected);

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

        render_menu(&fields, selected);

        if ((keys & (KEY_A | KEY_START)) && !(prev_keys & (KEY_A | KEY_START))) {
            menu_speed = (uint8_t)(fields.speed & 0xFFu);
            menu_timestamp = fields_to_timestamp(&fields);
            rtc_state_write(
                menu_timestamp - ((uint32_t)menu_speed * FAKE_RTC_TICK_SECONDS),
                menu_speed
            );
            audio_restore(&audio_backup);
            break;
        }

        prev_keys = keys;
    }
}
