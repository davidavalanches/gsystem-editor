/** Application shell: navigation rail, views, file actions, MIDI connection and Live wiring. */

import { AVOIDED_BANKS, BANK_COUNT, BankStore, PRESETS_PER_BANK, isAvoided, slotLabel } from "../core/bank";
import { GLOBAL_RANGES, MIDI_CHANNEL_PARAM, SYSTEM_BLOCK } from "../core/globals";
import { DEFAULT_SYSEX_ID, GSystemLink } from "../core/protocol";
import { SqsFile, USER_BANK_KIND, readSyx } from "../core/sqs";
import { USER_PRESET_BASE, USER_SLOTS, sameBytes, type Preset } from "../core/sysex";
import { midiAccess } from "../midi/transport";
import { BanksView } from "./banks";
import { askText, showChecklist, showChoices } from "./dialog";
import { el } from "./dom";
import { loadSession, pickFile, saveFile, storeSession } from "./files";
import { MidiView } from "./midiview";
import { PresetView } from "./preset";
import { SettingsView } from "./settings";
import { ICONS, type MenuItem } from "./widgets";

type ReadMode = "all" | "bank" | "refresh" | "verify" | "revert";
const SYSEX_ID_KEY = "gsystem-editor.sysex-id";
const CORRUPT_KEY = "gsystem-editor.corrupt";
/** Write stored presets into the unit (Vyzor's Sync sequence, checked by reading back). */
const STORE_TO_UNIT = true;
const pad2 = (n: number) => String(n).padStart(2, "0");
type ViewKey = "banks" | "preset" | "settings" | "midi";

export class App {
  private readonly bank = new BankStore();
  private readonly preset = new PresetView(this.bank);
  private readonly banks: BanksView;
  private readonly midiView = new MidiView();
  private readonly settings = new SettingsView();
  private readonly toast = el("div", "toast hidden");
  private readonly railButtons = new Map<ViewKey, HTMLButtonElement>();
  private readonly midiDot = el("span", "midi-dot");
  private view: ViewKey = "banks";
  private link: GSystemLink | null = null;
  private readMode: ReadMode | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  /** The preset last recalled from the editor: the unit's echo of it is not followed. */
  private recalled: { slot: number; at: number } | null = null;
  /** Slots re-read to drop their pending changes. */
  private revertSlots: number[] = [];

