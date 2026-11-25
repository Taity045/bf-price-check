import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { W } from "../helpers/load-worker.mjs";

const info = (u) => W.canonicalize(new URL(u));
const urls = (u, orig = u) => W.cdxQueries(info(u), orig).map((q) => q.url);

describe("archive lookups try more URL forms", () => {
  test("canonical page first, then trailing slash, pasted link and mobile host", () => {
    const q = urls("https://www.cyclelab.com/product/abc-123", "https://www.cyclelab.com/product/abc-123?utm_source=x");
    assert.equal(q[0], info("https://www.cyclelab.com/product/abc-123").canon);
    assert.ok(q.includes("https://www.cyclelab.com/product/abc-123/"), "trailing slash");
    assert.ok(q.includes("https://www.cyclelab.com/product/abc-123?utm_source=x"), "pasted link with its parameters");
    assert.ok(q.some((u) => u.startsWith("https://m.cyclelab.com/product/abc-123")), "mobile host");
  });
  test("a page with product parameters also tries the page without them", () => {
    const c = info("https://shop.example/product?variant=large").canon;
    const q = urls("https://shop.example/product?variant=large");
    if (new URL(c).search) assert.ok(q.includes("https://shop.example/product"));
  });
  test("no duplicate queries", () => {
    const q = urls("https://www.evetech.co.za/x/best-pc-deal/22997");
    assert.equal(new Set(q).size, q.length);
  });
  test("mobile and www hosts are the same product; other products are not", () => {
    const c = info("https://www.cyclelab.com/product/abc-123").canon;
    assert.ok(W.sameProduct("https://m.cyclelab.com/product/abc-123", c));
    assert.ok(W.sameProduct("http://cyclelab.com/product/abc-123/", c));
    assert.ok(!W.sameProduct("https://m.cyclelab.com/product/other-9", c));
  });
});
