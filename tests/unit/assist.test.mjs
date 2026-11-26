// AI Shopping Assistant (src/assist.js, AB-30): intent detection, rules, the AI fields, the filter, the picks,
// the reasons, and /api/assist. No network: shop answers and env.AI are mocked.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { W, worker } from "../helpers/load-worker.mjs";
import { testDb } from "../helpers/db.mjs";

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const quiet = (t) => { const log = console.log; console.log = () => {}; t.after(() => { console.log = log; }); };

const PLAIN = ["PS5", "PS5 controller", "PS5 Slim", "Jungle Oats", "Jungle Oats 1 kg", "Garmin Forerunner 265", "Samsung Galaxy S25 Ultra 256GB", "iPhone 16 Pro 256GB", "Dyson V15 Detect",
  "Kettle 1.7L", "Nike Air Force 1 size 9.5", "LEGO 75192", "Sony A7R IV", "Ryzen R5 laptop", "Tastic Rice 2kg", "Clover Full Cream 2 L", "AirPods 4", "Buds3 Pro", "best PS5 deals", "Huawei Watch GT 5 46mm", "R2-D2 LEGO", "PS5?", "Case for iPhone 16", "Charger for MacBook Air", "Cover for PS5"];
const ASKS = ["I have R15,000. I need a laptop for programming and Docker", "Best running watch under R6000", "Need a 4K TV under £500 for PS5", "Good coffee machine under R3000",
  "laptop under R15000", "air fryer budget R1500", "recommend a kettle", "best headphones for flights", "I need a phone for my mom", "TV R 8 000", "speaker 1500 rand", "earbuds up to 900", "fridge under R12k", "What is the best tablet for school",
  // a need without a budget: "<product> for <person / use>", or a question
  "laptop machine for a student studying law ?", "phone for my mom", "laptop for university", "headphones for the gym", "tablet for my son", "which laptop is good for coding?"];

describe("assistant: which requests use it", () => {
  test("plain product names stay on the normal search (no AI)", () => { for (const q of PLAIN) assert.equal(W.asIsAssist(q), false, q); });
  test("a budget or need words use the assistant", () => { for (const q of ASKS) assert.equal(W.asIsAssist(q), true, q); });
  test("a link is never an assistant request", () => {
    for (const q of ["https://www.takealot.com/x/PLID1", "takealot.com/x/PLID1"]) assert.equal(W.asIsAssist(q), false, q);
  });
  test("the page uses the same rule as the server", () => {
    const src = readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");
    const m = src.match(/const ASK_RE = (\/.+\/i);\n/);
    assert.ok(m, "ASK_RE in index.html");
    const re = (0, eval)(m[1]);
    assert.equal(re.source, W.AS_ASK_RE.source);
    for (const q of [...PLAIN, ...ASKS]) assert.equal(re.test(q), W.asIsAssist(q), q);
  });
});