  constructor(root: HTMLElement) {
    this.banks = new BanksView(this.bank, {
      open: (slot) => {
        this.preset.openSlot(slot);
        this.show("preset");
      },
      menu: () => this.fileMenu(),
      bankMenu: (b) => this.bankMenu(b),
      readUnit: () => {
        // Offline, the button connects; when that fails the MIDI view says why.
        if (!this.link) void this.toggleConnection().then(() => this.link || this.show("midi"));
        else if (this.link.busy) this.link.cancel();
        else this.startRead("all");
      },
      sync: () => this.syncPending(),
      select: (slot) => {
        if (this.preset.isLive) this.preset.openSlot(slot);
      },
    }, this.preset.liveButton());

    const rail = el("nav", "rail");
    rail.setAttribute("aria-label", "Navigation");
    for (const [key, label, icon] of [["banks", "Banks", ICONS.banks], ["preset", "Preset", ICONS.preset],
      ["settings", "Settings", ICONS.settings], ["midi", "MIDI", ICONS.midi]] as [ViewKey, string, string][]) {
      const b = el("button");
      b.type = "button";
      if (key === "midi") {
        const wrap = el("span", "midi-icon");
        wrap.innerHTML = icon;
        wrap.append(this.midiDot);
        b.append(wrap, label);
      } else {
        b.innerHTML = icon;
        b.append(label);
      }
      b.addEventListener("click", () => this.show(key));
      this.railButtons.set(key, b);
      rail.append(b);
    }
    root.append(rail, this.banks.el, this.preset.el, this.settings.el, this.midiView.el, this.toast);
    this.settings.onRead = () => this.readSettings();
    this.settings.onConnect = () => void this.toggleConnection().then(() => this.link || this.show("midi"));
    this.settings.onSend = (changes) => {
      for (const [b, p, raw] of changes) this.link?.sendParam(b, p, raw);
      setTimeout(() => this.readSettings(), 300);
    };
    this.settings.onNotice = (text) => this.notify(text);
    this.midiView.addCard(this.settings.externalCard("MIDI"));

    this.bank.onChange = (slots) => {
      this.banks.refresh();
      for (const s of slots ?? []) this.preset.reloadIfShowing(s);
      if (!slots) this.preset.openSlot(this.preset.slot);
      this.preset.renderBrowser();
      this.scheduleSave();
    };
    this.bank.undo.onChange = () => this.banks.refresh();
    this.preset.onStore = (slot, p) => this.store(slot, p);
    this.midiView.sysexId.value = String(this.sysexId);
    this.midiView.sysexId.addEventListener("change", () => {
      const id = Number(this.midiView.sysexId.value);
      if (Number.isInteger(id) && id >= 0 && id <= 126) {
        try {
          localStorage.setItem(SYSEX_ID_KEY, String(id));
        } catch {
          // Not persisted; the value still applies to this session.
        }
        if (this.link) this.link.sysexId = id;
      } else {
        this.midiView.sysexId.value = String(this.sysexId);
      }
    });
    this.preset.onNotice = (text) => this.notify(text);
    this.preset.onSelect = (slot) => this.recallOnUnit(slot);
    this.preset.onSlotChange = (slot) => {
      this.banks.current = slot;
      this.banks.showBank(Math.floor(slot / PRESETS_PER_BANK));
    };
    this.midiView.connectButton.addEventListener("click", () => void this.toggleConnection());
    this.midiView.readAllButton.addEventListener("click", () => {
      this.startRead("all");
      this.show("banks");
    });
    this.midiView.readBankButton.addEventListener("click", () => this.startRead("bank"));

    document.addEventListener("keydown", (e) => {
      if (!(e.ctrlKey || e.metaKey) || (e.target as HTMLElement).tagName === "INPUT") return;
      if (e.key === "z" && !e.shiftKey) this.undo();
      else if (e.key === "y" || (e.key === "z" && e.shiftKey)) this.redo();
      else return;
      e.preventDefault();
    });

    this.restore();
    this.show("banks");
    this.welcome();
  }

  /** At start: connect the G-System or open a bank file; closing keeps the last session's bank. */
  private welcome(): void {
    const used = this.bank.presets.filter(Boolean).length;
    showChoices("G-System Editor", used ? `Last session: “${this.bank.title}”, ${used} presets.` : "No bank loaded yet.", [
      { label: "Connect the G-System", detail: "Over USB MIDI: read its banks, edit and play Live", primary: true,
        run: () => void this.toggleConnection().then(() => this.link || this.show("midi")) },
      { label: "Open a .sqs file", detail: "A Vyzor bank file (a .syx SysEx dump works too)", run: () => void this.open() },
    ], used ? "Continue" : "Close");
  }

  private show(view: ViewKey): void {
    this.view = view;
    this.banks.el.hidden = view !== "banks";
    this.preset.el.hidden = view !== "preset";
    this.settings.el.hidden = view !== "settings";
    this.midiView.el.hidden = view !== "midi";
    if (view === "settings" || view === "midi") this.readSettings();
    for (const [key, b] of this.railButtons) {
      if (key === view) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    }
  }

  private fileMenu(): MenuItem[] {
    return [
      { label: "Open a file (.sqs, .syx)…", action: () => void this.open() },
      { label: "Export all banks (.syx)", action: () => void this.exportSyx() },
      { label: "Export all banks (.sqs)…", action: () => void this.exportSqs() },
      { label: "Read this bank from the G-System", action: () => this.startRead("bank"), disabled: !this.link },
      { label: "Swap this bank with…", action: () => void this.bankOperation("swap") },
      { label: "Copy this bank to…", action: () => void this.bankOperation("copy") },
      { label: `Undo${this.bank.undo.undoText ? `: ${this.bank.undo.undoText}` : ""}`,
        action: () => this.bank.undoLast(), disabled: !this.bank.undo.canUndo },
      { label: "Redo", action: () => this.bank.redoLast(), disabled: !this.bank.undo.canRedo },
    ];
  }

