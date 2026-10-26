/** Application shell: modes, file actions, MIDI connection and Live wiring. */

import { BankStore } from "../core/bank";
import { GSystemLink } from "../core/protocol";
import { SqsFile, readSyx } from "../core/sqs";
import { USER_PRESET_BASE, USER_SLOTS, sameBytes, type Preset } from "../core/sysex";
import { midiAccess, type MidiAccess } from "../midi/transport";
import { BanksView } from "./banks";
import { el } from "./dom";
import { PresetEditor } from "./editor";
import { loadSession, pickFile, saveFile, storeSession } from "./files";

type ReadMode = "all" | "selection" | "refresh";

export class App {
  private readonly bank = new BankStore();
  private readonly banks = new BanksView(this.bank);
  private readonly editor = new PresetEditor(this.bank);
  private readonly status = el("div", "status");
  private readonly titleEl = el("span", "title");
  private readonly midiStatus = el("span", "midi-status", "Non connecté");
  private readonly connectButton = el("button", "", "Connecter");
  private readonly readAll = el("button", "", "Lire tout");
  private readonly readSelection = el("button", "", "Lire la sélection");
  private readonly progress = el("progress", "progress");
  private readonly undoButton = el("button", "", "↶");
  private readonly redoButton = el("button", "", "↷");
  private mode: "banks" | "preset" = "banks";
  private midi: MidiAccess = midiAccess();
  private link: GSystemLink | null = null;
  private readMode: ReadMode | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(root: HTMLElement) {
    const modeTabs = el("div", "modes");
    const modeButtons = (["banks", "preset"] as const).map((m) => {
      const b = el("button", m === this.mode ? "mode active" : "mode", m === "banks" ? "Banques" : "Preset");
      b.addEventListener("click", () => this.setMode(m));
      modeTabs.append(b);
      return b;
    });
    this.setMode = (m) => {
      this.mode = m;
      modeButtons.forEach((b, i) => b.classList.toggle("active", ["banks", "preset"][i] === m));
      this.banks.el.hidden = m !== "banks";
      this.editor.el.hidden = m !== "preset";
      this.updateUndo();
    };

    const fileMenu = el("div", "file-actions");
    const action = (label: string, fn: () => void, title = "") => {
      const b = el("button", "", label);
      b.title = title;
      b.addEventListener("click", fn);
      fileMenu.append(b);
      return b;
    };
    action("Ouvrir…", () => void this.open(), "Ouvrir une banque .sqs ou .syx");
    action("Exporter .syx", () => void this.exportSyx(), "Enregistrer la banque au format SysEx");
    this.undoButton.title = "Annuler";
    this.redoButton.title = "Rétablir";
    this.undoButton.addEventListener("click", () => this.undo());
    this.redoButton.addEventListener("click", () => this.redo());
    fileMenu.append(this.undoButton, this.redoButton);

    const midiBar = el("div", "midi-actions");
    this.connectButton.addEventListener("click", () => void this.toggleConnection());
    this.readAll.addEventListener("click", () => this.startRead("all"));
    this.readSelection.addEventListener("click", () => this.startRead("selection"));
    this.readAll.disabled = this.readSelection.disabled = true;
    this.progress.hidden = true;
    midiBar.append(this.midiStatus, this.progress, this.connectButton, this.readAll, this.readSelection);

    const top = el("header", "topbar");
    top.append(modeTabs, this.titleEl, fileMenu, midiBar);
    const main = el("main");
    main.append(this.banks.el, this.editor.el);
    root.append(top, main, this.status);

    this.bank.onChange = (slots) => {
      this.banks.refresh(slots);
      for (const s of slots ?? []) this.editor.reloadIfShowing(s);
      if (!slots) this.editor.openSlot(0);
      this.updateTitle();
      this.scheduleSave();
    };
    this.bank.undo.onChange = () => this.updateUndo();
    this.banks.onOpen = (slot) => {
      this.editor.openSlot(slot);
      this.setMode("preset");
    };
    this.editor.onStore = (slot, preset) => this.bank.setSlots(new Map([[slot, preset]]), `Store « ${preset.name} »`);
    this.editor.onNotice = (text) => this.notify(text);
    this.editor.onChange = () => this.updateUndo();

    document.addEventListener("keydown", (e) => {
      if (!(e.ctrlKey || e.metaKey) || (e.target as HTMLElement).tagName === "INPUT") return;
      if (e.key === "z" && !e.shiftKey) this.undo();
      else if (e.key === "y" || (e.key === "z" && e.shiftKey)) this.redo();
      else return;
      e.preventDefault();
    });

    this.restore();
    this.setMode("banks");
  }

  private setMode: (m: "banks" | "preset") => void;

  // Session and files

