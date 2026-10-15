# DriveWare (DriveRack family) serial protocol notes

Source: static analysis of DriveWare v2.6.2 for interoperability, plus its string and `Binary`
resources. **Nothing here has been tested against a real device.**
Items marked *inferred* are reasoning, not observed behaviour.

Revision 4 (2026-10-15): covers the whole DriveWare family (480/481/482, 442, 240/241, 260, 261,
220i). Corrected the link-up order (the device speaks first), added network discovery through
`NETWORK_DID_CONFIG` (4.1), resolved device types 'C' and 'F', and mapped the `UTILITY_REPLY` size
variants (4.5). Revision 3 (2026-10-14): added the link-up handshake, connect sequence, reply layouts from the
receive handler table, and the self-describing FX/parameter model. Revision 2 corrected the header
bytes and found the real dispatcher. Revision 1 (previous thread) had the framing and CRC right.

## 1. Physical link

- RS-232, `COM<n>`, **38400 baud, 8N1**, no flow control (RTS and DTR asserted). The baud is a
  registry setting (index 0..7 = 1200..115200, default 38400); the manual, section 6.1, says the
  unit is fixed at 38400.
- Cable: DB-9 female-female **null modem** (manual). A straight-through cable will not work.
- Reads use an 8000 ms timeout; driver buffers 0x2800 bytes each.

## 2. Byte stream: control bytes vs frames

Outside a frame, any byte with bit 7 set is a single-byte control code (handled by DriveWare's
receiver and writer threads):

| Byte | Name          | Who sends it, when                                                       |
|------|---------------|---------------------------------------------------------------------------|
| 0xA5 | ACK           | after a reliable frame arrived with a good CRC                             |
| 0xDA | NAK           | after a reliable frame arrived with a bad CRC; peer resends                |
| 0xFF | IDLE / HELLO  | 16 × 0xFF every 250 ms until link-up, and after a "bad flag" byte          |
| 0xF0 | RESYNC        | 261 × 0xF0 written in reply to a received 0xFF                             |
| 0x8C | KEEPALIVE     | sent by the writer after 1 s with nothing to send; skipped by the receiver  |
| other| bad flag      | counted; the writer answers with 16 × 0xFF                                 |

Link-up (*inferred from the writer thread*): the writer idles sending 16 × 0xFF every 250 ms until it
has received 0xFF or 0xF0 from the peer. On 0xFF it sends the 0xF0 burst; on 0xF0 it does not. It
then posts an internal `MSG_NETWORK_EVENT_NOW_ACTIVE` to the application and starts serving the
transmit queue. It still cannot send anything: the send function drops every frame whose `dst` is
not in a 128-bit "allowed destinations" bitmap, and that bitmap is empty until a device speaks
(`FUN_004189a0`). A single unit sends `MSG_NETWORK_IDENTIFY`; a network master sends
`MSG_NETWORK_DID_CONFIG` (section 4.1). Only then does DriveWare send `MSG_GUI_IDENTIFY`,
`MSG_SYSTEM_DO_ATTACH` and `MSG_SYSCON_CONFIG_REQUEST` to each unit it learned about. Revision 3
had this backwards (host first, to address 1).

## 3. Frame format

```
dst       destination device address, 0x00..0x7F
src       source device address, 0x00..0x7F; bit 7 set => "reliable" (guaranteed) frame
seq       present only on reliable frames; starts at 1, +1 after each ACK, wraps 0xFF -> 1
len       payload length in bytes; 0 means 256
payload   len bytes: uint16 LE message ID, then message data
crc       CRC-8 over every preceding byte (dst, src|0x80, seq, len, payload)
```

- CRC: Dallas/Maxim CRC-8, reflected polynomial 0x8C, **init 0xFF**, no final XOR, table driven
  (all 256 entries verified against the standard table).
- DriveWare passes 0xFF as source to mean "my own address". A
  128-bit bitmap at `+0x96` lists device addresses that are allowed as destinations.
- Field names confirmed by the debug string
  `Send_Config_Write_FX_Data: Dest = 0x%X, Src = 0x%X, Guar = %d, ...`.

Reliable frames are stop-and-wait: one frame in flight, ACK frees it and bumps `seq`, NAK resends it
with the same `seq`. The receiver ACKs every reliable frame with a good CRC, drops one whose `seq`
equals the last accepted one ("Duplicate Frame!!!"), and after 16 consecutive bad CRCs on
unreliable frames forces a resync. Almost everything DriveWare sends is reliable (`Guar = 1`).

