/** Preset editor: virtual front panel, block switches and parameter views. */

import { bankPosition, BANK_COUNT, PRESETS_PER_BANK, type BankStore } from "../core/bank";
import { BLOCKS, SWITCH_BLOCKS, block, diffFields, owner, readField, writeField, type Block, type Param } from "../core/params";
import { BLOCK_IDS, LEVELS_BLOCK_ID, LEVEL_SWITCHES } from "../core/protocol";
import { NAME_LEN, Preset, SysexError, USER_SLOTS } from "../core/sysex";
import { Knob, Toggle } from "./controls";
import { FrontPanel } from "./frontpanel";
import { el } from "./dom";

const VIEWS: [string, string, string[] | null][] = [
  ["all", "Tout", null],
  ["filter", "Filter", ["filter"]],
  ["dyn", "Dyn | EQ", ["comp", "gate", "eq"]],
  ["mod", "Mod", ["mod"]],
  ["pitch", "Pitch", ["pitch"]],
  ["delay", "Delay", ["delay"]],
  ["reverb", "Reverb", ["reverb"]],
];

/** Knob, toggle or value list bound to one preset field. */
class ParamControl {
  readonly el = el("div", "param");
  private readonly readout = el("div", "param-value");
  private knob: Knob | null = null;
  private toggle: Toggle | null = null;
  private select: HTMLSelectElement | null = null;

  constructor(readonly index: number, readonly param: Param, edited: (index: number, value: number) => void) {
    const title = el("div", "param-name", param.name);
    title.title = `Champ #${index} — plage ${param.lo} à ${param.hi}`;
    this.el.append(title);
    if (param.isSwitch) {
      this.toggle = new Toggle();
      this.toggle.onChange = (on) => edited(index, param.lo + Number(on));
      this.el.append(this.toggle.el);
    } else if (param.choices.length) {
      this.select = el("select", "param-select");
      for (let v = param.lo; v <= param.hi; v++) this.select.append(new Option(param.format(v), String(v)));
      this.select.addEventListener("change", () => edited(index, Number(this.select!.value)));
      this.el.append(this.select);
    } else {
      this.knob = new Knob(param.lo, param.hi);
      this.knob.onInput = (v) => (this.readout.textContent = param.format(v));
      this.knob.onChange = (v) => edited(index, v);
      this.el.append(this.knob.el, this.readout);
    }
  }

  setValue(value: number): void {
    if (this.toggle) this.toggle.setChecked(value !== this.param.lo);
    else if (this.select) {
      if (![...this.select.options].some((o) => o.value === String(value))) {
        this.select.append(new Option(`? ${value}`, String(value)));
      }
      this.select.value = String(value);
    } else if (this.knob) {
      this.knob.setValue(value);
      const outOfRange = value < this.param.lo || value > this.param.hi;
      this.readout.textContent = this.param.format(value) + (outOfRange ? " ⚠" : "");
    }
  }
}

/** Controls of one effect block, rebuilt when the effect type changes. */
class BlockPanel {
  readonly el = el("section", "block-panel");
  private readonly grid = el("div", "param-grid");
  private signature = "";
  private controls: ParamControl[] = [];

  constructor(readonly blk: Block, private edited: (index: number, value: number) => void) {
    this.el.append(el("h3", "", blk.label), this.grid);
  }

  load(data: Uint8Array): void {
    const fields = this.blk.fields(data);
    const signature = fields.map(([f, p]) => `${f}:${p.name}`).join(",");
    if (signature !== this.signature) {
      this.signature = signature;
      this.controls = fields.map(([f, p]) => new ParamControl(f, p, this.edited));
      this.grid.replaceChildren(...this.controls.map((c) => c.el));
    }
    for (const c of this.controls) c.setValue(readField(data, c.index));
  }
}

/** Edit buffer for one preset. Changes reach the bank only through Store. */
export class PresetEditor {
  readonly el = el("div", "editor");
  readonly panel = new FrontPanel();
  slot = 0;
  buffer: Preset | null = null;
  private stored: Preset | null = null;
  private undoStack: [Preset, Preset, string][] = [];
  private redoStack: [Preset, Preset, string][] = [];
  private panels: BlockPanel[] = [];
  private readonly pages = el("div", "pages");
  private readonly liveButton = el("button", "live", "Live");
  private fromUnit = false;
  private live = false;
  /** Level switches (loops, insert, boost): state unknown until seen. */
  private levelStates: Record<string, boolean | null> = {};
  /** Sends a parameter to the unit; null when not connected. */
  sendParam: ((blockId: number, param: number, value: number) => void) | null = null;
  onStore: ((slot: number, preset: Preset) => void) | null = null;
  onNotice: ((text: string) => void) | null = null;
  onChange: (() => void) | null = null;

