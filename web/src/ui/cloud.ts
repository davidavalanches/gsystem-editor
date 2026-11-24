/**
 * Online backup of each G-System's session on Dropbox, by hand or automatically while the editor runs.
 * A session is what the editor keeps for one G-System (bank and presets waiting to be written, settings
 * read and changes not sent, protected banks, favorites, loop names, finish) plus the preset being
 * edited and not stored. It is one file per SysEx ID, the way units are told apart.
 *
 * Several devices may save the same G-System: each upload names the revision it replaces, so a session
 * saved meanwhile elsewhere is never overwritten without asking.
 */

import { Capacitor } from "@capacitor/core";
import { Dropbox, DropboxError, type CloudFile } from "../cloud/dropbox";
import { askText, showChoices } from "./dialog";
import { openUrl } from "./quit";
import type { Unit } from "./units";

export const CLOUD_FORMAT = 1;

/** A G-System's session as saved online. */
export interface CloudSession {
  format: number;
  /** Version of the editor that saved it. */
  app: string;
  savedAt: string;
  /** Where it was saved ("Android app", "Linux desktop app"…). */
  device: string;
  sysexId: number;
  unitName: string;
  /** The workspace's stored values, by storage base (see App.cloudContent). */
  storage: Record<string, string>;
  /** A preset modified in the editor and not stored: its slot and its dump in base64. */
  draft: { slot: number; syx: string } | null;
}

/** What changes from one save to the next. */
export type SessionContent = Pick<CloudSession, "sysexId" | "unitName" | "storage" | "draft">;

export interface CloudHost {
  unit(): Unit;
  units(): readonly Unit[];
  /** The workspace shown, as it would be saved now. */
  content(): SessionContent;
  /** Show a saved session, in its G-System's workspace (made when the editor does not know it yet). */
  apply(session: CloudSession): void;
  /** Why a session cannot be shown now (an exchange with the G-System is under way), or null. */
  busy(): string | null;
  notify(text: string, warn?: boolean): void;
}

/** The revision this device last saved or restored for a G-System, and what it held. */
interface SyncState {
  path: string;
  rev: string;
  hash: string;
}

const STATE_BASE = "gsystem-editor.cloud";
const AUTO_KEY = "gsystem-editor.cloud-auto";
/** Automatic backup: how often the session is compared with the one saved. */
const AUTO_EVERY_MS = 20_000;
const FILE_PATTERN = /^gsystem-id-(\d+)\.json$/i;

export const sessionPath = (sysexId: number) => `/gsystem-id-${sysexId}.json`;

