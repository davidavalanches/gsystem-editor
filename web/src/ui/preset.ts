/** Preset view: effect tiles, block parameters and the fine-adjust sheet, over an edit buffer. */

import { bankPosition, slotLabel, type BankStore } from "../core/bank";
import {
  MODIFIER_BLOCK_ID, MODIFIER_FIELD, MODIFIER_PARAM_BASE, MODIFIER_SLOTS, SOURCES, UNASSIGNED, isValidModifier,
  modifierTargets, valueAt, writeModifier, type Modifier, type ModifierTarget,
} from "../core/modifiers";
import { BLOCKS, block, diffFields, owner, readField, writeField, type Block, type Param } from "../core/params";
import { BLOCK_IDS, LEVELS_BLOCK_ID, LEVEL_SWITCHES } from "../core/protocol";
import { NAME_LEN, Preset, SysexError, USER_SLOTS } from "../core/sysex";
import { askText } from "./dialog";
import { el } from "./dom";
import { ICONS, iconButton } from "./widgets";

/** Tile order of the design: the unit's effect sections. */
const TILES: [string, string][] = [
  ["filter", "FILTER"], ["comp", "COMP"], ["mod", "MOD"], ["pitch", "PITCH"],
  ["delay", "DELAY"], ["reverb", "REVERB"], ["eq", "EQ"], ["gate", "GATE"],
];
const TILE_LABELS: Record<string, string> = { mod: "Modulation", eq: "EQ paramétrique" };
/** Pseudo block of the tile list: pedal and encoder assignments. */
const MODIFIERS = "modifiers";
const SHORT_SOURCES = ["—", "VOL", "EXP", "ENC A", "ENC B", "ENC C"];
const isModifierField = (index: number) => index >= MODIFIER_FIELD && index < MODIFIER_FIELD + MODIFIER_SLOTS;
const LEVEL_LABELS: [string, string][] = [
  ["loop1", "L1"], ["loop2", "L2"], ["loop3", "L3"], ["loop4", "L4"], ["insert", "INS"], ["boost", "BST"],
];

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
  /** Loops, insert and boost: their place in the preset is not decoded, so their state is unknown until seen. */
  private levels: Record<string, boolean | null> = {};
  sendParam: ((blockId: number, param: number, value: number) => void) | null = null;
  onStore: ((slot: number, preset: Preset) => void) | null = null;
  onNotice: ((text: string) => void) | null = null;
  onSlotChange: ((slot: number) => void) | null = null;

  private readonly number = el("div", "dot-number");
  private readonly nameButton = el("button", "preset-name");
  private readonly liveButton = el("button", "pill live");
  private readonly storeButton = el("button", "pill store", "Store");
  private readonly undoButton = iconButton(ICONS.undo, "Annuler", () => this.undo());
  private readonly tiles = el("div", "blocks");
  private readonly levelBar = el("div", "levels");
  private readonly paramsHead = el("div", "params-head");
  private readonly paramsList = el("div", "params");
  private readonly body = el("div", "preset-body");

  constructor(private bank: BankStore) {
    this.resetLevels();
    this.nameButton.type = "button";
    this.nameButton.title = "Renommer le preset";
    this.nameButton.addEventListener("click", () => void this.rename());
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
    this.levelBar.setAttribute("aria-label", "Loops, insert et boost (en Live)");
    column.append(this.tiles, this.levelBar);
    const params = el("section", "params-section");
    params.setAttribute("aria-label", "Paramètres");
    params.append(this.paramsHead, this.paramsList);
    this.body.append(column, params);
    this.el.append(header, this.body);
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
    this.onNotice?.(`« ${this.buffer.name} » chargé dans la mémoire de travail du G-System`);
  }

  private sendChanges(before: Uint8Array, after: Uint8Array): void {
    if (this.fromUnit || !this.isLive) return;
    for (const [index, , value] of diffFields(before, after)) {
      const blk = owner(index);
      if (blk && index !== blk.countField) this.sendParam!(BLOCK_IDS[blk.key], index - blk.firstField, value);
      else if (isModifierField(index)) this.sendParam!(MODIFIER_BLOCK_ID, MODIFIER_PARAM_BASE + index - MODIFIER_FIELD, value);
    }
  }

  /** A switch or knob was used on the G-System: mirror it in the edit buffer. */
  applyFromUnit(blockId: number, param: number, value: number): void {
    if (blockId === LEVELS_BLOCK_ID) {
      for (const [key, index] of Object.entries(LEVEL_SWITCHES)) if (index === param) this.levels[key] = Boolean(value);
      this.renderLevels();
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
    this.resetLevels();
    this.stored = this.bank.preset(slot);
    this.undoStack = [];
    this.redoStack = [];
    this.setBuffer(this.stored, false);
    this.onSlotChange?.(slot);
    if (changed && !this.fromUnit) this.pushToUnit();
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

  private pushBuffer(after: Preset): void {
    this.undoStack.push([this.buffer!, after]);
    this.redoStack = [];
    this.setBuffer(after);
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

  revert(): void {
    if (!this.isDirty) return;
    this.undoStack = [];
    this.redoStack = [];
    this.setBuffer(this.stored);
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

  private toggleLevel(key: string): void {
    if (!this.isLive) return;
    const on = !this.levels[key];
    this.sendParam!(LEVELS_BLOCK_ID, LEVEL_SWITCHES[key], Number(on));
    this.levels[key] = on;
    this.renderLevels();
  }

  private resetLevels(): void {
    this.levels = Object.fromEntries(Object.keys(LEVEL_SWITCHES).map((k) => [k, null]));
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
      : this.isLive ? "LIVE · mémoire de travail" : `${this.bank.title} · ${slotLabel(this.slot)}`;
    this.nameButton.innerHTML = "";
    this.nameButton.append(el("span", "name", this.buffer ? this.buffer.name || "(sans nom)" : "— vide —"),
      el("span", this.isDirty || this.isLive ? "status alert" : "status", status));
    this.liveButton.classList.toggle("active", this.isLive);
    this.liveButton.setAttribute("aria-pressed", String(this.isLive));
    this.storeButton.classList.toggle("dirty", this.isDirty);
    this.storeButton.disabled = !this.isDirty;
    this.undoButton.disabled = !this.undoStack.length;
    this.renderTiles();
    this.renderLevels();
    this.renderParams();
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
      const typeShort = blk.hasType ? kind ?? "" : key === "eq" ? "3 bandes" : "Gate";
      pick.append(el("span", "tile-code", code), el("span", "tile-type", typeShort));
      pick.addEventListener("click", () => {
        this.blockKey = key;
        this.closeSheet();
        this.render();
      });
      tile.append(footswitch, pick);
      return tile;
    }), this.modifiersTile());
  }

  private modifiersTile(): HTMLElement {
    const assigned = this.buffer ? this.assignedModifiers(this.buffer.data) : [];
    const sources = [...new Set(assigned.map((t) => SHORT_SOURCES[t.modifier.source]))];
    const tile = el("button", `tile wide${this.blockKey === MODIFIERS ? " selected" : ""}${assigned.length ? " on" : ""}`);
    tile.type = "button";
    tile.setAttribute("aria-label", `Pédales et encodeurs, ${assigned.length} affectation(s)`);
    const head = el("span", "tile-head");
    head.append(el("span", "tile-code", "PÉDALES"), el("span", assigned.length ? "tile-count" : "tile-count none",
      sources.join(" · ") || "aucune"));
    tile.append(head, el("span", "tile-type", assigned.length
      ? assigned.map((t) => t.name).join(", ") : "Exp, Vol, encodeurs A-C"));
    tile.addEventListener("click", () => {
      this.blockKey = MODIFIERS;
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
      const state = this.levels[key];
      const b = el("button", `level${state ? " on" : ""}${state === null ? " unknown" : ""}`, label);
      b.type = "button";
      b.disabled = !this.isLive;
      b.title = `${label === "INS" ? "Insert (loop 5)" : label === "BST" ? "Boost" : `Loop ${label.slice(1)}`}`
        + (state === null ? " — état inconnu tant qu'il n'a pas été changé" : "");
      b.setAttribute("aria-pressed", String(!!state));
      b.addEventListener("click", () => this.toggleLevel(key));
      return b;
    }));
  }

  private renderParams(): void {
    if (this.blockKey === MODIFIERS) {
      this.renderModifiers();
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
      sw.append(trackEl, el("span", "switch-text", on ? "Activé" : "Désactivé"));
      sw.addEventListener("click", () => this.toggleBlock(blk.key));
      this.paramsHead.append(sw);
    }
    this.paramsList.classList.toggle("on-block", on);
    // Type and on/off are in the block header.
    const rows = blk.fields(preset.data)
      .filter(([index, p]) => !(blk.hasType && index === blk.firstField) && p.name !== blk.enableName);
    const pedals = new Map(this.assignedModifiers(preset.data).map((t) => [t.paramField, t.modifier.source]));
    this.paramsList.replaceChildren(...rows.map(([index, p]) =>
      this.paramRow(index, p, readField(preset.data, index), pedals.get(index))));
  }

  private renderModifiers(): void {
    this.paramsHead.replaceChildren(el("span", "label", "Pédales & encodeurs"), el("div", "grow"));
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
    const summary = !valid ? "valeurs invalides" : active ? `${SOURCES[m.source]}, ${m.min} / ${m.mid} / ${m.max} %` : "aucune";
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

  private paramRow(index: number, p: Param, value: number, pedal?: number): HTMLElement {
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
      this.openSheet(index);
    });
    return row;
  }

  // Fine-adjust sheet

  private openSheet(index: number): void {
    this.body.querySelector(".sheet-layer")?.remove();
    const preset = this.buffer;
    if (!preset) return;
    const blk = block(this.blockKey);
    const param = blk.fields(preset.data).find(([f]) => f === index)?.[1];
    if (!param) return;
    let value = readField(preset.data, index);

    const close = () => this.closeSheet();
    const sheet = el("div", "sheet");
    const head = el("div", "sheet-head");
    head.append(el("span", "", `${TILE_LABELS[blk.key] ?? blk.label} · ${param.name}`), el("span", "field", `champ #${index}`));
    const big = el("div", "sheet-value", param.format(value));
    sheet.append(head, big);

    const commit = (v: number) => {
      v = Math.max(param.lo, Math.min(param.hi, v));
      if (v === value) return;
      value = v;
      big.textContent = param.format(v);
      this.setField(index, v);
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
    const reset = el("button", "", "Retirer");
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