  constructor(private bank: BankStore) {
    this.resetLevels();
    this.panel.onPress = (key) => this.press(key);
    this.panel.onName = () => this.renameDialog();

    this.liveButton.disabled = true;
    this.liveButton.title = "Envoyer chaque modification au G-System (mémoire de travail, sans Store) "
      + "et suivre les changements faits sur le pédalier";
    this.liveButton.addEventListener("click", () => this.setLive(!this.live));
    const store = el("button", "", "Store");
    store.title = "Enregistrer le preset modifié dans son emplacement de la banque";
    store.addEventListener("click", () => this.store());
    const revert = el("button", "", "Revenir");
    revert.title = "Abandonner les modifications non stockées";
    revert.addEventListener("click", () => this.revert());
    const header = el("div", "editor-header");
    header.append(el("div", "spacer"), this.liveButton, store, revert);

    const tabs = el("div", "tabs");
    VIEWS.forEach(([key, label, keys], i) => {
      const tab = el("button", i === 0 ? "tab active" : "tab", label);
      const page = el("div", i === 0 ? "page compact" : "page");
      page.hidden = i !== 0;
      for (const blk of keys ? keys.map(block) : BLOCKS) {
        const p = new BlockPanel(blk, (index, value) => this.setField(index, value, `${blk.label}`));
        this.panels.push(p);
        page.append(p.el);
      }
      tab.dataset.view = key;
      tab.addEventListener("click", () => {
        tabs.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
        this.pages.querySelectorAll<HTMLElement>(".page").forEach((pg, j) => (pg.hidden = j !== i));
      });
      tabs.append(tab);
      this.pages.append(page);
    });
    this.el.append(header, this.panel.canvas, tabs, this.pages,
      el("p", "legend", "Paramètres, plages et listes de valeurs : tables du firmware G-System 4.02."));
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
    this.liveButton.classList.toggle("active", on);
    // Entering Live mode loads the edited preset into the unit so both match.
    if (on) this.pushToUnit();
    this.refreshPanel();
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
    this.onNotice?.(`« ${this.buffer.name} » chargé dans la mémoire de travail du G-System`);
  }

  private sendChanges(before: Uint8Array, after: Uint8Array): void {
    if (this.fromUnit || !this.isLive) return;
    for (const [index, , value] of diffFields(before, after)) {
      const blk = owner(index);
      if (blk && index !== blk.countField) this.sendParam!(BLOCK_IDS[blk.key], index - blk.firstField, value);
    }
  }

  /** A switch or knob was used on the G-System: mirror it in the edit buffer. */
  applyFromUnit(blockId: number, param: number, value: number): void {
    if (blockId === LEVELS_BLOCK_ID) {
      for (const [key, index] of Object.entries(LEVEL_SWITCHES)) {
        if (index === param) this.levelStates[key] = Boolean(value);
      }
      this.refreshPanel();
      return;
    }
    const key = Object.keys(BLOCK_IDS).find((k) => BLOCK_IDS[k] === blockId);
    if (!key || !this.buffer || !this.live) return;
    const blk = block(key);
    if (param >= blk.size) return;
    this.fromUnit = true;
    try {
      this.setField(blk.firstField + param, value, `G-System · ${blk.label}`);
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
      const keep = confirm(`Le preset « ${this.buffer!.name} » a été modifié sans être stocké.\n`
        + "OK : le stocker avant de changer de preset. Annuler : abandonner les modifications.");
      if (keep) this.store();
    }
    const changed = slot !== this.slot;
    this.slot = slot;
    this.resetLevels();
    this.stored = this.bank.preset(slot);
    this.undoStack = [];
    this.redoStack = [];
    this.setBuffer(this.stored, false);
    if (changed && !this.fromUnit) this.pushToUnit();
  }

