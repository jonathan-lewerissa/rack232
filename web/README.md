# DriveWare web port (prototype)

Vanilla JavaScript, no build step, no dependencies. Talks to the DriveRacks that DriveWare 2.6.2
supports (480, 481, 482, 442, 240, 241, 260, 220i) over RS-232 through the browser's Web Serial
API (desktop Chrome or Edge), using the protocol in [`../re/PROTOCOL.md`](../re/PROTOCOL.md). That
protocol is from static analysis only; nothing here has run against a real unit yet. The model
differences are summarised in the [top-level README](../README.md#supported-models).

## Run

```sh
cd web
npm start            # node scripts/serve.js -> http://localhost:8260/
npm test             # node --test: framing, CRC, link layer, session against the simulator
```

Open `http://localhost:8260/?sim` to start the built-in simulator immediately (a 260). Pick another
model with `?sim=240`, `?sim=220i`, `?sim=442` and so on, or a network with `?sim=480&units=3`
(three units plus a 480R remote). The same choices are under Options → Simulator. Signal chains,
ranges, program names and addresses are invented for testing.

## Deploy to Cloudflare Pages

`public/` is the whole site. In the Pages dashboard: framework preset **None**, build command
empty, build output directory **`web/public`**. Or from the CLI:

```sh
npx wrangler pages deploy web/public --project-name driveware-web-port
```

`public/_headers` sets `Permissions-Policy: serial=(self)` and a strict CSP. Pages serves HTTPS,
which Web Serial requires.

## First session with the hardware

1. Null-modem DB-9 cable (a straight cable will not work), USB-serial adapter, 38400 8N1. On a
   480/481/482/442 network, connect to the master unit.
2. Options → **Listen only**, then Connect. Power-cycle the unit and watch the traffic log: does it
   send `HELLO` (0xFF), keepalives (0x8C), a `NETWORK_IDENTIFY` (single unit) or a
   `NETWORK_DID_CONFIG` (network master) on its own?
3. Disconnect, untick Listen only, Connect again. The app sends 16 × 0xFF every 250 ms until the
   unit answers. It then waits for `NETWORK_IDENTIFY` or `NETWORK_DID_CONFIG`, attaches to every
   unit announced, and runs DriveWare's connect sequence on the selected one.
4. **Export** the log after each attempt; the exported text is what we need to correct the notes.

If no unit identifies itself within 2 s, the app falls back to the host/device addresses in
Options (default 0x00 / 0x01). DriveWare never does this. Requests the device ignores (input type,
prompt, value text) are asked once and then skipped; the Device card's Link details show which ones
were answered, along with the address source, model family and utility layout.

On a network, the Network card lists every address: master (ID 0), slaves (ID 1-99) and a 480R
remote (listed but not editable). Click a unit to edit it. Each unit is read fully the first time
it is selected, which takes a while at 38400 baud; until then only its model and name are read.

## Layout

| File | Role |
|---|---|
| `public/js/frame.js` | CRC-8 (Dallas, init 0xFF), frame encoder, incremental parser |
| `public/js/link.js` | hello/resync link-up, stop-and-wait ACK/NAK, resends, keepalive, 8 s RX watchdog |
| `public/js/messages.js` | message IDs, request builders, reply decoders |
| `public/js/models.js` | per-model table: type codes, family, outputs, utility layout, slider ranges |
| `public/js/network.js` | discovery (`NETWORK_IDENTIFY` / `NETWORK_DID_CONFIG`), one session per unit |
| `public/js/session.js` | one unit: connect sequence, FX/parameter walk, writes |
| `public/js/sim.js` | simulated units and networks for every model (device side of the same link layer) |
| `public/js/transport.js` | Web Serial transport and an in-memory loopback |
| `public/js/peq.js` | PEQ graph: finds bands by display text, draws the biquad response, drag/keyboard editing |
| `public/js/xover.js` | Crossover graph: finds HP/LP filter pairs by display text, draws BS/BW/LR responses per band |
| `public/js/app.js` | UI, signal-flow diagram and traffic log |

## Guesses to check on hardware

- `PARAM_REQUEST_REPLY_STRING` (0xA3) and the fx/param bytes of its reply: DriveWare never sends it.
- Output mute mask bit order (bit 0 = output 1), and the output counts per model in `models.js`.
- On a network, that the master forwards slave replies with the slave's address as source.
- `PROGRAM_REPLY_GLOBAL_DATA`: the app reads program names for `[2..3] + [4..5]` programs and treats
  the first count as user programs, numbered like the front panel: wire index n = program n+1, so
  1-25 User and 26-50 Factory on the 260 (manual 3.4, A.6); other models are read the same way. A store to a factory program is expected to land in
  the matching user slot, so the app reads back the slot named in `DID_STORE`.
- Crossover display text: the graph expects a frequency (`"1.25 kHz"` or `"Out"`) next to a type
  such as `"LR 24"`, and HP/LP in the prompt. The manual lists 12 types (BS and BW 6/12/18/24, LR
  12/24/36/48), so input type 0x58 is given 0..11; the 24x bank only shows 0..3 and the raw order
  is unknown. The simulator invents both.
- Slider ranges come from the manuals and DriveWare's program banks, per model family, for a few
  input types; other parameters get a stepper because the device does not report ranges.
- 48x/24x/442 parameter names: DriveWare has built-in tables for these and rarely asks the unit.
  If a unit does not answer the prompt and input-type requests, its parameters show as
  "Parameter n".
- Meters, RTA and the wizards are not available over serial.
