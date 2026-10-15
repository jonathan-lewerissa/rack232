# DriveRack 260 web port

A browser-based controller for the dbx DriveRack 260 loudspeaker management system, as a
replacement for the Windows-only DriveWare software. It talks to the unit over RS-232 using the
Web Serial API (desktop Chrome or Edge).

**Status: prototype.** The serial protocol was documented from DriveWare 2.6.2 for
interoperability and has not been tested on a real unit yet. A built-in simulator lets you try the app
without hardware.

## Quick start

```sh
cd web
npm start    # http://localhost:8260/  (add ?sim to start the simulator)
npm test
```

No build step and no dependencies; Node is only used for the dev server and tests. Deployment and
first-session notes for real hardware are in [`web/README.md`](web/README.md).

## Repository

| Path | Contents |
|---|---|
| [`web/`](web/) | The app: vanilla JS, served as static files from `web/public` |
| [`re/PROTOCOL.md`](re/PROTOCOL.md) | Serial protocol notes: framing, CRC, link layer, message flow |
| [`re/FUNCTIONALITY.md`](re/FUNCTIONALITY.md) | Manual features vs. what the protocol exposes |
| [`re/messages.tsv`](re/messages.tsv) | Message ID table |
| [`DESIGN.md`](DESIGN.md) | Visual direction and the reason for each design token |

## Disclaimer

This software is provided "as is", without warranty of any kind. Use it at your own risk.
Independent project, not affiliated with Harman or dbx.
