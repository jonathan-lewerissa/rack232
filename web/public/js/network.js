// Finds the units on the serial link and keeps one Session per unit (PROTOCOL.md 4.1).
//
// DriveWare sends nothing until a device speaks first:
// - a single unit (260, 220i, a lone 24x) sends NETWORK_IDENTIFY: our address is the frame's dst,
//   the unit's is its src;
// - a 48x/442 network master (address 0) sends NETWORK_DID_CONFIG: our address is the dst and the
//   payload is a bitmap of every address on the network. Unit IDs are addresses: 0 = master,
//   1..99 = slaves, 0x7D = 480R remote.
// If neither arrives the app falls back to fixed addresses from Options, which DriveWare never does.

import { Emitter } from "./emitter.js";
import { MSG, decode, hex } from "./messages.js";
import { ADDR, MAX_UNIT_ID } from "./models.js";
import { Session } from "./session.js";

export const DEFAULT_OPTIONS = Object.freeze({
  fallbackHostAddr: 0x00,
  fallbackDeviceAddr: ADDR.SINGLE, // DriveWare's single-unit slot is address 1
  identifyWaitMs: 2000,
  session: {}, // options for each unit's Session
});

export function nodeLabel(addr) {
  if (addr === ADDR.REMOTE_480R) return "480R remote";
  if (addr === ADDR.SYSCON) return "System control";
  if (addr <= MAX_UNIT_ID) return addr === ADDR.MASTER ? "Master (ID 0)" : `ID ${addr}`;
  return `Address 0x${hex(addr)}`;
}

export class Network extends Emitter {
  #link;
  #epoch = 0;
  #found = null; // resolves the wait for IDENTIFY / DID_CONFIG
  #queue = Promise.resolve(); // session operations started by the network run one at a time

  constructor(link, options = {}) {
    super();
    this.#link = link;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.#reset();
    link.on("frame", (f) => this.#onFrame(f));
    link.on("state", (state) => {
      this.#epoch++;
      this.#found?.();
      this.#reset();
      this.emit("change");
      if (state === "active") this.#bringUp(this.#epoch);
    });
  }

  // Every address on the link. Units (address <= 99) have a session; others (480R) are listed only.
  get nodes() {
    return this.addresses.map((addr) => ({ addr, label: nodeLabel(addr), session: this.sessions.get(addr) ?? null }));
  }

  get selected() {
    return this.sessions.get(this.selectedAddr) ?? null;
  }

  // Make a unit the one being edited, reading it fully the first time.
  select(addr) {
    if (!this.sessions.has(addr)) return;
    this.selectedAddr = addr;
    this.emit("change");
    this.#enqueue(this.#epoch, () => this.#ensureLoaded(this.sessions.get(addr)));
  }

  // ---- discovery ----

  #reset() {
    for (const s of this.sessions?.values() ?? []) s.dispose();
    this.hostAddr = null;
    this.addressesFrom = null; // "identify" | "network" | "fallback"
    this.generation = null;
    this.addresses = [];
    this.sessions = new Map();
    this.selectedAddr = null;
  }

  async #bringUp(epoch) {
    this.#status("Link up, waiting for the device to identify itself…");
    if (this.hostAddr == null) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, this.options.identifyWaitMs);
        this.#found = () => (clearTimeout(timer), resolve());
      });
      this.#found = null;
    }
    if (epoch !== this.#epoch || this.hostAddr != null) return;
    this.#status("No NETWORK_IDENTIFY or NETWORK_DID_CONFIG; trying the fallback addresses from Options…");
    this.#setTopology({
      hostAddr: this.options.fallbackHostAddr,
      addresses: [this.options.fallbackDeviceAddr],
      addressesFrom: "fallback",
    });
  }

  #onFrame(frame) {
    const { id, fields } = decode(frame.payload);
    if (id === MSG.NETWORK_IDENTIFY) {
      this.#setTopology({ hostAddr: frame.dst, addresses: [frame.src], addressesFrom: "identify", generation: fields.generation });
    } else if (id === MSG.NETWORK_DID_CONFIG && frame.src === ADDR.MASTER) {
      // The bitmap may include our own address; it is not a unit.
      const addresses = fields.addresses.filter((a) => a !== frame.dst);
      this.#setTopology({ hostAddr: frame.dst, addresses, addressesFrom: "network" });
    }
  }

  // Keep the sessions of units that are still present at the same addresses, drop the rest, and
  // attach to new ones. The selected unit is read fully; the others only identify themselves.
  #setTopology({ hostAddr, addresses, addressesFrom, generation = null }) {
    this.#found?.();
    const epoch = this.#epoch;
    const sameHost = hostAddr === this.hostAddr && addressesFrom === this.addressesFrom;
    if (sameHost && addresses.length === this.addresses.length && addresses.every((a) => this.addresses.includes(a))) return;
    for (const [addr, s] of this.sessions) {
      if (!sameHost || !addresses.includes(addr)) {
        s.dispose();
        this.sessions.delete(addr);
      }
    }
    Object.assign(this, { hostAddr, addressesFrom, generation, addresses: [...addresses].sort((a, b) => a - b) });
    const added = [];
    for (const addr of this.addresses) {
      if (addr > MAX_UNIT_ID || this.sessions.has(addr)) continue;
      const session = new Session(this.#link, { hostAddr, deviceAddr: addr, addressesFrom, generation }, {
        ...this.options.session,
        anySource: addressesFrom === "fallback",
      });
      session.on("change", (kind, detail) => this.emit("session-change", session, kind, detail));
      session.on("status", (text) => this.emit("session-status", session, text));
      this.sessions.set(addr, session);
      added.push(session);
    }
    if (!this.sessions.has(this.selectedAddr)) this.selectedAddr = this.sessions.keys().next().value ?? null;
    this.#status(addressesFrom === "network"
      ? `Network master reports ${this.addresses.length} address${this.addresses.length === 1 ? "" : "es"}: ${this.addresses.map(nodeLabel).join(", ")}`
      : `Unit at 0x${hex(addresses[0])} (${addressesFrom})`);
    this.emit("change");
    for (const s of added) {
      this.#enqueue(epoch, async () => {
        await s.attach();
        if (s === this.selected) await this.#ensureLoaded(s);
        else await s.identify();
      });
    }
  }

  async #ensureLoaded(session) {
    if (session && !session.model.loaded && !session.busy && this.sessions.get(session.model.deviceAddr) === session) {
      await session.refresh();
    }
  }

  #enqueue(epoch, fn) {
    this.#queue = this.#queue.then(async () => {
      if (epoch !== this.#epoch) return;
      try {
        await fn();
      } catch (err) {
        if (epoch === this.#epoch) this.#status(`Stopped: ${err.message}`);
      }
    });
  }

  #status(text) {
    this.status = text;
    this.emit("status", text);
  }
}
