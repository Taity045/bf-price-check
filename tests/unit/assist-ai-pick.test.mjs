// AB-42: general AI product picking for ALL kinds of products. The AI gets one numbered list of real listings
// (only the checks that are the same for every kind of product happen in code) and returns the picks, the other
// matches and the reasons in ONE answer. Every index maps to our own list; "picks": [] is respected; the
// category rules are the fallback only. No network: shops, OpenRouter and Workers AI are mocked.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { W, worker } from "../helpers/load-worker.mjs";
import { testDb } from "../helpers/db.mjs";

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const quiet = (t) => { const log = console.log; console.log = () => {}; t.after(() => { console.log = log; }); };
const prod = (title, price) => ({ title, handle: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), url: "/products/" + title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), price: String(price), price_min: String(price), price_max: String(price), available: true, vendor: "" });
function fakeAI(replies) {
  const calls = [];
  return { calls, async run(model, input) { calls.push({ model, input }); const r = replies[calls.length - 1]; if (r instanceof Error) throw r; if (typeof r === "function") return { response: r(input) }; return { response: r }; } };
}
// Computer Mania (Shopify) answers every search with `products`; every other shop fails.
function setup(t, products, ai) {
  const { env } = testDb(t);
  const ok = { limit: async () => ({ success: true }) };
  Object.assign(env, { RL_SEARCH: ok, RL_CMP_SHOP: ok, RL_CMP_SLOW: ok, RL_CMP_IP: ok });
  if (ai) env.AI = ai;
  const real = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (/\/robots\.txt$/.test(url)) return new Response("", { status: 404 });
    if (/computermania\.co\.za\/search\/suggest\.json/.test(url)) return json({ resources: { results: { products } } });
    return new Response("not mocked", { status: 599 });
  };
  t.after(() => { globalThis.fetch = real; });
  W.asAiReset(); W.asOrReset(); W.asRlReset();
  return { env };
}
let ipN = 0;
const get = (env, q) => worker.fetch(new Request("https://eish.veldwire.com/api/assist?q=" + encodeURIComponent(q) + "&c=ZA", { headers: { "cf-connecting-ip": "192.0.2." + (++ipN % 250) } }), env, {});
// The AI list as the model sees it: "1. name | price | shop" lines
const lines = (call) => call.input.messages[1].content.split("\n").filter((l) => /^\d+\. /.test(l));
// A fake model that picks by name: up to 3 lines whose name matches `want` and not `junk`; keep = all such lines
const picker = (want, junk = /^$/, reason = "It matches your request.") => (input) => {
  const ls = input.messages[1].content.split("\n").filter((l) => /^\d+\. /.test(l));
  const good = ls.filter((l) => want.test(l.split(" | ")[0]) && !junk.test(l.split(" | ")[0])).map((l) => Number(l.split(".")[0]));
  return JSON.stringify({ picks: good.slice(0, 3).map((i) => ({ i, reason })), keep: good });
};
const intentOf = (category, searchQueries) => JSON.stringify({ category, maxBudget: null, currency: "ZAR", searchQueries, mustHave: [], prefer: [], avoid: [] });

