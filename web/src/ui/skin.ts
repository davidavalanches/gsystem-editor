/** Finish of the app's panels, after the G-System's editions: kept on this device only; grey until one is picked. */

export const SKINS = [["black", "Black brushed"], ["grey", "Grey brushed"], ["red", "Red brushed"]] as const;
export type Skin = (typeof SKINS)[number][0];
const SKIN_KEY = "gsystem-editor.skin";

export function currentSkin(): Skin {
  try {
    const saved = localStorage.getItem(SKIN_KEY);
    return SKINS.some(([key]) => key === saved) ? (saved as Skin) : "grey";
  } catch {
    return "grey";
  }
}

export function applySkin(skin: Skin = currentSkin()): void {
  if (skin === "black") document.documentElement.removeAttribute("data-skin");
  else document.documentElement.dataset.skin = skin;
}

/** The user's pick: applied and remembered. */
export function chooseSkin(skin: Skin): void {
  applySkin(skin);
  try {
    localStorage.setItem(SKIN_KEY, skin);
  } catch {
    // Applied for this session only.
  }
}
