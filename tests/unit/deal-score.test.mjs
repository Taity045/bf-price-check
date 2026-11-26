// AB-29: Deal Score (src/score.js) and main products before accessories in search (src/search.js).
// No network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { W } from "../helpers/load-worker.mjs";

const NOW = Date.UTC(2026, 10, 26, 12);
const D = 864e5;
const pt = (daysAgo, price) => ({ t: NOW - daysAgo * D, price });
const score = (o) => W.dealScore({ C: "ZAR", now: NOW, ...o });

describe("deal score: honest when we know too little", () => {
  test("no history and no shop matches: no score, 'Check first', says why", () => {
    const d = score({ P: 13499, pts: [] });
    assert.equal(d.score, null);
    assert.equal(d.action, "Check first");
    assert.match(d.reasons[0], /Not enough price history yet/);
  });
  test("1 or 2 older prices: still no score", () => {
    const d = score({ P: 13499, pts: [pt(30, 14999), pt(60, 15999)] });
    assert.equal(d.score, null);
    assert.equal(d.action, "Check first");
    assert.match(d.reasons[0], /only 2 older prices/);
  });
  test("prices from the last 24 hours are not history", () => {
    assert.equal(score({ P: 100, pts: [pt(0.5, 120), pt(0.2, 130), pt(0.1, 140)] }).score, null);
  });
  test("no price: no score", () => {
    assert.equal(score({ P: null, pts: [pt(30, 1), pt(40, 1), pt(50, 1)] }).score, null);
    assert.equal(W.dealScore({ P: 10, pts: [] }).score, null);
  });
  test("still checking other shops is said, never a guess", () => {
    const d = score({ P: 999, pts: [], cmp: { done: 0, total: 3, matches: [] } });
    assert.equal(d.score, null);
    assert.match(d.reasons.join(" "), /still checking other shops/);
  });
});

describe("deal score: from real history", () => {
  test("Buy now: lowest price we found and clearly under the usual price", () => {
    const d = score({ P: 13499, pts: [pt(200, 15999), pt(100, 14999), pt(60, 15499)] });
    assert.equal(d.action, "Buy now");
    assert.ok(d.score >= 70, String(d.score));
    assert.match(d.reasons[0], /lowest price we found in 3 older prices/);
    assert.match(d.reasons[0], /R15,499/);
  });
  test("Buy now: 10 % or more under the usual price, even when it was lower once", () => {
    const d = score({ P: 900, pts: [pt(300, 800), pt(200, 1000), pt(150, 1000), pt(100, 1000), pt(70, 1000)] });
    assert.equal(d.action, "Buy now");
    assert.match(d.reasons[0], /10% less than the usual R1,000\. The lowest we found is R800/);
  });
  test("Wait: the price went up in the last 45 days (a rise before Black Friday)", () => {
    const d = score({ P: 16999, pts: [pt(200, 14999), pt(120, 14999), pt(20, 16999)] });
    assert.equal(d.action, "Wait");
    assert.ok(d.score < 40, String(d.score));
    assert.match(d.reasons[0], /went up in the last 45 days.*R14,999/);
  });
  test("Wait: clearly more than the usual price", () => {
    const d = score({ P: 1200, pts: [pt(300, 1000), pt(250, 1000), pt(200, 1000), pt(100, 1000)] });
    assert.equal(d.action, "Wait");
    assert.match(d.reasons[0], /20% more than the usual R1,000/);
  });
  test("Fair price: close to the usual price", () => {
    const d = score({ P: 1000, pts: [pt(300, 1000), pt(200, 1010), pt(100, 990)] });
    assert.equal(d.action, "Fair price");
    assert.ok(d.score >= 40 && d.score < 70, String(d.score));
  });
  test("an inflated 'was' price lowers the score and is named", () => {
    const pts = [pt(200, 999), pt(120, 1049), pt(20, 999)];
    const plain = score({ P: 999, pts }), fake = score({ P: 999, W: 1999, pts });
    assert.ok(fake.score < plain.score);
    assert.equal(fake.action, "Fair price");
    assert.match(fake.reasons[0], /"was" price of R1,999/);
  });
  test("deterministic and 0-100", () => {
    const o = { P: 50, pts: [pt(300, 500), pt(200, 500), pt(100, 500), pt(50, 500)] };
    assert.deepEqual(score(o), score(o));
    assert.ok(score(o).score <= 100);
    assert.ok(score({ P: 5000, pts: o.pts }).score >= 0);
  });
});

