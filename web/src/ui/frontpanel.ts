/**
 * Virtual front panel laid out like the G-System's control board, drawn on a
 * canvas in relative coordinates so it scales to any width. Footswitch clicks
 * are reported with onPress(key); the editor decides what each one does.
 */

const COLUMNS = 7;
/** Height / width. The real board is 2000x1054 for 6 columns; one extra column for Insert, EQ and Gate. */
export const PANEL_ASPECT = 0.4;

const GLYPHS: Record<string, string[]> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

interface Switch {
  key: string;
  title: string;
  subtitle?: string;
  caption?: string;
  arrow?: "up" | "down";
}

const ROWS: Switch[][] = [
  [
    { key: "filter", title: "FILTER", subtitle: "FORMANT | WAH | EFFECT FILTERS", caption: "INPUT" },
    { key: "comp", title: "COMP", subtitle: "COMPRESSOR ALGORITHM", caption: "A" },
    { key: "loop1", title: "LOOP 1", caption: "B" },
    { key: "loop2", title: "LOOP 2", caption: "C" },
    { key: "loop3", title: "LOOP 3", caption: "PAGE" },
    { key: "loop4", title: "LOOP 4", caption: "OUTPUT" },
    { key: "insert", title: "INSERT", subtitle: "LOOP 5" },
  ],
  [
    { key: "up", title: "UP", arrow: "up" },
    { key: "mod", title: "MOD", subtitle: "CHORUS | FLANGER | TREMOLO" },
    { key: "pitch", title: "PITCH", subtitle: "WHAMMY | PITCH ALGORITHM" },
    { key: "delay", title: "DELAY", subtitle: "HI-CLASS | TAPE ECHO | DYNAMIC" },
    { key: "reverb", title: "REVERB", subtitle: "REVERB ALGORITHM" },
    { key: "boost", title: "BOOST", subtitle: "PRESETABLE BOOST LEVEL" },
    { key: "eq", title: "EQ", subtitle: "PARAMETRIC EQ" },
  ],
  [
    { key: "down", title: "DOWN", arrow: "down" },
    ...[1, 2, 3, 4, 5].map((i) => ({ key: `preset${i}`, title: String(i), subtitle: "SÉLECTION" })),
    { key: "gate", title: "GATE", subtitle: "NOISE GATE" },
  ],
];

interface Rect { x: number; y: number; w: number; h: number }
const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

export interface PanelState {
  bank: string;
  position: string;
  name: string;
  /** key -> true (lit), false (off), null (unknown); missing keys have no ring. */
  leds: Record<string, boolean | null>;
  enabled: Set<string>;
  edited: boolean;
  status: string;
  live: boolean;
}

export class FrontPanel {
  readonly canvas = document.createElement("canvas");
  onPress: ((key: string) => void) | null = null;
  onName: (() => void) | null = null;
  private state: PanelState = {
    bank: "--", position: "", name: "", leds: {}, enabled: new Set(), edited: false, status: "", live: false,
  };
  private down: string | null = null;
  private midiFlash = false;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private w = 0;
  private h = 0;

  constructor() {
    this.canvas.className = "front-panel";
    this.canvas.addEventListener("pointerdown", (e) => {
      this.down = this.hit(e.offsetX, e.offsetY);
      if (this.down && !this.isEnabled(this.down)) this.down = null;
      this.draw();
    });
    this.canvas.addEventListener("pointerup", (e) => {
      const hit = this.hit(e.offsetX, e.offsetY);
      const down = this.down;
      this.down = null;
      this.draw();
      if (hit && hit === down) {
        if (hit === "__name__") this.onName?.();
        else this.onPress?.(hit);
      }
    });
    this.canvas.addEventListener("pointerleave", () => {
      this.down = null;
      this.draw();
    });
    new ResizeObserver(() => this.resize()).observe(this.canvas);
  }

  setState(state: PanelState): void {
    this.state = state;
    this.draw();
  }

