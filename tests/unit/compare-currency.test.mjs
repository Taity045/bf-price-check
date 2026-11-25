import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { W } from "../helpers/load-worker.mjs";

const shop = W.CMP_SHOPS.find((s) => s.id === "escentual");
const suggest = { resources: { results: { products: [{ title: "YSL Libre Eau de Parfum Spray 50ml", vendor: "Yves Saint Laurent", price: "107.00", url: "/products/libre", handle: "libre", available: true }] } } };
function stub(t, cookie) {
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (u) => { seen.push(String(u)); return new Response(JSON.stringify(suggest), { headers: { "content-type": "application/json", ...(cookie ? { "set-cookie": cookie } : {}) } }); };
  t.after(() => { globalThis.fetch = orig; });
  return seen;
}
describe("Shopify prices stay in the shop's own currency", () => {
  test("the search asks for the shop's home country and currency (UK prices with UK VAT)", async (t) => {
    const seen = stub(t, "cart_currency=GBP; path=/");
    const list = await W.CMP_SEARCH.shopify(shop, "libre");
    assert.equal(list.length, 1);
    assert.match(seen[0], /[?&]country=GB&currency=GBP$/);
  });
  test("an answer priced in another currency is refused, not shown", async (t) => {
    stub(t, "cart_currency=ZAR; path=/");
    await assert.rejects(() => W.CMP_SEARCH.shopify(shop, "libre"), /another currency/);
  });
  test("product details ask for the shop's currency too", async (t) => {
    const seen = stub(t, null);
    await W.CMP_DETAIL.shopify(shop, { handle: "libre" }).catch(() => {});
    assert.match(seen[0], /\/products\/libre\.js\?country=GB&currency=GBP$/);
  });
});
describe("matched option title", () => {
  test("an option already named in the title is not repeated", () => {
    const id = W.cmpIdentity({ title: "YSL Libre Eau de Parfum 50ml", brand: "Yves Saint Laurent", price: 90 }, "https://allbeauty.com/products/x");
    const c = { title: "Libre Eau De Parfum 50ml", price: 85, url: "https://fenwick.co.uk/products/y" };
    W.cmpApplyDetail(id, c, { variants: [{ title: "50ml", price: 85.6, barcode: null, available: true }] });
    assert.equal(c.title, "Libre Eau De Parfum 50ml");
    const c2 = { title: "Libre Eau De Parfum", price: 85, url: "https://fenwick.co.uk/products/y" };
    W.cmpApplyDetail(id, c2, { variants: [{ title: "50ml", price: 85.6, barcode: null, available: true }, { title: "90ml", price: 120, barcode: null, available: true }] });
    assert.equal(c2.title, "Libre Eau De Parfum 50ml");
  });
});
describe("checking a page at a Shopify shop we know", () => {
  test("asks for the shop's home country and currency (Lakeland with UK VAT, not an export price)", async (t) => {
    const urls = [];
    t.mock.method(globalThis, "fetch", async (raw) => {
      const u = new URL(raw);
      if (["1.1.1.1", "dns.google"].includes(u.hostname)) return Response.json({ Status: 0, Answer: u.searchParams.get("type") === "A" ? [{ type: 1, data: "104.16.0.1" }] : [] });
      urls.push(u.href);
      return new Response('<html><script type="application/ld+json">{"@type":"Product","name":"Ninja AF300UK","offers":{"price":"199.99","priceCurrency":"GBP"}}</script></html>', { headers: { "content-type": "text/html" } });
    });
    const u = "https://www.lakeland.co.uk/products/ninja-foodi-dual-air-fryer-7-6l-af300uk";
    const r = await W.getCurrent(W.canonicalize(new URL(u)), u, "www.lakeland.co.uk");
    assert.equal(r.price, 199.99);
    assert.equal(urls[0], u + "?country=GB&currency=GBP");
    urls.length = 0;
    const o = "https://www.example.co.uk/products/x";
    await W.getCurrent(W.canonicalize(new URL(o)), o, "www.example.co.uk");
    assert.equal(urls[0], o);
  });
});