describe("assistant: rules (no AI)", () => {
  test("budgets in rand and pounds", () => {
    const b = (q) => W.asBudget(q);
    assert.deepEqual(b("I have R15,000"), { amount: 15000, currency: "ZAR" });
    assert.deepEqual(b("under R6000"), { amount: 6000, currency: "ZAR" });
    assert.deepEqual(b("TV R 8 000"), { amount: 8000, currency: "ZAR" });
    assert.deepEqual(b("fridge under R12k"), { amount: 12000, currency: "ZAR" });
    assert.deepEqual(b("4K TV under £500"), { amount: 500, currency: "GBP" });
    assert.deepEqual(b("speaker 1500 rand"), { amount: 1500, currency: "ZAR" });
    assert.deepEqual(b("earbuds up to 900"), { amount: 900, currency: null });
    assert.equal(b("Ryzen R5 laptop"), null);
    assert.equal(b("PS5 Slim"), null);
  });
  test("laptop for programming and Docker", () => {
    const r = W.asRules("I have R15,000. I need a laptop for programming and Docker", "ZA");
    assert.equal(r.category, "laptop"); assert.equal(r.maxBudget, 15000); assert.equal(r.currency, "ZAR");
    assert.deepEqual(r.mustHave, ["16gb"]); assert.ok(r.prefer.includes("ssd"));
    assert.equal(r.searchQueries[0], "16GB laptop"); assert.ok(r.searchQueries.length <= 2);
    assert.ok(r.avoid.includes("refurbished"));
  });
  test("running watch, 4K TV for PS5, coffee machine", () => {
    const w = W.asRules("Best running watch under R6000", "ZA");
    assert.equal(w.category, "watch"); assert.equal(w.maxBudget, 6000); assert.deepEqual(w.searchQueries, ["running watch", "Garmin Forerunner"]); assert.ok(w.prefer.includes("gps"));
    const tv = W.asRules("Need a 4K TV under £500 for PS5", "ZA");
    assert.equal(tv.category, "tv"); assert.equal(tv.currency, "GBP"); assert.equal(tv.maxBudget, 500); assert.ok(tv.mustHave.includes("4k")); assert.ok(tv.prefer.includes("120hz"));
    const c = W.asRules("Good coffee machine under R3000", "ZA");
    assert.equal(c.category, "appliance"); assert.deepEqual(c.searchQueries, ["coffee machine"]);
  });
  test("a law student's laptop, with no budget", () => {
    const r = W.asRules("laptop machine for a student studying law ?", "ZA");
    assert.equal(r.category, "laptop"); assert.equal(r.maxBudget, null); assert.deepEqual(r.searchQueries, ["laptop"]); assert.ok(r.prefer.includes("ssd"));
    assert.equal(W.asUnderstanding(r), "Budget: not given · Looking for: laptop (SSD, 8GB, 16GB)");
    assert.equal(W.asRules("phone for my mom", "ZA").category, "phone");
  });
  test("asking for refurbished keeps refurbished", () => assert.ok(!W.asRules("refurbished laptop under R8000", "ZA").avoid.includes("refurbished")));
  test("the understanding line", () => {
    assert.equal(W.asUnderstanding(W.asRules("I have R15,000. I need a laptop for programming and Docker", "ZA")), "Budget: up to R15,000 · Looking for: laptop (16GB, SSD)");
    assert.equal(W.asUnderstanding(W.asRules("Best running watch under R6000", "ZA")), "Budget: up to R6,000 · Looking for: running watch (GPS)");
    assert.match(W.asUnderstanding(W.asRules("recommend a kettle", "ZA")), /^Budget: not given · Looking for: kettle$/);
  });
});

