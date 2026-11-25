/**
 * New versions: the app asks GitHub for the latest release once per launch, and when it is newer,
 * offers to download the file for this platform. It never installs anything itself (reliability first):
 * the download opens in the system's browser, and installing stays the person's own step.
 * Never shown during an exchange with the G-System; "Skip this version" is kept on this device only.
 * In a plain browser (the app run from its source), nothing is checked.
 */

import { Capacitor } from "@capacitor/core";
import { showChoices } from "./dialog";
import { openUrl } from "./quit";

const LATEST_URL = "https://api.github.com/repos/davidavalanches/gsystem-editor/releases/latest";
export const RELEASES_URL = "https://github.com/davidavalanches/gsystem-editor/releases/latest";
const SKIP_KEY = "gsystem-editor.skip-version";
/** After launch: the app settles (session restored, MIDI connected) before anything is asked. */
const FIRST_DELAY_MS = 8000;
/** While busy or another dialog is open: try again a little later. */
const RETRY_MS = 30000;

export type Platform = "android" | "linux" | "windows" | "mac-arm64" | "mac-x64" | "mac";

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface Release {
  tag_name: string;
  html_url: string;
  assets: ReleaseAsset[];
}

/** "v1.0.10" or "1.0.10" → [1, 0, 10]; null when it is not a version. */
export function parseVersion(text: string): number[] | null {
  const m = /^v?(\d+(?:\.\d+)*)$/.exec(text.trim());
  return m ? m[1].split(".").map(Number) : null;
}

/** True if `latest` is a newer version than `current` (1.0.10 is newer than 1.0.9). */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

/** The release file for this platform, the same files as the website's buttons; null: the release page. */
export function assetFor(platform: Platform, assets: ReleaseAsset[]): ReleaseAsset | null {
  const test: Record<Platform, (n: string) => boolean> = {
    android: (n) => /\.apk$/i.test(n),
    linux: (n) => /\.AppImage$/i.test(n),
    windows: (n) => /\.exe$/i.test(n),
    "mac-arm64": (n) => /arm64-mac\.zip$/i.test(n),
    "mac-x64": (n) => /-mac\.zip$/i.test(n) && !/arm64/i.test(n),
    // Processor unknown: let the person pick on the release page.
    mac: () => false,
  };
  return assets.find((a) => test[platform](a.name)) ?? null;
}

/** Where the app runs; null in a plain browser, where there is nothing to download. */
async function detectPlatform(): Promise<Platform | null> {
  if (Capacitor.getPlatform() === "android") return "android";
  const ua = navigator.userAgent;
  if (!ua.includes("Electron")) return null;
  if (ua.includes("Windows")) return "windows";
  if (!ua.includes("Macintosh")) return "linux";
  // The user agent says "Intel" on every Mac: Chromium's client hints know the processor.
  try {
    const data = (navigator as Navigator & {
      userAgentData?: { getHighEntropyValues(h: string[]): Promise<{ architecture?: string }> };
    }).userAgentData;
    const arch = (await data?.getHighEntropyValues(["architecture"]))?.architecture;
    if (arch === "arm") return "mac-arm64";
    if (arch === "x86") return "mac-x64";
  } catch {
    // Unknown: the release page.
  }
  return "mac";
}

function skipped(): string | null {
  try {
    return localStorage.getItem(SKIP_KEY);
  } catch {
    return null;
  }
}

function skip(tag: string): void {
  try {
    localStorage.setItem(SKIP_KEY, tag);
  } catch {
    // Not kept: it is offered again at the next launch.
  }
}

async function latestRelease(): Promise<Release | null> {
  try {
    const r = await fetch(LATEST_URL, { headers: { Accept: "application/vnd.github+json" } });
    if (!r.ok) return null;
    const rel = (await r.json()) as Release;
    return typeof rel?.tag_name === "string" && Array.isArray(rel.assets) ? rel : null;
  } catch {
    // Offline or GitHub unreachable: nothing to say.
    return null;
  }
}

function offer(rel: Release, platform: Platform): void {
  const version = rel.tag_name.replace(/^v/, "");
  const asset = assetFor(platform, rel.assets);
  const mb = asset ? ` · ${Math.round(asset.size / 1048576)} MB` : "";
  showChoices(`G-System Editor ${version} is available`, [
    { label: `Download ${version}`,
      detail: asset ? `${asset.name}${mb}, opened in your browser; install it as before. You have ${__APP_VERSION__}.`
        : `On the release page, in your browser. You have ${__APP_VERSION__}.`,
      run: () => openUrl(asset?.browser_download_url ?? rel.html_url) },
    { label: "What's new", detail: "The release notes, in your browser", run: () => openUrl(rel.html_url) },
    { label: "Later", detail: "Ask again at the next launch", run: () => {} },
    { label: "Skip this version", detail: `No more reminders for ${version}`, run: () => skip(rel.tag_name) },
  ]);
}

/**
 * Once per launch, a while after it: if GitHub has a newer version (not skipped), offer it when the app
 * is idle. `busy` is true during an exchange with the G-System; then, or with a dialog open, it waits.
 */
export function checkForUpdate(busy: () => boolean): void {
  setTimeout(() => void (async () => {
    const platform = await detectPlatform();
    if (!platform) return;
    const rel = await latestRelease();
    if (!rel || !isNewer(rel.tag_name, __APP_VERSION__) || skipped() === rel.tag_name) return;
    const tryShow = () => {
      if (busy() || document.querySelector(".dialog-layer")) setTimeout(tryShow, RETRY_MS);
      else offer(rel, platform);
    };
    tryShow();
  })(), FIRST_DELAY_MS);
}
