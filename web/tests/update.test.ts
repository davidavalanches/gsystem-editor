import { describe, expect, it, vi } from "vitest";
vi.mock("../src/ui/dialog", () => ({ showChoices: vi.fn() }));
vi.mock("../src/ui/quit", () => ({ openUrl: vi.fn() }));

import { assetFor, isNewer, parseVersion, type ReleaseAsset } from "../src/ui/update";

const asset = (name: string): ReleaseAsset => ({ name, browser_download_url: `https://x/${name}`, size: 1 });
// Named as GitHub publishes them (spaces become dots).
const ASSETS = [
  "gsystem-editor-1.0.10.apk",
  "G-System.Editor-1.0.10.AppImage",
  "G-System.Editor-1.0.10-arm64-mac.zip",
  "G-System.Editor-1.0.10-mac.zip",
  "G-System.Editor.1.0.10.exe",
  "G-System.Editor-1.0.10-win.zip",
].map(asset);

describe("update", () => {
  it("compares versions number by number", () => {
    expect(parseVersion("v1.0.10")).toEqual([1, 0, 10]);
    expect(parseVersion("next")).toBeNull();
    expect(isNewer("v1.0.10", "1.0.9")).toBe(true);
    expect(isNewer("v1.1", "1.0.10")).toBe(true);
    expect(isNewer("v1.0.10", "1.0.10")).toBe(false);
    expect(isNewer("v1.0.9", "1.0.10")).toBe(false);
    expect(isNewer("v1.0.10", "1.0.10.0")).toBe(false);
    expect(isNewer("garbage", "1.0.9")).toBe(false);
  });

  it("picks the file for each platform", () => {
    expect(assetFor("android", ASSETS)?.name).toBe("gsystem-editor-1.0.10.apk");
    expect(assetFor("linux", ASSETS)?.name).toBe("G-System.Editor-1.0.10.AppImage");
    expect(assetFor("windows", ASSETS)?.name).toBe("G-System.Editor.1.0.10.exe");
    expect(assetFor("mac-arm64", ASSETS)?.name).toBe("G-System.Editor-1.0.10-arm64-mac.zip");
    expect(assetFor("mac-x64", ASSETS)?.name).toBe("G-System.Editor-1.0.10-mac.zip");
    expect(assetFor("mac", ASSETS)).toBeNull();
    expect(assetFor("android", [])).toBeNull();
  });
});