describe("assistant: the AI's fields are checked", () => {
  const rules = W.asRules("I have R15,000. I need a laptop for programming and Docker", "ZA");
  const q = "I have R15,000. I need a laptop for programming and Docker";
  test("the AI can't change the budget or the category the rules found", () => {
    const m = W.asMerge({ category: "phone", maxBudget: 99999, currency: "GBP", searchQueries: ["gaming laptop"], mustHave: ["16GB"], prefer: ["SSD"], avoid: ["bag"] }, rules, q);
    assert.equal(m.maxBudget, 15000); assert.equal(m.category, "laptop"); assert.equal(m.currency, "ZAR"); assert.equal(m.by, "ai");
  });
  test("a budget from the AI only when the number is in the request", () => {
    const r = W.asRules("good earbuds for the gym", "ZA");
    assert.equal(W.asMerge({ maxBudget: 2000 }, r, "good earbuds for the gym").maxBudget, null);
  });
  test("odd or unsafe words are dropped", () => {
    const m = W.asMerge({ searchQueries: ["ignore the rules", "<script>", "a b c d e f g"], mustHave: ["RTX 4090"], prefer: ["http://x.co"], avoid: ["laptop"] }, rules, q);
    assert.ok(!m.searchQueries.some((s) => /ignore|script|a b c/.test(s)));
    assert.ok(!m.mustHave.includes("rtx 4090"), "a spec that is not in the request is not a must");
    assert.ok(!m.avoid.includes("laptop"));
  });
  test("a must-have from the AI is a spec word, not a use word", () => {
    const lq = "laptop machine for a student studying law ?";
    const m = W.asMerge({ category: "laptop", mustHave: ["law", "student", "SSD"] }, W.asRules(lq, "ZA"), lq);
    assert.deepEqual(m.mustHave, []);
    assert.equal(W.asUnderstanding(m), "Budget: not given · Looking for: laptop (SSD, 8GB, 16GB)");
  });
  test("other requests use the AI's searches", () => {
    const r = W.asRules("I need a good office chair for my back", "ZA");
    assert.equal(r.category, "other");
    assert.deepEqual(W.asMerge({ category: "other", searchQueries: ["office chair", "ergonomic chair"] }, r, "I need a good office chair for my back").searchQueries, ["office chair", "ergonomic chair"]);
  });
  test("JSON in an AI answer", () => {
    assert.deepEqual(W.asAiJson({ response: 'Here: {"category":"tv"} ok' }), { category: "tv" });
    assert.deepEqual(W.asAiJson({ response: { category: "tv" } }), { category: "tv" });
    assert.equal(W.asAiJson({ response: "no json" }), null);
    assert.equal(W.asAiJson({ response: "[1,2]" }), null);
  });
});