/** A short fingerprint of a session's content (53-bit cyrb53), to save only what changed. */
export function sessionHash(content: SessionContent): string {
  const text = JSON.stringify(content);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function parseSession(text: string): CloudSession {
  const s = JSON.parse(text) as CloudSession;
  if (!s || s.format !== CLOUD_FORMAT || !Number.isInteger(s.sysexId) || s.sysexId < 0 || s.sysexId > 126
    || typeof s.storage !== "object" || s.storage === null) {
    throw new Error("not a G-System Editor session (or saved by a newer version)");
  }
  return s;
}

function deviceName(): string {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  const kind = Capacitor.getPlatform() === "android" ? "app" : ua.includes("Electron") ? "desktop app" : "browser";
  return os ? `${os} ${kind}` : kind;
}

const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class CloudSync {
  readonly dropbox = new Dropbox();
  private auto = false;
  /** The upload under way: one at a time. */
  private saving: Promise<void> | null = null;
  /** G-Systems (unit keys) whose online session changed elsewhere and waits for the user: not saved meanwhile. */
  private readonly held = new Set<string>();
  /** Automatic backup is failing (offline…): said once, until it works again. */
  private failing = false;

  constructor(private readonly host: CloudHost) {
    try {
      this.auto = localStorage.getItem(AUTO_KEY) === "1";
    } catch {
      // Off.
    }
    setInterval(() => void this.autoSave(), AUTO_EVERY_MS);
    // Android may close an app left in the background: what is there is saved when it goes.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") void this.autoSave();
    });
  }

  /** This build has a Dropbox app key: backup is offered. */
  get available(): boolean {
    return this.dropbox.configured;
  }

  get autoOn(): boolean {
    return this.auto && this.dropbox.linked;
  }

  get menuLabel(): string {
    return !this.dropbox.linked ? "Back up to Dropbox…" : this.auto ? "Dropbox: automatic backup…" : "Dropbox…";
  }

  /** At start and after showing another G-System: was its session saved meanwhile from another device? */
  async check(): Promise<void> {
    if (!this.autoOn) return;
    const unit = this.host.unit();
    const path = sessionPath(unit.sysexId);
    try {
      const file = await this.dropbox.metadata(path);
      const state = this.state(unit);
      if (!file || unit !== this.host.unit() || (state?.path === path && state.rev === file.rev)) return;
      this.decide(unit, file, null);
    } catch (e) {
      this.failed(e, false);
    }
  }

  autoSave(): Promise<void> {
    return this.autoOn ? this.save(false) : Promise.resolve();
  }

  /** Before quitting or showing another G-System: the session as it is now, waited for at most timeoutMs. */
  flush(timeoutMs = 5000): Promise<void> {
    if (!this.autoOn) return Promise.resolve();
    return Promise.race([this.save(false), new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
  }

  /** The menu entry: link Dropbox, or save, restore, automatic backup, unlink. */
  open(): void {
    if (!this.dropbox.linked) {
      void this.link();
      return;
    }
    const unit = this.host.unit();
    const account = this.dropbox.account;
    showChoices(`Dropbox${account ? ` · ${account}` : ""}`, [
      { label: "Save this session now",
        detail: `${unit.name}: bank, presets to write, settings, favorites and the preset being edited`,
        run: () => void this.save(true) },
      { label: "Restore a session…", detail: "One of the sessions saved on Dropbox, one per G-System", run: () => void this.chooseRestore() },
      this.auto
        ? { label: "Turn automatic backup off", detail: "Now on: every change is saved within 20 s and when leaving the app",
          run: () => this.setAuto(false) }
        : { label: "Turn automatic backup on", detail: "Keeps each G-System's session up to date on Dropbox while the editor runs",
          run: () => this.setAuto(true) },
      { label: "Unlink Dropbox", detail: "On this device; the sessions saved stay in Dropbox (folder Apps)", run: () => void this.unlink() },
    ]);
  }

  /** Save the session shown: by hand always, automatically only when it changed. Never throws. */
  async save(byHand: boolean): Promise<void> {
    // Taken at once, before any wait: the editor may show another G-System by the time it uploads.
    const unit = this.host.unit();
    if (!byHand && this.held.has(unit.key)) return;
    const content = this.host.content();
    const hash = sessionHash(content);
    const path = sessionPath(content.sysexId);
    if (this.saving) {
      if (!byHand) return;
      await this.saving;
    }
    const state = this.state(unit);
    if (!byHand && state?.path === path && state.hash === hash) return;
    const run = this.upload(unit, content, hash, state?.path === path ? { replaces: state.rev } : "create", byHand);
    this.saving = run;
    try {
      await run;
    } finally {
      if (this.saving === run) this.saving = null;
    }
  }

  private async upload(unit: Unit, content: SessionContent, hash: string, mode: { replaces: string } | "create" | "overwrite",
    byHand: boolean): Promise<void> {
    const path = sessionPath(content.sysexId);
    const session: CloudSession = { format: CLOUD_FORMAT, app: __APP_VERSION__, savedAt: new Date().toISOString(),
      device: deviceName(), ...content };
    try {
      const file = await this.dropbox.upload(path, JSON.stringify(session), mode);
      this.setState(unit, { path, rev: file.rev, hash });
      this.held.delete(unit.key);
      this.failing = false;
      if (byHand) this.host.notify(`Session saved on Dropbox (${unit.name})`);
    } catch (e) {
      if (e instanceof DropboxError && e.conflict) {
        const file = await this.dropbox.metadata(path).catch(() => null);
        if (file) {
          this.decide(unit, file, content);
          return;
        }
      }
      this.failed(e, byHand);
    }
  }

  /** The session online was saved by another device: restore it, replace it, or leave both as they are. */
  private decide(unit: Unit, file: CloudFile, content: SessionContent | null): void {
    this.held.add(unit.key);
    showChoices(`${unit.name}: another session is on Dropbox`, [
      { label: "Restore the Dropbox session", detail: `Saved ${when(file.modified)}: replaces this device's bank, settings and changes`,
        run: () => void this.restore(file) },
      { label: "Keep this device's session", detail: "Saves it on Dropbox in place of the other one",
        run: () => {
          const kept = content ?? (unit.key === this.host.unit().key ? this.host.content() : null);
          if (kept) void this.upload(unit, kept, sessionHash(kept), "overwrite", true);
        } },
      { label: "Decide later", detail: "Until then this G-System is not backed up (Dropbox… in the menu)", run: () => {} },
    ]);
  }

  private async chooseRestore(): Promise<void> {
    let files: CloudFile[];
    try {
      files = (await this.dropbox.list()).filter((f) => FILE_PATTERN.test(f.name));
    } catch (e) {
      this.failed(e, true);
      return;
    }
    if (!files.length) {
      this.host.notify("No session on Dropbox yet");
      return;
    }
    const id = (f: CloudFile) => Number(FILE_PATTERN.exec(f.name)![1]);
    files.sort((a, b) => id(a) - id(b));
    showChoices("Restore a session", files.map((f) => {
      const unit = this.host.units().find((u) => u.sysexId === id(f));
      return { label: unit?.name ?? `G-System (ID ${id(f)})`, detail: `SysEx ID ${id(f)} · saved ${when(f.modified)}`,
        run: () => void this.restore(f, true) };
    }));
  }

  /** Download a session and show it, after asking when the user picked it from the list. */
  private async restore(file: CloudFile, confirmFirst = false): Promise<void> {
    let session: CloudSession;
    try {
      session = parseSession(await this.dropbox.download(file.path));
    } catch (e) {
      this.failed(e, true);
      return;
    }
    const apply = () => {
      const why = this.host.busy();
      if (why) {
        this.host.notify(why, true);
        return;
      }
      this.host.apply(session);
      const unit = this.host.unit();
      this.held.delete(unit.key);
      this.setState(unit, { path: sessionPath(session.sysexId), rev: file.rev, hash: sessionHash(this.host.content()) });
      this.host.notify(`Session restored (saved ${when(session.savedAt)})`);
    };
    if (!confirmFirst) return apply();
    const known = this.host.units().find((u) => u.sysexId === session.sysexId);
    showChoices(`Restore ${known?.name ?? session.unitName}?`, [
      { label: "Restore", detail: `Saved ${when(session.savedAt)} on ${session.device}${known ? ": replaces this device's bank, settings and changes"
        : ": a new G-System for the editor"}`, run: apply },
      { label: "Cancel", detail: "Leave the editor as it is", run: () => {} },
    ]);
  }

  private async link(): Promise<void> {
    const url = await this.dropbox.authorizeUrl();
    showChoices("Back up to Dropbox", [
      { label: "Open Dropbox", detail: "Allow G-System Editor there (it only sees its own folder), then copy the code Dropbox shows",
        run: () => {
          openUrl(url);
          void this.finishLink();
        } },
      { label: "Cancel", detail: "Sessions stay on this device only", run: () => {} },
    ]);
  }

  private async finishLink(): Promise<void> {
    const code = await askText("Paste the code Dropbox shows", "", 200);
    if (!code?.trim()) return;
    let name: string;
    try {
      name = await this.dropbox.finishLink(code);
    } catch (e) {
      this.host.notify(`Dropbox not linked: ${message(e)}`, true);
      return;
    }
    showChoices(`Dropbox linked${name ? `: ${name}` : ""}`, [
      { label: "Back up automatically", detail: "Each G-System's session is kept up to date on Dropbox while the editor runs",
        run: () => this.setAuto(true) },
      { label: "Back up by hand only", detail: "Save and restore from Dropbox… in the menu", run: () => this.setAuto(false) },
    ]);
  }

  private async unlink(): Promise<void> {
    await this.dropbox.unlink();
    this.held.clear();
    this.host.notify("Dropbox unlinked from this device");
  }

  private setAuto(on: boolean): void {
    this.auto = on;
    try {
      localStorage.setItem(AUTO_KEY, on ? "1" : "0");
    } catch {
      // For this session only.
    }
    this.host.notify(on ? "Automatic backup on Dropbox: on" : "Automatic backup on Dropbox: off");
    // A session saved elsewhere is offered first, then this one goes online.
    if (on) void this.check().then(() => this.autoSave());
  }

  private failed(e: unknown, byHand: boolean): void {
    if (byHand) this.host.notify(message(e), true);
    else if (!this.failing) this.host.notify(`Dropbox backup failed: ${message(e)}. Tried again automatically.`, true);
    if (!byHand) this.failing = true;
  }

  private state(unit: Unit): SyncState | null {
    try {
      return JSON.parse(localStorage.getItem(`${STATE_BASE}.${unit.key}`) ?? "null") as SyncState | null;
    } catch {
      return null;
    }
  }

  private setState(unit: Unit, state: SyncState): void {
    try {
      localStorage.setItem(`${STATE_BASE}.${unit.key}`, JSON.stringify(state));
    } catch {
      // Compared again next time: at worst saved once more.
    }
  }
}
