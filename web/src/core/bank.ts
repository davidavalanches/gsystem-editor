/** A 200-slot user bank in memory with undoable edits. */

import { SqsFile, readSyx, writeSyx } from "./sqs";
import { Preset, USER_SLOTS, userNumber } from "./sysex";

export const PRESETS_PER_BANK = 5;
export const BANK_COUNT = USER_SLOTS / PRESETS_PER_BANK;
/** Banks never written into the unit: on the user's G-System, stores there froze it repeatedly and
 * left slots unreadable (probably a faulty flash area). */
export const AVOIDED_BANKS: ReadonlySet<number> = new Set([27, 28, 29]);
export const isAvoided = (slot: number) => AVOIDED_BANKS.has(Math.floor(slot / PRESETS_PER_BANK));

/** User presets are grouped in banks 00-39 of 5 presets (positions 1-5). */
export function bankPosition(slot: number): [number, number] {
  return [Math.floor(slot / PRESETS_PER_BANK), (slot % PRESETS_PER_BANK) + 1];
}

/** Front-panel style location, e.g. "00-1". */
export function slotLabel(slot: number): string {
  const [bank, position] = bankPosition(slot);
  return `${String(bank).padStart(2, "0")}-${position}`;
}

export type Slots = (Preset | null)[];
type Changes = Map<number, Preset | null>;

interface Command {
  text: string;
  before: Changes;
  after: Changes;
}

export class UndoStack {
  private done: Command[] = [];
  private undone: Command[] = [];
  private cleanIndex = 0;
  onChange: (() => void) | null = null;

  push(cmd: Command, apply: (c: Changes) => void): void {
    apply(cmd.after);
    this.done.push(cmd);
    this.undone = [];
    if (this.cleanIndex > this.done.length) this.cleanIndex = -1;
    this.onChange?.();
  }

  undo(apply: (c: Changes) => void): void {
    const cmd = this.done.pop();
    if (!cmd) return;
    apply(cmd.before);
    this.undone.push(cmd);
    this.onChange?.();
  }

  redo(apply: (c: Changes) => void): void {
    const cmd = this.undone.pop();
    if (!cmd) return;
    apply(cmd.after);
    this.done.push(cmd);
    this.onChange?.();
  }

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  get undoText(): string {
    return this.done.at(-1)?.text ?? "";
  }

  get isClean(): boolean {
    return this.cleanIndex === this.done.length;
  }

  setClean(): void {
    this.cleanIndex = this.done.length;
    this.onChange?.();
  }

  clear(): void {
    this.done = [];
    this.undone = [];
    this.cleanIndex = 0;
    this.onChange?.();
  }
}

export class BankStore {
  presets: Slots = new Array(USER_SLOTS).fill(null);
  /** The .sqs file the bank came from, kept so it can be saved back. */
  sqs: SqsFile | null = null;
  title = "New bank";
  readonly undo = new UndoStack();
  /** Called with the slots that changed, or null when the whole bank was replaced. */
  onChange: ((slots: number[] | null) => void) | null = null;

  /** Slots changed in the editor and not yet written into the unit. */
  pending = new Set<number>();
  /** Slots the unit reports as damaged: a state of its memory, kept whatever bank is loaded. */
  corrupt = new Set<number>();

  load(presets: Slots, title: string, sqs: SqsFile | null = null, pending: Iterable<number> = []): void {
    this.presets = [...presets, ...new Array(Math.max(0, USER_SLOTS - presets.length)).fill(null)].slice(0, USER_SLOTS);
    this.sqs = sqs;
    this.title = title;
    this.pending = new Set(pending);
    this.undo.clear();
    this.onChange?.(null);
  }

  /** Load a .sqs or .syx file. Loose dumps without a user number fill the first free slots. */
  loadFile(name: string, bytes: Uint8Array): void {
    if (name.toLowerCase().endsWith(".syx")) {
      const slots: Slots = new Array(USER_SLOTS).fill(null);
      const loose: Preset[] = [];
      for (const p of readSyx(bytes)) {
        if (p.userSlot !== null && !slots[p.userSlot]) slots[p.userSlot] = p;
        else loose.push(p);
      }
      for (const p of loose) {
        const free = slots.indexOf(null);
        if (free < 0) break;
        slots[free] = p;
      }
      this.load(slots, name);
    } else {
      const sqs = new SqsFile(bytes);
      this.load(sqs.userPresets(), name, sqs);
    }
  }

  markPending(slots: Iterable<number>): void {
    const changed = [...slots].filter((s) => !this.pending.has(s));
    changed.forEach((s) => this.pending.add(s));
    if (changed.length) this.onChange?.(changed);
  }

  clearPending(slot: number): void {
    if (this.pending.delete(slot)) this.onChange?.([slot]);
  }

  /** Take slots off the list to write into the unit (their editor version stays). */
  dropPending(slots: Iterable<number>): void {
    const gone = [...slots].filter((s) => this.pending.delete(s));
    if (gone.length) this.onChange?.(gone);
  }

  preset(slot: number): Preset | null {
    return this.presets[slot];
  }

  /** Change slots without undo (used while filling the bank from the unit). */
  setDirect(slot: number, preset: Preset | null): void {
    this.presets[slot] = preset;
    this.onChange?.([slot]);
  }

  setSlots(changes: Changes, text: string): void {
    if (!changes.size) return;
    const before: Changes = new Map([...changes.keys()].map((s) => [s, this.presets[s]]));
    this.undo.push({ text, before, after: changes }, (c) => this.apply(c));
  }

  undoLast(): void {
    this.undo.undo((c) => this.apply(c));
  }

  redoLast(): void {
    this.undo.redo((c) => this.apply(c));
  }

  private apply(changes: Changes): void {
    for (const [slot, preset] of changes) this.presets[slot] = preset;
    this.onChange?.([...changes.keys()]);
  }

  /** The bank as a .syx file, every preset renumbered to its slot. */
  exportSyx(slots?: number[]): Uint8Array {
    const chosen = slots ?? [...this.presets.keys()];
    const presets = chosen.flatMap((s) => (this.presets[s] ? [this.presets[s]!.withNumber(userNumber(s))] : []));
    return writeSyx(presets);
  }

  /** The .sqs file it came from, with the edited slots written back. */
  exportSqs(): Uint8Array | null {
    if (!this.sqs) return null;
    this.presets.forEach((p, slot) => this.sqs!.setUserPreset(slot, p));
    return this.sqs.toBytes();
  }
}
