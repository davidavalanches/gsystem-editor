/** Preset view: effect tiles, block parameters and the fine-adjust sheet, over an edit buffer. */

import { BANK_COUNT, PRESETS_PER_BANK, bankPosition, slotLabel, type BankStore } from "../core/bank";
import {
  MODIFIER_BLOCK_ID, MODIFIER_FIELD, MODIFIER_PARAM_BASE, MODIFIER_SLOTS, SOURCES, UNASSIGNED, isValidModifier,
  modifierTargets, valueAt, writeModifier, type Modifier, type ModifierTarget,
} from "../core/modifiers";
import {
  BOOST_LEVEL_MAX, BOOST_LEVEL_PARAM, LEVEL_BITS, LEVELS_FIELD, OUTPUTS_FIELD, OUTPUT_MIN, OUTPUT_PARAMS, RELAY_CONTACTS, RELAY_PARAMS,
  ROUTINGS, ROUTING_PARAM, levelOn, presetLevels, presetOutputs, presetRelays, relayText, writeBoostLevel, writeLevel, writeOutputs,
  writeRelay, writeRouting,
} from "../core/levels";
import { ALL_FIELDS, describeField, formatField, rawHex } from "../core/fields";
import { FAVORITE_COUNT, FAVORITE_NAME_LEN, applyFavorite, captureFavorite, favoriteName, matchingFavorite, type Favorite, type Favorites } from "../core/favorites";
import { BLOCKS, Param, block, diffFields, owner, readField, writeField, type Block } from "../core/params";
import { BLOCK_IDS, LEVELS_BLOCK_ID, LEVEL_SWITCHES } from "../core/protocol";
import { NOVA_BLOCK_ID, NOVA_FIELD, NOVA_HEADER_FIELD, NOVA_PRESETS, novaPreset, novaWord, writeNovaPreset, writeNovaWord } from "../core/novadrive";
import { TAP_MAX_MS, TEMPO_BLOCKS, TEMPO_MAX_BPM, bpmToMs, msToBpm, presetTempoMs, syncToTempo, writeTempoMs } from "../core/tempo";
import { NAME_LEN, Preset, SysexError, USER_SLOTS } from "../core/sysex";
import { askText } from "./dialog";
import { LOOP_NAME_LEN, LoopNames } from "./loopnames";
import { DESKTOP, el } from "./dom";
import { ICONS, blockIcon, fillDotNumber, iconButton, onLongPress, routingIcon, showMenu } from "./widgets";

/**
 * The effect blocks in the order of the G-System's signal chain, fixed on the unit:
 * Filter → Comp → loops 1 to 4 and insert → Gate → EQ → the four blocks set by the routing.
 */
const TILES: [string, string][] = [
  ["filter", "Filter"], ["comp", "Comp"], ["gate", "Gate"], ["eq", "EQ"],
  ["mod", "Mod"], ["pitch", "Pitch"], ["delay", "Delay"], ["reverb", "Reverb"],
];
/** Phone: the blocks as on the unit's panel, two per row, before the Modifiers and Routing tiles. */
const GRID = ["filter", "comp", "mod", "pitch", "delay", "reverb", "eq", "gate"];
const CHAIN_BEFORE_LOOPS = ["filter", "comp"];
const CHAIN_AFTER_LOOPS = ["gate", "eq"];
/** The four blocks placed by the routing (Serial, Parallel, Semi Parallel or Serial2). */
const ROUTED = ["mod", "pitch", "delay", "reverb"];
const LOOP_KEYS = ["loop1", "loop2", "loop3", "loop4", "insert"];
/** Taps further apart than this start a new tempo. */
const TAP_RESET_MS = 2000;
const TILE_LABELS: Record<string, string> = { mod: "Modulation", eq: "Parametric EQ" };
/** Pseudo block of the tile list: pedal and encoder assignments. */
const MODIFIERS = "modifiers";
const SHORT_SOURCES = ["—", "VOL", "EXP", "ENC A", "ENC B", "ENC C"];
/** Pseudo block of the tile list: the preset's routing and output levels. */
const ROUTING = "routing";
const OUTPUTS = [0, 1].map((side) =>
  new Param(side ? "Output R" : "Output L", OUTPUT_MIN, 0, [], (v) => `${v} dB`));
/** Preset tempo in BPM, over the tap times' range. */
const TEMPO = new Param("Tempo", msToBpm(TAP_MAX_MS), TEMPO_MAX_BPM, [], (v) => `${v} BPM`);
/** Selection keys of the output and tempo rows (field indexes are below 165). */
const OUTPUT_ROW = 1000;
/** Desktop views of the parameters panel. */
type DeskTab = "block" | "all" | "raw" | "compare";
const DESK_TABS: [DeskTab, string][] = [["block", "Block"], ["all", "All blocks"], ["raw", "Raw"], ["compare", "Compare"]];
/** Compare target: the stored version of the preset, else a bank slot. */
const STORED = -1;
const TEMPO_ROW = 1002;
const NOVA_ROW = 1003;
/** Preset of a TC NDR-1 pedal recalled with the preset. */
const NOVA = new Param("NovaDrive", 0, NOVA_PRESETS, ["None", ...Array.from({ length: NOVA_PRESETS }, (_, i) => `Preset ${i + 1}`)]);
const isModifierField = (index: number) => index >= MODIFIER_FIELD && index < MODIFIER_FIELD + MODIFIER_SLOTS;
const LEVEL_LABELS: [string, string][] = [
  ["loop1", "L1"], ["loop2", "L2"], ["loop3", "L3"], ["loop4", "L4"], ["insert", "INS"],
];
/** Pseudo block: the preset's boost, its own footswitch on the unit, with a level per preset. */
const BOOST = "boost";
/** Pseudo block: the preset's two relay settings (contacts of the Relay jacks) and which one is in use. */
const RELAYS = "relays";
const BOOST_ROW = 1003;

/** Blocks with many parameters (13 to 25): on a phone their knobs would scroll, so they keep sliders. */
const SLIDER_BLOCKS = new Set(["reverb", "delay", "pitch"]);
/** Read out in the block header as well as listed: [parameter name, label]. */
const HEAD_READOUTS: [string, string][] = [["Mix", "Mix"], ["OutLev", "Output"]];

function loadFavorites(key: string): Favorites {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}") as Favorites;
  } catch {
    return {};
  }
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Slider fill: from the left, or from the centre for bipolar ranges. */
function trackGeometry(p: Param, value: number): { left: number; width: number; pos: number } {
  const pos = clamp01((value - p.lo) / (p.hi - p.lo || 1));
  const bipolar = p.lo < 0 && p.hi > 0;
  const zero = bipolar ? clamp01(-p.lo / (p.hi - p.lo)) : 0;
  return { left: Math.min(pos, zero), width: Math.abs(pos - zero), pos };
}

/**
 * Block codes stay whole: one that overflows its tile (with a larger system font on Android, say)
 * is set just small enough to fit, rather than cut.
 */
function fitCodes(root: HTMLElement): void {
  for (const code of root.querySelectorAll<HTMLElement>(".tile-code")) {
    code.style.fontSize = "";
    const room = code.getBoundingClientRect().width;
    if (!room) continue;
    // Fractional widths: an overflow under a pixel is invisible to scrollWidth but still ellipsed.
    const range = document.createRange();
    range.selectNodeContents(code);
    const text = () => range.getBoundingClientRect().width;
    // Whole pixels only: at a fractional size (9.7px, or the 0.75vw of the desktop layout) the capitals of this
    // small display font land on different pixel rows, some letters looking taller than others.
    let size = Math.floor(parseFloat(getComputedStyle(code).fontSize));
    code.style.fontSize = `${size}px`;
    for (let i = 0; i < 8 && text() > room - 0.5 && size > 6; i++) {
      size = Math.max(6, Math.min(size - 1, Math.floor((size * (room - 1)) / text())));
      code.style.fontSize = `${size}px`;
    }
  }
}

/** Potentiometer of a parameter tile: a 270° scale lit up to the value (from the centre when bipolar). */
function knob(p: Param, value: number): string {
  const g = trackGeometry(p, value);
  const r = 16, c = 2 * Math.PI * r, sweep = 0.75 * c;
  const fill = Math.max(0.001, g.width * sweep);
  const angle = -135 + g.pos * 270;
  return `<svg class="knob" viewBox="0 0 40 40" aria-hidden="true">`
    + `<circle class="knob-scale" cx="20" cy="20" r="${r}" stroke-dasharray="${sweep} ${c}" transform="rotate(135 20 20)"/>`
    + `<circle class="knob-arc" cx="20" cy="20" r="${r}" stroke-dasharray="${fill} ${c}" `
    + `stroke-dashoffset="${-g.left * sweep}" transform="rotate(135 20 20)"/>`
    + `<circle class="knob-shadow" cx="20" cy="21" r="11.5"/><circle class="knob-cap" cx="20" cy="20" r="11.5"/>`
    + `<line class="knob-pointer" x1="20" y1="19" x2="20" y2="10.5" transform="rotate(${angle} 20 20)"/></svg>`;
}

function track(p: Param, value: number): HTMLElement {
  const t = el("span", "track");
  const fill = el("span", "track-fill");
  const thumb = el("span", "track-thumb");
  const g = trackGeometry(p, value);
  fill.style.left = `${g.left * 100}%`;
  fill.style.width = `${g.width * 100}%`;
  thumb.style.left = `${g.pos * 100}%`;
  t.append(fill, thumb);
  return t;
}

export class PresetView {
  readonly el = el("section", "view");
  slot = 0;
  buffer: Preset | null = null;
  private stored: Preset | null = null;
  private undoStack: [Preset, Preset][] = [];
  private redoStack: [Preset, Preset][] = [];
  private blockKey = "reverb";
  private paramIndex: number | null = null;
  private live = false;
  private fromUnit = false;
  sendParam: ((blockId: number, param: number, value: number) => void) | null = null;
  onStore: ((slot: number, preset: Preset) => void) | null = null;
  onNotice: ((text: string) => void) | null = null;
  onSlotChange: ((slot: number) => void) | null = null;
  /** A preset was picked in the editor in Live mode (not followed from the unit): recall it on the G-System. */
  onSelect: ((slot: number) => void) | null = null;
  /** The Boost Max global setting of the G-System, when known: the boost level cannot go above it. */
  boostMax: () => number | null = () => null;
  /** Names of the loops of the G-System whose workspace is shown. */
  loopNames = new LoopNames();

