# DriveRack 260 functionality vs. what the DriveWare protocol exposes

Manual: `docs/260_Manual_5059585-A_original.pdf` (rev A). Protocol: see [PROTOCOL.md](PROTOCOL.md)
and [messages.tsv](messages.tsv). "Covered" means DriveWare 2.6.2 has working send and receive
code for it; nothing has been exercised on hardware yet.

## Feature coverage

| Manual feature (section) | Protocol path | Status |
|---|---|---|
| Program select / load, 25 factory + user programs (3.2, 5.5) | `PROGRAM_DO_RETRIEVE` + `DO_LOAD`, `REPLY_CURRENT`, `REQUEST_NAME`, `REPLY_GLOBAL_DATA` (user program count) | covered |
| Store / rename program (3.4, 3.6) | `PROGRAM_DO_STORE` with name, `DID_STORE` | covered |
| Edit every module parameter: GEQ/PEQ, AFS, Subharmonic, Gate, AGC, Notch, Crossover, Post PEQ, Comp/Limiter, Delay, Input mixer, Output (4.1–4.12) | discovery via `CONFIG_*`/`PARAM_*`, writes via `PARAM_WRITE`, text via `PARAM_REPLY_STRING` | covered, generic |
| Configuration mode: choose crossover type, inserts, routing (3.5, A.5) | `CONFIG_DO_START`, `WRITE_NUMBER_FX`, `WRITE_FX_DATA`, `DO_END` | covered, descriptor bytes undecoded |
| Output mutes (1.2, 5.2) | `CONFIG_MUTE_STATUS_*` bitmask, `CONFIG_SYSTEM_MUTE_*` | covered |
| Device name | `SYSTEM_WRITE/REQUEST/REPLY_DEVICE_NAME` | covered |
| Utility: security levels and passwords, PUP program/mute, program list, LCD contrast, output jumpers (5.1–5.5) | `UTILITY_REQUEST/REPLY` 76-byte block, written back with `UTILITY_REPLY` | covered, 260 layout to be mapped on hardware |
| ZC zone controllers (5.3, 6.2) | `KPS_*`, `SYSCON_*`, part of `UTILITY_REPLY` | covered for 480R; 260 fields unknown |
| Meters: comp/limiter gain reduction, AGC, output trims (5.6) | no `MSG_METER*` exists | **not available over serial** |
| RTA, Auto EQ wizard, AFS wizard, System Setup wizard (2.9, A.4) | no messages; only `KPS_KEYPRESS` / `BUTTON_DO_PRESS` remote key presses | front panel only |
| AFS live filter clear (4.2) | `AFL_REQUEST/REPLY` (`AFL` = AFS live?), `AFB_*` | present, semantics unverified |
| Firmware update (A.2) | `SYSTEM_*_FLASH_DOWNLOAD/WRITE_FLASH` | messages exist, DriveWare ignores them (separate updater) |
| Factory / soft reset (A.1) | `SYSTEM_DO_SOFT_RESET`, `DO_FACTORY_RESET` | messages exist, DriveWare never sends them |
| Security lockout error | string "The Security Level is not high enough to make the requested change." | device likely answers `MSG_ERROR_INVALID_PARAMETER` |

## Value encodings seen in the embedded 24x program bank

DriveWare embeds default program banks as `Binary` resources (198 = 48x, 229 = 24x, 293 = 442) in
MFC `CArchive` form: `CProgram` → `CFx` → `CParam(type id, name, value)`. The 260 has no bank, it
is read from the device, but the 24x shares the 260's generation and shows the encoding style:

| Block | Parameters (type id) | Value range seen | Manual range |
|---|---|---|---|
| Input Mixer | MGain 0x3E, Ch1/Ch2 0x49 | 0..27 | -Inf..+20 dB |
| GEQ (28 band) | on/off 0x0C, F 0x2A, band G 0x14/0x43 ×28, Boom/Zizz/Tilt | G 0..48, 24 = 0 dB | ±12 dB, 0.5 dB |
| 4 Band Post EQ | on 0x0C, Type 0x5A, Fc 0x4E/0x05/0x4F, G 0x07, Q 0x06, Q/S 0x50 | G 12..48, Q 0..15 | ±12 dB; Q 0.2..16 |
| Crossover 2X4 etc. | High/Low Fc 0x24, Slope 0x58 | Slope 0..3 | BW/BS 6..24, LR 12..48 |
| Comp / Limiter | on 0x00, OverEasy 0x04, Thresh 0x01, R 0x02, G 0x03, PkStop+ 0x57 | Thresh 40 = 0 dBu | -40..+20 dBu |
| Delay | Delay 0x1C | 0/1 (+ fine value elsewhere) | up to 1.3 s |
| Output n | Out Adj 0x00, G 0x3F, Ph 0x29 | Ph 0..36, 36 = 0° | 0..-175°, 5° |

The type id is the `paramType` in `Send_Param_Write() %d: paramType = %d, nVal = %d`; it tells the
GUI which widget and unit table to use. The device also returns it via
`PARAM_REPLY_INPUT_TYPE`, so a client can be data-driven.

## What this means for a rebuild

1. The 260 is self-describing: after the seven-message connect sequence, walk the FX list and ask
   for names, routing, input types, prompt strings and values. No hard-coded 260 model is needed
   for a first working editor; a nicer UI can special-case known block types later.
2. Writes are one `PARAM_WRITE` per change, plus `PROGRAM_DO_STORE` to persist.
3. Meters and the wizards cannot be reproduced over serial; the RTA/Auto EQ features stay on the
   front panel unless remote key presses turn out to work on the 260.
4. The link layer is small: CRC-8 table, framing, ACK/NAK stop-and-wait, idle/resync bytes. It
   fits in a few hundred lines of TypeScript on top of the Web Serial API.