Timeouts: with a frame in flight the writer waits 1000 ms for ACK/NAK, resends up
to 4 times, then sends 16 × 0xFF and starts another 4 resends, for up to 4 such rounds. After that
it drops the frame, still advances `seq`, and declares the link inactive (back to the 0xFF idle
loop). The reader uses an 8000 ms per-byte timeout; a timeout also takes the link down, so a peer
must send something (at least keepalives) every 8 s.

## 4. Application layer

Payload bytes 0..1 are the message ID. DriveWare's receive thread validates the length against a
static table (id, min, max, name) and dispatches each message to its handler; sending goes through
one function taking (dst, src, guaranteed, len, payload), with one wrapper per message.
[`messages.tsv`](messages.tsv) lists all 142 messages with their length limits, whether DriveWare
handles (`pc_rx`) or sends (`pc_tx`) them, and the decoded payload layout. Offsets below are payload offsets, so `[2]` is
the first byte after the ID.

### 4.1 Addresses and identification

Two ways a link announces itself. DriveWare accepts both on any link:

- `MSG_NETWORK_IDENTIFY` (0x0002, reliable, from a single unit): DriveWare sets its own address
  from the frame's `dst` and the unit's from `src`, and allows only that destination. Payload `[2]`
  is the protocol generation; a 2-byte IDENTIFY counts as generation 1. The generation is stored
  only once per link.
- `MSG_NETWORK_DID_CONFIG` (0x0001, 18 bytes, only accepted from `src` 0, the network master):
  DriveWare sets its own address from `dst`. Payload `[2..17]` is a 128-bit bitmap of every
  address on the network (bit n = `[2 + n/8] & (1 << n%8)`), copied straight into the
  allowed-destinations bitmap (`FUN_004187d0`).

Either one triggers `CDRDoc::Event_Routing_Reconfigured`. It walks addresses 0..99 and checks
0x7D, and for each address present sends `GUI_IDENTIFY`, `SYSTEM_DO_ATTACH` and
`SYSCON_CONFIG_REQUEST`, then runs the connect sequence (4.2) if the address is below 100.
DriveWare never polls addresses. Replies are routed to a unit by the frame's `src`.

Address = unit ID:

| Address | Meaning | Source |
|---|---|---|
| 0x00 | Network master ("Network Master Device") | decompiled.c ~6689 |
| 0x01..0x63 | Slave with that ID; 0x01 is also where the 260 and 220i always live | ~6698, 6448, 7536 |
| 0x6F | System control (internal device type 9) | ~7446 |
| 0x7D | 480R remote unit (type 4); only it may send 0x4E/0x4F/0xC3 and the 16-byte `UTILITY_REPLY` | ~6782, 15571 |
| 0x7F | Broadcast: `SYSCON_REQUEST` 0x47, system mute 0xB5, SYSCON 0x44 | ~1684, 7097 |

Generation selects the path in `Event_Routing_Reconfigured`: 3 = 260 (single unit at address 1),
4 = 220i, 1 or 2 = the network path used for the 48x/442 and the 24x.

- `MSG_SYSTEM_REPLY_DEVICE_DATA` (0x001B, 10 bytes): `[3..6]` are ASCII digits of the firmware
  version ("1510" = 1.510), `[7]` is a device-type character. No other bytes are read.
  DriveWare forces generation 2 for 'A'/'B' and 4 for '\''.

  | `[7]` | Type | Model | Family | Outputs | DriveWare built for |
  |---|---|---|---|---|---|
  | '0' / '1' / '2' | 1 / 2 / 3 | DriveRack 480 / 481 / 482 | 48x | 8 | 2.500 |
  | — | 4 | 480R remote (always address 0x7D) | — | — | |
  | 'A' / 'B' | 5 / 6 | DriveRack 240 / 241 | 24x | 4 | 1.060 |
  | — | 9 | System control (address 0x6F) | — | — | |
  | 'C' | 10 | DriveRack 442 | 442 | 4 (mute bits 4-7 skipped) | |
  | 'E' | 11 | DriveRack 260 | 260 | 6 | 1.510 |
  | 'F' | 12 | DriveRack 261 (`FUN_004b7e00`, treated with the 260) | 260 | 6 (*inferred*) | |
  | '\'' | 13 | DriveRack 220i | 220i | 2 | 1.01 |

  Detecting a model removes incompatible ones from the session: a 48x/442 removes any 24x, and a
  24x/260/261 removes 48x, 480R and 442 devices. 442 and 48x programs are mutually incompatible.
  The firmware warning ("old version of firmware") has a single threshold, 1.301, for every
  model, and looks disabled by a global flag.
- `MSG_SYSTEM_REPLY_DEVICE_NAME` (0x001E): `[2..]` NUL-terminated name.

Per-family data that DriveWare carries but the device does not report:

