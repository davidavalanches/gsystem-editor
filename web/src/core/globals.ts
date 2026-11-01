/**
 * Global settings (Edit › Menu on the unit): levels, utility, pedals, MIDI and tuner.
 * They are not part of presets; the unit applies a change at once.
 *
 * They live in two 55 22 blocks, read with 55 47 (see protocol.ts):
 * - block 1: levels and locks, mixed with the current preset's loops and routing;
 * - block 5: system settings, then the program map (26-153) and the switches (226-243);
 * - Volume Ctrl. is the source bits (as in a modifier) of block 13 parameter 58.
 *
 * Block 1 parameters and the utility ones of block 5 were identified by changing
 * each setting on the unit's front panel and watching the messages it sends;
 * the rest of block 5 follows the order of firmware 4.02's global table, checked
 * against the values read from the unit (SysEx ID 1, tuner 440 Hz, Exp/Vol pedal types).
 * Value lists are the firmware's.
 */

import { SWITCH_BLOCK, SWITCH_COUNT, SWITCH_FIRST } from "./switches";

export const LEVELS_BLOCK = 1;
export const SYSTEM_BLOCK = 5;
/** Block 5 parameter of the unit's MIDI channel (0 Off, 1-16, 17 Omni). */
export const MIDI_CHANNEL_PARAM = 15;
/** Block 5 parameter of Prg. Change In (0 Off, 1 On). */
export const PRG_CHANGE_IN_PARAM = 16;
/** Ranges read in one 55 47 request each: [block, first parameter, count]. */
export const GLOBAL_RANGES: [number, number, number][] = [[LEVELS_BLOCK, 0, 30], [SYSTEM_BLOCK, 3, 23], [0x0d, 58, 1],
  [SWITCH_BLOCK, SWITCH_FIRST, SWITCH_COUNT]];

const ONOFF = ["Off", "On"];
const PRESET_GLOBAL = ["Preset", "Global"];
const PEDAL_TYPES = ["Off", "Momentary", "Alternate", "Exp.", "Vol."];
const CHANNELS = ["Off", ...Array.from({ length: 16 }, (_, i) => String(i + 1)), "Omni"];
const db = (offset = 0) => (v: number) => `${v + offset} dB`;

export interface GlobalParam {
  block: number;
  param: number;
  name: string;
  lo: number;
  hi: number;
  choices?: readonly string[];
  format?: (v: number) => string;
  help?: string;
  /** Only these bits are the setting; the others are kept when writing. */
  mask?: number;
}

export interface GlobalGroup {
  title: string;
  params: GlobalParam[];
}

const p = (block: number, param: number, name: string, lo: number, hi: number,
  extra: Partial<GlobalParam> = {}): GlobalParam => ({ block, param, name, lo, hi, ...extra });
const e = (block: number, param: number, name: string, choices: readonly string[], help?: string): GlobalParam =>
  p(block, param, name, 0, choices.length - 1, { choices, help });

export const GLOBAL_GROUPS: GlobalGroup[] = [
  { title: "Gbl Levels", params: [
    // Stored in dB, as the firmware table gives it (-8 to 18) and the unit sends it.
    p(1, 3, "Input Gain", -8, 18, { format: db(), help: "Instrument input gain, from −8 to +18 dB" }),
    p(1, 4, "Loop Level", 0, 10, { format: db(), help: "Level sent into the loops" }),
    p(1, 5, "Loop Headroom", 2, 6, { format: db(), help: "Headroom at the effects input, from 2 to 6 dB (firmware range)" }),
    p(1, 6, "Volume", -100, 0, { format: db() }),
    e(1, 7, "Volume Pos.", ["Input", "Output"], "Volume before (Input) or after (Output) the effects"),
    p(1, 8, "Output Level", -100, 0, { format: db() }),
    p(1, 12, "Boost Max", 0, 10, { format: db(), help: "Maximum boost allowed per preset" }),
    e(1, 2, "Input Select", ["Rear", "Front"], "Guitar input used on the GFX01"),
  ] },
  { title: "Utility", params: [
    e(5, 3, "Tap Master", PRESET_GLOBAL, "On preset change: the preset's tempo or the tapped tempo"),
    e(1, 24, "Insert Lock", ONOFF, "Keeps the Insert loop state for all presets"),
    e(1, 13, "Boost Lock", ONOFF),
    e(1, 14, "EQ Lock", ONOFF),
    e(1, 25, "Relay Lock", ONOFF),
    e(1, 1, "Routing Lock", ONOFF),
    e(1, 28, "Fact. Bank Lock", ONOFF, "Makes the factory banks inaccessible"),
    p(5, 8, "View Angle", 0, 127, { help: "Display contrast" }),
    e(5, 25, "KillDry", ONOFF),
  ] },
  { title: "Pedals", params: [
    { ...e(0x0d, 58, "Volume Ctrl.", ["None", "Vol", "Exp", "Enc A", "Enc B", "Enc C"],
      "Pedal (or encoder) that controls the volume"), mask: 7 },
    e(5, 9, "GFX1 Vol. Type", PEDAL_TYPES),
    e(5, 10, "GFX1 Exp. Type", PEDAL_TYPES),
    e(5, 11, "Ctrl Vol. Type", PEDAL_TYPES),
    e(5, 12, "Ctrl Exp. Type", PEDAL_TYPES),
    e(5, 13, "Vol. Master", PRESET_GLOBAL, "On preset change: the preset's value or the pedal position"),
    e(5, 14, "Exp. Master", PRESET_GLOBAL),
  ] },
  { title: "MIDI", params: [
    e(5, 15, "MIDI Channel", CHANNELS),
    e(5, 16, "Prg. Change In", ONOFF),
    e(5, 17, "Prg. Change Out", ["Off", "On", "On Map"]),
    p(5, 19, "SysEx ID", 0, 126, { help: "Must match the SysEx ID in the MIDI view for Store" }),
    e(5, 20, "MIDI Clock In", ONOFF),
    // CC 120-127 are MIDI channel mode messages: the firmware stops at 119.
    p(5, 21, "Enc. A CC", 0, 119),
    p(5, 22, "Enc. B CC", 0, 119),
    p(5, 23, "Enc. C CC", 0, 119),
    p(5, 24, "Tap CC", 0, 119),
  ] },
  { title: "Tuner", params: [
    e(5, 5, "Output", ["Mute", "On"], "Whether the output is muted in tuner mode"),
    e(5, 6, "Mode", ["Bar", "Strobe"]),
    p(5, 7, "Reference", 420, 460, { format: (v) => `${v} Hz` }),
  ] },
];

export const globalKey = (block: number, param: number) => `${block}:${param}`;

/** The setting's value within the parameter's raw value. */
export const globalValue = (g: GlobalParam, raw: number) => (g.mask ? raw & g.mask : raw);
/** The raw value to send for a new setting. */
export const globalRaw = (g: GlobalParam, raw: number, value: number) => (g.mask ? (raw & ~g.mask) | value : value);

export function formatGlobal(g: GlobalParam, v: number): string {
  if (g.choices) return g.choices[v - g.lo] ?? String(v);
  return g.format ? g.format(v) : String(v);
}

export const GLOBAL_PARAMS = new Map(GLOBAL_GROUPS.flatMap((grp) => grp.params).map((g) => [globalKey(g.block, g.param), g]));
