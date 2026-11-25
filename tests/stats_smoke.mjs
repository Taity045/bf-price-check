// Post-deploy check of the private stats host: it must never be readable without Cloudflare Access.
// Pass: 403 from the worker (no valid Access sign-in), or a redirect to the Access login page.
// Fail: any 200 or other answer that is not one of those. A host that does not answer yet (new
// custom domain, certificate still being issued) is a warning, not a failure.
// Usage: node tests/stats_smoke.mjs [https://stats.veldwire.com] [https://eish.veldwire.com]
const STATS = (process.argv[2] || "https://stats.veldwire.com").replace(/\/$/, "");
const SITE = (process.argv[3] || "https://eish.veldwire.com").replace(/\/$/, "");
const UA = { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 bf-smoke" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (name, pass, info = "") => { console.log(`${pass ? "PASS" : "FAIL"} ${name}${info ? " — " + info : ""}`); if (!pass) failures.push(name); };
const protectedAnswer = (r) => r.status === 403 || (r.status >= 300 && r.status < 400 && /\.cloudflareaccess\.com\//.test(r.headers.get("location") || ""));

for (const path of ["/", "/api/data", "/?days=90"]) {
  let r = null, err = "";
  for (let i = 0; i < 12; i++) {
    try { r = await fetch(STATS + path, { headers: UA, redirect: "manual", signal: AbortSignal.timeout(15000) }); if (r.status < 500) break; } catch (e) { err = String(e.cause?.code || e.message || e); r = null; }
    await sleep(10000);
  }
  if (!r) { console.log(`::warning title=Stats host not answering yet::${STATS}${path}: ${err}. A new custom domain can take a few minutes.`); continue; }
  const body = await r.text();
  check(`${STATS}${path} is private (403 or Access login)`, protectedAnswer(r) && !body.includes("Price checks"), `HTTP ${r.status}${r.headers.get("location") ? " → " + r.headers.get("location").slice(0, 60) : ""}`);
  if (r.status === 403) check(`${STATS}${path} is not cached`, /no-store/.test(r.headers.get("cache-control") || ""));
}
const fake = await fetch(STATS + "/", { headers: { ...UA, "cf-access-jwt-assertion": "aaa.bbb.ccc" }, redirect: "manual" }).catch(() => null);
if (fake) check("a made-up Access token is refused", protectedAnswer(fake), `HTTP ${fake.status}`);
const dev = await fetch(SITE + "/__stats/api/data", { headers: UA }).catch(() => null);
if (dev) check("the local-only dev shortcut is closed on the live site", dev.status === 404, `HTTP ${dev.status}`);
const beacon = await fetch(SITE + "/api/m", { method: "POST", headers: UA, body: "nothing" }).catch(() => null);
if (beacon) check("click counter answers 204", beacon.status === 204, `HTTP ${beacon.status}`);

if (failures.length) { console.error(`\nSTATS SMOKE TEST FAILED: ${failures.join("; ")}`); process.exit(1); }
console.log("\nStats smoke test passed");
