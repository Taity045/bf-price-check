// ---------- shop readers ----------
// Some big SA shops show no readable price in their plain product page, or a wrong one.
// These readers use only what the shop serves to a normal browser: the same public JSON API its own
// product page calls, or data inside the page itself. They never go round a bot wall.
//  - API readers (TFG/VTEX, Mr Price group, Pick n Pay) replace the page fetch: one small JSON request.
//  - Page readers (Cape Union Mart/Poetry RSC data, NetFlorist, Clicks, Absolute Pets) read the page we
//    already fetched, before the general readers.
// robots.txt: checked by hand for every endpoint here (2026-11-25); the daily check also tests
// readerTarget(url) against the shop's robots.txt (src/daily.js).

const TFG_HOSTS = ["bash.com", "foschini.co.za", "markham.co.za", "sportscene.co.za", "totalsports.co.za", "americanswiss.co.za", "volpes.co.za", "hi-online.co.za", "athome.co.za", "zando.co.za", "exactonline.co.za", "jet.co.za", "fabiani.co.za", "dueloutdoor.co.za", "sterns.co.za"];
const MRP_STORES = { "mrp.com": ["en_za", "01_"], "mrphome.com": ["mrphome_en_za", "02_"], "mrpsport.com": ["mrpsport_en_za", "07_"] };
const SFCC_RSC_HOSTS = ["capeunionmart.co.za", "poetry.co.za", "trenery.co.za", "countryroad.co.za", "witchery.co.za", "politix.co.za", "mimco.co.za", "oldkhaki.co.za"];
const MRP_GRAPHQL = "https://apiprd.omni.mrpg.com/graphql";
const PNP_STORE = "WC44";   // one fixed store: the price can differ a little per region

const rdHost = (u) => stripWww(new URL(u).hostname.toLowerCase());
const onHost = (host, list) => list.find((d) => host === d || host.endsWith("." + d)) || null;

// What to read for this URL: { id, api?: url to robots-check and fetch } or null (general readers only).
function readerFor(u) {
  let url; try { url = new URL(u); } catch { return null; }
  const host = rdHost(url.href), path = url.pathname;
  if (onHost(host, TFG_HOSTS)) {
    const m = path.match(/^\/([a-z0-9][a-z0-9-]{2,200})\/p\/?$/i);
    if (m) return { id: "tfg-vtex", slug: m[1].toLowerCase(), api: `https://bash.com/api/catalog_system/pub/products/search/${m[1].toLowerCase()}/p` };
  }
  const mrp = onHost(host, Object.keys(MRP_STORES));
  if (mrp) {
    const m = path.match(/-(\d{6,12})\/?$/);
    if (m) { const [store, prefix] = MRP_STORES[mrp]; return { id: "mrp-graphql", store, sku: prefix + m[1], api: MRP_GRAPHQL }; }
  }
  if (onHost(host, ["pnp.co.za"])) {
    const m = path.match(/\/p\/(\d{6,20}_[A-Z]{1,4})\/?$/);
    if (m) return { id: "pnp-occ", code: m[1], api: `https://www.pnp.co.za/pnphybris/v2/pnp-spa/products/${m[1]}?fields=FULL&storeCode=${PNP_STORE}` };
  }
  if (onHost(host, SFCC_RSC_HOSTS)) return { id: "sfcc-rsc", code: (path.match(/\/(\d{6,12}(?:-C\d{1,3})?)\.html$/i) || [])[1] || null };
  if (onHost(host, ["netflorist.co.za"])) return { id: "netflorist" };
  if (onHost(host, ["clicks.co.za"])) return { id: "clicks" };
  if (onHost(host, ["absolutepets.com"])) return { id: "absolutepets" };
  return null;
}
// The URL a robots.txt check must allow (API readers fetch the API, not the page).
const readerTarget = (u) => { const r = readerFor(u); return r && r.api ? r.api : u; };

const priceOrNull = (n) => { const p = parsePrice(n); return p && p > 0 ? p : null; };
const wasIf = (was, price) => (was && price && was > price * 1.005 ? was : null);

