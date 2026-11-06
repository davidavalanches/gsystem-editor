/** Application shell: navigation rail, views, file actions, MIDI connection and Live wiring. */

import { emptyPreset } from "../core/empty";
import { describeField, formatField } from "../core/fields";
import { diffFields } from "../core/params";
import { BANK_COUNT, BankStore, PRESETS_PER_BANK, readBankFile, slotLabel } from "../core/bank";
import { GLOBAL_RANGES, MIDI_CHANNEL_PARAM, SYSTEM_BLOCK } from "../core/globals";
import { GSystemLink } from "../core/protocol";
import { SqsFile, USER_BANK_KIND, readSyx } from "../core/sqs";
import { NAME_LEN, USER_PRESET_BASE, USER_SLOTS, sameBytes, type Preset } from "../core/sysex";
import { midiAccess } from "../midi/transport";
import { BanksView } from "./banks";
import { askText, showChecklist, showChoices } from "./dialog";
import { el } from "./dom";
import { loadSession, pickFile, saveFile, storeSession } from "./files";
import { MidiView } from "./midiview";
import { PresetView } from "./preset";
import { SettingsView } from "./settings";
import { SKINS, chooseSkin, currentSkin } from "./skin";
import { ICONS, type MenuItem } from "./widgets";
import { GLOBALS_BASE, PROTECTED_BASE, SESSION_BASE, Units, defaultUnitName, parseSlotLabel, storageKey, type Unit } from "./units";

type ReadMode = "all" | "bank" | "refresh" | "verify" | "revert";
/** A preset to write into the unit, and how many times it was written. */
interface WriteItem {
  slot: number;
  preset: Preset;
  tries: number;
}
/** Writes of one preset before giving up, and the pause before writing it again. */
const WRITE_TRIES = 2;
const RETRY_DELAY_MS = 1000;
/** Damaged slots used to be kept between sessions; they belong to one unit, so they are dropped. */
const CORRUPT_KEY = "gsystem-editor.corrupt";
/** Block 5 parameter of the unit's SysEx ID, which tells units apart. */
const SYSEX_ID_PARAM = 19;
/** Write stored presets into the unit (Vyzor's Sync sequence, checked by reading back). */
const STORE_TO_UNIT = true;
const pad2 = (n: number) => String(n).padStart(2, "0");
type ViewKey = "banks" | "preset" | "settings" | "midi";

