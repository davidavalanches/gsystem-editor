/**
 * Loops, insert, boost and routing of a preset: packed into preset field 0.
 *
 * bits 0-1   routing, see ROUTINGS (block 1 parameter 0)
 * bit  2     boost on (block 1 parameter 10)
 * bit  8     relay switch (block 1 parameter 16): on = relay setting A drives the Relay jacks, off = B
 * bits 4-7   boost level in dB (block 1 parameter 11)
 * bits 9-12  loops 1 to 4 (block 1 parameters 19-22)
 * bit  13    insert loop (block 1 parameter 23)
 * bits 16-23 relays A and B (block 1 parameters 17 and 18, one nibble each, see presetRelays)
 *
 * Matched against the levels the unit sent for preset "Chute - drive" (loop 2 on, relay on,
 * relays 6 and 12) and those Vyzor sent with "Fragile - clean" (insert and boost
 * on, boost 2 dB). The factory presets bear it out: all loops off, boost 3-6 dB.
 * Loops 1, 3 and 4 follow the bit order rather than an observation.
 *
 * Field 2 holds the preset's output levels, Left Output and Right Output (block 1
 * parameters 26 and 27, -100 to 0 dB), as two signed 12-bit values; the left one is
 * taken to be the low half, as parameters pack upwards in field 0.
 */

import { readField, writeField } from "./params";

export const LEVELS_FIELD = 0;
/** Routing names in the firmware's order. */
export const ROUTINGS = ["Serial", "Parallel", "Semi Parallel", "Serial2"] as const;
/** Bits of the loop, insert, boost and relay switches in field 0, by the keys of protocol's LEVEL_SWITCHES. */
export const LEVEL_BITS: Record<string, number> = { loop1: 9, loop2: 10, loop3: 11, loop4: 12, insert: 13, boost: 2, relay: 8 };
export const OUTPUTS_FIELD = 2;
export const OUTPUT_MIN = -100;
/** Block 1 parameters of the routing and the output levels, for Live mode. */
export const ROUTING_PARAM = 0;
export const BOOST_LEVEL_PARAM = 11;
export const BOOST_LEVEL_MAX = 10;
export const OUTPUT_PARAMS: readonly [number, number] = [26, 27];
/** Block 1 parameters of relay settings A and B (the Relay footswitch toggles between them). */
export const RELAY_PARAMS: readonly [number, number] = [17, 18];
/** Contacts of a relay setting: the tip and ring of the Relay 1 and Relay 2 jacks. */
export const RELAY_CONTACTS = 4;

export interface PresetLevels {
  loops: [boolean, boolean, boolean, boolean];
  insert: boolean;
  boost: boolean;
  boostLevel: number;
  routing: number;
}

export function presetLevels(data: Uint8Array): PresetLevels {
  const raw = readField(data, LEVELS_FIELD) & 0xffffff;
  const bit = (n: number) => ((raw >> n) & 1) === 1;
  return {
    loops: [bit(9), bit(10), bit(11), bit(12)],
    insert: bit(13),
    boost: bit(2),
    boostLevel: (raw >> 4) & 0x0f,
    routing: raw & 3,
  };
}

const signed = (raw: number, bits: number) => (raw << (32 - bits)) >> (32 - bits);

/** Left and right output levels in dB. */
export function presetOutputs(data: Uint8Array): [number, number] {
  const raw = readField(data, OUTPUTS_FIELD) & 0xffffff;
  return [signed(raw & 0xfff, 12), signed(raw >> 12, 12)];
}

export function writeOutputs(data: Uint8Array, [left, right]: readonly [number, number]): Uint8Array {
  const raw = (left & 0xfff) | ((right & 0xfff) << 12);
  return writeField(data, OUTPUTS_FIELD, signed(raw, 24));
}

export function writeRouting(data: Uint8Array, routing: number): Uint8Array {
  const raw = (readField(data, LEVELS_FIELD) & 0xfffffc) | (routing & 3);
  return writeField(data, LEVELS_FIELD, signed(raw, 24));
}

export function levelOn(data: Uint8Array, key: string): boolean {
  return ((readField(data, LEVELS_FIELD) >> LEVEL_BITS[key]) & 1) === 1;
}

export function writeLevel(data: Uint8Array, key: string, on: boolean): Uint8Array {
  const bit = 1 << LEVEL_BITS[key];
  const raw = readField(data, LEVELS_FIELD) & 0xffffff;
  return writeField(data, LEVELS_FIELD, signed(on ? raw | bit : raw & ~bit, 24));
}

/** Boost level of the preset, 0 to 10 dB (the unit also caps it at the global Boost Max). */
export function writeBoostLevel(data: Uint8Array, level: number): Uint8Array {
  const value = Math.max(0, Math.min(BOOST_LEVEL_MAX, Math.round(level)));
  const raw = (readField(data, LEVELS_FIELD) & 0xffff0f) | (value << 4);
  return writeField(data, LEVELS_FIELD, signed(raw, 24));
}

/**
 * Relay settings A and B, 4 bits each: bit n closes contact n + 1. The firmware lists
 * them as OOOO to CCCC, first contact first ("Chute - drive": A = OCCO, B = OOCC).
 */
export function presetRelays(data: Uint8Array): [number, number] {
  const raw = readField(data, LEVELS_FIELD) & 0xffffff;
  return [(raw >> 16) & 0x0f, (raw >> 20) & 0x0f];
}

export function writeRelay(data: Uint8Array, which: number, value: number): Uint8Array {
  const shift = which ? 20 : 16;
  const raw = (readField(data, LEVELS_FIELD) & 0xffffff & ~(0x0f << shift)) | ((value & 0x0f) << shift);
  return writeField(data, LEVELS_FIELD, signed(raw, 24));
}

/** "OCCO": open (O) or closed (C), contact 1 first, as the unit shows a relay setting. */
export const relayText = (value: number) =>
  Array.from({ length: RELAY_CONTACTS }, (_, i) => ((value >> i) & 1 ? "C" : "O")).join("");
