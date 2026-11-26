// AB-43b: every search (not only device families): clear accessories and parts come after the products themselves.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { W } from "../helpers/load-worker.mjs";

const tk = () => W.cmpShopById("takealot");
const L = (ts) => ts.map((t, i) => ({ title: t, price: 50 + i * 100, url: "https://www.takealot.com/x/PLID" + (i + 1), in_stock: true }));
const order = (q, ts) => W.srchFilter(q, tk(), L(ts)).map((r) => (r.rank ? "acc:" : "") + r.title);

describe("AB-43b: main products first for any search", () => {
  test("airfryer: air fryers before liners and baskets (which still show)", () => {
    assert.deepEqual(order("airfryer", ["Silicone Air Fryer Liner Round", "Air Fryer Paper Liners 100pcs", "Philips Airfryer 3000 Series 4.1L", "Russell Hobbs 5L Air Fryer", "Air Fryer Silicone Pot Basket for Ninja"]),
      ["Philips Airfryer 3000 Series 4.1L", "Russell Hobbs 5L Air Fryer", "acc:Silicone Air Fryer Liner Round", "acc:Air Fryer Paper Liners 100pcs", "acc:Air Fryer Silicone Pot Basket for Ninja"]);
  });
  test("a brand alone: phones and TVs before cases and chargers", () => {
    assert.deepEqual(order("samsung", ["Samsung Clear Case Galaxy A56", "Samsung 25W Charger", "Samsung Galaxy A16 128GB", "Samsung 55in Crystal UHD TV"]),
      ["Samsung Galaxy A16 128GB", "Samsung 55in Crystal UHD TV", "acc:Samsung Clear Case Galaxy A56", "acc:Samsung 25W Charger"]);
  });
  test("a search for the accessory itself is not changed", () => {
    assert.deepEqual(order("airfryer liner", ["Silicone Air Fryer Liner Round", "Philips Airfryer Liner set"]), ["Silicone Air Fryer Liner Round", "Philips Airfryer Liner set"]);
    assert.ok(order("samsung case", ["Samsung Clear Case Galaxy A56"]).every((x) => !x.startsWith("acc:")));
  });
  test("main products with an accessory word in the name are not moved", () => {
    assert.deepEqual(order("kenwood mixer", ["Kenwood Hand Mixer", "Kenwood Chef Stand Mixer"]), ["Kenwood Hand Mixer", "Kenwood Chef Stand Mixer"]);
    assert.ok(order("coleman", ["Coleman Sleeping Bag", "Coleman Tower Fan"]).every((x) => !x.startsWith("acc:")));
    assert.deepEqual(order("camping tent", ["Tent Pegs for Camping Tent 10pcs", "Coleman 4 Person Camping Tent"]), ["Coleman 4 Person Camping Tent", "acc:Tent Pegs for Camping Tent 10pcs"]);
  });
  test("device searches keep their own order (consoles first)", () => {
    const r = W.srchFilter("PS5", tk(), L(["PlayStation 5 Slim Console", "EA Sports FC 26 PS5"]));
    assert.equal(r[0].title, "PlayStation 5 Slim Console"); assert.equal(r[0].rank, 0);
  });
  test("the page says main products first, then accessories and parts", () => {
    const res = readFileSync(new URL("../../public/result.js", import.meta.url), "utf8");
    assert.match(res, /main products first, then accessories and parts, lowest price first in each/);
  });
});
