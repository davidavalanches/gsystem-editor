/**
 * Preset tempo: the tap time (ms) stored in the Filter, Mod and Delay blocks.
 *
 * The unit has no separate tempo field; in the user's presets the Filter's and the
 * Delay's tap times nearly always match, the Mod's often not. The tempo shown is the
 * Delay's (else the Filter's); setting it writes all three, as tapping does.
 */

import { block, readField, writeField } from "./params";

export const TAP_MIN_MS = 100;
export const TAP_MAX_MS = 3000;
const TAP_BLOCKS = ["delay", "filter", "mod"];

/** Fields of the tap times under the current effect types, Delay's first. */
export function tapFields(data: Uint8Array): number[] {
  return TAP_BLOCKS.flatMap((key) => block(key).fields(data).filter(([, p]) => /^Tap/.test(p.name)).map(([f]) => f));
}

export function presetTempoMs(data: Uint8Array): number | null {
  const [field] = tapFields(data);
  return field === undefined ? null : readField(data, field);
}

export function writeTempoMs(data: Uint8Array, ms: number): Uint8Array {
  const value = Math.max(TAP_MIN_MS, Math.min(TAP_MAX_MS, Math.round(ms)));
  return tapFields(data).reduce((d, f) => writeField(d, f, value), data);
}

export const msToBpm = (ms: number) => Math.round(60000 / ms);
export const bpmToMs = (bpm: number) => Math.round(60000 / bpm);