  /** The actions of one bank; each first makes it the bank shown. */
  private bankMenu(b: number): MenuItem[] {
    const on = (action: () => void) => () => {
      this.banks.showBank(b);
      action();
    };
    return [
      { label: `Read bank ${pad2(b)} from the G-System`, action: on(() => this.startRead("bank")), disabled: !this.link },
      { label: "Swap with bank…", action: on(() => void this.bankOperation("swap")) },
      { label: "Copy to bank…", action: on(() => void this.bankOperation("copy")) },
      { label: "Export bank (.syx)", action: on(() => void this.exportBankSyx(b)) },
    ];
  }

  private async exportBankSyx(b: number): Promise<void> {
    const slots = [...Array(PRESETS_PER_BANK).keys()].map((i) => b * PRESETS_PER_BANK + i);
    try {
      const where = await saveFile(this.exportName("syx", `-bank-${pad2(b)}`), this.bank.exportSyx(slots));
      this.notify(`Bank ${pad2(b)} exported: ${where}`);
    } catch (e) {
      alert(`Export impossible : ${(e as Error).message}`);
    }
  }

  // Session and files

  /** The unit said which of the slots read are damaged; the others it answered (or left empty) are fine. */
  private updateCorrupt(presets: Preset[], missing: number[], corrupt: number[]): void {
    const before = this.bank.corrupt.size;
    for (const p of presets) if (p.userSlot !== null) this.bank.corrupt.delete(p.userSlot);
    for (const n of missing) this.bank.corrupt.delete(n - USER_PRESET_BASE);
    for (const n of corrupt) this.bank.corrupt.add(n - USER_PRESET_BASE);
    if (!corrupt.length && before === this.bank.corrupt.size) return;
    try {
      localStorage.setItem(CORRUPT_KEY, JSON.stringify([...this.bank.corrupt]));
    } catch {
      // Not kept: the next read finds them again.
    }
    this.banks.refresh();
  }

