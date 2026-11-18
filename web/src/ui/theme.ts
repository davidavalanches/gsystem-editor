/**
 * Look of the app, kept on this device only. Modern: flat and dark, Inter, a colour per effect family.
 * Old school: the look of versions 1.0.x, after the unit itself (chrome footswitches, green LCD, dot-matrix
 * preset number, IBM Plex and Michroma), in one of the G-System's three finishes. The layout is the same.
 */

export const THEMES = [
  ["modern", "Modern", "Flat and dark, a colour per effect family"],
  ["black", "Old school · Black brushed", "Like the unit: chrome footswitches, green display, black panels"],
  ["grey", "Old school · Grey brushed", "Like the unit: chrome footswitches, green display, silver panels"],
  ["red", "Old school · Red brushed", "Like the unit: chrome footswitches, green display, red panels"],
] as const;
export type Theme = (typeof THEMES)[number][0];
const THEME_KEY = "gsystem-editor.theme";

export function currentTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return THEMES.some(([key]) => key === saved) ? (saved as Theme) : "modern";
  } catch {
    return "modern";
  }
}

/** Old school sets data-theme="oldschool" and its finish in data-skin, as the 1.0.x stylesheet expects. */
export function applyTheme(theme: Theme = currentTheme()): void {
  const root = document.documentElement;
  if (theme === "modern") {
    delete root.dataset.theme;
    delete root.dataset.skin;
  } else {
    root.dataset.theme = "oldschool";
    if (theme === "black") delete root.dataset.skin;
    else root.dataset.skin = theme;
  }
}

/** The user's pick: applied at once and remembered. */
export function chooseTheme(theme: Theme): void {
  applyTheme(theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Applied for this session only.
  }
}