  private readonly number = el("div", "dot-number");
  private readonly nameButton = el("button", "preset-name");
  private readonly tempoButton = el("button", "preset-tempo");
  /** Old school theme: the green LCD of the unit, with the name, a status line and the tempo at its top right. */
  private readonly lcd = el("div", "preset-lcd");
  private readonly lcdTempo = el("button", "preset-tempo lcd-tempo");
  /** Live is global: the same toggle shows in the Preset and Banks headers. */
  private readonly liveButtons: HTMLButtonElement[] = [];
  private readonly storeButton = el("button", "pill store", "Store");
  /** Undo step by step; a long press goes back to the preset as stored, in one go. */
  private readonly undoButton = iconButton(ICONS.undo, "Undo (long press: back to the stored preset)", () => this.undo());
  private readonly redoButton = iconButton(ICONS.redo, "Redo", () => this.redo());
  /** Desktop: the differences with the stored version, in the parameters panel. */
  private readonly compareButton = el("button", "pill compare desk-only", "Compare");
  /** Amber LED lit while the preset has changes not stored. */
  private readonly editLed = el("span", "edit-led");
  /** The unit's two green tempo LEDs, lit in turn on each beat of the preset's tempo. */
  private readonly tempoLeds = el("span", "tempo-leds");
  private readonly tapButton = el("button", "pill tap desk-only", "Tap");
  private taps: number[] = [];
  /**
   * Desktop: the signal chain (Filter, Comp, loops, Gate, EQ, then the four routed blocks).
   * Phone: the 2 × 5 panel of blocks, with the Modifiers and Routing tiles.
   */
  private readonly tiles = el("div", "chain");
  private readonly column = el("section", "chain-section");
  private readonly levelBar = el("div", "levels");
  /** Relay: its switch picks setting A or B, like the unit's Relay footswitch; its label opens both settings. */
  private readonly relayBlock = el("div", "boost-block relay-block");
  private readonly boostBlock = el("div", "boost-block");
  private readonly strip = el("div", "preset-strip");
  private readonly lower = el("div", "preset-lower");
  private readonly main = el("div", "preset-main");
  private readonly favoriteBar = el("div", "favorites");
  private readonly params = el("section", "params-section");
  /** Desktop, right of the parameters: the bank's presets, relay and boost, modifiers, outputs. */
  private readonly side = el("aside", "preset-side");
  /** The favorites of the G-System whose workspace is shown, and where they are kept. */
  private favorites: Favorites = {};
  private favoritesKey: string | null = null;
  private tab: DeskTab = "block";
  private compareSlot = STORED;
  private readonly paramsHead = el("div", "params-head");
  private readonly paramsList = el("div", "params");
  private readonly body = el("div", "preset-body");
  /** Desktop: a bank browser on the left and the fine-adjust panel docked on the right. */
  private readonly browser = el("aside", "preset-browser");
  private readonly browserList = el("div", "browser-list");
  private readonly search = el("input", "browser-search");

  constructor(private bank: BankStore) {
    this.nameButton.type = "button";
    this.nameButton.title = "Rename the preset";
    this.nameButton.addEventListener("click", () => void this.rename());
    this.tempoButton.type = "button";
    this.tempoButton.title = "Preset tempo";
    this.tempoButton.addEventListener("click", () => this.openTempoSheet());
    this.lcdTempo.type = "button";
    this.lcdTempo.title = "Preset tempo";
    this.lcdTempo.addEventListener("click", () => this.openTempoSheet());
    this.lcd.append(this.nameButton, this.lcdTempo);
    this.storeButton.type = "button";
    this.storeButton.title = "Store the preset in the editor's bank "
      + "and in the G-System if connected (otherwise at the next sync)";
    this.storeButton.addEventListener("click", () => this.store());
    onLongPress(this.undoButton, () => this.revert());
    this.redoButton.classList.add("redo");
    this.compareButton.type = "button";
    this.compareButton.title = "Differences with the stored version or another preset";
    this.compareButton.addEventListener("click", () => {
      this.tab = this.tab === "compare" ? "block" : "compare";
      this.closeSheet();
      this.render();
    });
    this.tapButton.type = "button";
    this.tapButton.title = "Tap the preset's tempo (two taps or more)";
    this.tapButton.addEventListener("click", () => this.tap());

    this.tempoLeds.append(el("span", "tempo-led"), el("span", "tempo-led"));
    const tempo = el("div", "preset-tempo-group");
    tempo.append(this.tempoLeds, this.tempoButton, this.tapButton);
    this.editLed.append(el("span", "edit-led-dot"), el("span", "edit-led-text", "Modified"));
    this.editLed.setAttribute("role", "status");
    const header = el("header", "header preset-header");
    header.append(
      iconButton(ICONS.prev, "Previous preset", () => this.openSlot((this.slot + USER_SLOTS - 1) % USER_SLOTS)),
      this.number, this.lcd,
      iconButton(ICONS.next, "Next preset", () => this.openSlot((this.slot + 1) % USER_SLOTS)),
      this.editLed, tempo, el("div", "grow"), this.liveButton(), this.undoButton, this.redoButton, this.compareButton,
      this.storeButton,
    );

    this.column.append(this.tiles);
    this.levelBar.setAttribute("aria-label", "Preset loops and insert");
    // Phone: the loops, insert, relay and boost in a strip over the block's settings.
    this.strip.append(this.levelBar, this.relayBlock, this.boostBlock);
    this.params.setAttribute("aria-label", "Parameters");
    this.favoriteBar.setAttribute("aria-label", "Effect favorites");
    this.side.setAttribute("aria-label", "Bank and preset settings");
    this.layout();
    this.search.type = "search";
    this.search.placeholder = "Preset name…";
    this.search.setAttribute("aria-label", "Search for a preset");
    this.search.addEventListener("input", () => this.renderBrowser());
    this.browser.setAttribute("aria-label", "Banks");
    this.browser.append(this.search, this.browserList);
    this.body.append(this.browser, this.main);
    this.el.append(header, this.body);
    DESKTOP.addEventListener("change", () => {
      this.closeSheet();
      this.layout();
      this.render();
      this.renderBrowser();
    });
    this.openSlot(0);
    // Codes are measured in the panel font: again once it has loaded, and when the window changes size.
    void document.fonts?.ready.then(() => fitCodes(this.tiles));
    // Also when the view is shown again: hidden, the tiles have no width to fit into.
    new ResizeObserver(() => fitCodes(this.tiles)).observe(this.tiles);
  }

  /**
   * Desktop: the chain over the block's settings and the side column. Phone: the panel of blocks at the left,
   * the strip of loops, relay and boost over the block's settings at the right.
   */
  private layout(): void {
    const desk = DESKTOP.matches;
    this.column.className = desk ? "chain-section" : "blocks-column";
    this.column.setAttribute("aria-label", desk ? "Signal chain" : "Effect blocks");
    this.tiles.className = desk ? "chain" : "blocks";
    if (desk) {
      this.params.replaceChildren(this.paramsHead, this.favoriteBar, this.paramsList);
      this.lower.replaceChildren(this.params, this.side);
      this.main.replaceChildren(this.column, this.lower);
    } else {
      this.params.replaceChildren(this.strip, this.favoriteBar, this.paramsHead, this.paramsList);
      this.main.replaceChildren(this.column, this.params);
    }
  }

  // Live link

  /** A new Live toggle, kept in step with the others. */
  liveButton(): HTMLButtonElement {
    const button = el("button", "pill live");
    button.type = "button";
    button.innerHTML = '<span class="live-dot"></span>Live';
    button.title = "Send each change to the G-System (working memory, no Store) and follow the unit";
    button.disabled = this.sendParam === null;
    button.addEventListener("click", () => this.setLive(!this.live));
    this.liveButtons.push(button);
    this.renderLive();
    return button;
  }

  setConnected(connected: boolean): void {
    for (const b of this.liveButtons) b.disabled = !connected;
    if (!connected) this.setLive(false);
  }

  get isLive(): boolean {
    return this.live && this.sendParam !== null;
  }

  setLive(on: boolean): void {
    this.live = on;
    // Entering Live mode loads the edited preset into the unit so both match.
    if (on) this.pushToUnit();
    this.render();
  }

  /** Audition the edited preset: write all its parameters into the unit's edit buffer. Nothing is stored. */
  pushToUnit(): void {
    if (!this.buffer || !this.isLive) return;
    for (const blk of BLOCKS) {
      // The type comes first: it selects which parameters the others are.
      for (const [index] of blk.fields(this.buffer.data)) {
        this.sendParam!(BLOCK_IDS[blk.key], index - blk.firstField, readField(this.buffer.data, index));
      }
    }
    // After the types, which select what each modifier slot controls (Vyzor sends them the same way).
    for (let slot = 0; slot < MODIFIER_SLOTS; slot++) {
      this.sendParam!(MODIFIER_BLOCK_ID, MODIFIER_PARAM_BASE + slot, readField(this.buffer.data, MODIFIER_FIELD + slot));
    }
    this.sendRouting(this.buffer.data);
    this.sendParam!(NOVA_BLOCK_ID, 0, novaWord(this.buffer.data));
    this.onNotice?.(`“${this.buffer.name}” loaded into the G-System's working memory`);
  }

  private sendChanges(before: Uint8Array, after: Uint8Array): void {
    if (this.fromUnit || !this.isLive) return;
    for (const [index, , value] of diffFields(before, after)) {
      const blk = owner(index);
      if (blk && index !== blk.countField) this.sendParam!(BLOCK_IDS[blk.key], index - blk.firstField, value);
      else if (isModifierField(index)) this.sendParam!(MODIFIER_BLOCK_ID, MODIFIER_PARAM_BASE + index - MODIFIER_FIELD, value);
      else if (index === LEVELS_FIELD || index === OUTPUTS_FIELD) this.sendRouting(after, index);
      else if (index === NOVA_HEADER_FIELD || index === NOVA_FIELD) this.sendParam!(NOVA_BLOCK_ID, 0, novaWord(after));
      if (index === LEVELS_FIELD) {
        const level = presetLevels(after).boostLevel;
        if (level !== presetLevels(before).boostLevel) this.sendParam!(LEVELS_BLOCK_ID, BOOST_LEVEL_PARAM, level);
        // Relay settings first: the unit applies them to its jacks when the relay switch is set.
        const relays = presetRelays(before);
        let relaysChanged = false;
        presetRelays(after).forEach((v, which) => {
          if (v === relays[which]) return;
          this.sendParam!(LEVELS_BLOCK_ID, RELAY_PARAMS[which], v);
          relaysChanged = true;
        });
        for (const key of Object.keys(LEVEL_BITS)) {
          const on = levelOn(after, key);
          if (on !== levelOn(before, key) || (key === "relay" && relaysChanged)) {
            this.sendParam!(LEVELS_BLOCK_ID, LEVEL_SWITCHES[key], Number(on));
          }
        }
      }
    }
  }

  /** Routing and output levels go to the levels block (1); only those of field 0 are sent, not its loops or boost. */
  private sendRouting(data: Uint8Array, only?: number): void {
    if (only !== OUTPUTS_FIELD) this.sendParam!(LEVELS_BLOCK_ID, ROUTING_PARAM, presetLevels(data).routing);
    if (only !== LEVELS_FIELD) presetOutputs(data).forEach((v, side) => this.sendParam!(LEVELS_BLOCK_ID, OUTPUT_PARAMS[side], v));
  }

  /** A switch or knob was used on the G-System: mirror it in the edit buffer. */
  applyFromUnit(blockId: number, param: number, value: number): void {
    if (blockId === LEVELS_BLOCK_ID && this.buffer && this.live
      && (param === ROUTING_PARAM || param === BOOST_LEVEL_PARAM || OUTPUT_PARAMS.includes(param) || RELAY_PARAMS.includes(param))) {
      this.fromUnit = true;
      try {
        if (param === ROUTING_PARAM) this.setRouting(value);
        else if (param === BOOST_LEVEL_PARAM) this.setBoostLevel(value);
        else if (RELAY_PARAMS.includes(param)) this.setRelay(RELAY_PARAMS.indexOf(param), value);
        else this.setOutput(OUTPUT_PARAMS.indexOf(param), value);
      } finally {
        this.fromUnit = false;
      }
      return;
    }
    if (blockId === LEVELS_BLOCK_ID) {
      const key = Object.keys(LEVEL_SWITCHES).find((k) => LEVEL_SWITCHES[k] === param);
      if (key && this.buffer && this.live) {
        this.fromUnit = true;
        try {
          this.setLevel(key, Boolean(value));
        } finally {
          this.fromUnit = false;
        }
      }
      return;
    }
    if (blockId === NOVA_BLOCK_ID) {
      if (param !== 0 || !this.buffer || !this.live || novaWord(this.buffer.data) === (value & 0xffffff)) return;
      this.fromUnit = true;
      try {
        this.pushBuffer(this.buffer.withData(writeNovaWord(this.buffer.data, value)));
      } finally {
        this.fromUnit = false;
      }
      return;
    }
    const key = Object.keys(BLOCK_IDS).find((k) => BLOCK_IDS[k] === blockId);
    if (!this.buffer || !this.live) return;
    let index: number;
    if (blockId === MODIFIER_BLOCK_ID) {
      index = MODIFIER_FIELD + param - MODIFIER_PARAM_BASE;
      if (!isModifierField(index)) return;
    } else {
      if (!key || param >= block(key).size) return;
      index = block(key).firstField + param;
    }
    this.fromUnit = true;
    try {
      this.setField(index, value);
    } finally {
      this.fromUnit = false;
    }
  }

