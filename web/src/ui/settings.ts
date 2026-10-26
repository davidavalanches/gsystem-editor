/** Settings view: the unit's global settings (levels, utility, pedals, MIDI, tuner), read and written live. */

import { GLOBAL_GROUPS, formatGlobal, globalKey, globalRaw, globalValue, type GlobalParam } from "../core/globals";
import {
  FUNCTIONS, STYLES, SWITCH_BANKS, SWITCH_BLOCK, SWITCH_COUNT, SWITCH_FIRST, decodeSwitch, encodeSwitch, switchKind,
  withFunction, type SwitchSetting,
} from "../core/switches";
import { el } from "./dom";

export class SettingsView {
  readonly el = el("section", "view");
  /** Raw values read from the unit, by globalKey. */
  private readonly raw = new Map<string, number>();
  private readonly rows = new Map<string, () => void>();
  private readonly readButton = el("button", "pill", "Relire");
  private readonly note = el("p", "settings-note");
  private connected = false;
  onRead: (() => void) | null = null;
  onChange: ((block: number, param: number, raw: number) => void) | null = null;

  constructor() {
    this.readButton.type = "button";
    this.readButton.addEventListener("click", () => this.onRead?.());
    const header = el("header", "header");
    header.append(el("div", "grow header-title", "Réglages du G-System"), this.readButton);
    const body = el("div", "settings-body");
    body.append(this.note);
    for (const group of GLOBAL_GROUPS) {
      const card = el("div", "card settings-card");
      card.append(el("h2", "", group.title));
      for (const g of group.params) card.append(this.row(g));
      body.append(card);
    }
    const switches = el("div", "card settings-card switches-card");
    switches.append(el("h2", "", "Switches"),
      el("p", "", "Fonction de chaque switch du pédalier. EDIT, UP et DOWN sont fixes."));
    for (let n = 0; n < SWITCH_COUNT; n++) switches.append(this.switchRow(n));
    body.append(switches);
    this.el.append(header, body);
    this.setConnected(false);
  }

  setConnected(on: boolean): void {
    this.connected = on;
    if (!on) this.raw.clear();
    this.readButton.disabled = !on;
    this.refresh();
  }

  /** A value arrived from the unit (answer to a read, or a change made on its front panel). */
  update(block: number, param: number, raw: number): void {
    const key = globalKey(block, param);
    const draw = this.rows.get(key);
    if (!draw) return;
    this.raw.set(key, raw);
    draw();
    this.refreshNote();
  }

  private refresh(): void {
    for (const draw of this.rows.values()) draw();
    this.refreshNote();
  }

  private refreshNote(): void {
    this.note.textContent = !this.connected
      ? "Connectez le G-System (vue MIDI) : ces réglages sont lus et modifiés directement dans le pédalier."
      : this.raw.size ? "Chaque changement est appliqué immédiatement par le G-System (ce ne sont pas des réglages de preset)."
        : "Lecture des réglages…";
  }

