/**
 * Dropbox, where the sessions of each G-System are kept online: files in the app's own folder of the
 * user's Dropbox (Apps/<app name>), nothing else of the account is reachable. There is no server: the
 * app is linked with OAuth's PKCE flow without redirection (Dropbox shows a code that the user pastes
 * back), the same on Android, in the desktop app and in Chrome; the tokens stay on this device.
 */

import { DROPBOX_APP_KEY } from "./config";

const TOKENS_KEY = "gsystem-editor.dropbox";
const AUTHORIZE_URL = "https://www.dropbox.com/oauth2/authorize";
const TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
const API_URL = "https://api.dropboxapi.com/2";
const CONTENT_URL = "https://content.dropboxapi.com/2";
/** An access token is renewed this long before it expires. */
const EXPIRY_MARGIN_MS = 60_000;

interface Tokens {
  refresh: string;
  access: string;
  /** When the access token expires (ms since the epoch). */
  expires: number;
  /** The account's display name, shown in the menu. */
  account?: string;
}

export interface CloudFile {
  /** Path in the app's folder, e.g. "/gsystem-id-1.json". */
  path: string;
  name: string;
  /** Dropbox revision: an update names the one it replaces, so a newer one is never overwritten. */
  rev: string;
  /** When Dropbox received it (ISO date). */
  modified: string;
}

/** How an upload treats a file already there. */
export type UploadMode = { replaces: string } | "create" | "overwrite";

export class DropboxError extends Error {
  constructor(message: string, readonly status: number, readonly summary = "") {
    super(message);
  }

  /** Another device saved the file since (or it exists while it was to be created). */
  get conflict(): boolean {
    return this.status === 409 && this.summary.startsWith("path/conflict");
  }

  get notFound(): boolean {
    return this.status === 409 && /not_found/.test(this.summary);
  }
}