  /** A preset was recalled on the G-System: show it, without sending it back. */
  followUnit(slot: number): void {
    if (!this.live || slot === this.slot || slot < 0 || slot >= USER_SLOTS) return;
    this.fromUnit = true;
    try {
      this.openSlot(slot);
    } finally {
      this.fromUnit = false;
    }
  }

  // Buffer

  get isDirty(): boolean {
    if (!this.buffer || !this.stored) return this.buffer !== this.stored;
    return this.buffer.data.some((b, i) => b !== this.stored!.data[i]);
  }

  openSlot(slot: number): void {
    if (slot !== this.slot && this.isDirty) {
      if (confirm(`“${this.buffer!.name}” was modified but not stored.\nOK: store it. Cancel: discard the changes.`)) {
        this.store();
      }
    }
    const changed = slot !== this.slot;
    this.slot = slot;
    this.closeSheet();
    this.stored = this.bank.preset(slot);
    this.undoStack = [];
    this.redoStack = [];
    this.setBuffer(this.stored, false);
    this.onSlotChange?.(slot);
    this.renderBrowser();
    // Only in Live mode does picking a preset in the editor recall it on the unit.
    if (changed && !this.fromUnit && this.isLive) {
      this.onSelect?.(slot);
      // After the unit's own recall, so that the edit buffer ends up as the editor shows it.
      setTimeout(() => {
        if (this.slot === slot) this.pushToUnit();
      }, 400);
    }
  }

  /** Desktop browser: every bank with its presets' names, filtered by the search box; and the side column. */
  renderBrowser(): void {
    if (!DESKTOP.matches) return;
    this.renderSide();
    const query = this.search.value.trim().toLowerCase();
    const groups: HTMLElement[] = [];
    for (let b = 0; b < BANK_COUNT; b++) {
      const slots = [...Array(PRESETS_PER_BANK).keys()].map((i) => b * PRESETS_PER_BANK + i)
        .filter((s) => !query || this.bank.preset(s)?.name.toLowerCase().includes(query));
      if (!slots.length) continue;
      const group = el("div", "browser-bank");
      group.append(el("div", "browser-bank-num", String(b).padStart(2, "0")));
      for (const slot of slots) {
        const p = this.bank.preset(slot);
        const row = el("button", ["browser-slot", slot === this.slot ? "current" : "", p ? "" : "empty"].filter(Boolean).join(" "));
        row.type = "button";
        row.append(el("span", "browser-pos", String((slot % PRESETS_PER_BANK) + 1)), el("span", "browser-name", p ? p.name : "—"));
        row.addEventListener("click", () => this.openSlot(slot));
        group.append(row);
      }
      groups.push(group);
    }
    this.browserList.replaceChildren(...(groups.length ? groups : [el("p", "empty-note", "No preset found.")]));
    this.browserList.querySelector(".current")?.scrollIntoView({ block: "nearest" });
  }

  /**
   * Desktop column right of the parameters: the five presets of the bank (with the blocks each has on, in chain
   * order), then the edited preset's relay and boost, its pedal assignments, its outputs and NovaDrive preset.
   */
  private renderSide(): void {
    if (!DESKTOP.matches) return;
    const [bankNum] = bankPosition(this.slot);
    const section = (title: string, onOpen?: () => void) => {
      const box = el("section", "side-section");
      const head = el("div", "side-head");
      head.append(el("span", "side-title", title));
      if (onOpen) {
        const more = el("button", "side-more", "Edit");
        more.type = "button";
        more.addEventListener("click", onOpen);
        head.append(more);
      }
      box.append(head);
      return box;
    };

    const bankBox = section(`Bank ${String(bankNum).padStart(2, "0")}`);
    for (let i = 0; i < PRESETS_PER_BANK; i++) {
      const slot = bankNum * PRESETS_PER_BANK + i;
      const unread = this.bank.unread.has(slot);
      // The edited preset shows as edited, the others as last read from the G-System (or the file).
      const p = slot === this.slot ? this.buffer : this.bank.preset(slot);
      const row = el("button", ["side-preset", slot === this.slot ? "current" : "", p ? "" : "empty",
        unread ? "unread" : ""].filter(Boolean).join(" "));
      row.type = "button";
      row.disabled = unread;
      const name = el("span", "side-preset-name", unread ? "Not read yet" : p ? p.name || "(no name)" : "—");
      const dots = el("span", "block-dots");
      if (p && !unread) {
        for (const [key, code] of TILES) {
          const on = this.isOnIn(block(key), p.data);
          const dot = el("span", on ? "on" : "");
          if (on) dot.style.setProperty("--h", `var(--fx-${key})`);
          dot.title = `${code}${on ? " on" : " off"}`;
          dots.append(dot);
        }
      }
      row.append(el("span", "side-preset-pos", String(i + 1)), name, dots);
      if (slot === this.slot && this.isDirty) row.append(el("span", "side-dirty"));
      row.setAttribute("aria-label", `${slotLabel(slot)} ${unread ? "not read yet" : p?.name ?? "empty"}`);
      row.addEventListener("click", () => this.openSlot(slot));
      bankBox.append(row);
    }

    const parts: HTMLElement[] = [bankBox];
    const preset = this.buffer;
    if (preset) {
      const lv = presetLevels(preset.data);
      const rig = section("Relay and boost", () => this.pick(RELAYS));
      const relay = el("div", "side-segment");
      relay.setAttribute("role", "radiogroup");
      relay.setAttribute("aria-label", "Relay setting in use");
      const inUse = levelOn(preset.data, "relay") ? 0 : 1;
      presetRelays(preset.data).forEach((value, which) => {
        const b = el("button", which === inUse ? "on" : "");
        b.type = "button";
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", String(which === inUse));
        b.title = `Relay ${which ? "B" : "A"}: ${relayText(value)}`;
        b.append(el("span", "side-segment-name", `Relay ${which ? "B" : "A"}`), el("span", "side-segment-sub", relayText(value)));
        b.addEventListener("click", () => this.setLevel("relay", which === 0));
        relay.append(b);
      });
      const boost = el("div", lv.boost ? "side-boost on" : "side-boost");
      const sw = el("button", "side-boost-switch", lv.boost ? "Boost on" : "Boost off");
      sw.type = "button";
      sw.setAttribute("aria-pressed", String(lv.boost));
      sw.addEventListener("click", () => this.setLevel("boost", !lv.boost));
      const level = el("button", "side-boost-level", `${lv.boostLevel} dB`);
      level.type = "button";
      level.title = "Adjust the boost level";
      level.addEventListener("click", () => this.pick(BOOST));
      boost.append(sw, level);
      rig.append(relay, boost);

      const mods = section("Modifiers", () => this.pick(MODIFIERS));
      const assigned = this.assignedModifiers(preset.data);
      if (!assigned.length) mods.append(el("p", "side-note", "None assigned."));
      // Each assignment opens its own settings (source, Min / Mid / Max).
      for (const t of assigned) {
        const row = el("button", "side-row side-link");
        row.type = "button";
        row.title = `${SOURCES[t.modifier.source]}, ${t.modifier.min} / ${t.modifier.mid} / ${t.modifier.max} %`;
        row.append(el("span", "side-row-name", `${this.blockLabel(t.key)} ${t.name}`),
          el("span", "source-chip on small", SHORT_SOURCES[t.modifier.source]));
        row.addEventListener("click", () => {
          this.pick(MODIFIERS);
          this.paramIndex = t.field;
          this.openModifierSheet(t);
        });
        mods.append(row);
      }

      const outs = section("Outputs and NovaDrive", () => this.pick(ROUTING));
      const [left, right] = presetOutputs(preset.data);
      const nova = novaPreset(preset.data);
      for (const [label, value] of [["Output L", `${left} dB`], ["Output R", `${right} dB`],
        ["NovaDrive", NOVA.format(nova)]]) {
        const row = el("div", "side-row");
        row.append(el("span", "side-row-name", label), el("span", "side-row-value", value));
        outs.append(row);
      }
      parts.push(rig, mods, outs);
    }
    this.side.replaceChildren(...parts);
  }

  /** The bank slot changed under us (paste, import, undo, re-read): follow it if not edited. */
  reloadIfShowing(slot: number): void {
    if (slot === this.slot && !this.isDirty) {
      this.stored = this.bank.preset(slot);
      this.setBuffer(this.stored, false);
    }
  }

  private setBuffer(preset: Preset | null, send = true): void {
    if (send && this.buffer && preset) this.sendChanges(this.buffer.data, preset.data);
    this.buffer = preset;
    this.render();
  }

  setField(index: number, value: number): void {
    if (!this.buffer || readField(this.buffer.data, index) === value) return;
    let data: Uint8Array;
    try {
      data = writeField(this.buffer.data, index, value);
    } catch {
      return;
    }
    // A new tap time or note value sets the block's delay time or speed, as on the unit (which does it itself in Live).
    const blk = owner(index);
    if (!this.fromUnit && blk && TEMPO_BLOCKS.includes(blk.key)
      && /^(Tap|Tempo)/.test(blk.fields(data).find(([f]) => f === index)?.[1].name ?? "")) {
      data = syncToTempo(data, blk.key);
    }
    this.pushBuffer(this.buffer.withData(data));
  }

  private setRouting(routing: number): void {
    if (this.buffer && presetLevels(this.buffer.data).routing !== routing) {
      this.pushBuffer(this.buffer.withData(writeRouting(this.buffer.data, routing)));
    }
  }

  private setNovaPreset(n: number): void {
    if (this.buffer && novaPreset(this.buffer.data) !== n) this.pushBuffer(this.buffer.withData(writeNovaPreset(this.buffer.data, n)));
  }

  private setRelay(which: number, value: number): void {
    if (this.buffer && presetRelays(this.buffer.data)[which] !== value) {
      this.pushBuffer(this.buffer.withData(writeRelay(this.buffer.data, which, value)));
    }
  }

  private setOutput(side: number, value: number): void {
    if (!this.buffer) return;
    const outputs = presetOutputs(this.buffer.data);
    if (outputs[side] === value) return;
    outputs[side] = Math.max(OUTPUT_MIN, Math.min(0, value));
    this.pushBuffer(this.buffer.withData(writeOutputs(this.buffer.data, outputs)));
  }

  /** Tempo in BPM: written to the tap times of Filter, Mod and Delay. */
  private setTempo(bpm: number): void {
    if (!this.buffer) return;
    const data = writeTempoMs(this.buffer.data, bpmToMs(bpm));
    if (diffFields(this.buffer.data, data).length) this.pushBuffer(this.buffer.withData(data));
  }

  /** Tap tempo: the average of the last intervals, from the second tap on, within the tempo's range. */
  private tap(): void {
    if (!this.buffer || presetTempoMs(this.buffer.data) === null) return;
    const now = performance.now();
    if (this.taps.length && now - this.taps[this.taps.length - 1] > TAP_RESET_MS) this.taps = [];
    this.taps = [...this.taps, now].slice(-5);
    if (this.taps.length < 2) return;
    const ms = (this.taps[this.taps.length - 1] - this.taps[0]) / (this.taps.length - 1);
    this.setTempo(Math.max(TEMPO.lo, Math.min(TEMPO.hi, Math.round(60000 / ms))));
  }

  /** Shows a block (or the modifiers, routing or boost) in the parameters panel. */
  private pick(key: string): void {
    this.blockKey = key;
    this.tab = "block";
    this.closeSheet();
    this.render();
  }

  private pushBuffer(after: Preset): void {
    this.undoStack.push([this.buffer!, after]);
    this.redoStack = [];
    this.setBuffer(after);
  }

