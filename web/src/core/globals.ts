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

export const LEVELS_BLOCK = 1;
export const SYSTEM_BLOCK = 5;
/** Ranges read in one 55 47 request each: [block, first parameter, count]. */
export const GLOBAL_RANGES: [number, number, number][] = [[LEVELS_BLOCK, 0, 30], [SYSTEM_BLOCK, 3, 23], [0x0d, 58, 1]];

const ONOFF = ["Off", "On"];
const PRESET_GLOBAL = ["Preset", "Global"];
const PEDAL_TYPES = ["Off", "Momentané", "Alterné", "Exp.", "Vol."];
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
  { title: "Niveaux (Gbl Levels)", params: [
    p(1, 3, "Input Gain", 0, 26, { format: db(-8), help: "Gain de l'entrée instrument, de −8 à +18 dB" }),
    p(1, 4, "Loop Level", 0, 10, { format: db(), help: "Niveau envoyé dans les boucles" }),
    p(1, 5, "Loop Headroom", 0, 10, { help: "Marge à l'entrée des effets ; sa plage dépend de Loop Level" }),
    p(1, 6, "Volume", -100, 0, { format: db() }),
    e(1, 7, "Volume Pos.", ["Input", "Output"], "Volume avant (Input) ou après (Output) les effets"),
    p(1, 8, "Output Level", -100, 0, { format: db() }),
    p(1, 12, "Boost Max", 0, 10, { format: db(), help: "Boost maximal possible par preset" }),
    e(1, 2, "Input Select", ["Rear", "Front"], "Entrée guitare utilisée sur le GFX01"),
  ] },
  { title: "Utility", params: [
    e(5, 3, "Tap Master", PRESET_GLOBAL, "Au changement de preset : tempo du preset ou tempo tapé"),
    e(1, 24, "Insert Lock", ONOFF, "Garde l'état de la boucle Insert pour tous les presets"),
    e(1, 13, "Boost Lock", ONOFF),
    e(1, 14, "EQ Lock", ONOFF),
    e(1, 25, "Relay Lock", ONOFF),
    e(1, 1, "Routing Lock", ONOFF),
    e(1, 28, "Fact. Bank Lock", ONOFF, "Rend les banques d'usine inaccessibles"),
    p(5, 8, "View Angle", 0, 127, { help: "Contraste de l'écran" }),
    e(5, 25, "KillDry", ONOFF),
  ] },
  { title: "Pédales", params: [
    { ...e(0x0d, 58, "Volume Ctrl.", ["None", "Vol", "Exp", "Enc A", "Enc B", "Enc C"],
      "Pédale (ou encodeur) qui règle le volume"), mask: 7 },
    e(5, 9, "GFX1 Vol. Type", PEDAL_TYPES),
    e(5, 10, "GFX1 Exp. Type", PEDAL_TYPES),
    e(5, 11, "Ctrl Vol. Type", PEDAL_TYPES),
    e(5, 12, "Ctrl Exp. Type", PEDAL_TYPES),
    e(5, 13, "Vol. Master", PRESET_GLOBAL, "Au changement de preset : valeur du preset ou position de la pédale"),
    e(5, 14, "Exp. Master", PRESET_GLOBAL),
  ] },
  { title: "MIDI", params: [
    e(5, 15, "MIDI Channel", CHANNELS),
    e(5, 16, "Prg. Change In", ONOFF),
    e(5, 17, "Prg. Change Out", ["Off", "On", "On Map"]),
    p(5, 19, "SysEx ID", 0, 126, { help: "Doit correspondre au SysEx ID de la vue MIDI pour Store" }),
    e(5, 20, "MIDI Clock In", ONOFF),
    p(5, 21, "Enc. A CC", 0, 127),
    p(5, 22, "Enc. B CC", 0, 127),
    p(5, 23, "Enc. C CC", 0, 127),
    p(5, 24, "Tap CC", 0, 127),
  ] },
  { title: "Accordeur", params: [
    e(5, 5, "Sortie", ["Mute", "On"], "Sortie coupée ou non en mode accordeur"),
    e(5, 6, "Affichage", ["Bar", "Strobe"]),
    p(5, 7, "Référence", 420, 460, { format: (v) => `${v} Hz` }),
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