  /** The bank slot changed under us (paste, import, undo): follow it if not edited. */
  reloadIfShowing(slot: number): void {
    if (slot === this.slot && !this.isDirty) {
      this.stored = this.bank.preset(slot);
      this.setBuffer(this.stored, false);
    }
  }

  private setBuffer(preset: Preset | null, send = true): void {
    if (send && this.buffer && preset) this.sendChanges(this.buffer.data, preset.data);
    this.buffer = preset;
    this.pages.classList.toggle("disabled", !preset);
    if (preset) for (const p of this.panels) p.load(preset.data);
    this.refreshPanel();
    this.onChange?.();
  }

  setField(index: number, value: number, text: string): void {
    if (!this.buffer || readField(this.buffer.data, index) === value) return;
    let data: Uint8Array;
    try {
      data = writeField(this.buffer.data, index, value);
    } catch {
      return;
    }
    this.pushBuffer(this.buffer.withData(data), `${text} = ${value}`);
  }

  private pushBuffer(after: Preset, text: string): void {
    this.undoStack.push([this.buffer!, after, text]);
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
    this.refreshPanel();
  }

  revert(): void {
    if (!this.isDirty) return;
    this.undoStack = [];
    this.redoStack = [];
    this.setBuffer(this.stored);
  }

  renameDialog(): void {
    if (!this.buffer) return;
    const name = prompt(`Nom du preset (${NAME_LEN} caractères max.)`, this.buffer.name)?.trim();
    if (!name || name === this.buffer.name) return;
    try {
      this.pushBuffer(this.buffer.withName(name.slice(0, NAME_LEN)), "Renommer");
    } catch (e) {
      if (e instanceof SysexError) alert("Utilisez uniquement des caractères ASCII imprimables.");
      else throw e;
    }
  }

  // Front panel

  press(key: string): void {
    if ((SWITCH_BLOCKS as readonly string[]).includes(key) && this.buffer) {
      const blk = block(key);
      const field = blk.enableField(this.buffer.data);
      if (field !== null) {
        const on = readField(this.buffer.data, field) !== 1;
        this.setField(field, Number(on), `${blk.label} ${on ? "on" : "off"}`);
      }
    } else if (key in LEVEL_SWITCHES) {
      if (this.isLive) {
        const on = !this.levelStates[key];
        this.sendParam!(LEVELS_BLOCK_ID, LEVEL_SWITCHES[key], Number(on));
        this.levelStates[key] = on;
        this.refreshPanel();
      }
    } else if (key === "up" || key === "down") {
      // Like the unit: change bank, keep the position within the bank.
      const [b, position] = bankPosition(this.slot);
      const target = (b + (key === "up" ? 1 : -1) + BANK_COUNT) % BANK_COUNT;
      this.openSlot(target * PRESETS_PER_BANK + position - 1);
    } else if (key.startsWith("preset")) {
      const target = this.slot - (this.slot % PRESETS_PER_BANK) + Number(key.slice(-1)) - 1;
      if (target !== this.slot) this.openSlot(target);
    }
  }

  private resetLevels(): void {
    this.levelStates = Object.fromEntries(Object.keys(LEVEL_SWITCHES).map((k) => [k, null]));
  }

  private refreshPanel(): void {
    const preset = this.buffer;
    const leds: Record<string, boolean | null> = {};
    const enabled = new Set(["up", "down", "preset1", "preset2", "preset3", "preset4", "preset5"]);
    for (const key of SWITCH_BLOCKS) {
      const field = preset ? block(key).enableField(preset.data) : null;
      if (preset && field !== null) {
        leds[key] = readField(preset.data, field) === 1;
        enabled.add(key);
      }
    }
    for (const key of Object.keys(LEVEL_SWITCHES)) {
      leds[key] = this.levelStates[key];
      if (this.isLive) enabled.add(key);
    }
    const [b, position] = bankPosition(this.slot);
    for (let i = 1; i <= PRESETS_PER_BANK; i++) leds[`preset${i}`] = position === i;
    let status = this.isDirty ? "Store pour garder" : "";
    if (this.isLive) status = `LIVE  ${status}`.trim();
    this.panel.setState({
      bank: String(b).padStart(2, "0"), position: String(position), name: preset?.name ?? "", leds, enabled,
      edited: this.isDirty, status, live: this.isLive,
    });
  }
}
