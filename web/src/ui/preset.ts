/** Preset view: effect tiles, block parameters and the fine-adjust sheet, over an edit buffer. */

import { BANK_COUNT, PRESETS_PER_BANK, bankPosition, slotLabel, type BankStore } from "../core/bank";
import {
  MODIFIER_BLOCK_ID, MODIFIER_FIELD, MODIFIER_PARAM_BASE, MODIFIER_SLOTS, SOURCES, UNASSIGNED, isValidModifier,
  modifierTargets, valueAt, writeModifier, type Modifier, type ModifierTarget,
} from "../core/modifiers";
import {
  LEVEL_BITS, LEVELS_FIELD, OUTPUTS_FIELD, OUTPUT_MIN, OUTPUT_PARAMS, ROUTINGS, ROUTING_PARAM, levelOn, presetLevels,
  presetOutputs, writeLevel, writeOutputs, writeRouting,
} from "../core/levels";
import { ALL_FIELDS, describeField, formatField, rawHex } from "../core/fields";
import { FAVORITE_COUNT, applyFavorite, captureFavorite, type Favorite, type Favorites } from "../core/favorites";
import { BLOCKS, Param, block, diffFields, owner, readField, writeField, type Block } from "../core/params";
import { BLOCK_IDS, LEVELS_BLOCK_ID, LEVEL_SWITCHES } from "../core/protocol";
import { TAP_MAX_MS, TAP_MIN_MS, bpmToMs, msToBpm, presetTempoMs, writeTempoMs } from "../core/tempo";
import { NAME_LEN, Preset, SysexError, USER_SLOTS } from "../core/sysex";
import { askText } from "./dialog";
import { DESKTOP, el } from "./dom";
import { ICONS, iconButton, onLongPress, routingIcon, showMenu } from "./widgets";

/** Tile order of the design: the unit's effect sections. */
const TILES: [string, string][] = [
  ["filter", "FILTER"], ["comp", "COMP"], ["mod", "MOD"], ["pitch", "PITCH"],
  ["delay", "DELAY"], ["reverb", "REVERB"], ["eq", "EQ"], ["gate", "GATE"],
];
const TILE_LABELS: Record<string, string> = { mod: "Modulation", eq: "Parametric EQ" };
/** Pseudo block of the tile list: pedal and encoder assignments. */
const MODIFIERS = "modifiers";
const SHORT_SOURCES = ["—", "VOL", "EXP", "ENC A", "ENC B", "ENC C"];
/** Pseudo block of the tile list: the preset's routing and output levels. */
const ROUTING = "routing";
const OUTPUTS = [0, 1].map((side) =>
  new Param(side ? "Output R" : "Output L", OUTPUT_MIN, 0, [], (v) => `${v} dB`));
/** Preset tempo in BPM, over the tap times' range. */
const TEMPO = new Param("Tempo", msToBpm(TAP_MAX_MS), msToBpm(TAP_MIN_MS), [], (v) => `${v} BPM`);
/** Selection keys of the output and tempo rows (field indexes are below 165). */
const OUTPUT_ROW = 1000;
/** Desktop views of the parameters panel. */
type DeskTab = "block" | "all" | "raw" | "compare";
const DESK_TABS: [DeskTab, string][] = [["block", "Bloc"], ["all", "Tous les blocs"], ["raw", "Brut"], ["compare", "Comparer"]];
/** Compare target: the stored version of the preset, else a bank slot. */
const STORED = -1;
const TEMPO_ROW = 1002;
const isModifierField = (index: number) => index >= MODIFIER_FIELD && index < MODIFIER_FIELD + MODIFIER_SLOTS;
const LEVEL_LABELS: [string, string][] = [
  ["loop1", "L1"], ["loop2", "L2"], ["loop3", "L3"], ["loop4", "L4"], ["insert", "INS"], ["boost", "BST"],
];

const FAVORITES_KEY = "gsystem-favorites";