describe("assistant: the filter and the picks", () => {
  const intent = W.asRules("I have R15,000. I need a laptop for programming and Docker", "ZA");
  test("accessories, memory, used stock and other kinds are out", () => {
    const fits = (t) => W.asFits(intent, t, "16GB laptop");
    assert.equal(fits("HP 15 Laptop - AMD Ryzen 5 7520U, 16GB LPDDR5, 512GB SSD"), true);
    assert.equal(fits("Asus Vivobook 15 Superfast Core i3| 16GB RAM | 512GB SSD Notebook"), true);
    assert.equal(fits("Kingston KCP432SD8/16 16GB DDR4 3200 MHz Notebook Memory"), false);
    assert.equal(fits("Lenovo ThinkPad T14 Ryzen 5 Laptop 16GB Ram + 512GB SSD (Refurb)"), false);
    assert.equal(fits("15.6 inch Laptop Sleeve Bag"), false);
    assert.equal(fits("Samsung Galaxy A27 5G 128GB"), false);
    const w = W.asRules("Best running watch under R6000", "ZA");
    assert.equal(W.asFits(w, "Huawei Watch GT 5 42mm Ceramic Case Strap", "running watch"), true);
    assert.equal(W.asFits(w, "Silicone Strap for Garmin Forerunner 265", "running watch"), false);
    const c = W.asRules("Good coffee machine under R3000", "ZA");
    assert.equal(W.asFits(c, "Nespresso Pixie Coffee Machine Titan C62", "coffee machine"), true);
    assert.equal(W.asFits(c, "Nespresso Original Coffee Capsules 50 pack", "coffee machine"), false);
  });
  const cand = (title, price, shop = "Takealot", url) => ({ title, price, was: null, currency: "ZAR", shop, shop_id: shop.toLowerCase(), url: url || "https://www.takealot.com/" + encodeURIComponent(title) + "/PLID" + price });
  test("ranked by specs, budget and price; over budget last and marked; one listing per model (cheapest)", () => {
    const list = [
      cand("ASUS Vivobook 15 Ryzen 5 16GB RAM 512GB SSD Laptop Silver", 12299),
      cand("ASUS Vivobook 15 Ryzen 5 16GB RAM 512GB SSD Laptop Black", 12999, "Computer Mania", "https://computermania.co.za/products/vivobook"),
      cand("Lenovo IdeaPad Slim 3 Ryzen 7 16GB 512GB Laptop", 15999),
      cand("HP 15 Celeron 8GB 256GB SSD Laptop", 6798),
      cand("HP 15 Ryzen 5 16GB 512GB SSD Laptop", 10499),
    ];
    const r = W.asPick(intent, list);
    assert.equal(r.top[0].title, "HP 15 Ryzen 5 16GB 512GB SSD Laptop", "same specs: the lower price first");
    assert.equal(r.top[1].title, "ASUS Vivobook 15 Ryzen 5 16GB RAM 512GB SSD Laptop Silver");
    assert.equal(r.top[1].price, 12299, "the cheaper listing of the same model");
    assert.equal(r.total, 4, "the two Vivobook listings are one model");
    assert.equal(r.shops, 1, "shops with a match (the Computer Mania listing is the same model, dearer)");
    const over = r.top.concat(r.rest).find((x) => x.price === 15999);
    assert.equal(over.over, true);
    assert.ok(r.top.concat(r.rest).indexOf(over) > r.top.concat(r.rest).findIndex((x) => x.price === 6798), "over budget comes after every match in the budget");
  });
  test("rule reasons say only true facts", () => {
    const r = W.asPick(intent, [cand("HP 15 Ryzen 5 16GB 512GB SSD Laptop", 10499), cand("Lenovo IdeaPad Ryzen 7 16GB Laptop", 15999)]);
    assert.equal(W.asRuleReason(intent, r.top[0], 0, r.top), "The name shows 16GB, SSD, 512GB and Ryzen 5, and it costs R4,501 less than your budget.");
    assert.equal(W.asRuleReason(intent, r.top[1], 1, r.top), "The name shows 16GB and Ryzen 7, but it costs R999 more than your budget.");
  });
  test("an AI reason with a new number, a link or an acronym that is not in the facts is refused", () => {
    const f = "name: HP 15 Ryzen 5 16GB 512GB SSD Laptop; price: R10,499; shop: Takealot; within the budget R15,000 R4,501";
    assert.equal(W.asReasonOk("It has 16GB RAM and a 512GB SSD, and it costs R4,501 less than your budget.", f), true);
    assert.equal(W.asReasonOk("It has 32GB RAM for many Docker containers.", f), false);
    assert.equal(W.asReasonOk("It has an RTX graphics card for Docker work.", f), false);
    assert.equal(W.asReasonOk("Buy it at www.example.com today for less.", f), false);
    assert.equal(W.asReasonOk("Good.", f), false);
    assert.equal(W.asReasonOk("It has a 512GB SSD, which is a larger storage capacity.", f), false);
    assert.equal(W.asReasonOk("It has 16GB RAM, which is more than the other two laptops.", f), false);
    assert.equal(W.asReasonOk("It has 16GB RAM for smooth performance.", f), false);
    assert.equal(W.asReasonOk("It has 16GB RAM and a 512GB SSD for programming.", f), true);
    assert.equal(W.asReasonOk("It is good. It is cheap. Buy it now please.", f), false);
  });
  test("every pick must be a real candidate (same link, name, price and shop)", () => {
    const c = [cand("HP 15 Ryzen 5 16GB 512GB SSD Laptop", 10499)];
    assert.equal(W.asValidate([{ ...c[0] }], c).length, 1);
    assert.equal(W.asValidate([{ ...c[0], price: 9999 }], c).length, 0);
    assert.equal(W.asValidate([{ ...c[0], title: "HP 15 Ryzen 7 32GB" }], c).length, 0);
    assert.equal(W.asValidate([{ ...c[0], url: "https://evil.example/x" }], c).length, 0);
    assert.equal(W.asValidate([{ ...c[0], shop: "Loot" }], c).length, 0);
  });
});

