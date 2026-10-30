/**
 * G-System MIDI protocol. Messages used, all observed on the hardware:
 *
 * - Universal Device Inquiry, answered with the firmware version.
 * - 55 45 01 <num>: request a stored preset (read-only), answered by a dump in
 *   about 0.77 s. The unit ignores requests while busy; empty slots never answer.
 * - 55 22 <block> <param:2> <value:6 nibbles>: set one parameter of the edit
 *   buffer. The unit sends the same message when a switch or knob is used.
 *   Writing needs SysEx ID 7F; nothing is stored until Store is pressed.
 * - Store, as Vyzor's Sync does it (captured while running Vyzor): editor mode on
 *   (55 22 01 00 1D … 1), 55 57 00, the preset dump (55 20 01 <num>), 55 57 01,
 *   all addressed to the unit's own SysEx ID (Global › MIDI › SysEx ID, 1 here).
 *   This exact sequence succeeded four times, then froze the unit on the next
 *   store with identical bytes and timing; addressed to 7F, overwriting froze it
 *   too. A freeze needs a power cycle, leaves the slot unreadable and once
 *   altered a neighbouring preset. On this unit the freezes stayed in banks 27-29,
 *   which the app never writes; elsewhere stores are read back to verify them.
 * - Bank Select + Program Change: sent by the unit when a preset is recalled.
 *   The editor sends the same pair to recall a preset (Prg.Chng.In on, on the
 *   unit's MIDI channel). A first test over USB saw it ignored, so in Live mode
 *   the editor also writes the preset's parameters into the edit buffer.
 */

import { MODEL_G_SYSTEM, Preset, TC_MANUFACTURER, USER_PRESET_BASE, USER_SLOTS, isPresetDump, userNumber } from "./sysex";

export const DEVICE_INQUIRY = new Uint8Array([0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7]);
export const REQUEST_PRESET = 0x45;
/** 55 47 <block> <first:2> <count:2>: the unit answers with 55 22 messages for those parameters (as Vyzor reads globals). */
export const REQUEST_PARAMS = 0x47;
export const SET_PARAM = 0x22;
export const WRITE_DEVICE_ID = 0x7f;
export const REQUEST_TIMEOUT_MS = 1100;
export const SEND_INTERVAL_MS = 2;
/** Pause between the messages of a store transfer, and before reading the slot back (as tested). */
export const STORE_STEP_MS = 100;
export const STORE_SETTLE_MS = 1500;
/** The unit's SysEx ID as found by Vyzor's AutoSense; set in the unit's Global › MIDI menu. */
export const DEFAULT_SYSEX_ID = 1;
const USER_BANK_SIZE = 100; // Bank Select (CC 0) 1 = user presets 1-100, 2 = 101-200

/** Block ids of the 55 22 message, captured from the unit's switches and knobs.
 * Block 1 is the levels table (loops, insert, boost); block 13 holds the modifiers (see modifiers.ts). */
export const BLOCK_IDS: Record<string, number> = {
  eq: 2, mod: 4, filter: 7, pitch: 8, delay: 9, comp: 10, reverb: 11, gate: 12,
};
export const LEVELS_BLOCK_ID = 1;
export const LEVEL_SWITCHES: Record<string, number> = {
  loop1: 19, loop2: 20, loop3: 21, loop4: 22, insert: 23, boost: 10, relay: 16,
};

export function presetRequest(number: number, deviceId = 0): Uint8Array {
  return new Uint8Array([0xf0, ...TC_MANUFACTURER, deviceId, MODEL_G_SYSTEM, REQUEST_PRESET, 0x01,
    number >> 7, number & 0x7f, 0xf7]);
}

/** The messages that store a preset into a user slot, in order. `sysexId` must be the unit's own ID. */
export function storeMessages(slot: number, preset: Preset, sysexId: number): Uint8Array[] {
  if (sysexId < 0 || sysexId > 0x7e) throw new RangeError(`SysEx ID out of range: ${sysexId}`);
  const sysex = (...body: number[]) => new Uint8Array([0xf0, ...TC_MANUFACTURER, sysexId, MODEL_G_SYSTEM, ...body, 0xf7]);
  return [
    sysex(SET_PARAM, 0x01, 0x00, 0x1d, 0, 0, 0, 0, 0, 1), // editor mode on
    sysex(0x57, 0x00), // begin transfer
    preset.toSysex(userNumber(slot), sysexId),
    sysex(0x57, 0x01), // end transfer
  ];
}

