/** Opening and saving files on each platform, and session persistence. */

import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";

export function pickFile(accept: string): Promise<{ name: string; bytes: Uint8Array } | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      resolve(file ? { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } : null);
    });
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Save a file; returns where it went. On Android: Documents/G-System; elsewhere: a download. */
export async function saveFile(name: string, bytes: Uint8Array): Promise<string> {
  if (Capacitor.isNativePlatform()) {
    const path = `G-System/${name}`;
    await Filesystem.writeFile({ path, data: toBase64(bytes), directory: Directory.Documents, recursive: true });
    return `Documents/${path}`;
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return `Downloads/${name}`;
}

const SESSION_KEY = "gsystem-editor.session";

export interface Session {
  title: string;
  syx: Uint8Array;
  sqs: Uint8Array | null;
  /** Slots still to be written into the unit. */
  pending: number[];
}

/** Keep the current bank between launches (the app may be closed at any time on Android). */
export function storeSession(session: Session): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      title: session.title, syx: toBase64(session.syx), sqs: session.sqs ? toBase64(session.sqs) : null,
      pending: session.pending,
    }));
  } catch {
    // Storage full or unavailable: the session simply is not restored.
  }
}

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return { title: s.title, syx: fromBase64(s.syx), sqs: s.sqs ? fromBase64(s.sqs) : null, pending: s.pending ?? [] };
  } catch {
    return null;
  }
}