- Built-in FX tables giving each parameter's input type (48x: 124 FX types, 24x: 159, 442: 124,
  system control: 161, 260: 118, 220i: 46). DriveWare only asks `PARAM_REQUEST_INPUT_TYPE` /
  `PROMPT_STRING` (0x97/0x99) when its table has no entry, so older families may not answer them.
- Program banks (`Binary` resources 198 = 48x, 229 = 24x, 293 = 442): 31-band GEQs in all three;
  crossover slopes 0..3 (input type 0x21/0x22 on the 48x, 0x58 on the 24x, 0x23 on the 442's
  linked filters); output gain 0x3F seen from 7 to 137.

### 4.2 Connect sequence (sent to the device address, all reliable)

1. `MSG_SYSTEM_REQUEST_DEVICE_DATA` (0x1A)
2. `MSG_CONFIG_REQUEST_NUMBER_FX` (0x77)
3. `MSG_SYSTEM_REQUEST_DEVICE_NAME` (0x1D)
4. `MSG_PROGRAM_REQUEST_GLOBAL_DATA` (0x67)
5. `MSG_PROGRAM_REQUEST_CURRENT` (0x50)
6. `MSG_CONFIG_MUTE_STATUS_REQUEST` (0xB3)
7. `MSG_UTILITY_REQUEST` (0xC0)

The replies drive the rest. `REPLY_GLOBAL_DATA` (0x68) carries three uint16. DriveWare passes `[2..3]` and `[4..5]` to the
device object and then asks `MSG_PROGRAM_REQUEST_NAME` for programs 0 .. sum of two counts it keeps
at `+0x107`/`+0x109`. `+0x107` is the user program count: DriveWare logs it as
`g_nUserPrograms`, increments it when it adds a user program, and builds the user program list
from it before the `+0x109` (factory) list. Which reply field lands in `+0x107` is *inferred* to be
`[2..3]`, which matches the manual: programs 1-25 User, 26-50 Factory (3.4, A.6). `[6..7]` is copied into every program entry; its meaning is open. `REPLY_CURRENT`
(0x51, `[2]` = program number) triggers `MSG_PROGRAM_REQUEST_NAME(n)`, `MSG_CONFIG_REQUEST_ALL(n)`
and `MSG_PARAM_REQUEST_ALL`.

### 4.3 The device describes its own signal chain

The program's processing chain is a list of FX blocks, each with a list of parameters. DriveWare
learns it entirely from the device:

| Step | Request → Reply | Reply payload |
|------|-----------------|---------------|
| how many blocks | 0x77 → `CONFIG_REPLY_NUMBER_FX` 0x78 | `[2]` = count |
| each block | 0x74 (`[2]`=fx) → `CONFIG_REPLY_FX_DATA` 0x75 | `[2]`=fx, `[3..9]` descriptor (type, routing) |
| block name | 0x79 → `CONFIG_REPLY_FX_NAME` 0x7A | `[2]`=fx, `[4..]` name |
| block routing | 0x7B → `CONFIG_REPLY_FX_IN_OUT` 0x7C | `[2]`=fx, `[3]`=in channel, `[4]`=out channel |
| all values | 0x92 (`[2]`=fx) → `PARAM_REPLY_ALL_IN_FX` 0x93 | `[3]`=fx, `[5..]` uint16 per parameter |
| one value | 0x95 → `PARAM_REPLY` 0x96 | `[3]`=fx, `[4]`=param, `[6..7]` value |
| widget type | 0x97 (`[2]`=fx,`[3]`=param) → `PARAM_REPLY_INPUT_TYPE` 0x98 | `[4]` = input type |
| label | 0x99 → `PARAM_REPLY_PROMPT_STRING` 0x9A | `[4..]` prompt string |
| value as text | 0xA3 → `PARAM_REPLY_STRING` 0xA4 | `[4..19]` 16-char display string |
| value type text | 0xA1 → `PARAM_TYPE_REPLY_STRING` 0xA2 | `[5..20]` 16-char string |