/** Bank Select (CC 0: 1 for user presets 1-100, 2 for 101-200) and Program Change recalling a user slot. */
export function presetSelectMessages(slot: number, channel: number): Uint8Array[] {
  const ch = (channel - 1) & 0x0f;
  return [new Uint8Array([0xb0 | ch, 0x00, 1 + Math.floor(slot / USER_BANK_SIZE)]),
    new Uint8Array([0xc0 | ch, slot % USER_BANK_SIZE])];
}

export function paramsRequest(blockId: number, first: number, count: number, deviceId: number): Uint8Array {
  return new Uint8Array([0xf0, ...TC_MANUFACTURER, deviceId, MODEL_G_SYSTEM, REQUEST_PARAMS, blockId,
    first >> 7, first & 0x7f, count >> 7, count & 0x7f, 0xf7]);
}

export function paramMessage(blockId: number, param: number, value: number): Uint8Array {
  const raw = value & 0xffffff;
  const nibbles = [20, 16, 12, 8, 4, 0].map((shift) => (raw >> shift) & 0x0f);
  return new Uint8Array([0xf0, ...TC_MANUFACTURER, WRITE_DEVICE_ID, MODEL_G_SYSTEM, SET_PARAM, blockId,
    param >> 7, param & 0x7f, ...nibbles, 0xf7]);
}

/** [block id, parameter, value] of a 55 22 message, else null. */
export function parseParamMessage(msg: Uint8Array): [number, number, number] | null {
  return msg.length === 17 ? parseParamValues(msg)?.[0] ?? null : null;
}

/** All [block id, parameter, value] of a 55 22 message: the unit sends consecutive parameters in one message. */
export function parseParamValues(msg: Uint8Array): [number, number, number][] | null {
  if (msg.length < 17 || (msg.length - 11) % 6 || msg[1] !== 0x00 || msg[2] !== 0x20 || msg[3] !== 0x1f
    || msg[5] !== MODEL_G_SYSTEM || msg[6] !== SET_PARAM) return null;
  const first = (msg[8] << 7) | msg[9];
  const out: [number, number, number][] = [];
  for (let off = 10, i = 0; off + 6 < msg.length; off += 6, i++) {
    let raw = 0;
    for (const n of msg.slice(off, off + 6)) raw = (raw << 4) | (n & 0x0f);
    out.push([msg[7], first + i, raw & 0x800000 ? raw - (1 << 24) : raw]);
  }
  return out;
}

/** Firmware version ("4.05") if this is the G-System's identity reply. */
export function identityVersion(msg: Uint8Array): string | null {
  const ok = msg.length >= 17 && msg[1] === 0x7e && msg[3] === 0x06 && msg[4] === 0x02
    && msg[5] === 0x00 && msg[6] === 0x20 && msg[7] === 0x1f && msg[8] === MODEL_G_SYSTEM;
  return ok ? `${msg[14]}.${String(msg[15]).padStart(2, "0")}` : null;
}

/** A MIDI connection: sends raw messages and delivers complete messages. */
export interface Transport {
  send(msg: Uint8Array): void;
  onMessage: ((msg: Uint8Array) => void) | null;
  /** The device went away (unplugged, switched off): the transport is already closed. */
  onLost: (() => void) | null;
  close(): void;
}

type Listener<T extends unknown[]> = (...args: T) => void;

/** Requests to the unit: identification, preset reading and parameter changes. */
export class GSystemLink {
  onIdentity: Listener<[string]> | null = null;
  onParam: Listener<[number, number, number]> | null = null;
  onPresetSelected: Listener<[number]> | null = null;
  onPresetRead: Listener<[Preset]> | null = null;
  onProgress: Listener<[number, number]> | null = null;
  onReadFinished: Listener<[Preset[], number[]]> | null = null;
  onActivity: Listener<[]> | null = null;

  private queue: number[] = [];
  private current: number | null = null;
  private received: Preset[] = [];
  private missing: number[] = [];
  private total = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sendQueue: Uint8Array[] = [];
  private sending: ReturnType<typeof setInterval> | null = null;
  private bank: number | null = null;
  private storing = false;
  /** The unit's own SysEx ID, required for stores. */
  sysexId = DEFAULT_SYSEX_ID;

  constructor(private transport: Transport) {
    transport.onMessage = (msg) => this.handle(msg);
  }

  get busy(): boolean {
    return this.current !== null || this.storing;
  }

  identify(): void {
    this.transport.send(DEVICE_INQUIRY);
  }

  /** Queue a parameter change; bursts (a whole preset) are paced. */
  sendParam(blockId: number, param: number, value: number): void {
    this.sendQueue.push(paramMessage(blockId, param, value));
    if (this.sending === null) {
      this.sending = setInterval(() => {
        const msg = this.sendQueue.shift();
        if (msg) this.transport.send(msg);
        else {
          clearInterval(this.sending!);
          this.sending = null;
        }
      }, SEND_INTERVAL_MS);
    }
  }