function loadFavorites(): Favorites {
  try {
    return JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "{}") as Favorites;
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

  private readonly number = el("div", "dot-number");
  private readonly nameButton = el("button", "preset-name");
  private readonly tempoButton = el("button", "preset-tempo");
  private readonly liveButton = el("button", "pill live");
  private readonly storeButton = el("button", "pill store", "Store");
  /** Back to the preset as stored, in one go (Ctrl+Z still undoes step by step). */
  private readonly undoButton = iconButton(ICONS.undo, "Revenir au preset avant modification", () => this.revert());
  private readonly tiles = el("div", "blocks");
  private readonly levelBar = el("div", "levels");
  private readonly favoriteBar = el("div", "favorites");
  private favorites: Favorites = loadFavorites();
  private tab: DeskTab = "block";
  private compareSlot = STORED;
  private readonly paramsHead = el("div", "params-head");
  private readonly paramsList = el("div", "params");
  private readonly body = el("div", "preset-body");
  /** Desktop: a bank browser on the left and the fine-adjust panel docked on the right. */
  private readonly browser = el("aside", "preset-browser");
  private readonly browserList = el("div", "browser-list");
  private readonly search = el("input", "browser-search");
  private readonly inspector = el("aside", "preset-inspector");

  constructor(private bank: BankStore) {
    this.nameButton.type = "button";
    this.nameButton.title = "Renommer le preset";
    this.nameButton.addEventListener("click", () => void this.rename());
    this.tempoButton.type = "button";
    this.tempoButton.title = "Tempo du preset";
    this.tempoButton.addEventListener("click", () => this.openTempoSheet());
    this.liveButton.type = "button";
    this.liveButton.innerHTML = '<span class="live-dot"></span>Live';
    this.liveButton.title = "Envoyer chaque modification au G-System (mémoire de travail, sans Store) "
      + "et suivre le pédalier";
    this.liveButton.disabled = true;
    this.liveButton.addEventListener("click", () => this.setLive(!this.live));
    this.storeButton.type = "button";
    this.storeButton.title = "Enregistrer le preset dans la banque de l'éditeur "
      + "et dans le G-System s'il est connecté (sinon à la prochaine synchronisation)";
    this.storeButton.addEventListener("click", () => this.store());

    const header = el("header", "header preset-header");
    header.append(
      iconButton(ICONS.prev, "Preset précédent", () => this.openSlot((this.slot + USER_SLOTS - 1) % USER_SLOTS)),
      this.number, this.nameButton,
      iconButton(ICONS.next, "Preset suivant", () => this.openSlot((this.slot + 1) % USER_SLOTS)),
      el("div", "separator"), this.undoButton, this.liveButton, this.storeButton,
    );

    const column = el("section", "blocks-column");
    column.setAttribute("aria-label", "Blocs d'effets");
    this.levelBar.setAttribute("aria-label", "Loops, insert et boost du preset");
    column.append(this.tiles);
    const params = el("section", "params-section");
    params.setAttribute("aria-label", "Paramètres");
    // Strip over the block details: the preset's loops, insert and boost, and its tempo.
    const strip = el("div", "preset-strip");
    strip.append(this.levelBar, this.tempoButton);
    this.favoriteBar.setAttribute("aria-label", "Favoris de l'effet");
    params.append(strip, this.favoriteBar, this.paramsHead, this.paramsList);
    const main = el("div", "preset-main");
    main.append(column, params);
    this.search.type = "search";
    this.search.placeholder = "Nom du preset…";
    this.search.setAttribute("aria-label", "Rechercher un preset");
    this.search.addEventListener("input", () => this.renderBrowser());
    this.browser.setAttribute("aria-label", "Banques");
    this.browser.append(this.search, this.browserList);
    this.inspector.setAttribute("aria-label", "Réglage du paramètre");
    this.body.append(this.browser, main, this.inspector);
    this.el.append(header, this.body);
    DESKTOP.addEventListener("change", () => {
      this.closeSheet();
      this.renderBrowser();
    });
    this.openSlot(0);
  }

  // Live link

  setConnected(connected: boolean): void {
    this.liveButton.disabled = !connected;
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
    this.onNotice?.(`« ${this.buffer.name} » chargé dans la mémoire de travail du G-System`);
  }

  private sendChanges(before: Uint8Array, after: Uint8Array): void {
    if (this.fromUnit || !this.isLive) return;
    for (const [index, , value] of diffFields(before, after)) {
      const blk = owner(index);
      if (blk && index !== blk.countField) this.sendParam!(BLOCK_IDS[blk.key], index - blk.firstField, value);
      else if (isModifierField(index)) this.sendParam!(MODIFIER_BLOCK_ID, MODIFIER_PARAM_BASE + index - MODIFIER_FIELD, value);
      else if (index === LEVELS_FIELD || index === OUTPUTS_FIELD) this.sendRouting(after, index);
      if (index === LEVELS_FIELD) {
        for (const key of Object.keys(LEVEL_BITS)) {
          const on = levelOn(after, key);
          if (on !== levelOn(before, key)) this.sendParam!(LEVELS_BLOCK_ID, LEVEL_SWITCHES[key], Number(on));
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
      && (param === ROUTING_PARAM || OUTPUT_PARAMS.includes(param))) {
      this.fromUnit = true;
      try {
        if (param === ROUTING_PARAM) this.setRouting(value);
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
      if (confirm(`« ${this.buffer!.name} » a été modifié sans être stocké.\nOK : le stocker. Annuler : abandonner les modifications.`)) {
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
    if (changed && !this.fromUnit) this.pushToUnit();
  }

  /** Desktop browser: every bank with its presets' names, filtered by the search box. */
  renderBrowser(): void {
    if (!DESKTOP.matches) return;
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
    this.browserList.replaceChildren(...(groups.length ? groups : [el("p", "empty-note", "Aucun preset trouvé.")]));
    this.browserList.querySelector(".current")?.scrollIntoView({ block: "nearest" });
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
    this.pushBuffer(this.buffer.withData(data));
  }

  private setRouting(routing: number): void {
    if (this.buffer && presetLevels(this.buffer.data).routing !== routing) {
      this.pushBuffer(this.buffer.withData(writeRouting(this.buffer.data, routing)));
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
    const name = (await askText(`Nom du preset (${NAME_LEN} caractères max.)`, this.buffer.name, NAME_LEN))?.trim();
    if (!name || !this.buffer || name === this.buffer.name) return;
    try {
      this.pushBuffer(this.buffer.withName(name.slice(0, NAME_LEN)));
    } catch (e) {
      if (e instanceof SysexError) alert("Utilisez uniquement des caractères ASCII imprimables.");
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
    const field = this.buffer ? blk.enableField(this.buffer.data) : null;
    return field !== null && readField(this.buffer!.data, field) === 1;
  }

  // Rendering

  private render(): void {
    const [b, position] = bankPosition(this.slot);
    this.number.setAttribute("aria-label", `Banque ${String(b).padStart(2, "0")}, position ${position}`);
    this.number.innerHTML = `<span class="bank">${String(b).padStart(2, "0")}</span><span class="position">${position}</span>`;
    const status = this.isDirty ? "Modifié — Store pour garder"
      : this.isLive ? "LIVE · edit buffer" : `${this.bank.title} · ${slotLabel(this.slot)}`;
    this.nameButton.innerHTML = "";
    this.nameButton.append(el("span", "name", this.buffer ? this.buffer.name || "(sans nom)" : "— vide —"),
      el("span", this.isDirty || this.isLive ? "status alert" : "status", status));
    const ms = this.buffer ? presetTempoMs(this.buffer.data) : null;
    this.tempoButton.hidden = ms === null;
    if (ms !== null) {
      this.tempoButton.replaceChildren(el("span", "bpm", String(msToBpm(ms))), el("span", "unit", "BPM"));
      this.tempoButton.setAttribute("aria-label", `Tempo ${msToBpm(ms)} BPM, toucher pour régler`);
    }
    this.liveButton.classList.toggle("active", this.isLive);
    this.liveButton.setAttribute("aria-pressed", String(this.isLive));
    this.storeButton.classList.toggle("dirty", this.isDirty);
    this.storeButton.disabled = !this.isDirty;
    this.undoButton.disabled = !this.isDirty;
    this.renderTiles();
    this.renderLevels();
    this.renderParams();
    this.renderFavorites();
  }

  private renderTiles(): void {
    this.tiles.replaceChildren(...TILES.map(([key, code]) => {
      const blk = block(key);
      const on = this.isOn(blk);
      // A footswitch (on/off, as on the unit) beside the label that shows the block's parameters.
      const tile = el("div", `tile${key === this.blockKey ? " selected" : ""}${on ? " on" : ""}`);
      const label = TILE_LABELS[key] ?? blk.label;
      const footswitch = el("button", on ? "footswitch on" : "footswitch");
      footswitch.type = "button";
      footswitch.disabled = !this.buffer || blk.enableField(this.buffer.data) === null;
      footswitch.setAttribute("aria-pressed", String(on));
      footswitch.setAttribute("aria-label", `${label} : ${on ? "désactiver" : "activer"}`);
      footswitch.addEventListener("click", () => this.toggleBlock(key));
      const pick = el("button", "tile-label");
      pick.type = "button";
      pick.setAttribute("aria-label", `Afficher ${label}, ${on ? "activé" : "désactivé"}`);
      const kind = this.buffer ? blk.effectType(this.buffer.data)?.name : "";
      const typeShort = blk.hasType ? kind ?? "" : key === "eq" ? "3-band" : "Gate";
      pick.append(el("span", "tile-code", code), el("span", "tile-type", typeShort));
      pick.addEventListener("click", () => {
        this.blockKey = key;
        this.tab = "block";
        this.closeSheet();
        this.render();
      });
      tile.append(footswitch, pick);
      return tile;
    }), this.modifiersTile(), this.routingTile());
  }

  private modifiersTile(): HTMLElement {
    const assigned = this.buffer ? this.assignedModifiers(this.buffer.data) : [];
    const sources = [...new Set(assigned.map((t) => SHORT_SOURCES[t.modifier.source]))];
    const tile = el("button", `tile stack${this.blockKey === MODIFIERS ? " selected" : ""}${assigned.length ? " on" : ""}`);
    tile.type = "button";
    tile.setAttribute("aria-label", `Pédales et encodeurs, ${assigned.length} affectation(s)`);
    tile.title = assigned.map((t) => t.name).join(", ");
    tile.append(el("span", "tile-code", "MODIFIERS"),
      el("span", assigned.length ? "tile-count" : "tile-count none", sources.join(" · ") || "none"));
    tile.addEventListener("click", () => {
      this.blockKey = MODIFIERS;
      this.tab = "block";
      this.closeSheet();
      this.render();
    });
    return tile;
  }

  private routingTile(): HTMLElement {
    const tile = el("button", `tile stack${this.blockKey === ROUTING ? " selected" : ""}`);
    tile.type = "button";
    const type = el("span", "tile-type tile-routing");
    if (this.buffer) {
      const routing = presetLevels(this.buffer.data).routing;
      const [left, right] = presetOutputs(this.buffer.data);
      type.append(ROUTINGS[routing] ?? String(routing));
      tile.title = `L ${left} dB · R ${right} dB`;
      tile.setAttribute("aria-label", `Routing ${ROUTINGS[routing] ?? routing}, sorties ${left} et ${right} dB`);
    }
    tile.append(el("span", "tile-code", "ROUTING"), type);
    tile.addEventListener("click", () => {
      this.blockKey = ROUTING;
      this.tab = "block";
      this.closeSheet();
      this.render();
    });
    return tile;
  }

  private assignedModifiers(data: Uint8Array): ModifierTarget[] {
    return modifierTargets(data, true).filter((t) => t.modifier.source && isValidModifier(t.modifier));
  }

  private renderLevels(): void {
    this.levelBar.replaceChildren(...LEVEL_LABELS.map(([key, label]) => {
      const on = this.buffer ? levelOn(this.buffer.data, key) : false;
      const b = el("button", on ? "level on" : "level", label);
      b.type = "button";
      b.disabled = !this.buffer;
      b.title = label === "INS" ? "Insert (loop 5)" : label === "BST"
        ? `Boost ${this.buffer ? presetLevels(this.buffer.data).boostLevel : 0} dB` : `Loop ${label.slice(1)}`;
      b.setAttribute("aria-pressed", String(on));
      b.addEventListener("click", () => this.setLevel(key, !on));
      return b;
    }));
  }

  /** The four favorites of the shown effect: tap to load (or to save into an empty one), long-press for more. */
  private renderFavorites(): void {
    const key = this.blockKey;
    const isEffect = key !== MODIFIERS && key !== ROUTING && (this.tab === "block" || !DESKTOP.matches);
    this.favoriteBar.hidden = !isEffect || !this.buffer;
    if (this.favoriteBar.hidden) return;
    const slots = this.favorites[key] ?? [];
    this.favoriteBar.replaceChildren(el("span", "favorites-title", "FAV"), ...Array.from({ length: FAVORITE_COUNT }, (_, i) => {
      const fav = slots[i] ?? null;
      const b = el("button", fav ? "favorite" : "favorite empty");
      b.type = "button";
      b.append(el("span", "favorite-num", String(i + 1)), el("span", "favorite-label", fav ? fav.label : "+"));
      b.title = fav ? `Charger le favori ${i + 1} (${fav.label}) — appui long : plus d'options`
        : `Enregistrer les réglages actuels dans le favori ${i + 1}`;
      onLongPress(b, (x, y) => showMenu({ x, y }, [
        { label: "Charger", action: () => this.loadFavorite(key, i), disabled: !fav },
        { label: fav ? "Remplacer par les réglages actuels" : "Enregistrer les réglages actuels",
          action: () => this.saveFavorite(key, i) },
        { label: "Effacer", action: () => this.saveFavorite(key, i, true), disabled: !fav },
      ]));
      b.addEventListener("click", () => (fav ? this.loadFavorite(key, i) : this.saveFavorite(key, i)));
      return b;
    }));
  }

  private saveFavorite(key: string, index: number, clear = false): void {
    if (!this.buffer) return;
    const slots: (Favorite | null)[] = [...(this.favorites[key] ?? [])];
    while (slots.length < FAVORITE_COUNT) slots.push(null);
    slots[index] = clear ? null : captureFavorite(this.buffer.data, key);
    this.favorites = { ...this.favorites, [key]: slots };
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(this.favorites));
    } catch {
      alert("Impossible d'enregistrer les favoris sur cet appareil.");
    }
    this.renderFavorites();
    this.onNotice?.(clear ? `Favori ${index + 1} effacé` : `Favori ${index + 1} enregistré : ${slots[index]!.label}`);
  }

  private loadFavorite(key: string, index: number): void {
    const fav = this.favorites[key]?.[index];
    if (!this.buffer || !fav) return;
    try {
      const data = applyFavorite(this.buffer.data, key, fav);
      if (diffFields(this.buffer.data, data).length) this.pushBuffer(this.buffer.withData(data));
      this.onNotice?.(`Favori ${index + 1} chargé : ${fav.label}`);
    } catch (e) {
      alert(`Favori illisible : ${(e as Error).message}`);
    }
  }

  private renderParams(): void {
    const desk = DESKTOP.matches;
    this.paramsList.classList.remove("wide-list");
    if (desk && this.tab === "all") this.renderAllBlocks();
    else if (desk && this.tab === "raw") this.renderRaw();
    else if (desk && this.tab === "compare") this.renderCompare();
    else this.renderBlockParams();
    if (desk) this.paramsHead.append(this.deskTabs());
  }

  private deskTabs(): HTMLElement {
    const tabs = el("div", "desk-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Vue des paramètres");
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
    this.paramsHead.replaceChildren(el("span", "label", "Tous les blocs"), el("div", "grow"));
    this.paramsList.classList.remove("on-block");
    const preset = this.buffer;
    if (!preset) {
      this.paramsList.replaceChildren(el("p", "empty-note", "Emplacement vide."));
      return;
    }
    const rows: HTMLElement[] = [];
    for (const [key, code] of TILES) {
      const blk = block(key);
      const on = this.isOn(blk);
      const head = el("button", on ? "all-head on" : "all-head");
      head.type = "button";
      head.title = `Afficher ${blk.label} seul`;
      head.append(el("span", "all-code", code),
        el("span", "all-type", blk.effectType(preset.data)?.name ?? (key === "eq" ? "3-band" : "Gate")),
        el("span", on ? "all-state on" : "all-state", on ? "On" : "Off"));
      head.addEventListener("click", () => {
        this.blockKey = key;
        this.tab = "block";
        this.render();
      });
      rows.push(head);
      for (const [index, p] of blk.fields(preset.data)) {
        if ((blk.hasType && index === blk.firstField) || p.name === blk.enableName) continue;
        rows.push(this.paramRow(index, p, readField(preset.data, index), () => this.openSheet(index)));
      }
    }
    this.paramsList.replaceChildren(...rows);
  }

  /** All 165 fields: what each holds, raw and as shown; those changed since the last Store are marked. */
  private renderRaw(): void {
    const preset = this.buffer;
    const changed = new Set(preset && this.stored ? diffFields(this.stored.data, preset.data).map(([i]) => i) : []);
    this.paramsHead.replaceChildren(el("span", "label", "Brut"), el("div", "grow"),
      el("span", "params-hint", preset ? `${ALL_FIELDS.length} champs · ${changed.size} modifié(s)` : ""));
    this.paramsList.classList.remove("on-block");
    this.paramsList.classList.add("wide-list");
    if (!preset) {
      this.paramsList.replaceChildren(el("p", "empty-note", "Emplacement vide."));
      return;
    }
    const table = el("table", "field-table");
    const head = el("tr");
    for (const h of ["#", "Groupe", "Paramètre", "Brut", "Valeur"]) head.append(el("th", "", h));
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
    select.setAttribute("aria-label", "Comparer avec");
    select.append(new Option("Version enregistrée", String(STORED)));
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
    this.paramsHead.replaceChildren(el("span", "label", "Comparer avec"), select, el("div", "grow"),
      el("span", "params-hint", preset && other ? `${diffs.length} différence(s)` : ""));
    this.paramsList.classList.remove("on-block");
    this.paramsList.classList.add("wide-list");
    if (!preset || !other) {
      this.paramsList.replaceChildren(el("p", "empty-note", "Rien à comparer."));
      return;
    }
    if (!diffs.length && preset.name === other.name) {
      this.paramsList.replaceChildren(el("p", "empty-note", "Aucune différence."));
      return;
    }
    const table = el("table", "field-table compare");
    const head = el("tr");
    for (const h of ["#", "Groupe", "Paramètre", "Ce preset", other === this.stored ? "Enregistré" : other.name, ""]) {
      head.append(el("th", "", h));
    }
    table.append(head);
    if (preset.name !== other.name) {
      const row = el("tr");
      const take = el("button", "take", "← Reprendre");
      take.type = "button";
      take.addEventListener("click", () => this.pushBuffer(this.buffer!.withName(other.name)));
      const cell = el("td");
      cell.append(take);
      row.append(el("td", "num", "—"), el("td", "", "Preset"), el("td", "", "Nom"), el("td", "", preset.name),
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
      const take = el("button", "take", whole ? "← Reprendre le bloc" : "← Reprendre");
      take.type = "button";
      take.title = whole ? `Le type diffère : reprendre tout le bloc ${blk!.label}` : "Reprendre cette valeur dans ce preset";
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
    const blk = block(this.blockKey);
    const preset = this.buffer;
    const on = this.isOn(blk);
    this.paramsHead.replaceChildren(el("span", "label", TILE_LABELS[blk.key] ?? blk.label));
    if (!preset) {
      this.paramsList.replaceChildren(el("p", "empty-note", "Emplacement vide."));
      return;
    }
    if (blk.hasType) {
      const select = el("select", "type-select");
      select.setAttribute("aria-label", "Type d'effet");
      blk.types.forEach((t, i) => select.append(new Option(t.name, String(i))));
      select.value = String(readField(preset.data, blk.firstField));
      select.addEventListener("change", () => this.setField(blk.firstField, Number(select.value)));
      this.paramsHead.append(select);
    }
    this.paramsHead.append(el("div", "grow"));
    const field = blk.enableField(preset.data);
    if (field !== null) {
      const sw = el("button", on ? "switch on" : "switch");
      sw.type = "button";
      sw.setAttribute("aria-pressed", String(on));
      sw.setAttribute("aria-label", `${blk.label} : ${on ? "désactiver" : "activer"}`);
      const trackEl = el("span", "switch-track");
      trackEl.append(el("span", "switch-knob"));
      sw.append(trackEl, el("span", "switch-text", on ? "On" : "Off"));
      sw.addEventListener("click", () => this.toggleBlock(blk.key));
      this.paramsHead.append(sw);
    }
    this.paramsList.classList.toggle("on-block", on);
    // Type and on/off are in the block header.
    const rows = blk.fields(preset.data)
      .filter(([index, p]) => !(blk.hasType && index === blk.firstField) && p.name !== blk.enableName);
    const pedals = new Map(this.assignedModifiers(preset.data).map((t) => [t.paramField, t.modifier.source]));
    this.paramsList.replaceChildren(...rows.map(([index, p]) =>
      this.paramRow(index, p, readField(preset.data, index), () => this.openSheet(index), pedals.get(index))));
  }

  private openTempoSheet(): void {
    const ms = this.buffer ? presetTempoMs(this.buffer.data) : null;
    if (ms === null) return;
    this.openValueSheet(`Tempo · ${ms} ms`, "tap Filter, Mod, Delay", TEMPO, msToBpm(ms), (next) => this.setTempo(next));
  }

  /** Routing type and output levels: global menus on the unit, but stored in each preset. */
  private renderRouting(): void {
    this.paramsHead.replaceChildren(el("span", "label", "Routing"));
    this.paramsList.classList.remove("on-block");
    const preset = this.buffer;
    if (!preset) {
      this.paramsList.replaceChildren(el("p", "empty-note", "Emplacement vide."));
      return;
    }
    this.paramsHead.append(el("div", "grow"));
    // One button per routing, a single one lit: one tap instead of opening a list.
    const current = presetLevels(preset.data).routing;
    const choice = el("div", "routing-choice");
    choice.setAttribute("role", "radiogroup");
    choice.setAttribute("aria-label", "Type de routing");
    ROUTINGS.forEach((name, i) => {
      const b = el("button", i === current ? "on" : "");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(i === current));
      b.insertAdjacentHTML("afterbegin", routingIcon(i));
      b.append(el("span", "", name === "Semi Parallel" ? "Semi Par." : name));
      b.addEventListener("click", () => this.setRouting(i));
      choice.append(b);
    });
    const rows: HTMLElement[] = [choice, ...presetOutputs(preset.data).map((v, side) =>
      this.paramRow(OUTPUT_ROW + side, OUTPUTS[side], v, () =>
        this.openValueSheet(`Routing · ${OUTPUTS[side].name}`, `field #${OUTPUTS_FIELD}`, OUTPUTS[side], v,
          (next) => this.setOutput(side, next))))];
    const ms = presetTempoMs(preset.data);
    if (ms !== null) rows.push(this.paramRow(TEMPO_ROW, TEMPO, msToBpm(ms), () => this.openTempoSheet()));
    this.paramsList.replaceChildren(...rows);
  }

  private renderModifiers(): void {
    this.paramsHead.replaceChildren(el("span", "label", "Modifiers"), el("div", "grow"));
    this.paramsList.classList.remove("on-block");
    const preset = this.buffer;
    if (!preset) {
      this.paramsList.replaceChildren(el("p", "empty-note", "Emplacement vide."));
      return;
    }
    this.paramsHead.append(el("span", "params-hint", "Paramètres pilotables avec les types d'effets actuels"));
    // NovaDrive slots only matter with a NovaDrive pedal: listed once one is assigned.
    const targets = modifierTargets(preset.data, true)
      .filter((t) => t.key !== "novadrive" || (t.modifier.source && isValidModifier(t.modifier)));
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
    row.setAttribute("aria-label", `${this.blockLabel(t.key)} ${t.name} : ${summary}, toucher pour régler`);
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

  private paramRow(index: number, p: Param, value: number, open: () => void, pedal?: number): HTMLElement {
    const row = el("button", index === this.paramIndex ? "param selected" : "param");
    row.type = "button";
    row.setAttribute("aria-label", `${p.name} : ${p.format(value)}, toucher pour régler`);
    const top = el("span", "param-top");
    const out = value < p.lo || value > p.hi;
    const name = el("span", "param-name", p.name);
    if (pedal) name.append(el("span", "source-chip on small", SHORT_SOURCES[pedal]));
    top.append(name, el("span", out ? "param-value warn" : "param-value", p.format(value)));
    row.append(top);
    const count = p.hi - p.lo + 1;
    if (p.choices.length && count <= 8) {
      const segs = el("span", "segments");
      for (let v = p.lo; v <= p.hi; v++) segs.append(el("span", v === value ? "on" : ""));
      row.append(segs);
    } else {
      row.append(track(p, value));
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
    this.openValueSheet(`${TILE_LABELS[blk.key] ?? blk.label} · ${param.name}`, `field #${index}`, param,
      readField(preset.data, index), (v) => this.setField(index, v));
  }

  private openValueSheet(title: string, tag: string, param: Param, start: number, set: (v: number) => void): void {
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
      sheet.append(t, range);
      this.sheetShow = show;
    }

    const buttons = el("div", "sheet-buttons");
    const stepper = (label: string, delta: number) => holdButton(label, delta < 0 ? "Diminuer" : "Augmenter", () => {
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
      row.append(el("span", "mod-label", label), holdButton("−", `${label} : diminuer`, () => step(-1)), pct,
        holdButton("+", `${label} : augmenter`, () => step(1)), equiv);
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
    if (DESKTOP.matches) {
      // Docked in the inspector column: no backdrop, the parameters stay usable beside it.
      sheet.setAttribute("aria-label", label);
      sheet.classList.add("docked");
      this.inspector.replaceChildren(sheet);
      return;
    }
    const layer = el("div", "sheet-layer");
    const backdrop = el("button", "sheet-backdrop");
    backdrop.type = "button";
    backdrop.setAttribute("aria-label", "Fermer");
    backdrop.addEventListener("click", () => this.closeSheet());
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
    this.inspector.replaceChildren(el("p", "inspector-hint", "Choisissez un paramètre pour le régler ici."));
    this.paramsList.querySelector(".param.selected")?.classList.remove("selected");
  }
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