function base64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Dropbox-API-Arg is an HTTP header: characters beyond ASCII are escaped. */
const headerJson = (value: unknown) => JSON.stringify(value).replace(/[\u007f-￿]/g,
  (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

const toFile = (m: { path_display: string; name: string; rev: string; server_modified: string }): CloudFile =>
  ({ path: m.path_display, name: m.name, rev: m.rev, modified: m.server_modified });

export class Dropbox {
  private tokens: Tokens | null = Dropbox.loadTokens();
  /** PKCE secret of the link under way, between opening Dropbox's page and pasting its code. */
  private verifier: string | null = null;
  private refreshing: Promise<string> | null = null;

  constructor(private readonly appKey = DROPBOX_APP_KEY) {}

  /** An app key was set for this build (see config.ts): without one, Dropbox is not offered. */
  get configured(): boolean {
    return this.appKey !== "";
  }

  get linked(): boolean {
    return this.tokens !== null;
  }

  get account(): string {
    return this.tokens?.account ?? "";
  }

  /** Step 1: the page where the user allows the app; Dropbox then shows a code to paste with finishLink. */
  async authorizeUrl(): Promise<string> {
    const random = crypto.getRandomValues(new Uint8Array(48));
    this.verifier = base64Url(random);
    const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(this.verifier))));
    return `${AUTHORIZE_URL}?${new URLSearchParams({
      client_id: this.appKey, response_type: "code", code_challenge: challenge, code_challenge_method: "S256",
      token_access_type: "offline",
    })}`;
  }

  /** Step 2: the code Dropbox showed is exchanged for tokens; returns the account's name. */
  async finishLink(code: string): Promise<string> {
    if (!this.verifier) throw new DropboxError("Open Dropbox's page first", 0);
    const reply = await this.tokenRequest({ grant_type: "authorization_code", code: code.trim(), code_verifier: this.verifier });
    this.verifier = null;
    this.tokens = { refresh: reply.refresh_token, access: reply.access_token, expires: Date.now() + reply.expires_in * 1000 };
    try {
      const me = await this.rpc<{ name: { display_name: string } }>("users/get_current_account", null);
      this.tokens.account = me.name.display_name;
    } catch {
      // Linked all the same; the menu just shows no name.
    }
    this.saveTokens();
    return this.account;
  }

  /** Forget this device's access (and withdraw it at Dropbox when it can be reached). */
  async unlink(): Promise<void> {
    try {
      if (this.tokens) await this.rpc("auth/token/revoke", null);
    } catch {
      // Withdrawn here all the same; the user can also remove the app from Dropbox's settings.
    } finally {
      this.tokens = null;
      this.saveTokens();
    }
  }

  /** The file's revision, or null when there is none. */
  async metadata(path: string): Promise<CloudFile | null> {
    try {
      return toFile(await this.rpc("files/get_metadata", { path }));
    } catch (e) {
      if (e instanceof DropboxError && e.notFound) return null;
      throw e;
    }
  }

  /** The files in the app's folder. */
  async list(): Promise<CloudFile[]> {
    type Page = { entries: ({ ".tag": string } & Parameters<typeof toFile>[0])[]; cursor: string; has_more: boolean };
    let page = await this.rpc<Page>("files/list_folder", { path: "" });
    const files = page.entries.filter((e) => e[".tag"] === "file").map(toFile);
    while (page.has_more) {
      page = await this.rpc<Page>("files/list_folder/continue", { cursor: page.cursor });
      files.push(...page.entries.filter((e) => e[".tag"] === "file").map(toFile));
    }
    return files;
  }

  async upload(path: string, text: string, mode: UploadMode): Promise<CloudFile> {
    const write = mode === "create" ? "add" : mode === "overwrite" ? "overwrite" : { ".tag": "update", update: mode.replaces };
    const response = await this.request(`${CONTENT_URL}/files/upload`, {
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": headerJson({ path, mode: write, autorename: false, mute: true }),
    }, new TextEncoder().encode(text));
    return toFile(await response.json());
  }

  async download(path: string): Promise<string> {
    const response = await this.request(`${CONTENT_URL}/files/download`, { "Dropbox-API-Arg": headerJson({ path }) });
    return response.text();
  }

  private async rpc<T>(endpoint: string, arg: unknown): Promise<T> {
    const response = await this.request(`${API_URL}/${endpoint}`, arg === null ? {} : { "Content-Type": "application/json" },
      arg === null ? undefined : JSON.stringify(arg));
    const text = await response.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  /** A call with the access token; an expired one is renewed and the call made again once. */
  private async request(url: string, headers: Record<string, string>, body?: BodyInit, retry = true): Promise<Response> {
    const token = await this.accessToken();
    let response: Response;
    try {
      response = await fetch(url, { method: "POST", headers: { ...headers, Authorization: `Bearer ${token}` }, body });
    } catch {
      throw new DropboxError("Dropbox cannot be reached (offline?)", 0);
    }
    if (response.status === 401 && retry && this.tokens) {
      this.tokens.expires = 0;
      return this.request(url, headers, body, false);
    }
    if (!response.ok) throw await Dropbox.error(response);
    return response;
  }

  private async accessToken(): Promise<string> {
    if (!this.tokens) throw new DropboxError("Dropbox is not linked", 401);
    if (this.tokens.expires - EXPIRY_MARGIN_MS > Date.now()) return this.tokens.access;
    // Calls made together share one renewal.
    this.refreshing ??= (async () => {
      try {
        const reply = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: this.tokens!.refresh });
        this.tokens = { ...this.tokens!, access: reply.access_token, expires: Date.now() + reply.expires_in * 1000 };
        this.saveTokens();
        return this.tokens.access;
      } catch (e) {
        // Access withdrawn from Dropbox's settings: link again.
        if (e instanceof DropboxError && e.status === 400) {
          this.tokens = null;
          this.saveTokens();
          throw new DropboxError("Dropbox no longer gives access: link it again", 401);
        }
        throw e;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private async tokenRequest(fields: Record<string, string>): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
    let response: Response;
    try {
      response = await fetch(TOKEN_URL, { method: "POST", body: new URLSearchParams({ ...fields, client_id: this.appKey }) });
    } catch {
      throw new DropboxError("Dropbox cannot be reached (offline?)", 0);
    }
    if (!response.ok) throw await Dropbox.error(response);
    return response.json();
  }

  private static async error(response: Response): Promise<DropboxError> {
    const text = await response.text().catch(() => "");
    let summary = "";
    try {
      const body = JSON.parse(text);
      summary = body.error_summary ?? body.error_description ?? body.error ?? "";
    } catch {
      summary = text.slice(0, 200);
    }
    return new DropboxError(`Dropbox: ${summary || `error ${response.status}`}`, response.status, summary);
  }

  private saveTokens(): void {
    try {
      if (this.tokens) localStorage.setItem(TOKENS_KEY, JSON.stringify(this.tokens));
      else localStorage.removeItem(TOKENS_KEY);
    } catch {
      // Linked for this session only.
    }
  }

  private static loadTokens(): Tokens | null {
    try {
      const t = JSON.parse(localStorage.getItem(TOKENS_KEY) ?? "null") as Tokens | null;
      return t && typeof t.refresh === "string" ? t : null;
    } catch {
      return null;
    }
  }
}