  /** Drop every change since the preset was opened or stored; in Live mode the unit follows. */
  revert(): void {
    if (!this.isDirty || !this.stored) return;
    this.closeSheet();
    this.undoStack = [];
    this.redoStack = [];
    this.setBuffer(this.stored);
  }

  undo(): void {
    const step = this.undoStack.pop();
    if (!step) return;
    this.redoStack.push(step);
    this.setBuffer(step[0]);
  }

  redo(): void {
    const step = this.redoStack.pop();
    if (!step) return;
    this.undoStack.push(step);
    this.setBuffer(step[1]);
  }

  store(): void {
    if (!this.buffer || !this.isDirty) return;
    this.onStore?.(this.slot, this.buffer);
    this.stored = this.buffer;
    this.render();
  }

  private async rename(): Promise<void> {
    if (!this.buffer) return;
    const name = (await askText(`Preset name (${NAME_LEN} characters max.)`, this.buffer.name, NAME_LEN))?.trim();
    if (!name || !this.buffer || name === this.buffer.name) return;
    try {
      this.pushBuffer(this.buffer.withName(name.slice(0, NAME_LEN)));
    } catch (e) {
      if (e instanceof SysexError) alert("Use printable ASCII characters only.");
      else throw e;
    }
  }

  private toggleBlock(key: string): void {
    if (!this.buffer) return;
    const field = block(key).enableField(this.buffer.data);
    if (field !== null) this.setField(field, Number(readField(this.buffer.data, field) !== 1));
  }

  /** Loops, insert and boost are stored in the preset: edited like any field, sent to the unit in Live mode. */
  private setLevel(key: string, on: boolean): void {
    if (this.buffer && levelOn(this.buffer.data, key) !== on) {
      this.pushBuffer(this.buffer.withData(writeLevel(this.buffer.data, key, on)));
    }
  }

  private isOn(blk: Block): boolean {
    return this.buffer !== null && this.isOnIn(blk, this.buffer.data);
  }

  private isOnIn(blk: Block, data: Uint8Array): boolean {
    const field = blk.enableField(data);
    return field !== null && readField(data, field) === 1;
  }

  // Rendering

  private renderLive(): void {
    for (const b of this.liveButtons) {
      b.classList.toggle("active", this.isLive);
      b.setAttribute("aria-pressed", String(this.isLive));
    }
  }

  private render(): void {
    const [b, position] = bankPosition(this.slot);
    fillDotNumber(this.number, b, position);
    // Modern theme: the name alone (changes not stored show as the amber "Modified" LED, Live as its own button).
    // Old school theme: the LCD's second line also tells where the preset comes from, or that it is modified.
    const status = this.isDirty ? "Modified — Store to keep"
      : this.isLive ? "LIVE · edit buffer" : `${this.bank.title} · ${slotLabel(this.slot)}`;
    this.nameButton.replaceChildren(el("span", "name", this.buffer ? this.buffer.name || "(no name)" : "— empty —"),
      el("span", this.isDirty || this.isLive ? "status alert" : "status", status));
    this.nameButton.title = `Rename the preset (${this.bank.title} · ${slotLabel(this.slot)})`;
    const ms = this.buffer ? presetTempoMs(this.buffer.data) : null;
    this.tempoButton.hidden = ms === null;
    this.lcdTempo.hidden = ms === null;
    this.tapButton.hidden = ms === null;
    this.tempoLeds.hidden = ms === null || ms <= 0;
    if (ms !== null) {
      this.tempoButton.textContent = `${msToBpm(ms)} BPM`;
      this.lcdTempo.textContent = `${msToBpm(ms)} BPM`;
      this.tempoButton.setAttribute("aria-label", `Tempo ${msToBpm(ms)} BPM, tap to adjust`);
      this.tempoLeds.style.setProperty("--beat", `${ms}ms`);
      this.tempoLeds.title = `Tempo ${msToBpm(ms)} BPM`;
    }
    this.editLed.hidden = !this.isDirty;
    this.renderLive();
    this.storeButton.classList.toggle("dirty", this.isDirty);
    this.storeButton.disabled = !this.isDirty;
    this.storeButton.replaceChildren("Store", el("span", "store-where", ` in ${slotLabel(this.slot)}`));
    // Enabled while there is something to undo, or changes to drop with a long press.
    this.undoButton.disabled = !this.undoStack.length && !this.isDirty;
    this.redoButton.disabled = !this.redoStack.length;
    this.compareButton.classList.toggle("active", this.tab === "compare");
    this.compareButton.setAttribute("aria-pressed", String(this.tab === "compare"));
    this.renderTiles();
    this.renderLevels();
    this.renderParams();
    this.renderFavorites();
    this.renderSide();
  }

  /**
   * The signal chain, in the unit's order. Desktop: one line from In to Out, the loops stacked, the four routed
   * blocks drawn as the routing places them. Phone: one row of tiles, the loops as a narrow marker (their switches
   * are the chips below) and the routed blocks in a frame with the routing's icon.
   */
  private renderTiles(): void {
    const desk = DESKTOP.matches;
    if (!desk) {
      this.tiles.replaceChildren(...GRID.map((key) => this.blockTile(key)), this.modifiersTile(), this.routingTile());
      requestAnimationFrame(() => fitCodes(this.tiles));
      return;
    }
    const parts: HTMLElement[] = [];
    const link = () => parts.push(el("span", "chain-link"));
    if (desk) {
      parts.push(el("span", "chain-end", "In"));
      link();
    }
    for (const key of CHAIN_BEFORE_LOOPS) {
      parts.push(this.blockTile(key));
      link();
    }
    parts.push(this.loopsBlock());
    for (const key of CHAIN_AFTER_LOOPS) {
      link();
      parts.push(this.blockTile(key));
    }
    link();
    parts.push(this.routedGroup());
    if (desk) {
      link();
      parts.push(el("span", "chain-end", "Out"));
    }
    this.tiles.replaceChildren(...parts);
    requestAnimationFrame(() => fitCodes(this.tiles));
  }

  /** An effect block: its icon switches it on and off, its name shows its settings; long press for its menu. */
  private blockTile(key: string): HTMLElement {
    const blk = block(key);
    const on = this.isOn(blk);
    const tile = el("div", `tile${key === this.blockKey ? " selected" : ""}${on ? " on" : ""}`);
    tile.style.setProperty("--h", `var(--fx-${key})`);
    tile.style.setProperty("--t", `var(--fx-${key}-tint)`);
    const label = TILE_LABELS[blk.key] ?? blk.label;
    const footswitch = el("button", on ? "footswitch on" : "footswitch");
    footswitch.innerHTML = blockIcon(key);
    footswitch.type = "button";
    footswitch.disabled = !this.buffer || blk.enableField(this.buffer.data) === null;
    footswitch.setAttribute("aria-pressed", String(on));
    footswitch.setAttribute("aria-label", `${label}: ${on ? "turn off" : "turn on"}`);
    footswitch.addEventListener("click", () => this.toggleBlock(key));
    const pick = el("button", "tile-label");
    pick.type = "button";
    pick.setAttribute("aria-label", `Show ${label}, ${on ? "on" : "off"}`);
    const kind = this.buffer ? blk.effectType(this.buffer.data)?.name : "";
    const typeShort = blk.hasType ? kind ?? "" : key === "eq" ? "3-band" : "Gate";
    pick.append(el("span", "tile-code", this.blockLabel(key)), el("span", "tile-type", typeShort));
    pick.addEventListener("click", () => this.pick(key));
    onLongPress(tile, (x, y) => this.blockMenu(key, x, y));
    tile.append(footswitch, pick);
    return tile;
  }

  /** Menu of a block: on/off, its favorites, and the modifiers. */
  private blockMenu(key: string, x: number, y: number): void {
    if (!this.buffer) return;
    const blk = block(key);
    const on = this.isOn(blk);
    const slots = (this.favorites[key] ?? []).slice(0, FAVORITE_COUNT);
    showMenu({ x, y }, [
      { label: on ? "Turn off" : "Turn on", action: () => this.toggleBlock(key), disabled: blk.enableField(this.buffer.data) === null },
      ...Array.from({ length: FAVORITE_COUNT }, (_, i) => {
        const fav = slots[i] ?? null;
        return { label: fav ? `Load favorite ${i + 1}: ${favoriteName(fav)}` : `Save as favorite ${i + 1}`,
          action: () => {
            this.pick(key);
            void (fav ? this.loadFavorite(key, i) : this.saveFavorite(key, i));
          } };
      }),
      { label: "Modifiers (pedals and encoders)…", action: () => this.pick(MODIFIERS) },
    ]);
  }

  /** Loops 1 to 4 and the insert, stacked with the pedals' names (long press or right-click to name a loop). */
  private loopsBlock(): HTMLElement {
    const box = el("div", "chain-loops");
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", "Loops and insert");
    for (const key of LOOP_KEYS) {
      const on = this.buffer ? levelOn(this.buffer.data, key) : false;
      const loop = key.startsWith("loop") ? Number(key.slice(4)) - 1 : null;
      const name = loop === null ? "" : this.loopNames.name(loop);
      const b = el("button", on ? "loop-row on" : "loop-row");
      b.type = "button";
      b.disabled = !this.buffer;
      b.setAttribute("aria-pressed", String(on));
      b.setAttribute("aria-label", loop === null ? "Insert" : this.loopNames.label(loop));
      b.title = loop === null ? "Insert (loop 5)" : `Loop ${loop + 1}${name ? `: ${name}` : ""} (long press or right-click: name it)`;
      b.append(el("span", "loop-led"), el("span", "loop-tag", loop === null ? "Ins" : `L${loop + 1}`),
        el("span", "loop-name", name));
      if (loop !== null) onLongPress(b, () => void this.renameLoop(loop));
      b.addEventListener("click", () => this.setLevel(key, !on));
      box.append(b);
    }
    return box;
  }

  /** Mod, Pitch, Delay and Reverb, framed and laid out as the routing places them. */
  private routedGroup(): HTMLElement {
    const routing = this.buffer ? presetLevels(this.buffer.data).routing : 0;
    const name = ROUTINGS[routing] ?? String(routing);
    const group = el("div", `chain-group routing-${routing}${this.blockKey === ROUTING ? " selected" : ""}`);
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", `Routing ${name}`);
    const head = el("div", "chain-group-head");
    const title = el("button", "chain-group-title");
    title.type = "button";
    title.title = "Routing, outputs, tempo and NovaDrive";
    title.setAttribute("aria-label", `Routing ${name}: show its settings`);
    title.insertAdjacentHTML("afterbegin", routingIcon(routing));
    // The routing's name is in the selector beside it.
    title.append(el("span", "", "Routing"));
    title.addEventListener("click", () => this.pick(ROUTING));
    head.append(title);
    head.append(this.routingSelector(routing));
    const tile = (key: string) => this.blockTile(key);
    const lane = (...items: HTMLElement[]) => {
      const row = el("div", "lane");
      items.forEach((item, i) => {
        if (i) row.append(el("span", "chain-link"));
        row.append(item);
      });
      return row;
    };
    const lanes = (...rows: HTMLElement[]) => {
      const box = el("div", "lanes");
      box.append(...rows);
      return box;
    };
    let body: HTMLElement;
    if (routing === 0) body = lane(...ROUTED.map(tile));
    else if (routing === 1) body = lanes(...ROUTED.map((k) => lane(tile(k))));
    else if (routing === 2) body = lane(tile("mod"), tile("pitch"), lanes(lane(tile("delay")), lane(tile("reverb"))));
    else {
      // Serial2: the modulation sits in the delay's feedback loop.
      const loop = el("div", "feedback");
      loop.append(tile("delay"), el("span", "feedback-tag", "Feedback"), tile("mod"));
      body = lane(tile("pitch"), loop, tile("reverb"));
    }
    body.classList.add("chain-group-body");
    group.append(head, body);
    return group;
  }