  flashMidi(): void {
    this.midiFlash = true;
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.midiFlash = false;
      this.draw();
    }, 120);
    this.draw();
  }

  private isEnabled(key: string): boolean {
    return key === "__name__" || this.state.enabled.has(key);
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.w = this.canvas.clientWidth;
    this.h = this.w * PANEL_ASPECT;
    this.canvas.style.height = `${this.h}px`;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.draw();
  }

  // Geometry (panel coordinates in CSS pixels)

  private cell(row: number, col: number): Rect {
    const cw = (this.w - 2 * this.w * 0.022) / COLUMNS;
    const tops = [0.005, 0.43, 0.715];
    const heights = [0.28, 0.285, 0.28];
    return rect(this.w * 0.022 + col * cw, this.h * tops[row], cw, this.h * heights[row]);
  }

  private display(): Rect {
    return rect(this.w * 0.022, this.h * 0.29, this.w * 0.956, this.h * 0.13);
  }

  private lcd(): Rect {
    const d = this.display();
    return rect(d.x + d.w * 0.34, d.y + d.h * 0.17, d.w * 0.33, d.h * 0.66);
  }

  private circle(row: number, col: number): { cx: number; cy: number; r: number } {
    const c = this.cell(row, col);
    const d = Math.min(c.w, c.h) * 0.44;
    const cy = c.y + c.h * (row === 1 ? 0.56 : 0.6);
    return { cx: c.x + c.w / 2, cy, r: d / 2 };
  }

  private hit(x: number, y: number): string | null {
    for (let row = 0; row < ROWS.length; row++) {
      for (let col = 0; col < ROWS[row].length; col++) {
        const c = this.circle(row, col);
        if (Math.hypot(x - c.cx, y - c.cy) < c.r * 1.35) return ROWS[row][col].key;
      }
    }
    const l = this.lcd();
    return x >= l.x && x <= l.x + l.w && y >= l.y && y <= l.y + l.h ? "__name__" : null;
  }

  // Painting

  private draw(): void {
    const ctx = this.canvas.getContext("2d");
    if (!ctx || !this.w) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    this.body(ctx);
    ROWS.forEach((switches, row) => switches.forEach((sw, col) => this.switchCell(ctx, row, col, sw)));
    this.displayBand(ctx);
  }

  private font(px: number, bold = true, family = "DejaVu Sans, Roboto, Arial, sans-serif"): string {
    return `${bold ? "bold " : ""}${Math.max(6, px)}px ${family}`;
  }

  private body(ctx: CanvasRenderingContext2D): void {
    const { w, h } = this;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "rgb(214,216,218)");
    g.addColorStop(0.5, "rgb(196,198,201)");
    g.addColorStop(1, "rgb(186,188,191)");
    ctx.fillStyle = g;
    ctx.strokeStyle = "rgb(120,122,125)";
    ctx.lineWidth = Math.max(1, w * 0.002);
    ctx.beginPath();
    ctx.roundRect(0.5, 0.5, w - 1, h - 1, w * 0.008);
    ctx.fill();
    ctx.stroke();
    // Brushed aluminium: faint horizontal lines.
    ctx.strokeStyle = "rgba(255,255,255,0.11)";
    ctx.lineWidth = 1;
    const step = Math.max(2, h / 260);
    for (let y = step, i = 0; y < h; y += step, i++) {
      if (i % 3 === 0) continue;
      ctx.beginPath();
      ctx.moveTo(2, y);
      ctx.lineTo(w - 2, y);
      ctx.stroke();
    }
    // Seams between cells.
    ctx.strokeStyle = "rgb(150,152,156)";
    ctx.lineWidth = Math.max(1, w * 0.0012);
    for (let col = 1; col < COLUMNS; col++) {
      for (const [a, b] of [[0, 0], [1, 2]]) {
        const top = this.cell(a, col);
        const bottom = this.cell(b, col);
        ctx.beginPath();
        ctx.moveTo(top.x, top.y);
        ctx.lineTo(top.x, bottom.y + bottom.h);
        ctx.stroke();
      }
    }
    // Screws.
    for (const [fx, fy] of [[0.011, 0.14], [0.989, 0.14], [0.011, 0.86], [0.989, 0.86]]) {
      const cx = w * fx, cy = h * fy, r = w * 0.0075;
      const sg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      sg.addColorStop(0, "rgb(70,70,72)");
      sg.addColorStop(1, "rgb(20,20,22)");
      ctx.fillStyle = sg;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgb(110,110,112)";
      ctx.lineWidth = r * 0.25;
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.6, cy);
      ctx.lineTo(cx + r * 0.6, cy);
      ctx.moveTo(cx, cy - r * 0.6);
      ctx.lineTo(cx, cy + r * 0.6);
      ctx.stroke();
    }
  }

  private switchCell(ctx: CanvasRenderingContext2D, row: number, col: number, sw: Switch): void {
    const cell = this.cell(row, col);
    const c = this.circle(row, col);
    const enabled = this.isEnabled(sw.key);
    const ink = enabled ? "rgb(25,25,28)" : "rgb(120,122,126)";
    const presetStyle = row === 2 && sw.key.startsWith("preset");
    const titleSize = this.h * (presetStyle ? 0.06 : 0.04);
    ctx.fillStyle = ink;
    ctx.textBaseline = "middle";
    ctx.font = this.font(titleSize);
    let titleBottom: number;
    if (presetStyle) {
      ctx.textAlign = "left";
      const ty = c.cy - c.r - titleSize * 0.9;
      ctx.fillText(sw.title, cell.x + cell.w * 0.08, ty);
      ctx.font = this.font(this.h * 0.0135, false);
      ctx.fillText(sw.subtitle ?? "", cell.x + cell.w * 0.38, ty);
      titleBottom = ty;
    } else {
      ctx.textAlign = "center";
      const ty = cell.y + cell.h * 0.06 + titleSize * 0.7;
      let tx = cell.x + cell.w / 2;
      if (sw.arrow) {
        this.arrow(ctx, cell.x + cell.w * 0.25, ty, titleSize * 0.75, sw.arrow === "up", ink);
        tx = cell.x + cell.w * 0.62;
      }
      ctx.font = this.font(titleSize);
      ctx.fillText(sw.title, tx, ty);
      titleBottom = ty + titleSize * 0.7;
      if (sw.subtitle) {
        ctx.font = this.font(this.h * 0.0135, false);
        const sy = row === 1 ? c.cy + c.r * 1.45 : titleBottom + titleSize * 0.35;
        ctx.fillText(sw.subtitle, cell.x + cell.w / 2, sy);
      }
    }
    if (sw.caption) {
      ctx.fillStyle = "rgb(240,242,245)";
      ctx.font = this.font(this.h * 0.03, false);
      ctx.textAlign = "center";
      ctx.fillText(sw.caption, cell.x + cell.w / 2, c.cy + c.r + cell.h * 0.02 + titleSize * 0.55);
    }
    this.footswitch(ctx, c.cx, c.cy, c.r, enabled, this.down === sw.key);
    if (sw.key in this.state.leds) this.ring(ctx, c.cx, c.cy, c.r, this.state.leds[sw.key]);
  }

  private arrow(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, up: boolean, ink: string): void {
    ctx.strokeStyle = ink;
    ctx.lineWidth = size * 0.12;
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.stroke();
    const s = size * 0.55, d = up ? 1 : -1;
    ctx.fillStyle = ink;
    ctx.beginPath();
    ctx.moveTo(x, y - s * d);
    ctx.lineTo(x - s, y + s * 0.6 * d);
    ctx.lineTo(x + s, y + s * 0.6 * d);
    ctx.closePath();
    ctx.fill();
  }

  private footswitch(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, enabled: boolean, down: boolean): void {
    const ring = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    ring.addColorStop(0.75, "rgb(45,47,50)");
    ring.addColorStop(1, "rgb(95,98,102)");
    ctx.fillStyle = ring;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    const dr = r * (down ? 0.62 : 0.68);
    const hx = cx - dr * 0.36, hy = cy - dr * 0.4;
    const base = enabled ? 245 : 200;
    const g = ctx.createRadialGradient(hx, hy, 0, hx, hy, dr * 1.5);
    g.addColorStop(0, `rgb(${base},${base},${base})`);
    g.addColorStop(0.45, `rgb(${base - 40},${base - 38},${base - 35})`);
    g.addColorStop(0.8, `rgb(${base - 120},${base - 118},${base - 115})`);
    g.addColorStop(1, `rgb(${base - 60},${base - 58},${base - 55})`);
    ctx.fillStyle = g;
    ctx.strokeStyle = "rgb(30,30,32)";
    ctx.lineWidth = Math.max(1, r * 0.04);
    ctx.beginPath();
    ctx.arc(cx, cy, dr, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  /** Neon ring around the footswitch: red when on, amber dashed when unknown. */
  private ring(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, state: boolean | null): void {
    const width = r * 0.14;
    const rr = r + width * 0.9;
    ctx.save();
    if (state) {
      const glow = ctx.createRadialGradient(cx, cy, rr * 0.7, cx, cy, rr * 1.36);
      glow.addColorStop(0, "rgba(255,40,30,0)");
      glow.addColorStop(0.3, "rgba(255,50,35,0.6)");
      glow.addColorStop(1, "rgba(255,50,35,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx, cy, rr * 1.36, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgb(255,70,50)";
      ctx.lineWidth = width;
    } else if (state === null) {
      ctx.strokeStyle = "rgb(255,175,0)";
      ctx.lineWidth = width * 0.7;
      ctx.setLineDash([width * 1.5, width * 1.2]);
    } else {
      ctx.strokeStyle = "rgba(120,40,36,0.67)";
      ctx.lineWidth = width * 0.7;
    }
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, Math.PI * 2);
    ctx.stroke();
    if (state) {
      ctx.strokeStyle = "rgba(255,200,190,0.8)";
      ctx.lineWidth = width * 0.3;
      ctx.stroke();
    }
    ctx.restore();
  }

  private displayBand(ctx: CanvasRenderingContext2D): void {
    const d = this.display();
    ctx.fillStyle = "rgb(10,10,12)";
    ctx.fillRect(d.x, d.y, d.w, d.h);

    // MIDI activity and Live indicators.
    const ledR = d.h * 0.07;
    ([["MIDI", this.midiFlash, [60, 220, 60]], ["LIVE", this.state.live, [255, 200, 0]]] as const)
      .forEach(([label, on, rgb], i) => {
        const x = d.x + d.w * (0.13 + i * 0.045);
        ctx.fillStyle = on ? `rgb(${rgb})` : `rgba(${rgb},0.25)`;
        ctx.beginPath();
        ctx.arc(x, d.y + d.h * 0.6, ledR, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgb(220,220,220)";
        ctx.font = this.font(d.h * 0.11, false);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, x, d.y + d.h * 0.22);
      });

    // Bank number in large dots, position within the bank as a small subscript.
    const big = rect(d.x + d.w * 0.19, d.y + d.h * 0.14, d.w * 0.08, d.h * 0.72);
    const pitch = this.dots(ctx, this.state.bank.slice(-2).padStart(2), big);
    const small = pitch * 0.5;
    this.dots(ctx, this.state.position.slice(-1), rect(big.x + pitch * 12, big.y + pitch * 7 - small * 7, small * 5, small * 7));
    if (this.state.edited) {
      ctx.fillStyle = "rgb(200,200,200)";
      ctx.font = this.font(d.h * 0.1, false);
      ctx.textAlign = "left";
      ctx.fillText("EDITED", d.x + d.w * 0.285, d.y + d.h * 0.15);
    }

    // Green LCD with the preset name.
    const l = this.lcd();
    ctx.fillStyle = "rgb(70,75,85)";
    ctx.fillRect(l.x, d.y + d.h * 0.02, l.w * 0.3, d.h * 0.13);
    ctx.fillStyle = "rgb(230,230,235)";
    ctx.font = this.font(d.h * 0.1);
    ctx.textAlign = "center";
    ctx.fillText("PRESET", l.x + l.w * 0.15, d.y + d.h * 0.085);
    const lg = ctx.createLinearGradient(0, l.y, 0, l.y + l.h);
    lg.addColorStop(0, "rgb(186,222,60)");
    lg.addColorStop(1, "rgb(160,200,40)");
    ctx.fillStyle = lg;
    ctx.fillRect(l.x, l.y, l.w, l.h);
    ctx.fillStyle = "rgb(30,40,10)";
    ctx.font = this.font(l.h * 0.36, false, "DejaVu Sans Mono, Roboto Mono, monospace");
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(this.state.name || "<EMPTY>", l.x + l.w * 0.03, l.y + l.h * 0.45);
    ctx.fillText(this.state.status, l.x + l.w * 0.03, l.y + l.h * 0.88);

    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgb(200,202,206)";
    ctx.font = this.font(d.h * 0.1, false);
    ctx.fillText("INTEGRATED EFFECTS + MANAGEMENT", d.x + d.w * 0.97, d.y + d.h * 0.28);
    ctx.fillStyle = "rgb(150,155,162)";
    ctx.font = this.font(d.h * 0.3, false);
    ctx.fillText("G·SYSTEM", d.x + d.w * 0.97, d.y + d.h * 0.66);
  }

  /** Text in 5x7 dots; returns the dot pitch used. */
  private dots(ctx: CanvasRenderingContext2D, text: string, r: Rect): number {
    const cols = 6 * text.length - 1;
    const pitch = Math.min(r.w / cols, r.h / 7);
    [...text].forEach((ch, ci) => {
      (GLYPHS[ch] ?? GLYPHS[" "]).forEach((line, y) => {
        [...line].forEach((bit, x) => {
          ctx.fillStyle = bit === "1" ? "rgb(255,45,30)" : "rgb(45,10,8)";
          ctx.beginPath();
          ctx.arc(r.x + (ci * 6 + x + 0.5) * pitch, r.y + (y + 0.5) * pitch, pitch * 0.38, 0, Math.PI * 2);
          ctx.fill();
        });
      });
    });
    return pitch;
  }
}
