/**
 * The G-Systems the editor knows. Each has its own workspace (bank, Store list, protected banks,
 * last settings read), so presets meant for one never go to another. Units cannot be told apart by
 * their identity reply (no serial number), so they are recognised by their SysEx ID: two units
 * used with the editor need different IDs.
 */

export interface Unit {
  /** Stable storage key; the SysEx ID may be changed later. */
  key: string;
  sysexId: number;
  name: string;
}

interface Registry {
  units: Unit[];
  current: string;
}

const UNITS_KEY = "gsystem-editor.units";
/** Storage of a single workspace, before units existed: moved to the first unit. */
const LEGACY_KEYS = ["gsystem-editor.session", "gsystem-editor.protected-banks", "gsystem-globals"];
const LEGACY_SYSEX_ID = "gsystem-editor.sysex-id";
export const DEFAULT_SYSEX_ID = 1;

export const SESSION_BASE = "gsystem-editor.session";
export const PROTECTED_BASE = "gsystem-editor.protected-banks";
export const GLOBALS_BASE = "gsystem-globals";
export const FAVORITES_BASE = "gsystem-favorites";

export const storageKey = (base: string, unit: Unit) => `${base}.${unit.key}`;
export const defaultUnitName = (sysexId: number) => `G-System (ID ${sysexId})`;

export class Units {
  private registry: Registry;

  constructor() {
    this.registry = Units.load();
    this.shareLegacyFavorites();
  }

  /** Favorites kept for all units before each had its own: every known unit gets a copy. */
  private shareLegacyFavorites(): void {
    try {
      const shared = localStorage.getItem(FAVORITES_BASE);
      if (shared === null) return;
      for (const unit of this.registry.units) {
        if (localStorage.getItem(storageKey(FAVORITES_BASE, unit)) === null) localStorage.setItem(storageKey(FAVORITES_BASE, unit), shared);
      }
      localStorage.removeItem(FAVORITES_BASE);
    } catch {
      // Left where they are, tried again next time.
    }
  }

  get list(): readonly Unit[] {
    return this.registry.units;
  }

  get current(): Unit {
    return this.registry.units.find((u) => u.key === this.registry.current) ?? this.registry.units[0];
  }

  others(): Unit[] {
    return this.registry.units.filter((u) => u.key !== this.current.key);
  }

  bySysexId(id: number): Unit | undefined {
    return this.registry.units.find((u) => u.sysexId === id);
  }

  select(unit: Unit): void {
    this.registry.current = unit.key;
    this.save();
  }

  add(sysexId: number, name = defaultUnitName(sysexId)): Unit {
    let n = this.registry.units.length + 1;
    while (this.registry.units.some((u) => u.key === `u${n}`)) n++;
    const unit = { key: `u${n}`, sysexId, name };
    this.registry.units.push(unit);
    this.save();
    return unit;
  }

  update(unit: Unit, change: Partial<Omit<Unit, "key">>): void {
    Object.assign(unit, change);
    this.save();
  }

  private save(): void {
    try {
      localStorage.setItem(UNITS_KEY, JSON.stringify(this.registry));
    } catch {
      // Kept for this session only.
    }
  }

  private static load(): Registry {
    try {
      const saved = JSON.parse(localStorage.getItem(UNITS_KEY) ?? "null") as Registry | null;
      if (saved && Array.isArray(saved.units) && saved.units.length) return saved;
    } catch {
      // Rebuilt below.
    }
    // First run with units: the existing workspace becomes the first unit's.
    let sysexId = DEFAULT_SYSEX_ID;
    try {
      const id = Number(localStorage.getItem(LEGACY_SYSEX_ID));
      if (localStorage.getItem(LEGACY_SYSEX_ID) !== null && Number.isInteger(id) && id >= 0 && id <= 126) sysexId = id;
    } catch {
      // Default ID.
    }
    const unit: Unit = { key: "u1", sysexId, name: defaultUnitName(sysexId) };
    try {
      for (const base of LEGACY_KEYS) {
        const value = localStorage.getItem(base);
        if (value !== null) {
          localStorage.setItem(storageKey(base, unit), value);
          localStorage.removeItem(base);
        }
      }
      localStorage.removeItem(LEGACY_SYSEX_ID);
    } catch {
      // Nothing to move.
    }
    const registry = { units: [unit], current: unit.key };
    try {
      localStorage.setItem(UNITS_KEY, JSON.stringify(registry));
    } catch {
      // Kept for this session only.
    }
    return registry;
  }
}

/** "03-2" (or "3-2") to a slot index, or null. */
export function parseSlotLabel(text: string, banks: number, perBank: number): number | null {
  const m = /^\s*(\d{1,2})\s*[-.\s]\s*(\d)\s*$/.exec(text);
  if (!m) return null;
  const bank = Number(m[1]), position = Number(m[2]);
  return bank < banks && position >= 1 && position <= perBank ? bank * perBank + position - 1 : null;
}
