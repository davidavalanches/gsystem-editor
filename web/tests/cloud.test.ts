import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dropbox } from "../src/cloud/dropbox";
// The dialogs need a page; a conflict here would show one.
vi.mock("../src/ui/dialog", () => ({ showChoices: vi.fn(), askText: vi.fn() }));

import { showChoices } from "../src/ui/dialog";
import { CloudSync, parseSession, sessionHash, type CloudHost, type SessionContent } from "../src/ui/cloud";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

let calls: Call[];
let replies: ((call: Call) => Response)[];
let store: Map<string, string>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const fileMeta = (rev: string) => ({ ".tag": "file", path_display: "/gsystem-id-1.json", name: "gsystem-id-1.json", rev,
  server_modified: "2026-11-24T10:00:00Z" });
const linked = (expires = Date.now() + 3_600_000) =>
  store.set("gsystem-editor.dropbox", JSON.stringify({ refresh: "R", access: "A", expires }));
const arg = (c: Call) => JSON.parse(c.headers["Dropbox-API-Arg"]);

beforeEach(() => {
  vi.mocked(showChoices).mockClear();
  calls = [];
  replies = [];
  store = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal("document", { addEventListener: () => {}, visibilityState: "visible" });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const call = { url, headers: (init.headers ?? {}) as Record<string, string>, body: init.body };
    calls.push(call);
    const reply = replies.shift();
    if (!reply) throw new Error(`unexpected call ${url}`);
    return reply(call);
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("Dropbox link", () => {
  it("asks for a code with PKCE, then trades it with the verifier", async () => {
    const dropbox = new Dropbox("KEY");
    const url = new URL(await dropbox.authorizeUrl());
    expect(url.searchParams.get("client_id")).toBe("KEY");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("token_access_type")).toBe("offline");
    expect(url.searchParams.has("redirect_uri")).toBe(false);
    replies.push(() => json({ access_token: "A", refresh_token: "R", expires_in: 14400 }),
      () => json({ name: { display_name: "David" } }));
    expect(await dropbox.finishLink(" CODE ")).toBe("David");
    const sent = calls[0].body as URLSearchParams;
    expect(sent.get("code")).toBe("CODE");
    expect(sent.get("code_verifier")).toMatch(/^[\w-]{43,}$/);
    expect(calls[1].headers.Authorization).toBe("Bearer A");
    expect(JSON.parse(store.get("gsystem-editor.dropbox")!)).toMatchObject({ refresh: "R", account: "David" });
  });

  it("renews an expired access token, once for calls made together", async () => {
    linked(0);
    const dropbox = new Dropbox("KEY");
    replies.push(() => json({ access_token: "B", expires_in: 14400 }), () => json(fileMeta("r1")), () => json(fileMeta("r1")));
    await Promise.all([dropbox.metadata("/gsystem-id-1.json"), dropbox.metadata("/gsystem-id-1.json")]);
    expect(calls.filter((c) => c.url.endsWith("/oauth2/token"))).toHaveLength(1);
    expect(calls[1].headers.Authorization).toBe("Bearer B");
  });

  it("forgets the link when Dropbox withdrew access", async () => {
    linked(0);
    const dropbox = new Dropbox("KEY");
    replies.push(() => json({ error: "invalid_grant" }, 400));
    await expect(dropbox.metadata("/x.json")).rejects.toThrow(/link it again/);
    expect(dropbox.linked).toBe(false);
  });

  it("tells a conflict and a missing file apart", async () => {
    linked();
    const dropbox = new Dropbox("KEY");
    replies.push(() => json({ error_summary: "path/conflict/file/.." }, 409), () => json({ error_summary: "path/not_found/.." }, 409));
    await expect(dropbox.upload("/x.json", "{}", { replaces: "r0" })).rejects.toMatchObject({ conflict: true });
    expect(await dropbox.metadata("/x.json")).toBeNull();
  });
});

describe("session backup", () => {
  let content: SessionContent;
  let notices: string[];
  const unit = { key: "u1", sysexId: 1, name: "G-System (ID 1)" };
  const host = (): CloudHost => ({
    unit: () => unit, units: () => [unit], content: () => content, apply: () => {}, busy: () => null,
    notify: (t) => void notices.push(t),
  });

  beforeEach(() => {
    vi.useFakeTimers();
    content = { sysexId: 1, unitName: unit.name, storage: { "gsystem-editor.session": "{}" }, draft: null };
    notices = [];
    linked();
    store.set("gsystem-editor.cloud-auto", "1");
  });
  afterEach(() => vi.useRealTimers());

  it("creates the file, then replaces only its own revision and only when something changed", async () => {
    const sync = new CloudSync(host());
    replies.push(() => json(fileMeta("r1")));
    await sync.autoSave();
    expect(arg(calls[0])).toMatchObject({ path: "/gsystem-id-1.json", mode: "add", autorename: false });
    const saved = parseSession(new TextDecoder().decode(calls[0].body as Uint8Array));
    expect(saved).toMatchObject({ format: 1, sysexId: 1, storage: content.storage, draft: null });

    await sync.autoSave();
    expect(calls).toHaveLength(1);

    content = { ...content, draft: { slot: 4, syx: "AAAA" } };
    replies.push(() => json(fileMeta("r2")));
    await sync.autoSave();
    expect(arg(calls[1]).mode).toEqual({ ".tag": "update", update: "r1" });
  });

  it("asks before replacing a session saved meanwhile by another device, and holds the backup until then", async () => {
    store.set("gsystem-editor.cloud.u1", JSON.stringify({ path: "/gsystem-id-1.json", rev: "r1", hash: "old" }));
    const sync = new CloudSync(host());
    replies.push(() => json({ error_summary: "path/conflict/file/.." }, 409), () => json(fileMeta("r7")));
    await sync.autoSave();
    expect(arg(calls[0]).mode).toEqual({ ".tag": "update", update: "r1" });
    expect(vi.mocked(showChoices)).toHaveBeenCalledOnce();
    const [title, choices] = vi.mocked(showChoices).mock.calls[0];
    expect(title).toContain("another session is on Dropbox");
    expect(choices.map((c) => c.label)).toEqual(["Restore the Dropbox session", "Keep this device's session", "Decide later"]);
    content = { ...content, unitName: "changed" };
    await sync.autoSave();
    expect(calls).toHaveLength(2);
    replies.push(() => json(fileMeta("r8")));
    choices[1].run();
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(arg(calls[2]).mode).toBe("overwrite");
  });

  it("says once that automatic backup fails, then again only after it worked", async () => {
    const sync = new CloudSync(host());
    replies.push(() => { throw new TypeError("offline"); });
    await sync.autoSave();
    replies.push(() => { throw new TypeError("offline"); });
    await sync.autoSave();
    expect(notices).toEqual(["Dropbox backup failed: Dropbox cannot be reached (offline?). Tried again automatically."]);
  });

  it("fingerprints the content, not when it was saved", () => {
    expect(sessionHash(content)).toBe(sessionHash({ ...content }));
    expect(sessionHash(content)).not.toBe(sessionHash({ ...content, unitName: "Other" }));
  });

  it("refuses a file that is not a session", () => {
    expect(() => parseSession('{"format":2,"sysexId":1,"storage":{}}')).toThrow(/not a G-System Editor session/);
    expect(() => parseSession('{"format":1,"sysexId":200,"storage":{}}')).toThrow();
  });
});
