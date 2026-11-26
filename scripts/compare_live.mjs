// Live compare test from this machine: checks real products, then searches every planned shop.
// Usage: node scripts/compare_live.mjs URL [URL...]   (or LIST=file with one URL per line)
// Prints one line per shop and writes compare-live.json. Talks to real shops; run it sparingly.
// AI_PROBE=1: a fake env.AI that answers "unsure" and prints which candidates would go to the AI check
// (no Workers AI call; the rule result is shown).
import { readFileSync, writeFileSync } from "node:fs";
import { W } from "../tests/helpers/load-worker.mjs";
import { testDb } from "../tests/helpers/db.mjs";

const urls = process.argv.slice(2).concat(process.env.LIST ? readFileSync(process.env.LIST, "utf8").split("\n").map((x) => x.trim()).filter((x) => x && !x.startsWith("#")) : []);
const { env } = testDb();
if (process.env.AI_PROBE) env.AI = { async run(model, input) { console.log("  AI would check:\n    " + input.messages[1].content.replace(/\n/g, "\n    ")); return { response: "{}" }; } };
const out = [];
for (const raw of urls) {
  const v = W.validateUrl(raw);
  const ci = W.canonicalize(v.url);
  const cur = await W.getCurrent(ci, v.url.href, v.url.hostname);
  if (cur.status !== "ok") { console.log(`\n# ${raw}\n  source: ${cur.status} ${cur.message || ""}`); out.push({ url: raw, source: cur }); continue; }
  const id = await W.cmpIdentityFromCurrent(cur, ci.canon);
  const plan = W.cmpPlan(id, v.url.hostname, id.currency);
  console.log(`\n# ${cur.title} | ${cur.price} ${id.currency} | brand=${id.brand} gtin=${id.gtin} codes=${id.codes.join(",")} cat=${plan.category}\n  query: ${W.cmpQuery(id)}`);
  const rows = await Promise.all(plan.shops.map(async (s) => {
    const shop = W.CMP_SHOPS.find((x) => x.id === s.id);
    const t0 = Date.now();
    let r; try { r = await W.cmpSearchShop(env, shop, id); } catch (e) { r = { status: "crash", message: String(e) }; }
    return { shop: s.id, ms: Date.now() - t0, ...r };
  }));
  for (const r of rows) console.log(`  ${r.shop.padEnd(15)} ${r.status.padEnd(7)} ${String(r.ms).padStart(5)}ms ${r.match ? `${r.match.level.padEnd(7)} ${r.match.price} ${r.match.in_stock ? "" : "(out of stock) "}${r.match.title} ${r.match.url}` : (r.message || "") + (r.candidates != null ? ` candidates=${r.candidates}` : "")}${r.ai ? ` ai=${JSON.stringify(r.ai)}` : ""}`);
  out.push({ url: raw, source: { title: cur.title, price: cur.price, currency: id.currency, gtin: id.gtin, codes: id.codes, brand: id.brand }, category: plan.category, shops: rows });
}
writeFileSync(process.env.OUT || "compare-live.json", JSON.stringify(out, null, 1));
