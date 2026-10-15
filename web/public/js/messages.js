// Application layer: message IDs, request builders and reply decoders (PROTOCOL.md section 4).
// Payload offsets match PROTOCOL.md: [0..1] = uint16 LE message ID, [2] = first data byte.
// Layouts marked "guessed" have no sender in DriveWare, so they are not backed by code.

import { MESSAGE_TABLE } from "./message-table.js";

export const MSG = {};
export const MSG_INFO = new Map();
for (const [id, min, max, name] of MESSAGE_TABLE) {
  MSG_INFO.set(id, { id, min, max, name });
  if (!name.includes("?")) MSG[name.replace(/^MSG_/, "")] = id;
}

export const msgName = (id) => MSG_INFO.get(id)?.name.replace(/^MSG_/, "") ?? `0x${hex(id, 4)}`;

export const hex = (n, width = 2) => n.toString(16).toUpperCase().padStart(width, "0");
export const hexBytes = (bytes) => Array.from(bytes, (b) => hex(b)).join(" ");

export const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];
export const readU16 = (p, off) => p[off] | (p[off + 1] << 8);

export function payload(id, ...data) {
  return Uint8Array.from([...u16(id), ...data.flat()]);
}

const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0) & 0x7f);

function cstr(p, off, len = p.length - off) {
  let s = "";
  for (let i = off; i < Math.min(p.length, off + len) && p[i] !== 0; i++) s += String.fromCharCode(p[i]);
  return s.trimEnd();
}

// ---- requests (host -> device) ----

export const req = {
  guiIdentify: () => payload(MSG.GUI_IDENTIFY, u16(3)), // DriveWare always sends 3
  attach: () => payload(MSG.SYSTEM_DO_ATTACH),
  deviceData: () => payload(MSG.SYSTEM_REQUEST_DEVICE_DATA),
  deviceName: () => payload(MSG.SYSTEM_REQUEST_DEVICE_NAME),
  writeDeviceName: (name) => payload(MSG.SYSTEM_WRITE_DEVICE_NAME, ascii(name), 0),
  numberFx: () => payload(MSG.CONFIG_REQUEST_NUMBER_FX),
  globalData: () => payload(MSG.PROGRAM_REQUEST_GLOBAL_DATA),
  currentProgram: () => payload(MSG.PROGRAM_REQUEST_CURRENT),
  currentName: () => payload(MSG.PROGRAM_REQUEST_CURRENT_NAME),
  programName: (n) => payload(MSG.PROGRAM_REQUEST_NAME, n),
  retrieve: (n) => payload(MSG.PROGRAM_DO_RETRIEVE, n),
  load: () => payload(MSG.PROGRAM_DO_LOAD),
  // mode byte: 0xFF when DriveWare inserts a new program, 0x00 when it overwrites
  store: (n, name, insert = false) => payload(MSG.PROGRAM_DO_STORE, n, insert ? 0xff : 0x00, ascii(name), 0),
  configAll: (n) => payload(MSG.CONFIG_REQUEST_ALL, n),
  fxData: (fx) => payload(MSG.CONFIG_REQUEST_FX_DATA, fx),
  fxName: (fx) => payload(MSG.CONFIG_REQUEST_FX_NAME, fx),
  fxInOut: (fx) => payload(MSG.CONFIG_REQUEST_FX_IN_OUT, fx),
  paramAll: () => payload(MSG.PARAM_REQUEST_ALL),
  paramAllInFx: (fx) => payload(MSG.PARAM_REQUEST_ALL_IN_FX, fx),
  paramWrite: (fx, p, v) => payload(MSG.PARAM_WRITE, fx, p, u16(v)),
  paramInputType: (fx, p) => payload(MSG.PARAM_REQUEST_INPUT_TYPE, fx, p),
  paramPrompt: (fx, p) => payload(MSG.PARAM_REQUEST_PROMPT_STRING, fx, p),
  paramText: (fx, p) => payload(MSG.PARAM_REQUEST_REPLY_STRING, fx, p), // guessed layout
  muteStatus: () => payload(MSG.CONFIG_MUTE_STATUS_REQUEST),
  writeMuteStatus: (mask) => payload(MSG.CONFIG_WRITE_MUTE_STATUS, mask),
  systemMute: () => payload(MSG.CONFIG_SYSTEM_MUTE_REQUEST),
  writeSystemMute: (on) => payload(MSG.CONFIG_WRITE_SYSTEM_MUTE, on ? 1 : 0),
  utility: () => payload(MSG.UTILITY_REQUEST),
};

// ---- replies (device -> host) ----

// Device type character in SYSTEM_REPLY_DEVICE_DATA [7].
export const DEVICE_TYPES = {
  0x30: "DriveRack 480",
  0x31: "DriveRack 481",
  0x32: "DriveRack 482",
  0x41: "DriveRack 240",
  0x42: "DriveRack 241",
  0x43: "DriveRack 442 (inferred)",
  0x45: "DriveRack 260",
  0x46: "device type 12 (unknown)",
  0x27: "DriveRack 220i",
};