  /** One footswitch: its function, then the style, the preset to recall or the CC to send. */
  private switchRow(n: number): HTMLElement {
    const param = SWITCH_FIRST + n;
    const key = globalKey(SWITCH_BLOCK, param);
    const row = el("div", "setting switch-setting");
    row.append(el("span", "switch-number", `#${n + 1}`));
    const control = el("div", "setting-control");
    row.append(control);
    const select = (label: string, options: string[]) => {
      const s = el("select", "type-select");
      s.setAttribute("aria-label", `Switch #${n + 1} : ${label}`);
      options.forEach((o, i) => s.append(new Option(o, String(i))));
      return s;
    };
    const fn = select("fonction", [...FUNCTIONS]);
    const style = select("style", STYLES);
    const bank = select("banque", SWITCH_BANKS);
    const preset = select("preset", ["1", "2", "3", "4", "5"]);
    preset.classList.add("narrow");
    const cc = select("CC", Array.from({ length: 120 }, (_, i) => `CC ${i}`));
    control.append(fn, style, bank, preset, cc);

    const current = (): SwitchSetting | null => {
      const raw = this.raw.get(key);
      return raw === undefined ? null : decodeSwitch(raw);
    };
    const send = (next: SwitchSetting) => {
      const raw = encodeSwitch(next);
      if (raw === this.raw.get(key)) return;
      this.raw.set(key, raw);
      this.onChange?.(SWITCH_BLOCK, param, raw);
      draw();
    };
    const set = (s: HTMLSelectElement, v: number) => {
      if (![...s.options].some((o) => o.value === String(v))) s.append(new Option(String(v), String(v)));
      s.value = String(v);
    };
    fn.addEventListener("change", () => { const c = current(); if (c) send(withFunction(c, Number(fn.value))); });
    style.addEventListener("change", () => { const c = current(); if (c) send({ ...c, p1: Number(style.value) }); });
    bank.addEventListener("change", () => { const c = current(); if (c) send({ ...c, p1: Number(bank.value) }); });
    cc.addEventListener("change", () => { const c = current(); if (c) send({ ...c, p1: Number(cc.value) }); });
    preset.addEventListener("change", () => { const c = current(); if (c) send({ ...c, p2: Number(preset.value) }); });

    const draw = () => {
      const c = current();
      fn.disabled = c === null;
      if (c === null) fn.selectedIndex = -1;
      const kind = c ? switchKind(c.fn) : "none";
      style.hidden = kind !== "style";
      bank.hidden = preset.hidden = kind !== "preset";
      cc.hidden = kind !== "cc";
      if (!c) return;
      set(fn, c.fn);
      if (kind === "style") set(style, c.p1);
      if (kind === "preset") { set(bank, c.p1); set(preset, c.p2); }
      if (kind === "cc") set(cc, c.p1);
    };
    this.rows.set(key, draw);
    return row;
  }

  private row(g: GlobalParam): HTMLElement {
    const key = globalKey(g.block, g.param);
    const row = el("div", "setting");
    const label = el("div", "setting-label");
    label.append(el("span", "setting-name", g.name));
    if (g.help) label.append(el("span", "setting-help", g.help));
    const control = el("div", "setting-control");
    row.append(label, control);

    const send = (value: number) => {
      const raw = this.raw.get(key);
      if (raw === undefined) return;
      const next = globalRaw(g, raw, Math.max(g.lo, Math.min(g.hi, value)));
      if (next === raw) return;
      this.raw.set(key, next);
      this.onChange?.(g.block, g.param, next);
      draw();
    };
    const current = () => {
      const raw = this.raw.get(key);
      return raw === undefined ? null : globalValue(g, raw);
    };

    let draw: () => void;
    if (g.choices) {
      const select = el("select", "type-select");
      select.setAttribute("aria-label", g.name);
      g.choices.forEach((c, i) => select.append(new Option(c, String(g.lo + i))));
      select.addEventListener("change", () => send(Number(select.value)));
      control.append(select);
      draw = () => {
        const v = current();
        select.disabled = v === null;
        if (v === null) select.selectedIndex = -1;
        else {
          // Values outside the list are shown as such rather than silently mapped.
          if (![...select.options].some((o) => o.value === String(v))) select.append(new Option(String(v), String(v)));
          select.value = String(v);
        }
      };
    } else {
      const value = el("span", "setting-value");
      const minus = stepButton("−", `${g.name} : diminuer`, () => send((current() ?? 0) - 1));
      const plus = stepButton("+", `${g.name} : augmenter`, () => send((current() ?? 0) + 1));
      control.append(minus, value, plus);
      draw = () => {
        const v = current();
        value.textContent = v === null ? "—" : formatGlobal(g, v);
        minus.disabled = plus.disabled = v === null;
      };
    }
    this.rows.set(key, () => draw());
    return row;
  }
}

/** − / + button that repeats while held. */
function stepButton(label: string, ariaLabel: string, action: () => void): HTMLButtonElement {
  const b = el("button", "step", label);
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
        repeat(Math.max(60, delay * 0.8));
      }, delay);
    };
    repeat(400);
  });
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) b.addEventListener(ev, stop);
  return b;
}