Writes: `MSG_PARAM_WRITE` (0x94) = `[2]`=fx index, `[3]`=parameter index, `[4..5]` uint16 value
(confirmed in DriveWare's write path). `MSG_PARAM_WRITE_ALL_IN_FX` (0x91) = `[2]`=fx, `[3]`=count,
`[4..]` uint16 values.

Parameter values are **step indices**, not physical units. The embedded 24x program bank (see
[FUNCTIONALITY.md](FUNCTIONALITY.md)) shows e.g. GEQ band gain 0..48 with 24 = 0 dB (0.5 dB steps),
output phase 0..36 with 36 = 0° (5° steps), compressor threshold 0..60 with 40 = 0 dBu. The device
can render any value to text through 0xA3/0xA4, so a client does not need its own unit tables.

### 4.4 Programs

- Select and load: `MSG_PROGRAM_DO_RETRIEVE` (0x5A, `[2]`=program) followed by
  `MSG_PROGRAM_DO_LOAD` (0x5C, no data); the device answers `DID_RETRIEVE` 0x5B and `DID_LOAD`
  0x5D (`[2]`=program).
- Names: `REQUEST_NAME` 0x56 (`[2]`=program) → `REPLY_NAME` 0x57 (`[2]`=program, `[4..]` name);
  `REQUEST_CURRENT_NAME` 0x54 → 0x55 (`[4..]` name).
- Store: `MSG_PROGRAM_DO_STORE` (0x58) = `[2]`=program, `[3]`=mode (0x00 or 0xFF), `[4..]` name;
  reply `DID_STORE` 0x59 (`[2]`=program).
- Format and bulk transfer (0x5E..0x66) move whole programs; `REPLY_FORMAT` (0x66, 25 bytes) is
  `[2]` u8, then u16 at 6, 8, 10, 12, 14, u8 at 16, 17, u16 at 18, u8 at 20, 21, u16 at 22, u8 at 24.
- Configuration edits (changing which blocks exist): `CONFIG_DO_START` 0x71,
  `CONFIG_WRITE_NUMBER_FX` 0x76, `CONFIG_WRITE_FX_DATA` 0x73 (8-byte header + uint16 params),
  `CONFIG_DO_END` 0x72 ("Send Config DO END to box").

### 4.5 Mutes and utilities

- `CONFIG_MUTE_STATUS_REQUEST` 0xB3 → `REPLY` 0xB4: `[2]` = output mute bitmask;
  `CONFIG_WRITE_MUTE_STATUS` 0xB8 writes it. `CONFIG_SYSTEM_MUTE_*` (0xB5..0xB7) is the
  global mute (`[2]` = 1 muted; 0x81 also treated as muted).
- `UTILITY_REQUEST` 0xC0 → `UTILITY_REPLY` 0xC1: security, power-up and program-list settings,
  written back with `UTILITY_REPLY`. The length table says 76 bytes, but `FUN_0041a480` accepts a
  size per device (offsets below include the 2-byte message ID):

  | Length | Who | Layout |
  |---|---|---|
  | 0x10 (16) | 480R remote at 0x7D only | not mapped |
  | 0x4C (76) | 48x, 442 | `[4..20]` 17 per-function lock levels, `[21..36]`/`[37..52]` high/medium passwords, `[53]` security level, `[54..63]` program list, `[64]` list size, `[65]` bit 0 list mode (*inferred*), `[68..75]` power-up mute, redundancy, load stored, mic pre, MIDI channel, SysEx ID (order not mapped) |
  | 0x65 (101) | 24x (generation 2) | the 0x4C layout plus `[76..100]`, probably switch-closure settings (*inferred*) |
  | 0xDB (219) | 260, 220i (generation 3/4) | `[2]` = 1 on writes; 260: `[20..25]` output gain jumpers, `[26]`+`[43..59]` security page with `[59]` = security level, `[27]` list mode, `[28]` list index, `[29..38]` program list, `[39]` list size, `[41]` output mute byte, `[60..87]` passwords, `[88]`/`[89]` power-up program/mute (order *inferred*), `[93..218]` zone controller setup; 220i: `[90]` front-panel lockout |

  Nothing in DriveWare mentions LCD contrast, although the 260 manual lists it as a utility setting.
- `KPS_*`, `BUTTON_DO_PRESS` (0xA0) and `SYSCON_*` drive zone controllers, remote key presses and
  the 480R "system control" features.

### 4.6 Error replies

`MSG_ERROR_INVALID_MESSAGE` 0x2D, `_LENGTH` 0x2E, `_PARAMETER` 0x2F (10 bytes, error code at
`[2..3]`). DriveWare logs them and otherwise ignores them.

## 5. Still unknown / to verify on hardware

- The handshake in section 2 on each model: does the unit send 0xFF unprompted, and does it send
  `NETWORK_IDENTIFY` (or the master `NETWORK_DID_CONFIG`) right after link-up?
- Each unit's address and protocol generation byte. In particular, does a lone 24x send IDENTIFY or
  DID_CONFIG?
- The utility layouts beyond the security level, and the meaning of the FX descriptor bytes in 0x75.
- Whether each model answers the discovery requests in 4.3. The 48x/24x/442 matter most, since
  DriveWare has its own FX tables for them and rarely asks.
- Whether the 48x master forwards slave replies with the slave's address as `src` (assumed).
