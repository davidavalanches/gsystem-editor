/** Banks view: the 40 banks on the left, the 5 presets of the chosen bank on the right. */

import { AVOIDED_BANKS, BANK_COUNT, PRESETS_PER_BANK, slotLabel, type BankStore } from "../core/bank";
import { block, readField } from "../core/params";
import { NAME_LEN, type Preset } from "../core/sysex";
import { askText } from "./dialog";
import { el } from "./dom";
import { ICONS, iconButton, onLongPress, showMenu, type MenuItem } from "./widgets";

/** LED order: the unit's effect sections, as on the Preset view. */
const LED_BLOCKS = ["filter", "comp", "mod", "pitch", "delay", "reverb", "eq", "gate"];

export interface BanksActions {
  open(slot: number): void;
  menu(): MenuItem[];
  readUnit(): void;
  sync(): void;
}

export class BanksView {
  readonly el = el("section", "view");
  bankIndex = 0;
  /** The preset shown in the Preset view, highlighted here. */
  current = 0;
  private clipboard: Preset | null = null;
  private readonly title = el("div", "header-title");
  private readonly sub = el("div");
  private readonly readButton = el("button", "pill primary", "Lire le G-System");
  private readonly syncButton = el("button", "pill sync");
  private connected = false;
  private readonly list = el("div", "bank-list");
  private readonly slots = el("div", "slots");
  private bankButtons: HTMLButtonElement[] = [];
  private reading: [number, number] | null = null;

  constructor(private bank: BankStore, private actions: BanksActions) {
    this.readButton.type = "button";
    this.readButton.disabled = true;
    this.readButton.addEventListener("click", () => actions.readUnit());
    this.syncButton.type = "button";
    this.syncButton.title = "Écrire dans le G-System les presets modifiés hors connexion (chacun vérifié)";
    this.syncButton.addEventListener("click", () => actions.sync());
    const titles = el("div", "grow");
    titles.append(this.title, this.sub);
    const more = iconButton(ICONS.more, "Plus d'actions : ouvrir, exporter, annuler", () => showMenu(more, actions.menu()));
    const header = el("header", "header");
    header.append(titles, iconButton(ICONS.search, "Rechercher un preset", () => void this.search()),
      this.syncButton, this.readButton, more);

    this.list.setAttribute("role", "listbox");
    this.list.setAttribute("aria-label", "Banques");
    for (let b = 0; b < BANK_COUNT; b++) {
      const button = el("button");
      button.type = "button";
      button.setAttribute("role", "option");
      button.addEventListener("click", () => this.showBank(b));
      this.bankButtons.push(button);
      this.list.append(button);
    }
    const body = el("div", "banks-body");
    body.append(this.list, this.slots);
    this.el.append(header, body);
    this.refresh();
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    this.readButton.disabled = !connected;
    this.renderHeader();
  }

  /** Reading progress, or null when no read is running. */
  setReading(progress: [number, number] | null): void {
    this.reading = progress;
    this.readButton.textContent = progress ? "Annuler" : "Lire le G-System";
    this.readButton.className = progress ? "pill warn" : "pill primary";
    this.renderHeader();
  }

  showBank(index: number, focus = false): void {
    this.bankIndex = index;
    this.refresh();
    if (focus) this.bankButtons[index].scrollIntoView({ block: "nearest" });
  }

  refresh(): void {
    this.renderHeader();
    this.bankButtons.forEach((button, b) => {
      const selected = b === this.bankIndex;
      button.setAttribute("aria-selected", String(selected));
      button.classList.toggle("avoided", AVOIDED_BANKS.has(b));
      button.classList.toggle("has-pending",
        [...Array(PRESETS_PER_BANK).keys()].some((i) => this.bank.pending.has(b * PRESETS_PER_BANK + i)));
      button.title = AVOIDED_BANKS.has(b) ? "Banque exclue de l'écriture dans le G-System (zone mémoire défaillante)" : "";
      const used = [...Array(PRESETS_PER_BANK).keys()].map((i) => !!this.bank.preset(b * PRESETS_PER_BANK + i));
      const num = el("span", used.some(Boolean) ? "bank-num used" : "bank-num", String(b).padStart(2, "0"));
      const dots = el("span", "fill-dots");
      for (const u of used) dots.append(el("span", u ? "used" : ""));
      button.replaceChildren(num, dots);
      button.setAttribute("aria-label", `Banque ${String(b).padStart(2, "0")}, ${used.filter(Boolean).length} presets`);
    });
    this.slots.replaceChildren(...[...Array(PRESETS_PER_BANK).keys()].map((i) => this.slotRow(this.bankIndex * PRESETS_PER_BANK + i)));
  }

