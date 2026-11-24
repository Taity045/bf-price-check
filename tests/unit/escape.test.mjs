import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { W, worker } from "../helpers/load-worker.mjs";
import { testDb } from "../helpers/db.mjs";

const NASTY = `<script>alert("x")</script> & 'quotes'`;
const ESCAPED = "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quotes&#39;";

describe("HTML escaping", () => {
  test("server escHtml", () => {
    assert.equal(W.escHtml(NASTY), ESCAPED);
    assert.equal(W.escHtml(null), "");
    assert.equal(W.escHtml(undefined), "");
    assert.equal(W.escHtml(0), "0");
    assert.equal(W.escHtml("&amp;"), "&amp;amp;", "escapes already-escaped text again");
  });
  test("the page's own esc() matches the server's", () => {
    const html = readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");
    const line = html.match(/^const esc = .*$/m);
    assert.ok(line, "esc() found in public/index.html");
    const esc = new Function(line[0] + "; return esc;")();
    for (const s of [NASTY, "", null, "R 1 299", "a\"b'c<d>e&f"]) assert.equal(esc(s), W.escHtml(s));
  });
  test("link previews escape a product title from the shop", async (t) => {
    const { db, env } = testDb(t);
    const url = "https://shop.co.za/p/1";
    db.prepare("INSERT INTO tracked (url, orig_url, title, added_at, last_viewed) VALUES (?, ?, ?, ?, ?)").run(url, url, "x", Date.now(), Date.now());
    db.prepare("INSERT INTO verdicts (url, host, title, verdict, price, currency, n, archived, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)").run(url, "shop.co.za", `"><script>alert(1)</script>`, "Same old price", 100, "ZAR", 3, Date.now());
    const r = await worker.fetch(new Request("https://site.test/?u=" + encodeURIComponent(url), { headers: { "user-agent": "WhatsApp/2.24" } }), env, { waitUntil() {} });
    const page = await r.text();
    assert.equal(r.status, 200);
    assert.ok(!page.includes("<script>alert(1)</script>"), "raw title must not reach the page");
    assert.match(page, /<meta property="og:title" content="Same old price: &quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;">/);
  });
});