  private restore(): void {
    const session = loadSession();
    if (!session) {
      this.updateTitle();
      return;
    }
    const presets: (Preset | null)[] = new Array(USER_SLOTS).fill(null);
    for (const p of readSyx(session.syx)) if (p.userSlot !== null) presets[p.userSlot] = p;
    this.bank.load(presets, session.title, session.sqs ? new SqsFile(session.sqs) : null);
    this.notify("Banque de la session précédente restaurée.");
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      storeSession({ title: this.bank.title, syx: this.bank.exportSyx(), sqs: this.bank.sqs?.toBytes() ?? null });
    }, 500);
  }

  private async open(): Promise<void> {
    const file = await pickFile(".sqs,.SQS,.syx,.SYX");
    if (!file) return;
    try {
      this.bank.loadFile(file.name, file.bytes);
      const used = this.bank.presets.filter(Boolean).length;
      const bad = this.bank.presets.filter((p) => p && !p.checksumOk).length;
      this.notify(`${used} presets chargés${bad ? `, ${bad} avec une somme de contrôle invalide` : ""}`);
    } catch (e) {
      alert(`Ouverture impossible : ${(e as Error).message}`);
    }
  }

  private async exportSyx(): Promise<void> {
    const base = this.bank.title.replace(/\.(sqs|syx)$/i, "").replace(/[^\w\- ]+/g, "_") || "banque";
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    const where = await saveFile(`${base}-${stamp}.syx`, this.bank.exportSyx());
    this.bank.undo.setClean();
    this.notify(`Banque exportée : ${where}`);
  }

  private updateTitle(): void {
    this.titleEl.textContent = this.bank.title + (this.bank.undo.isClean ? "" : " *");
  }

  // Undo

  private undo(): void {
    if (this.mode === "preset") this.editor.undo();
    else this.bank.undoLast();
  }

  private redo(): void {
    if (this.mode === "preset") this.editor.redo();
    else this.bank.redoLast();
  }

  private updateUndo(): void {
    this.updateTitle();
  }

  // MIDI

  private async toggleConnection(): Promise<void> {
    if (this.link) {
      this.link.close();
      this.link = null;
      this.connected(false);
      this.midiStatus.textContent = "Déconnecté";
      return;
    }
    try {
      const ports = await this.midi.listPorts();
      const port = ports.find((p) => /g-system/i.test(p.name)) ?? ports[0];
      if (!port) {
        this.midiStatus.textContent = "Aucun appareil MIDI";
        this.notify("Branchez le G-System en USB (câble OTG sur téléphone), puis réessayez.");
        return;
      }
      const link = new GSystemLink(await this.midi.open(port.id));
      this.link = link;
      link.onIdentity = (version) => {
        this.midiStatus.textContent = `G-System ${version}`;
        this.connected(true);
      };
      link.onActivity = () => this.editor.panel.flashMidi();
      link.onParam = (b, p, v) => this.editor.applyFromUnit(b, p, v);
      link.onPresetSelected = (slot) => this.unitPreset(slot);
      link.onPresetRead = (preset) => {
        if (this.readMode === "all" && preset.userSlot !== null) this.bank.setDirect(preset.userSlot, preset);
      };
      link.onProgress = (done, total) => {
        this.progress.max = total;
        this.progress.value = done;
        if (this.readMode !== "refresh") this.notify(`Lecture du preset ${done}/${total}…`);
      };
      link.onReadFinished = (presets, missing) => this.readFinished(presets, missing);
      this.midiStatus.textContent = `${port.name}…`;
      this.connectButton.textContent = "Déconnecter";
      link.identify();
    } catch (e) {
      this.midiStatus.textContent = "Erreur MIDI";
      alert((e as Error).message);
    }
  }

  private connected(on: boolean): void {
    this.connectButton.textContent = on || this.link ? "Déconnecter" : "Connecter";
    this.readAll.disabled = this.readSelection.disabled = !on;
    this.editor.sendParam = on && this.link ? (b, p, v) => this.link!.sendParam(b, p, v) : null;
    this.editor.setConnected(on);
  }

  private startRead(mode: ReadMode): void {
    if (!this.link) return;
    if (this.link.busy) {
      this.link.cancel();
      return;
    }
    let slots: number[];
    if (mode === "all") {
      if (!this.bank.undo.isClean && !confirm("La banque affichée a des modifications non exportées. Les abandonner ?")) return;
      this.bank.load(new Array(USER_SLOTS).fill(null), `G-System (lu le ${new Date().toLocaleString("fr-FR")})`);
      this.setMode("banks");
      slots = [...Array(USER_SLOTS).keys()];
    } else if (mode === "selection") {
      slots = this.banks.selectedSlots;
    } else {
      slots = [this.editor.slot];
    }
    this.readMode = mode;
    if (mode !== "refresh") {
      this.progress.hidden = false;
      (mode === "all" ? this.readAll : this.readSelection).textContent = "Annuler";
    }
    this.link.readSlots(slots);
  }

  private readFinished(presets: Preset[], missing: number[]): void {
    const mode = this.readMode;
    this.readMode = null;
    this.progress.hidden = true;
    this.readAll.textContent = "Lire tout";
    this.readSelection.textContent = "Lire la sélection";
    if (mode === "all") {
      this.bank.undo.setClean();
      this.notify(`${presets.length} presets lus, ${missing.length} emplacement(s) vide(s). Pensez à exporter la banque.`);
      return;
    }
    const changes = new Map<number, Preset | null>();
    for (const p of presets) if (p.userSlot !== null) changes.set(p.userSlot, p);
    for (const n of missing) changes.set(n - USER_PRESET_BASE, null);
    for (const [s, p] of [...changes]) if (sameBytes(this.bank.preset(s)?.data, p?.data)) changes.delete(s);
    if (mode === "selection") this.notify(`${presets.length} preset(s) lu(s), ${missing.length} emplacement(s) vide(s).`);
    if (!changes.size) {
      if (mode === "selection") this.notify("Les presets lus sont identiques à la banque affichée.");
      return;
    }
    if (mode === "refresh") {
      this.bank.setSlots(changes, "Relu depuis le G-System");
      this.notify("Preset mis à jour depuis le G-System (différent de la banque affichée).");
    } else if (this.banks.confirmOverwrite(changes)) {
      this.bank.setSlots(changes, `Lecture de ${changes.size} emplacement(s) du G-System`);
    }
  }

  /** A preset was recalled on the pedalboard: follow it and re-read it so the editor shows what the unit plays. */
  private unitPreset(slot: number): void {
    if (!this.editor.isLive) return;
    this.editor.followUnit(slot);
    this.banks.select(slot);
    if (this.link && !this.link.busy) this.startRead("refresh");
  }

  private notify(text: string): void {
    this.status.textContent = text;
  }
}