// Categories the rules never had: the AI decides, with accessories and parts in the same shop answer
const UNSEEN = [
  { q: "where can i buy a camping tent", cat: "other", sq: ["camping tent"], want: /\btent\b/i, junk: /\b(pegs?|repair|footprint|light|lantern|mat)\b/i,
    products: [prod("Tent Pegs Steel 10 Pack", 99), prod("Coleman Darwin 4 Person Dome Tent", 2499), prod("Tent Repair Kit", 79), prod("Campmaster Tent Footprint 3x3m", 349), prod("Natural Instinct Explorer 6 Person Tunnel Tent", 3999), prod("LED Tent Light", 149), prod("First Ascent Amp 2 Hiking Tent", 3299)] },
  { q: "blender for smoothies", cat: "appliance", sq: ["blender"], want: /\bblender\b/i, junk: /\b(jug|blade|replacement|bottle|lid)\b/i,
    products: [prod("Replacement Blender Jug 1.5L", 299), prod("Nutribullet 600W Personal Blender", 999), prod("Blender Blade Assembly", 199), prod("Russell Hobbs Desire Jug Blender 1.5L", 799), prod("Smoothie Bottle 600ml with Lid", 129), prod("Philips Series 5000 Blender", 1499)] },
  { q: "good coffee machine under R3000", cat: "appliance", sq: ["coffee machine"], want: /\b(coffee machine|espresso machine|coffee maker)\b/i, junk: /\b(capsules?|descaler|pods?|cups?)\b/i,
    products: [prod("Nespresso Capsules Variety 50 Pack", 449), prod("De'Longhi Dedica EC685 Espresso Machine", 2999), prod("Coffee Machine Descaler 500ml", 149), prod("Russell Hobbs Coffee Maker 10 Cup", 699), prod("Coffee Cups Set of 6", 199), prod("Mellerware Espresso Machine 15 Bar", 1799), prod("De'Longhi Magnifica Bean to Cup", 8999)] },
  { q: "acoustic guitar for a beginner", cat: "other", sq: ["acoustic guitar"], want: /\bguitar\b/i, junk: /\b(strings?|picks?|capo|strap|stand|tuner|bag|case)\b/i,
    products: [prod("Guitar Strings Acoustic Set", 129), prod("Yamaha F310 Acoustic Guitar", 2799), prod("Guitar Capo", 99), prod("Fender CD-60S Acoustic Guitar Natural", 3999), prod("Guitar Picks 12 Pack", 49), prod("Guitar Stand Folding", 199)] },
];

describe("AB-42: general AI picking for unseen kinds of products (end to end, mocked AI)", () => {
  for (const u of UNSEEN) test(`${u.q}: the main products are picked, accessories and parts are not shown`, async (t) => {
    quiet(t);
    const ai = fakeAI([intentOf(u.cat, u.sq), picker(u.want, u.junk)]);
    const { env } = setup(t, u.products, ai);
    const d = await (await get(env, u.q)).json();
    assert.equal(ai.calls.length, 2, "two AI calls: intent, then pick + reasons");
    assert.ok(lines(ai.calls[1]).length >= u.products.filter((p) => W.asBudget(u.q) == null || Number(p.price) <= W.asBudget(u.q).amount).length - 1, "the real listings go to the AI");
    assert.equal(d.ai.pick, true);
    assert.ok(d.picks.length >= 2, JSON.stringify(d.picks.map((p) => p.title)));
    for (const p of d.picks.concat(d.more)) {
      assert.match(p.title, u.want); assert.doesNotMatch(p.title, u.junk);
      assert.ok(p.url.startsWith("https://computermania.co.za/products/"), "a real shop link");
      assert.ok(u.products.some((x) => x.title === p.title && Number(x.price) === p.price), "a real product and price");
    }
    const b = W.asBudget(u.q);
    if (b) assert.ok(d.picks.every((p) => p.price <= b.amount && !p.over_budget), "never over the budget");
    assert.ok(d.picks.every((p) => p.reason_by === "ai" && /^It matches your request\./.test(p.reason)));
  });
  test("running shoes and a baby stroller (no rules for them): the AI list keeps unknown items and the AI drops the junk", async () => {
    const env = { AI: fakeAI([picker(/\b(running shoe|stroller|pram)\b/i, /\b(laces|insoles?|rain cover|cup holder)\b/i)]) };
    for (const [q, cands, want] of [
      ["running shoes for beginners", [["Shoe Laces Flat 120cm", 49], ["Nike Revolution 7 Running Shoe", 1199], ["Gel Insoles", 199], ["ASICS Gel-Contend 9 Mens Running Shoe", 1399], ["Adidas Duramo SL Running Shoe", 999]], /Running Shoe/],
      ["where can i buy a baby stroller", [["Stroller Rain Cover", 299], ["Chicco Liteway Stroller", 3499], ["Stroller Cup Holder", 99], ["Bugaboo Butterfly Stroller", 9999], ["Joie Pram and Car Seat Travel System", 6999]], /Stroller|Pram/],
    ]) {
      W.asAiReset(); W.asOrReset(); env.AI.calls.length = 0;
      const intent = W.asRules(q, "ZA");
      const all = cands.map(([title, price], i) => ({ title, price, was: null, currency: "ZAR", shop: "Takealot", shop_id: "takealot", url: "https://www.takealot.com/x/PLID" + i, fit: W.asFits(intent, title, intent.searchQueries[0]), rel: W.asRel(intent, title) }));
      const { list, overOnly } = W.asAiList(intent, all);
      assert.equal(list.length, cands.length, "no listing is dropped by category rules before the AI: " + q);
      const r = await W.asAiPick(env, q, intent, list, overOnly);
      assert.equal(r.ok, true, q);
      assert.ok(r.top.length >= 2 && r.top.concat(r.rest).every((p) => want.test(p.title) && !/Laces|Insoles|Rain Cover|Cup Holder/.test(p.title)), q + ": " + r.top.map((p) => p.title).join(" / "));
    }
  });
});