describe("deal score: other shops", () => {
  const hist = [pt(200, 15999), pt(100, 14999), pt(60, 15499)];
  test("Buy elsewhere: a cheaper exact match in stock, with the shop and the exact saving", () => {
    const d = score({ P: 13499, pts: hist, cmp: { done: 3, total: 3, matches: [{ name: "Loot", price: 12999, in_stock: true }, { name: "Makro", price: 13299, in_stock: true }] } });
    assert.equal(d.action, "Buy elsewhere");
    assert.match(d.reasons[0], /^Loot sells the same product for R12,999\. You save R500 \(4%\)\.$/);
    assert.match(d.reasons[1], /1 more shop is also cheaper/);
    assert.ok(d.score < score({ P: 13499, pts: hist }).score);
  });
  test("R20 or more counts on a big price; under 3 % and under R20 is a small saving (no Buy elsewhere)", () => {
    const big = score({ P: 13499, pts: [], cmp: { done: 1, total: 1, matches: [{ name: "Loot", price: 13479, in_stock: true }] } });
    assert.equal(big.action, "Buy elsewhere");
    const small = score({ P: 300, pts: hist.map((x) => ({ ...x, price: 300 })), cmp: { done: 1, total: 1, matches: [{ name: "Loot", price: 294, in_stock: true }] } });
    assert.notEqual(small.action, "Buy elsewhere");
    assert.match(small.reasons.join(" "), /Loot is R6 cheaper\. The saving is small/);
  });
  test("out of stock or a multi-buy flyer deal is never 'Buy elsewhere'", () => {
    const d = score({ P: 100, pts: [], cmp: { done: 2, total: 2, matches: [{ name: "Hirsch's", price: 50, in_stock: false }, { name: "Food Lover's Market", price: 60, in_stock: true, flyerQty: 3 }] } });
    assert.notEqual(d.action, "Buy elsewhere");
    assert.equal(d.score, null);
  });
  test("no history, but this shop is the cheapest of the shops that sell it: a score and 'Fair price'", () => {
    const d = score({ P: 999, pts: [], cmp: { done: 2, total: 2, matches: [{ name: "Loot", price: 1099, in_stock: true }, { name: "Takealot", price: 1049, in_stock: true }] } });
    assert.equal(d.action, "Fair price");
    assert.ok(d.score > 50);
    assert.match(d.reasons.join(" "), /No cheaper exact match at 2 other shops/);
  });
  test("pounds: £2 or 3 %", () => {
    const d = W.dealScore({ P: 100, C: "GBP", now: NOW, pts: [], cmp: { done: 1, total: 1, matches: [{ name: "Argos", price: 97.5, in_stock: true }] } });
    assert.equal(d.action, "Buy elsewhere");
    assert.match(d.reasons[0], /£97\.50\. You save £2\.50/);
  });
});

