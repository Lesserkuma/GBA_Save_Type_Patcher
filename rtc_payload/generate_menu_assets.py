#!/usr/bin/env python3
"""Generate shared OBJ assets for the Fake-RTC boot and runtime menus."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from PIL import Image


ROOT = Path(__file__).resolve().parent
ASSET_DIR = ROOT / "assets"
OUT_FILE = ROOT / "menu_assets_generated.h"

TILE_SIZE = 8
SCREEN_W = 240
SCREEN_H = 160
OBJ_BLOCK_W = 32
OBJ_BLOCK_H = 16
OBJ_TILE_BUDGET_BYTES = 4096
RUNTIME_STACK_BACKUP_BUDGET_BYTES = 1536
RUNTIME_TEXT_SPRITES_RESERVED = 48
OAM_ENTRY_COUNT = 128

GLYPH_CHARS = "0123456789/:-x"
GLYPH_X = [1, 12, 23, 33, 44, 55, 65, 76, 86, 97, 108, 118, 129, 140]
GLYPH_Y = 1
GLYPH_W = 8
GLYPH_H = 16


@dataclass(frozen=True)
class RuntimeStats:
    obj_tiles_bytes: int
    oam_entries: int
    backup_bytes: int


def load_rgba(name: str) -> Image.Image:
    return Image.open(ASSET_DIR / name).convert("RGBA")


def gba_color(color: tuple[int, int, int, int]) -> int:
    r, g, b, a = color
    if a == 0:
        return 0
    return (r >> 3) | ((g >> 3) << 5) | ((b >> 3) << 10)


def unique_colors(images: Iterable[Image.Image], transparent_first: bool) -> list[tuple[int, int, int, int]]:
    colors: list[tuple[int, int, int, int]] = []
    seen: set[tuple[int, int, int, int]] = set()
    if transparent_first:
        transparent = (255, 255, 255, 0)
        colors.append(transparent)
        seen.add(transparent)

    for image in images:
        pixels = image.get_flattened_data() if hasattr(image, "get_flattened_data") else image.getdata()
        for color in pixels:
            normalized = color if color[3] else (255, 255, 255, 0)
            if transparent_first and normalized[3] == 0:
                continue
            if normalized not in seen:
                colors.append(normalized)
                seen.add(normalized)

    if len(colors) > 16:
        raise SystemExit(f"4bpp palette has {len(colors)} colors, maximum is 16")
    return colors


def palette_words(colors: list[tuple[int, int, int, int]]) -> list[int]:
    return [gba_color(color) for color in colors] + [0] * (16 - len(colors))


def palette_index(colors: list[tuple[int, int, int, int]]) -> dict[tuple[int, int, int, int], int]:
    return {color: index for index, color in enumerate(colors)}


def color_index(
    lookup: dict[tuple[int, int, int, int], int],
    color: tuple[int, int, int, int],
) -> int:
    normalized = color if color[3] else (255, 255, 255, 0)
    try:
        return lookup[normalized]
    except KeyError as exc:
        raise SystemExit(f"Color {normalized!r} is missing from palette") from exc


def image_with_transparent_color(
    image: Image.Image,
    transparent_color: tuple[int, int, int, int],
) -> Image.Image:
    transparent = (255, 255, 255, 0)
    out = image.copy()
    data = out.get_flattened_data() if hasattr(out, "get_flattened_data") else out.getdata()
    pixels = [
        transparent if color == transparent_color else color
        for color in data
    ]
    out.putdata(pixels)
    return out


def pack_tile(indices: list[int]) -> bytes:
    if len(indices) != 64:
        raise ValueError("A tile must contain exactly 64 pixels")
    out = bytearray()
    for y in range(8):
        row = y * 8
        for x in range(0, 8, 2):
            out.append(indices[row + x] | (indices[row + x + 1] << 4))
    return bytes(out)


def tile_from_image(
    image: Image.Image,
    x: int,
    y: int,
    lookup: dict[tuple[int, int, int, int], int],
    pad_color: tuple[int, int, int, int],
) -> bytes:
    indices: list[int] = []
    for yy in range(y, y + 8):
        for xx in range(x, x + 8):
            color = image.getpixel((xx, yy)) if 0 <= xx < image.width and 0 <= yy < image.height else pad_color
            indices.append(color_index(lookup, color))
    return pack_tile(indices)


def halfwords_from_bytes(data: bytes) -> list[int]:
    if len(data) & 1:
        raise ValueError("Data length must be even")
    return [data[i] | (data[i + 1] << 8) for i in range(0, len(data), 2)]


def add_unique_tile(tile: bytes, tiles: list[bytes], tile_index: dict[bytes, int]) -> int:
    existing = tile_index.get(tile)
    if existing is not None:
        return existing
    index = len(tiles)
    tiles.append(tile)
    tile_index[tile] = index
    return index


def glyph_tile_constants(prefix: str, char_name: str, top: int, bottom: int) -> dict[str, int]:
    return {
        f"{prefix}_{char_name}_TOP": top,
        f"{prefix}_{char_name}_BOTTOM": bottom,
    }


def const_name_for_char(ch: str) -> str:
    if ch.isdigit():
        return ch
    return {
        "/": "SLASH",
        ":": "COLON",
        "-": "DASH",
        "x": "X",
    }[ch]


def build_obj_assets(bg: Image.Image, glyphs: Image.Image, arrow: Image.Image) -> tuple[list[int], list[int], list[int], dict[str, int], RuntimeStats]:
    transparent = (255, 255, 255, 0)
    black = bg.getpixel((0, 0))
    runtime_bg = image_with_transparent_color(bg, black)
    colors = unique_colors([runtime_bg, glyphs, arrow], transparent_first=True)
    lookup = palette_index(colors)
    blank_tile = pack_tile([0] * 64)
    blank_block = blank_tile * ((OBJ_BLOCK_W // TILE_SIZE) * (OBJ_BLOCK_H // TILE_SIZE))
    tiles = [blank_tile]
    tile_index = {blank_tile: 0}
    constants: dict[str, int] = {
        "MENU_OBJ_TILE_NONE": 0xFFFF,
        "MENU_OBJ_TILE_BLANK": 0,
    }

    for ch, x in zip(GLYPH_CHARS, GLYPH_X):
        top = add_unique_tile(tile_from_image(glyphs, x, GLYPH_Y, lookup, transparent), tiles, tile_index)
        bottom = add_unique_tile(tile_from_image(glyphs, x, GLYPH_Y + 8, lookup, transparent), tiles, tile_index)
        constants.update(glyph_tile_constants("MENU_OBJ_TILE", const_name_for_char(ch), top, bottom))

    arrow_tile = add_unique_tile(tile_from_image(arrow, 0, 0, lookup, transparent), tiles, tile_index)
    constants["MENU_OBJ_TILE_ARROW"] = arrow_tile
    constants["MENU_OBJ_TILES_SIZE_HALFWORDS"] = len(tiles) * 16

    runtime_tiles = list(tiles)
    block_index: dict[bytes, int] = {}
    bg_tile_starts: list[int] = []

    def append_block(block: bytes) -> int:
        existing = block_index.get(block)
        if existing is not None:
            return existing
        start = len(runtime_tiles)
        block_tiles = [block[i : i + 32] for i in range(0, len(block), 32)]
        runtime_tiles.extend(block_tiles)
        block_index[block] = start
        return start

    for y in range(0, SCREEN_H, OBJ_BLOCK_H):
        for x in range(0, SCREEN_W, OBJ_BLOCK_W):
            block_parts: list[bytes] = []
            for tile_y in range(0, OBJ_BLOCK_H, TILE_SIZE):
                for tile_x in range(0, OBJ_BLOCK_W, TILE_SIZE):
                    block_parts.append(tile_from_image(runtime_bg, x + tile_x, y + tile_y, lookup, transparent))
            block = b"".join(block_parts)
            bg_tile_starts.append(constants["MENU_OBJ_TILE_NONE"] if block == blank_block else append_block(block))

    bg_sprite_count = sum(1 for tile_start in bg_tile_starts if tile_start != constants["MENU_OBJ_TILE_NONE"])
    constants["MENU_RUNTIME_BG_COLS"] = SCREEN_W // OBJ_BLOCK_W + (1 if SCREEN_W % OBJ_BLOCK_W else 0)
    constants["MENU_RUNTIME_BG_ROWS"] = SCREEN_H // OBJ_BLOCK_H
    constants["MENU_RUNTIME_BG_SPRITES"] = bg_sprite_count
    constants["MENU_RUNTIME_TEXT_SPRITES_RESERVED"] = RUNTIME_TEXT_SPRITES_RESERVED
    constants["MENU_RUNTIME_BG_TILES_SIZE_HALFWORDS"] = (len(runtime_tiles) - len(tiles)) * 16
    constants["MENU_RUNTIME_OBJ_TILES_SIZE_HALFWORDS"] = len(runtime_tiles) * 16

    stats = RuntimeStats(
        obj_tiles_bytes=len(runtime_tiles) * 32,
        oam_entries=bg_sprite_count + RUNTIME_TEXT_SPRITES_RESERVED,
        backup_bytes=32 + 1024 + 192,
    )
    if stats.obj_tiles_bytes > OBJ_TILE_BUDGET_BYTES:
        raise SystemExit(f"Runtime OBJ tiles use {stats.obj_tiles_bytes} bytes, budget is {OBJ_TILE_BUDGET_BYTES}")
    if stats.oam_entries > OAM_ENTRY_COUNT:
        raise SystemExit(f"Runtime menu uses {stats.oam_entries} OAM entries, maximum is {OAM_ENTRY_COUNT}")
    if stats.backup_bytes > RUNTIME_STACK_BACKUP_BUDGET_BYTES:
        raise SystemExit(f"Runtime backup estimate is {stats.backup_bytes} bytes, budget is {RUNTIME_STACK_BACKUP_BUDGET_BYTES}")

    return (
        palette_words(colors),
        halfwords_from_bytes(b"".join(tiles)),
        halfwords_from_bytes(b"".join(runtime_tiles[len(tiles) :])),
        {**constants, "menu_runtime_bg_tile_starts": bg_tile_starts},
        stats,
    )


def format_define(name: str, value: int) -> str:
    return f"#define {name} {value}u"


def format_array(name: str, values: list[int], ctype: str = "uint16_t", per_line: int = 12) -> str:
    lines = [f"static const {ctype} {name}[] = {{"]
    for index in range(0, len(values), per_line):
        chunk = values[index : index + per_line]
        lines.append("    " + ", ".join(f"0x{value:04x}" for value in chunk) + ",")
    lines.append("};")
    return "\n".join(lines)


def write_header(
    obj_palette: list[int],
    obj_tiles: list[int],
    runtime_bg_tiles: list[int],
    obj_constants: dict[str, int],
    stats: RuntimeStats,
) -> None:
    defines = []
    for name, value in obj_constants.items():
        if name == "menu_runtime_bg_tile_starts":
            continue
        defines.append(format_define(name, value))
    defines.extend(
        [
            format_define("MENU_RUNTIME_OBJ_TILES_SIZE_BYTES", stats.obj_tiles_bytes),
            format_define("MENU_RUNTIME_OAM_ENTRIES_MAX", stats.oam_entries),
            format_define("MENU_RUNTIME_BACKUP_ESTIMATE_BYTES", stats.backup_bytes),
        ]
    )

    text = "\n".join(
        [
            "/* Auto-generated by rtc_payload/generate_menu_assets.py. */",
            "#pragma once",
            "",
            "#include <stdint.h>",
            "",
            *defines,
            "",
            format_array("menu_obj_palette", obj_palette),
            "",
            format_array("menu_obj_tiles", obj_tiles),
            "",
            format_array("menu_runtime_bg_tiles", runtime_bg_tiles),
            "",
            format_array("menu_runtime_bg_tile_starts", obj_constants["menu_runtime_bg_tile_starts"]),
            "",
        ]
    )
    OUT_FILE.write_text(text, encoding="utf-8", newline="\n")


def main() -> int:
    bg = load_rgba("bg.png")
    glyphs = load_rgba("glyphs.png")
    arrow = load_rgba("arrow.png")
    if bg.size != (SCREEN_W, SCREEN_H):
        raise SystemExit(f"bg.png must be {SCREEN_W}x{SCREEN_H}, got {bg.size}")

    obj_palette, obj_tiles, runtime_bg_tiles, obj_constants, stats = build_obj_assets(bg, glyphs, arrow)
    if len(obj_tiles) + len(runtime_bg_tiles) != obj_constants["MENU_RUNTIME_OBJ_TILES_SIZE_HALFWORDS"]:
        raise SystemExit("Runtime OBJ footprint does not match the generated tile arrays")
    write_header(
        obj_palette,
        obj_tiles,
        runtime_bg_tiles,
        obj_constants,
        stats,
    )
    print(f"wrote {OUT_FILE.relative_to(ROOT.parent)}")
    print(
        f"shared obj tiles: {len(obj_tiles) * 2} bytes, "
        f"runtime background: {len(runtime_bg_tiles) * 2} bytes"
    )
    print(f"runtime obj footprint: {stats.obj_tiles_bytes} bytes, oam max: {stats.oam_entries}, backup estimate: {stats.backup_bytes} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