describe("AB-42: strict grounding of the AI answer", () => {
  const intent = W.asRules("good kettle under R1000", "ZA");
  const list = [["Russell Hobbs Kettle 1.7L", 499], ["Kettle Descaler", 89], ["Defy Cordless Kettle", 349], ["Smeg Kettle Cream", 999]].map(([title, price], i) => ({ title, price, currency: "ZAR", shop: "Makro", url: "https://www.makro.co.za/p/" + i, fit: true, rel: 1 }));
  test("only indices of our list, once each, in the budget; numbers as text are fine; anything else is dropped", () => {
    const r = W.asPickParse({ picks: [{ i: 1, reason: "a" }, { i: 1, reason: "dup" }, { i: 0 }, { i: 99 }, { i: -2 }, { i: "3" }, { i: "abc" }, 4], keep: [1, 3, 4, 77] }, list, intent, false);
    assert.deepEqual(r.picks.map((p) => p.i), [0, 2, 3]);
    assert.deepEqual([...r.keep].sort(), [0, 2, 3]);
  });
  test("only invented numbers: a bad answer (the rules decide)", () => {
    assert.equal(W.asPickParse({ picks: [{ i: 0 }, { i: 12 }], keep: [] }, list, intent, false), null);
    assert.equal(W.asPickParse({ picks: "1,2" }, list, intent, false), null);
    assert.equal(W.asPickParse({ answer: [1] }, list, intent, false), null);
    assert.equal(W.asPickParse({ picks: [{ i: 1, reason: "x" }], extra: "chat" }, list, intent, false), null);
  });
  test("an over-budget index is never picked (the AI can't change the budget)", () => {
    const l2 = list.concat([{ title: "Smeg Kettle Black", price: 1999, currency: "ZAR", shop: "Makro", url: "https://www.makro.co.za/p/9", fit: true, rel: 1 }]);
    const r = W.asPickParse({ picks: [{ i: 5 }, { i: 1 }], keep: [5, 1] }, l2, intent, false);
    assert.deepEqual(r.picks.map((p) => p.i), [0]); assert.ok(!r.keep.has(4));
  });
  test('"picks": [] with "keep": [] is a valid, empty answer; "keep" with no "picks" gives the first kept products', () => {
    const e = W.asPickParse({ picks: [], keep: [] }, list, intent, false);
    assert.deepEqual(e.picks, []); assert.equal(e.keep.size, 0);
    const k = W.asPickParse({ picks: [], keep: [4, 1] }, list, intent, false);
    assert.deepEqual(k.picks.map((p) => p.i), [0, 3]);
  });
  test("a name, price or link in the AI answer is never used: only our own listing", async () => {
    const env = { AI: fakeAI([JSON.stringify({ picks: [{ i: 2, reason: "Buy it at https://evil.example for R5.", title: "Fake Kettle", price: 5, url: "https://evil.example" }], keep: [2] })]) };
    W.asAiReset(); W.asOrReset();
    const r = await W.asAiPick(env, "good kettle under R1000", intent, list, false);
    assert.equal(r.ok, true); assert.equal(r.top.length, 1);
    assert.equal(r.top[0].title, "Kettle Descaler"); assert.equal(r.top[0].url, "https://www.makro.co.za/p/1"); assert.equal(r.top[0].price, 89);
    assert.ok(!/evil|Fake|R5\b/.test(JSON.stringify(r.top)), "the bad reason is replaced by a rule reason");
    assert.equal(r.by[0], "rules");
  });
  test("an AI reason with an invented spec or number is replaced; a good reason gets the budget line", async () => {
    const env = { AI: fakeAI([JSON.stringify({ picks: [{ i: 1, reason: "It boils water fast with its 3000W element" }, { i: 3, reason: "It is a cordless kettle for your kitchen" }], keep: [1, 3] })]) };
    W.asAiReset(); W.asOrReset();
    const r = await W.asAiPick(env, "good kettle under R1000", intent, list, false);
    assert.deepEqual(r.by, ["rules", "ai"]);
    assert.equal(r.top[1].reason, "It is a cordless kettle for your kitchen. It costs R651 less than your budget.");
  });
});

