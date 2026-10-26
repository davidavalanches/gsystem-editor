/**
 * Preset parameter layout.
 *
 * A preset's 516 data bytes are a 21-byte name followed by 165 fields of 3 bytes
 * (signed 24-bit little-endian). Fields 0-124 hold the effect blocks; fields
 * 125-164 hold byte-packed data (routing, levels, switch/pedal assignments).
 *
 * Each effect block is stored as [parameter count][parameters...] in a slot of
 * fixed size, in this order: Comp, Filter, Mod, Pitch, Reverb, Gate, Delay, EQ.
 * Parameter 0 of a block is its effect type (when it has one), parameter 1 its
 * on/off switch. Which parameters exist depends on the effect type.
 *
 * Names, ranges and value lists come from the parameter tables of G-System
 * firmware 4.02 and were cross-checked against the factory presets and the
 * user's banks; unit conversions come from the G-System manual.
 */

import { PRESET_DATA_LEN } from "./sysex";

export const FIELDS_OFFSET = 21;
export const FIELD_COUNT = (PRESET_DATA_LEN - FIELDS_OFFSET) / 3;
export const NUMERIC_FIELDS = 125;

export function fieldOffset(index: number): number {
  if (index < 0 || index >= FIELD_COUNT) throw new RangeError(`field ${index} out of range`);
  return FIELDS_OFFSET + 3 * index;
}

export function readField(data: Uint8Array, index: number): number {
  const off = fieldOffset(index);
  const value = data[off] | (data[off + 1] << 8) | (data[off + 2] << 16);
  return value & 0x800000 ? value - (1 << 24) : value;
}

export function writeField(data: Uint8Array, index: number, value: number): Uint8Array {
  if (!Number.isInteger(value) || value < -(1 << 23) || value >= 1 << 23) {
    throw new RangeError(`value ${value} does not fit in 24 bits`);
  }
  const off = fieldOffset(index);
  const raw = value & 0xffffff;
  const out = data.slice();
  out[off] = raw & 0xff;
  out[off + 1] = (raw >> 8) & 0xff;
  out[off + 2] = (raw >> 16) & 0xff;
  return out;
}

// Value display

