// Byte-level framing for the DriveRack serial link (PROTOCOL.md sections 2 and 3).
//
//   dst, src (bit 7 = reliable), [seq if reliable], len (0 = 256), payload[len], crc8
//
// Outside a frame, a byte with bit 7 set is a single-byte control code.

export const CTRL = Object.freeze({
  ACK: 0xa5,
  NAK: 0xda,
  HELLO: 0xff,
  RESYNC: 0xf0,
  KEEPALIVE: 0x8c,
});

// Dallas/Maxim CRC-8: reflected polynomial 0x8C, init 0xFF, no final XOR.
const CRC_TABLE = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let b = 0; b < 8; b++) c = c & 1 ? (c >>> 1) ^ 0x8c : c >>> 1;
    t[i] = c;
  }
  return t;
})();

export function crc8(bytes, crc = 0xff) {
  for (const b of bytes) crc = CRC_TABLE[crc ^ b];
  return crc;
}

export function encodeFrame({ dst, src, reliable = false, seq = 0, payload }) {
  if (dst > 0x7f || src > 0x7f) throw new RangeError("addresses are 7-bit");
  if (payload.length < 1 || payload.length > 256) throw new RangeError("payload must be 1..256 bytes");
  const head = reliable ? [dst, src | 0x80, seq & 0xff] : [dst, src];
  const out = new Uint8Array(head.length + 2 + payload.length);
  out.set(head, 0);
  out[head.length] = payload.length & 0xff;
  out.set(payload, head.length + 1);
  out[out.length - 1] = crc8(out.subarray(0, out.length - 1));
  return out;
}

// Incremental receiver. Calls onControl(byte) for control bytes between frames and
// onFrame(frame) for every complete frame; frame.crcOk tells whether the CRC matched.
export class FrameParser {
  constructor({ onControl, onFrame }) {
    this.onControl = onControl;
    this.onFrame = onFrame;
    this.reset();
  }

  reset() {
    this.state = "idle";
    this.buf = [];
    this.need = 0;
  }

  get inFrame() {
    return this.state !== "idle";
  }

  push(bytes) {
    for (const b of bytes) this.#byte(b);
  }

  #byte(b) {
    switch (this.state) {
      case "idle":
        if (b & 0x80) {
          this.onControl(b);
          return;
        }
        this.buf = [b];
        this.state = "src";
        return;
      case "src":
        this.buf.push(b);
        this.state = b & 0x80 ? "seq" : "len";
        return;
      case "seq":
        this.buf.push(b);
        this.state = "len";
        return;
      case "len":
        this.buf.push(b);
        this.need = b === 0 ? 256 : b;
        this.state = "payload";
        return;
      case "payload":
        this.buf.push(b);
        if (--this.need === 0) this.state = "crc";
        return;
      case "crc": {
        const raw = Uint8Array.from([...this.buf, b]);
        const reliable = (raw[1] & 0x80) !== 0;
        const off = reliable ? 3 : 2;
        const frame = {
          dst: raw[0],
          src: raw[1] & 0x7f,
          reliable,
          seq: reliable ? raw[2] : null,
          payload: raw.slice(off + 1, raw.length - 1),
          crc: b,
          crcOk: crc8(raw.subarray(0, raw.length - 1)) === b,
          raw,
        };
        this.reset();
        this.onFrame(frame);
        return;
      }
    }
  }
}