  private restore(): void {
    try {
      for (const s of JSON.parse(localStorage.getItem(CORRUPT_KEY) ?? "[]") as number[]) this.bank.corrupt.add(s);
    } catch {
      // Nothing known about damaged slots yet.
    }
    const session = loadSession();
    if (!session) return;
    const presets: (Preset | null)[] = new Array(USER_SLOTS).fill(null);
    for (const p of readSyx(session.syx)) if (p.userSlot !== null) presets[p.userSlot] = p;
    this.bank.load(presets, session.title, session.sqs ? new SqsFile(session.sqs) : null, session.pending);
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      storeSession({ title: this.bank.title, syx: this.bank.exportSyx(), sqs: this.bank.sqs?.toBytes() ?? null,
        pending: [...this.bank.pending] });
    }, 500);
  }

  /** True when it is fine to replace the bank (no unsynchronised presets, or the user agrees to drop them). */
  private canReplaceBank(): boolean {
    const n = this.bank.pending.size;
    return !n || confirm(`${n} modified preset(s) not yet written to the G-System. Discard them?`);
  }

  private async open(): Promise<void> {
    if (!this.canReplaceBank()) return;
    const file = await pickFile(".sqs,.SQS,.syx,.SYX");
    if (!file) return;
    try {
      this.bank.loadFile(file.name, file.bytes);
      const used = this.bank.presets.filter(Boolean).length;
      this.notify(`${used} presets loaded from ${file.name}`);
      this.banks.showBank(0);
    } catch (e) {
      alert(`Cannot open file: ${(e as Error).message}`);
    }
  }

  private exportName(ext: string, suffix = ""): string {
    const base = this.bank.title.replace(/\.(sqs|syx)$/i, "").replace(/[^\w\- ]+/g, "_").trim() || "bank";
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    return `${base}${suffix}-${stamp}.${ext}`;
  }

  private async exportSyx(): Promise<void> {
    try {
      const where = await saveFile(this.exportName("syx"), this.bank.exportSyx());
      this.bank.undo.setClean();
      this.notify(`Bank exported: ${where}`);
    } catch (e) {
      alert(`Export impossible : ${(e as Error).message}`);
    }
  }

  /**
   * All 200 user presets as a Vyzor .sqs set. The file is built on an existing .sqs: the one the bank came
   * from, else one the user picks once (its other sections, such as Vyzor's own data, are kept as they are).
   */
  private async exportSqs(): Promise<void> {
    if (!this.bank.sqs) {
      if (!confirm("The bank does not come from an .sqs file. Pick a Vyzor .sqs file to use as a template: "
        + "its 200 presets will be replaced by the bank's; the chosen file is not modified.")) return;
      const file = await pickFile(".sqs,.SQS");
      if (!file) return;
      try {
        const template = new SqsFile(file.bytes);
        template.bank(USER_BANK_KIND);
        this.bank.sqs = template;
      } catch (e) {
        alert(`This file cannot be used as a template: ${(e as Error).message}`);
        return;
      }
    }
    try {
      const where = await saveFile(this.exportName("sqs"), this.bank.exportSqs()!);
      this.bank.undo.setClean();
      this.notify(`Banks exported: ${where}`);
      this.scheduleSave();
    } catch (e) {
      alert(`Export impossible : ${(e as Error).message}`);
    }
  }

  private undo(): void {
    if (this.view === "preset") this.preset.undo();
    else this.bank.undoLast();
  }

  private redo(): void {
    if (this.view === "preset") this.preset.redo();
    else this.bank.redoLast();
  }

  // MIDI

  private async toggleConnection(): Promise<void> {
    if (this.link) {
      this.link.close();
      this.link = null;
      this.setConnected(false, "Disconnected");
      return;
    }
    try {
      const midi = midiAccess();
      const ports = await midi.listPorts();
      const port = ports.find((p) => /g-system/i.test(p.name)) ?? ports[0];
      if (!port) {
        this.midiView.setStatus("No MIDI device", false, "Plug the G-System in over USB (OTG cable on a phone), then try again.");
        return;
      }
      const transport = await midi.open(port.id);
      transport.onLost = () => this.connectionLost(port.name);
      const link = new GSystemLink(transport);
      link.sysexId = this.sysexId;
      this.link = link;
      link.onIdentity = (version) => {
        this.setConnected(true, `G-System ${version}`, port.name);
        const n = this.bank.pending.size;
        if (n) this.notify(`${n} preset(s) modified offline: tap “Sync” to write them to the G-System`);
      };
      link.onParam = (b, p, v) => {
        this.settings.update(b, p, v);
        this.preset.applyFromUnit(b, p, v);
      };
      link.onPresetSelected = (slot) => this.unitPreset(slot);
      link.onPresetRead = (p) => {
        if (this.readMode === "all" && p.userSlot !== null) this.bank.setDirect(p.userSlot, p);
      };
      link.onProgress = (done, total) => {
        if (this.readMode === "all" || this.readMode === "bank") this.banks.setReading([done, total]);
      };
      link.onReadFinished = (presets, missing, corrupt) => this.readFinished(presets, missing, corrupt);
      this.midiView.setStatus(`${port.name}…`, false, "Identifying…");
      link.identify();
      // The unit answers the identity request at once; without an answer it is not a G-System.
      setTimeout(() => {
        if (this.link === link && !this.midiDot.classList.contains("on")) {
          this.midiView.setStatus("No answer", false, `“${port.name}” does not answer like a G-System.`);
        }
      }, 2000);
    } catch (e) {
      this.midiView.setStatus("MIDI error", false, (e as Error).message);
    }
  }

  /** The G-System went away (unplugged, switched off): stop everything that needs it and say so. */
  private connectionLost(name: string): void {
    if (!this.link) return;
    const wasLive = this.preset.isLive;
    const reading = this.readMode === "all" || this.readMode === "bank";
    const unwritten = this.writeQueue.length;
    this.link.close();
    this.link = null;
    this.readMode = null;
    this.writeQueue = [];
    this.verifying = null;
    this.revertSlots = [];
    this.banks.setReading(null);
    this.setConnected(false, "Connection lost", `“${name}” was unplugged or switched off. Plug it back in, then Connect.`);
    this.midiDot.classList.add("lost");
    this.notify(["G-System disconnected", wasLive ? "Live mode off" : "",
      reading ? "reading interrupted: only the presets read so far are in the bank" : "",
      unwritten ? `${unwritten} preset(s) not written, still in the sync list` : ""].filter(Boolean).join(" — "), true);
  }

  /** Ask the unit for its global settings (answers arrive as parameter messages). */
  private readSettings(): void {
    if (!this.link) return;
    for (const [block, first, count] of GLOBAL_RANGES) this.link.requestParams(block, first, count);
  }

  private setConnected(on: boolean, text: string, detail = ""): void {
    this.midiView.setStatus(text, on, detail);
    this.midiDot.classList.toggle("on", on);
    this.midiDot.classList.remove("lost");
    this.banks.setConnected(on);
    this.preset.sendParam = on && this.link ? (b, p, v) => this.link!.sendParam(b, p, v) : null;
    this.preset.setConnected(on);
    this.settings.setConnected(on);
    if (on) {
      this.notify(`${text} connected`);
      if (this.view === "settings") this.readSettings();
    }
  }

  private get sysexId(): number {
    try {
      const saved = Number(localStorage.getItem(SYSEX_ID_KEY));
      return localStorage.getItem(SYSEX_ID_KEY) !== null && Number.isInteger(saved) ? saved : DEFAULT_SYSEX_ID;
    } catch {
      return DEFAULT_SYSEX_ID;
    }
  }

  /** Store into the editor's bank and, when connected, into the unit. */
  private store(slot: number, p: Preset): void {
    this.bank.setSlots(new Map([[slot, p]]), `Store “${p.name}”`);
    this.writeToUnit(new Map([[slot, p]]));
  }

  /** Swap the shown bank with another one, or copy it over another one (5 presets each). */
  private async bankOperation(kind: "swap" | "copy"): Promise<void> {
    const from = this.banks.bankIndex;
    const answer = await askText(kind === "swap" ? `Swap bank ${pad2(from)} with bank (00–39):`
      : `Copy bank ${pad2(from)} to bank (00–39):`, "", 2);
    if (answer === null || answer.trim() === "") return;
    const to = Number(answer);
    if (!Number.isInteger(to) || to < 0 || to >= BANK_COUNT || to === from) {
      alert("Enter a bank number from 00 to 39, other than the bank shown.");
      return;
    }
    const written = kind === "swap" ? [from, to] : [to];
    if (written.some((b) => AVOIDED_BANKS.has(b))) {
      alert("Banks 27 to 29 are excluded: writing to them locks up the G-System.");
      return;
    }
    const changes = new Map<number, Preset | null>();
    for (let i = 0; i < PRESETS_PER_BANK; i++) {
      const a = from * PRESETS_PER_BANK + i, b = to * PRESETS_PER_BANK + i;
      changes.set(b, this.bank.preset(a));
      if (kind === "swap") changes.set(a, this.bank.preset(b));
    }
    if (kind === "copy") {
      const lost = [...changes].filter(([s, p]) => this.bank.preset(s) && !sameBytes(this.bank.preset(s)!.data, p?.data))
        .map(([s]) => `${slotLabel(s)}  ${this.bank.preset(s)!.name}`);
      if (lost.length && !confirm(`These presets of bank ${pad2(to)} will be replaced:\n\n${lost.join("\n")}\n\n`
        + "You can undo this in the editor, but not on the G-System once written.")) return;
    }
    this.bank.setSlots(changes, kind === "swap" ? `Swap banks ${pad2(from)} and ${pad2(to)}`
      : `Copy bank ${pad2(from)} to ${pad2(to)}`);
    this.banks.showBank(to, true);
    this.writeToUnit(changes);
  }

  /** The presets waiting to be written into the unit: write them, take them off the list, or re-read the unit's. */
  private syncPending(): void {
    const slots = [...this.bank.pending].sort((a, b) => a - b);
    if (!slots.length) return;
    const offline = !this.link;
    showChecklist(`Presets to sync (${slots.length})`,
      offline ? "Offline: you can remove presets from the list; writing happens once the G-System is connected."
        : "Write writes the checked presets to the G-System (each one verified). Re-read replaces the editor's version with the G-System's.",
      slots.map((s) => ({ id: s, label: `${slotLabel(s)}  ${this.bank.preset(s)?.name ?? "(empty)"}` })), [
        { label: "Remove from list", run: (ids) => this.dropPending(ids) },
        { label: "Re-read from G-System", disabled: offline, run: (ids) => this.revertPending(ids) },
        { label: "Write to G-System", primary: true, disabled: offline,
          run: (ids) => this.writeToUnit(new Map(ids.map((s) => [s, this.bank.preset(s)] as [number, Preset | null]))) },
      ]);
  }

  private dropPending(slots: number[]): void {
    if (!confirm(`Remove ${slots.length} preset(s) from the list? They stay modified in the editor but will not be written to the G-System.`)) return;
    this.bank.dropPending(slots);
    this.notify(`${slots.length} preset(s) removed from the sync list`);
  }

  /** Drop the editor's changes: read the unit's version of the slots back (undoable). */
  private revertPending(slots: number[]): void {
    if (!this.link || this.link.busy) return;
    this.revertSlots = slots;
    this.startRead("revert");
  }

  /** Recall the preset picked in the editor on the unit (Bank Select + Program Change on its MIDI channel). */
  private recallOnUnit(slot: number): void {
    if (!this.link || this.link.busy) return;
    const channel = this.settings.rawValue(SYSTEM_BLOCK, MIDI_CHANNEL_PARAM);
    this.recalled = { slot, at: Date.now() };
    this.link.selectPreset(slot, channel !== undefined && channel >= 1 && channel <= 16 ? channel : 1);
  }

  private writeQueue: { slot: number; preset: Preset }[] = [];
  private writeTotal = 0;
  private verifying: { slot: number; preset: Preset } | null = null;

  /** Write presets into the unit one at a time, each read back before the next. */
  private writeToUnit(changes: Map<number, Preset | null>): void {
    const writable = [...changes].filter(([slot, preset]) => preset && !isAvoided(slot)).map(([slot]) => slot);
    if (!this.link || !STORE_TO_UNIT) {
      this.bank.markPending(writable);
      this.notify(writable.length
        ? `${writable.length} preset(s) stored in the editor, to sync the next time the G-System is connected`
        : "Stored in the editor's bank");
      return;
    }
    this.bank.markPending(writable);
    if (this.link.busy || this.writeQueue.length) {
      alert("The G-System is busy: the presets are stored in the editor. "
        + "Repeat the operation once the current read or write has finished to write them to the unit.");
      return;
    }
    const notes: string[] = [];
    const todo: { slot: number; preset: Preset }[] = [];
    for (const [slot, preset] of [...changes].sort((a, b) => a[0] - b[0])) {
      if (isAvoided(slot)) notes.push(`${slotLabel(slot)}: excluded bank, not written to the G-System`);
      else if (!preset) notes.push(`${slotLabel(slot)}: the G-System cannot empty a slot, it keeps its previous preset`);
      else todo.push({ slot, preset });
    }
    if (notes.length) alert(notes.join("\n"));
    this.writeQueue = todo;
    this.writeTotal = todo.length;
    this.nextWrite();
  }

  private nextWrite(): void {
    const item = this.writeQueue[0];
    if (!item) return;
    const done = this.writeTotal - this.writeQueue.length;
    this.notify(`Writing “${item.preset.name}” to the G-System (${slotLabel(item.slot)})`
      + (this.writeTotal > 1 ? ` — ${done + 1}/${this.writeTotal}` : "") + "…");
    this.verifying = item;
    this.link!.store(item.slot, item.preset, () => this.startRead("verify"));
  }

  private startRead(mode: ReadMode): void {
    if (!this.link || this.link.busy) return;
    let slots: number[];
    if (mode === "all") {
      if (!this.canReplaceBank()) return;
      if (!this.bank.undo.isClean && !confirm("The bank shown has unexported changes. Discard them?")) return;
      this.bank.load(new Array(USER_SLOTS).fill(null), `G-System (read ${new Date().toLocaleString("en-GB")})`);
      slots = [...Array(USER_SLOTS).keys()];
    } else if (mode === "bank") {
      slots = this.banks.bankSlots;
    } else if (mode === "verify") {
      slots = [this.verifying!.slot];
    } else if (mode === "revert") {
      slots = this.revertSlots;
    } else {
      slots = [this.preset.slot];
    }
    this.readMode = mode;
    if (mode === "all" || mode === "bank") this.banks.setReading([0, slots.length]);
    this.link.readSlots(slots);
  }

  private readFinished(presets: Preset[], missing: number[], corrupt: number[]): void {
    this.updateCorrupt(presets, missing, corrupt);
    const mode = this.readMode;
    this.readMode = null;
    this.banks.setReading(null);
    if (mode === "verify") {
      const expected = this.verifying!;
      this.verifying = null;
      const got = presets[0];
      if (got && sameBytes(got.data, expected.preset.data)) {
        this.writeQueue.shift();
        this.bank.clearPending(expected.slot);
        if (this.writeQueue.length) {
          this.nextWrite();
        } else {
          this.notify(this.writeTotal > 1 ? `${this.writeTotal} presets written to the G-System (verified)`
            : `“${expected.preset.name}” stored in the G-System (${slotLabel(expected.slot)}, verified)`);
        }
      } else {
        const left = this.writeQueue.length - 1;
        this.writeQueue = [];
        alert(`The G-System did not confirm storing “${expected.preset.name}” in ${slotLabel(expected.slot)}`
          + (got ? ": the preset read back is different."
            : corrupt.length ? ": the G-System reports the slot's memory as damaged."
              : ": the slot does not answer (G-System locked up? Switch it off and on again).")
          + (left ? `\n${left} other write(s) cancelled.` : "")
          + "\nThe presets stay stored in the editor and in the “to sync” list.");
      }
      return;
    }
    if (mode === "all") {
      this.bank.undo.setClean();
      this.notify(`${presets.length} presets read, ${missing.length} empty slot(s)`
        + (corrupt.length ? `, ${corrupt.length} damaged (${corrupt.map((n) => slotLabel(n - USER_PRESET_BASE)).join(", ")})` : "")
        + ". Remember to export the bank.", corrupt.length > 0);
      return;
    }
    const changes = new Map<number, Preset | null>();
    for (const p of presets) if (p.userSlot !== null) changes.set(p.userSlot, p);
    for (const n of missing) changes.set(n - USER_PRESET_BASE, null);
    for (const [s, p] of [...changes]) if (sameBytes(this.bank.preset(s)?.data, p?.data)) changes.delete(s);
    // A damaged slot keeps the editor's copy: it may be the only good one left.
    if (mode === "bank") {
      this.notify(`${presets.length} preset(s) read, ${changes.size} different from the bank shown`
        + (corrupt.length ? `, ${corrupt.length} damaged on the G-System (editor copy kept)` : "") + ".", corrupt.length > 0);
    }
    if (mode === "revert") {
      if (changes.size) this.bank.setSlots(changes, "Re-read from the G-System");
      this.bank.dropPending(this.revertSlots);
      this.notify(`${this.revertSlots.length} preset(s) re-read from the G-System, removed from the sync list`);
      this.revertSlots = [];
      return;
    }
    if (!changes.size) return;
    this.bank.setSlots(changes, mode === "refresh" ? "Re-read from the G-System" : "Read a bank from the G-System");
    if (mode === "refresh") this.notify("Preset updated from the G-System (different from the bank shown).");
  }

  /** A preset was recalled on the pedalboard: follow it and re-read it so the editor shows what the unit plays. */
  private unitPreset(slot: number): void {
    const echo = this.recalled?.slot === slot && Date.now() - this.recalled.at < 1500;
    if (echo || !this.preset.isLive) return;
    this.preset.followUnit(slot);
    if (this.link && !this.link.busy) this.startRead("refresh");
  }

  /** A short message at the bottom; a warning stays longer. */
  private notify(text: string, warn = false): void {
    this.toast.textContent = text;
    this.toast.classList.remove("hidden");
    this.toast.classList.toggle("warn", warn);
    this.toast.setAttribute("role", warn ? "alert" : "status");
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.classList.add("hidden"), warn ? 8000 : 2500);
  }
}