const hz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} kHz` : `${Math.round(v)} Hz`);
/** Filter frequencies: 20 Hz to 20 kHz in sixth-octave steps. */
export const freq = (i: number) => hz(20 * 2 ** (i / 6));
/** Modulation speed: 0.05 Hz to 20 Hz in 1/24-octave steps. */
export const lfo = (i: number) => {
  const f = 0.05 * 2 ** (i / 24);
  return `${f < 10 ? f.toFixed(2) : f.toFixed(1)} Hz`;
};
const unit = (suffix: string) => (v: number) => `${v} ${suffix}`;
const scaled = (factor: number, suffix: string) => (v: number) => `${(v * factor).toFixed(1)} ${suffix}`;

const DB = unit("dB"), MS = unit("ms"), PCT = unit("%"), CENTS = unit("cents");
const ONOFF = ["Off", "On"];
const TEMPO = ["Ignore", "2", "1", "1/2D", "1/2", "1/2T", "1/4D", "1/4", "1/4T", "1/8D", "1/8", "1/8T",
  "1/16D", "1/16", "1/16T", "1/32D", "1/32", "1/32T"];
const DELAY_TEMPO = ["Ignore", ...TEMPO.slice(2)];
const TIMES = ["0.3 ms", "0.5 ms", "0.7 ms", "1.0 ms", "1.4 ms", "2.0 ms", "3.0 ms", "5.0 ms", "7.0 ms", "10 ms",
  "14 ms", "20 ms", "30 ms", "50 ms", "70 ms", "100 ms", "140 ms", "200 ms", "300 ms", "500 ms",
  "700 ms", "1.0 s", "1.4 s", "2.0 s"];
const VOWELS = ["HEAT", "HIT", "HEAD", "HAD", "BUT", "FATHER", "ALL", "BOOT", "FOOT", "BIRD"];

export class Param {
  constructor(
    readonly name: string,
    readonly lo: number,
    readonly hi: number,
    readonly choices: readonly string[] = [],
    readonly fmt: ((v: number) => string) | null = null,
    /** Value of the first entry of `choices` (e.g. -12 for intervals). */
    readonly choicesBase = 0,
  ) {}

  format(value: number): string {
    if (this.choices.length) {
      const i = value - this.choicesBase;
      return i >= 0 && i < this.choices.length ? this.choices[i] : String(value);
    }
    return this.fmt ? this.fmt(value) : String(value);
  }

  get isSwitch(): boolean {
    return this.choices.length === 2 && this.choices[0] === "Off" && this.choices[1] === "On";
  }
}

const P = (name: string, lo: number, hi: number, fmt: ((v: number) => string) | null = null) =>
  new Param(name, lo, hi, [], fmt);
const E = (name: string, choices: readonly string[]) => new Param(name, 0, choices.length - 1, choices);
/** Value list whose values are indices into a longer list (e.g. release starts at index 13). */
const L = (name: string, lo: number, hi: number, choices: readonly string[]) => new Param(name, lo, hi, choices);

const TAP = P("Tap", 100, 3000, MS);
const OUTLEV = P("OutLev", -100, 0, DB);
const MIX = P("Mix", 0, 100, PCT);
const ENABLE = E("Enable", ONOFF);

const FILTER_WAH = [ENABLE, TAP, E("Tempo", TEMPO), P("Sense", 0, 10), E("Resp", ["Slow", "Fast"]),
  P("Speed", 0, 208, lfo), E("Shape", ["Tri", "Sine"]), P("Sweep", 0, 100, PCT), E("Range", ["Low", "High"]),
  OUTLEV, E("AutoOn", ["Off", "0.3s", "0.5s", "1s", "3s", "5s", "10s", "Inf"])];
const FILTER_RES = [ENABLE, TAP, E("Tempo", TEMPO), E("Style", ["2nd", "4th"]), P("Sense", 0, 10),
  E("Resp", ["Slow", "Fast"]), P("Fmax", 34, 54, freq), P("Hicut", 18, 57, freq), P("Resnce", 0, 100, PCT),
  P("Speed", 0, 208, lfo), E("Shape", ["Tri", "Sine"]), OUTLEV];
const FILTER_FORMANT = [ENABLE, TAP, E("Tempo", TEMPO), E("Low", VOWELS), E("Mid", VOWELS), E("High", VOWELS),
  P("Sweep", 0, 100, PCT), P("Bright", 0, 100, PCT), P("Resnce", 0, 100, PCT), P("Sense", 0, 10),
  E("Resp", ["Slow", "Fast"]), P("Speed", 0, 208, lfo), E("Shape", ["Tri", "Sine"]), OUTLEV];

const MOD_CHORUS = [ENABLE, TAP, E("Tempo", TEMPO), P("Speed", 0, 208, lfo), P("Depth", 0, 100, PCT),
  P("HiCut", 0, 60, freq), MIX, OUTLEV, P("Cho Dly", 0, 500, scaled(0.1, "ms")), E("Ratio", ONOFF),
  E("PhaRev", ONOFF), P("FeedB", -100, 100, PCT), P("FB Cut", 0, 60, freq)];
const MOD_PHASER = [ENABLE, TAP, E("Tempo", TEMPO), P("Speed", 0, 208, lfo), P("Depth", 0, 100, PCT),
  P("Fb", -100, 100, PCT), E("Range", ["Low", "High"]), E("Rev", ONOFF), MIX, OUTLEV];
const MOD_UNIVIBE = [ENABLE, E("BpMode", ["Delay", "Direct"]), E("Tempo1", TEMPO), E("Tempo2", TEMPO),
  P("Depth", 0, 100, PCT), P("Speed1", 38, 184, lfo), P("Speed2", 38, 184, lfo), P("Attack", 50, 5000, MS),
  P("Releas", 50, 5000, MS), E("Select", ["Speed1", "Speed2"]), E("PhaRev", ONOFF), MIX, OUTLEV];
const MOD_TREMOLO = [ENABLE, TAP, E("Tempo", TEMPO), P("Speed", 0, 368), P("Depth", 0, 100, PCT),
  E("Type", ["Soft", "Hard"]), P("Width", 0, 100, PCT), P("Hi Cut", 0, 60, freq), MIX, OUTLEV];

const INTERVALS = ["-13", "-12", "-11", "-10", "-9", "-Oct1", "-7", "-6", "-5", "-4", "-3", "-2", "Unison",
  "2", "3", "4", "5", "6", "7", "Oct1", "9", "10", "11", "12", "13"];
const PITCH_TAIL = [MIX, OUTLEV, E("Dir", ["Down", "Up"])];
const PITCH_SHIFTER = [ENABLE, P("Voice1", -1200, 1200, CENTS), P("Voice2", -1200, 1200, CENTS),
  P("Pan1", -50, 50), P("Pan2", -50, 50), P("Delay1", 0, 350, MS), P("Delay2", 0, 350, MS),
  P("Fb1", 0, 100, PCT), P("Fb2", 0, 100, PCT), P("Level1", -100, 0, DB), P("Level2", -100, 0, DB),
  ...PITCH_TAIL, E("Range", ["1 Oct", "2 Oct"]), P("Pitch", 0, 100, PCT), P("VoiceL", -100, 100),
  P("VoiceR", -100, 100)];
const PITCH_INTELLIGENT = [ENABLE, new Param("Voice1", -12, 12, INTERVALS, null, -12),
  new Param("Voice2", -12, 12, INTERVALS, null, -12), P("Pan1", -50, 50), P("Pan2", -50, 50),
  P("Delay1", 0, 50, MS), P("Delay2", 0, 50, MS),
  E("Key", ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]),
  E("Scale", ["Ionian", "Dorian", "Phrygi", "Lydian", "MixoLy", "Aeolia", "Locria", "PntMin", "PntMaj",
    "Blues", "DimHlf", "DimWhl", "Whole", "MelMin", "HrmMin", "SupLoc", "Lyd b7", "PhryMa"]),
  P("Level1", -100, 0, DB), P("Level2", -100, 0, DB), ...PITCH_TAIL, E("Mode", ["Step", "Smooth"]),
  P("Pitch", 0, 100, PCT), P("VoiceL", -100, 100), P("VoiceR", -100, 100)];
// The doubler's parameter names are not in the firmware tables.
const PITCH_DOUBLER = [ENABLE, P("Pitch", -20, 20), P("Param 3", -20, 20), P("Param 4", -50, 50),
  P("Param 5", -50, 50), P("Delay", 3, 60, MS), P("Param 7", 1, 20), P("Param 8", 0, 100), P("Param 9", 0, 100),
  P("Param 10", -100, 0, DB), P("Param 11", -100, 0, DB), P("Param 12", 0, 100), OUTLEV,
  E("Side", ["Left", "Right"])];

const DELAY = [ENABLE, P("Delay", 0, 1800, MS), P("Delay1", 0, 1800, MS), P("Delay2", 0, 1800, MS),
  E("Tempo", DELAY_TEMPO), E("Tempo1", DELAY_TEMPO), E("Tempo2", DELAY_TEMPO), P("TapTime", 100, 3000, MS),
  P("Fb", 0, 120, PCT), P("Fb1", 0, 120, PCT), P("Fb2", 0, 120, PCT), P("Drive", 0, 24, DB),
  P("Drive1", 0, 24, DB), P("Drive2", 0, 24, DB), P("Fbhcut", 0, 60, freq), P("Fblcut", 0, 60, freq),
  P("Pan1", -50, 50), P("Pan2", -50, 50), MIX, OUTLEV, P("Width", 0, 100, PCT), P("Offset", 0, 200, MS),
  P("Sense", -50, 0, DB), P("Damp", 0, 100, DB), P("Rel", 20, 1000, MS), P("Delay", 50, 800, MS)];

const REVERB = [ENABLE, P("Decay", 1, 200, scaled(0.1, "s")), P("PreDly", 0, 100, MS),
  E("Shape", ["Round", "Curved", "Square"]),
  E("Size", ["Box", "Tiny", "Small", "Medium", "Large", "XL", "Grand", "Huge"]),
  E("Hi Col", ["Wool", "Warm", "Real", "Clear", "Bright", "Crisp", "Glass"]), P("Hi Lev", -25, 25),
  E("Lo Col", ["Thick", "Round", "Real", "Light", "Tight", "Thin", "NoBass"]), P("Lo Lev", -25, 25),
  P("Early", -100, 0, DB), P("RevLev", -100, 0, DB), P("Diff", -25, 25), MIX, OUTLEV];

const COMP = [E("Comp", ONOFF), P("Thres", -40, 0, DB),
  E("Ratio", ["Off", "1.12:1", "1.25:1", "1.40:1", "1.60:1", "1.80:1", "2.0:1", "2.5:1", "3.2:1", "4.0:1",
    "5.6:1", "8.0:1", "16:1", "32:1", "64:1", "inf:1"]),
  L("Attack", 0, 16, TIMES), L("Releas", 13, 23, TIMES), P("Gain", -100, 12, DB), P("Drive", 1, 20),
  P("Resp", 1, 10)];

const GATE = [E("NG", ONOFF), E("Mode", ["Hard", "Soft"]), P("Thres", -60, 0, DB), P("Damp", 0, 90, DB),
  P("Speed", 3, 200, unit("dB/s"))];

const EQ = [P("Gain1", -12, 12, DB), P("Freq1", 0, 60, freq), P("Width1", 0, 39, scaled(0.1, "oct")),
  P("Gain2", -12, 12, DB), P("Freq2", 0, 60, freq), P("Width2", 0, 39, scaled(0.1, "oct")),
  P("Gain3", -12, 12, DB), P("Freq3", 0, 60, freq), P("Width3", 0, 39, scaled(0.1, "oct")), E("EQ", ONOFF)];

export interface EffectType {
  name: string;
  /** Parameters 1.. (parameter 0 is the type itself). */
  params: readonly Param[];
}

const family = (names: string[], params: readonly Param[]): EffectType[] => names.map((name) => ({ name, params }));

export class Block {
  constructor(
    readonly key: string,
    readonly label: string,
    readonly countField: number,
    /** Parameter slots reserved in the SysEx layout. */
    readonly size: number,
    readonly types: readonly EffectType[] = [],
    /** For blocks without a type parameter. */
    readonly params: readonly Param[] = [],
    readonly enableName = "Enable",
  ) {}

  get firstField(): number {
    return this.countField + 1;
  }

  get hasType(): boolean {
    return this.types.length > 0;
  }

  effectType(data: Uint8Array): EffectType | null {
    if (!this.hasType) return null;
    return this.types[readField(data, this.firstField)] ?? null;
  }

  /** Parameters in slot order for the effect type currently stored. */
  paramList(data: Uint8Array): Param[] {
    if (!this.hasType) return [...this.params];
    const typeParam = new Param("Type", 0, this.types.length - 1, this.types.map((t) => t.name));
    return [typeParam, ...(this.effectType(data)?.params ?? [])];
  }

  fields(data: Uint8Array): [number, Param][] {
    return this.paramList(data).map((p, i) => [this.firstField + i, p]);
  }

  enableField(data: Uint8Array): number | null {
    for (const [f, p] of this.fields(data)) if (p.name === this.enableName) return f;
    return null;
  }

  allFields(): number[] {
    const out = [];
    for (let f = this.countField; f < this.firstField + this.size; f++) out.push(f);
    return out;
  }
}

export const BLOCKS: readonly Block[] = [
  new Block("comp", "Compresseur", 3, 9, family(["Advanced", "Sustaining", "Percussive"], COMP), [], "Comp"),
  new Block("filter", "Filter", 13, 15, [
    ...family(["Resonance Filter", "Touch Res Filter", "Auto Res Filter"], FILTER_RES),
    ...family(["Wah wah", "Touch Wah", "Auto Wah"], FILTER_WAH),
    ...family(["Formant", "Touch Formant", "Auto Formant"], FILTER_FORMANT),
  ]),
  new Block("mod", "Mod", 29, 14, [
    ...family(["Classic Chorus", "Advanced Chorus", "Classic Flanger", "Advanced Flanger", "Vibrato"], MOD_CHORUS),
    ...family(["Vintage Phaser", "Smooth Phaser"], MOD_PHASER),
    ...family(["Tremolo", "Panner"], MOD_TREMOLO),
    ...family(["Vintage Univibe", "Modern Univibe"], MOD_UNIVIBE),
  ]),
  new Block("pitch", "Pitch", 44, 19, [
    ...family(["Pitch Shifter", "Octaver", "Whammy", "Detune"], PITCH_SHIFTER),
    ...family(["Intelligent"], PITCH_INTELLIGENT),
    ...family(["Doubler"], PITCH_DOUBLER),
  ]),
  new Block("reverb", "Reverb", 64, 15, family(["Spring", "Hall", "Room", "Plate"], REVERB)),
  new Block("gate", "Noise gate", 80, 5, [], GATE, "NG"),
  new Block("delay", "Delay", 86, 27, family(
    ["Single Delay", "Tape Delay", "Reverse", "Lo-Fi", "Ping Pong", "Dynamic Delay", "Dual Delay"], DELAY)),
  new Block("eq", "EQ", 114, 10, [], EQ, "EQ"),
];

/** Blocks shown as footswitches on the virtual front panel. */
export const SWITCH_BLOCKS = ["comp", "filter", "mod", "pitch", "delay", "reverb", "eq", "gate"] as const;

export function block(key: string): Block {
  const b = BLOCKS.find((x) => x.key === key);
  if (!b) throw new Error(`unknown block ${key}`);
  return b;
}

export function owner(index: number): Block | null {
  return BLOCKS.find((b) => index >= b.countField && index < b.firstField + b.size) ?? null;
}

/** Fields that differ between two presets: [index, value in a, value in b]. */
export function diffFields(a: Uint8Array, b: Uint8Array): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i < FIELD_COUNT; i++) {
    const off = fieldOffset(i);
    if (a[off] !== b[off] || a[off + 1] !== b[off + 1] || a[off + 2] !== b[off + 2]) {
      out.push([i, readField(a, i), readField(b, i)]);
    }
  }
  return out;
}
