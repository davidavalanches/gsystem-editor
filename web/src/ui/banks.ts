/** Banks view: the 40 banks on the left, the 5 presets of the chosen bank on the right. */

import { BANK_COUNT, PRESETS_PER_BANK, slotLabel, type BankStore } from "../core/bank";
import { ROUTINGS, presetLevels, presetOutputs, type PresetLevels } from "../core/levels";
import { block, readField } from "../core/params";
import { msToBpm, presetTempoMs } from "../core/tempo";
import { NAME_LEN, type Preset } from "../core/sysex";
import { askText, showChoices } from "./dialog";
import { DESKTOP, el } from "./dom";
import { ICONS, fillDotNumber, iconButton, onLongPress, routingIcon, showMenu, type MenuItem } from "./widgets";

/** The effect blocks, named as on the unit's switches (desktop preset details). */
const STRIP: [string, string][] = [["filter", "FILTER"], ["comp", "COMP"], ["mod", "MOD"], ["pitch", "PITCH"],
  ["delay", "DELAY"], ["reverb", "REVERB"], ["eq", "EQ"], ["gate", "GATE"]];

const DAMAGED = "The G-System reports this slot's memory as damaged (it answers \u201ccorrupt preset\u201d).";

export interface BanksActions {
  open(slot: number): void;
  menu(): MenuItem[];
  /** Actions on a whole bank (read, swap, copy, export). */
  bankMenu(bank: number): MenuItem[];
  readUnit(): void;
  sync(): void;
  /** Desktop: a preset was selected (in Live mode the unit recalls it). */
  select(slot: number): void;
  /** Desktop: a bank was dragged onto another one (offer to swap them). */
  dropBank(from: number, to: number): void;
}

export class BanksView {
  readonly el = el("section", "view");
  bankIndex = 0;
  /** The preset shown in the Preset view, highlighted here. */
  current = 0;
  private clipboard: Preset | null = null;
  private readonly title = el("div", "header-title");
  private readonly sub = el("div");
  private readonly readButton = el("button", "pill primary", "Connect");
  private readonly syncButton = el("button", "pill sync");
  private connected = false;
  private readonly list = el("div", "bank-list");
  private readonly slots = el("div", "slots");
  /** Desktop: every bank at once, and the selected preset's details. */
  private readonly grid = el("div", "bank-grid");
  private readonly detail = el("aside", "bank-detail");
  private bankButtons: HTMLButtonElement[] = [];
  private reading: [number, number] | null = null;

  constructor(private bank: BankStore, private actions: BanksActions, live: HTMLButtonElement) {
    this.readButton.type = "button";
    this.readButton.addEventListener("click", () => actions.readUnit());
    this.syncButton.type = "button";
    this.syncButton.title = "Presets changed in the editor, not yet stored in the G-System: write them (each one verified) or remove them from the list";
    this.syncButton.addEventListener("click", () => actions.sync());
    const titles = el("div", "grow");
    titles.append(this.title, this.sub);
    const more = iconButton(ICONS.more, "More actions: open, export, undo", () => showMenu(more, actions.menu()));
    const header = el("header", "header");
    header.append(titles, iconButton(ICONS.search, "Search for a preset", () => void this.search()),
      this.syncButton, live, this.readButton, more);

    this.list.setAttribute("role", "listbox");
    this.list.setAttribute("aria-label", "Banks");
    for (let b = 0; b < BANK_COUNT; b++) {
      const button = el("button");
      button.type = "button";
      button.setAttribute("role", "option");
      button.addEventListener("click", () => this.showBank(b));
      this.bankButtons.push(button);
      this.list.append(button);
    }
    const body = el("div", "banks-body");
    this.grid.setAttribute("aria-label", "All banks");
    this.detail.setAttribute("aria-label", "Selected preset");
    body.append(this.list, this.slots, this.grid, this.detail);
    this.el.append(header, body);
    DESKTOP.addEventListener("change", () => this.refresh());
    this.refresh();
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    if (!this.reading) this.readButton.textContent = connected ? "Read G-System" : "Connect";
    this.renderHeader();
  }

