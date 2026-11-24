import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { W } from "../helpers/load-worker.mjs";

const DAY = 864e5;
const ago = (days) => Date.now() - days * DAY;
// History as stored in D1: live checks (one per day counts) and archive snapshots.
const hist = (prices, { currency = "ZAR", start = 10, step = 7 } = {}) => ({
  checks: prices.map((price, i) => ({ ts: ago(start + i * step), price, currency })),
  snaps: [],
});
const live = (price, was = null, currency = "ZAR") => ({ status: "ok", price, was, currency });

describe("verdict", () => {
  test("Real deal: at the lowest price and at least 5% under the usual price", () => {
    const j = W.judge(live(100), hist([120, 110, 100]));
    assert.equal(j.verdict, "Real deal");
    assert.deepEqual([j.low, j.med, j.high, j.n], [100, 110, 120, 3]);
  });
  test("Decent deal: 5% or more under the usual price but not the lowest", () => {
    assert.equal(W.judge(live(110), hist([100, 120, 130])).verdict, "Decent deal");
  });
  test("Same old price", () => {
    assert.equal(W.judge(live(100), hist([100, 100, 100])).verdict, "Same old price");
    assert.equal(W.judge(live(102), hist([100, 100, 100])).verdict, "Same old price", "within 3% of the usual price");
  });
  test("Pricier than usual: more than 3% over the usual price", () => {
    assert.equal(W.judge(live(104), hist([100, 100, 100])).verdict, "Pricier than usual");
  });
  test("Fake discount: 'was' price above anything seen and no real saving", () => {
    const j = W.judge(live(100, 150), hist([100, 100, 100]));
    assert.equal(j.verdict, "Fake discount");
    assert.equal(j.high90, 100);
    assert.equal(j.gap, 0.5);
  });
  test("Not enough history below 3 earlier prices", () => {
    for (const n of [0, 1, 2]) {
      const j = W.judge(live(100), hist(Array(n).fill(100)));
      assert.equal(j.verdict, "Not enough history", `${n} prices`);
      assert.equal(j.n, n);
    }
    assert.equal(W.judge(live(100), hist([100, 100, 100])).verdict, "Same old price", "3 prices is enough");
  });
  test("no live price and too little history gives no verdict", () => {
    const j = W.judge({ status: "blocked" }, hist([100, 100, 100]));
    assert.equal(j.verdict, null);
  });
  test("no live price: the last of 4+ stored prices is used and marked archived", () => {
    const j = W.judge(null, hist([100, 100, 100, 90], { start: 2, step: 5 }));
    assert.equal(j.archived, 1);
    assert.ok(j.verdict);
  });
  test("prices from the last 24 hours do not count as history", () => {
    const h = { checks: [{ ts: Date.now() - 3600e3, price: 100, currency: "ZAR" }, ...hist([100, 100]).checks], snaps: [] };
    assert.equal(W.judge(live(100), h).verdict, "Not enough history");
  });
  test("several checks on the same day count once", () => {
    const t = ago(5);
    const h = { checks: [0, 1, 2].map((i) => ({ ts: t + i * 1000, price: 100, currency: "ZAR" })), snaps: [] };
    assert.equal(W.judge(live(100), h).n, 1);
  });
  test("prices in another currency are ignored", () => {
    const h = { checks: [...hist([100, 100]).checks, { ts: ago(30), price: 5, currency: "GBP" }], snaps: [] };
    assert.equal(W.judge(live(100), h).verdict, "Not enough history");
  });
  test("archive snapshots count, failed snapshots do not", () => {
    const snap = (days, price, status = "ok") => ({ snap_ts: new Date(ago(days)).toISOString().replace(/\D/g, "").slice(0, 14), price, currency: "ZAR", status });
    const h = { checks: [], snaps: [snap(20, 100), snap(40, 100), snap(60, 100), snap(80, 50, "noprice")] };
    assert.equal(W.judge(live(100), h).verdict, "Same old price");
  });
  test("prices older than a year are ignored", () => {
    const h = hist([100, 100, 100], { start: 400 });
    assert.equal(W.judge(live(100), h).verdict, "Not enough history");
  });
});

describe("90-day 'was' price rule", () => {
  test("'was' is compared with the highest price in the last 90 days, not older highs", () => {
    // 150 two hundred days ago; 100 in the last 90 days. The shop says 'was 140'.
    const h = { checks: [{ ts: ago(200), price: 150, currency: "ZAR" }, { ts: ago(60), price: 100, currency: "ZAR" }, { ts: ago(30), price: 100, currency: "ZAR" }], snaps: [] };
    const j = W.judge(live(100, 140), h);
    assert.equal(j.high90, 100);
    assert.equal(j.verdict, "Fake discount");
  });
  test("with fewer than 2 prices in 90 days the yearly high is used", () => {
    const h = { checks: [{ ts: ago(200), price: 150, currency: "ZAR" }, { ts: ago(150), price: 100, currency: "ZAR" }, { ts: ago(30), price: 100, currency: "ZAR" }], snaps: [] };
    const j = W.judge(live(100, 140), h);
    assert.equal(j.high90, 150);
    assert.notEqual(j.verdict, "Fake discount");
  });
  test("a 'was' price within 3% of the 90-day high is not a fake discount", () => {
    assert.equal(W.judge(live(100, 103), hist([100, 100, 100])).verdict, "Same old price");
    assert.equal(W.judge(live(100, 103.5), hist([100, 100, 100])).verdict, "Fake discount");
  });
  test("a real saving wins over an inflated 'was' price", () => {
    assert.equal(W.judge(live(80, 200), hist([100, 100, 100])).verdict, "Real deal");
  });
});

describe("public verdict", () => {
  test("only public fields", () => {
    const p = W.publicVerdict(W.judge(live(100), hist([120, 110, 100])));
    assert.deepEqual(Object.keys(p).sort(), ["currency", "low", "low_t", "med", "n", "price", "verdict", "was"]);
    assert.equal(W.publicVerdict({ verdict: null }), null);
  });
  test("median", () => {
    assert.equal(W.median([3, 1, 2]), 2);
    assert.equal(W.median([4, 1, 2, 3]), 2.5);
    assert.equal(W.median([]), null);
  });
});