describe("AB-42: empty picks are respected; the rules are only the fallback", () => {
  const LAPTOPS = [prod("HP 15 Laptop - AMD Ryzen 5 7520U, 16GB LPDDR5, 512GB SSD", 12999), prod("MSI Modern 15 Ryzen 5 16GB RAM 512GB SSD Laptop", 13999), prod("15.6 inch Laptop Sleeve", 299)];
  const LQ = "I have R15,000. I need a laptop for programming and Docker";
  const INTENT = JSON.stringify({ category: "laptop", maxBudget: 15000, currency: "ZAR", searchQueries: ["16GB laptop"], mustHave: ["16GB"], prefer: [], avoid: [] });
  test('the AI says nothing matches ("picks": []): no picks, no accessories, an honest note', async (t) => {
    quiet(t);
    const ai = fakeAI([INTENT, JSON.stringify({ picks: [], keep: [] })]);
    const { env } = setup(t, LAPTOPS, ai);
    const d = await (await get(env, LQ)).json();
    assert.equal(d.ai.pick, true); assert.deepEqual(d.picks, []); assert.deepEqual(d.more, []);
    assert.match(d.note, /^We found no products in stock that match your request\./);
  });
  for (const [name, reply] of [["an error", new Error("5000: internal")], ["chat text, not JSON", "Sure! Here are some laptops I like."], ["only invented numbers", JSON.stringify({ picks: [{ i: 40 }], keep: [40] })]]) {
    test(`the pick step fails (${name}): the category rules pick, with rule reasons`, async (t) => {
      quiet(t);
      const ai = fakeAI([INTENT, reply]);
      const { env } = setup(t, LAPTOPS, ai);
      const d = await (await get(env, LQ)).json();
      assert.equal(ai.calls.length, 2);
      assert.equal(d.ai.pick, false); assert.equal(d.ai.models.pick, "rules");
      assert.deepEqual(d.picks.map((p) => p.price), [12999, 13999]);
      assert.ok(d.picks.every((p) => p.reason_by === "rules")); assert.ok(!/Sleeve/.test(JSON.stringify(d)));
    });
  }
  test("no AI at all (AI_ASSIST off): rules, no AI call", async (t) => {
    quiet(t);
    const ai = fakeAI([INTENT, INTENT]);
    const { env } = setup(t, LAPTOPS, ai); env.AI_ASSIST = "off";
    const d = await (await get(env, LQ)).json();
    assert.equal(ai.calls.length, 0); assert.equal(d.picks.length, 2); assert.equal(d.ai.pick, false);
  });
});

