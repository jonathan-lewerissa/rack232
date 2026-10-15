# DriveWare web port

A browser-based controller for the dbx DriveRack loudspeaker management systems that the
Windows-only DriveWare 2.6.2 software supports: the DriveRack **480, 481, 482, 442, 240, 241, 260
and 220i**. It talks to the unit over RS-232 using the Web Serial API (desktop Chrome or Edge).

**Status: prototype.** The serial protocol was documented from DriveWare 2.6.2 for
interoperability and has not been tested on a real unit of any model yet. A built-in simulator for
every model lets you try the app without hardware.

## Quick start

```sh
cd web
npm start    # http://localhost:8260/  (add ?sim to start the simulator)
npm test
```

`?sim=480&units=3` simulates a three-unit 480 network; `?sim=240`, `?sim=220i` and so on pick
another model. The simulator model and network size are also under Options.

No build step and no dependencies; Node is only used for the dev server and tests. Deployment and
first-session notes for real hardware are in [`web/README.md`](web/README.md).

## Supported models

DriveWare 2.6.2 uses one serial protocol for the whole family. Each unit reports its model, and
the editor builds its UI from the processing blocks and parameters the unit describes, so the same
app handles every model. Per-model differences live in
[`web/public/js/models.js`](web/public/js/models.js).

| Model | Type code | Family | Outputs | Link | DriveWare built for | Notes |
|---|---|---|---|---|---|---|
| DriveRack 480 / 481 / 482 | `0` / `1` / `2` | 48x | 8 | network | firmware 2.500 | Master (ID 0) plus slaves (ID 1-99) and an optional 480R remote on one serial port |
| DriveRack 442 | `C` | 442 | 4 | network | — | Programs are not compatible with the 48x |
| DriveRack 240 / 241 | `A` / `B` | 24x | 4 | single | firmware 1.060 | |
| DriveRack 260 | `E` | 260 | 6 | single | firmware 1.510 | The model this project started with; manual in `docs/` |
| DriveRack 261 | `F` | 260 | 6 (inferred) | single | — | Named in DriveWare and handled like the 260; not on the dbx product page |
| DriveRack 220i | `'` | 220i | 2 | single | firmware 1.01 | |

What differs between models, all taken from DriveWare's code (see
[`re/PROTOCOL.md`](re/PROTOCOL.md) 4.1 and 4.5):

- **Discovery.** A single unit announces itself with `NETWORK_IDENTIFY`. On a 48x/442 network the
  master announces every address with `NETWORK_DID_CONFIG`, and unit IDs are addresses. The app
  lists all units and edits one at a time. It reads a unit fully when you select it; the others
  only report model and name until then. The 480R remote is listed but cannot be edited.
- **Utility block.** Security, power-up and program-list settings come in three layouts: 76 bytes
  (48x/442), 101 bytes (24x) and 219 bytes (260/220i). The app shows the layout and security level
  but cannot edit utility settings yet.
- **Output count.** Sets the number of mute switches. The mute mask is one byte on every model.
- **Slider ranges.** These come from each family's manual or DriveWare's built-in program banks:
  for example, 12 crossover types on the 260 and 4 slope values on the 24x/48x. Parameters with an
  unknown range get a stepper.

### Limits beyond the 260

- **Parameter names and types.** DriveWare has built-in parameter tables for the 48x, 24x, 442,
  260 and 220i and only asks the unit as a fallback. The app always asks. If a 48x or 24x does not
  answer those requests, its parameters appear as "Parameter n" with raw values. Porting DriveWare's
  tables would fix that; the device card shows which requests each unit answered.
- **Network-wide actions.** DriveWare sends some commands (system mute, system control) to every
  unit at once; the app mutes each unit separately. Venue files (`.dwv`), system control and zone
  controllers are not implemented.
- **Sample rate.** The PEQ graph assumes 48 kHz on every model. Only the 260's rate is confirmed,
  from its manual.

Newer DriveRacks (PA2, VENU360, 4800/4820) are not supported: DriveWare 2.6.2 does not cover
them.

## Repository

| Path | Contents |
|---|---|
| [`web/`](web/) | The app: vanilla JS, served as static files from `web/public` |
| [`re/PROTOCOL.md`](re/PROTOCOL.md) | Serial protocol notes: framing, CRC, link layer, discovery, per-model differences |
| [`re/FUNCTIONALITY.md`](re/FUNCTIONALITY.md) | 260 manual features vs. what the protocol exposes |
| [`re/messages.tsv`](re/messages.tsv) | Message ID table |
| [`DESIGN.md`](DESIGN.md) | Visual direction and the reason for each design token |

## Disclaimer

This software is provided "as is", without warranty of any kind. Use it at your own risk.
Independent project, not affiliated with Harman or dbx.
