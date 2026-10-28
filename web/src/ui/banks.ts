/** Banks view: the 40 banks on the left, the 5 presets of the chosen bank on the right. */

import { AVOIDED_BANKS, BANK_COUNT, PRESETS_PER_BANK, slotLabel, type BankStore } from "../core/bank";
import { ROUTINGS, presetLevels } from "../core/levels";
import { block, readField } from "../core/params";
import { msToBpm, presetTempoMs } from "../core/tempo";
import { NAME_LEN, type Preset } from "../core/sysex";
import { askText } from "./dialog";
import { DESKTOP, el } from "./dom";
import { ICONS, iconButton, onLongPress, routingIcon, showMenu, type MenuItem } from "./widgets";

/** State strip of a preset row: the effect blocks, named as on the unit's switches. */
const STRIP: [string, string][] = [["filter", "FILTER"], ["comp", "COMP"], ["mod", "MOD"], ["pitch", "PITCH"],
  ["delay", "DELAY"], ["reverb", "REVERB"], ["eq", "EQ"], ["gate", "GATE"]];

export interface BanksActions {
  open(slot: number): void;
  menu(): MenuItem[];
  /** Actions on a whole bank (read, swap, copy, export). */
  bankMenu(bank: number): MenuItem[];
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
  private readonly readButton = el("button", "pill primary", "Connecter");
  private readonly syncButton = el("button", "pill sync");
  private connected = false;
  private readonly list = el("div", "bank-list");
  private readonly slots = el("div", "slots");
  /** Desktop: every bank at once, and the selected preset's details. */
  private readonly grid = el("div", "bank-grid");
  private readonly detail = el("aside", "bank-detail");
  private bankButtons: HTMLButtonElement[] = [];
  private reading: [number, number] | null = null;

  constructor(private bank: BankStore, private actions: BanksActions) {
    this.readButton.type = "button";
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
    this.grid.setAttribute("aria-label", "Toutes les banques");
    this.detail.setAttribute("aria-label", "Preset sélectionné");
    body.append(this.list, this.slots, this.grid, this.detail);
    this.el.append(header, body);
    DESKTOP.addEventListener("change", () => this.refresh());
    this.refresh();
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    if (!this.reading) this.readButton.textContent = connected ? "Lire le G-System" : "Connecter";
    this.renderHeader();
  }

  /** Reading progress, or null when no read is running. */
  setReading(progress: [number, number] | null): void {
    this.reading = progress;
    this.readButton.textContent = progress ? "Annuler" : this.connected ? "Lire le G-System" : "Connecter";
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
    if (DESKTOP.matches) {
      this.renderGrid();
      this.renderDetail();
    }
  }

  /** Desktop: select a preset (its details show on the right); double-click opens it. */
  private select(slot: number): void {
    this.current = slot;
    this.bankIndex = Math.floor(slot / PRESETS_PER_BANK);
    this.refresh();
  }

  private renderGrid(): void {
    this.grid.replaceChildren(...[...Array(BANK_COUNT).keys()].map((b) => {
      const slots = [...Array(PRESETS_PER_BANK).keys()].map((i) => b * PRESETS_PER_BANK + i);
      const used = slots.filter((s) => this.bank.preset(s)).length;
      const cell = el("section", ["bank-cell", used ? "used" : "", AVOIDED_BANKS.has(b) ? "avoided" : "",
        b === this.bankIndex ? "current" : ""].filter(Boolean).join(" "));
      cell.setAttribute("aria-label", `Banque ${String(b).padStart(2, "0")}`);
      const head = el("div", "bank-cell-head");
      const more = iconButton(ICONS.more, `Actions de la banque ${String(b).padStart(2, "0")}`,
        () => showMenu(more, this.actions.bankMenu(b)));
      more.classList.add("bank-cell-more");
      head.append(el("span", "bank-cell-num", String(b).padStart(2, "0")), more);
      cell.append(head, ...slots.map((slot) => {
        const p = this.bank.preset(slot);
        const button = el("button", ["cell-slot", p ? "" : "empty", slot === this.current ? "selected" : "",
          this.bank.pending.has(slot) ? "pending" : ""].filter(Boolean).join(" "));
        button.type = "button";
        button.setAttribute("aria-label", `${slotLabel(slot)} ${p ? p.name : "vide"}`);
        button.append(el("span", "cell-pos", String((slot % PRESETS_PER_BANK) + 1)), el("span", "cell-name", p ? p.name : ""));
        onLongPress(button, (x, y) => showMenu({ x, y }, this.slotMenu(slot)));
        button.addEventListener("click", () => this.select(slot));
        button.addEventListener("dblclick", () => this.actions.open(slot));
        return button;
      }));
      return cell;
    }));
  }

