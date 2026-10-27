/**
 * Loops, insert, boost and routing of a preset: packed into preset field 0.
 *
 * bits 0-1   routing, see ROUTINGS (block 1 parameter 0)
 * bit  2     boost on (block 1 parameter 10)
 * bits 4-7   boost level in dB (block 1 parameter 11)
 * bits 9-12  loops 1 to 4 (block 1 parameters 19-22)
 * bit  13    insert loop (block 1 parameter 23)
 * bits 16-23 relays (block 1 parameters 17 and 18, one nibble each)
 *
 * Matched against the levels the unit sent for preset "Chute - drive" (loop 2 on,
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
export const OUTPUTS_FIELD = 2;
export const OUTPUT_MIN = -100;
/** Block 1 parameters of the routing and the output levels, for Live mode. */
export const ROUTING_PARAM = 0;
export const OUTPUT_PARAMS: readonly [number, number] = [26, 27];

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