  /** Four buttons with the routings' diagrams, one lit. */
  private routingSelector(current: number): HTMLElement {
    const choice = el("div", "routing-choice");
    choice.setAttribute("role", "radiogroup");
    choice.setAttribute("aria-label", "Routing type");
    ROUTINGS.forEach((name, i) => {
      const b = el("button", i === current ? "on" : "");
      b.type = "button";
      b.disabled = !this.buffer;
      b.title = name;
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(i === current));
      b.insertAdjacentHTML("afterbegin", routingIcon(i));
      b.append(el("span", "", name === "Semi Parallel" ? "Semi Par." : name));
      b.addEventListener("click", () => this.setRouting(i));
      choice.append(b);
    });
    return choice;
  }

  private assignedModifiers(data: Uint8Array): ModifierTarget[] {
    return modifierTargets(data, true).filter((t) => t.modifier.source && isValidModifier(t.modifier));
  }

  private renderLevels(): void {
    this.levelBar.replaceChildren(...LEVEL_LABELS.map(([key, label]) => {
      const on = this.buffer ? levelOn(this.buffer.data, key) : false;
      const loop = key.startsWith("loop") ? Number(key.slice(4)) - 1 : null;
      const name = loop === null ? "" : this.loopNames.name(loop);
      const b = el("button", ["level", on ? "on" : "", name ? "named" : ""].filter(Boolean).join(" "));
      // Short on a phone ("L1", "INS"), spelled out on a desktop ("LOOP 1", "INSERT"): CSS picks one.
      const tag = el("span", "level-tag");
      tag.append(el("span", "level-short", label),
        el("span", "level-long", key === "insert" ? "INSERT" : `LOOP ${label.slice(1)}`));
      // A named loop: its number small on top, the pedal's name below.
      if (name) {
        const text = el("span", "level-text");
        text.append(tag, el("span", "level-name", name));
        b.append(text);
      } else b.append(tag);
      b.type = "button";
      b.disabled = !this.buffer;
      b.title = label === "INS" ? "Insert (loop 5)"
        : `Loop ${label.slice(1)}${name ? `: ${name}` : ""} (long press or right-click: name it)`;
      b.setAttribute("aria-label", label === "INS" ? "Insert" : this.loopNames.label(loop!));
      b.setAttribute("aria-pressed", String(on));
      // Registered before the click, so the click ending a long press is swallowed.
      if (loop !== null) onLongPress(b, () => void this.renameLoop(loop));
      b.addEventListener("click", () => this.setLevel(key, !on));
      return b;
    }));
    this.renderBoostBlock();
    this.renderRelayBlock();
  }

  /**
   * The relay switch picks which of the preset's two relay settings drives the Relay jacks: A or B, never
   * both, like the unit's Relay footswitch. Relay A is in use when the switch (block 1 parameter 16) is on:
   * tried on the unit, editing the other setting in Live changed the amp's channel.
   * Its label opens both settings, as the boost's opens its level.
   */
  private renderRelayBlock(): void {
    const on = this.buffer ? levelOn(this.buffer.data, "relay") : false;
    const [inUse, other] = on ? ["A", "B"] : ["B", "A"];
    this.relayBlock.className = ["boost-block relay-block", this.blockKey === RELAYS ? "selected" : ""].filter(Boolean).join(" ");
    const sw = el("button", "boost-switch relay-switch", inUse);
    sw.type = "button";
    sw.disabled = !this.buffer;
    sw.title = `Relay ${inUse} in use: tap for Relay ${other}`;
    sw.setAttribute("aria-label", `Relay ${inUse} in use, switch to ${other}`);
    sw.addEventListener("click", () => this.setLevel("relay", !on));
    const pick = el("button", "boost-pick");
    pick.type = "button";
    pick.disabled = !this.buffer;
    pick.setAttribute("aria-label", "Relay settings A and B");
    const value = this.buffer ? relayText(presetRelays(this.buffer.data)[on ? 0 : 1]) : "—";
    pick.append(el("span", "boost-name", "Relay"), el("span", "boost-level", value));
    pick.addEventListener("click", () => this.pick(RELAYS));
    this.relayBlock.replaceChildren(sw, pick);
  }

  /** Phone: the preset's pedal and encoder assignments, as a tile under the blocks. */
  private modifiersTile(): HTMLElement {
    const assigned = this.buffer ? this.assignedModifiers(this.buffer.data) : [];
    const sources = [...new Set(assigned.map((t) => SHORT_SOURCES[t.modifier.source]))];
    const tile = el("button", `tile stack${this.blockKey === MODIFIERS ? " selected" : ""}${assigned.length ? " on" : ""}`);
    tile.type = "button";
    tile.setAttribute("aria-label", `Pedals and encoders, ${assigned.length} assignment(s)`);
    tile.title = assigned.map((t) => `${this.blockLabel(t.key)} ${t.name}`).join(", ");
    tile.append(el("span", "tile-code", "Modifiers"),
      el("span", assigned.length ? "tile-count" : "tile-count none",
        assigned.length ? `${assigned.length} · ${sources.join(" ")}` : "none"));
    tile.addEventListener("click", () => this.pick(MODIFIERS));
    return tile;
  }

  /** Phone: the routing (and the outputs, tempo, NovaDrive) as a tile under the blocks. */
  private routingTile(): HTMLElement {
    const tile = el("button", `tile stack${this.blockKey === ROUTING ? " selected" : ""}`);
    tile.type = "button";
    const type = el("span", "tile-type tile-routing");
    if (this.buffer) {
      const routing = presetLevels(this.buffer.data).routing;
      const [left, right] = presetOutputs(this.buffer.data);
      type.insertAdjacentHTML("afterbegin", routingIcon(routing));
      type.append(ROUTINGS[routing] ?? String(routing));
      tile.title = `L ${left} dB · R ${right} dB`;
      tile.setAttribute("aria-label", `Routing ${ROUTINGS[routing] ?? routing}, outputs ${left} and ${right} dB`);
    }
    tile.append(el("span", "tile-code", "Routing"), type);
    tile.addEventListener("click", () => this.pick(ROUTING));
    return tile;
  }

  /** Boost: its switch (LED) toggles it, its label shows its level and opens it like an effect block. */
  /** Name the pedal in a loop, for this G-System. */
  private async renameLoop(loop: number): Promise<void> {
    const name = await askText(`Loop ${loop + 1} on this G-System: the pedal in it (${LOOP_NAME_LEN} characters max., empty for none)`,
      this.loopNames.name(loop), LOOP_NAME_LEN);
    if (name !== null) this.loopNames.set(loop, name);
  }

  /** The loop names changed, or another G-System's are shown. */
  loopNamesChanged(): void {
    this.renderLevels();
    this.renderTiles();
  }

  private renderBoostBlock(): void {
    const lv = this.buffer ? presetLevels(this.buffer.data) : null;
    const on = !!lv?.boost;
    this.boostBlock.className = ["boost-block", on ? "on" : "", this.blockKey === BOOST ? "selected" : ""].filter(Boolean).join(" ");
    const led = el("button", "boost-switch");
    led.type = "button";
    led.disabled = !this.buffer;
    led.setAttribute("aria-pressed", String(on));
    led.setAttribute("aria-label", on ? "Turn boost off" : "Turn boost on");
    led.addEventListener("click", () => this.setLevel("boost", !on));
    const pick = el("button", "boost-pick");
    pick.type = "button";
    pick.disabled = !this.buffer;
    pick.setAttribute("aria-label", `Adjust boost, ${lv ? lv.boostLevel : 0} dB`);
    pick.append(el("span", "boost-name", "Boost"), el("span", "boost-level", lv ? `${lv.boostLevel} dB` : "—"));
    pick.addEventListener("click", () => this.pick(BOOST));
    this.boostBlock.replaceChildren(led, pick);
  }

  private setBoostLevel(level: number): void {
    if (this.buffer && presetLevels(this.buffer.data).boostLevel !== level) {
      this.pushBuffer(this.buffer.withData(writeBoostLevel(this.buffer.data, level)));
    }
  }

  /** The boost as a block: on/off in the header, its level as a parameter. */
  private renderBoost(): void {
    this.paramsList.classList.remove("on-block");
    const preset = this.buffer;
    this.paramsHead.replaceChildren(el("span", "label", "Boost"));
    if (!preset) {
      this.paramsList.replaceChildren(el("p", "empty-note", "Empty slot."));
      return;
    }
    const lv = presetLevels(preset.data);
    this.paramsHead.append(el("div", "grow"));
    const sw = el("button", lv.boost ? "switch on" : "switch");
    sw.type = "button";
    sw.setAttribute("aria-pressed", String(lv.boost));
    sw.setAttribute("aria-label", lv.boost ? "Turn boost off" : "Turn boost on");
    const trackEl = el("span", "switch-track");
    trackEl.append(el("span", "switch-knob"));
    sw.append(trackEl, el("span", "switch-text", lv.boost ? "On" : "Off"));
    sw.addEventListener("click", () => this.setLevel("boost", !lv.boost));
    this.paramsHead.append(sw);
    this.paramsList.classList.toggle("on-block", lv.boost);
    const max = this.boostMax();
    const param = new Param("Level", 0, Math.min(BOOST_LEVEL_MAX, max ?? BOOST_LEVEL_MAX), [], (v) => `${v} dB`);
    const note = max === null
      ? "Level added when the boost is on. The G-System caps it at the Boost Max global setting (Gbl Levels), not read yet."
      : lv.boostLevel > max
        ? `Stored at ${lv.boostLevel} dB, above the Boost Max global setting (${max} dB): the G-System plays ${max} dB.`
        : `Level added when the boost is on, up to the Boost Max global setting (${max} dB, Gbl Levels).`;
    this.paramsList.replaceChildren(
      this.paramRow(BOOST_ROW, param, lv.boostLevel, () =>
        this.openValueSheet("Boost · Level", `field #${LEVELS_FIELD}`, param, lv.boostLevel, (v) => this.setBoostLevel(v)),
        (v) => this.setBoostLevel(v)),
      el("p", "params-note", note));
  }

  /** The Boost Max global setting changed: redraw the boost if it is shown. */
  boostMaxChanged(): void {
    if (this.blockKey === BOOST) this.render();
  }

  /** Shows the favorites of another G-System's workspace. */
  useFavorites(key: string): void {
    this.favoritesKey = key;
    this.favorites = loadFavorites(key);
    this.renderFavorites();
  }

  /** The four favorites of the shown effect: tap to load (or to save into an empty one), long-press for more. */
  private renderFavorites(): void {
    const key = this.blockKey;
    const isEffect = key !== MODIFIERS && key !== ROUTING && key !== BOOST && key !== RELAYS && (this.tab === "block" || !DESKTOP.matches);
    this.favoriteBar.hidden = !isEffect || !this.buffer;
    if (this.favoriteBar.hidden) return;
    const slots = (this.favorites[key] ?? []).slice(0, FAVORITE_COUNT);
    const match = matchingFavorite(this.buffer!.data, key, slots);
    this.favoriteBar.replaceChildren(el("span", "favorites-title", "FAV"), ...Array.from({ length: FAVORITE_COUNT }, (_, i) => {
      const fav = slots[i] ?? null;
      const b = el("button", fav ? `favorite${i === match ? " match" : ""}` : "favorite empty");
      b.type = "button";
      b.append(el("span", "favorite-num", String(i + 1)), el("span", "favorite-label", fav ? favoriteName(fav) : "+"));
      b.title = fav ? `Load favorite ${i + 1}: ${favoriteName(fav)} (${fav.label}) — long press: more options`
        : `Save the current settings to favorite ${i + 1}`;
      onLongPress(b, (x, y) => showMenu({ x, y }, [
        { label: "Load", action: () => this.loadFavorite(key, i), disabled: !fav },
        { label: fav ? "Replace with current settings" : "Save current settings",
          action: () => this.saveFavorite(key, i) },
        { label: "Rename", action: () => this.renameFavorite(key, i), disabled: !fav },
        { label: "Clear", action: () => this.saveFavorite(key, i, true), disabled: !fav },
      ]));
      b.addEventListener("click", () => (fav ? this.loadFavorite(key, i) : this.saveFavorite(key, i)));
      return b;
    }));
  }

  /** Saves the current settings into a favorite, under a name asked for first (the previous one, else the effect type). */
  private async saveFavorite(key: string, index: number, clear = false): Promise<void> {
    if (!this.buffer) return;
    let name: string | undefined;
    if (!clear) {
      const previous = this.favorites[key]?.[index];
      const suggested = previous?.name ?? block(key).effectType(this.buffer.data)?.name ?? block(key).label;
      const answer = await askText(`Favorite ${index + 1} name (${FAVORITE_NAME_LEN} characters max.)`, suggested, FAVORITE_NAME_LEN);
      if (answer === null || !this.buffer) return;
      name = answer.trim() || undefined;
    }
    this.storeFavorite(key, index, clear ? null : captureFavorite(this.buffer.data, key, name));
    const fav = this.favorites[key]?.[index];
    this.onNotice?.(fav ? `Favorite ${index + 1} saved: ${favoriteName(fav)}` : `Favorite ${index + 1} cleared`);
  }

  private async renameFavorite(key: string, index: number): Promise<void> {
    const fav = this.favorites[key]?.[index];
    if (!fav) return;
    const answer = await askText(`Favorite ${index + 1} name (${FAVORITE_NAME_LEN} characters max.)`, favoriteName(fav), FAVORITE_NAME_LEN);
    if (answer === null) return;
    const { name: _old, ...rest } = fav;
    const name = answer.trim();
    this.storeFavorite(key, index, name ? { ...rest, name } : rest);
  }

  private storeFavorite(key: string, index: number, fav: Favorite | null): void {
    const slots: (Favorite | null)[] = [...(this.favorites[key] ?? [])];
    while (slots.length < FAVORITE_COUNT) slots.push(null);
    slots[index] = fav;
    this.favorites = { ...this.favorites, [key]: slots };
    try {
      if (this.favoritesKey) localStorage.setItem(this.favoritesKey, JSON.stringify(this.favorites));
    } catch {
      alert("Cannot save favorites on this device.");
    }
    this.renderFavorites();
  }

  private loadFavorite(key: string, index: number): void {
    const fav = this.favorites[key]?.[index];
    if (!this.buffer || !fav) return;
    try {
      const data = applyFavorite(this.buffer.data, key, fav);
      if (diffFields(this.buffer.data, data).length) this.pushBuffer(this.buffer.withData(data));
      this.onNotice?.(`Favorite ${index + 1} loaded: ${favoriteName(fav)}`);
    } catch (e) {
      alert(`Unreadable favorite: ${(e as Error).message}`);
    }
  }

  private renderParams(): void {
    const desk = DESKTOP.matches;
    // A control used with the keyboard keeps the focus once the list is rebuilt.
    const active = document.activeElement as HTMLElement | null;
    const focused = active && this.paramsList.contains(active) ? active.closest<HTMLElement>("[data-row]")?.dataset.row : undefined;
    this.paramsList.classList.remove("wide-list", "row-list", "slider-list");
    // Knob arcs and sliders take the colour of the block shown.
    const effect = TILES.some(([k]) => k === this.blockKey) && (this.tab === "block" || !desk);
    if (effect) {
      this.params.style.setProperty("--h", `var(--fx-${this.blockKey})`);
      this.params.style.setProperty("--t", `var(--fx-${this.blockKey}-tint)`);
    } else {
      this.params.style.removeProperty("--h");
      this.params.style.removeProperty("--t");
    }
    if (desk && this.tab === "all") this.renderAllBlocks();
    else if (desk && this.tab === "raw") this.renderRaw();
    else if (desk && this.tab === "compare") this.renderCompare();
    else this.renderBlockParams();
    if (desk) this.paramsHead.append(this.deskTabs());
    if (focused !== undefined) {
      this.paramsList.querySelector<HTMLElement>(`[data-row="${focused}"] :is(.knob-control, select)`)?.focus();
    }
  }

  private deskTabs(): HTMLElement {
    const tabs = el("div", "desk-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Parameters view");
    for (const [key, label] of DESK_TABS) {
      const b = el("button", key === this.tab ? "on" : "", label);
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(key === this.tab));
      b.addEventListener("click", () => {
        this.tab = key;
        this.closeSheet();
        this.render();
      });
      tabs.append(b);
    }
    return tabs;
  }

  /** Every effect block at once: its type, on/off and parameters, each one adjustable. */
  private renderAllBlocks(): void {
    this.paramsHead.replaceChildren(el("span", "label", "All blocks"), el("div", "grow"));
    this.paramsList.classList.remove("on-block");
    const preset = this.buffer;
    if (!preset) {
      this.paramsList.replaceChildren(el("p", "empty-note", "Empty slot."));
      return;
    }
    const rows: HTMLElement[] = [];
    for (const [key, code] of TILES) {
      const blk = block(key);
      const on = this.isOn(blk);
      const head = el("button", on ? "all-head on" : "all-head");
      head.style.setProperty("--h", `var(--fx-${key})`);
      head.style.setProperty("--t", `var(--fx-${key}-tint)`);
      head.type = "button";
      head.title = `Show ${blk.label} alone`;
      head.append(el("span", "all-code", code),
        el("span", "all-type", blk.effectType(preset.data)?.name ?? (key === "eq" ? "3-band" : "Gate")),
        el("span", on ? "all-state on" : "all-state", on ? "On" : "Off"));
      head.addEventListener("click", () => {
        this.blockKey = key;
        this.tab = "block";
        this.render();
      });
      rows.push(head);
      for (const [index, p] of blk.shownFields(preset.data)) {
        if ((blk.hasType && index === blk.firstField) || p.name === blk.enableName) continue;
        const row = this.paramRow(index, p, readField(preset.data, index), () => this.openSheet(index), (v) => this.setField(index, v));
        // The list mixes blocks on and off: each row lights its indicators from its own block.
        row.classList.toggle("on-block", on);
        rows.push(row);
      }
    }
    this.paramsList.replaceChildren(...rows);
  }

  /** All 165 fields: what each holds, raw and as shown; those changed since the last Store are marked. */
  private renderRaw(): void {
    const preset = this.buffer;
    const changed = new Set(preset && this.stored ? diffFields(this.stored.data, preset.data).map(([i]) => i) : []);
    this.paramsHead.replaceChildren(el("span", "label", "Raw"), el("div", "grow"),
      el("span", "params-hint", preset ? `${ALL_FIELDS.length} fields · ${changed.size} modified` : ""));
    this.paramsList.classList.remove("on-block");
    this.paramsList.classList.add("wide-list");
    if (!preset) {
      this.paramsList.replaceChildren(el("p", "empty-note", "Empty slot."));
      return;
    }
    const table = el("table", "field-table");
    const head = el("tr");
    for (const h of ["#", "Group", "Parameter", "Raw", "Value"]) head.append(el("th", "", h));
    table.append(head);
    for (const index of ALL_FIELDS) {
      const info = describeField(preset.data, index);
      const row = el("tr", [changed.has(index) ? "changed" : "", info.param ? "editable" : ""].filter(Boolean).join(" "));
      row.append(el("td", "num", String(index)), el("td", "", info.group), el("td", "", info.name),
        el("td", "num", rawHex(preset.data, index)), el("td", "", formatField(preset.data, index)));
      if (info.param && owner(index)) {
        row.tabIndex = 0;
        row.addEventListener("click", () => this.openSheet(index));
        row.addEventListener("keydown", (e) => {
          if (e.key === "Enter") this.openSheet(index);
        });
      }
      table.append(row);
    }
    this.paramsList.replaceChildren(table);
  }

  /** Differences with the stored version or another preset; each can be taken over. */
  private renderCompare(): void {
    const preset = this.buffer;
    const select = el("select", "type-select compare-select");
    select.setAttribute("aria-label", "Compare with");
    select.append(new Option("Stored version", String(STORED)));
    this.bank.presets.forEach((p, slot) => {
      if (p && slot !== this.slot) select.append(new Option(`${slotLabel(slot)} ${p.name}`, String(slot)));
    });
    select.value = String(this.compareSlot);
    if (select.value !== String(this.compareSlot)) {
      this.compareSlot = STORED;
      select.value = String(STORED);
    }
    select.addEventListener("change", () => {
      this.compareSlot = Number(select.value);
      this.render();
    });
    const other = this.compareSlot === STORED ? this.stored : this.bank.preset(this.compareSlot);
    const diffs = preset && other ? diffFields(preset.data, other.data) : [];
    this.paramsHead.replaceChildren(el("span", "label", "Compare with"), select, el("div", "grow"),
      el("span", "params-hint", preset && other ? `${diffs.length} difference(s)` : ""));
    this.paramsList.classList.remove("on-block");
    this.paramsList.classList.add("wide-list");
    if (!preset || !other) {
      this.paramsList.replaceChildren(el("p", "empty-note", "Nothing to compare."));
      return;
    }
    if (!diffs.length && preset.name === other.name) {
      this.paramsList.replaceChildren(el("p", "empty-note", "No differences."));
      return;
    }
    const table = el("table", "field-table compare");
    const head = el("tr");
    for (const h of ["#", "Group", "Parameter", "This preset", other === this.stored ? "Stored" : other.name, ""]) {
      head.append(el("th", "", h));
    }
    table.append(head);
    if (preset.name !== other.name) {
      const row = el("tr");
      const take = el("button", "take", "← Take");
      take.type = "button";
      take.addEventListener("click", () => this.pushBuffer(this.buffer!.withName(other.name)));
      const cell = el("td");
      cell.append(take);
      row.append(el("td", "num", "—"), el("td", "", "Preset"), el("td", "", "Name"), el("td", "", preset.name),
        el("td", "", other.name), cell);
      table.append(row);
    }
    for (const [index, , theirs] of diffs) {
      const mine = describeField(preset.data, index);
      const their = describeField(other.data, index);
      const name = mine.name === their.name ? mine.name : `${mine.name} / ${their.name}`;
      // A block whose type (or parameter count) differs is taken whole: its fields only mean
      // something together, and the count must match the type.
      const blk = owner(index);
      const whole = blk !== null && blk.allFields().slice(0, 2).some((f) => readField(preset.data, f) !== readField(other.data, f));
      const take = el("button", "take", whole ? "← Take block" : "← Take");
      take.type = "button";
      take.title = whole ? `The type differs: take the whole ${blk!.label} block` : "Take this value into this preset";
      take.addEventListener("click", () => {
        if (!this.buffer) return;
        if (!whole) return this.setField(index, theirs);
        const data = blk!.allFields().reduce((d, f) => writeField(d, f, readField(other.data, f)), this.buffer.data);
        this.pushBuffer(this.buffer.withData(data));
      });
      const cell = el("td");
      cell.append(take);
      const row = el("tr");
      row.append(el("td", "num", String(index)), el("td", "", mine.group), el("td", "", name),
        el("td", "", formatField(preset.data, index)), el("td", "", formatField(other.data, index)), cell);
      table.append(row);
    }
    this.paramsList.replaceChildren(table);
  }

  private renderBlockParams(): void {
    if (this.blockKey === MODIFIERS) {
      this.renderModifiers();
      return;
    }
    if (this.blockKey === ROUTING) {
      this.renderRouting();
      return;
    }
    if (this.blockKey === BOOST) {
      this.renderBoost();
      return;
    }
    if (this.blockKey === RELAYS) {
      this.renderRelays();
      return;
    }
    const blk = block(this.blockKey);
    const preset = this.buffer;
    const on = this.isOn(blk);
    // The block's icon, filled with its colour when it is on, like its tile in the chain.
    const icon = el("span", on ? "head-icon on" : "head-icon");
    icon.innerHTML = blockIcon(blk.key);
    this.paramsHead.replaceChildren(icon, el("span", "label", TILE_LABELS[blk.key] ?? blk.label));
    if (!preset) {
      this.paramsList.replaceChildren(el("p", "empty-note", "Empty slot."));
      return;
    }
    if (blk.hasType) {
      const select = el("select", "type-select");
      select.setAttribute("aria-label", "Effect type");
      blk.types.forEach((t, i) => select.append(new Option(t.name, String(i))));
      select.value = String(readField(preset.data, blk.firstField));
      select.addEventListener("change", () => this.setField(blk.firstField, Number(select.value)));
      this.paramsHead.append(select);
    }
    const field = blk.enableField(preset.data);
    if (field !== null) {
      const sw = el("button", on ? "switch on" : "switch");
      sw.type = "button";
      sw.setAttribute("aria-pressed", String(on));
      sw.setAttribute("aria-label", `${blk.label}: ${on ? "turn off" : "turn on"}`);
      const trackEl = el("span", "switch-track");
      trackEl.append(el("span", "switch-knob"));
      sw.append(trackEl, el("span", "switch-text", on ? "On" : "Off"));
      sw.addEventListener("click", () => this.toggleBlock(blk.key));
      this.paramsHead.append(sw);
    }
    // Mix and output level read out at the far right, in sight without scrolling; they are set in the list.
    this.paramsHead.append(el("div", "grow"));
    const readouts = HEAD_READOUTS.flatMap(([name, label]) => {
      const found = blk.shownFields(preset.data).find(([, p]) => p.name === name);
      return found ? [[label, found[1].format(readField(preset.data, found[0]))]] : [];
    });
    if (readouts.length) {
      const box = el("span", "head-levels");
      box.setAttribute("aria-label", readouts.map(([l, v]) => `${l} ${v}`).join(", "));
      for (const [label, value] of readouts) {
        const line = el("span", "head-level");
        line.append(el("span", "head-level-name", label), el("span", "head-level-value", value));
        box.append(line);
      }
      this.paramsHead.append(box);
    }
    this.paramsList.classList.toggle("on-block", on);
    // Type and on/off are in the block header.
    const rows = blk.shownFields(preset.data)
      .filter(([index, p]) => !(blk.hasType && index === blk.firstField) && p.name !== blk.enableName);
    const pedals = new Map(this.assignedModifiers(preset.data).map((t) => [t.paramField, t.modifier.source]));
    this.paramsList.classList.toggle("slider-list", SLIDER_BLOCKS.has(blk.key) && !DESKTOP.matches);
    this.paramsList.replaceChildren(...rows.map(([index, p]) =>
      this.paramRow(index, p, readField(preset.data, index), () => this.openSheet(index), (v) => this.setField(index, v),
        pedals.get(index))));
  }

  private openTempoSheet(): void {
    const ms = this.buffer ? presetTempoMs(this.buffer.data) : null;
    if (ms === null) return;
    this.openValueSheet(`Tempo · ${ms} ms`, "tap Filter, Mod, Delay", TEMPO, msToBpm(ms), (next) => this.setTempo(next));
  }

  /** Routing type and output levels: global menus on the unit, but stored in each preset. */
  private renderRouting(): void {
    this.paramsHead.replaceChildren(el("span", "label", "Routing"));
    this.paramsList.classList.add("on-block");
    const preset = this.buffer;
    if (!preset) {
      this.paramsList.replaceChildren(el("p", "empty-note", "Empty slot."));
      return;
    }
    this.paramsHead.append(el("div", "grow"));
    // One button per routing, a single one lit: one tap instead of opening a list.
    const choice = this.routingSelector(presetLevels(preset.data).routing);
    const rows: HTMLElement[] = [choice, ...presetOutputs(preset.data).map((v, side) =>
      this.paramRow(OUTPUT_ROW + side, OUTPUTS[side], v, () =>
        this.openValueSheet(`Routing · ${OUTPUTS[side].name}`, `field #${OUTPUTS_FIELD}`, OUTPUTS[side], v,
          (next) => this.setOutput(side, next)), (next) => this.setOutput(side, next)))];
    const ms = presetTempoMs(preset.data);
    if (ms !== null) rows.push(this.paramRow(TEMPO_ROW, TEMPO, msToBpm(ms), () => this.openTempoSheet(), (bpm) => this.setTempo(bpm)));
    // The NovaDrive pedal's preset last: an external pedal, after the unit's own settings.
    const nova = novaPreset(preset.data);
    rows.push(this.paramRow(NOVA_ROW, NOVA, nova, () => this.openValueSheet("Routing · NovaDrive", "NDR-1 pedal preset", NOVA, nova,
      (next) => this.setNovaPreset(next)), (next) => this.setNovaPreset(next)));
    this.paramsList.replaceChildren(...rows);
  }

  /** Relay settings A and B: which contacts of the Relay jacks close (amp channels…), picked by the Relay switch. */
  private renderRelays(): void {
    this.paramsHead.replaceChildren(el("span", "label", "Relays"));
    this.paramsList.classList.add("on-block");
    const preset = this.buffer;
    if (!preset) {
      this.paramsList.replaceChildren(el("p", "empty-note", "Empty slot."));
      return;
    }
    this.paramsHead.append(el("div", "grow"), el("span", "params-hint", "Tap a contact to close or open it"));
    const inUse = levelOn(preset.data, "relay") ? 0 : 1;
    this.paramsList.replaceChildren(...presetRelays(preset.data).map((value, which) => this.relayRow(which, value, which === inUse)),
      el("p", "params-note", "The Relay switch of the G-System (or the Relay button) picks which setting drives the Relay jacks."));
  }

  /** One relay setting: picked as the one in use (A or B), and its four contacts. */
  private relayRow(which: number, value: number, inUse: boolean): HTMLElement {
    const name = which ? "Relay B" : "Relay A";
    const row = el("div", inUse ? "relay-row in-use" : "relay-row");
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", `${name}${inUse ? " (in use)" : ""}: ${relayText(value)}`);
    const pick = el("button", "relay-pick");
    pick.type = "button";
    pick.setAttribute("role", "radio");
    pick.setAttribute("aria-checked", String(inUse));
    pick.title = inUse ? `${name} drives the Relay jacks` : `Use ${name}`;
    pick.append(el("span", "relay-pick-dot"), el("span", "", name));
    pick.addEventListener("click", () => this.setLevel("relay", which === 0));
    const contacts = el("span", "relay-contacts");
    for (let i = 0; i < RELAY_CONTACTS; i++) {
      const closed = ((value >> i) & 1) === 1;
      const b = el("button", closed ? "relay-contact on" : "relay-contact", String(i + 1));
      b.type = "button";
      b.setAttribute("aria-pressed", String(closed));
      b.title = `Contact ${i + 1}: ${closed ? "closed" : "open"}`;
      b.addEventListener("click", () => this.setRelay(which, value ^ (1 << i)));
      contacts.append(b);
    }
    row.append(pick, contacts, el("span", "relay-text", relayText(value)));
    return row;
  }

  private renderModifiers(): void {
    this.paramsHead.replaceChildren(el("span", "label", "Modifiers"), el("div", "grow"));
    this.paramsList.classList.remove("on-block");
    const preset = this.buffer;
    if (!preset) {
      this.paramsList.replaceChildren(el("p", "empty-note", "Empty slot."));
      return;
    }
    this.paramsHead.append(el("span", "params-hint", "Parameters controllable with the current effect types"));
    // NovaDrive slots only matter with a NovaDrive pedal: listed once one is assigned.
    const targets = modifierTargets(preset.data, true)
      .filter((t) => t.key !== "novadrive" || (t.modifier.source && isValidModifier(t.modifier)));
    this.paramsList.classList.add("row-list");
    this.paramsList.replaceChildren(...targets.map((t) => this.modifierRow(t)));
  }

  private blockLabel(key: string): string {
    return key === "novadrive" ? "NovaDrive" : TILES.find(([k]) => k === key)?.[1] ?? key;
  }

  private modifierRow(t: ModifierTarget): HTMLElement {
    const m = t.modifier;
    const valid = isValidModifier(m);
    const active = valid && m.source > 0;
    const row = el("button", `param modifier${t.field === this.paramIndex ? " selected" : ""}${active ? " assigned" : ""}`);
    row.type = "button";
    const summary = !valid ? "invalid values" : active ? `${SOURCES[m.source]}, ${m.min} / ${m.mid} / ${m.max} %` : "none";
    row.setAttribute("aria-label", `${this.blockLabel(t.key)} ${t.name}: ${summary}, tap to adjust`);
    const top = el("span", "param-top");
    const name = el("span", "param-name");
    name.append(el("span", "param-block", this.blockLabel(t.key)), t.name);
    top.append(name, el("span", !valid ? "source-chip warn" : active ? "source-chip on" : "source-chip",
      valid ? SHORT_SOURCES[m.source] : "?"));
    const range = el("span", "mod-range");
    if (active) {
      const bar = el("span", "mod-bar");
      const lo = Math.min(m.min, m.max), hi = Math.max(m.min, m.max);
      bar.style.left = `${lo}%`;
      bar.style.width = `${Math.max(hi - lo, 1)}%`;
      const mid = el("span", "mod-mid");
      mid.style.left = `${m.mid}%`;
      range.append(bar, mid);
    }
    const values = el("span", "mod-values", active ? `${m.min} · ${m.mid} · ${m.max} %` : "");
    row.append(top, range, values);
    row.addEventListener("click", () => {
      this.paramIndex = t.field;
      this.paramsList.querySelectorAll(".param").forEach((r) => r.classList.toggle("selected", r === row));
      this.openModifierSheet(t);
    });
    return row;
  }

  private paramRow(index: number, p: Param, value: number, open: () => void, set: (v: number) => void,
    pedal?: number): HTMLElement {
    if (DESKTOP.matches) return directParam(index, p, value, open, set, pedal);
    const row = el("button", index === this.paramIndex ? "param selected" : "param");
    row.type = "button";
    row.setAttribute("aria-label", `${p.name}: ${p.format(value)}, tap to adjust`);
    // The layout lives on an inner element: older Android WebViews centre and shrink a button's
    // content whatever its own display, which squeezed the sliders to the width of their text.
    const body = el("span", "param-body");
    row.append(body);
    const out = value < p.lo || value > p.hi;
    if (this.paramsList.classList.contains("slider-list")) {
      // Slider row: name and value, then the position on the range (or the list's segments).
      const top = el("span", "param-top");
      const name = el("span", "param-name", p.name);
      if (pedal) name.append(el("span", "source-chip on small", SHORT_SOURCES[pedal]));
      top.append(name, el("span", out ? "param-value warn" : "param-value", p.format(value)));
      body.append(top);
      if (p.choices.length && p.hi - p.lo < 8) {
        const segs = el("span", "segments");
        for (let v = p.lo; v <= p.hi; v++) segs.append(el("span", v === value ? "on" : ""));
        body.append(segs);
      } else {
        body.append(track(p, value));
      }
    } else {
      // A tile like a knob on the unit's panel: name, potentiometer (or the chosen value of a list), readout.
      body.append(el("span", "param-name", p.name));
      if (pedal) row.append(el("span", "source-chip on small param-pedal", SHORT_SOURCES[pedal]));
      if (p.choices.length) {
        const box = el("span", "param-choice");
        box.append(el("span", "param-choice-text", p.format(value)));
        box.insertAdjacentHTML("beforeend", '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>');
        body.append(box);
      } else {
        body.insertAdjacentHTML("beforeend", knob(p, value));
        body.append(el("span", out ? "param-value warn" : "param-value", p.format(value)));
      }
    }
    row.addEventListener("click", () => {
      this.paramIndex = index;
      this.paramsList.querySelectorAll(".param").forEach((r) => r.classList.toggle("selected", r === row));
      open();
    });
    return row;
  }

  // Fine-adjust sheet

  private openSheet(index: number): void {
    this.body.querySelector(".sheet-layer")?.remove();
    const preset = this.buffer;
    if (!preset) return;
    const blk = owner(index);
    const param = blk?.fields(preset.data).find(([f]) => f === index)?.[1];
    if (!blk || !param) return;
    // A parameter driven by a pedal or encoder shows the travel it is given, from Min to Max.
    const mod = this.assignedModifiers(preset.data).find((t) => t.paramField === index)?.modifier;
    this.openValueSheet(`${TILE_LABELS[blk.key] ?? blk.label} · ${param.name}`, `field #${index}`, param,
      readField(preset.data, index), (v) => this.setField(index, v), mod);
  }

  private openValueSheet(title: string, tag: string, param: Param, start: number, set: (v: number) => void,
    mod?: Modifier): void {
    this.body.querySelector(".sheet-layer")?.remove();
    let value = start;
    const close = () => this.closeSheet();
    const sheet = el("div", "sheet");
    const head = el("div", "sheet-head");
    head.append(el("span", "", title), el("span", "field", tag));
    const big = el("div", "sheet-value", param.format(value));
    sheet.append(head, big);

    const commit = (v: number) => {
      v = Math.max(param.lo, Math.min(param.hi, v));
      if (v === value) return;
      value = v;
      big.textContent = param.format(v);
      set(v);
    };

    if (param.choices.length && param.hi - param.lo < 24) {
      const choices = el("div", "sheet-choices");
      for (let v = param.lo; v <= param.hi; v++) {
        const c = el("button", v === value ? "on" : "", param.format(v));
        c.type = "button";
        c.addEventListener("click", () => {
          commit(v);
          choices.querySelectorAll("button").forEach((b, i) => b.classList.toggle("on", param.lo + i === v));
        });
        choices.append(c);
      }
      sheet.append(choices);
    } else {
      const t = track(param, value);
      const fill = t.querySelector<HTMLElement>(".track-fill")!;
      const thumb = t.querySelector<HTMLElement>(".track-thumb")!;
      const show = (v: number) => {
        const g = trackGeometry(param, v);
        fill.style.left = `${g.left * 100}%`;
        fill.style.width = `${g.width * 100}%`;
        thumb.style.left = `${g.pos * 100}%`;
        big.textContent = param.format(v);
      };
      const at = (x: number) => {
        const r = t.getBoundingClientRect();
        return Math.round(param.lo + clamp01((x - r.left) / r.width) * (param.hi - param.lo));
      };
      let dragging: number | null = null;
      t.addEventListener("pointerdown", (e) => {
        t.setPointerCapture(e.pointerId);
        dragging = at(e.clientX);
        show(dragging);
      });
      t.addEventListener("pointermove", (e) => {
        if (dragging === null) return;
        dragging = at(e.clientX);
        show(dragging);
      });
      const end = () => {
        if (dragging === null) return;
        const v = dragging;
        dragging = null;
        commit(v);
        show(value);
      };
      t.addEventListener("pointerup", end);
      t.addEventListener("pointercancel", end);
      const range = el("div", "sheet-range");
      range.append(el("span", "", param.format(param.lo)), el("span", "", param.format(param.hi)));
      if (mod) {
        const lo = clamp01(Math.min(mod.min, mod.max) / 100), hi = clamp01(Math.max(mod.min, mod.max) / 100);
        const band = el("span", "track-mod");
        band.style.left = `${lo * 100}%`;
        band.style.width = `${Math.max(hi - lo, 0.01) * 100}%`;
        t.prepend(band);
        const note = el("div", "sheet-mod",
          `${SHORT_SOURCES[mod.source]}: ${param.format(valueAt(param, mod.min))} → ${param.format(valueAt(param, mod.max))}`);
        sheet.append(t, range, note);
      } else sheet.append(t, range);
      this.sheetShow = show;
    }

    const buttons = el("div", "sheet-buttons");
    const stepper = (label: string, delta: number) => holdButton(label, delta < 0 ? "Decrease" : "Increase", () => {
      commit(value + delta);
      this.sheetShow?.(value);
    });
    const ok = el("button", "ok", "OK");
    ok.type = "button";
    ok.addEventListener("click", close);
    buttons.append(stepper("−", -1), ok, stepper("+", 1));
    sheet.append(buttons);
    this.showSheet(sheet, param.name);
  }

  /** Source and Min / Mid / Max of a modifier slot. */
  private openModifierSheet(t: ModifierTarget): void {
    this.body.querySelector(".sheet-layer")?.remove();
    if (!this.buffer) return;
    const clampPct = (v: number) => Math.max(0, Math.min(100, v));
    let m: Modifier = isValidModifier(t.modifier) ? { ...t.modifier } : { ...UNASSIGNED };
    const sheet = el("div", "sheet modifier-sheet");
    const head = el("div", "sheet-head");
    head.append(el("span", "", `${this.blockLabel(t.key)} · ${t.name}`), el("span", "field", `modifier ${t.slot + 1}`));
    const sources = el("div", "sheet-choices sources");
    const rows = el("div", "mod-rows");
    sheet.append(head, sources, rows);

    // Rows are built once: rebuilding them would drop the − / + button being held.
    const rowParts = (["min", "mid", "max"] as const).map((k) => {
      const label = { min: "Min", mid: "Mid", max: "Max" }[k];
      const row = el("div", "mod-row");
      const pct = el("span", "mod-pct");
      const equiv = el("span", "mod-equiv");
      const step = (d: number) => commit({ ...m, [k]: clampPct(m[k] + d) });
      row.append(el("span", "mod-label", label), holdButton("−", `${label}: decrease`, () => step(-1)), pct,
        holdButton("+", `${label}: increase`, () => step(1)), equiv);
      rows.append(row);
      return { k, row, pct, equiv };
    });
    const commit = (next: Modifier) => {
      m = next;
      if (this.buffer) this.pushBuffer(this.buffer.withData(writeModifier(this.buffer.data, t.slot, m)));
      draw();
    };
    const draw = () => {
      sources.replaceChildren(...SOURCES.map((label, i) => {
        const b = el("button", i === m.source ? "on" : "", label);
        b.type = "button";
        b.setAttribute("aria-pressed", String(i === m.source));
        b.addEventListener("click", () => commit({ ...m, source: i }));
        return b;
      }));
      for (const { k, row, pct, equiv } of rowParts) {
        row.classList.toggle("disabled", !m.source);
        pct.textContent = `${m[k]} %`;
        equiv.textContent = t.param ? `≈ ${t.param.format(valueAt(t.param, m[k]))}` : "";
      }
    };
    draw();

    const buttons = el("div", "sheet-buttons");
    const reset = el("button", "", "Remove");
    reset.type = "button";
    reset.addEventListener("click", () => commit({ ...UNASSIGNED }));
    const ok = el("button", "ok", "OK");
    ok.type = "button";
    ok.addEventListener("click", () => this.closeSheet());
    buttons.append(reset, ok);
    sheet.append(buttons);
    this.showSheet(sheet, `Modifier ${t.name}`);
  }

  private showSheet(sheet: HTMLElement, label: string): void {
    const layer = el("div", "sheet-layer");
    const backdrop = el("button", "sheet-backdrop");
    backdrop.type = "button";
    backdrop.setAttribute("aria-label", "Close");
    backdrop.addEventListener("click", () => this.closeSheet());
    // The fine slider takes the colour of the block shown, as its knob does.
    const hue = this.params.style.getPropertyValue("--h");
    if (hue) sheet.style.setProperty("--h", hue);
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-label", label);
    layer.append(backdrop, sheet);
    this.body.append(layer);
  }

  private sheetShow: ((v: number) => void) | null = null;

  private closeSheet(): void {
    this.paramIndex = null;
    this.sheetShow = null;
    this.body.querySelector(".sheet-layer")?.remove();
    this.paramsList.querySelector(".param.selected")?.classList.remove("selected");
  }
}

