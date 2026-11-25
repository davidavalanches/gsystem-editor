/**
 * Ko-fi: the app is free, and asks for a tip at most once in a while, right after something worked
 * (all banks read, presets written and verified). Never during an exchange, never twice in a session;
 * "Maybe later" (or closing the dialog) asks again after a month at the earliest, "No thanks" and
 * "Support" never again. The More actions menu keeps a permanent link. Kept on this device only.
 */

import { showChoices } from "./dialog";
import { openUrl } from "./quit";

export const KOFI_URL = "https://ko-fi.com/davidavalanches";
const KEY = "gsystem-editor.donate";
const LATER_MS = 30 * 24 * 3600 * 1000;
/** A short pause after the success: its own message shows first. */
const DELAY_MS = 2500;

interface DonateState {
  /** asked: shown, no answer yet (or "later"); done: supported or declined, never shown again. */
  state: "asked" | "done";
  at: number;
}

let shownThisSession = false;

function load(): DonateState | null {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as DonateState | null;
    return saved && (saved.state === "asked" || saved.state === "done") && typeof saved.at === "number" ? saved : null;
  } catch {
    return null;
  }
}

function save(state: DonateState["state"]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ state, at: Date.now() }));
  } catch {
    // Not kept: at worst it asks again next session.
  }
}

export function openKofi(): void {
  openUrl(KOFI_URL);
}

/** After a real success: invite to tip if it is time. `busy` is checked again when the dialog would show. */
export function inviteToDonate(busy: () => boolean): void {
  if (shownThisSession) return;
  const saved = load();
  if (saved?.state === "done" || (saved && Date.now() - saved.at < LATER_MS)) return;
  shownThisSession = true;
  setTimeout(() => {
    if (busy() || document.querySelector(".dialog-layer")) {
      // Something else is on screen or under way: try at the next success instead.
      shownThisSession = false;
      return;
    }
    // Recorded before showing: closing the dialog counts as "Maybe later".
    save("asked");
    showChoices("Enjoying G-System Editor?", [
      { label: "Support it on Ko-fi", detail: "It's free and made on my evenings. A coffee helps keep it going, and this year's goal is signing the Mac app.",
        run: () => {
          save("done");
          openKofi();
        } },
      { label: "Maybe later", detail: "Ask again in a month", run: () => save("asked") },
      { label: "No thanks", detail: "Don't ask again (Ko-fi stays in the More actions menu)", run: () => save("done") },
    ]);
  }, DELAY_MS);
}
