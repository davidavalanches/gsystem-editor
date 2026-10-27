/** What each of a preset's 165 fields is, for the raw view and the comparison. */

import { LEVELS_FIELD, OUTPUTS_FIELD } from "./levels";
import { MODIFIER_FIELD, MODIFIER_SLOTS, SOURCES, modifierTargets, readModifier } from "./modifiers";
import { FIELD_COUNT, owner, readField, type Param } from "./params";

export interface FieldInfo {
  group: string;
  name: string;
  /** The parameter it holds under the current effect type, when it is one. */
  param: Param | null;
}

export function describeField(data: Uint8Array, index: number): FieldInfo {
  const blk = owner(index);
  if (blk) {
    if (index === blk.countField) return { group: blk.label, name: "Nombre de paramètres", param: null };
    const param = blk.fields(data).find(([f]) => f === index)?.[1] ?? null;
    return { group: blk.label, name: param?.name ?? "(non utilisé par ce type)", param };
  }
  if (index >= MODIFIER_FIELD && index < MODIFIER_FIELD + MODIFIER_SLOTS) {
    const slot = index - MODIFIER_FIELD;
    const target = modifierTargets(data, true).find((t) => t.slot === slot);
    return { group: "Modifiers", name: target ? `${target.key} · ${target.name}` : `Slot ${slot + 1}`, param: null };
  }
  if (index === LEVELS_FIELD) return { group: "Preset", name: "Routing, boost, loops, relais", param: null };
  if (index === OUTPUTS_FIELD) return { group: "Preset", name: "Output L / R", param: null };
  return { group: "Preset", name: "(inconnu)", param: null };
}

/** The value as shown: the parameter's display, a modifier's source, else the raw value. */
export function formatField(data: Uint8Array, index: number): string {
  const info = describeField(data, index);
  const value = readField(data, index);
  if (info.param) return info.param.format(value);
  if (info.group === "Modifiers") {
    const m = readModifier(data, index - MODIFIER_FIELD);
    return m.source ? `${SOURCES[m.source] ?? m.source}` : "—";
  }
  return String(value);
}

export const rawHex = (data: Uint8Array, index: number) =>
  (readField(data, index) & 0xffffff).toString(16).toUpperCase().padStart(6, "0");

export const ALL_FIELDS = [...Array(FIELD_COUNT).keys()];