/**
 * Desktop parameter: the knob turns by dragging up or down (Shift for fine steps) or with the arrow keys,
 * Page Up / Down, Home and End; a double click opens the fine-adjust sheet. A list is a drop-down.
 * The value is set once the knob is released.
 */
function directParam(index: number, p: Param, value: number, open: () => void, set: (v: number) => void,
  pedal?: number): HTMLElement {
  const row = el("div", "param direct");
  row.dataset.row = String(index);
  const body = el("span", "param-body");
  row.append(body);
  body.append(el("span", "param-name", p.name));
  if (pedal) row.append(el("span", "source-chip on small param-pedal", SHORT_SOURCES[pedal]));
  if (p.choices.length) {
    const select = el("select", "param-select");
    select.setAttribute("aria-label", p.name);
    for (let v = p.lo; v <= p.hi; v++) select.append(new Option(p.format(v), String(v)));
    if (value < p.lo || value > p.hi) select.append(new Option(String(value), String(value)));
    select.value = String(value);
    select.addEventListener("change", () => set(Number(select.value)));
    body.append(select);
    return row;
  }
  const dial = el("span", "knob-control");
  dial.tabIndex = 0;
  dial.setAttribute("role", "slider");
  dial.setAttribute("aria-label", p.name);
  dial.setAttribute("aria-valuemin", String(p.lo));
  dial.setAttribute("aria-valuemax", String(p.hi));
  const readout = el("span", "param-value");
  const span = p.hi - p.lo;
  const clampV = (v: number) => Math.max(p.lo, Math.min(p.hi, Math.round(v)));
  let shown = value;
  const show = (v: number) => {
    shown = v;
    dial.innerHTML = knob(p, v);
    readout.textContent = p.format(v);
    readout.classList.toggle("warn", v < p.lo || v > p.hi);
    dial.setAttribute("aria-valuenow", String(v));
    dial.setAttribute("aria-valuetext", p.format(v));
  };
  show(value);
  // The whole range over 200 px of travel, ten times finer with Shift.
  let drag: { y: number; at: number } | null = null;
  dial.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dial.focus();
    dial.setPointerCapture(e.pointerId);
    drag = { y: e.clientY, at: shown };
  });
  dial.addEventListener("pointermove", (e) => {
    if (!drag) return;
    drag.at += ((drag.y - e.clientY) / (e.shiftKey ? 2000 : 200)) * span;
    drag.y = e.clientY;
    drag.at = Math.max(p.lo, Math.min(p.hi, drag.at));
    if (clampV(drag.at) !== shown) show(clampV(drag.at));
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    if (shown !== value) set(shown);
  };
  dial.addEventListener("pointerup", end);
  dial.addEventListener("pointercancel", end);
  dial.addEventListener("lostpointercapture", end);
  dial.addEventListener("dblclick", open);
  dial.addEventListener("keydown", (e) => {
    const page = Math.max(1, Math.round(span / 10));
    const next = { ArrowUp: shown + 1, ArrowRight: shown + 1, ArrowDown: shown - 1, ArrowLeft: shown - 1,
      PageUp: shown + page, PageDown: shown - page, Home: p.lo, End: p.hi }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const v = clampV(next);
    if (v !== value) set(v);
  });
  body.append(dial, readout);
  return row;
}

/** A button that repeats its action while held. */
function holdButton(label: string, ariaLabel: string, action: () => void): HTMLElement {
  const b = el("button", "", label);
  b.type = "button";
  b.setAttribute("aria-label", ariaLabel);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  b.addEventListener("pointerdown", () => {
    action();
    const repeat = (delay: number) => {
      timer = setTimeout(() => {
        action();
        repeat(Math.max(40, delay * 0.8));
      }, delay);
    };
    repeat(400);
  });
  b.addEventListener("pointerup", stop);
  b.addEventListener("pointerleave", stop);
  b.addEventListener("pointercancel", stop);
  return b;
}
