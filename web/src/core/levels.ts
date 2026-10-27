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
 */

import { readField } from "./params";

export const LEVELS_FIELD = 0;
/** Routing names in the firmware's order. */
export const ROUTINGS = ["Serial", "Parallel", "Semi Parallel", "Serial2"] as const;

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
