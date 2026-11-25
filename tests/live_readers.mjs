// Live check of the shop readers on real products.
// Usage: node tests/live_readers.mjs            -> runs the readers here (this machine's network)
//        node tests/live_readers.mjs <BASE>     -> asks the deployed site (/api/check?fresh=1), Cloudflare's network
import fs from "fs";
const BASE = process.argv[2];
const rows = fs.readFileSync(new URL("./live_readers.txt", import.meta.url), "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(" | ").map((x) => x.trim()));
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const KEY = process.env.E2E_KEY || (fs.existsSync("/workspace/bf-secrets/e2e_key") ? fs.readFileSync("/workspace/bf-secrets/e2e_key", "utf8").trim() : "");
let W = null;
if (!BASE) W = (await import("./helpers/load-worker.mjs")).W;
const out = [];
for (const [shop, url] of rows) {
  // The site allows 20 checks a minute per visitor: keep a gap, and wait once if it says "too many".
  if (BASE) await new Promise((ok) => setTimeout(ok, +(process.env.GAP_MS || 3500)));
  const t0 = Date.now();
  let c;
  try {
    if (W) { const v = W.validateUrl(url).url; c = await W.getCurrent(W.canonicalize(v), v.href, v.hostname); }
    else {
      let r = await fetch(`${BASE}/api/check?fresh=1&url=${encodeURIComponent(url)}`, { headers: { "user-agent": UA, ...(KEY ? { "x-e2e-key": KEY } : {}) } });
      if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 61000)); r = await fetch(`${BASE}/api/check?fresh=1&url=${encodeURIComponent(url)}`, { headers: { "user-agent": UA, ...(KEY ? { "x-e2e-key": KEY } : {}) } }); }
      const d = await r.json(); c = d.current || { status: "error", message: d.error || r.status }; }
  } catch (e) { c = { status: "error", message: String(e).slice(0, 80) }; }
  const ms = Date.now() - t0;
  const ok = c.status === "ok" && c.price > 0;
  out.push({ shop, url, ok, price: c.price, was: c.was, currency: c.currency, source: c.source, title: c.title, ms, message: c.message });
  console.log(`${ok ? "OK  " : "FAIL"} ${shop.padEnd(16)} ${String(c.price ?? "-").padStart(9)} ${String(c.was ?? "").padStart(9)} ${(c.source || c.status || "").padEnd(18)} ${String(ms).padStart(5)}ms ${(c.title || c.message || "").slice(0, 50)}`);
}
const byShop = {};
for (const r of out) (byShop[r.shop] ||= []).push(r.ok);
console.log("\n" + Object.entries(byShop).map(([s, a]) => `${s}: ${a.filter(Boolean).length}/${a.length}`).join(", "));
fs.writeFileSync(process.env.OUT || "/tmp/live_readers.json", JSON.stringify(out, null, 1));
process.exit(out.every((r) => r.ok) ? 0 : 1);
