import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { W } from "../helpers/load-worker.mjs";
import { fixture } from "../helpers/fixtures.mjs";

const extract = (name, host) => W.extractFromHtml(fixture(name), host);

describe("parsePrice: structured data (machine format, '.' is always the decimal point)", () => {
  const cases = [
    ["999.990", 999.99], ["1299.000", 1299], ["1299.99", 1299.99], ["1299", 1299], ["0.299", 0.3], ["12.5", 12.5], ["1.299", 1.3],
    [1299, 1299], [12.345, 12.35], [999.99, 999.99],
    ["1,299.00", 1299], ["1,299", 1299], ["£1,299.99", 1299.99], ["1299,00", 1299], ["12,5", 12.5], ["1.299,00", 1299], ["1.299,00 €", 1299],
    ["R 1 299,00", 1299], ["1 234 567,89", 1234567.89], ["R&nbsp;450", 450], ["R1,299", 1299],
    ["1.299.000", null], ["1299,000", null], ["0", null], ["abc", null], ["", null], [null, null], [undefined, null], [-5, null], [1e8, null],
  ];
  for (const [input, want] of cases) test(`${JSON.stringify(input)} -> ${want}`, () => assert.equal(W.parsePrice(input), want));
});

describe("parseTextPrice: visible text (thousands groups only when the reading is clear)", () => {
  const cases = [
    ["R 1.299", 1299], ["€999.990", 999990], ["1.299 EUR", 1299], ["1.299,00", 1299], ["1.299,00 €", 1299], ["1.299.000", 1299000],
    ["1,299", 1299], ["R1,299", 1299], ["1,299,000", 1299000], ["£1,299.99", 1299.99], ["R 1 299,00", 1299], ["1 234 567,89", 1234567.89],
    ["1299.000", 1299], ["1299,00", 1299], ["12,5", 12.5], ["12.5", 12.5], ["R 12 999.000", 12999], ["R&nbsp;450", 450],
    ["1.299", null], ["999.990", null], ["1299,000", 1299], ["1,2,3", null], ["1.2.3,00", null], ["abc", null], [null, null],
  ];
  for (const [input, want] of cases) test(`${JSON.stringify(input)} -> ${want}`, () => assert.equal(W.parseTextPrice(input), want));
  test("a currency next to the number (price block) makes one group clear", () => {
    assert.equal(W.parseTextPrice("999.990", { currency: true }), 999990);
    assert.equal(W.parseTextPrice("1.299", { currency: true }), 1299);
  });
});

describe("structured price wins over the visible price", () => {
  const page = (ld, block) => `<html><head><title>T</title>${ld}</head><body><div class="product-detail-price"><span>${block}</span></div></body></html>`;
  const ld = (price) => `<script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "Thing", offers: { "@type": "Offer", price, priceCurrency: "EUR" } })}</script>`;
  test("JSON-LD \"999.990\" is 999.99 even when the page shows €999.990", () => {
    const r = W.extractFromHtml(page(ld("999.990"), "€999.990"), "shop.example");
    assert.equal(r.price, 999.99); assert.equal(r.source, "json-ld");
  });
  test("JSON-LD and the visible block disagree: JSON-LD is used", () => {
    const r = W.extractFromHtml(page(ld("1299.000"), "R 1 499,00"), "shop.example");
    assert.equal(r.price, 1299); assert.equal(r.source, "json-ld");
  });
  test("og price tag \"1299.000\" is 1299; itemprop content \"999.990\" is 999.99", () => {
    assert.equal(W.extractFromHtml(`<html><head><meta property="product:price:amount" content="1299.000"><meta property="product:price:currency" content="ZAR"></head><body><div class="pdp-price">R 1 499</div></body></html>`, "shop.example").price, 1299);
    assert.equal(W.extractFromHtml(`<html><body><span itemprop="price" content="999.990">R 999,99</span><div class="pdp-price">R 1 499</div></body></html>`, "shop.example").price, 999.99);
  });
  test("no structured price: the visible block is read with the text rules", () => {
    const r = W.extractFromHtml(page("", "R 1 299,00 <del>R 1 599,00</del>"), "shop.example");
    assert.equal(r.price, 1299); assert.equal(r.was, 1599); assert.equal(r.source, "price-block");
  });
});

describe("currency mapping", () => {
  test("country domains", () => {
    assert.equal(W.tldCurrency("www.woolworths.co.za"), "ZAR");
    assert.equal(W.tldCurrency("www.argos.co.uk"), "GBP");
    assert.equal(W.tldCurrency("www.mediamarkt.de"), "EUR");
    assert.equal(W.tldCurrency("shop.example.ie"), "EUR");
    assert.equal(W.tldCurrency("www.example.com"), null);
    assert.equal(W.tldCurrency(""), null);
  });
  test("South African shops on .com domains are ZAR", () => {
    for (const h of ["www.takealot.com", "takealot.com", "www.cyclelab.com", "www.bash.com", "www.superbalist.com", "www.evetech.com", "m.netflorist.com", "www2.makro.com"]) {
      assert.equal(W.tldCurrency(h), "ZAR", h);
    }
  });
  test("other .com shops are not guessed", () => assert.equal(W.tldCurrency("www.amazon.com"), null));
  test("currency symbols", () => {
    assert.equal(W.symbolCurrency("£8.00"), "GBP");
    assert.equal(W.symbolCurrency("1.299,00 €"), "EUR");
    assert.equal(W.symbolCurrency("R 1 299"), "ZAR");
    assert.equal(W.symbolCurrency("ZAR 10"), "ZAR");
    assert.equal(W.symbolCurrency("$5"), "USD");
    assert.equal(W.symbolCurrency("PRICE 5"), null);
  });
});

