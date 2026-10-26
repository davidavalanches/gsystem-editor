/**
 * Modifiers: per preset, a pedal or encoder controls an effect parameter between
 * Min, Mid and Max (Edit › Enter › Enter on the unit, Modifier page in Vyzor).
 *
 * Preset fields 125-162 hold 38 modifier slots, grouped by block: Filter 4,
 * Comp 3, Mod 5, Pitch 8, Delay 10, Reverb 4, NovaDrive 4. A block's slots follow
 * the list of parameters its current effect type lets a modifier control, in
 * parameter order: slot 1 is the first of them, and so on. Changing the type
 * keeps the slots, so they then apply to the new type's list.
 *
 * Each slot is a 24-bit word: source in bits 0-2 (0 none, 1 Vol, 2 Exp, 3-5
 * encoders A-C), then Min, Mid and Max in 7 bits each, as a percentage of the
 * parameter's range. Unassigned is source 0, 0 / 50 / 100 %.
 *
 * The lists of controllable parameters come from the bit masks of firmware 4.02
 * (one per effect type); the slot layout was checked against the user's presets
 * (e.g. Whammy Pitch, delay Mix) and the unit's own 55 22 0D messages.
 */

import { block, readField, writeField, type Param } from "./params";

export const MODIFIER_FIELD = 125;
export const MODIFIER_SLOTS = 38;
/** 55 22 block of the modifiers; slot n is parameter 20 + n. */
export const MODIFIER_BLOCK_ID = 0x0d;
export const MODIFIER_PARAM_BASE = 20;

export const SOURCES = ["Aucune", "Vol", "Exp", "Enc A", "Enc B", "Enc C"] as const;

export interface Modifier {
  source: number;
  min: number;
  mid: number;
  max: number;
}

export const UNASSIGNED: Modifier = { source: 0, min: 0, mid: 50, max: 100 };

export function decodeModifier(value: number): Modifier {
  const raw = value & 0xffffff;
  return { source: raw & 7, min: (raw >> 3) & 0x7f, mid: (raw >> 10) & 0x7f, max: (raw >> 17) & 0x7f };
}

/** The field value (signed, as readField returns it). */
export function encodeModifier(m: Modifier): number {
  const pct = (v: number) => Math.max(0, Math.min(100, Math.round(v)));
  const raw = (m.source & 7) | (pct(m.min) << 3) | (pct(m.mid) << 10) | (pct(m.max) << 17);
  return raw & 0x800000 ? raw - (1 << 24) : raw;
}

/** Values the unit cannot have set (seen in presets made with older firmware). */
export function isValidModifier(m: Modifier): boolean {
  return m.source < SOURCES.length && m.min <= 100 && m.mid <= 100 && m.max <= 100;
}

interface SlotGroup {
  key: string;
  first: number;
  size: number;
  /** Per effect type (in the block's type order): parameter indices a modifier can control. */
  targets: number[][];
}

const CHORUS = [4, 6, 7, 8], FLANGER = [4, 6, 7, 8, 12];
const DELAY = [2, 9, 15, 16, 19, 20], TAPE = [2, 9, 12, 15, 16, 19, 20];

const GROUPS: SlotGroup[] = [
  { key: "filter", first: 0, size: 4, targets: [[8, 9, 12], [12], [10, 12], [8, 10], [10], [6, 10], [7, 9, 14], [9, 14], [9, 12, 14]] },
  { key: "comp", first: 4, size: 3, targets: [[2, 3, 6], [6, 7], [6, 7]] },
  { key: "mod", first: 7, size: 5, targets: [CHORUS, CHORUS, FLANGER, FLANGER, [4, 5, 6, 8], [4, 6, 9, 10], [4, 6, 9, 10],
    [4, 5, 7, 8, 10], [4, 5, 10], [5, 6, 7, 10, 12], [5, 6, 7, 10, 12]] },
  { key: "pitch", first: 12, size: 8, targets: [[2, 3, 4, 5, 8, 9, 12, 13], [12, 13], [13, 16], [12, 13, 17, 18], [10, 11, 12, 13], []] },
  { key: "delay", first: 20, size: 10, targets: [DELAY, TAPE, DELAY, TAPE, [...DELAY, 21], DELAY, [3, 4, 10, 11, 15, 16, 17, 18, 19, 20]] },
  { key: "reverb", first: 30, size: 4, targets: [[2, 13, 14], [2, 8, 13, 14], [2, 13, 14], [2, 9, 13, 14]] },
];
/** Shown by the unit when a NovaDrive NDR-1 pedal is connected to its MIDI ports. */
export const NOVADRIVE = { first: 34, names: ["OD Gain", "OD Level", "DS Gain", "DS Level"] };

export interface ModifierTarget {
  /** Block key ("delay"…), or "novadrive". */
  key: string;
  slot: number;
  field: number;
  /** Preset field of the controlled parameter, null for NovaDrive. */
  paramField: number | null;
  param: Param | null;
  name: string;
  modifier: Modifier;
}

export const modifierField = (slot: number) => MODIFIER_FIELD + slot;

export function readModifier(data: Uint8Array, slot: number): Modifier {
  return decodeModifier(readField(data, modifierField(slot)));
}

export function writeModifier(data: Uint8Array, slot: number, m: Modifier): Uint8Array {
  return writeField(data, modifierField(slot), encodeModifier(m));
}

/** The parameters of this preset a modifier can control, as the unit lists them. */
export function modifierTargets(data: Uint8Array, novaDrive = false): ModifierTarget[] {
  const out: ModifierTarget[] = [];
  for (const g of GROUPS) {
    const blk = block(g.key);
    const type = readField(data, blk.firstField);
    const params = blk.paramList(data);
    (g.targets[type] ?? []).slice(0, g.size).forEach((index, n) => {
      const slot = g.first + n;
      const param = params[index] ?? null;
      out.push({ key: g.key, slot, field: modifierField(slot), paramField: blk.firstField + index, param,
        name: param?.name ?? `Paramètre ${index}`, modifier: readModifier(data, slot) });
    });
  }
  if (novaDrive) {
    NOVADRIVE.names.forEach((name, n) => {
      const slot = NOVADRIVE.first + n;
      out.push({ key: "novadrive", slot, field: modifierField(slot), paramField: null, param: null, name,
        modifier: readModifier(data, slot) });
    });
  }
  return out;
}

/** Parameter value at a percentage of its range, assuming the unit scales linearly. */
export function valueAt(param: Param, percent: number): number {
  return Math.round(param.lo + (percent / 100) * (param.hi - param.lo));
}
