/**
 * Native helpers: opening a web page outside the app (linking Dropbox), and quitting. The app opens
 * full screen on a computer and on Android, so it needs its own way out: the desktop shell closes its window (and stops), Android finishes its activity. In a browser, only
 * the application window opened by scripts/gsystem-editor.sh (marked ?window=app) can close itself:
 * a page alone in its window may; an ordinary tab gets no Quit.
 */

import { Capacitor, registerPlugin } from "@capacitor/core";

interface GSystemAppPlugin {
  exit(): Promise<void>;
  openUrl(options: { url: string }): Promise<void>;
}

const NativeApp = registerPlugin<GSystemAppPlugin>("GSystemApp");

const isDesktop = () => navigator.userAgent.includes("Electron");
const isAppWindow = () => new URLSearchParams(location.search).get("window") === "app";

export function canQuit(): boolean {
  return Capacitor.getPlatform() === "android" || isDesktop() || isAppWindow();
}

export function quitApp(): void {
  if (Capacitor.getPlatform() === "android") void NativeApp.exit();
  // Electron lets the page close its own window, and the last window closed stops the app; so does
  // Chrome for a window that only ever showed this page.
  else window.close();
}

/** Open a web page outside the app: the system's browser on Android and in the desktop app, a new window in Chrome. */
export function openUrl(url: string): void {
  if (Capacitor.getPlatform() === "android") void NativeApp.openUrl({ url });
  else window.open(url, "_blank", "noopener");
}
