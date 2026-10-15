# DESIGN.md

Direction chosen 2026-10-14: **rack hardware**. Written by Claude from that one-word choice, so treat
it as a starting point and overwrite anything that does not match your taste.

Design read: a companion control surface for live-sound engineers and installers, in the visual
language of the 260's own front panel. Dial: ENERGY 2 / RHYTHM 2 / MOTION 1.

Restyled 2026-10-15 after two references from the user: a Eurorack module panel (Ginkosynthese
Sampleslicer: aluminum, black knobs, red name pill, slotted corners) and a rack of vintage
outboard compressors (black faceplates, amber backlit VU meters). Synthesis: **aluminum modules
mounted in a black rack.** Cards are faceplates with corner mounting slots and a red name pill;
the top bar and traffic log are black rack units; controls are black keycaps.

## Identity motif

Meter glass. Every value the device itself reported sits on an amber backlit meter face,
monospace, tabular figures, black ink (param readouts, PEQ/crossover graphs). Values we only sent
(not yet confirmed) are dimmed, like an unlit meter. The motif tells the user what the hardware
actually says versus what the app assumes, which is the main honesty problem of an untested
protocol.

## Color (one reason each)

| Token | Use | Why |
|---|---|---|
| `--bg` `--rack` (black), `--alu` (aluminum), `--key` `--well` (black controls) | everything structural | rack + module panels, keeps colors meaningful. `.card` flips `--text`/`--muted` to dark ink |
| `--glass` amber + `--ink` | device-confirmed values, graphs | backlit VU meter face |
| `--brand` red | card title pills, brand pill only | the panel's silkscreened name pill; deeper than `--mute` |
| `--signal` green | link LED, "passing" output LED, switch on | green = signal present on hardware |
| `--mute` red | mute state, overwrite/destructive actions, protocol errors | red = muted/danger on every console; never used for selection |
| `--warn` amber | the as-is footer, linking state | caution, distinct from danger |
| `--text` off-white | selection border, focus ring, primary button | selection is not a status, so it gets no hue |

## Type

Loaded from Google Fonts (the CSP allows `fonts.googleapis.com` / `fonts.gstatic.com`), all SIL
OFL. Offline, `font-display: swap` falls back to the system stacks:
- **Barlow** 400/600 for UI text: industrial, DIN-like, narrow enough for dense tables.
- **JetBrains Mono** (variable) with `tabular-nums` for readouts, addresses and the traffic log:
  digits must not jump while a fader moves.
- **Saira** (variable width) as `--label`, bold semi-expanded uppercase: the Eurostile-style
  silkscreen of rack gear. Card titles (red pill), sub-labels (rule underneath, like SAMPLE/GAIN), block names,
  table heads, mute keys.

## Layout

- Signal chain drawn as the manual's A.7 diagram: input lanes, the crossover as one tall routing
  block where the inputs split, then one lane per output ending in its mute LED and jack.
  Inferred from each block's in/out channel; falls back to a flat row when the shape does not fit.
- PEQ blocks get a frequency-response graph (log 20 Hz..20 kHz, +-15 dB) with one draggable
  point per band; the parameter table stays below for exact values. Grid lines are the axis
  reference, not decoration.
- Top bar: Connect serial is a split button; Run simulator lives in its menu. While linked, the
  group is swapped for Disconnect. The as-is disclaimer sits in the footer.
- Traffic pane toggles from a fixed button at the bottom right (z-index above popovers); its LED
  is lit while the pane is shown, and the choice is kept in localStorage.
- Mute buttons look like lit hardware switches (LED + label); the system mute spans full width.
- Radius 3px everywhere except the name pills: machined edges.
- Selected block = lit keycap (ivory face, black ring). Selection still gets no hue.

## Motion (MOTION 1)

Hover/press feedback only, plus the Options popover opening from its button. PEQ points
follow the pointer directly while dragged (direct manipulation, no easing). No motion on
selection, parameter changes or log rows: those happen hundreds of times a session.

## Theme

Two panel finishes, same black rack chrome: **silver** and **black** for dark front-of-house
positions. The top-bar button cycles system (follows `prefers-color-scheme`, live) → sun (silver) →
moon (black); default system. `js/panel.js` is loaded in `<head>` so the stored choice applies
before first paint; kept in localStorage. Each finish sets
the surface tokens on `.card`/`.options-panel` (`--face`, `--text`, `--wire`, `--cap`...); meter
glass, keys and LEDs are shared.