  /** Reading progress, or null when no read is running. */
  setReading(progress: [number, number] | null): void {
    this.reading = progress;
    this.readButton.textContent = progress ? "Cancel" : this.connected ? "Read G-System" : "Connect";
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
      const locked = this.bank.isProtectedBank(b);
      button.classList.toggle("avoided", locked);
      button.classList.toggle("has-pending",
        [...Array(PRESETS_PER_BANK).keys()].some((i) => this.bank.pending.has(b * PRESETS_PER_BANK + i)));
      button.title = locked ? "Bank protected: not written to the G-System" : "";
      const used = [...Array(PRESETS_PER_BANK).keys()].map((i) => !!this.bank.preset(b * PRESETS_PER_BANK + i));
      const num = el("span", used.some(Boolean) ? "bank-num used" : "bank-num", String(b).padStart(2, "0"));
      const dots = el("span", "fill-dots");
      for (const u of used) dots.append(el("span", u ? "used" : ""));
      button.replaceChildren(num, dots);
      button.setAttribute("aria-label", `Bank ${String(b).padStart(2, "0")}, ${used.filter(Boolean).length} presets`);
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
    this.actions.select(slot);
  }

  private renderGrid(): void {
    this.grid.replaceChildren(...[...Array(BANK_COUNT).keys()].map((b) => {
      const slots = [...Array(PRESETS_PER_BANK).keys()].map((i) => b * PRESETS_PER_BANK + i);
      const used = slots.filter((s) => this.bank.preset(s)).length;
      const cell = el("section", ["bank-cell", used ? "used" : "", this.bank.isProtectedBank(b) ? "avoided" : "",
        b === this.bankIndex ? "current" : ""].filter(Boolean).join(" "));
      cell.setAttribute("aria-label", `Bank ${String(b).padStart(2, "0")}`);
      cell.dataset.bank = String(b);
      const head = el("div", "bank-cell-head");
      head.title = "Click to select the bank; drag it onto another bank to swap them";
      head.addEventListener("pointerdown", (e) => {
        if (e.button === 0 && !(e.target as HTMLElement).closest(".bank-cell-more")) this.dragBank(e, b);
      });
      const more = iconButton(ICONS.more, `Bank ${String(b).padStart(2, "0")} actions`,
        () => showMenu(more, this.actions.bankMenu(b)));
      more.classList.add("bank-cell-more");
      head.append(el("span", "bank-cell-num", String(b).padStart(2, "0")), more);
      cell.append(head, ...slots.map((slot) => {
        const p = this.bank.preset(slot);
        const damaged = this.bank.corrupt.has(slot);
        const button = el("button", ["cell-slot", p ? "" : "empty", slot === this.current ? "selected" : "",
          this.bank.pending.has(slot) ? "pending" : "", damaged ? "corrupt" : ""].filter(Boolean).join(" "));
        button.type = "button";
        button.dataset.slot = String(slot);
        button.setAttribute("aria-label", `${slotLabel(slot)} ${p ? p.name : "empty"}${damaged ? ", damaged on the G-System" : ""}`);
        if (p) {
          button.addEventListener("pointerdown", (e) => {
            if (e.button === 0 && e.pointerType === "mouse") this.dragSlot(e, slot);
          });
        }
        if (damaged) button.title = DAMAGED;
        button.append(el("span", "cell-pos", String((slot % PRESETS_PER_BANK) + 1)),
          el("span", "cell-name", p ? p.name : damaged ? "damaged" : ""));
        onLongPress(button, (x, y) => showMenu({ x, y }, this.slotMenu(slot)));
        button.addEventListener("click", () => this.select(slot));
        button.addEventListener("dblclick", () => this.actions.open(slot));
        return button;
      }));
      return cell;
    }));
  }

  /** Pressing a bank's header selects it; moving onto another bank, still pressed, offers to swap them. */
  private dragBank(down: PointerEvent, from: number): void {
    down.preventDefault();
    if (this.bankIndex !== from) this.showBank(from);
    this.drag(down, {
      source: () => this.grid.querySelector<HTMLElement>(`.bank-cell[data-bank="${from}"]`),
      targetOf: (node) => {
        const b = node.closest<HTMLElement>(".bank-cell[data-bank]")?.dataset.bank;
        return b === undefined || Number(b) === from ? null : Number(b);
      },
      element: (b) => this.grid.querySelector<HTMLElement>(`.bank-cell[data-bank="${b}"]`),
      hint: (b) => `⇄ swap with bank ${String(b).padStart(2, "0")}`,
      drop: (b) => this.actions.dropBank(from, b),
    });
  }

