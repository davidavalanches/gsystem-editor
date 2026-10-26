/**
 * Footswitch assignments (Edit › Menu › Switches): block 5 parameters 226-243
 * hold switches #1 to #18.
 *
 * Each value packs three bytes: the function, then its first and second
 * parameters (style Toggle / Hold, or for Preset the bank and the preset,
 * or for MIDI CC the controller number). The function order is the manual's
 * table; the unit's own values bear it out (#1-#5 Filter, Comp, Loop 1-3;
 * #8-#10 Mod, Pitch, Delay; #14-#18 Preset 1-5 of the current bank), switching
 * #1 to Hold on the unit set the style byte to 1, the unit showed the user's
 * Preset 38-5 and 00-4 switches as decoded, and a switch set to Tap Tempo from
 * the editor showed as such.
 */

export const SWITCH_BLOCK = 5;
export const SWITCH_FIRST = 226;
export const SWITCH_COUNT = 18;
/** Switches with a fixed function (not in the unit's Switches menu), by index. */
export const FIXED_SWITCHES: ReadonlyMap<number, string> = new Map([[5, "EDIT"], [6, "UP"], [12, "DOWN"]]);

export const FUNCTIONS = ["None", "Filter", "Comp", "Loop 1", "Loop 2", "Loop 3", "Loop 4", "Insert", "Relay", "Gate",
  "Boost", "Mod", "Pitch", "Delay", "Reverb", "EQ", "Preset", "Tap Tempo", "Tuner Mute", "MIDI CC"] as const;
export const PRESET = 16;
export const MIDI_CC = 19;
const NO_PARAMS = new Set([0, 17]);

export const STYLES = ["Toggle", "Hold"];
/** Bank parameter of a Preset switch: none (UP/DOWN decide), factory A0-A9 and B0-B9, then user banks 00-39. */
export const SWITCH_BANKS = ["Banque courante", ...Array.from({ length: 10 }, (_, i) => `A${i}`),
  ...Array.from({ length: 10 }, (_, i) => `B${i}`), ...Array.from({ length: 40 }, (_, i) => String(i).padStart(2, "0"))];

export interface SwitchSetting {
  fn: number;
  p1: number;
  p2: number;
}

export function decodeSwitch(value: number): SwitchSetting {
  const raw = value & 0xffffff;
  return { fn: raw & 0xff, p1: (raw >> 8) & 0xff, p2: (raw >> 16) & 0xff };
}

export function encodeSwitch(s: SwitchSetting): number {
  return (s.fn & 0xff) | ((s.p1 & 0xff) << 8) | ((s.p2 & 0xff) << 16);
}

export type SwitchKind = "none" | "style" | "preset" | "cc";

export function switchKind(fn: number): SwitchKind {
  return fn === PRESET ? "preset" : fn === MIDI_CC ? "cc" : NO_PARAMS.has(fn) || fn >= FUNCTIONS.length ? "none" : "style";
}

/** A new function starts from neutral parameters (the unit's own defaults are not known). */
export function withFunction(s: SwitchSetting, fn: number): SwitchSetting {
  return fn === s.fn ? s : { fn, p1: 0, p2: 0 };
}

export function describeSwitch(s: SwitchSetting): string {
  const name = FUNCTIONS[s.fn] ?? `Fonction ${s.fn}`;
  switch (switchKind(s.fn)) {
    case "style": return `${name} (${STYLES[s.p1] ?? s.p1})`;
    case "preset": return `Preset ${SWITCH_BANKS[s.p1] ?? s.p1}-${s.p2 + 1}`;
    case "cc": return `MIDI CC #${s.p1}`;
    default: return name;
  }
}
