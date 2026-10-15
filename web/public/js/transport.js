// Byte transports. Each exposes write(bytes), onData(callback) and close().

// Web Serial (Chrome/Edge 89+, needs https or http://localhost).
export class SerialTransport {
  static get supported() {
    return typeof navigator !== "undefined" && "serial" in navigator;
  }

  #port;
  #reader = null;
  #writer = null;
  #onData = () => {};
  #onClose = () => {};
  #closing = false;

  onData(fn) {
    this.#onData = fn;
  }

  onClose(fn) {
    this.#onClose = fn;
  }

  // DriveWare: 38400 8N1, no flow control, RTS and DTR asserted.
  async open({ baudRate = 38400 } = {}) {
    this.#port = await navigator.serial.requestPort();
    await this.#port.open({ baudRate, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none", bufferSize: 0x2800 });
    await this.#port.setSignals({ dataTerminalReady: true, requestToSend: true }).catch(() => {});
    this.#writer = this.#port.writable.getWriter();
    this.#readLoop();
    return this.#port.getInfo();
  }

  write(bytes) {
    this.#writer?.write(bytes).catch((err) => console.error("serial write failed", err));
  }

  async #readLoop() {
    // Framing/parity/break errors end one reader but leave port.readable usable.
    while (this.#port?.readable && !this.#closing) {
      this.#reader = this.#port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.#reader.read();
          if (done) break;
          if (value?.length) this.#onData(value);
        }
      } catch (err) {
        if (!this.#closing) console.warn("serial read error", err);
      } finally {
        this.#reader.releaseLock();
      }
    }
    if (!this.#closing) this.#onClose("port lost");
  }

  async close() {
    this.#closing = true;
    try {
      await this.#reader?.cancel();
      this.#writer?.releaseLock();
      await this.#port?.close();
    } catch (err) {
      console.warn("closing serial port", err);
    }
    this.#onClose("closed");
  }
}

// Two connected in-memory endpoints. bytesPerMs throttles like a real line
// (38400 baud 8N1 = 3.84 bytes/ms); corrupt(bytes) may return altered bytes.
export function createLoopback({ bytesPerMs = Infinity, corrupt = null } = {}) {
  const make = () => ({ listener: () => {}, busyUntil: 0 });
  const ends = [make(), make()];
  let closed = false;
  const endpoint = (self, peer) => ({
    write(bytes) {
      if (closed) return;
      let data = Uint8Array.from(bytes);
      if (corrupt) data = corrupt(data);
      const now = Date.now();
      const start = Math.max(now, self.busyUntil);
      self.busyUntil = start + data.length / bytesPerMs;
      const delay = Number.isFinite(bytesPerMs) ? Math.ceil(self.busyUntil - now) : 0;
      setTimeout(() => !closed && peer.listener(data), delay);
    },
    onData(fn) {
      self.listener = fn;
    },
    onClose() {},
    close() {
      closed = true;
    },
  });
  return [endpoint(ends[0], ends[1]), endpoint(ends[1], ends[0])];
}