describe("price extraction from saved pages", () => {
  test("JSON-LD @graph with sale and strikethrough price specifications", () => {
    const r = extract("jsonld-graph.html", "www.woolworths.co.za");
    assert.equal(r.source, "json-ld");
    assert.equal(r.price, 1299);
    assert.equal(r.was, 1599);
    assert.equal(r.currency, "ZAR");
    assert.equal(r.title, "Cotton Rich Crew Neck T-shirt & Socks");
    assert.equal(r.gtin, "6009209876543");
    assert.equal(r.mpn, "TS-100");
    assert.equal(r.brand, "Studio W");
    assert.equal(r.image, "https://images.example.co.za/tshirt.jpg");
  });
  test("JSON-LD ProductGroup takes the first variant's price", () => {
    const r = extract("jsonld-product-group.html", "www.shop.co.uk");
    assert.deepEqual([r.source, r.price, r.currency, r.title], ["json-ld", 89.99, "GBP", "Running Shoe"]);
  });
  test("Open Graph product meta tags", () => {
    const r = extract("og-meta.html", "shop.co.uk");
    assert.deepEqual([r.source, r.price, r.was, r.currency, r.title], ["og-meta", 1249.5, 1499, "GBP", "Ceramic Pour-Over Set"]);
  });
  test("schema.org microdata", () => {
    const r = extract("microdata.html", "www.builders.co.za");
    assert.deepEqual([r.source, r.price, r.currency], ["microdata", 1499, "ZAR"]);
  });
  test("Next.js state with centAmount prices", () => {
    const r = extract("next-data-cents.html", "shop.co.za");
    assert.deepEqual([r.source, r.price, r.was, r.currency], ["page-data-v2", 499.99, 699.99, "ZAR"]);
  });
  test("main product price block with a crossed-out price, ignoring related products", () => {
    const r = extract("price-block.html", "www.evetech.co.za");
    assert.deepEqual([r.source, r.price, r.was, r.currency], ["price-block", 69999.99, 119999.99, "ZAR"]);
  });
  test("Cycle Lab GA4 view_item data layer (real page, trimmed)", () => {
    const r = extract("cyclelab-view-item.html", "www.cyclelab.com");
    assert.equal(r.source, "datalayer");
    assert.equal(r.price, 69999.99);
    assert.equal(r.currency, "ZAR");
    assert.equal(r.was, 119999.99, "discount of R 50000 gives the list price");
    assert.match(r.title, /^Demo Orbea Terra M21e Team Carbon Gravel Bike 700c Green S 2023$/);
  });
  test("view_item_list (related products) is ignored", () => {
    const html = '<script>dataLayer.push({ event: "view_item_list", ecommerce: { currency: "ZAR", items: [{ price: "499.00" }] } });</script>';
    assert.equal(W.parseDataLayer(html, {}), null);
  });
  test("Amazon page uses the buy-box price, not other JSON-LD", () => {
    const r = extract("amazon-product.html", "www.amazon.co.uk");
    assert.deepEqual([r.source, r.price, r.was, r.currency], ["amazon-page", 8, 16.99, "GBP"]);
    assert.equal(r.title, "Atomic Habits: the life-changing million-copy & bestseller");
  });
  test("was price lower than or equal to the price is dropped", () => {
    const html = '<script type="application/ld+json">{"@type":"Product","name":"X","offers":{"price":"100","priceCurrency":"GBP","priceSpecification":{"priceType":"ListPrice","price":"90"}}}</script>';
    const r = W.extractFromHtml(html, "x.co.uk");
    assert.equal(r.price, 100);
    assert.equal(r.was, null);
  });
  test("a currency of 'R' becomes ZAR and junk currency is dropped", () => {
    const meta = (c) => `<meta property="product:price:amount" content="10"><meta property="product:price:currency" content="${c}">`;
    assert.equal(W.extractFromHtml(meta("R"), "x.co.za").currency, "ZAR");
    assert.equal(W.extractFromHtml(meta("rand"), "x.co.za").currency, null);
  });
  test("page with no price", () => {
    const r = W.extractFromHtml("<html><title>Hello &amp; welcome</title></html>", "x.co.uk");
    assert.equal(r.source, null);
    assert.equal(r.price, undefined);
    assert.equal(r.title, "Hello & welcome");
  });
});

