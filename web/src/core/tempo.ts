/**
 * Preset tempo: the tap time (ms) stored in the Filter, Mod and Delay blocks.
 *
 * The unit has no separate tempo field; in the user's presets the Filter's and the
 * Delay's tap times nearly always match, the Mod's often not. The tempo shown is the
 * Delay's (else the Filter's); setting it writes all three, as tapping does.
 *
 * A block whose Tempo is a note value (not Ignore) follows its tap time: the delay
 * time or the modulation speed is the tap (a quarter note) times that note value,
 * as the unit sets it when tapping.
 */

import { block, lfo, readField, writeField } from "./params";

export const TAP_MIN_MS = 100;
export const TAP_MAX_MS = 3000;
/** Blocks with a tap time, Delay first. */
export const TEMPO_BLOCKS = ["delay", "filter", "mod"];

/** Fields of the tap times under the current effect types, Delay's first. */
export function tapFields(data: Uint8Array): number[] {
  return TEMPO_BLOCKS.flatMap((key) => block(key).fields(data).filter(([, p]) => /^Tap/.test(p.name)).map(([f]) => f));
}

export function presetTempoMs(data: Uint8Array): number | null {
  const [field] = tapFields(data);
  return field === undefined ? null : readField(data, field);
}

export function writeTempoMs(data: Uint8Array, ms: number): Uint8Array {
  const value = Math.max(TAP_MIN_MS, Math.min(TAP_MAX_MS, Math.round(ms)));
  return syncAllToTempo(tapFields(data).reduce((d, f) => writeField(d, f, value), data));
}

/** Length of a note value of the Tempo lists ("1/8D"…), in quarter notes; null for Ignore. */
export function noteQuarters(label: string): number | null {
  const m = /^(\d+)(?:\/(\d+))?([DT])?$/.exec(label);
  if (!m) return null;
  return (4 * Number(m[1])) / Number(m[2] ?? 1) * (m[3] === "D" ? 1.5 : m[3] === "T" ? 2 / 3 : 1);
}

/** Tempo parameter and the one it sets. */
const SYNCED: [string, string][] = [["Tempo", "Delay"], ["Tempo1", "Delay1"], ["Tempo2", "Delay2"],
  ["Tempo", "Speed"], ["Tempo1", "Speed1"], ["Tempo2", "Speed2"]];

/** Delay times and speeds of a block set from its tap time (else the preset tempo) and its Tempo note values. */
export function syncToTempo(data: Uint8Array, key: string): Uint8Array {
  const fields = block(key).fields(data);
  const find = (name: string) => fields.find(([, p]) => p.name === name);
  const tap = fields.find(([, p]) => /^Tap/.test(p.name));
  const tapMs = tap ? readField(data, tap[0]) : presetTempoMs(data);
  if (!tapMs || tapMs <= 0) return data;
  let out = data;
  for (const [tempoName, targetName] of SYNCED) {
    const tempo = find(tempoName), target = find(targetName);
    if (!tempo || !target) continue;
    const quarters = noteQuarters(tempo[1].format(readField(data, tempo[0])));
    if (quarters === null) continue;
    const ms = tapMs * quarters;
    const [field, param] = target;
    let value: number;
    if (targetName.startsWith("Delay")) value = Math.round(ms);
    // Speeds in the 1/24-octave scale from 0.05 Hz (a tremolo's own scale is not known).
    else if (param.fmt === lfo) value = Math.round(24 * Math.log2(1000 / ms / 0.05));
    else continue;
    out = writeField(out, field, Math.max(param.lo, Math.min(param.hi, value)));
  }
  return out;
}

export function syncAllToTempo(data: Uint8Array): Uint8Array {
  return TEMPO_BLOCKS.reduce((d, key) => syncToTempo(d, key), data);
}

export const msToBpm = (ms: number) => Math.round(60000 / ms);
export const bpmToMs = (bpm: number) => Math.round(60000 / bpm);
