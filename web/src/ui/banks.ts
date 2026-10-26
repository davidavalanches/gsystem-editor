/** Bank grid: one row per bank (00-39), one column per preset position (1-5). */

import { BANK_COUNT, PRESETS_PER_BANK, slotLabel, type BankStore } from "../core/bank";
import { BLOCKS, readField } from "../core/params";
import { NAME_LEN, type Preset } from "../core/sysex";
import { el } from "./dom";

export class BanksView {
  readonly el = el("div", "banks");
  private readonly table = el("table", "bank-grid");
  private readonly summary = el("div", "summary");
  private readonly cells: HTMLTableCellElement[] = [];
  selected = new Set<number>([0]);
  current = 0;
  private clipboard: (Preset | null)[] = [];
  onOpen: ((slot: number) => void) | null = null;

  constructor(private bank: BankStore) {
    const head = el("tr");
    head.append(el("th"));
    for (let p = 1; p <= PRESETS_PER_BANK; p++) head.append(el("th", "", `Preset ${p}`));
    const thead = el("thead");
    thead.append(head);
    const tbody = el("tbody");
    for (let b = 0; b < BANK_COUNT; b++) {
      const row = el("tr");
      row.append(el("th", "", String(b).padStart(2, "0")));
      for (let p = 0; p < PRESETS_PER_BANK; p++) {
        const slot = b * PRESETS_PER_BANK + p;
        const td = el("td");
        td.addEventListener("click", (e) => this.select(slot, e.shiftKey, e.ctrlKey || e.metaKey));
        td.addEventListener("dblclick", () => this.onOpen?.(slot));
        this.cells.push(td);
        row.append(td);
      }
      tbody.append(row);
    }
    this.table.append(thead, tbody);
    const scroller = el("div", "grid-scroller");
    scroller.append(this.table);
    this.el.append(scroller, this.summary);
    this.refresh(null);
  }

  /** Redraw the given slots (all when null). */
  refresh(slots: number[] | null): void {
    for (const slot of slots ?? this.cells.keys()) {
      const td = this.cells[slot];
      const p = this.bank.preset(slot);
      td.textContent = p ? p.name || "(sans nom)" : "— vide —";
      td.className = [!p || !p.name ? "empty" : "", p && !p.checksumOk ? "warn" : "",
        this.selected.has(slot) ? "selected" : "", slot === this.current ? "current" : ""].join(" ").trim();
      td.title = slotLabel(slot) + (p && !p.checksumOk
        ? "\nSomme de contrôle invalide dans le fichier : elle sera corrigée à l'enregistrement." : "");
    }
    this.renderSummary();
  }

  select(slot: number, extend = false, toggle = false): void {
    const before = [...this.selected, this.current];
    if (extend) {
      const [a, b] = [Math.min(this.current, slot), Math.max(this.current, slot)];
      for (let s = a; s <= b; s++) this.selected.add(s);
    } else if (toggle) {
      if (this.selected.has(slot)) this.selected.delete(slot);
      else this.selected.add(slot);
    } else {
      this.selected = new Set([slot]);
    }
    this.current = slot;
    this.refresh([...new Set([...before, ...this.selected, slot])]);
  }

  get selectedSlots(): number[] {
    return [...this.selected].sort((a, b) => a - b);
  }

  private renderSummary(): void {
    const slot = this.current;
    const p = this.bank.preset(slot);
    const actions = el("div", "summary-actions");
    const button = (label: string, action: () => void, disabled = false) => {
      const b = el("button", "", label);
      b.disabled = disabled;
      b.addEventListener("click", action);
      actions.append(b);
    };
    button("Ouvrir", () => this.onOpen?.(slot), !p);
    button("Renommer", () => this.rename(slot), !p);
    button("Copier", () => (this.clipboard = this.selectedSlots.map((s) => this.bank.preset(s))));
    button("Coller", () => this.paste(), !this.clipboard.length);
    button("Vider", () => this.clear());
    this.summary.replaceChildren(el("h2", "", `${slotLabel(slot)} — ${p ? p.name || "(sans nom)" : "vide"}`));
    if (p) {
      const table = el("table", "effects");
      for (const blk of BLOCKS) {
        const kind = blk.effectType(p.data);
        const field = blk.enableField(p.data);
        const on = field !== null && readField(p.data, field) === 1;
        const row = el("tr");
        row.append(el("td", "", blk.label), el("td", "", kind?.name ?? ""), el("td", on ? "on" : "off", on ? "On" : "Off"));
        table.append(row);
      }
      this.summary.append(table);
      if (!p.checksumOk) {
        this.summary.append(el("p", "warn", "⚠ Somme de contrôle invalide dans le fichier : elle sera corrigée à l'enregistrement."));
      }
    }
    this.summary.append(actions);
  }

  private rename(slot: number): void {
    const p = this.bank.preset(slot);
    if (!p) return;
    const name = prompt(`Nom du preset (${NAME_LEN} caractères max.)`, p.name)?.trim();
    if (!name || name === p.name) return;
    try {
      this.bank.setSlots(new Map([[slot, p.withName(name.slice(0, NAME_LEN))]]), `Renommer « ${p.name} »`);
    } catch {
      alert("Utilisez uniquement des caractères ASCII imprimables.");
    }
  }

  confirmOverwrite(changes: Map<number, Preset | null>): boolean {
    const lost = [...changes].filter(([s, p]) => {
      const old = this.bank.preset(s);
      return old && (!p || !p.data.every((b, i) => b === old.data[i]));
    }).map(([s]) => `${slotLabel(s)}  ${this.bank.preset(s)!.name}`);
    if (!lost.length) return true;
    return confirm(`${lost.length} preset(s) existant(s) vont être remplacés :\n\n${lost.slice(0, 15).join("\n")}`
      + `${lost.length > 15 ? "\n…" : ""}\n\nVous pourrez annuler.`);
  }

  private paste(): void {
    const changes = new Map<number, Preset | null>();
    this.clipboard.forEach((p, i) => {
      if (this.current + i < this.cells.length) changes.set(this.current + i, p);
    });
    if (this.confirmOverwrite(changes)) this.bank.setSlots(changes, `Coller ${changes.size} preset(s)`);
  }

  private clear(): void {
    const changes = new Map(this.selectedSlots.map((s) => [s, null] as [number, null]));
    if (this.confirmOverwrite(changes)) this.bank.setSlots(changes, `Vider ${changes.size} emplacement(s)`);
  }
}