const decoders = {
  [MSG.NETWORK_IDENTIFY]: (p) => (p.length > 2 ? { generation: p[2] } : {}),
  [MSG.SYSTEM_REPLY_DEVICE_DATA]: (p) => {
    const digits = String.fromCharCode(...p.slice(3, 7));
    return {
      firmware: /^\d{4}$/.test(digits) ? `${digits[0]}.${digits.slice(1)}` : digits,
      typeChar: String.fromCharCode(p[7]),
      model: DEVICE_TYPES[p[7]] ?? `unknown type '${String.fromCharCode(p[7])}'`,
    };
  },
  [MSG.SYSTEM_REPLY_DEVICE_NAME]: (p) => ({ name: cstr(p, 2) }),
  [MSG.PROGRAM_REPLY_CURRENT]: (p) => ({ program: p[2] }),
  [MSG.PROGRAM_REPLY_CURRENT_NAME]: (p) => ({ name: cstr(p, 4) }),
  [MSG.PROGRAM_REPLY_NAME]: (p) => ({ program: p[2], name: cstr(p, 4) }),
  [MSG.PROGRAM_DID_STORE]: (p) => ({ program: p[2] }),
  [MSG.PROGRAM_DID_RETRIEVE]: (p) => ({ program: p[2] }),
  [MSG.PROGRAM_DID_LOAD]: (p) => ({ program: p[2] }),
  // DriveWare requests names for programs 0 .. a+b-1 (inferred: factory + user counts).
  [MSG.PROGRAM_REPLY_GLOBAL_DATA]: (p) => ({ a: readU16(p, 2), b: readU16(p, 4), c: readU16(p, 6) }),
  [MSG.CONFIG_REPLY_NUMBER_FX]: (p) => ({ count: p[2] }),
  [MSG.CONFIG_REPLY_FX_DATA]: (p) => ({ fx: p[2], type: p[3], descriptor: Array.from(p.slice(4, 10)) }),
  [MSG.CONFIG_REPLY_FX_NAME]: (p) => ({ fx: p[2], name: cstr(p, 4) }),
  [MSG.CONFIG_REPLY_FX_IN_OUT]: (p) => ({ fx: p[2], in: p[3], out: p[4] }),
  [MSG.PARAM_REPLY_ALL_IN_FX]: (p) => {
    const values = [];
    for (let off = 5; off + 1 < p.length; off += 2) values.push(readU16(p, off));
    return { fx: p[3], values };
  },
  [MSG.PARAM_REPLY]: (p) => ({ fx: p[3], param: p[4], value: readU16(p, 6) }),
  [MSG.PARAM_REPLY_INPUT_TYPE]: (p) => ({ fx: p[2], param: p[3], inputType: p[4] }),
  [MSG.PARAM_REPLY_PROMPT_STRING]: (p) => ({ fx: p[2], param: p[3], prompt: cstr(p, 4) }),
  [MSG.PARAM_REPLY_STRING]: (p) => ({ fx: p[2], param: p[3], text: cstr(p, 4, 16).trim() }), // fx/param guessed
  [MSG.PARAM_TYPE_REPLY_STRING]: (p) => ({ text: cstr(p, 5, 16).trim() }),
  [MSG.CONFIG_MUTE_STATUS_REPLY]: (p) => ({ mask: p[2] }),
  [MSG.CONFIG_SYSTEM_MUTE_REPLY]: (p) => ({ muted: p[2] === 1 || p[2] === 0x81, raw: p[2] }),
  [MSG.UTILITY_REPLY]: (p) => ({ bytes: p.length - 2 }),
  [MSG.ERROR_INVALID_MESSAGE]: (p) => ({ error: true, code: readU16(p, 2) }),
  [MSG.ERROR_INVALID_LENGTH]: (p) => ({ error: true, code: readU16(p, 2) }),
  [MSG.ERROR_INVALID_PARAMETER]: (p) => ({ error: true, code: readU16(p, 2) }),
};

export function decode(p) {
  const id = p.length >= 2 ? readU16(p, 0) : -1;
  const info = MSG_INFO.get(id);
  const out = { id, name: msgName(id), fields: {}, warning: null };
  if (!info) out.warning = "unknown message ID";
  else if (p.length < info.min || p.length > info.max)
    out.warning = `length ${p.length} outside ${info.min}..${info.max}`;
  const dec = decoders[id];
  if (dec) {
    try {
      out.fields = dec(p);
    } catch (err) {
      out.warning = `decode failed: ${err.message}`;
    }
  }
  return out;
}

export function describeFields(fields) {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? (v.length > 12 ? `[${v.length} values]` : `[${v.join(",")}]`) : JSON.stringify(v)}`)
    .join(" ");
}
