// The DriveWare 2.6.2 device family. Everything here comes from static analysis of DriveWare
// (see re/PROTOCOL.md 4.1 and 4.5) unless marked inferred; none of it is checked on hardware.
//
// typeChar   SYSTEM_REPLY_DEVICE_DATA [7]
// family     DriveWare treats these groups alike (program banks, FX tables, utility layout)
// generation protocol generation DriveWare ends up with (IDENTIFY [2], overridden for 24x/220i)
// utility    UTILITY_REPLY payload length (with the 2-byte ID) DriveWare accepts and writes back
// outputs    output count, so the width of the mute bitmask in use
// firmware   firmware DriveWare 2.6.2 was built for ("Developed for use with")
// ranges     slider ranges by PARAM_REPLY_INPUT_TYPE, from the manual or DriveWare's embedded program
//            banks; values only seen in a bank are the largest seen, not a confirmed maximum

const COMMON_RANGES = {
  0x0c: { max: 1, toggle: true }, // on/off
  0x14: { max: 48, fader: true }, // GEQ band gain, 24 = 0 dB
  0x43: { max: 48, fader: true },
  0x29: { max: 36 }, // output phase, 5 degree steps
  0x06: { max: 15 }, // PEQ Q
  0x01: { max: 60 }, // compressor threshold, 40 = 0 dBu
};

const FAMILIES = {
  "48x": {
    family: "48x", generation: 1, utility: 0x4c, outputs: 8, firmware: "2.500",
    ranges: { ...COMMON_RANGES, 0x21: { max: 3 }, 0x22: { max: 3 } }, // crossover slopes, bank 198
  },
  "442": {
    family: "442", generation: 1, utility: 0x4c, outputs: 4, firmware: null,
    ranges: { ...COMMON_RANGES, 0x23: { max: 3 } }, // linked-filter slope, bank 293
  },
  "24x": {
    family: "24x", generation: 2, utility: 0x65, outputs: 4, firmware: "1.060",
    ranges: { ...COMMON_RANGES, 0x58: { max: 3 } }, // crossover slope, bank 229
  },
  "260": {
    family: "260", generation: 3, utility: 0xdb, outputs: 6, firmware: "1.510",
    ranges: { ...COMMON_RANGES, 0x58: { max: 11 } }, // manual 4.7 lists 12 crossover types
  },
  "220i": {
    family: "220i", generation: 4, utility: 0xdb, outputs: 2, firmware: "1.01",
    ranges: COMMON_RANGES,
  },
};

const model = (typeChar, name, family, extra = {}) => ({ typeChar, name, ...FAMILIES[family], ...extra });

export const MODELS = [
  model("0", "DriveRack 480", "48x"),
  model("1", "DriveRack 481", "48x"),
  model("2", "DriveRack 482", "48x"),
  model("C", "DriveRack 442", "442"),
  model("A", "DriveRack 240", "24x"),
  model("B", "DriveRack 241", "24x"),
  model("E", "DriveRack 260", "260"),
  // DriveWare names type 'F' "DriveRack 261" and handles it with the 260; outputs inferred.
  model("F", "DriveRack 261", "260", { firmware: null }),
  model("'", "DriveRack 220i", "220i"),
];

const BY_CHAR = new Map(MODELS.map((m) => [m.typeChar.charCodeAt(0), m]));

export const modelFor = (typeByte) => BY_CHAR.get(typeByte) ?? null;

// Used before DEVICE_DATA arrives, or for an unknown type: the family-independent ranges only.
export const UNKNOWN_MODEL = Object.freeze({ name: null, family: null, outputs: null, ranges: COMMON_RANGES });

// Fixed network addresses. Slaves use their unit ID (1..99) as address.
export const ADDR = Object.freeze({ MASTER: 0x00, SINGLE: 0x01, SYSCON: 0x6f, REMOTE_480R: 0x7d, BROADCAST: 0x7f });
export const MAX_UNIT_ID = 99;

// UTILITY_REPLY variants: payload length -> what DriveWare does with it. The security level offset
// is the only field mapped with confidence; offsets include the 2-byte message ID.
export const UTILITY_LAYOUTS = {
  0x10: { label: "480R remote" },
  0x4c: { label: "48x/442", securityLevel: 53 },
  0x65: { label: "24x", securityLevel: 53 },
  0xdb: { label: "260/220i", securityLevel: 59 },
};
