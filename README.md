<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# GBA Save Type Patcher

GBA Save Type Patcher is a tool for achieving more widespread compatibility for
legally owned backups. It detects common save-library implementations and rewrites
their access routines for the selected target hardware. Where a direct rewrite
is not enough, it installs a small runtime, redirects the relevant calls, and
reserves the storage it needs. Everything runs locally in the browser; ROM and
save files are never uploaded.

> [!WARNING]
> Binary patching is hardware-sensitive. Keep an untouched backup and select
> the hardware that is really present on the target cartridge. This project
> is a proof of concept and cannot guarantee compatibility with every game or
> cartridge.

## What can be patched?

### Save targets

| Mode | Intended target | What it does |
| --- | --- | --- |
| **SRAM** | Battery-backed SRAM cartridge | Converts a supported EEPROM or FLASH save library to SRAM. Includes selectable 1M FLASH bank-switch compatibility. |
| **Batteryless SRAM** | SRAM cartridge without a battery | Adds a runtime that keeps the logical save in a reserved 256-KiB ROM-FLASH area. It can flush automatically or through a configurable hotkey. An existing `.sav` can be embedded. |
| **512K FLASH** | Cartridge with a genuine SST 512K FLASH save chip | Adapts a supported game to the target FLASH and installs a journal runtime where required. |
| **Off-spec 512K/1M FLASH** | Cartridge with a supported non-standard FLASH chip | Patches for the selected SST25VF064C-family, SST49LF080A, or SST39VF6401B behavior. |
| **None** | Original save hardware | Leaves the save type unchanged, allowing only the optional RTC or Waitstate patches to be applied. |

The patcher recognizes save-library signatures rather than relying on a game
list. Unknown, ambiguous, modified, or damaged implementations are not patched
optimistically.

### Optional patches

- **Fake RTC** adds a software clock and an in-game configuration menu
  for RTC games running on cartridges without a real-time clock.
  - **Continuous on VBlank** is the default and advances independently of RTC
    reads. At `1x`, one RTC second is approximately 60 delivered VBlank frames.
    Higher speeds are distributed across those frames, allowing frequent RTC
    reads to observe smooth progress without increasing the overall clock rate.
    It adds a small amount of work to delivered VBlank IRQs.
  - **Only when the game reads the clock** does not add RTC clock-tick work to
    the VBlank path.
    Each RTC read counts as one nominal frame, so at `1x` approximately 60
    consecutive reads advance the clock by one second.
  - The speed multiplier ranges from `0` to `9999`. Holding
    Up or Down accelerates changes when the speed field is selected.
  - **Save RTC State on Global Hotkey** is enabled by default. It restores the
    timestamp, speed, and sub-second phase after a cold boot from a checksummed
    32-byte record at the very end of an aligned 256-KiB writable ROM-FLASH
    block. Batteryless SRAM and FLASH Journal patches share their existing
    256-KiB save reservation; other modes reserve the block directly after the
    add-on payload block. On a cold boot, the saved values are loaded into the
    RTC settings menu.
  - A persistence update erases the 256-KiB block as two consecutive 128-KiB
    halves before programming anything. The Batteryless and Journal runtimes
    coordinate that erase with their normal game-save flush so save data and
    the RTC record are written back in the same operation. Without one of those
    save runtimes, the record is updated after the initial RTC menu and when
    the RTC hotkey menu is confirmed.
  - When **Save RTC State on Global Hotkey** is disabled, no persistence block is
    reserved and RTC values are neither saved nor restored.
- **Waitstate** adjusts `WAITCNT` initialization for cartridges that require
  slower ROM access timings.

These add-ons are best effort. If an add-on cannot be applied, its warning is
kept while an otherwise successful save-type patch can still be returned. A
failed requested save-type conversion fails that ROM instead.
Continuous Fake RTC additionally requires the shared IRQ handler; installation
is rejected if that handler cannot be installed, rather than producing a clock
that cannot advance.

## Usage

1. Open the web application in a current Chromium-based browser.
2. Drop one or more `.gba`, `.bin`, or `.srl` files onto the page.
3. For Batteryless SRAM, optionally add a `.sav` with the same base name as its
   ROM and exactly the detected save size.
4. Select the save hardware present on the target cartridge and any optional
   patches.
5. Choose **Patch ROMs**, review all warnings, and save the generated file or
   ZIP archive.
6. Test the patched ROM and saving behavior before writing it to hardware.

Supported session limits:

- ROM size: up to 32 MiB
- ROM extensions: `.gba`, `.bin`, `.srl`
- Save extension: `.sav`
- Recognized save sizes: 512 B, 8 KiB, 32 KiB, 64 KiB, and 128 KiB
- At most 64 files and 512 MiB of input per session