export class App {
  private readonly bank = new BankStore();
  private readonly units = new Units();
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
  /** Links whose identity has answered (it is asked several times). */
  private readonly answered = new WeakSet<GSystemLink>();
  /** Set by Connect: once the G-System answers, ask what to read. */
  private readOffer = false;
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
      copyToUnit: (slots) => void this.copyToUnit(slots),
      sendToUnit: (slots) => this.sendToUnit(slots),
      hasOtherUnit: () => this.units.others().length > 0,
      bankMenu: (b) => this.bankMenu(b),
      dropBank: (from, to) => showChoices(`Bank ${pad2(from)} onto bank ${pad2(to)}`, [
        { label: `Swap banks ${pad2(from)} and ${pad2(to)}`, detail: "Exchange their presets (undoable), then Store to write them",
          run: () => void this.bankOperation("swap", from, to) },
        { label: `Copy bank ${pad2(from)} to ${pad2(to)}`, detail: `Replaces the presets of bank ${pad2(to)}`,
          run: () => void this.bankOperation("copy", from, to) },
        { label: "Cancel", detail: "Leave both banks as they are", run: () => {} },
      ]),
      readUnit: () => {
        // Offline, the button connects, then offers to read; when connecting fails the MIDI view says why.
        if (!this.link) this.connectAndOfferRead();
        else if (this.link.busy) this.link.cancel();
        else this.offerRead();
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
        this.units.update(this.units.current, { sysexId: id });
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

  /** At start: connect the G-System, open a bank file, or go on with the last session's bank. */
  private welcome(): void {
    const used = this.bank.presets.filter(Boolean).length;
    showChoices("G-System Editor", [
      { label: "Connect the G-System", detail: "Over USB MIDI: read its banks, edit and play Live",
        run: () => this.connectAndOfferRead() },
      { label: "Open a .sqs file", detail: "A Vyzor bank file (a .syx SysEx dump works too)", run: () => void this.open() },
      used ? { label: "Continue with last session",
        detail: `${this.units.list.length > 1 ? `${this.units.current.name} · ` : ""}“${this.bank.title}”, ${used} presets`, run: () => {} }
        : { label: "Start with an empty bank", detail: "Presets can be read or opened later", run: () => {} },
    ]);
  }

  /** Connects; once the G-System has answered, asks what to read from it. */
  private connectAndOfferRead(): void {
    this.readOffer = true;
    void this.toggleConnection().then(() => {
      if (!this.link) {
        this.readOffer = false;
        this.show("midi");
      }
    });
  }

  /** Read every bank, only the bank shown, or nothing. */
  private offerRead(): void {
    if (!this.link || this.link.busy) return;
    const slots = this.banks.bankSlots;
    const bank = Math.floor(slots[0] / PRESETS_PER_BANK) + 1;
    showChoices("Read the G-System", [
      { label: "Read all banks", detail: "All 40 banks, about 2 min 30 (replaces the bank shown in the editor)",
        run: () => {
          this.startRead("all");
          this.show("banks");
        } },
      { label: `Read bank ${bank}`, detail: `Its ${slots.length} presets, a few seconds`, run: () => this.startRead("bank") },
      { label: "Not now", detail: "Read later with “Read G-System” or from the MIDI view", run: () => {} },
    ]);
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
      { label: "Import banks from a file…", action: () => void this.importFromFile() },
      { label: "Export all banks (.syx)", action: () => void this.exportSyx() },
      { label: "Export all banks (.sqs)…", action: () => void this.exportSqs() },
      { label: "Read this bank from the G-System", action: () => this.startRead("bank"), disabled: !this.link },
      { label: "Swap this bank with…", action: () => void this.bankOperation("swap") },
      { label: "Copy this bank to…", action: () => void this.bankOperation("copy") },
      { label: `Undo${this.bank.undo.undoText ? `: ${this.bank.undo.undoText}` : ""}`,
        action: () => this.bank.undoLast(), disabled: !this.bank.undo.canUndo },
      { label: "Redo", action: () => this.bank.redoLast(), disabled: !this.bank.undo.canRedo },
      { label: `G-System: ${this.units.current.name}…`, action: () => this.chooseUnit() },
      { label: "Appearance…", action: () => this.chooseSkin() },
    ];
  }