  private renderDetail(): void {
    const slot = this.current;
    const p = this.bank.preset(slot);
    const [b, position] = [Math.floor(slot / PRESETS_PER_BANK), (slot % PRESETS_PER_BANK) + 1];
    const display = el("div", "detail-display");
    const number = el("div", "dot-number");
    number.append(el("span", "bank", String(b).padStart(2, "0")), el("span", "position", String(position)));
    display.append(number, el("div", "detail-lcd", p ? p.name || "(sans nom)" : "<EMPTY>"));
    const parts: HTMLElement[] = [display];
    if (p) {
      const blocks = el("div", "detail-blocks");
      for (const [key, label] of STRIP) {
        const blk = block(key);
        const field = blk.enableField(p.data);
        const on = field !== null && readField(p.data, field) === 1;
        const cell = el("div", on ? "detail-block on" : "detail-block");
        cell.append(el("span", on ? "footswitch on" : "footswitch"), el("span", "detail-code", label),
          el("span", "detail-type", blk.effectType(p.data)?.name ?? (key === "eq" ? "3-band" : "Gate")));
        blocks.append(cell);
      }
      const lv = presetLevels(p.data);
      const ms = presetTempoMs(p.data);
      const facts = el("dl", "detail-facts");
      const fact = (term: string, value: string) => facts.append(el("dt", "", term), el("dd", "", value));
      fact("Loops", [...lv.loops.flatMap((on, i) => (on ? [`Loop ${i + 1}`] : [])), ...(lv.insert ? ["Insert"] : [])].join(", ") || "aucune");
      fact("Boost", lv.boost ? `On · ${lv.boostLevel} dB` : `Off · ${lv.boostLevel} dB`);
      fact("Routing", ROUTINGS[lv.routing] ?? String(lv.routing));
      if (ms) fact("Tempo", `${msToBpm(ms)} BPM (${ms} ms)`);
      fact("Somme de contrôle", p.checksumOk ? "valide" : "à corriger");
      if (this.bank.pending.has(slot)) fact("G-System", "à synchroniser");
      parts.push(blocks, facts);
    } else {
      parts.push(el("p", "detail-empty", "Emplacement vide."));
    }
    const actions = el("div", "detail-actions");
    if (p) {
      const open = el("button", "detail-open", "Ouvrir dans l'éditeur");
      open.type = "button";
      open.addEventListener("click", () => this.actions.open(slot));
      actions.append(open);
    }
    const more = el("div", "detail-more");
    for (const item of this.slotMenu(slot).filter((m) => m.label !== "Ouvrir")) {
      const button = el("button", "", item.label.replace(/…$/, ""));
      button.type = "button";
      button.disabled = !!item.disabled;
      button.addEventListener("click", item.action);
      more.append(button);
    }
    actions.append(more);
    parts.push(el("div", "grow"), actions, el("p", "detail-hint", "Double-clic : ouvrir · appui long ou clic droit : plus d'actions"));
    this.detail.replaceChildren(...parts);
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
    // Only what the preset switches on, as small lit buttons (display only): the effect blocks,
    // then the external loops, insert and boost grouped after them.
    const strip = el("span", "fs-strip");
    const lv = p ? presetLevels(p.data) : null;
    if (p && lv) {
      const lit = (parent: HTMLElement, label: string, title = label) => {
        const chip = el("span", "fs-item");
        chip.title = title;
        chip.append(el("span", "fs-led"), el("span", "fs-label", label));
        parent.append(chip);
      };
      for (const [key, label] of STRIP) {
        const field = block(key).enableField(p.data);
        if (field !== null && readField(p.data, field) === 1) lit(strip, label);
      }
      const loops = el("span", "fs-loops");
      lv.loops.forEach((on, i) => on && lit(loops, `LOOP ${i + 1}`));
      if (lv.insert) lit(loops, "INSERT");
      if (lv.boost) lit(loops, "BOOST", `BOOST ${lv.boostLevel} dB`);
      if (loops.childElementCount) strip.append(loops);
    }
    // Position and name on one line, so the state strip gets the full width of the row.
    const head = el("span", "slot-head");
    head.append(el("span", "slot-code", String((slot % PRESETS_PER_BANK) + 1)),
      el("span", "slot-name", p ? p.name || "(sans nom)" : "vide"));
    // Not yet synced with the G-System: a dot after the name, low like a subscript.
    if (this.bank.pending.has(slot)) head.append(el("span", "slot-pending"));
    const main = el("span", "slot-main");
    main.append(head, strip);
    row.append(main);
    if (p && lv) row.append(routingBadge(lv.routing, presetTempoMs(p.data)));
    row.addEventListener("click", () => this.actions.open(slot));
    onLongPress(row, (x, y) => showMenu({ x, y }, this.slotMenu(slot)));
    return row;
  }