## How it works

For each ROM, the application:

1. validates the fixed header byte and complement checksum and checks the
   Nintendo logo and reserved header fields;
2. detects known EEPROM, SRAM, and FLASH library signatures and determines the
   logical save size when possible;
3. builds an atomic patch plan containing code replacements, hooks, payloads,
   configuration, optional ROM expansion, and embedded save data;
4. verifies that all writes fit, do not conflict, and still match the bytes the
   plan was built against;
5. applies the plan in a Web Worker, records the patch metadata in two reserved
   header bytes, validates the resulting header, and records input/output
   SHA-256 hashes; and
6. returns only the patched output to the browser download flow.

The application has no upload endpoint or analytics. Its Content Security
Policy blocks network connections, foreign scripts, embedded objects, and
framing.

## Patch metadata in the GBA ROM header

The patcher uses the two trailing reserved bytes in the 192-byte GBA header as
a small, project-specific metadata record. No bytes are appended to the ROM;
the existing offsets `0xBE` and `0xBF` are overwritten. This record is **not**
part of Nintendo's original header specification.

| ROM offset | Name | Meaning |
| ---: | --- | --- |
| `0xBE` | Patch marker | Fixed value `0x4C` (ASCII `L`). The complete byte is a signature; its individual bits have no separate meaning. |
| `0xBF` | Patch flags | Encodes the target save size, target save medium, and successfully installed optional features. |

### Bit layout of byte `0xBF`

| Bits | Mask | Value | Meaning |
| ---: | ---: | ---: | --- |
| `2..0` | `0x07` | `000` | No or unknown save size |
|  |  | `001` | 512 B (4K EEPROM) |
|  |  | `010` | 8 KiB (64K EEPROM) |
|  |  | `011` | 32 KiB (256K SRAM) |
|  |  | `100` | 64 KiB (512K FLASH) |
|  |  | `101` | 128 KiB (1M FLASH) |
|  |  | `110`, `111` | Reserved |
| `4..3` | `0x18` | `00` | No or unknown save medium |
|  |  | `01` | SRAM |
|  |  | `10` | EEPROM |
|  |  | `11` | FLASH |
| `5` | `0x20` | `0` / `1` | Batteryless SRAM runtime absent / installed |
| `6` | `0x40` | `0` / `1` | Waitstate patch absent / successfully installed |
| `7` | `0x80` | `0` / `1` | Fake RTC absent / successfully installed |

The flags are composed as:

```text
flags = sizeCode | (mediumCode << 3) | featureFlags
```

For example, a 32-KiB Batteryless SRAM target uses size code `011`, medium
code `01`, and bit 5, resulting in `0x2B`. The two header bytes are therefore
`4C 2B`.

The current patcher writes this record as output metadata for easier
auto-detecting the save type with a cartridge flashing software.

## Compatibility and safety

- A recognized save-type string alone does not prove that every required
  routine has a supported layout. The patch is committed only when the full
  required hook set can be built safely.
- Runtime payloads need suitable free space. The patcher may expand a ROM, but
  never beyond the GBA's 32-MiB address space.
- Some strict ROM inspection tools may report `0xBE` and `0xBF` as non-zero
  reserved bytes. For this project, that is intentional.

Use ROM images that you are legally entitled to modify. This repository does
not contain commercial games, firmware, or copyrighted ROM images.

## Credits

Parts of this project are based on or informed by:

- [GBATA SRAM Patcher](https://web.archive.org/web/20070225124322/http://www.gbadat.altervista.org/tools.htm) by coolhj
- [gba-auto-batteryless-patcher](https://github.com/metroid-maniac/gba-auto-batteryless-patcher) by Metroid Maniac
- [gba-flash-patcher](https://github.com/metroid-maniac/gba-flash-patcher) by Metroid Maniac
- [Custom 1M FLASH Patcher](https://github.com/Lesserkuma/Custom_1M_FLASH_Patcher) by Lesserkuma
- [SuperFW](https://github.com/davidgfnet/superfw) by David Guillen Fandos

## License

GBA Save Type Patcher is distributed under
[GPL-3.0-or-later](LICENSE). Third-party components retain their respective
copyright and license terms, see [Third Party Notices](THIRD_PARTY_NOTICES.md).

## DISCLAIMER

This software is being developed by Lesserkuma as a hobby project. Codex was used as an assisting agent.
There is no direct affiliation with Nintendo or any other company. This software is provided as-is and
the developer is not responsible for any damage that is caused by the use of it. Use at your own risk!