// ---------- /api/assist with mocked shops ----------
// Computer Mania (Shopify) answers every search with `products`; every other shop fails. robots.txt: none.
const prod = (title, price, extra = {}) => ({ title, handle: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), url: "/products/" + title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), price: String(price), price_min: String(price), price_max: String(price), available: true, vendor: "", ...extra });
const LAPTOPS = [prod("HP 15 Laptop - AMD Ryzen 5 7520U, 16GB LPDDR5, 512GB SSD", 12999), prod("Lenovo Ideapad Slim 3 Ryzen 7 16GB 512GB Laptop", 15999), prod("Packard Bell Senna R32 Ryzen 3 16GB RAM 512GB SSD Laptop", 8999),
  prod("Kingston 16GB DDR4 Notebook Memory", 899), prod("15.6 inch Laptop Sleeve", 299), prod("Out of stock 16GB laptop", 9999, { available: false }), prod("MSI Modern 15 Ryzen 5 16GB RAM 512GB SSD Laptop", 13999)];
function setup(t, products = LAPTOPS, ai) {
  const { db, env } = testDb(t);
  const ok = { limit: async () => ({ success: true }) };
  Object.assign(env, { RL_SEARCH: ok, RL_CMP_SHOP: ok, RL_CMP_SLOW: ok, RL_CMP_IP: ok });
  if (ai) env.AI = ai;
  const real = globalThis.fetch, fetched = [];
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    fetched.push(url);
    if (/\/robots\.txt$/.test(url)) return new Response("", { status: 404 });
    if (/computermania\.co\.za\/search\/suggest\.json/.test(url)) return json({ resources: { results: { products } } });
    return new Response("not mocked", { status: 599 });
  };
  t.after(() => { globalThis.fetch = real; });
  W.asAiReset();
  return { db, env, fetched };
}
function fakeAI(replies) {
  const calls = [];
  return { calls, async run(model, input) { calls.push({ model, input }); const r = replies[calls.length - 1]; if (r instanceof Error) throw r; if (typeof r === "function") return r(input); return { response: r }; } };
}
const LQ = "I have R15,000. I need a laptop for programming and Docker";
const get = (env, q, c = "ZA") => worker.fetch(new Request("https://eish.veldwire.com/api/assist?q=" + encodeURIComponent(q) + "&c=" + c, { headers: { "cf-connecting-ip": "203.0.113.9" } }), env, {});

