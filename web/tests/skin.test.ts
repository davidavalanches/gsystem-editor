import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chooseSkin, currentSkin } from "../src/ui/skin";

describe("panel finish per G-System", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    const attrs = new Map<string, string>();
    vi.stubGlobal("document", { documentElement: { dataset: {}, removeAttribute: (a: string) => attrs.delete(a) } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps each G-System's own finish", () => {
    expect(currentSkin("gsystem-editor.skin.u1")).toBe("grey");
    chooseSkin("red", "gsystem-editor.skin.u1");
    chooseSkin("black", "gsystem-editor.skin.u2");
    expect(currentSkin("gsystem-editor.skin.u1")).toBe("red");
    expect(currentSkin("gsystem-editor.skin.u2")).toBe("black");
  });

  it("gives a G-System without one the last finish picked", () => {
    chooseSkin("red", "gsystem-editor.skin.u1");
    expect(currentSkin("gsystem-editor.skin.u3")).toBe("red");
    expect(currentSkin()).toBe("red");
  });
});