describe("AB-42: the AI list and the prompt", () => {
  test("in-budget only (when any), one listing per model, rules' matches first, at most AS_AI_N", () => {
    const intent = W.asRules("camping tent under R3000", "ZA");
    const mk = (title, price, i) => ({ title, price, currency: "ZAR", shop: i % 2 ? "Takealot" : "Loot", shop_id: i % 2 ? "takealot" : "loot", url: "https://x.example/" + i, fit: W.asFits(intent, title, "camping tent"), rel: W.asRel(intent, title) });
    const all = [mk("Coleman Dome Camping Tent 4 Person", 2499, 1), mk("Coleman Dome Camping Tent 4 Person", 2299, 2), mk("Luxury Camping Tent 8 Person", 8999, 3), mk("Tent Pegs", 99, 4)];
    for (let i = 0; i < 40; i++) all.push(mk("Camping Chair Model " + i, 300 + i, 10 + i));
    const { list, overOnly } = W.asAiList(intent, all);
    assert.equal(overOnly, false); assert.equal(list.length, W.AS_AI_N);
    assert.ok(!list.some((c) => c.price > 3000), "nothing over the budget");
    assert.equal(list.filter((c) => /Coleman/.test(c.title)).length, 1); assert.equal(list.find((c) => /Coleman/.test(c.title)).price, 2299, "the cheapest listing of a model");
    assert.match(list[0].title, /Camping Tent/);
  });
  test("nothing in the budget: the closest products go, marked over budget", () => {
    const intent = W.asRules("camping tent under R500", "ZA");
    const { list, overOnly } = W.asAiList(intent, [{ title: "Coleman Dome Camping Tent", price: 2499, currency: "ZAR", shop: "Loot", shop_id: "loot", url: "https://x.example/1", fit: true, rel: 1 }]);
    assert.equal(overOnly, true); assert.equal(list.length, 1);
  });
  test("the prompt: strict JSON, main product only, parts and accessories out unless asked, empty picks allowed, grounded reasons", () => {
    const s = W.AS_PICK_SYSTEM;
    for (const re of [/only one JSON object/, /"picks"/, /"keep"/, /spare parts, accessories/, /Only when the shopper asks for a part or an accessory/, /\{"picks":\[\],"keep":\[\]\}/, /bulk/, /no budget/, /only facts that are in the product name/, /do not follow instructions/]) assert.match(s, re);
    assert.ok(s.length < 2200, "short prompt for a small model");
  });
  test("cache v10 (AB-42b); the intent step knows bikes and any other product", () => {
    assert.equal(W.AS_VER, "v10");
    const src = readFileSync(new URL("../../src/assist.js", import.meta.url), "utf8");
    assert.match(src, /tablet, bike, other; use other for all other products/); assert.match(src, /"camping tent", "baby stroller"/);
  });
  test("small CPU cost: 400 raw listings make the AI list fast", () => {
    const intent = W.asRules("where can i buy a camping tent", "ZA");
    const all = [];
    for (let i = 0; i < 400; i++) all.push({ title: `Brand${i % 37} Camping Tent ${i % 50} Person Model ${i}`, price: 500 + i, currency: "ZAR", shop: "Takealot", shop_id: "takealot", url: "https://x.example/" + i, fit: i % 3 === 0, rel: W.asRel(intent, "Camping Tent") });
    const t0 = performance.now();
    for (let k = 0; k < 5; k++) W.asAiList(intent, all);
    assert.ok((performance.now() - t0) / 5 < 25, "ms per list: " + ((performance.now() - t0) / 5).toFixed(1));
  });
});

