/**
 * TC Electronic G-System SysEx preset dumps.
 *
 * Layout of a preset dump (1044 bytes), as observed in dumps produced by the unit:
 *
 *     F0 00 20 1F <dev> 55 20 01 <num_hi> <num_lo> <1032 nibbles> <checksum> F7
 *
 * - 00 20 1F is TC Electronic's manufacturer ID, 55 the G-System model ID.
 * - The preset number is a 14-bit value; user presets start at 100 (slot 0 = 100).
 * - Each payload byte is sent as two nibbles, high nibble first (516 bytes).
 * - The checksum is the sum of all nibbles, masked to 7 bits.
 * - The name is the first 20 payload bytes. Bit 7 of some name bytes is set by the
 *   unit; its meaning is unknown, so it is displayed masked and always preserved.
 */

export const SYSEX_START = 0xf0;
export const SYSEX_END = 0xf7;
export const TC_MANUFACTURER = [0x00, 0x20, 0x1f] as const;
export const MODEL_G_SYSTEM = 0x55;
export const MSG_PRESET = [0x20, 0x01] as const;
export const DEVICE_ID_ALL = 0x7f;

export const HEADER_LEN = 10;
export const PRESET_DATA_LEN = 516;
export const PRESET_DUMP_LEN = HEADER_LEN + 2 * PRESET_DATA_LEN + 2;
export const NAME_LEN = 20;

export const USER_PRESET_BASE = 100;
export const USER_SLOTS = 200;

export class SysexError extends Error {}
export class ChecksumError extends SysexError {}

export function nibblesToBytes(nibbles: Uint8Array): Uint8Array {
  if (nibbles.length % 2) throw new SysexError("odd nibble count");
  const out = new Uint8Array(nibbles.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = nibbles[2 * i];
    const lo = nibbles[2 * i + 1];
    if (hi > 0x0f || lo > 0x0f) throw new SysexError("nibble value above 0x0F");
    out[i] = (hi << 4) | lo;
  }
  return out;
}

export function bytesToNibbles(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length * 2);
  data.forEach((b, i) => {
    out[2 * i] = b >> 4;
    out[2 * i + 1] = b & 0x0f;
  });
  return out;
}

export function checksum(nibbles: Uint8Array): number {
  let sum = 0;
  for (const n of nibbles) sum += n;
  return sum & 0x7f;
}

/** Split a raw byte stream (e.g. a .syx file) into complete SysEx messages. */
export function splitSysex(stream: Uint8Array): Uint8Array[] {
  const messages: Uint8Array[] = [];
  let start = -1;
  stream.forEach((b, i) => {
    if (b === SYSEX_START) start = i;
    else if (b === SYSEX_END && start >= 0) {
      messages.push(stream.slice(start, i + 1));
      start = -1;
    }
  });
  return messages;
}

export function isPresetDump(msg: Uint8Array): boolean {
  return (
    msg.length === PRESET_DUMP_LEN &&
    msg[0] === SYSEX_START &&
    msg[1] === TC_MANUFACTURER[0] &&
    msg[2] === TC_MANUFACTURER[1] &&
    msg[3] === TC_MANUFACTURER[2] &&
    msg[5] === MODEL_G_SYSTEM &&
    msg[6] === MSG_PRESET[0] &&
    msg[7] === MSG_PRESET[1] &&
    msg[msg.length - 1] === SYSEX_END
  );
}

export function sameBytes(a: Uint8Array | null | undefined, b: Uint8Array | null | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class Preset {
  readonly data: Uint8Array;

  constructor(
    readonly number: number,
    data: Uint8Array,
    readonly deviceId: number = DEVICE_ID_ALL,
    /** Checksum found in the source dump; null when the preset was built in memory. */
    readonly sourceChecksum: number | null = null,
  ) {
    if (data.length !== PRESET_DATA_LEN) {
      throw new SysexError(`preset data must be ${PRESET_DATA_LEN} bytes, got ${data.length}`);
    }
    if (number < 0 || number >= 1 << 14) throw new SysexError(`preset number out of range: ${number}`);
    this.data = data;
  }

  /** Parse a preset dump. With strict=false a checksum mismatch is kept, not raised. */
  static fromSysex(msg: Uint8Array, strict = true): Preset {
    if (!isPresetDump(msg)) throw new SysexError("not a G-System preset dump");
    const nibbles = msg.slice(HEADER_LEN, msg.length - 2);
    const stored = msg[msg.length - 2];
    if (strict && checksum(nibbles) !== stored) {
      throw new ChecksumError(`checksum mismatch: stored ${stored}, computed ${checksum(nibbles)}`);
    }
    return new Preset((msg[8] << 7) | msg[9], nibblesToBytes(nibbles), msg[4], stored);
  }

  /** Build a dump; the checksum is always recomputed from the data. */
  toSysex(number = this.number, deviceId = this.deviceId): Uint8Array {
    const nibbles = bytesToNibbles(this.data);
    const out = new Uint8Array(PRESET_DUMP_LEN);
    out.set([SYSEX_START, ...TC_MANUFACTURER, deviceId, MODEL_G_SYSTEM, ...MSG_PRESET, number >> 7, number & 0x7f]);
    out.set(nibbles, HEADER_LEN);
    out[PRESET_DUMP_LEN - 2] = checksum(nibbles);
    out[PRESET_DUMP_LEN - 1] = SYSEX_END;
    return out;
  }

  get checksumOk(): boolean {
    return this.sourceChecksum === null || this.sourceChecksum === checksum(bytesToNibbles(this.data));
  }

  get name(): string {
    let s = "";
    for (const b of this.data.slice(0, NAME_LEN)) {
      const c = b & 0x7f;
      s += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : " ";
    }
    return s.trimEnd();
  }

  withName(name: string): Preset {
    const encoded = new Uint8Array(NAME_LEN).fill(0x20);
    for (let i = 0; i < Math.min(name.length, NAME_LEN); i++) {
      const c = name.charCodeAt(i);
      if (c < 0x20 || c > 0x7e) throw new SysexError("name must be printable ASCII");
      encoded[i] = c;
    }
    const data = this.data.slice();
    // Keep the unit's bit 7 flags on each name byte.
    for (let i = 0; i < NAME_LEN; i++) data[i] = (this.data[i] & 0x80) | encoded[i];
    return new Preset(this.number, data, this.deviceId);
  }

  withNumber(number: number): Preset {
    return new Preset(number, this.data, this.deviceId);
  }

  withData(data: Uint8Array): Preset {
    return new Preset(this.number, data, this.deviceId);
  }

  get userSlot(): number | null {
    const slot = this.number - USER_PRESET_BASE;
    return slot >= 0 && slot < USER_SLOTS ? slot : null;
  }
}

export function userNumber(slot: number): number {
  if (slot < 0 || slot >= USER_SLOTS) throw new SysexError(`user slot out of range: ${slot}`);
  return USER_PRESET_BASE + slot;
}
