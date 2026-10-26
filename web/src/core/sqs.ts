/**
 * Read and write Vyzor/Midi Quest .SQS bank files.
 *
 * An .SQS file is a big-endian IFF container (LIST of FORM BANK). Each bank has
 * a SHDR header naming the instrument and the bank kind ("Preset buffer",
 * "User Bank", "Global", ...) and a BODY holding fixed-size slots, each one
 * either zero-filled (empty) or a SysEx dump followed by zero padding.
 *
 * Only the BODY slots are rewritten; every other byte of the file is kept as is,
 * so files stay readable by Vyzor.
 */

import { Preset, SYSEX_START, USER_SLOTS, SysexError, isPresetDump, splitSysex, userNumber } from "./sysex";

export const USER_BANK_KIND = "User Bank";
export const PRESET_BUFFER_KIND = "Preset buffer";

export class SqsError extends Error {}

export interface Bank {
  instrument: string;
  kind: string;
  bodyOffset: number;
  bodySize: number;
  slotCount: number;
}

const ascii = (bytes: Uint8Array) => String.fromCharCode(...bytes);
const cstr = (bytes: Uint8Array) => {
  const end = bytes.indexOf(0);
  return ascii(end >= 0 ? bytes.slice(0, end) : bytes);
};
const u32 = (d: Uint8Array, o: number) => ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;

function findTag(data: Uint8Array, tag: string, from: number): number {
  const t = [...tag].map((c) => c.charCodeAt(0));
  for (let i = from; i + 4 <= data.length; i++) {
    if (data[i] === t[0] && data[i + 1] === t[1] && data[i + 2] === t[2] && data[i + 3] === t[3]) return i;
  }
  return -1;
}

/** Sub-chunks up to the next FORM. Vyzor writes FORM sizes that are too small,
 * so the declared size cannot be used to bound a bank. */
function readChunks(data: Uint8Array, start: number): Map<string, [number, number]> {
  const chunks = new Map<string, [number, number]>();
  let off = start;
  while (off + 8 <= data.length) {
    const id = data.slice(off, off + 4);
    const name = ascii(id);
    if (name === "FORM" || name === "LIST" || ![...id].every((c) => c >= 0x20 && c < 0x7f)) break;
    const size = u32(data, off + 4);
    if (off + 8 + size > data.length) throw new SqsError(`chunk ${name} at ${off} overruns the file`);
    if (!chunks.has(name)) chunks.set(name, [off + 8, size]);
    off += 8 + size + (size & 1);
  }
  return chunks;
}

export class SqsFile {
  private data: Uint8Array;
  readonly banks: Bank[];

  constructor(data: Uint8Array) {
    this.data = data.slice();
    if (ascii(this.data.slice(0, 4)) !== "LIST") throw new SqsError("not an SQS file (missing LIST header)");
    this.banks = this.findBanks();
  }

  private findBanks(): Bank[] {
    const d = this.data;
    const banks: Bank[] = [];
    for (let pos = findTag(d, "FORM", 0); pos >= 0; pos = findTag(d, "FORM", pos + 4)) {
      if (ascii(d.slice(pos + 8, pos + 12)) !== "BANK") continue;
      const chunks = readChunks(d, pos + 12);
      const shdr = chunks.get("SHDR");
      const body = chunks.get("BODY");
      if (!shdr || !body) continue;
      let kind = cstr(d.slice(shdr[0] + 16, shdr[0] + 32));
      // The header reuses a stale buffer: "Preset\0ffer" means "Preset buffer".
      if (kind === "Preset") kind = PRESET_BUFFER_KIND;
      const slotCount = kind === USER_BANK_KIND ? USER_SLOTS : 1;
      if (body[1] % slotCount) throw new SqsError(`bank ${kind}: body size ${body[1]} not divisible by ${slotCount}`);
      banks.push({ instrument: cstr(d.slice(shdr[0], shdr[0] + 16)), kind, bodyOffset: body[0], bodySize: body[1], slotCount });
    }
    return banks;
  }

  bank(kind: string, instrument = "TCE G-System"): Bank {
    const b = this.banks.find((x) => x.kind === kind && x.instrument === instrument);
    if (!b) throw new SqsError(`no ${kind} bank for ${instrument}`);
    return b;
  }

  private slotRange(bank: Bank, slot: number): [number, number] {
    if (slot < 0 || slot >= bank.slotCount) throw new SqsError(`slot ${slot} out of range`);
    const size = bank.bodySize / bank.slotCount;
    const start = bank.bodyOffset + slot * size;
    return [start, start + size];
  }

  /** The raw SysEx message stored in a slot, or null if it is empty. */
  readSlot(bank: Bank, slot: number): Uint8Array | null {
    const [start, end] = this.slotRange(bank, slot);
    const raw = this.data.slice(start, end);
    if (raw[0] !== SYSEX_START) return null;
    const stop = raw.indexOf(0xf7);
    // Vyzor initialises some slots with a bare header and no data.
    return stop >= 0 ? raw.slice(0, stop + 1) : null;
  }

  /** All 200 user slots; checksum mismatches are kept and flagged, not rejected. */
  userPresets(): (Preset | null)[] {
    const bank = this.bank(USER_BANK_KIND);
    const out: (Preset | null)[] = [];
    for (let slot = 0; slot < bank.slotCount; slot++) {
      const msg = this.readSlot(bank, slot);
      out.push(msg && isPresetDump(msg) ? Preset.fromSysex(msg, false) : null);
    }
    return out;
  }

  setUserPreset(slot: number, preset: Preset | null): void {
    const bank = this.bank(USER_BANK_KIND);
    const [start, end] = this.slotRange(bank, slot);
    const content = preset ? preset.toSysex(userNumber(slot)) : new Uint8Array(0);
    if (content.length > end - start) throw new SysexError("dump does not fit in slot");
    this.data.fill(0, start, end);
    this.data.set(content, start);
  }

  toBytes(): Uint8Array {
    return this.data.slice();
  }
}

export function readSyx(bytes: Uint8Array): Preset[] {
  return splitSysex(bytes).filter(isPresetDump).map((m) => Preset.fromSysex(m, false));
}

export function writeSyx(presets: Preset[]): Uint8Array {
  const parts = presets.map((p) => p.toSysex());
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