  /** Holding a preset and moving onto another one offers to swap them (a click still selects). */
  private dragSlot(down: PointerEvent, from: number): void {
    this.drag(down, {
      source: () => this.grid.querySelector<HTMLElement>(`.cell-slot[data-slot="${from}"]`),
      targetOf: (node) => {
        const s = node.closest<HTMLElement>(".cell-slot[data-slot]")?.dataset.slot;
        return s === undefined || Number(s) === from ? null : Number(s);
      },
      element: (s) => this.grid.querySelector<HTMLElement>(`.cell-slot[data-slot="${s}"]`),
      hint: (s) => `⇄ swap with ${slotLabel(s)}`,
      drop: (s) => this.dropSlot(from, s),
    });
  }

  /** Drag from a pressed pointer: past a few pixels a copy of the source follows the pointer, the item
   * under it is highlighted, and releasing there calls `drop`. Escape cancels. */
  private drag(down: PointerEvent, o: {
    source: () => HTMLElement | null;
    targetOf: (node: Element) => number | null;
    element: (target: number) => HTMLElement | null;
    hint: (target: number) => string;
    drop: (target: number) => void;
  }): void {
    let ghost: HTMLElement | null = null;
    let source: HTMLElement | null = null;
    let target: number | null = null;
    let dx = 0, dy = 0;
    const setTarget = (t: number | null) => {
      if (t === target) return;
      if (target !== null) o.element(target)?.classList.remove("drop-target");
      target = t;
      if (target !== null) o.element(target)?.classList.add("drop-target");
      if (ghost) ghost.querySelector(".drag-hint")!.textContent = target !== null ? o.hint(target) : "";
    };
    const move = (e: PointerEvent) => {
      if (!ghost) {
        if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < 6) return;
        source = o.source();
        if (!source) return;
        const box = source.getBoundingClientRect();
        dx = down.clientX - box.left;
        dy = down.clientY - box.top;
        ghost = source.cloneNode(true) as HTMLElement;
        ghost.classList.add("drag-ghost");
        ghost.style.width = `${box.width}px`;
        ghost.style.height = `${box.height}px`;
        ghost.append(el("span", "drag-hint"));
        document.body.append(ghost);
        source.classList.add("dragging");
        document.body.classList.add("dragging-item");
      }
      ghost.style.transform = `translate(${e.clientX - dx}px, ${e.clientY - dy}px)`;
      const over = document.elementFromPoint(e.clientX, e.clientY);
      setTarget(over ? o.targetOf(over) : null);
    };
    const end = (drop: boolean) => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", cancel);
      document.removeEventListener("keydown", key);
      const to = target;
      setTarget(null);
      ghost?.remove();
      source?.classList.remove("dragging");
      document.body.classList.remove("dragging-item");
      if (drop && ghost && to !== null) o.drop(to);
    };
    const up = () => end(true);
    const cancel = () => end(false);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") end(false);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", cancel);
    document.addEventListener("keydown", key);
  }

  /** A preset dropped onto another: swap them, or copy it there. */
  private dropSlot(from: number, to: number): void {
    const a = this.bank.preset(from), b = this.bank.preset(to);
    const name = (p: Preset | null, s: number) => `${slotLabel(s)} ${p ? `“${p.name}”` : "(empty)"}`;
    const locked = [from, to].filter((s) => this.bank.isProtected(s));
    if (locked.length) {
      alert(`${locked.map(slotLabel).join(" and ")}: protected bank (bank menu, “Allow writing”).`);
      return;
    }
    showChoices(`${name(a, from)} onto ${name(b, to)}`, [
      { label: `Swap ${slotLabel(from)} and ${slotLabel(to)}`, detail: "Exchange the two presets (undoable), then Store to write them",
        run: () => this.edit(new Map([[from, b], [to, a]]), `Swap ${slotLabel(from)} and ${slotLabel(to)}`) },
      { label: `Copy ${slotLabel(from)} to ${slotLabel(to)}`, detail: b ? `Replaces “${b.name}”` : "Into the empty slot",
        run: () => this.edit(new Map([[to, a]]), `Copy ${slotLabel(from)} to ${slotLabel(to)}`) },
      { label: "Cancel", detail: "Leave both presets as they are", run: () => {} },
    ]);
  }

  private renderDetail(): void {
    const slot = this.current;
    const p = this.bank.preset(slot);
    const [b, position] = [Math.floor(slot / PRESETS_PER_BANK), (slot % PRESETS_PER_BANK) + 1];
    const display = el("div", "detail-display");
    const number = el("div", "dot-number");
    fillDotNumber(number, b, position);
    display.append(number, el("div", "detail-lcd", p ? p.name || "(no name)" : "<EMPTY>"));
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
      fact("Loops", [...lv.loops.flatMap((on, i) => (on ? [`Loop ${i + 1}`] : [])), ...(lv.insert ? ["Insert"] : [])].join(", ") || "none");
      fact("Boost", lv.boost ? `On · ${lv.boostLevel} dB` : `Off · ${lv.boostLevel} dB`);
      fact("Routing", ROUTINGS[lv.routing] ?? String(lv.routing));
      const [left, right] = presetOutputs(p.data);
      fact("Output L", `${left} dB`);
      fact("Output R", `${right} dB`);
      if (ms) fact("Tempo", `${msToBpm(ms)} BPM (${ms} ms)`);
      if (!p.checksumOk) fact("Checksum", "needs fixing");
      if (this.bank.pending.has(slot)) fact("G-System", "to sync");
      if (this.bank.corrupt.has(slot)) fact("G-System", "memory damaged");
      parts.push(blocks, facts);
    } else {
      parts.push(el("p", "detail-empty", this.bank.corrupt.has(slot) ? `Empty slot. ${DAMAGED}` : "Empty slot."));
    }
    const actions = el("div", "detail-actions");
    if (p) {
      const open = el("button", "detail-open", "Open in editor");
      open.type = "button";
      open.addEventListener("click", () => this.actions.open(slot));
      actions.append(open);
    }
    const more = el("div", "detail-more");
    for (const item of this.slotMenu(slot).filter((m) => m.label !== "Open")) {
      const button = el("button", "", item.label.replace(/…$/, ""));
      button.type = "button";
      button.disabled = !!item.disabled;
      button.addEventListener("click", item.action);
      more.append(button);
    }
    actions.append(more);
    parts.push(el("div", "grow"), actions, el("p", "detail-hint", "Double-click: open · long press or right-click: more actions"));
    this.detail.replaceChildren(...parts);
  }

  private renderHeader(): void {
    this.title.textContent = this.bank.title + (this.bank.undo.isClean ? "" : " *");
    const pending = this.bank.pending.size;
    this.syncButton.hidden = !pending;
    this.syncButton.textContent = `Store (${pending})`;
    // Offline too: the list can be looked at and trimmed.
    this.syncButton.disabled = !!this.reading;
    if (this.reading) {
      const [done, total] = this.reading;
      this.sub.className = "reading";
      const bar = el("span", "progress");
      const fill = el("span");
      fill.style.width = `${(done / Math.max(1, total)) * 100}%`;
      bar.append(fill);
      this.sub.replaceChildren(el("b", "", `Reading ${done}/${total}`), bar);
    } else {
      const used = this.bank.presets.filter(Boolean).length;
      const bad = this.bank.presets.filter((p) => p && !p.checksumOk).length;
      this.sub.className = "header-sub";
      this.sub.textContent = `${used} of 200 presets`
        + (pending ? ` · ${pending} to sync with the G-System` : bad ? ` · ${bad} checksum(s) to fix` : "");
    }
  }

  private slotRow(slot: number): HTMLElement {
    const p = this.bank.preset(slot);
    const damaged = this.bank.corrupt.has(slot);
    const classes = ["slot", p ? "" : "empty", slot === this.current ? "current" : "", p && !p.checksumOk ? "warn" : "",
      this.bank.pending.has(slot) ? "pending" : "", damaged ? "corrupt" : ""];
    const row = el("button", classes.filter(Boolean).join(" "));
    row.type = "button";
    row.setAttribute("aria-label", `${slotLabel(slot)} ${p ? p.name : "empty"}${damaged ? ", damaged on the G-System" : ""}`);
    if (damaged) row.title = DAMAGED;
    const lv = p ? presetLevels(p.data) : null;
    // Position and name, with the tempo and routing at the right of the row.
    const head = el("span", "slot-head");
    head.append(el("span", "slot-code", String((slot % PRESETS_PER_BANK) + 1)),
      el("span", "slot-name", p ? p.name || "(no name)" : "empty"));
    // Not yet synced with the G-System: a dot after the name, low like a subscript.
    if (this.bank.pending.has(slot)) head.append(el("span", "slot-pending"));
    if (damaged) head.append(el("span", "slot-corrupt", "damaged"));
    const main = el("span", "slot-main");
    main.append(head);
    row.append(main);
    if (p && lv) row.append(levelsBadge(presetOutputs(p.data), lv), routingBadge(lv.routing, presetTempoMs(p.data)));
    row.addEventListener("click", () => this.actions.open(slot));
    onLongPress(row, (x, y) => showMenu({ x, y }, this.slotMenu(slot)));
    return row;
  }

  private slotMenu(slot: number): MenuItem[] {
    const p = this.bank.preset(slot);
    return [
      { label: "Open", action: () => this.actions.open(slot), disabled: !p },
      { label: "Rename…", action: () => void this.rename(slot), disabled: !p },
      { label: "Copy", action: () => { this.clipboard = p; this.refresh(); }, disabled: !p },
      { label: "Paste here", action: () => this.paste(slot), disabled: !this.clipboard },
      { label: "Clear slot", action: () => this.clear(slot), disabled: !p },
    ];
  }

  private async rename(slot: number): Promise<void> {
    const p = this.bank.preset(slot);
    if (!p) return;
    const name = (await askText(`Preset name (${NAME_LEN} characters max.)`, p.name, NAME_LEN))?.trim();
    if (!name || name === p.name) return;
    try {
      this.edit(new Map([[slot, p.withName(name.slice(0, NAME_LEN))]]), `Rename “${p.name}”`);
    } catch {
      alert("Use printable ASCII characters only.");
    }
  }

  private paste(slot: number): void {
    const old = this.bank.preset(slot);
    if (old && !confirm(`Replace “${old.name}” (${slotLabel(slot)})? You can undo this.`)) return;
    this.edit(new Map([[slot, this.clipboard]]), `Paste into ${slotLabel(slot)}`);
  }

  /** An edit of the editor's bank; the slots join the list to store into the G-System. */
  private edit(changes: Map<number, Preset | null>, text: string): void {
    this.bank.setSlots(changes, text);
    this.bank.markPending([...changes.keys()].filter((s) => !this.bank.isProtected(s)));
  }

  private clear(slot: number): void {
    const old = this.bank.preset(slot);
    if (old && confirm(`Clear ${slotLabel(slot)} “${old.name}”? You can undo this.`)) {
      this.edit(new Map([[slot, null]]), `Clear ${slotLabel(slot)}`);
    }
  }

  private async search(): Promise<void> {
    const text = (await askText("Search for a preset (name)", "", 40))?.trim().toLowerCase();
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
    alert(`No preset contains “${text}”.`);
  }

  /** Slots a "read this bank" request should cover. */
  get bankSlots(): number[] {
    return [...Array(PRESETS_PER_BANK).keys()].map((i) => this.bankIndex * PRESETS_PER_BANK + i);
  }
}

/** Output levels of the routing and, when it is on and above 0 dB, the boost: left of the routing badge. */
function levelsBadge([left, right]: [number, number], lv: PresetLevels): HTMLElement {
  const badge = el("span", "slot-levels");
  const boost = lv.boost && lv.boostLevel > 0;
  badge.title = `Output L ${left} dB · R ${right} dB` + (boost ? ` · boost ${lv.boostLevel} dB` : "");
  const line = (label: string, value: string, cls = "") => {
    const l = el("span", `slot-level ${cls}`.trim());
    l.append(el("span", "slot-level-name", label), el("span", "slot-level-value", value));
    return l;
  };
  badge.append(line("L", `${left} dB`), line("R", `${right} dB`));
  if (boost) badge.append(line("BST", `+${lv.boostLevel} dB`, "boost"));
  return badge;
}

/** Routing and tempo of a preset, at the right of its row. */
function routingBadge(routing: number, tempoMs: number | null): HTMLElement {
  const name = ROUTINGS[routing] ?? `Routing ${routing}`;
  const badge = el("span", "slot-routing");
  badge.title = `Routing: ${name}` + (tempoMs ? ` · tempo ${msToBpm(tempoMs)} BPM (${tempoMs} ms)` : "");
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