describe("deal score: server and page share the code", () => {
  test("publicDeal: history only, no score from an archived price", () => {
    assert.equal(W.publicDeal({ price: 10, currency: "ZAR", archived: 1, pts: [] }), null);
    const d = W.publicDeal({ price: 10, currency: "ZAR", archived: 0, pts: [] });
    assert.deepEqual(Object.keys(d), ["score", "action", "reasons"]);
    assert.equal(d.score, null);
  });
  test("the built page has the same dealScore code", () => {
    execFileSync("python3", ["build.py"], { cwd: new URL("../../", import.meta.url), stdio: "ignore" });
    const built = readFileSync(new URL("../../dist/worker.js", import.meta.url), "utf8");
    const src = readFileSync(new URL("../../public/result.js", import.meta.url), "utf8");
    assert.match(src, /\/\*DEAL_SCORE\*\//);
    assert.match(built, /Not enough price history yet/);
    assert.match(built, /function dealScore/);
  });
});

describe("search: main products before accessories", () => {
  const shop = W.cmpShopById("takealot");
  const c = (title, price, i) => ({ title, price, url: "https://www.takealot.com/x/PLID" + i, in_stock: true });
  const PS5 = [
    ["EA Sports FC 27 (PS5)", 1228], ["PlayStation 5 Slim Console with disc drive (PS5 Slim)", 15999],
    ["PlayStation 5 Slim Console + DualSense Wireless Controller", 17990], ["Turtle Beach Recon 70 Gaming Headset PS5", 549],
    ["Sony PlayStation 5 DualSense Wireless Controller V2 Midnight Black", 1799], ["FirstShop Titan PS5 Type-C to Type-A Charging Cable 2m", 120],
    ["FirstShop Tuff-Luv PS5 Console Carry Bag Black", 1199], ["PlayStation 5 Media Remote", 699.99], ["Playstation PS5 Cover - Wolverine Edition Cover", 1499],
    ["Playstation 5 Pulse Explore Wireless Earbuds - PS5", 4999], ["Playstation 5 Slim Digital Edition - PS5", 14499], ["Logitech G29 Racing Wheel (PS5, PS4) + Shifter", 4999],
    ["PS5 Charging Dock for DualSense", 399],
  ].map(([t, p], i) => c(t, p, i));
  test("bare 'PS5': consoles only, cheapest console first; accessories and games left out and counted", () => {
    for (const q of ["PS5", "ps5", "PlayStation 5"]) {
      const info = {};
      const out = W.srchFilter(q, shop, PS5, info);
      assert.deepEqual(out.map((x) => x.price), [14499, 15999, 17990], q);
      assert.ok(out.every((x) => x.rank === 0));
      assert.equal(info.hidden, PS5.length - 3);
    }
  });
  test("'PS5 controller' still finds controllers (no device ranking)", () => {
    assert.equal(W.srchDevice("PS5 controller"), null);
    const out = W.srchFilter("PS5 controller", shop, PS5);
    assert.ok(out.some((x) => /DualSense Wireless Controller V2/.test(x.title)));
    assert.equal(out[0].rank, undefined);
  });
  test("'iPhone 16 case' still finds cases; bare 'iPhone 16' puts phones first", () => {
    const L = [c("Apple iPhone 16 Silicone Case with MagSafe", 999, 1), c("Apple iPhone 16 128GB Black", 17999, 2), c("Spigen iPhone 16 Tempered Glass Screen Protector", 299, 3)];
    assert.deepEqual(W.srchFilter("iPhone 16", shop, L).map((x) => x.price), [17999]);
    assert.deepEqual(W.srchFilter("iPhone 16 case", shop, L).map((x) => x.price), [999]);
  });
  test("families: main product or accessory", () => {
    const k = (q, t) => W.srchKind(W.srchDevice(q), t);
    assert.equal(k("Nintendo Switch 2", "Nintendo Switch 2 Mario Kart World Bundle"), "main");
    assert.equal(k("Nintendo Switch 2", "Mario Kart World (Nintendo Switch 2)"), "acc");
    assert.equal(k("Nintendo Switch 2", "Nintendo Switch 2 Pro Controller"), "acc");
    assert.equal(k("Xbox Series X", "Xbox Series X 1TB Console"), "main");
    assert.equal(k("Apple Watch", "Apple Watch Series 10 GPS 46mm Jet Black Aluminium Case with Black Sport Band"), "main");
    assert.equal(k("Apple Watch", "Apple Watch 45mm Sport Band"), "acc");
    assert.equal(k("AirPods", "Apple AirPods Pro 2 with MagSafe Charging Case (USB-C)"), "main");
    assert.equal(k("AirPods", "AirPods Pro 2 Protective Case Cover"), "acc");
    assert.equal(k("Garmin", "Garmin Forerunner 265 GPS Smartwatch"), "main");
    assert.equal(k("Garmin", "Garmin QuickFit 22 Silicone Watch Band"), "acc");
    assert.equal(k("Dyson", "Dyson V15 Detect Absolute Cordless Vacuum"), "main");
    assert.equal(k("Dyson", "Dyson V15 Replacement Filter"), "acc");
    assert.equal(k("iPad", "Apple iPad 11 Wi-Fi 128GB"), "main");
    assert.equal(k("iPad", "Logitech Combo Touch Keyboard Case for iPad"), "acc");
    assert.equal(k("MacBook Air", "Apple MacBook Air 13 M3 8GB 256GB"), "main");
  });
  test("a search that is not a main product keeps lowest price first", () => {
    assert.equal(W.srchDevice("Smeg kettle"), null);
    assert.equal(W.srchDevice("PS5 game"), null);
    assert.equal(W.srchDevice("iPhone 16 screen protector"), null);
  });
  test("/api/search names the family and an accessory example", () => {
    const p = W.srchPlan("PS5", "ZA");
    assert.equal(p.device, "consoles");
    assert.equal(p.accessory_example, "PS5 controller");
    assert.equal(W.srchPlan("Smeg kettle", "ZA").device, null);
  });
});

describe("deal score: score agrees with the action", () => {
  test("'Buy elsewhere' and 'Wait' stay under 50; 'Buy now' is 65 or more", () => {
    const hist = [pt(200, 1299), pt(100, 1249), pt(60, 1299), pt(30, 1199)];
    const away = score({ P: 999, pts: hist, cmp: { done: 1, total: 1, matches: [{ name: "Hirsch's", price: 899, in_stock: true }] } });
    assert.equal(away.action, "Buy elsewhere");
    assert.ok(away.score <= 49, String(away.score));
    assert.ok(W.dsRaw({ P: 999, C: "ZAR", now: NOW, pts: hist, cmp: { done: 1, total: 1, matches: [{ name: "Hirsch's", price: 899, in_stock: true }] } }).score > 49);
    const now = score({ P: 900, pts: [pt(300, 800), pt(200, 1000), pt(150, 1000), pt(100, 1000), pt(70, 1000)] });
    assert.equal(now.action, "Buy now");
    assert.ok(now.score >= 65, String(now.score));
  });
});