  private renderHeader(): void {
    this.title.textContent = this.bank.title + (this.bank.undo.isClean ? "" : " *");
    const pending = this.bank.pending.size;
    this.syncButton.hidden = !pending;
    this.syncButton.textContent = `Synchroniser (${pending})`;
    this.syncButton.disabled = !this.connected || !!this.reading;
    if (this.reading) {
      const [done, total] = this.reading;
      this.sub.className = "reading";
      const bar = el("span", "progress");
      const fill = el("span");
      fill.style.width = `${(done / Math.max(1, total)) * 100}%`;
      bar.append(fill);
      this.sub.replaceChildren(el("b", "", `Lecture ${done}/${total}`), bar);
    } else {
      const used = this.bank.presets.filter(Boolean).length;
      const bad = this.bank.presets.filter((p) => p && !p.checksumOk).length;
      this.sub.className = "header-sub";
      this.sub.textContent = `${used} presets sur 200 · `
        + (pending ? `${pending} à synchroniser avec le G-System`
          : bad ? `${bad} somme(s) de contrôle à corriger` : "sommes de contrôle valides");
    }
  }

  private slotRow(slot: number): HTMLElement {
    const p = this.bank.preset(slot);
    const classes = ["slot", p ? "" : "empty", slot === this.current ? "current" : "", p && !p.checksumOk ? "warn" : "",
      this.bank.pending.has(slot) ? "pending" : ""];
    const row = el("button", classes.filter(Boolean).join(" "));
    row.type = "button";
    row.setAttribute("aria-label", `${slotLabel(slot)} ${p ? p.name : "vide"}`);
    const leds = el("span", "leds");
    if (p) {
      for (const key of LED_BLOCKS) {
        const blk = block(key);
        const field = blk.enableField(p.data);
        const on = field !== null && readField(p.data, field) === 1;
        const led = el("span", on ? "led on" : "led");
        led.title = `${blk.label} ${on ? "on" : "off"}`;
        leds.append(led);
      }
    }
    row.append(el("span", "slot-code", slotLabel(slot)), el("span", "slot-name", p ? p.name || "(sans nom)" : "vide"), leds);
    row.insertAdjacentHTML("beforeend", ICONS.chevron);
    row.addEventListener("click", () => this.actions.open(slot));
    onLongPress(row, (x, y) => showMenu({ x, y }, this.slotMenu(slot)));
    return row;
  }

  private slotMenu(slot: number): MenuItem[] {
    const p = this.bank.preset(slot);
    return [
      { label: "Ouvrir", action: () => this.actions.open(slot), disabled: !p },
      { label: "Renommer…", action: () => void this.rename(slot), disabled: !p },
      { label: "Copier", action: () => (this.clipboard = p), disabled: !p },
      { label: "Coller ici", action: () => this.paste(slot), disabled: !this.clipboard },
      { label: "Vider l'emplacement", action: () => this.clear(slot), disabled: !p },
    ];
  }

  private async rename(slot: number): Promise<void> {
    const p = this.bank.preset(slot);
    if (!p) return;
    const name = (await askText(`Nom du preset (${NAME_LEN} caractères max.)`, p.name, NAME_LEN))?.trim();
    if (!name || name === p.name) return;
    try {
      this.bank.setSlots(new Map([[slot, p.withName(name.slice(0, NAME_LEN))]]), `Renommer « ${p.name} »`);
    } catch {
      alert("Utilisez uniquement des caractères ASCII imprimables.");
    }
  }

  private paste(slot: number): void {
    const old = this.bank.preset(slot);
    if (old && !confirm(`Remplacer « ${old.name} » (${slotLabel(slot)}) ? Vous pourrez annuler.`)) return;
    this.bank.setSlots(new Map([[slot, this.clipboard]]), `Coller dans ${slotLabel(slot)}`);
  }

  private clear(slot: number): void {
    const old = this.bank.preset(slot);
    if (old && confirm(`Vider ${slotLabel(slot)} « ${old.name} » ? Vous pourrez annuler.`)) {
      this.bank.setSlots(new Map([[slot, null]]), `Vider ${slotLabel(slot)}`);
    }
  }

  private async search(): Promise<void> {
    const text = (await askText("Rechercher un preset (nom)", "", 40))?.trim().toLowerCase();
    if (!text) return;
    const start = this.bankIndex * PRESETS_PER_BANK;
    for (let i = 1; i <= this.bank.presets.length; i++) {
      const slot = (start + i) % this.bank.presets.length;
      if (this.bank.preset(slot)?.name.toLowerCase().includes(text)) {
        this.showBank(Math.floor(slot / PRESETS_PER_BANK), true);
        this.slots.children[slot % PRESETS_PER_BANK]?.animate?.(
          [{ outline: "2px solid #FFB224" }, { outline: "2px solid transparent" }], { duration: 1200 });
        return;
      }
    }
    alert(`Aucun preset ne contient « ${text} ».`);
  }

  /** Slots a "read this bank" request should cover. */
  get bankSlots(): number[] {
    return [...Array(PRESETS_PER_BANK).keys()].map((i) => this.bankIndex * PRESETS_PER_BANK + i);
  }
}
