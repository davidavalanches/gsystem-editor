#!/usr/bin/env node
/**
 * Downloads of the GitHub releases, by version and platform (GitHub's own counters of each attached file).
 *
 *   node scripts/downloads.mjs                 table by version and platform
 *   node scripts/downloads.mjs --log FILE.csv  also append today's totals to a CSV, to follow them over time
 *
 * The counters cover every download of a file: from the releases page, from the site's buttons (which point
 * to releases/latest) or from a direct link. GitHub does not tell them apart, nor people from robots.
 */

import { appendFileSync, existsSync } from "node:fs";

const REPO = "davidavalanches/gsystem-editor";
const PLATFORMS = [
  ["Android", (n) => n.endsWith(".apk")],
  ["Mac Apple Silicon", (n) => n.endsWith("-arm64-mac.zip")],
  ["Mac Intel", (n) => n.endsWith("-mac.zip")],
  ["Windows exe", (n) => n.endsWith(".exe")],
  ["Windows zip", (n) => n.endsWith("-win.zip")],
  ["Linux", (n) => n.endsWith(".AppImage")],
];
const platformOf = (name) => PLATFORMS.find(([, test]) => test(name))?.[0] ?? "Other";

async function releases() {
  const all = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "gsystem-editor-downloads" },
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} ${res.statusText}`);
    const batch = await res.json();
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}

const list = await releases();
const columns = [...PLATFORMS.map(([p]) => p), "Other"];
const rows = list.map((r) => {
  const counts = Object.fromEntries(columns.map((c) => [c, 0]));
  for (const a of r.assets) counts[platformOf(a.name)] += a.download_count;
  return { tag: r.tag_name, date: (r.published_at ?? "").slice(0, 10), counts };
});
const used = columns.filter((c) => rows.some((r) => r.counts[c]));
const total = (r) => used.reduce((s, c) => s + r.counts[c], 0);
const sums = Object.fromEntries(used.map((c) => [c, rows.reduce((s, r) => s + r.counts[c], 0)]));
const grand = Object.values(sums).reduce((a, b) => a + b, 0);

const head = ["Version", "Published", ...used, "Total"];
const body = rows.map((r) => [r.tag, r.date, ...used.map((c) => String(r.counts[c])), String(total(r))]);
const foot = ["All", "", ...used.map((c) => String(sums[c])), String(grand)];
const widths = head.map((h, i) => Math.max(h.length, ...[...body, foot].map((l) => l[i].length)));
const line = (cells) => cells.map((c, i) => (i < 2 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
console.log(line(head));
console.log(widths.map((w) => "-".repeat(w)).join("  "));
body.forEach((l) => console.log(line(l)));
console.log(widths.map((w) => "-".repeat(w)).join("  "));
console.log(line(foot));

const logAt = process.argv.indexOf("--log");
if (logAt > 0) {
  const file = process.argv[logAt + 1];
  if (!file) throw new Error("--log needs a CSV file name");
  const today = new Date().toISOString().slice(0, 10);
  const lines = [];
  if (!existsSync(file)) lines.push(["date", "version", ...columns, "total"].join(","));
  for (const r of rows) lines.push([today, r.tag, ...columns.map((c) => r.counts[c]), columns.reduce((s, c) => s + r.counts[c], 0)].join(","));
  appendFileSync(file, lines.join("\n") + "\n");
  console.log(`\n${rows.length} lines added to ${file}`);
}
