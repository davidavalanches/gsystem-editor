/**
 * Finish of the app's panels, after the G-System's editions. Each G-System (workspace, see units) keeps its
 * own; a G-System that has none takes the last one picked on this device, grey until one is picked.
 */

export const SKINS = [["black", "Black brushed"], ["grey", "Grey brushed"], ["red", "Red brushed"]] as const;
export type Skin = (typeof SKINS)[number][0];
/** The last finish picked on this device, whatever the G-System. */
const SKIN_KEY = "gsystem-editor.skin";
export const SKIN_BASE = "gsystem-editor.skin";

const read = (key: string): Skin | null => {
  try {
    const saved = localStorage.getItem(key);
    return SKINS.some(([k]) => k === saved) ? (saved as Skin) : null;
  } catch {
    return null;
  }
};

/** The finish of a G-System (its storage key), else the last one picked, else grey. */
export function currentSkin(unitKey?: string): Skin {
  return (unitKey ? read(unitKey) : null) ?? read(SKIN_KEY) ?? "grey";
}

export function applySkin(skin: Skin = currentSkin()): void {
  if (skin === "black") document.documentElement.removeAttribute("data-skin");
  else document.documentElement.dataset.skin = skin;
}

/** The user's pick: applied and remembered for this G-System (and as the last one picked). */
export function chooseSkin(skin: Skin, unitKey?: string): void {
  applySkin(skin);
  try {
    localStorage.setItem(SKIN_KEY, skin);
    if (unitKey) localStorage.setItem(unitKey, skin);
  } catch {
    // Applied for this session only.
  }
}