  /** The panels' finish, after the G-System's black, grey and red editions. */
  private chooseSkin(): void {
    const now = currentSkin();
    showChoices("Appearance", SKINS.map(([key, label]) => ({
      label, detail: key === now ? "In use" : `Panels in ${label.toLowerCase()} metal`, run: () => chooseSkin(key),
    })));
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
      { label: "Send bank to the G-System", action: on(() => this.sendToUnit(this.bankSlots(b))),
        disabled: !this.bankSlots(b).some((s) => this.bank.preset(s)) },
      ...(this.units.others().length ? [{ label: "Copy bank to the other G-System…",
        action: on(() => void this.copyToUnit([...Array(PRESETS_PER_BANK).keys()].map((i) => b * PRESETS_PER_BANK + i))) }] : []),
      { label: "Clear bank", action: on(() => this.clearBank(b)),
        disabled: ![...Array(PRESETS_PER_BANK).keys()].some((i) => this.bank.preset(b * PRESETS_PER_BANK + i)) },
      this.bank.protectedBanks.has(b)
        ? { label: "Allow writing", action: on(() => this.protectBank(b, false)) }
        : { label: "Protect from writing", action: on(() => this.protectBank(b, true)) },
    ];
  }

  private bankSlots(b: number): number[] {
    return [...Array(PRESETS_PER_BANK).keys()].map((i) => b * PRESETS_PER_BANK + i);
  }

  /**
   * Writes presets to the G-System as they are in the editor, modified or not (e.g. just imported
   * from a backup, to overwrite the unit's). Without a G-System connected they join the Store list.
   */
  private sendToUnit(slots: number[]): void {
    const changes = new Map<number, Preset | null>();
    for (const s of slots) {
      const p = this.bank.preset(s);
      if (p && !this.bank.isProtected(s)) changes.set(s, p);
    }
    const skipped = slots.filter((s) => this.bank.preset(s) && this.bank.isProtected(s));
    if (!changes.size) {
      alert(skipped.length ? "This bank is protected from writing: nothing is sent." : "Nothing to send: the slots are empty.");
      return;
    }
    const list = [...changes].map(([s, p]) => `${slotLabel(s)}  ${p!.name}`);
    if (this.link && !confirm(`Write ${changes.size === 1 ? "this preset" : "these presets"} into “${this.units.current.name}”, `
      + `replacing what it holds there?\n\n${list.join("\n")}`)) return;
    this.writeToUnit(changes);
  }

  /**
   * Takes banks from a .sqs or .syx file into the G-System shown, at the same banks or into the bank
   * shown. The file may come from any G-System (the SysEx ID does not matter). The presets replace
   * the editor's (undoable) and join the Store list.
   */
  private async importFromFile(): Promise<void> {
    const file = await pickFile(".sqs,.SQS,.syx,.SYX");
    if (!file) return;
    let slots: (Preset | null)[];
    try {
      slots = readBankFile(file.name, file.bytes).slots;
    } catch (e) {
      alert(`Cannot open file: ${(e as Error).message}`);
      return;
    }
    const banks = [...Array(BANK_COUNT).keys()].filter((b) => this.bankSlots(b).some((s) => slots[s]));
    if (!banks.length) {
      alert(`${file.name} holds no user preset.`);
      return;
    }
    const shown = this.banks.bankIndex;
    const apply = (picked: number[], into: number | null) => {
      const changes = new Map<number, Preset | null>();
      for (const b of picked) {
        const to = into ?? b;
        this.bankSlots(b).forEach((s, i) => {
          const p = slots[s];
          const dest = to * PRESETS_PER_BANK + i;
          if (p) changes.set(dest, p.withNumber(USER_PRESET_BASE + dest));
        });
      }
      for (const [s, p] of [...changes]) if (sameBytes(this.bank.preset(s)?.data, p?.data)) changes.delete(s);
      const protectedSlots = [...changes.keys()].filter((s) => this.bank.isProtected(s));
      const replaced = [...changes.keys()].filter((s) => this.bank.preset(s)).map((s) => `${slotLabel(s)}  ${this.bank.preset(s)!.name}`);
      if (!changes.size) {
        this.notify("The editor already holds these presets: use “Send bank to the G-System” to write them.");
        return;
      }
      if (replaced.length && !confirm(`${replaced.length} preset(s) of “${this.units.current.name}” will be replaced in the editor `
        + `(undoable), then wait in the Store list:\n\n${replaced.slice(0, 15).join("\n")}`
        + (replaced.length > 15 ? `\n… and ${replaced.length - 15} more` : ""))) return;
      this.bank.setSlots(changes, `Import from ${file.name}`);
      this.bank.markPending([...changes.keys()].filter((s) => !this.bank.isProtected(s)));
      this.banks.showBank(into ?? picked[0]);
      this.notify(`${changes.size} preset(s) imported from ${file.name}: tap “Store (n)” to write them to the G-System`
        + (protectedSlots.length ? ` (${protectedSlots.length} in protected banks stay in the editor only)` : ""), protectedSlots.length > 0);
    };
    showChecklist(`Import from ${file.name}`,
      `Choose the banks to take into “${this.units.current.name}”. The file may come from another G-System.`,
      banks.map((b) => ({
        id: b,
        label: `${pad2(b)}  ${this.bankSlots(b).map((s) => slots[s]?.name ?? "—").join(" · ")}`,
      })),
      [
        { label: `Into bank ${pad2(shown)}`, run: (ids) => {
          if (ids.length !== 1) alert(`Check a single bank to import it into bank ${pad2(shown)}.`);
          else apply(ids, shown);
        } },
        { label: "Into the same banks", primary: true, run: (ids) => apply(ids, null) },
      ]);
  }

  /** Empties the bank's slots in the editor (undoable); they join the list to store. */
  private clearBank(b: number): void {
    const slots = [...Array(PRESETS_PER_BANK).keys()].map((i) => b * PRESETS_PER_BANK + i);
    const names = slots.filter((s) => this.bank.preset(s)).map((s) => `${slotLabel(s)}  ${this.bank.preset(s)!.name}`);
    if (!names.length || !confirm(`Clear bank ${pad2(b)}?\n\n${names.join("\n")}\n\nYou can undo this.`)) return;
    // The unit only takes complete presets: each slot gets an empty one ("Empty", everything off).
    const template = this.bank.template(slots[0]);
    if (!template) return;
    this.bank.setSlots(new Map(slots.map((s) => [s, emptyPreset(this.bank.preset(s) ?? template, s)])), `Clear bank ${pad2(b)}`);
    this.bank.markPending(slots.filter((s) => !this.bank.isProtected(s)));
  }

  /** Protected banks are never written into the G-System (for a faulty memory area). */
  private protectBank(b: number, on: boolean): void {
    if (on) this.bank.protectedBanks.add(b);
    else this.bank.protectedBanks.delete(b);
    try {
      localStorage.setItem(storageKey(PROTECTED_BASE, this.units.current), JSON.stringify([...this.bank.protectedBanks]));
    } catch {
      // Kept for this session only.
    }
    this.banks.refresh();
    const damaged = !on && this.bank.isProtectedBank(b);
    this.notify(on ? `Bank ${pad2(b)} protected: it will not be written to the G-System`
      : damaged ? `Bank ${pad2(b)} stays protected: the G-System reported a damaged slot in it (read it again to check)`
      : `Bank ${pad2(b)} can be written to the G-System again`);
  }

  private async exportBankSyx(b: number): Promise<void> {
    const slots = [...Array(PRESETS_PER_BANK).keys()].map((i) => b * PRESETS_PER_BANK + i);
    try {
      const where = await saveFile(this.exportName("syx", `-bank-${pad2(b)}`), this.bank.exportSyx(slots));
      if (!where) return;
      this.notify(`Bank ${pad2(b)} exported: ${where}`);
    } catch (e) {
      alert(`Export failed: ${(e as Error).message}`);
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
    this.banks.refresh();
  }

  private restore(): void {
    try {
      localStorage.removeItem(CORRUPT_KEY);
    } catch {
      // Nothing stored.
    }
    this.loadUnit(this.units.current);
  }

  /** Show a unit's workspace: its bank, Store list, protected banks and last settings read. */
  private loadUnit(unit: Unit): void {
    this.bank.protectedBanks.clear();
    try {
      for (const b of JSON.parse(localStorage.getItem(storageKey(PROTECTED_BASE, unit)) ?? "[]") as number[]) {
        this.bank.protectedBanks.add(b);
      }
    } catch {
      // No bank protected.
    }
    this.bank.corrupt.clear();
    const session = loadSession(storageKey(SESSION_BASE, unit));
    const presets: (Preset | null)[] = new Array(USER_SLOTS).fill(null);
    if (session) for (const p of readSyx(session.syx)) if (p.userSlot !== null) presets[p.userSlot] = p;
    this.bank.load(presets, session?.title ?? "Empty bank", session?.sqs ? new SqsFile(session.sqs) : null, session?.pending ?? []);
    this.settings.useStorage(storageKey(GLOBALS_BASE, unit));
    this.midiView.sysexId.value = String(unit.sysexId);
    if (this.link) this.link.sysexId = unit.sysexId;
    this.banks.unitName = this.units.list.length > 1 ? unit.name : "";
    this.banks.refresh();
  }

  /** Save the shown workspace now, then show another unit's. */
  private switchUnit(unit: Unit): void {
    if (unit.key === this.units.current.key) return;
    this.saveNow();
    this.units.select(unit);
    this.loadUnit(unit);
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 500);
  }

  private saveNow(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    storeSession({ title: this.bank.title, syx: this.bank.exportSyx(), sqs: this.bank.sqs?.toBytes() ?? null,
      pending: [...this.bank.pending] }, storageKey(SESSION_BASE, this.units.current));
  }

  /** Offline: work on another G-System's workspace, to prepare changes before plugging it in. */
  private chooseUnit(): void {
    const current = this.units.current;
    showChoices("G-System", [
      ...this.units.list.map((u) => ({
        label: u.name,
        detail: `SysEx ID ${u.sysexId}${u.key === current.key ? " · shown now" : ""}`,
        run: () => {
          if (u.key === current.key) return;
          if (this.link) {
            this.notify("Disconnect first: the workspace shown is the connected G-System's", true);
            return;
          }
          this.switchUnit(u);
          this.notify(`Workspace of “${u.name}”`);
        },
      })),
      { label: "Rename this G-System…", detail: `“${current.name}”`, run: () => void this.renameUnit(current) },
    ]);
  }

  private async renameUnit(unit: Unit): Promise<void> {
    const name = (await askText("Name of this G-System (e.g. Master, Slave)", unit.name, 24))?.trim();
    if (!name) return;
    this.units.update(unit, { name });
    if (unit.key === this.units.current.key) {
      this.banks.unitName = this.units.list.length > 1 ? name : "";
      this.banks.refresh();
    }
  }

  /** Copy presets to another G-System's workspace (same or another position); stored there with Store. */
  private async copyToUnit(slots: number[]): Promise<void> {
    const others = this.units.others();
    if (!others.length) return;
    const target = others.length === 1 ? others[0] : await new Promise<Unit | null>((resolve) => {
      showChoices("Copy to which G-System?", [
        ...others.map((u) => ({ label: u.name, detail: `SysEx ID ${u.sysexId}`, run: () => resolve(u) })),
        { label: "Cancel", detail: "Copy nothing", run: () => resolve(null) },
      ]);
    });
    if (!target) return;
    const presets = slots.map((s) => this.bank.preset(s));
    if (presets.every((p) => !p)) return;
    let first: number | null;
    if (slots.length === 1) {
      const answer = await askText(`Copy “${presets[0]!.name}” into “${target.name}”, slot (e.g. 03-2):`, slotLabel(slots[0]), 5);
      if (answer === null) return;
      first = parseSlotLabel(answer, BANK_COUNT, PRESETS_PER_BANK);
    } else {
      const from = Math.floor(slots[0] / PRESETS_PER_BANK);
      const answer = await askText(`Copy bank ${pad2(from)} into “${target.name}”, bank (00–39):`, pad2(from), 2);
      if (answer === null) return;
      const b = Number(answer);
      first = answer.trim() !== "" && Number.isInteger(b) && b >= 0 && b < BANK_COUNT ? b * PRESETS_PER_BANK : null;
    }
    if (first === null) {
      alert(slots.length === 1 ? "Enter a slot such as 03-2." : "Enter a bank number from 00 to 39.");
      return;
    }
    // The other unit's workspace, as stored.
    const other = new BankStore();
    try {
      for (const b of JSON.parse(localStorage.getItem(storageKey(PROTECTED_BASE, target)) ?? "[]") as number[]) {
        other.protectedBanks.add(b);
      }
    } catch {
      // No bank protected.
    }
    const session = loadSession(storageKey(SESSION_BASE, target));
    const loaded: (Preset | null)[] = new Array(USER_SLOTS).fill(null);
    if (session) for (const p of readSyx(session.syx)) if (p.userSlot !== null) loaded[p.userSlot] = p;
    other.load(loaded, session?.title ?? "Empty bank", session?.sqs ? new SqsFile(session.sqs) : null, session?.pending ?? []);
    const dest = presets.map((_, i) => first! + i);
    if (dest.some((s) => other.isProtected(s))) {
      alert(`That bank is protected from writing on “${target.name}”.`);
      return;
    }
    const replaced = dest.filter((s, i) => presets[i] && other.preset(s)).map((s) => `${slotLabel(s)}  ${other.preset(s)!.name}`);
    if (replaced.length && !confirm(`These presets of “${target.name}” will be replaced:\n\n${replaced.join("\n")}\n\n`
      + "This cannot be undone in the editor.")) return;
    const copied: number[] = [];
    presets.forEach((p, i) => {
      if (!p) return;
      other.setDirect(dest[i], p.withNumber(USER_PRESET_BASE + dest[i]));
      copied.push(dest[i]);
    });
    other.markPending(copied);
    storeSession({ title: other.title, syx: other.exportSyx(), sqs: other.sqs?.toBytes() ?? null, pending: [...other.pending] },
      storageKey(SESSION_BASE, target));
    this.notify(`${copied.length} preset(s) copied into “${target.name}” (${copied.map(slotLabel).join(", ")}): `
      + "connect it and tap Store to write them");
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
      if (!where) return;
      this.bank.undo.setClean();
      this.notify(`Bank exported: ${where}`);
    } catch (e) {
      alert(`Export failed: ${(e as Error).message}`);
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
      if (!where) return;
      this.bank.undo.setClean();
      this.notify(`Banks exported: ${where}`);
      this.scheduleSave();
    } catch (e) {
      alert(`Export failed: ${(e as Error).message}`);
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
      link.onIdentity = (version) => this.identifyUnit(link, version, port.name);
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
      let received = 0;
      link.onActivity = () => received++;
      const identified = () => this.link !== link || this.answered.has(link);
      // The unit answers the identity request at once. The first request right after opening
      // the port can be lost (seen on macOS), so it is sent again until an answer comes.
      for (const delay of [0, 600, 1200]) {
        setTimeout(() => {
          if (!identified()) link.identify();
        }, delay);
      }
      setTimeout(() => {
        if (identified()) return;
        this.readOffer = false;
        void (midi.describe?.() ?? Promise.resolve("")).then((ports) => {
          if (identified()) return;
          const heard = received ? `${received} other message(s) received` : "nothing received";
          this.midiView.setStatus("No answer", false,
            `“${port.name}” does not answer like a G-System (${heard}${ports ? `; ${ports}` : ""}).`);
        });
      }, 2500);
    } catch (e) {
      this.midiView.setStatus("MIDI error", false, (e as Error).message);
    }
  }

  /** The identity answered: find out which unit this is (by its SysEx ID), show its workspace, then go on. */
  private identifyUnit(link: GSystemLink, version: string, portName: string): void {
    if (this.answered.has(link)) return; // the identity request is sent again until a first answer
    this.answered.add(link);
    const normal = link.onParam;
    let done = false;
    const finish = (id: number | null) => {
      if (done) return;
      done = true;
      link.onParam = normal;
      if (this.link === link) void this.unitConnected(id, version, portName);
    };
    // Until then, parameter answers belong to a unit not known yet: only its SysEx ID is taken.
    link.onParam = (b, p, v) => {
      if (b === SYSTEM_BLOCK && p === SYSEX_ID_PARAM) finish(v);
    };
    // Addressed to the ID expected, to 0 (as preset requests, which every unit answers) and to all IDs,
    // since the unit's own is not known yet.
    for (const id of new Set([this.sysexId, 0, 0x7f])) link.requestParams(SYSTEM_BLOCK, SYSEX_ID_PARAM, 1, id);
    setTimeout(() => finish(null), 1500);
  }

  private async unitConnected(id: number | null, version: string, portName: string): Promise<void> {
    // Unknown ID: ask rather than guess, so that one unit's presets never go to another.
    if (id === null && this.units.list.length > 1) {
      const picked = await new Promise<Unit | null>((resolve) => showChoices("Which G-System is connected?", [
        ...this.units.list.map((u) => ({ label: u.name, detail: `SysEx ID ${u.sysexId}`, run: () => resolve(u) })),
        { label: "Disconnect", detail: "Its SysEx ID could not be read", run: () => resolve(null) },
      ]));
      if (!picked) {
        if (this.link) void this.toggleConnection();
        return;
      }
      id = picked.sysexId;
    }
    let unit = id === null ? this.units.current : this.units.bySysexId(id);
    let created = false;
    if (!unit) {
      unit = this.units.add(id!, defaultUnitName(id!));
      created = true;
    }
    const switched = unit.key !== this.units.current.key;
    this.switchUnit(unit);
    if (this.link) this.link.sysexId = unit.sysexId;
    // Damaged slots are a state of one unit's memory: whatever was found before belongs to the previous connection.
    if (this.bank.corrupt.size) {
      this.bank.corrupt.clear();
      this.banks.refresh();
    }
    this.setConnected(true, `G-System ${version}`, portName);
    if (switched) this.notify(`“${unit.name}” connected (SysEx ID ${id}): its workspace is shown`);
    // A new unit, or one still under its default name (such as the workspace of earlier versions): name it.
    if (created || unit.name === defaultUnitName(unit.sysexId)) {
      await this.renameUnit(unit);
      if (!this.link) return;
    }
    // Preset recalls need the unit's MIDI channel: read the settings now.
    this.readSettings();
    if (this.readOffer || created) {
      this.readOffer = false;
      this.offerRead();
    }
    const n = this.bank.pending.size;
    if (n) this.notify(`${n} preset(s) modified offline for “${unit.name}”: tap “Store” to write them`);
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
    }
  }

  private get sysexId(): number {
    return this.units.current.sysexId;
  }

  /** Store into the editor's bank and, when connected, into the unit. */
  private store(slot: number, p: Preset): void {
    this.bank.setSlots(new Map([[slot, p]]), `Store “${p.name}”`);
    this.writeToUnit(new Map([[slot, p]]));
  }

  /** Swap the shown bank with another one, or copy it over another one (5 presets each). */
  private async bankOperation(kind: "swap" | "copy", from = this.banks.bankIndex, target?: number): Promise<void> {
    let to = target;
    if (to === undefined) {
      const answer = await askText(kind === "swap" ? `Swap bank ${pad2(from)} with bank (00–39):`
        : `Copy bank ${pad2(from)} to bank (00–39):`, "", 2);
      if (answer === null || answer.trim() === "") return;
      to = Number(answer);
    }
    if (!Number.isInteger(to) || to < 0 || to >= BANK_COUNT || to === from) {
      alert("Enter a bank number from 00 to 39, other than the bank shown.");
      return;
    }
    const written = kind === "swap" ? [from, to] : [to];
    const locked = written.filter((b) => this.bank.isProtectedBank(b));
    if (locked.length) {
      alert(`Bank ${locked.map(pad2).join(" and ")} is protected from writing (bank menu, “Allow writing”).`);
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
    // Written with Store, like the other edits of the bank.
    this.bank.markPending(changes.keys());
  }

  /** The presets waiting to be written into the unit: write them, take them off the list, or re-read the unit's. */
  private syncPending(): void {
    const slots = [...this.bank.pending].sort((a, b) => a - b);
    if (!slots.length) return;
    const offline = !this.link;
    showChecklist(`Presets to store (${slots.length})`,
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
    if (!this.link) return;
    if (this.link.busy) {
      this.notify("The G-System is busy reading or writing: preset not recalled on it", true);
      return;
    }
    const channel = this.settings.rawValue(SYSTEM_BLOCK, MIDI_CHANNEL_PARAM);
    this.recalled = { slot, at: Date.now() };
    // The unit's channel as read; Off, Omni (17) and an unknown channel: channel 1. Over USB the unit
    // follows these messages even with Prg. Change In Off (seen on the user's G-System), so that
    // setting is not checked.
    this.link.selectPreset(slot, channel !== undefined && channel >= 1 && channel <= 16 ? channel : 1);
  }

  private writeQueue: WriteItem[] = [];
  private writeTotal = 0;
  private verifying: WriteItem | null = null;

  /** Write presets into the unit one at a time, each read back before the next. */
  private writeToUnit(changes: Map<number, Preset | null>): void {
    const writable = [...changes].filter(([slot, preset]) => preset && !this.bank.isProtected(slot)).map(([slot]) => slot);
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
    const todo: WriteItem[] = [];
    for (const [slot, preset] of [...changes].sort((a, b) => a[0] - b[0])) {
      if (this.bank.isProtected(slot)) notes.push(`${slotLabel(slot)}: protected bank, not written to the G-System`);
      else if (!preset) notes.push(`${slotLabel(slot)}: the G-System cannot empty a slot, it keeps its previous preset`);
      else todo.push({ slot, preset, tries: 0 });
    }
    // Nothing can be written for an emptied slot: it leaves the list.
    this.bank.dropPending([...changes].filter(([, preset]) => !preset).map(([slot]) => slot));
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
    item.tries++;
    this.link!.store(item.slot, item.preset, () => this.startRead("verify"));
  }

  /** The preset was read back as written: next one, or the end of the writes. */
  private writeDone(item: WriteItem): void {
    this.writeQueue.shift();
    this.bank.clearPending(item.slot);
    if (this.writeQueue.length) {
      this.nextWrite();
      return;
    }
    this.link?.editorModeOff();
    this.notify(this.writeTotal > 1 ? `${this.writeTotal} presets written to the G-System (verified)`
      : `“${item.preset.name}” stored in the G-System (${slotLabel(item.slot)}, verified)`);
  }

  /** Still different after the retries: say what differs, and let the G-System's version be kept. */
  private writeFailed(item: WriteItem, got: Preset | undefined, damaged: boolean): void {
    const left = this.writeQueue.length - 1;
    const where = `“${item.preset.name}” in ${slotLabel(item.slot)}`;
    const tail = (left ? `\n${left} other write(s) cancelled.` : "") + "\nThe presets stay stored in the editor and in the Store list.";
    if (!got) {
      this.writeQueue = [];
      this.link?.editorModeOff();
      alert(`The G-System did not confirm storing ${where}`
        + (damaged ? ": the G-System reports the slot's memory as damaged."
          : ": the slot does not answer (G-System locked up? Switch it off and on again).") + tail);
      return;
    }
    const fields = diffFields(item.preset.data, got.data);
    const nameFlags = item.preset.data.slice(0, NAME_LEN).some((b, i) => b !== got.data[i]);
    let detail: string;
    if (got.name !== item.preset.name && fields.length > 20) {
      // Nothing of the new preset arrived: the unit ignored the write.
      detail = `the slot still holds “${got.name}”: the G-System ignored the write. Check that the SysEx ID in the MIDI view `
        + "matches the G-System's (MIDI menu) and that no other program is using its MIDI port, then try again.";
    } else {
      const lines = fields.slice(0, 8).map(([f]) => {
        const info = describeField(got.data, f);
        return `• ${info.group} · ${info.name}: ${formatField(item.preset.data, f)} → ${formatField(got.data, f)}`;
      });
      if (fields.length > 8) lines.push(`• … and ${fields.length - 8} more`);
      if (nameFlags) lines.unshift(got.name === item.preset.name ? "• Name: internal flags" : `• Name: “${item.preset.name}” → “${got.name}”`);
      detail = `the G-System changed ${lines.length === 1 ? "this value" : "these values"} while storing it:\n${lines.join("\n")}`;
    }
    const keep = confirm(`The preset read back from ${where} is different from the one sent, after ${item.tries} tries: ${detail}`
      + "\n\nOK keeps the G-System's version in the editor (undoable) and goes on; Cancel stops here."
      + tail.replace("\nThe presets", "\nOtherwise the presets"));
    if (!keep) {
      this.writeQueue = [];
      this.link?.editorModeOff();
      return;
    }
    this.bank.setSlots(new Map([[item.slot, got]]), "Keep the G-System's version");
    this.writeDone(item);
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
        this.writeDone(expected);
      } else if (got && expected.tries < WRITE_TRIES && this.link) {
        // A write may be missed (unit busy, MIDI port shared): write it once more. Never for a slot
        // that does not answer or is reported damaged: writing there again may lock the unit up.
        this.notify(`“${expected.preset.name}” (${slotLabel(expected.slot)}) read back different, writing it again…`);
        setTimeout(() => this.link && this.nextWrite(), RETRY_DELAY_MS);
      } else {
        this.writeFailed(expected, got, corrupt.length > 0);
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