// ---- API readers ----
async function readApi(rd, agent, verifiedHost) {
  const headers = { ...(agent || { "user-agent": UA }), accept: "application/json" };
  if (rd.id === "tfg-vtex") {
    const r = await fetchStore(rd.api, headers, 10000, verifiedHost);
    if (!r.ok) { await r.body?.cancel(); return { error: `The shop's product data answered HTTP ${r.status}.` }; }
    return vtexProduct(JSON.parse(await readLimitedText(r)));
  }
  if (rd.id === "mrp-graphql") {
    const query = `{products(filter:{sku:{eq:${JSON.stringify(rd.sku)}}}){items{name sku url_key small_image{url} price_range{minimum_price{regular_price{value currency} final_price{value currency}}}}}}`;
    const r = await fetchStore(rd.api, { ...headers, "content-type": "application/json", store: rd.store }, 10000, verifiedHost, { method: "POST", body: JSON.stringify({ query }) });
    if (!r.ok) { await r.body?.cancel(); return { error: `The shop's product data answered HTTP ${r.status}.` }; }
    return mrpProduct(JSON.parse(await readLimitedText(r)));
  }
  if (rd.id === "pnp-occ") {
    const r = await fetchStore(rd.api, headers, 10000, verifiedHost);
    if (r.status === 400 || r.status === 404) { await r.body?.cancel(); return { error: "Pick n Pay has no product with this code." }; }
    if (!r.ok) { await r.body?.cancel(); return { error: `The shop's product data answered HTTP ${r.status}.` }; }
    return pnpProduct(JSON.parse(await readLimitedText(r)));
  }
  return { error: "No reader." };
}

// VTEX catalog answer: the lowest price of a size/colour in stock (else of any), and its list price as "was".
function vtexProduct(d) {
  const p = Array.isArray(d) ? d[0] : null;
  if (!p) return { error: "The shop has no product at this link now." };
  let best = null, any = null;
  for (const it of p.items || []) for (const s of it.sellers || []) {
    const o = s.commertialOffer || {}, pr = priceOrNull(o.Price);
    if (!pr) continue;
    const cand = { price: pr, list: priceOrNull(o.ListPrice), it };
    if (!any || pr < any.price) any = cand;
    if (o.AvailableQuantity > 0 && (!best || pr < best.price)) best = cand;
  }
  const pick = best || any;
  if (!pick) return { error: "The shop shows no price for this product now. It is probably out of stock." };
  const img = pick.it.images && pick.it.images[0] && pick.it.images[0].imageUrl;
  const ean = String(pick.it.ean || "").trim();
  return { price: pick.price, was: wasIf(pick.list, pick.price), currency: "ZAR", title: p.productName, image: img || null, brand: p.brand || undefined, gtin: /^\d{8,14}$/.test(ean) ? ean : undefined, source: "vtex-api", in_stock: !!best };
}

function mrpProduct(d) {
  const it = d && d.data && d.data.products && d.data.products.items && d.data.products.items[0];
  if (!it) return { error: "Mr Price has no product with this number now." };
  const mp = (it.price_range && it.price_range.minimum_price) || {};
  const price = priceOrNull(mp.final_price && mp.final_price.value), reg = priceOrNull(mp.regular_price && mp.regular_price.value);
  if (!price) return { error: "Mr Price shows no price for this product now." };
  const img = it.small_image && it.small_image.url;
  return { price, was: wasIf(reg, price), currency: (mp.final_price && mp.final_price.currency) || "ZAR", title: it.name, image: img && !/placeholder/i.test(img) ? img : null, source: "mrp-graphql" };
}

function pnpProduct(d) {
  const pr = d && d.price;
  const price = priceOrNull(pr && pr.value);
  if (!price) return { error: "Pick n Pay shows no price for this product now." };
  const im = (d.images || []).find((x) => x && x.url);
  return { price, was: wasIf(priceOrNull(pr.oldPrice), price), currency: pr.currencyIso || "ZAR", title: d.name, image: im ? new URL(im.url, "https://www.pnp.co.za/").href : null, source: "pnp-occ" };
}

// ---- page readers ----
// Returns { price, was?, currency?, title?, source } or null (then the general readers run).
function readPage(rd, html) {
  if (rd.id === "sfcc-rsc") return sfccRsc(html, rd.code);
  if (rd.id === "netflorist") return netflorist(html);
  if (rd.id === "clicks") return clicksPage(html);
  if (rd.id === "absolutepets") return absolutePets(html);
  return null;
}

