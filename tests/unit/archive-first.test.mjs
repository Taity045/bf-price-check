// upload --first: the products people check go first (even below --min-pri), then listed shops in order.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const row = (key, shop, pri) => JSON.stringify({ key, shop, pri, segs: [{ captured_at: 1790000000000, last_seen: 1790000000000, n: 1, price: 10, was: null, currency: "ZAR", url: key, crawl: "CC-MAIN-2026-39" }] });
function stub() {
  const got = [];
  const srv = http.createServer((q, s) => { let b = ""; q.on("data", (c) => (b += c)); q.on("end", () => { const rows = JSON.parse(b).rows; got.push(...rows.map((r) => r.key)); s.setHeader("content-type", "application/json"); s.end(JSON.stringify({ written: rows.length, cap_left: 99999 })); }); });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok({ srv, got, url: `http://127.0.0.1:${srv.address().port}/` })));
}
const run = (args) => new Promise((ok, no) => execFile("node", ["scripts/cc/archive.mjs", ...args], { env: { ...process.env, ARCHIVE_LOAD_KEY: "test-key" } }, (e, out) => (e ? no(e) : ok(out))));

test("upload --first sends listed products first, then listed shops, then the usual order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "first-"));
  writeFileSync(join(dir, "rows.jsonl"), [
    row("https://www.loot.co.za/product/a/1", "Loot", 3), row("https://www.evetech.co.za/x/best-deal/2", "Evetech", 3),
    row("https://www.bash.com/b/p", "Bash (TFG)", 1), row("https://www.evetech.co.za/checked/best-deal/9", "Evetech", 0),
  ].join("\n") + "\n");
  writeFileSync(join(dir, "first.json"), JSON.stringify({ keys: ["https://www.evetech.co.za/checked/best-deal/9"], shops: ["Bash (TFG)", "Evetech"] }));
  const s = await stub();
  try {
    await run(["upload", "--out", dir, "--endpoint", s.url, "--min-pri", "1", "--first", join(dir, "first.json"), "--batch", "1"]);
    assert.deepEqual(s.got, ["https://www.evetech.co.za/checked/best-deal/9", "https://www.bash.com/b/p", "https://www.evetech.co.za/x/best-deal/2", "https://www.loot.co.za/product/a/1"]);
    // the next run sends nothing again
    s.got.length = 0;
    await run(["upload", "--out", dir, "--endpoint", s.url, "--first", join(dir, "first.json")]);
    assert.deepEqual(s.got, []);
  } finally { s.srv.close(); }
});

test("upload without --first keeps the usual order and --min-pri", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nofirst-"));
  writeFileSync(join(dir, "rows.jsonl"), [row("https://www.loot.co.za/product/a/1", "Loot", 3), row("https://www.evetech.co.za/checked/best-deal/9", "Evetech", 0)].join("\n") + "\n");
  const s = await stub();
  try {
    await run(["upload", "--out", dir, "--endpoint", s.url, "--min-pri", "1"]);
    assert.deepEqual(s.got, ["https://www.loot.co.za/product/a/1"]);
  } finally { s.srv.close(); }
});

test("collect --keys reads only the listed links (source check)", () => {
  const src = readFileSync("scripts/cc/archive.mjs", "utf8");
  assert.match(src, /\(wanted && !wanted\.has\(key\)\)/);
  assert.match(src, /shops = shops\.filter\(\(s\) => \[\.\.\.wanted\]\.some\(\(k\) => inShop\(s, k\)\)\)/);
});
