/**
 * Names of the four effect loops (the pedals plugged into them). They belong to a G-System, not to a
 * preset: each workspace (SysEx ID, see units) keeps its own, on this device only.
 */

export const LOOP_NAMES_BASE = "gsystem-loop-names";
export const LOOP_COUNT = 4;
export const LOOP_NAME_LEN = 16;

export class LoopNames {
  private names: string[] = new Array(LOOP_COUNT).fill("");
  private key: string | null = null;
  /** Called after any change, and when another G-System's names are shown. */
  onChange: (() => void) | null = null;

  /** Show (and keep) the names of another G-System. */
  use(key: string): void {
    this.key = key;
    let saved: unknown = null;
    try {
      saved = JSON.parse(localStorage.getItem(key) ?? "null");
    } catch {
      saved = null;
    }
    this.names = Array.from({ length: LOOP_COUNT }, (_, i) =>
      Array.isArray(saved) && typeof saved[i] === "string" ? saved[i].slice(0, LOOP_NAME_LEN) : "");
    this.onChange?.();
  }

  /** The name of loop 1-4 (index 0-3), "" when it has none. */
  name(index: number): string {
    return this.names[index] ?? "";
  }

  /** "Loop 2" or its name. */
  label(index: number): string {
    return this.name(index) || `Loop ${index + 1}`;
  }

  set(index: number, name: string): void {
    this.names[index] = name.trim().slice(0, LOOP_NAME_LEN);
    if (this.key) {
      try {
        localStorage.setItem(this.key, JSON.stringify(this.names));
      } catch {
        // Kept for this session only.
      }
    }
    this.onChange?.();
  }
}
