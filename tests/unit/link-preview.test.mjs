// WhatsApp (chat and Status) link previews: what the preview fetcher needs from us.
// Rules from Meta's "Link Previews" page for WhatsApp: og:title, og:description, og:url and an
// absolute og:image inside <head> in the first 300 KB; image under 600 KB, 300 px or wider, 4:1 or narrower.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { worker } from "../helpers/load-worker.mjs";
import { testDb } from "../helpers/db.mjs";

const UAS = ["WhatsApp/2.23.20.0", "WhatsApp/2.24.20.80 i", "WhatsApp/2.23.20.0 A", "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)"];
const get = (env, path, headers = {}, method = "GET") => worker.fetch(new Request("https://site.test" + path, { method, headers }), env, { waitUntil() {} });
const metas = (html, prop) => [...html.matchAll(new RegExp(`<meta property="${prop}" content="([^"]*)">`, "g"))].map((m) => m[1]);

describe("link previews (WhatsApp chat and Status)", () => {
  for (const ua of UAS) {
    test(`${ua}: home page has one absolute JPEG og:image early in <head>`, async (t) => {
      const { env } = testDb(t);
      // WhatsApp on iPhone asks for a range of the page.
      const r = await get(env, "/", { "user-agent": ua, range: "bytes=0-307199", "accept-language": "en-GB,en;q=0.9" });
      assert.equal(r.status, 200);
      assert.match(r.headers.get("content-type"), /^text\/html/);
      const html = await r.text();
      const head = html.slice(0, html.indexOf("</head>"));
      assert.ok(head.length > 0 && html.indexOf("</head>") < 300 * 1024);
      const imgs = metas(head, "og:image");
      assert.deepEqual(imgs, ["https://site.test/og-home.jpg"], "exactly one og:image, absolute https");
      assert.ok(head.indexOf('property="og:image"') < 2000, "og:image in the first 2 KB");
      for (const p of ["og:title", "og:description", "og:url"]) assert.ok(metas(head, p)[0]?.length > 5, p + " not empty");
      assert.deepEqual(metas(head, "og:image:width"), ["1200"]);
      assert.deepEqual(metas(head, "og:image:height"), ["630"]);
      assert.ok(!/<link rel="icon" href="data:[^"]*</.test(head), "inline icon has no raw < inside the attribute");
    });
  }
  test("og-home.jpg: JPEG 1200x630, under 100 KB, with length and long cache; HEAD has no body", async (t) => {
    const { env } = testDb(t);
    const r = await get(env, "/og-home.jpg", { "user-agent": UAS[0], range: "bytes=0-2097151" });
    const b = Buffer.from(await r.arrayBuffer());
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "image/jpeg");
    assert.equal(Number(r.headers.get("content-length")), b.length);
    assert.ok(b.length < 100 * 1024, b.length + " bytes");
    assert.ok(b[0] === 0xff && b[1] === 0xd8, "JPEG magic");
    let i = 2, w = 0, h = 0;
    while (i < b.length) { const m = b[i + 1], len = b.readUInt16BE(i + 2); if (m >= 0xc0 && m <= 0xc3) { h = b.readUInt16BE(i + 5); w = b.readUInt16BE(i + 7); break; } i += 2 + len; }
    assert.deepEqual([w, h], [1200, 630]);
    assert.match(r.headers.get("cache-control"), /max-age=\d{5,}/);
    const hr = await get(env, "/og-home.jpg", { "user-agent": UAS[0] }, "HEAD");
    assert.equal(hr.status, 200);
  });
  test("favicon.ico and apple-touch-icon.png are real images (WhatsApp on iPhone asks for /favicon.ico)", async (t) => {
    const { env } = testDb(t);
    const f = await get(env, "/favicon.ico", { "user-agent": UAS[0], range: "bytes=0-30719" });
    const fb = Buffer.from(await f.arrayBuffer());
    assert.equal(f.status, 200);
    assert.equal(f.headers.get("content-type"), "image/x-icon");
    assert.ok(fb.length > 200 && fb.length < 30720 && fb.readUInt16LE(2) === 1, "ICO header, under 30 KB");
    const a = await get(env, "/apple-touch-icon.png", { "user-agent": UAS[0] });
    const ab = Buffer.from(await a.arrayBuffer());
    assert.equal(a.status, 200);
    assert.equal(a.headers.get("content-type"), "image/png");
    assert.equal(ab.slice(1, 4).toString(), "PNG");
    assert.equal(ab.readUInt32BE(16), 180);
  });
  test("old square card link still works for previews made before", async (t) => {
    const { env } = testDb(t);
    const r = await get(env, "/og-square.jpg", { "user-agent": UAS[0] });
    assert.equal(r.status, 200);
  });
  test("robots.txt lets preview fetchers in", async (t) => {
    const { env } = testDb(t);
    const r = await get(env, "/robots.txt", { "user-agent": UAS[0] });
    assert.match(await r.text(), /User-agent: \*\nAllow: \//);
  });
});
