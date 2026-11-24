import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  root: "web",
  base: "./",
  // The app's version, shown in the More actions menu and the MIDI view.
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: { outDir: "../dist", emptyOutDir: true },
  test: { root: ".", include: ["web/tests/**/*.test.ts"] },
});
