/** Brushed-metal rotary knob and pill toggle switch. Styling lives in styles.css. */

const SWEEP = 135;

export class Knob {
  readonly el = document.createElement("div");
  private readonly cap = document.createElement("div");
  private value: number;
  private dragY: number | null = null;
  private dragValue = 0;
  /** While turning. */
  onInput: ((value: number) => void) | null = null;
  /** When the gesture ends. */
  onChange: ((value: number) => void) | null = null;

  constructor(private lo: number, private hi: number) {
    this.value = lo;
    this.el.className = "knob";
    this.el.tabIndex = 0;
    this.el.setAttribute("role", "slider");
    this.el.setAttribute("aria-valuemin", String(lo));
    this.el.setAttribute("aria-valuemax", String(hi));
    this.cap.className = "knob-cap";
    this.el.append(this.cap);
    this.el.addEventListener("pointerdown", (e) => {
      this.el.setPointerCapture(e.pointerId);
      this.dragY = e.clientY;
      this.dragValue = this.value;
      this.el.classList.add("pressed");
      e.preventDefault();
    });
    this.el.addEventListener("pointermove", (e) => {
      if (this.dragY === null) return;
      // A full sweep for about 200 px; Shift for fine control.
      const perPx = ((this.hi - this.lo) / 200) * (e.shiftKey ? 0.1 : 1);
      this.dragValue = Math.max(this.lo, Math.min(this.hi, this.dragValue + (this.dragY - e.clientY) * perPx));
      this.dragY = e.clientY;
      this.change(Math.round(this.dragValue), false);
    });
    const end = () => {
      if (this.dragY === null) return;
      this.dragY = null;
      this.el.classList.remove("pressed");
      this.onChange?.(this.value);
    };
    this.el.addEventListener("pointerup", end);
    this.el.addEventListener("pointercancel", end);
    this.el.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.change(this.value + (e.deltaY < 0 ? this.step() : -this.step()), true);
    }, { passive: false });
    this.el.addEventListener("keydown", (e) => {
      const keys: Record<string, number> = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1,
        PageUp: 10, PageDown: -10 };
      if (e.key in keys) {
        e.preventDefault();
        const k = keys[e.key];
        this.change(this.value + Math.sign(k) * this.step(Math.abs(k) > 1), true);
      }
    });
    this.render();
  }

  setValue(value: number): void {
    this.value = Math.max(this.lo, Math.min(this.hi, Math.round(value)));
    this.render();
  }

  private step(big = false): number {
    const span = this.hi - this.lo;
    return span > 50 || big ? Math.max(1, Math.floor(span / (big ? 10 : 100))) : 1;
  }

  private change(value: number, final: boolean): void {
    value = Math.max(this.lo, Math.min(this.hi, value));
    if (value !== this.value) {
      this.setValue(value);
      this.onInput?.(value);
    }
    if (final) this.onChange?.(this.value);
  }

  private render(): void {
    const span = this.hi - this.lo;
    const angle = -SWEEP + (span ? (2 * SWEEP * (this.value - this.lo)) / span : 0);
    this.cap.style.setProperty("--angle", `${angle}deg`);
    this.el.setAttribute("aria-valuenow", String(this.value));
  }
}

export class Toggle {
  readonly el = document.createElement("button");
  private checked = false;
  onChange: ((checked: boolean) => void) | null = null;

  constructor() {
    this.el.className = "toggle";
    this.el.type = "button";
    this.el.setAttribute("role", "switch");
    this.el.innerHTML = '<span class="toggle-label on">ON</span><span class="toggle-label off">OFF</span>'
      + '<span class="toggle-knob"></span>';
    this.el.addEventListener("click", () => {
      this.setChecked(!this.checked);
      this.onChange?.(this.checked);
    });
    this.render();
  }

  setChecked(checked: boolean): void {
    this.checked = checked;
    this.render();
  }

  private render(): void {
    this.el.classList.toggle("checked", this.checked);
    this.el.setAttribute("aria-checked", String(this.checked));
  }
}
