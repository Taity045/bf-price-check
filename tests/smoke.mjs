// Post-deploy smoke test against the live site. Exits non-zero on any failure.
// Usage: node tests/smoke.mjs [BASE]   (default: the workers.dev address)
const BASE = (process.argv[2] || process.env.BASE || "https://bf-price-check.tm-deal-lab.workers.dev").replace(/\/$/, "");
const UA = { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 bf-smoke" };
// Stable examples from shops that passed live tests; one ok answer is enough.
const EXAMPLES = [
  "https://www.evetech.co.za/amd-ryzen-5-5500-intel-arc-b580-budget-gaming-pc-16gb-512gb-nvme/best-pc-deal/22997",
  "https://www.mediamarkt.de/de/product/_samsung-galaxy-a57-256-gb-awesome-gray-dual-sim-3039261.html",
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (name, pass, info = "") => { console.log(`${pass ? "PASS" : "FAIL"} ${name}${info ? " — " + info : ""}`); if (!pass) failures.push(name); };
const get = (path, init = {}) => fetch(BASE + path, { ...init, headers: { ...UA, ...(init.headers || {}) }, signal: AbortSignal.timeout(45000) });

// 1. home page (allow a short time for the new version to reach every location)
let home = { status: "no answer" }, html = "";
for (let i = 0; i < 6; i++) {
  try { home = await get("/"); html = await home.text(); if (home.status === 200 && html.includes("Deal or Dud")) break; } catch (e) { home = { status: String(e) }; }
  await sleep(5000);
}
check("home page answers 200", home.status === 200, `HTTP ${home.status}`);
check("home page is the app", html.includes("Deal or Dud") && /<script src="\/app\.[0-9a-f]{10}\.js"/.test(html));
const js = html.match(/\/app\.[0-9a-f]{10}\.js/);
if (js) { const r = await get(js[0]); check("app script loads", r.ok && /javascript/.test(r.headers.get("content-type") || ""), `HTTP ${r.status}`); }

// 2. a live price check
let checked = null;
for (const url of EXAMPLES) {
  try {
    const r = await get("/api/check?url=" + encodeURIComponent(url));
    const d = await r.json();
    console.log(`  ${new URL(url).hostname}: HTTP ${r.status}, status ${d.current && d.current.status}, price ${d.current && d.current.price} ${d.current && d.current.currency}${d.cached ? " (cached)" : ""}`);
    if (r.status === 200 && d.current && d.current.status === "ok" && d.current.price > 0) { checked = d; break; }
  } catch (e) { console.log(`  ${url}: ${e}`); }
}
check("/api/check returns a price for a known product", !!checked);

// 3. input validation
const priv = await get("/api/check?url=" + encodeURIComponent("http://127.0.0.1/admin"));
check("/api/check refuses a private address (400)", priv.status === 400, `HTTP ${priv.status}`);
const form = await get("/api/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shop: "" }) });
check("/api/request refuses bad input (400)", form.status === 400, `HTTP ${form.status}`);
const badJson = await get("/api/request", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
check("/api/request refuses broken JSON (400)", badJson.status === 400, `HTTP ${badJson.status}`);

// 4. archive prices: the load endpoint is hidden without its key; the stats answer
const load = await get("/api/admin/archive-load", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer wrong-key-for-smoke-test-0000000000000" }, body: JSON.stringify({ rows: [] }) });
check("/api/admin/archive-load is hidden without the key (404)", load.status === 404, `HTTP ${load.status}`);
const ast = await get("/api/archive-stats");
const astJ = await ast.json().catch(() => null);
check("/api/archive-stats answers", ast.status === 200 && astJ && typeof astJ.rows === "number", `HTTP ${ast.status}${astJ ? `, ${astJ.rows} rows` : ""}`);
if (checked) check("/api/check has the Common Crawl history list", Array.isArray(checked.history && checked.history.cc));

if (failures.length) { console.error(`\nSMOKE TEST FAILED on ${BASE}: ${failures.join("; ")}`); process.exit(1); }
console.log(`\nSmoke test passed on ${BASE}`);