  private slotMenu(slot: number): MenuItem[] {
    const p = this.bank.preset(slot);
    return [
      { label: "Ouvrir", action: () => this.actions.open(slot), disabled: !p },
      { label: "Renommer…", action: () => void this.rename(slot), disabled: !p },
      { label: "Copier", action: () => { this.clipboard = p; this.refresh(); }, disabled: !p },
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
      this.bank.setSlots(new Map([[slot, p.withName(name.slice(0, NAME_LEN))]]), `Renommer « ${p.name} »`);
    } catch {
      alert("Utilisez uniquement des caractères ASCII imprimables.");
    }
  }

  private paste(slot: number): void {
    const old = this.bank.preset(slot);
    if (old && !confirm(`Remplacer « ${old.name} » (${slotLabel(slot)}) ? Vous pourrez annuler.`)) return;
    this.bank.setSlots(new Map([[slot, this.clipboard]]), `Coller dans ${slotLabel(slot)}`);
  }

  private clear(slot: number): void {
    const old = this.bank.preset(slot);
    if (old && confirm(`Vider ${slotLabel(slot)} « ${old.name} » ? Vous pourrez annuler.`)) {
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
    alert(`Aucun preset ne contient « ${text} ».`);
  }

  /** Slots a "read this bank" request should cover. */
  get bankSlots(): number[] {
    return [...Array(PRESETS_PER_BANK).keys()].map((i) => this.bankIndex * PRESETS_PER_BANK + i);
  }
}

/** Routing and tempo of a preset, at the right of its row. */
function routingBadge(routing: number, tempoMs: number | null): HTMLElement {
  const name = ROUTINGS[routing] ?? `Routing ${routing}`;
  const badge = el("span", "slot-routing");
  badge.title = `Routing : ${name}` + (tempoMs ? ` · tempo ${msToBpm(tempoMs)} BPM (${tempoMs} ms)` : "");
  // The tempo first, on a small LCD like the preset name's; the routing below it.
  if (tempoMs) {
    const tempo = el("span", "slot-tempo");
    tempo.append(el("span", "bpm", String(msToBpm(tempoMs))), el("span", "unit", "BPM"));
    badge.append(tempo);
  }
  const routingLine = el("span", "slot-routing-line");
  routingLine.insertAdjacentHTML("afterbegin", routingIcon(routing));
  badge.append(routingLine, el("span", "slot-routing-name", name === "Semi Parallel" ? "Semi Par." : name));
  return badge;
}
