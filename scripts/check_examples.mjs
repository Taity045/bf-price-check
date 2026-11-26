// Live check of the home page picks (examples.json): each link must give a price through our own checker.
// Usage: node scripts/check_examples.mjs [BASE]   (default https://eish.veldwire.com). Exits 1 if one fails.
// Slow on purpose (one check every 4 s, under our limit of 20 checks a minute) so it is polite to the shops.
import { readFileSync } from "node:fs";
const BASE = (process.argv[2] || "https://eish.veldwire.com").replace(/\/$/, "");
const ex = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const items = [...new Map(ex.groups.flatMap((g) => g.items).map((i) => [i.url, i])).values()];
const bad = [];
for (const it of items) {
  let line;
  try {
    let r;
    for (let i = 0; i < 3; i++) {   // our own rate limit (429): wait a minute and try again
      r = await fetch(BASE + "/api/check?url=" + encodeURIComponent(it.url), { signal: AbortSignal.timeout(45000) });
      if (r.status !== 429) break;
      await new Promise((ok) => setTimeout(ok, 61000));
    }
    const d = await r.json();
    const c = d.current || {};
    const ok = r.status === 200 && c.status === "ok" && c.price > 0 && !d.blocked_shop;
    line = `${ok ? "OK  " : "FAIL"} ${it.shop.padEnd(20)} ${String(c.price ?? "-").padStart(9)} ${c.currency || ""}  ${it.name}${ok ? "" : "  (" + (c.error || d.error || c.status || r.status) + ")"}`;
    if (!ok) bad.push(it.url);
  } catch (e) { line = `FAIL ${it.shop} ${it.name} (${e})`; bad.push(it.url); }
  console.log(line);
  await new Promise((r) => setTimeout(r, 4000));
}
console.log(`\n${items.length - bad.length}/${items.length} picks give a live price on ${BASE}`);
if (bad.length) { console.log("Failed:\n" + bad.join("\n")); process.exit(1); }