  /** Recall a user preset on the unit, on MIDI channel 1-16. */
  selectPreset(slot: number, channel: number): void {
    for (const msg of presetSelectMessages(slot, channel)) this.transport.send(msg);
  }

  /** Ask for parameter values; they arrive through onParam. */
  requestParams(blockId: number, first: number, count: number): void {
    this.transport.send(paramsRequest(blockId, first, count, this.sysexId));
  }

  /** Store a preset into a user slot of the unit; `done` runs once the unit has had time to write it. */
  store(slot: number, preset: Preset, done: () => void): void {
    const steps = storeMessages(slot, preset, this.sysexId);
    this.storing = true;
    const step = () => {
      const msg = steps.shift();
      if (!msg) {
        setTimeout(() => {
          this.storing = false;
          done();
        }, STORE_SETTLE_MS);
        return;
      }
      this.transport.send(msg);
      setTimeout(step, STORE_STEP_MS);
    };
    step();
  }

  readSlots(slots: Iterable<number>): void {
    this.queue = [...slots].map((s) => USER_PRESET_BASE + s);
    this.total = this.queue.length;
    this.received = [];
    this.missing = [];
    this.next();
  }

  cancel(): void {
    this.queue = [];
    if (this.timer) clearTimeout(this.timer);
    this.finish();
  }

  close(): void {
    this.queue = [];
    if (this.timer) clearTimeout(this.timer);
    if (this.sending !== null) clearInterval(this.sending);
    this.sending = null;
    this.sendQueue = [];
    this.current = null;
    this.transport.close();
  }

  private next(): void {
    const number = this.queue.shift();
    if (number === undefined) {
      this.finish();
      return;
    }
    this.current = number;
    this.transport.send(presetRequest(number));
    this.timer = setTimeout(() => {
      // Empty slots do not answer.
      this.missing.push(number);
      this.onProgress?.(this.total - this.queue.length, this.total);
      this.next();
    }, REQUEST_TIMEOUT_MS);
  }

  private finish(): void {
    this.current = null;
    this.onReadFinished?.(this.received, this.missing);
  }

  private handle(msg: Uint8Array): void {
    this.onActivity?.();
    const status = msg[0] & 0xf0;
    if (status === 0xb0 && msg.length === 3 && msg[1] === 0) {
      this.bank = msg[2];
      return;
    }
    if (status === 0xc0 && msg.length === 2) {
      if (this.bank === 1 || this.bank === 2) {
        const slot = (this.bank - 1) * USER_BANK_SIZE + msg[1];
        if (slot < USER_SLOTS) this.onPresetSelected?.(slot);
      }
      return;
    }
    const version = identityVersion(msg);
    if (version) {
      this.onIdentity?.(version);
      return;
    }
    const changes = parseParamValues(msg);
    if (changes) {
      for (const change of changes) this.onParam?.(...change);
      return;
    }
    if (this.current === null || !isPresetDump(msg)) return;
    const preset = Preset.fromSysex(msg, false);
    if (preset.number !== this.current) return;
    if (this.timer) clearTimeout(this.timer);
    this.received.push(preset);
    this.onPresetRead?.(preset);
    this.onProgress?.(this.total - this.queue.length, this.total);
    this.next();
  }
}

/** Reassembles SysEx messages that a transport delivers in pieces. */
export class MidiParser {
  private sysex: number[] | null = null;
  private pending: number[] = [];
  private expected = 0;

  constructor(private emit: (msg: Uint8Array) => void) {}

  push(bytes: Iterable<number>): void {
    for (const b of bytes) {
      if (b === 0xf0) {
        this.sysex = [b];
      } else if (this.sysex) {
        if (b === 0xf7) {
          this.sysex.push(b);
          this.emit(new Uint8Array(this.sysex));
          this.sysex = null;
        } else if (b >= 0xf8) {
          this.emit(new Uint8Array([b])); // real-time bytes may interleave
        } else if (b & 0x80) {
          this.sysex = null; // aborted SysEx
          this.pending = [b];
          this.expected = channelLength(b);
        } else {
          this.sysex.push(b);
        }
      } else if (b & 0x80) {
        if (b >= 0xf8) continue;
        this.pending = [b];
        this.expected = channelLength(b);
      } else if (this.pending.length) {
        this.pending.push(b);
      }
      if (this.pending.length && this.pending.length === this.expected) {
        this.emit(new Uint8Array(this.pending));
        this.pending = [];
      }
    }
  }
}

function channelLength(status: number): number {
  const kind = status & 0xf0;
  return kind === 0xc0 || kind === 0xd0 ? 2 : status >= 0xf0 ? 1 : 3;
}
