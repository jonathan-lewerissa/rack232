# DriveRack 260 web controller (prototype)

Vanilla JavaScript, no build step, no dependencies. Talks to the DriveRack 260 over RS-232 through
the browser's Web Serial API (desktop Chrome or Edge), using the protocol in
[`../re/PROTOCOL.md`](../re/PROTOCOL.md). That protocol is from static analysis only; nothing here
has run against a real unit yet.

## Run

```sh
cd web
npm start            # node scripts/serve.js -> http://localhost:8260/
npm test             # node --test: framing, CRC, link layer, session against the simulator
```

Open `http://localhost:8260/?sim` to start the built-in simulator immediately. Its signal chain,
ranges and addresses are invented for testing.

## Deploy to Cloudflare Pages

`public/` is the whole site. In the Pages dashboard: framework preset **None**, build command
empty, build output directory **`web/public`**. Or from the CLI:

```sh
npx wrangler pages deploy web/public --project-name driverack-260
```

`public/_headers` sets `Permissions-Policy: serial=(self)` and a strict CSP. Pages serves HTTPS,
which Web Serial requires.

## First session with the hardware

1. Null-modem DB-9 cable (a straight cable will not work), USB-serial adapter, 38400 8N1.
2. Options → **Listen only**, then Connect. Power-cycle the 260 and watch the traffic log: does it
   send `HELLO` (0xFF), keepalives (0x8C) or a `NETWORK_IDENTIFY` on its own?
3. Disconnect, untick Listen only, Connect again. The app sends 16 × 0xFF every 250 ms until the
   unit answers, then runs DriveWare's connect sequence.
4. **Export** the log after each attempt; the exported text is what we need to correct the notes.

If the unit never sends `NETWORK_IDENTIFY`, the app falls back to the host/device addresses in
Options (default 0x00 / 0x01). Requests the device ignores (input type, prompt, value text) are asked
once and then skipped; the Device card shows which ones were answered.

## Layout

| File | Role |
|---|---|
| `public/js/frame.js` | CRC-8 (Dallas, init 0xFF), frame encoder, incremental parser |
| `public/js/link.js` | hello/resync link-up, stop-and-wait ACK/NAK, resends, keepalive, 8 s RX watchdog |
| `public/js/messages.js` | message IDs, request builders, reply decoders |
| `public/js/session.js` | address discovery, connect sequence, FX/parameter walk, writes |
| `public/js/sim.js` | simulated 260 (device side of the same link layer) |
| `public/js/transport.js` | Web Serial transport and an in-memory loopback |
| `public/js/peq.js` | PEQ graph: finds bands by display text, draws the biquad response, drag/keyboard editing |
| `public/js/xover.js` | Crossover graph: finds HP/LP filter pairs by display text, draws BS/BW/LR responses per band |
| `public/js/app.js` | UI, signal-flow diagram and traffic log |

## Guesses to check on hardware

- `PARAM_REQUEST_REPLY_STRING` (0xA3) and the fx/param bytes of its reply: DriveWare never sends it.
- Output mute mask bit order (bit 0 = output 1).
- `PROGRAM_REPLY_GLOBAL_DATA`: the app reads program names for `[2..3] + [4..5]` programs and treats
  the first count as user programs, numbered like the front panel: wire index n = program n+1, so
  1-25 User and 26-50 Factory (manual 3.4, A.6). A store to a factory program is expected to land in
  the matching user slot, so the app reads back the slot named in `DID_STORE`.
- Crossover display text: the graph expects a frequency (`"1.25 kHz"` or `"Out"`) next to a type
  such as `"LR 24"`, and HP/LP in the prompt. The manual lists 12 types (BS and BW 6/12/18/24, LR
  12/24/36/48), so input type 0x58 is given 0..11; the 24x bank only shows 0..3 and the raw order
  is unknown. The simulator invents both.
- Slider ranges come from DriveWare's 24x bank for a few input types; other parameters get a
  stepper because the device does not report ranges.
- Meters, RTA and the wizards are not available over serial.
