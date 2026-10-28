/** Application shell: navigation rail, views, file actions, MIDI connection and Live wiring. */

import { AVOIDED_BANKS, BANK_COUNT, BankStore, PRESETS_PER_BANK, isAvoided, slotLabel } from "../core/bank";
import { GLOBAL_RANGES } from "../core/globals";
import { DEFAULT_SYSEX_ID, GSystemLink } from "../core/protocol";
import { SqsFile, USER_BANK_KIND, readSyx } from "../core/sqs";
import { USER_PRESET_BASE, USER_SLOTS, sameBytes, type Preset } from "../core/sysex";
import { midiAccess } from "../midi/transport";
import { BanksView } from "./banks";
import { askText } from "./dialog";
import { el } from "./dom";
import { loadSession, pickFile, saveFile, storeSession } from "./files";
import { MidiView } from "./midiview";
import { PresetView } from "./preset";
import { SettingsView } from "./settings";
import { ICONS, type MenuItem } from "./widgets";

type ReadMode = "all" | "bank" | "refresh" | "verify";
const SYSEX_ID_KEY = "gsystem-editor.sysex-id";
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
    });

    const rail = el("nav", "rail");
    rail.setAttribute("aria-label", "Navigation");
    for (const [key, label, icon] of [["banks", "Banques", ICONS.banks], ["preset", "Preset", ICONS.preset],
      ["settings", "Réglages", ICONS.settings], ["midi", "MIDI", ICONS.midi]] as [ViewKey, string, string][]) {
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
  }

  private show(view: ViewKey): void {
    this.view = view;
    this.banks.el.hidden = view !== "banks";
    this.preset.el.hidden = view !== "preset";
    this.settings.el.hidden = view !== "settings";
    this.midiView.el.hidden = view !== "midi";
    if (view === "settings") this.readSettings();
    for (const [key, b] of this.railButtons) {
      if (key === view) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    }
  }

  private fileMenu(): MenuItem[] {
    return [
      { label: "Ouvrir un fichier (.sqs, .syx)…", action: () => void this.open() },
      { label: "Exporter toutes les banques (.syx)", action: () => void this.exportSyx() },
      { label: "Exporter toutes les banques (.sqs)…", action: () => void this.exportSqs() },
      { label: "Lire cette banque du G-System", action: () => this.startRead("bank"), disabled: !this.link },
      { label: "Échanger cette banque avec…", action: () => void this.bankOperation("swap") },
      { label: "Copier cette banque sur…", action: () => void this.bankOperation("copy") },
      { label: `Annuler${this.bank.undo.undoText ? ` : ${this.bank.undo.undoText}` : ""}`,
        action: () => this.bank.undoLast(), disabled: !this.bank.undo.canUndo },
      { label: "Rétablir", action: () => this.bank.redoLast(), disabled: !this.bank.undo.canRedo },
    ];
  }

  /** The actions of one bank; each first makes it the bank shown. */
  private bankMenu(b: number): MenuItem[] {
    const on = (action: () => void) => () => {
      this.banks.showBank(b);
      action();
    };
    return [
      { label: `Lire la banque ${pad2(b)} du G-System`, action: on(() => this.startRead("bank")), disabled: !this.link },
      { label: "Échanger avec la banque…", action: on(() => void this.bankOperation("swap")) },
      { label: "Copier sur la banque…", action: on(() => void this.bankOperation("copy")) },
      { label: "Exporter la banque (.syx)", action: on(() => void this.exportBankSyx(b)) },
    ];
  }

  private async exportBankSyx(b: number): Promise<void> {
    const slots = [...Array(PRESETS_PER_BANK).keys()].map((i) => b * PRESETS_PER_BANK + i);
    try {
      const where = await saveFile(this.exportName("syx", `-banque-${pad2(b)}`), this.bank.exportSyx(slots));
      this.notify(`Banque ${pad2(b)} exportée : ${where}`);
    } catch (e) {
      alert(`Export impossible : ${(e as Error).message}`);
    }
  }

  // Session and files

  private restore(): void {
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
    return !n || confirm(`${n} preset(s) modifié(s) n'ont pas encore été écrits dans le G-System. Les abandonner ?`);
  }

  private async open(): Promise<void> {
    if (!this.canReplaceBank()) return;
    const file = await pickFile(".sqs,.SQS,.syx,.SYX");
    if (!file) return;
    try {
      this.bank.loadFile(file.name, file.bytes);
      const used = this.bank.presets.filter(Boolean).length;
      this.notify(`${used} presets chargés depuis ${file.name}`);
      this.banks.showBank(0);
    } catch (e) {
      alert(`Ouverture impossible : ${(e as Error).message}`);
    }
  }

  private exportName(ext: string, suffix = ""): string {
    const base = this.bank.title.replace(/\.(sqs|syx)$/i, "").replace(/[^\w\- ]+/g, "_").trim() || "banque";
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    return `${base}${suffix}-${stamp}.${ext}`;
  }

  private async exportSyx(): Promise<void> {
    try {
      const where = await saveFile(this.exportName("syx"), this.bank.exportSyx());
      this.bank.undo.setClean();
      this.notify(`Banque exportée : ${where}`);
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
      if (!confirm("La banque ne vient pas d'un fichier .sqs. Choisissez un fichier .sqs de Vyzor qui servira de modèle : "
        + "ses 200 presets seront remplacés par ceux de la banque, le fichier choisi n'est pas modifié.")) return;
      const file = await pickFile(".sqs,.SQS");
      if (!file) return;
      try {
        const template = new SqsFile(file.bytes);
        template.bank(USER_BANK_KIND);
        this.bank.sqs = template;
      } catch (e) {
        alert(`Ce fichier ne peut pas servir de modèle : ${(e as Error).message}`);
        return;
      }
    }
    try {
      const where = await saveFile(this.exportName("sqs"), this.bank.exportSqs()!);
      this.bank.undo.setClean();
      this.notify(`Banques exportées : ${where}`);
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
      this.setConnected(false, "Déconnecté");
      return;
    }
    try {
      const midi = midiAccess();
      const ports = await midi.listPorts();
      const port = ports.find((p) => /g-system/i.test(p.name)) ?? ports[0];
      if (!port) {
        this.midiView.setStatus("Aucun appareil MIDI", false, "Branchez le G-System en USB (câble OTG sur téléphone), puis réessayez.");
        return;
      }
      const link = new GSystemLink(await midi.open(port.id));
      link.sysexId = this.sysexId;
      this.link = link;
      link.onIdentity = (version) => {
        this.setConnected(true, `G-System ${version}`, port.name);
        const n = this.bank.pending.size;
        if (n) this.notify(`${n} preset(s) modifié(s) hors connexion : touchez « Synchroniser » pour les écrire dans le G-System`);
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
      link.onReadFinished = (presets, missing) => this.readFinished(presets, missing);
      this.midiView.setStatus(`${port.name}…`, false, "Identification…");
      link.identify();
      // The unit answers the identity request at once; without an answer it is not a G-System.
      setTimeout(() => {
        if (this.link === link && !this.midiDot.classList.contains("on")) {
          this.midiView.setStatus("Pas de réponse", false, `« ${port.name} » ne répond pas comme un G-System.`);
        }
      }, 2000);
    } catch (e) {
      this.midiView.setStatus("Erreur MIDI", false, (e as Error).message);
    }
  }

  /** Ask the unit for its global settings (answers arrive as parameter messages). */
  private readSettings(): void {
    if (!this.link) return;
    for (const [block, first, count] of GLOBAL_RANGES) this.link.requestParams(block, first, count);
  }

  private setConnected(on: boolean, text: string, detail = ""): void {
    this.midiView.setStatus(text, on, detail);
    this.midiDot.classList.toggle("on", on);
    this.banks.setConnected(on);
    this.preset.sendParam = on && this.link ? (b, p, v) => this.link!.sendParam(b, p, v) : null;
    this.preset.setConnected(on);
    this.settings.setConnected(on);
    if (on) {
      this.notify(`${text} connecté`);
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
    this.bank.setSlots(new Map([[slot, p]]), `Store « ${p.name} »`);
    this.writeToUnit(new Map([[slot, p]]));
  }

  /** Swap the shown bank with another one, or copy it over another one (5 presets each). */
  private async bankOperation(kind: "swap" | "copy"): Promise<void> {
    const from = this.banks.bankIndex;
    const answer = await askText(kind === "swap" ? `Échanger la banque ${pad2(from)} avec la banque (00–39) :`
      : `Copier la banque ${pad2(from)} sur la banque (00–39) :`, "", 2);
    if (answer === null || answer.trim() === "") return;
    const to = Number(answer);
    if (!Number.isInteger(to) || to < 0 || to >= BANK_COUNT || to === from) {
      alert("Indiquez un numéro de banque entre 00 et 39, différent de la banque affichée.");
      return;
    }
    const written = kind === "swap" ? [from, to] : [to];
    if (written.some((b) => AVOIDED_BANKS.has(b))) {
      alert("Les banques 27 à 29 sont exclues : écrire dedans bloque le G-System.");
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
      if (lost.length && !confirm(`Ces presets de la banque ${pad2(to)} vont être remplacés :\n\n${lost.join("\n")}\n\n`
        + "Vous pourrez annuler dans l'éditeur, mais pas dans le G-System une fois écrits.")) return;
    }
    this.bank.setSlots(changes, kind === "swap" ? `Échanger les banques ${pad2(from)} et ${pad2(to)}`
      : `Copier la banque ${pad2(from)} sur ${pad2(to)}`);
    this.banks.showBank(to, true);
    this.writeToUnit(changes);
  }

  /** Write the presets changed while disconnected. */
  private syncPending(): void {
    const changes = new Map([...this.bank.pending].sort((a, b) => a - b).map((s) => [s, this.bank.preset(s)] as [number, Preset | null]));
    this.writeToUnit(changes);
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
        ? `${writable.length} preset(s) enregistré(s) dans l'éditeur, à synchroniser au prochain branchement du G-System`
        : "Enregistré dans la banque de l'éditeur");
      return;
    }
    this.bank.markPending(writable);
    if (this.link.busy || this.writeQueue.length) {
      alert("Le G-System est occupé : les presets sont enregistrés dans l'éditeur. "
        + "Refaites l'opération une fois la lecture ou l'écriture en cours terminée pour les écrire dans le pédalier.");
      return;
    }
    const notes: string[] = [];
    const todo: { slot: number; preset: Preset }[] = [];
    for (const [slot, preset] of [...changes].sort((a, b) => a[0] - b[0])) {
      if (isAvoided(slot)) notes.push(`${slotLabel(slot)} : banque exclue, non écrit dans le G-System`);
      else if (!preset) notes.push(`${slotLabel(slot)} : le G-System ne permet pas de vider un emplacement, il garde son ancien preset`);
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
    this.notify(`Écriture de « ${item.preset.name} » dans le G-System (${slotLabel(item.slot)})`
      + (this.writeTotal > 1 ? ` — ${done + 1}/${this.writeTotal}` : "") + "…");
    this.verifying = item;
    this.link!.store(item.slot, item.preset, () => this.startRead("verify"));
  }

  private startRead(mode: ReadMode): void {
    if (!this.link || this.link.busy) return;
    let slots: number[];
    if (mode === "all") {
      if (!this.canReplaceBank()) return;
      if (!this.bank.undo.isClean && !confirm("La banque affichée a des modifications non exportées. Les abandonner ?")) return;
      this.bank.load(new Array(USER_SLOTS).fill(null), `G-System (lu le ${new Date().toLocaleString("fr-FR")})`);
      slots = [...Array(USER_SLOTS).keys()];
    } else if (mode === "bank") {
      slots = this.banks.bankSlots;
    } else if (mode === "verify") {
      slots = [this.verifying!.slot];
    } else {
      slots = [this.preset.slot];
    }
    this.readMode = mode;
    if (mode === "all" || mode === "bank") this.banks.setReading([0, slots.length]);
    this.link.readSlots(slots);
  }

  private readFinished(presets: Preset[], missing: number[]): void {
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
          this.notify(this.writeTotal > 1 ? `${this.writeTotal} presets écrits dans le G-System (vérifiés)`
            : `« ${expected.preset.name} » enregistré dans le G-System (${slotLabel(expected.slot)}, vérifié)`);
        }
      } else {
        const left = this.writeQueue.length - 1;
        this.writeQueue = [];
        alert(`Le G-System n'a pas confirmé l'enregistrement de « ${expected.preset.name} » en ${slotLabel(expected.slot)}`
          + (got ? " : le preset relu est différent." : " : l'emplacement ne répond pas (G-System bloqué ? éteignez-le et rallumez-le).")
          + (left ? `\n${left} autre(s) écriture(s) annulée(s).` : "")
          + "\nLes presets restent enregistrés dans l'éditeur et dans la liste « à synchroniser ».");
      }
      return;
    }
    if (mode === "all") {
      this.bank.undo.setClean();
      this.notify(`${presets.length} presets lus, ${missing.length} emplacement(s) vide(s). Pensez à exporter la banque.`);
      return;
    }
    const changes = new Map<number, Preset | null>();
    for (const p of presets) if (p.userSlot !== null) changes.set(p.userSlot, p);
    for (const n of missing) changes.set(n - USER_PRESET_BASE, null);
    for (const [s, p] of [...changes]) if (sameBytes(this.bank.preset(s)?.data, p?.data)) changes.delete(s);
    if (mode === "bank") this.notify(`${presets.length} preset(s) lu(s), ${changes.size} différent(s) de la banque affichée.`);
    if (!changes.size) return;
    this.bank.setSlots(changes, mode === "refresh" ? "Relu depuis le G-System" : "Lecture d'une banque du G-System");
    if (mode === "refresh") this.notify("Preset mis à jour depuis le G-System (différent de la banque affichée).");
  }

  /** A preset was recalled on the pedalboard: follow it and re-read it so the editor shows what the unit plays. */
  private unitPreset(slot: number): void {
    if (!this.preset.isLive) return;
    this.preset.followUnit(slot);
    if (this.link && !this.link.busy) this.startRead("refresh");
  }

  private notify(text: string): void {
    this.toast.textContent = text;
    this.toast.classList.remove("hidden");
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.classList.add("hidden"), 2500);
  }
}