// Country Road Group / Cape Union Mart (Next.js + Salesforce Commerce). The data is in the React stream
// (self.__next_f.push, JSON in a JS string, so quotes may be escaped). Per product code: list_price and
// sale_price in cents. Fallback: the schema.org offer price in the same stream.
function sfccRsc(html, code) {
  const q = '\\\\?"';   // a quote, maybe escaped
  if (code) {
    const i = html.search(new RegExp(`${q}pim_code${q}:${q}${code.replace(/[-]/g, "\\-")}${q}`));
    if (i >= 0) {
      const win = html.slice(i, i + 3000);
      const m = win.match(new RegExp(`${q}list_price${q}:(\\d+|null),${q}sale_price${q}:(\\d+|null)`));
      const name = win.match(new RegExp(`${q}pim_name${q}:${q}((?:[^"\\\\]|\\\\[^"])*?)${q}`));
      if (m && m[1] !== "null") {
        const list = Number(m[1]) / 100, sale = m[2] === "null" ? null : Number(m[2]) / 100;
        const price = sale && sale < list ? sale : list;
        return { price, was: sale && sale < list ? list : null, currency: "ZAR", title: name ? rscText(name[1]) : undefined, source: "rsc-data" };
      }
    }
  }
  const o = html.match(new RegExp(`${q}priceCurrency${q}:${q}([A-Z]{3})${q},${q}price${q}:${q}?([\\d.]+)`));
  if (o) { const price = priceOrNull(o[2]); if (price) return { price, was: null, currency: o[1], source: "rsc-json-ld" }; }
  return null;
}

// A JSON string body from the stream, maybe escaped once more (\" and \\u0026).
function rscText(s) { let t = s.replace(/\\"/g, '"').replace(/\\\\/g, "\\"); try { t = JSON.parse('"' + t.replace(/"/g, '\\"') + '"'); } catch {} return t.replace(/\s+/g, " ").trim(); }

// NetFlorist (Next.js pages router): __NEXT_DATA__ props.pageProps.initialProductData.productList[0].
// Read with a regex on that one object: the whole __NEXT_DATA__ is ~300 KB, too much to parse on each check.
function netflorist(html) {
  const i = html.indexOf('"initialProductData":{"productList":[{');
  if (i < 0) return null;
  const obj = html.slice(i, i + 4000);
  const price = priceOrNull((obj.match(/"productPrice":([\d.]+)/) || [])[1]);
  if (!price) return null;
  const was = priceOrNull((obj.match(/"productWasPrice":([\d.]+)/) || [])[1]);
  const t = html.match(/<h1 class="productTitle"[^>]*>([^<]{2,200})</);
  return { price, was: wasIf(was, price), currency: "ZAR", title: t ? decodeEntities(t[1]).trim() : undefined, source: "next-data" };
}

// Clicks: the JSON-LD is broken JSON and its price is the regular price. The page shows the promo price
// in .price.typo-h2; the hidden productPrice input holds the regular price.
function clicksPage(html) {
  const m = html.match(/class="price\s+typo-h2"[^>]*>([\s\S]{0,80}?)<\/div>/);
  const price = m && parseTextPrice(m[1].replace(/<[^>]+>/g, " "));
  if (!price) return null;
  const reg = html.match(/name="productPrice"\s+value="([\d.]+)"/);
  return { price, was: wasIf(reg && parsePrice(reg[1]), price), currency: "ZAR", source: "clicks-page" };
}

// Absolute Pets: the data layer value is without VAT. The main product price block (not related
// products or quick-buy) shows the shelf price, "from R…" when sizes cost different amounts (lowest).
function absolutePets(html) {
  const m = html.match(/id="ctl\d+_ctl\d+_productPrice_productPrice"[^>]*>([\s\S]{0,300}?)<\/div>/);
  if (!m) return null;
  const txt = m[1].replace(/<[^>]+>/g, " ");
  const amounts = [...txt.matchAll(/R\s?(\d[\d\s,]*(?:[.,]\d{2})?)/g)].map((a) => parseTextPrice(a[1], { currency: true })).filter(Boolean);
  if (!amounts.length) return null;
  const strike = m[1].match(/<(?:del|s|strike)\b[^>]*>([\s\S]*?)<\/(?:del|s|strike)>/i);
  const was = strike ? parseTextPrice(strike[1].replace(/<[^>]+>/g, " "), { currency: true }) : null;
  const rest = amounts.filter((a) => a !== was);
  const price = rest.length ? Math.min(...rest) : amounts[0];
  return { price, was: wasIf(was, price), currency: "ZAR", source: "absolutepets-page" };
}