describe("bot checks and blocks", () => {
  test("Amazon interstitial (real page, trimmed) is a block", () => {
    assert.match(W.detectBlock(200, fixture("amazon-bot-check.html")), /bot check/);
  });
  test("Cloudflare challenge page is a block", () => {
    assert.match(W.detectBlock(200, fixture("cloudflare-challenge.html")), /bot check/);
  });
  test("refusal status codes", () => {
    for (const s of [401, 403, 429, 503]) assert.match(W.detectBlock(s, ""), new RegExp(`HTTP ${s}`));
  });
  test("a normal product page that mentions captcha in a script but has JSON-LD price is not a block", () => {
    const html = '<script src="recaptcha.js"></script><script type="application/ld+json">{"@type":"Product","offers":{"price":"10"}}</script>';
    assert.equal(W.detectBlock(200, html), null);
  });
  test("normal page", () => assert.equal(W.detectBlock(200, fixture("og-meta.html")), null));
});

describe("Takealot API", () => {
  test("barcode is found in product information", () => {
    assert.equal(W.takealotBarcode(JSON.parse(fixture("takealot-api.json"))), "9781022725812");
    assert.equal(W.takealotBarcode({ product_information: { items: [] } }), undefined);
  });
  test("takealotApi reads the selected buy-box offer (no network)", async (t) => {
    t.mock.method(globalThis, "fetch", async (raw) => {
      const u = new URL(raw);
      if (u.hostname === "1.1.1.1" || u.hostname === "dns.google") return Response.json({ Status: 0, Answer: [{ type: 1, data: "104.18.0.1" }] });
      assert.equal(u.hostname, "api.takealot.com");
      assert.match(u.pathname, /PLID94290998$/);
      return new Response(fixture("takealot-api.json"), { headers: { "content-type": "application/json" } });
    });
    const r = await W.takealotApi("94290998");
    assert.equal(r.price, 1189);
    assert.equal(r.was, 1216);
    assert.equal(r.currency, "ZAR");
    assert.equal(r.source, "takealot-api");
    assert.equal(r.gtin, "9781022725812");
    assert.match(r.image, /s-pdpxl\.file$/);
  });
  test("takealotApi reports out-of-stock and HTTP errors", async (t) => {
    let body = { buybox: { items: [] } }, status = 200;
    t.mock.method(globalThis, "fetch", async (raw) => {
      const u = new URL(raw);
      if (u.hostname === "1.1.1.1" || u.hostname === "dns.google") return Response.json({ Status: 0, Answer: [{ type: 1, data: "104.18.0.1" }] });
      return Response.json(body, { status });
    });
    assert.match((await W.takealotApi("1")).error, /no offer/);
    status = 500;
    assert.match((await W.takealotApi("1")).error, /HTTP 500/);
  });
});

describe("canonical product links", () => {
  const canon = (u) => W.canonicalize(new URL(u));
  test("Amazon keeps only the ASIN", () => {
    const c = canon("https://amazon.co.za/Some-Name/dp/b0dgj7hyg1/ref=sr_1_1?keywords=x&th=1");
    assert.deepEqual(c, { canon: "https://www.amazon.co.za/dp/B0DGJ7HYG1", kind: "amazon", asin: "B0DGJ7HYG1" });
  });
  test("Takealot keeps the PLID path", () => {
    const c = canon("https://www.takealot.com/airpods-pro-3/PLID94290998/?utm_source=x&gclid=1");
    assert.deepEqual(c, { canon: "https://www.takealot.com/airpods-pro-3/PLID94290998", kind: "takealot", plid: "94290998" });
  });
  test("tracking parameters are dropped and the rest sorted", () => {
    assert.equal(canon("https://shop.co.uk/p?size=9&utm_campaign=bf&colour=red#reviews").canon, "https://shop.co.uk/p?colour=red&size=9");
  });
});

describe("shop list", () => {
  test("Amazon is not on the 'works' list", () => {
    assert.ok(!W.SHOP_LIST.works.some((s) => /amazon/i.test(s.name)));
    assert.ok(W.SHOP_LIST.works.some((s) => s.name === "Takealot"));
  });
  test("shopFor matches subdomains and paths", () => {
    assert.equal(W.shopFor("https://www.takealot.com/x/PLID1")?.name, "Takealot");
    assert.equal(W.shopFor("takealot.com")?.name, "Takealot");
    assert.equal(W.shopFor("https://nottakealot.com/"), null);
  });
});

describe("barcode from microdata", () => {
  test("reads itemprop gtin13 (Loot style) when JSON-LD has none", () => {
    const html = '<div itemscope itemtype="https://schema.org/Product"><meta itemProp="sku" content="hfbk-8342-g710"/><meta itemProp="gtin13" content="8806095847788"/><h1 itemProp="name">Samsung Galaxy S25</h1><meta itemprop="price" content="16799"><meta itemprop="priceCurrency" content="ZAR"></div>';
    assert.equal(W.extractFromHtml(html, "www.loot.co.za").gtin, "8806095847788");
  });
  test("ignores a gtin that is not 8-14 digits", () => {
    const html = '<meta itemprop="gtin13" content="n/a"><meta itemprop="price" content="10"><meta itemprop="priceCurrency" content="ZAR">';
    assert.equal(W.extractFromHtml(html, "x.co.za").gtin, undefined);
  });
});