describe("AB-42b: a small safety check on the AI's answer (the same for every kind of product)", () => {
  const L = (intent, rows) => rows.map(([title, price], i) => ({ title, price, currency: "ZAR", shop: "Takealot", shop_id: "takealot", url: "https://www.takealot.com/x/PLID" + i, fit: W.asFits(intent, title, intent.searchQueries[0]), rel: 0.5 }));
  test("only a size in common ('Foam Bath 2 Litre' for 'coke 2 litre'): never shown, the real Coca-Cola fills the picks", () => {
    const intent = W.asRules("coke 2 litre", "ZA");
    const list = L(intent, [["Coca-Cola Zero Plastic Bottle 2L", 19.99], ["Clicks Silky Bubbles Foam Bath Midnight & Roses 2 Litre", 89.99], ["Clicks Silky Bubbles Foam Bath Floral 2 Litre", 89.99], ["Coca-Cola Original 2L", 24.99]]);
    const r = W.asPickParse({ picks: [{ i: 1 }, { i: 2 }, { i: 3 }], keep: [1, 2, 3, 4] }, list, intent, false);
    assert.deepEqual(r.picks.map((p) => list[p.i].title), ["Coca-Cola Zero Plastic Bottle 2L", "Coca-Cola Original 2L"]);
    assert.ok(![...r.keep].some((i) => /Foam/.test(list[i].title)));
  });
  test("an accessory name the AI let through (a folio among phones) and a far too cheap item are not shown", () => {
    const intent = W.asRules("iphone with a good camera", "ZA");
    const list = L(intent, [["Apple iPhone 18 Pro 256GB", 28999], ["Apple iPhone 17 256GB", 19999], ["Apple iPhone 16e 128GB", 12999], ["FirstShop Apple iPhone Duo Folio with Kickstand - Taupe", 499], ["Apple iPhone Lightning Earphones", 349]]);
    const r = W.asPickParse({ picks: [{ i: 1 }, { i: 2 }, { i: 3 }], keep: [1, 2, 3, 4, 5] }, list, intent, false);
    assert.deepEqual([...r.keep].sort(), [0, 1, 2]);
  });
  test("the AI picked only refused products: a bad answer (the rules decide); an accessory request is never checked this way", () => {
    const intent = W.asRules("coke 2 litre", "ZA");
    const list = L(intent, [["Coca-Cola Zero Plastic Bottle 2L", 19.99], ["Foam Bath 2 Litre", 89.99]]);
    assert.equal(W.asPickParse({ picks: [{ i: 2 }], keep: [2] }, list, intent, false), null);
    const acc = W.asRules("iphone 16 case", "ZA");
    const l2 = L(acc, [["Spigen Case for iPhone 16", 299]]);
    assert.deepEqual(W.asPickParse({ picks: [{ i: 1 }], keep: [1] }, l2, acc, false).picks.map((p) => p.i), [0]);
  });
  test("unknown kinds of products with the request's words are kept (a tent, a stroller)", () => {
    const intent = W.asRules("where can i buy a baby stroller", "ZA");
    const list = L(intent, [["Chicco Liteway Stroller", 3499], ["Bugaboo Butterfly Stroller", 9999], ["Baby Travel System 3 in 1", 6999]]);
    const r = W.asPickParse({ picks: [{ i: 1 }, { i: 2 }, { i: 3 }], keep: [1, 2, 3] }, list, intent, false);
    assert.equal(r.picks.length, 3);
  });
  test("a word the request uses is never junk ('printer ink refill' keeps refills)", () => {
    const q = "printer ink refill", intent = W.asRules(q, "ZA");
    const list = L(intent, [["HP 305 Ink Refill Kit", 199], ["Canon PG-545 Ink Refill", 249]]);
    assert.equal(W.asPickParse({ picks: [{ i: 1 }, { i: 2 }], keep: [1, 2] }, list, intent, false, q).picks.length, 2);
    assert.equal(W.asPickParse({ picks: [{ i: 1 }, { i: 2 }], keep: [1, 2] }, list, intent, false, "printer"), null, "without the word in the request, refills are refused");
  });
});