describe("/api/assist", () => {
  test("rules only (no AI binding): top 3 real in-stock laptops, no accessories, over budget marked", async (t) => {
    quiet(t);
    const { env, db } = setup(t);
    const r = await get(env, LQ);
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.understanding, "Budget: up to R15,000 · Looking for: laptop (16GB, SSD)");
    assert.equal(d.intent.by, "rules"); assert.deepEqual(d.ai, { intent: false, reasons: false });
    assert.equal(d.picks.length, 3);
    assert.deepEqual(d.picks.map((p) => p.price), [12999, 13999, 8999]);
    assert.ok(d.picks.every((p) => p.shop === "Computer Mania" && p.url.startsWith("https://computermania.co.za/products/") && p.reason_by === "rules" && !p.over_budget));
    assert.equal(d.more.length, 1); assert.equal(d.more[0].price, 15999); assert.equal(d.more[0].over_budget, true);
    assert.equal(d.total, 4); assert.equal(d.shop_count, 1);
    const all = JSON.stringify(d);
    assert.ok(!/Kingston|Sleeve|Out of stock/.test(all), "no memory, sleeve or out-of-stock product");
    assert.ok(d.shops.searched.includes("Computer Mania")); assert.ok(d.shops.failed.length > 0);
    // no D1 writes except the shared robots.txt cache of the shop searches
    const rows = db.prepare("SELECT k FROM cache").all().map((x) => x.k);
    assert.ok(rows.every((k) => k.startsWith("robots-cmp:")), rows.join());
    assert.equal(db.prepare("SELECT COUNT(*) n FROM rl").get().n, 0);
  });
  test("Workers AI reads the request and writes the reasons; a reason with an invented fact is replaced", async (t) => {
    quiet(t);
    const ai = fakeAI([
      JSON.stringify({ category: "laptop", maxBudget: 15000, currency: "ZAR", searchQueries: ["16GB laptop", "Ryzen laptop"], mustHave: ["16GB"], prefer: ["SSD"], avoid: ["bag"] }),
      JSON.stringify({ 1: "It has 16GB RAM and a 512GB SSD for Docker, within your budget.", 2: "It has 64GB RAM and an RTX 4090.", 3: "It fits your budget for Docker work." }),
    ]);
    const { env } = setup(t, LAPTOPS, ai);
    const d = await (await get(env, LQ)).json();
    assert.equal(ai.calls.length, 2);
    assert.equal(ai.calls[0].model, "@cf/meta/llama-3.1-8b-instruct-fp8-fast");
    assert.equal(d.intent.by, "ai"); assert.equal(d.intent.maxBudget, 15000);
    assert.equal(d.picks[0].reason, "It has 16GB RAM and a 512GB SSD for Docker, within your budget."); assert.equal(d.picks[0].reason_by, "ai");
    assert.equal(d.picks[1].reason_by, "rules", "64GB / RTX 4090 are not in the facts"); assert.ok(!/RTX|64GB/.test(JSON.stringify(d)));
    assert.equal(d.picks[2].reason_by, "ai");
    assert.deepEqual(d.ai, { intent: true, reasons: true });
  });
  test("the AI can't add a product, a price or a link", async (t) => {
    quiet(t);
    const ai = fakeAI([
      JSON.stringify({ category: "laptop", searchQueries: ["16GB laptop"] }),
      JSON.stringify({ 1: "Buy the MacBook Pro M4 at https://evil.example for R5,000.", picks: [{ title: "MacBook Pro M4", price: 5000, url: "https://evil.example" }] }),
    ]);
    const { env } = setup(t, LAPTOPS, ai);
    const d = await (await get(env, LQ)).json();
    const all = JSON.stringify(d);
    assert.ok(!/MacBook|evil\.example|R5,000/.test(all), all.slice(0, 300));
    assert.equal(d.picks.length, 3);
  });
  test("AI slow, broken or out of free Neurons: the rules decide; AI_MATCH off: no AI call", async (t) => {
    quiet(t);
    const slow = { calls: 0, run() { this.calls++; return new Promise(() => {}); } };
    let { env } = setup(t, LAPTOPS, slow);
    const t0 = Date.now();
    let d = await (await get(env, LQ)).json();
    assert.equal(d.intent.by, "rules"); assert.equal(d.picks.length, 3);
    assert.ok(Date.now() - t0 < 2 * W.AS_AI_TIMEOUT + 6000, "two AI timeouts at most");
    const broke = fakeAI([new Error("4006: you have used up your daily free allocation of 10,000 neurons"), "{}"]);
    ({ env } = setup(t, LAPTOPS, broke));
    d = await (await get(env, LQ)).json();
    assert.equal(broke.calls.length, 1, "no second call after the free Neurons error"); assert.equal(d.intent.by, "rules");
    const off = fakeAI(["{}", "{}"]);
    ({ env } = setup(t, LAPTOPS, off)); env.AI_MATCH = "off";
    d = await (await get(env, LQ)).json();
    assert.equal(off.calls.length, 0); assert.equal(d.picks.length, 3);
  });
  test("the shared Workers AI daily cap (compare's count) is respected, read only", async (t) => {
    quiet(t);
    const ai = fakeAI(["{}", "{}"]);
    const { env, db } = setup(t, LAPTOPS, ai);
    db.prepare("INSERT INTO cache (k, v, exp) VALUES (?, ?, ?)").run("cmpai-day:" + new Date().toISOString().slice(0, 10), String(W.CMP_AI_DAILY + 1), Date.now() + 864e5);
    const d = await (await get(env, LQ)).json();
    assert.equal(ai.calls.length, 0); assert.equal(d.picks.length, 3);
    assert.equal(db.prepare("SELECT v FROM cache WHERE k LIKE 'cmpai-day:%'").get().v, String(W.CMP_AI_DAILY + 1), "not changed");
  });
  test("nothing in the budget: the closest real products, marked over budget, and a plain note", async (t) => {
    quiet(t);
    const { env } = setup(t);
    const d = await (await get(env, "I need a laptop for programming under R5000")).json();
    assert.ok(d.picks.length > 0 && d.picks.every((p) => p.over_budget));
    assert.match(d.note, /no match in your budget/);
    assert.match(d.picks[0].reason, /more than your budget\.$/);
  });
  test("a budget in pounds searches UK shops; GET and POST; bad requests", async (t) => {
    quiet(t);
    const { env } = setup(t, []);
    const d = await (await get(env, "Need a 4K TV under £500 for PS5", "ZA")).json();
    assert.equal(d.country, "GB"); assert.equal(d.currency, "GBP"); assert.match(d.understanding, /^Budget: up to £500 · Looking for: TV \(4K/);
    assert.equal(d.picks.length, 0); assert.ok(d.note);
    const p = await worker.fetch(new Request("https://eish.veldwire.com/api/assist", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" }, body: JSON.stringify({ q: "Good coffee machine under R3000", c: "ZA" }) }), env, {});
    assert.equal(p.status, 200); assert.equal((await p.json()).intent.category, "appliance");
    assert.equal((await get(env, "")).status, 400);
    assert.match((await (await get(env, "https://www.takealot.com/x/PLID1")).json()).error, /link/);
    assert.equal((await get(env, "x".repeat(201))).status, 400);
    assert.equal((await get(env, "laptop under R5000", "US")).status, 400);
    const put = await worker.fetch(new Request("https://eish.veldwire.com/api/assist?q=x", { method: "PUT" }), env, {});
    assert.equal(put.status, 405);
  });
});

describe("assistant: one listing per model", () => {
  const key = (t) => W.asModelKey(t);
  test("colours and shops are the same model; other numbers are not", () => {
    assert.equal(W.asSameModel(key("Garmin White Forerunner 265 Music Watch"), key("Garmin Black Forerunner 265 Music Watch"), true), true);
    const tl = (a, b) => new Set([...W.asTail(a), ...W.asTail(b)]);
    const fa = "Garmin Forerunner 70, GPS, Whitestone", fb = "Garmin Forerunner 70, GPS, Cool Lavender";
    assert.equal(W.asSameModel(key(fa), key(fb), true, tl(fa, fb)), true);
    assert.equal(W.asSameModel(key("Nespresso Pixie Coffee Machine"), key("Nespresso Inissia Coffee Machine"), true, tl("Nespresso Pixie Coffee Machine", "Nespresso Inissia Coffee Machine")), false, "same price, other model");
    assert.equal(W.asSameModel(key("Garmin Forerunner 265 Music"), key("Garmin Forerunner 265S Music"), true), false);
    assert.equal(W.asSameModel(key("Garmin Forerunner 165 GPS Running Smartwatch - Black/Slate Grey"), key("Garmin Forerunner 165 GPS"), false), true, "other shop, more describing words");
    assert.equal(W.asSameModel(key("Garmin Forerunner 165"), key("Garmin Forerunner 165 Music"), false), false, "Music is another version");
    assert.equal(W.asSameModel(key("ASUS Vivobook 15 Ryzen 5 16GB 512GB SSD"), key("ASUS Vivobook 15 Ryzen 5 16GB 256GB SSD"), true), false);
    assert.equal(W.asSameModel(key("ASUS Vivobook 15 Ryzen 5 16GB 512GB SSD"), key("ASUS Vivobook 15 Ryzen 7 16GB 512GB SSD"), true), false, "Ryzen 5 vs Ryzen 7");
    assert.equal(W.asSameModel(key("Nespresso Pixie Coffee Machine"), key("Nespresso Inissia Coffee Machine"), false), false);
  });
});
