// Black Friday Price Check — Cloudflare Worker
// Routes:  GET /                -> the app (HTML)
//          GET /api/check?url=  -> live price + stored history
//          GET /api/archive?url= -> Wayback snapshot list
//          GET /api/snap?url=&ts=&orig= -> price from one Wayback snapshot (cached forever in D1)
//          POST /api/m          -> one button-click count (cookieless, see src/stats.js)
//          stats.veldwire.com   -> private stats dashboard (Cloudflare Access)
//          GET /api/daily-status -> counts for the daily price saving (no URLs)
//          scheduled (cron)     -> daily price saving, see src/daily.js
// Bindings: DB (D1)

const CHECK_TTL_MS = 6 * 3600 * 1000;      // cache a live check for 6 h
const CDX_TTL_MS = 12 * 3600 * 1000;       // cache the snapshot list for 12 h
const HISTORY_DAYS = 365;
const SNAP_REDIRECT_MS = 864e5;              // a Wayback redirect may move a copy by up to 1 day (copies can be 1 day apart)
const SNAP_SPACINGS = [1, 2, 3, 4, 6];       // days between used copies: the smallest that fits MAX_SNAPS
const MAX_SNAPS = 64;
const MAX_TRACKED = 1000;
const LIVE_CACHE_PREFIX = "check-v4:";
const RL = { check: 20, snap: 120, req: 5, verdict: 40, others: 20 };       // requests per IP per minute
const MAX_HTML = 4 * 1024 * 1024;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const TLD_CUR = [[".co.za","ZAR"],[".za","ZAR"],[".co.uk","GBP"],[".uk","GBP"],[".com.de","EUR"],[".de","EUR"],[".fr","EUR"],[".nl","EUR"],[".be","EUR"],[".es","EUR"],[".it","EUR"],[".ie","EUR"],[".at","EUR"],[".pt","EUR"],[".fi","EUR"],[".gr","EUR"],[".lu","EUR"],[".sk","EUR"],[".si","EUR"],[".ee","EUR"],[".lv","EUR"],[".lt","EUR"],[".hr","EUR"],[".mt","EUR"],[".cy","EUR"]];
const LANG = { ZAR: "en-ZA,en;q=0.9", GBP: "en-GB,en;q=0.9", EUR: "en-GB,en;q=0.8,de;q=0.6,nl;q=0.5,fr;q=0.5" };

// ---------- helpers ----------
const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*", ...extra } });
const now = () => Date.now();
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
const tsToMs = (ts) => Date.UTC(+ts.slice(0,4), +ts.slice(4,6)-1, +ts.slice(6,8), +ts.slice(8,10)||0, +ts.slice(10,12)||0, +ts.slice(12,14)||0);
const stripWww = (h) => h.replace(/^www\d?\./, "").replace(/^m\./, "");

// South African stores that use a .com (or other) domain.
const HOST_CUR = { "cyclelab.com": "ZAR", "takealot.com": "ZAR", "bash.com": "ZAR", "superbalist.com": "ZAR", "mrp.com": "ZAR", "pepstores.com": "ZAR", "loot.co.za": "ZAR", "dionwired.com": "ZAR", "hificorp.com": "ZAR", "evetech.com": "ZAR", "builders.com": "ZAR", "sportsmanswarehouse.com": "ZAR", "makro.com": "ZAR", "game.com": "ZAR", "zando.com": "ZAR", "netflorist.com": "ZAR" };
function tldCurrency(host) {
  const h = stripWww(String(host || "").toLowerCase());
  if (HOST_CUR[h]) return HOST_CUR[h];
  for (const [t, c] of TLD_CUR) if (h.endsWith(t)) return c;
  return null;
}

function decodeEntities(s) {
  return String(s).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function symbolCurrency(s) {
  if (/£|GBP/.test(s)) return "GBP";
  if (/€|EUR/.test(s)) return "EUR";
  if (/ZAR|(^|[^A-Za-z])R\s?\d/.test(s)) return "ZAR";
  if (/\$|USD/.test(s)) return "USD";
  return null;
}

const priceNum = (n) => (isFinite(n) && n > 0 && n < 1e7 ? Math.round(n * 100) / 100 : null);
const priceDigits = (v) => decodeEntities(String(v)).replace(/[\s\u00a0\u2009\u202f']/g, "").replace(/[^\d.,]/g, "").replace(/^[.,]+|[.,]+$/g, "");

// Machine-format price from structured data: JSON-LD offers.price, itemprop/meta content, og/product:price:amount,
// shop JSON APIs, data layers. "." is ALWAYS the decimal point, whatever the digit count: "999.990" -> 999.99,
// "1299.000" -> 1299. Also accepted, because each has one reading only: "1,299.00" / "1,299" (comma groups),
// "1299,00" (comma + 1-2 digits = decimal), "1.299,00" (comma after dots = European). Anything else
// (for example "1.299.000" or "1299,000") is not a machine number: null, so we never guess.
function parsePrice(v) {
  if (v == null) return null;
  if (typeof v === "number") return priceNum(v);
  const s = priceDigits(v);
  if (!s || !/\d/.test(s)) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return priceNum(parseFloat(s));
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return priceNum(parseFloat(s.replace(/,/g, "")));
  if (/^\d+,\d{1,2}$/.test(s)) return priceNum(parseFloat(s.replace(",", ".")));
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s)) return priceNum(parseFloat(s.replace(/\./g, "").replace(",", ".")));
  return null;
}

// Human-visible price text (the shop's price block, Amazon's price text, a price the user types).
// Thousands groups are used only when the reading is clear:
// - both marks: the last one is the decimal mark ("1.299,00", "1,299.99", "1 234 567,89");
// - commas only: "1,299" / "1,299,000" are groups; "12,5" / "1299,00" / "1299,000" are decimals;
// - dots only: "1.299.000" (2+ groups) is groups; "1.299" / "999.990" (one group) are groups only next to a currency
//   sign or code, otherwise unclear -> null; "1299.000" or "12.5" is a decimal.
function parseTextPrice(v, { currency = false } = {}) {
  if (v == null) return null;
  if (typeof v === "number") return priceNum(v);
  const raw = decodeEntities(String(v));
  const hasCur = currency || /[R$£€]|\b(?:ZAR|EUR|GBP|USD)\b/.test(raw);
  const s = priceDigits(raw);
  if (!s || !/\d/.test(s)) return null;
  const lc = s.lastIndexOf(","), ld = s.lastIndexOf(".");
  if (lc >= 0 && ld >= 0) {
    const dec = lc > ld ? "," : ".", grp = dec === "," ? "." : ",";
    const [int, frac, extra] = s.split(dec);
    if (extra !== undefined || !new RegExp(`^\\d{1,3}(\\${grp}\\d{3})*$`).test(int)) return null;
    return priceNum(parseFloat(int.split(grp).join("") + "." + frac));
  }
  if (lc < 0 && ld < 0) return priceNum(parseFloat(s));
  const sep = lc >= 0 ? "," : ".";
  const parts = s.split(sep);
  const grouped = /^[1-9]\d{0,2}$/.test(parts[0]) && parts.slice(1).every((x) => x.length === 3);
  if (grouped && parts.length > 2) return priceNum(parseFloat(parts.join("")));
  if (parts.length > 2) return null;
  if (!grouped) return priceNum(parseFloat(parts[0] + "." + parts[1]));
  // One group of 3 after 1-3 digits ("1,299", "1.299", "999.990").
  if (sep === "," || hasCur) return priceNum(parseFloat(parts.join("")));
  return null;
}

// ---------- URL safety ----------
function isPrivateIPv4(ip) {
  const p = ip.split(".").map(Number);
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || p.some((x) => x > 255)) return true;
  const [a, b, c] = p;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 100) return b >= 64 && b <= 127;
  if (a === 169) return b === 254;
  if (a === 172) return b >= 16 && b <= 31;
  if (a === 192) return b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99);
  if (a === 198) return b === 18 || b === 19 || (b === 51 && c === 100);
  return a === 203 && b === 0 && c === 113;
}
function isPrivateIPv6(ip) {
  if (!/^[\da-f:]+$/i.test(ip)) return true;
  const s = new URL("http://[" + ip + "]/").hostname.slice(1, -1);
  const [prefix, subnet] = s.split(":").map((part) => parseInt(part || "0", 16));
  if (prefix < 0x2000 || prefix > 0x3fff) return true; // outside global unicast
  if (prefix === 0x2001) return subnet < 0x200 || subnet === 0xdb8;
  return prefix === 0x2002 || (prefix === 0x3fff && subnet < 0x1000);
}

function validateUrl(raw) {
  if (!raw || raw.length > 2048) return { error: "Paste a product link (http or https)." };
  let u;
  try { u = new URL(raw.trim()); } catch { return { error: "That doesn't look like a valid link." }; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { error: "Only http(s) product links are allowed." };
  if (u.username || u.password) return { error: "Links with login details are not allowed." };
  if (u.port && u.port !== "80" && u.port !== "443") return { error: "Only standard web ports are allowed." };
  u.hostname = u.hostname.replace(/\.$/, "");
  const h = u.hostname.toLowerCase();
  if (!h.includes(".") || h.split(".").includes("") || /\.(local|internal|lan|home|corp|localhost|arpa)$/.test(h)) return { error: "That address is not a public website." };
  if (/^[\d.]+$/.test(h) || h.includes(":") || h.startsWith("[")) return { error: "Use the store's normal web address, not an IP address." };
  if (/(^|\.)workers\.dev$|(^|\.)archive\.org$/.test(h)) return { error: "That isn't a store page." };
  u.hash = "";
  return { url: u };
}

async function resolvesPublic(host) {
  // Literal private names are already rejected in validateUrl. Here we look the host up (DoH, with fallbacks).
  // Every address returned must be public. If no resolver answers at all, we return null: callers block (fail closed).
  // The cron treats null as "try later" and does not count it as a product failure.
  // NXDOMAIN (Status 3) is an answer with no addresses: we allow it, because the fetch then fails anyway.
  const endpoints = ["https://1.1.1.1/dns-query", "https://dns.google/resolve"];
  const lookup = async (type) => {
    for (const ep of endpoints) {
      try {
        const r = await fetch(`${ep}?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: "application/dns-json" }, redirect: "manual", signal: AbortSignal.timeout(3000) });
        if (!r.ok) continue;
        const d = await r.json();
        if (d.Status !== 0 && d.Status !== 3) continue;
        return (d.Answer || []).filter((a) => a.type === 1 || a.type === 28);
      } catch { /* try next resolver */ }
    }
    return null;
  };
  const lookups = await Promise.all([lookup("A"), lookup("AAAA")]);
  if (lookups.every((x) => x === null)) return null;
  const ips = lookups.filter(Boolean).flat();
  if (ips.length === 0) return true;
  return ips.every((a) => a.type === 1 ? !isPrivateIPv4(a.data) : !isPrivateIPv6(a.data));
}

// Marketing / tracking parameters that never select a different product.
const TRACKING = /^(utm_.*|gclid|gclsrc|dclid|fbclid|msclkid|mc_cid|mc_eid|srsltid|_ga|_gl|igshid|zanpid|awc|sv_campaign_id|cm_mmc|s_kwcid|ef_id|gad_source|gbraid|wbraid|ref|ref_|tag|source|campaign|cmp|cmpid|aff|affiliate|trk|spm|ito|mcid|sv1)$/i;

function canonicalize(u) {
  const c = new URL(u.toString());
  c.hash = "";
  const host = c.hostname.toLowerCase();
  // Amazon: the ASIN identifies the product (variants have their own ASIN), so the query is dropped.
  if (/(^|\.)amazon\./.test(host)) {
    const m = c.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/asin)\/([A-Z0-9]{10})(?:\/|$)/i);
    if (m) return { canon: `https://${host.startsWith("www.") ? host : "www." + host}/dp/${m[1].toUpperCase()}`, kind: "amazon", asin: m[1].toUpperCase() };
  }
  for (const k of [...c.searchParams.keys()]) if (TRACKING.test(k)) c.searchParams.delete(k);
  c.searchParams.sort();
  // Takealot: the PLID identifies the product; only variant parameters change what is sold.
  if (/(^|\.)takealot\.com$/.test(host) && ![...c.searchParams.keys()].some((k) => /variant|sku/i.test(k))) {
    const m = c.pathname.match(/PLID(\d+)/i);
    if (m) return { canon: `https://www.takealot.com${c.pathname.replace(/\/+$/, "")}`, kind: "takealot", plid: m[1] };
  }
  if (/(^|\.)woolworths\.co\.za$/.test(host)) {
    const m = c.pathname.match(/\/_\/(A-[0-9A-Za-z]+)/);
    if (m) return { canon: `https://www.woolworths.co.za/prod/_/${m[1]}${c.search}`, kind: "woolworths" };
  }
  let s = c.toString();
  if (s.endsWith("?")) s = s.slice(0, -1);
  return { canon: s, kind: "generic" };
}

// ---------- page parsing ----------
function typeHas(node, names) {
  const t = node && node["@type"];
  if (!t) return false;
  const arr = Array.isArray(t) ? t : [t];
  return arr.some((x) => names.includes(String(x).replace(/^https?:\/\/schema\.org\//, "")));
}

function readOffer(o, out) {
  if (!o || typeof o !== "object") return;
  if (Array.isArray(o)) { for (const x of o) readOffer(x, out); return; }
  if (o.offers) readOffer(o.offers, out);
  let price = parsePrice(o.price ?? o.lowPrice);
  let cur = o.priceCurrency;
  const specs = o.priceSpecification ? (Array.isArray(o.priceSpecification) ? o.priceSpecification : [o.priceSpecification]) : [];
  for (const sp of specs) {
    if (!sp || typeof sp !== "object") continue;
    const p = parsePrice(sp.price);
    const pt = String(sp.priceType || "");
    if (!cur && sp.priceCurrency) cur = sp.priceCurrency;
    if (/Strikethrough|ListPrice|MSRP|SRP|Regular/i.test(pt)) { if (p && !out.was) out.was = p; }
    else if (p && !price) price = p;
  }
  if (price && !out.price) { out.price = price; out.currency = out.currency || cur; }
  else if (!out.currency && cur) out.currency = cur;
}

function walkLd(node, out, depth = 0) {
  if (!node || typeof node !== "object" || depth > 8) return;
  if (Array.isArray(node)) { for (const n of node) walkLd(n, out, depth + 1); return; }
  if (node["@graph"]) walkLd(node["@graph"], out, depth + 1);
  if (typeHas(node, ["Product", "ProductGroup", "IndividualProduct", "ProductModel", "Book", "Vehicle", "SomeProducts"])) {
    if (!out.title && node.name) out.title = String(node.name);
    if (!out.gtin) { const g = node.gtin13 || node.gtin || node.gtin12 || node.gtin14 || node.gtin8 || node.ean; if (g && /^\d{8,14}$/.test(String(g).trim())) out.gtin = String(g).trim(); }
    if (!out.mpn && node.mpn) out.mpn = String(node.mpn).slice(0, 60);
    if (!out.brand && node.brand) out.brand = String(typeof node.brand === "object" ? node.brand.name || "" : node.brand).slice(0, 60) || undefined;
    if (!out.image && node.image) { const im = Array.isArray(node.image) ? node.image[0] : node.image; out.image = typeof im === "string" ? im : im && (im.url || im.contentUrl); }
    if (node.offers) readOffer(node.offers, out);
    if (!out.price && node.hasVariant) walkLd(node.hasVariant, out, depth + 1);
  } else if (typeHas(node, ["Offer", "AggregateOffer"]) && !out.price) {
    readOffer(node, out);
  } else if (node.mainEntity) walkLd(node.mainEntity, out, depth + 1);
}

function parseJsonLd(html, out) {
  const re = /<script[^>]+type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let m, n = 0;
  while ((m = re.exec(html)) && n++ < 30) {
    let txt = m[1].trim().replace(/^<!\[CDATA\[|\]\]>$/g, "");
    try { walkLd(JSON.parse(txt), out); }
    catch { try { walkLd(JSON.parse(txt.replace(/[\u0000-\u001f]+/g, " ")), out); } catch {} }
    if (out.price) return "json-ld";
  }
  return out.price ? "json-ld" : null;
}

function parseMeta(html, out) {
  const metas = {};
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const key = (tag.match(/\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const val = (tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i) || [])[1];
    if (key && val != null && !(key.toLowerCase() in metas)) metas[key.toLowerCase()] = decodeEntities(val);
  }
  if (!out.title) out.title = metas["og:title"] || metas["twitter:title"];
  if (!out.image) out.image = metas["og:image"] || metas["twitter:image"];
  let src = null;
  if (!out.price) {
    // og/product price tags are machine format; twitter:data1 is display text ("R 1 299").
    const tw = /\d/.test(metas["twitter:data1"] || "") && /price/i.test(metas["twitter:label1"] || "") ? metas["twitter:data1"] : null;
    const mp = metas["product:price:amount"] || metas["og:price:amount"] || metas["product:sale_price:amount"];
    const p = mp ? parsePrice(mp) : parseTextPrice(tw);
    if (p) { out.price = p; src = "og-meta"; }
    if (!out.currency) out.currency = metas["product:price:currency"] || metas["og:price:currency"] || metas["product:sale_price:currency"];
  }
  if (!out.was) {
    const w = parsePrice(metas["product:original_price:amount"] || metas["og:original_price:amount"] || metas["product:regular_price:amount"]);
    if (w) out.was = w;
  }
  if (!out.price) {
    const p = parsePrice(metas["price"]);
    if (p) { out.price = p; src = "microdata"; if (!out.currency) out.currency = metas["pricecurrency"]; }
  }
  if (!out.price) {
    const a = html.match(/itemprop\s*=\s*["']price["'][^>]*?\bcontent\s*=\s*["']([^"']+)["']/i) || html.match(/\bcontent\s*=\s*["']([^"']+)["'][^>]*?itemprop\s*=\s*["']price["']/i);
    if (a && parsePrice(a[1])) {
      out.price = parsePrice(a[1]); src = "microdata";
      const c = html.match(/itemprop\s*=\s*["']priceCurrency["'][^>]*?\bcontent\s*=\s*["']([A-Z]{3})["']/i) || html.match(/\bcontent\s*=\s*["']([A-Z]{3})["'][^>]*?itemprop\s*=\s*["']priceCurrency["']/i);
      if (c && !out.currency) out.currency = c[1];
    }
  }
  return src;
}

function textAfter(html, marker, len = 6000) {
  const i = html.indexOf(marker);
  return i < 0 ? null : html.slice(i, i + len);
}

function parseAmazon(html, out) {
  const block = textAfter(html, 'id="corePriceDisplay_desktop_feature_div"') || textAfter(html, 'id="corePrice_feature_div"') || textAfter(html, 'id="corePrice_desktop"') || textAfter(html, 'id="apex_desktop"') || textAfter(html, 'id="price_inside_buybox"', 800) || textAfter(html, 'id="priceblock_dealprice"', 800) || textAfter(html, 'id="priceblock_ourprice"', 800);
  if (!block) return null;
  let p = null, was = null;
  const pay = block.match(/priceToPay[\s\S]{0,400}?class="a-offscreen">([^<]+)</) || block.match(/apexPriceToPay[\s\S]{0,400}?class="a-offscreen">([^<]+)</) || block.match(/class="a-offscreen">([^<]*\d[^<]*)</) || block.match(/id="priceblock_(?:deal|our)price"[^>]*>([^<]+)</) || block.match(/id="price_inside_buybox"[^>]*>([^<]+)</);
  if (pay) { p = parseTextPrice(pay[1]); if (!out.currency) out.currency = symbolCurrency(pay[1]); }
  const w = block.match(/(?:basisPrice|a-text-price)[\s\S]{0,300}?class="a-offscreen">([^<]+)</);
  if (w) was = parseTextPrice(w[1]);
  if (!p) {
    const whole = block.match(/class="a-price-whole">([\d.,\s]+)/), frac = block.match(/class="a-price-fraction">(\d+)/);
    if (whole) p = parseTextPrice(whole[1].replace(/[.,]\s*$/, "").replace(/[.,\s]/g, "") + (frac ? "." + frac[1] : ""), { currency: true });
  }
  if (p) { out.price = p; if (was && was > p) out.was = was; }
  const t = html.match(/id="productTitle"[^>]*>\s*([^<]+)</);
  if (t) out.title = decodeEntities(t[1].trim());
  return p ? "amazon-page" : null;
}

function pageAmount(raw, fallbackCurrency) {
  if (!raw) return {};
  if (!raw.startsWith("{")) return { price: parsePrice(raw) };
  try {
    const amount = JSON.parse(raw);
    const currency = amount.currencyCode || amount.currency || fallbackCurrency;
    if (amount.centAmount == null) return { price: parsePrice(amount.value ?? amount.amount), currency };
    const digits = amount.fractionDigits ?? (currency ? new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits : 2);
    const units = amount.preciseAmount ?? amount.centAmount;
    if (!Number.isInteger(digits) || digits < 0 || digits > 6 || !/^\d+$/.test(units)) return {};
    const price = Number(units) / 10 ** digits;
    return price > 0 && price < 1e7 ? { price, currency } : {};
  } catch { return {}; }
}

// Generic fallbacks used by many shop platforms (Shopify, Magento, SFCC, Next.js data)
// GA4 "view_item" event pushed to dataLayer/gtag: ecommerce { currency, value, items: [{ price }] }.
// Only the view_item event is used, so prices of related products (view_item_list) are ignored.
function parseDataLayer(html, out) {
  const re = /["']?event["']?\s*[:,]\s*["']view_item["']/g;
  let m;
  while ((m = re.exec(html))) {
    const seg = html.slice(m.index, m.index + 2500);
    const cur = seg.match(/["']?currency["']?\s*:\s*["']([A-Z]{3})["']/);
    const item = seg.match(/items["']?\s*:\s*\[\s*\{([\s\S]{0,1500}?)\}/);
    const ip = item && item[1].match(/["']?price["']?\s*:\s*["']?([\d.,\s]+)["']?/);
    const val = seg.match(/["']?value["']?\s*:\s*["']?([\d.,\s]+)["']?/);
    const price = parsePrice((ip && ip[1]) || (val && val[1]));
    if (!price) continue;
    out.price = price;
    if (cur && !out.currency) out.currency = cur[1];
    const name = item && item[1].match(/["']?item_name["']?\s*:\s*["']([^"']{2,200})["']/);
    if (name && !out.title) out.title = name[1].trim();
    // a discount amount in the same item gives the list price
    const disc = item && item[1].match(/["']?discount["']?\s*:\s*["']?-?\s*(?:R|£|€)?\s*([\d.,]+)["']?/);
    const d = disc && parsePrice(disc[1]);
    if (d && d > 0 && d < price * 10) out.was = Math.round((price + d) * 100) / 100;
    return "datalayer";
  }
  return null;
}

// Last resort: the price block of the main product, e.g. <h3 class="r_price">R 69,999.99</h3> <del>R 119,999.99</del>.
// Only blocks whose class names say they belong to the product detail area are used, and the
// amount must carry a currency symbol, so prices of related products are not picked.
function parseMainPriceBlock(html, out) {
  const blockRe = /class\s*=\s*["'][^"']*(?:details?[-_ ]?box[-_ ]?price|product[-_ ]?(?:info|detail|main)[^"']*price|pdp[-_ ]?price|product-price-main|price[-_ ]?main)[^"']*["']/gi;
  const m = blockRe.exec(html);
  if (!m) return null;
  const blk = html.slice(m.index, m.index + 1500);
  const amt = /(R|£|€)\s?(\d{1,3}(?:[ ,\u00a0]\d{3})*(?:[.,]\d{2})?|\d+(?:[.,]\d{2})?)(?!\d)/;
  const strikeRe = /<(del|s|strike)\b[^>]*>([\s\S]{0,200}?)<\/\1>|class\s*=\s*["'][^"']*(?:old|was|inst|regular|list)[-_]?price[^"']*["'][^>]*>([^<]{0,80})/i;
  const sm = blk.match(strikeRe);
  const strikeTxt = sm ? (sm[2] || sm[3] || "") : "";
  const rest = sm ? blk.replace(sm[0], " ") : blk;
  const pm = rest.replace(/<[^>]+>/g, " ").match(amt);
  if (!pm) return null;
  const price = parseTextPrice(pm[2], { currency: true });
  if (!price) return null;
  out.price = price;
  if (!out.currency) out.currency = symbolCurrency(pm[0]);
  const wm = strikeTxt.replace(/<[^>]+>/g, " ").match(amt);
  const was = wm && parseTextPrice(wm[2], { currency: true });
  if (was && was > price) out.was = was;
  return "price-block";
}

function parseFallback(html, out) {
  // schema.org Offer embedded in a script (JSON-LD built by JavaScript, or app state)
  const offRe = /"@type"\s*:\s*"(?:Offer|AggregateOffer)"/g;
  let om, tries = 0;
  while ((om = offRe.exec(html)) && tries++ < 10) {
    const objTxt = enclosingObject(html, om.index);
    if (!objTxt) continue;
    let obj = null;
    try { obj = JSON.parse(objTxt); } catch { try { obj = JSON.parse(objTxt.replace(/\\"/g, '"')); } catch {} }
    if (!obj) continue;
    const tmp = {};
    readOffer(obj, tmp);
    if (tmp.price) {
      out.price = tmp.price; if (tmp.was) out.was = tmp.was; if (tmp.currency && !out.currency) out.currency = tmp.currency;
      return "schema-in-script";
    }
  }
  const m = html.match(/"(?:salePrice|sale_price|finalPrice|final_price|currentPrice|current_price|sellingPrice|offerPrice)"\s*:\s*(\{[^{}]{1,1000}\}|"[\d.,]+"|\d+(?:\.\d+)?)/);
  const c = m && html.match(/"(?:currency|currencyCode|priceCurrency)"\s*:\s*"([A-Z]{3})"/);
  const current = pageAmount(m?.[1], out.currency || c?.[1]);
  if (current.price) {
    out.price = current.price;
    const w = html.match(/"(?:wasPrice|was_price|listPrice|list_price|regularPrice|regular_price|originalPrice|original_price|strikethroughPrice|oldPrice|old_price|rrp)"\s*:\s*(\{[^{}]{1,1000}\}|"[\d.,]+"|\d+(?:\.\d+)?)/);
    out.currency = current.currency || out.currency || c?.[1];
    const previous = pageAmount(w?.[1], out.currency);
    if (previous.price > out.price && (!previous.currency || previous.currency === out.currency)) out.was = previous.price;
    return "page-data-v2";
  }
  // GA4 / UA e-commerce data layer: first item price
  const ei = html.search(/['"]ecommerce['"]\s*:/);
  if (ei >= 0) {
    const win = html.slice(ei, ei + 4000);
    const p = win.match(/['"]price['"]\s*:\s*['"]?(\d[\d.,]*)['"]?/);
    if (p && parsePrice(p[1])) {
      out.price = parsePrice(p[1]);
      const c = html.slice(Math.max(0, ei - 800), ei + 4000).match(/['"](?:currency|currencyCode)['"]\s*:\s*['"](ZAR|GBP|EUR|USD)['"]/);
      if (c && !out.currency) out.currency = c[1];
      return "analytics-data";
    }
  }
  return null;
}

// Find the JSON object {...} that encloses position idx (string-aware on the way forward).
function enclosingObject(html, idx) {
  let depth = 0, st = -1;
  for (let i = idx; i >= 0 && i > idx - 4000; i--) {
    const c = html[i];
    if (c === "}") depth++;
    else if (c === "{") { if (depth === 0) { st = i; break; } depth--; }
  }
  if (st < 0) return null;
  depth = 0; let inStr = false;
  for (let i = st; i < html.length && i < st + 20000; i++) {
    const c = html[i];
    if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return html.slice(st, i + 1); }
  }
  return null;
}

function detectBlock(status, html) {
  if (status === 403 || status === 429 || status === 503 || status === 401) return `The store refused our request (HTTP ${status}).`;
  const head = html.slice(0, 20000);
  if (/captcha|Robot Check|px-captcha|cf-chl|challenge-platform|Access Denied|Request unsuccessful|Incapsula|_Incapsula_|blocked - redirecting|Pardon Our Interruption|are you a robot|verify you are human|enable JavaScript and cookies/i.test(head) && html.length < 400000 && !/application\/ld\+json[\s\S]{0,4000}"price"/i.test(html))
    return "The store showed a bot check instead of the product page.";
  return null;
}

// Archived copies only: a copy that is a bot or check page (Cloudflare, Akamai, PerimeterX, DataDome,
// SiteGround "One moment, please"), or an empty JavaScript shell with no price, is a "blocked copy".
// It is left out of the history and is not counted as "no price". Live checks keep detectBlock.
const ARCHIVE_CHECK_PAGE = /<title>\s*(?:One moment, please|Just a moment|Attention Required!? \| Cloudflare|Access Denied|Please wait|Checking your browser|Security check|Verifying you are human|Robot or human\?|Pardon Our Interruption)[^<]*<\/title>|sgcaptcha|\/\.well-known\/sgcaptcha|cf_chl_opt|cf-browser-verification|_cf_chl|challenges\.cloudflare\.com\/turnstile|_pxCaptcha|px-captcha|captcha-delivery\.com|geo\.captcha-delivery|ak_bmsc[\s\S]{0,200}Reference #|errors\.edgesuite\.net|Incapsula incident|_Incapsula_Resource/i;
const ARCHIVE_SHELL_TEXT = 1500;    // visible characters; below this with no price, the copy is an empty shell
function visibleTextLength(html) {
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>|<template[\s\S]*?<\/template>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim().length;
}
// Returns { reason, message } for a blocked copy, or null. ex = extractFromHtml(html, host), if already read.
function archivedCopyBlocked(html, ex) {
  if (detectBlock(200, html)) return { reason: "bot-page", message: "The archived copy is a bot-check page." };
  const head = html.slice(0, 30000);
  if (html.length < 400000 && ARCHIVE_CHECK_PAGE.test(head) && !(ex && ex.price)) return { reason: "bot-page", message: "The archived copy is a bot-check page." };
  if (!(ex && ex.price) && visibleTextLength(html.slice(0, 2000000)) < ARCHIVE_SHELL_TEXT) return { reason: "empty-shell", message: "The archived copy is an empty page (the shop adds the price later with JavaScript)." };
  return null;
}

// Archived copies are fetched from outside the shop's country. Shopify Markets shops then show the
// export price: Lakeland drops UK VAT for US visitors, so its Common Crawl and Internet Archive copies
// say GBP but are 1/1.2 of the UK price; other shops switch currency. A copy of a UK shop counts only
// when the page itself confirms the UK price: currency GBP in its structured data, no "VAT not
// included" flag, and on Shopify pages the buyer country "GB" with active currency GBP. Anything else
// is "unusable": left out, never counted as a price. Returns { reason, message } or null.
// expected: the shop's home currency (ukArchiveShop() decides it from the URL when not given).
function ukArchiveShop(url) {
  let u; try { u = new URL(url); } catch { return false; }
  const host = stripWww(u.hostname.toLowerCase());
  if (tldCurrency(host) === "GBP") return true;
  const s = shopFor(u.href) || blockedShopFor(u.href);
  if (s) return s.cc === "UK";
  return typeof CMP_SHOPS !== "undefined" && CMP_SHOPS.some((c) => c.cur === "GBP" && c.hosts.includes(host));
}
const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ""; } };
const GEO_MSG = "The archived copy shows the price for visitors outside the UK (without UK VAT or in another currency).";
function archivedGeoCheck(html, url, ex, expected) {
  const ccy = expected || (ukArchiveShop(url) ? "GBP" : null);
  if (ccy !== "GBP") return null;
  const bad = (reason) => ({ reason, message: GEO_MSG });
  if (/["']?valueAddedTaxIncluded["']?\s*:\s*["']?false\b/i.test(html) || /itemprop=["']valueAddedTaxIncluded["'][^>]{0,40}content=["']false/i.test(html)) return bad("ex-vat");
  const country = html.match(/\bShopify\.country\s*=\s*["']([A-Za-z]{2})["']/);
  const shopify = country || /\bShopify\.shop\s*=\s*["']|\bShopify\.currency\s*=/.test(html);
  if (shopify) {
    if (!country) return bad("geo-unconfirmed");
    if (country[1].toUpperCase() !== "GB") return bad("geo-price");
    const cur = html.match(/\bShopify\.currency\s*=\s*\{[^}]*?["']?active["']?\s*:\s*["']([A-Za-z]{3})["']/);
    if (!cur) return bad("geo-unconfirmed");
    if (cur[1].toUpperCase() !== "GBP") return bad("geo-currency");
  }
  let cur = ex && ex.currency;
  if (/(^|\.)amazon\.co\.uk$/i.test(hostOf(url))) {
    // Amazon UK prices for the delivery address in the page header: "Delivering to London E17 7" is
    // the UK price; another country (or no address) is not confirmed. VAT note "excl. VAT": unusable.
    const to = html.match(/Deliver(?:ing)? to\s*(?:<[^>]*>\s*)*([^<]{2,60})/i);
    const place = to ? decodeEntities(to[1]).replace(/\s+/g, " ").trim() : "";
    if (!place) return bad("geo-unconfirmed");
    if (!/\bUnited Kingdom\b|\b[A-Z]{1,2}\d[A-Z\d]?(?: \d[A-Z]{0,2})?$/.test(place)) return bad("geo-price");
    if (/id=["']vatMessage[^>]*>\s*(?:<[^>]*>\s*)*[^<]*\b(?:excl\.?|excluding|exclusive of)\s+VAT/i.test(html)) return bad("ex-vat");
    const pref = html.match(/currencyOfPreference\s*=\s*["']([A-Z]{3})["']/);
    if (!cur && pref) cur = pref[1];
  }
  // The currency must come from the page itself, not from the shop's domain.
  if (cur !== "GBP") return bad(cur ? "currency" : "currency-unconfirmed");
  return null;
}

function extractFromHtml(html, host) {
  const out = {};
  let source = null;
  if (/(^|\.)amazon\./.test(host)) source = parseAmazon(html, out);
  if (!source) source = parseJsonLd(html, out);
  const metaSrc = parseMeta(html, out);
  if (!out.gtin) {
    const m = html.match(/itemprop=["']gtin(?:8|12|13|14)?["'][^>]{0,80}?content=["'](\d{8,14})["']/i) || html.match(/content=["'](\d{8,14})["'][^>]{0,80}?itemprop=["']gtin(?:8|12|13|14)?["']/i);
    if (m) out.gtin = m[1];
  }
  if (!source) source = metaSrc;
  if (!source) source = parseFallback(html, out);
  if (!source) source = parseDataLayer(html, out);
  if (!source) {
    const tmp = {};
    const blk = parseMainPriceBlock(html, tmp);
    if (blk) { source = blk; out.price = tmp.price; if (tmp.was) out.was = tmp.was; if (!out.currency) out.currency = tmp.currency; }
  } else if (source === "datalayer" && !out.was) {
    // the visible block often shows the crossed-out price; use it only when it matches the same price
    const tmp = {};
    if (parseMainPriceBlock(html, tmp) && tmp.price === out.price && tmp.was) out.was = tmp.was;
  }
  if (!out.title) { const t = html.match(/<title[^>]*>([^<]{1,300})<\/title>/i); if (t) out.title = decodeEntities(t[1].trim()); }
  if (out.title) out.title = decodeEntities(out.title).replace(/\s+/g, " ").trim().slice(0, 200);
  if (out.image && typeof out.image !== "string") out.image = null;
  if (out.image && !/^https?:\/\//.test(out.image)) out.image = null;
  if (out.currency) { out.currency = String(out.currency).toUpperCase().trim(); if (out.currency === "R" ) out.currency = "ZAR"; if (!/^[A-Z]{3}$/.test(out.currency)) out.currency = null; }
  if (out.was && out.price && out.was <= out.price) out.was = null;
  return { ...out, source };
}

const AMZ_COOKIE = { "amazon.co.uk": "i18n-prefs=GBP; lc-acbuk=en_GB", "amazon.de": "i18n-prefs=EUR; lc-acbde=en_GB", "amazon.fr": "i18n-prefs=EUR; lc-acbfr=en_GB", "amazon.nl": "i18n-prefs=EUR; lc-acbnl=en_GB", "amazon.es": "i18n-prefs=EUR; lc-acbes=en_GB", "amazon.it": "i18n-prefs=EUR; lc-acbit=en_GB", "amazon.co.za": "i18n-prefs=ZAR; lc-acbza=en_ZA", "amazon.ie": "i18n-prefs=EUR" };
class PageReadError extends Error {}

// Reads at most MAX_HTML bytes. HTML pages are cut at the limit and still parsed (product data usually
// sits near the top); JSON bodies (truncate = false) fail instead, since a cut body can't be parsed.
async function readLimitedText(response, truncate = false) {
  const tooLarge = "The page is too large to read.";
  if (!truncate && Number(response.headers.get("content-length")) > MAX_HTML) {
    await response.body?.cancel();
    throw new PageReadError(tooLarge);
  }
  if (!response.body) return "";
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let bytes = 0, text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      if (bytes + value.byteLength > MAX_HTML) {
        await reader.cancel();
        if (!truncate) throw new PageReadError(tooLarge);
        return text + decoder.decode(value.subarray(0, MAX_HTML - bytes));
      }
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}

async function fetchStore(url, headers, timeout, verifiedHost, init = {}) {
  const signal = AbortSignal.timeout(timeout);
  for (let hop = 0; hop <= 5; hop++) {
    const target = validateUrl(url);
    if (target.error) throw new PageReadError(target.error);
    const host = target.url.hostname;
    if (!(hop === 0 && host === verifiedHost) && !(await resolvesPublic(host))) {
      throw new PageReadError("Couldn't verify a public address for the store.");
    }
    const cookie = AMZ_COOKIE[stripWww(host)];
    // init: { method, body } for a POST API (Mr Price GraphQL); a redirect never repeats a POST.
    const r = await fetch(target.url.href, { ...(hop === 0 ? init : {}), headers: { ...headers, ...(cookie ? { cookie } : {}) }, redirect: "manual", signal, cf: { cacheTtl: 0 } });
    if (![301, 302, 303, 307, 308].includes(r.status)) return r;
    const next = r.headers.get("location");
    await r.body?.cancel();
    if (!next) throw new PageReadError("The store returned an incomplete redirect.");
    url = new URL(next, target.url).href;
  }
  throw new PageReadError("The store redirected too many times.");
}

// agent: null for a check that a person asked for (browser headers), or BOT_HEADERS for the
// scheduled daily check, which says who we are (see src/daily.js).
async function fetchPage(url, currency, verifiedHost, agent) {
  if (agent) {
    const r = await fetchStore(url, { ...agent, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8", "accept-language": LANG[currency] || "en-GB,en;q=0.9" }, 15000, verifiedHost);
    return { status: r.status, html: await readLimitedText(r, true) };
  }
  const headers = { "user-agent": UA, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "accept-language": LANG[currency] || "en-GB,en;q=0.9", "cache-control": "no-cache", "upgrade-insecure-requests": "1", "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none" };
  const r = await fetchStore(url, headers, 15000, verifiedHost);
  return { status: r.status, html: await readLimitedText(r, true) };
}

function takealotBarcode(d) {
  let found = null;
  const walk = (n, depth) => {
    if (found || !n || typeof n !== "object" || depth > 8) return;
    if (Array.isArray(n)) { for (const x of n) walk(x, depth + 1); return; }
    if (n.item_type === "barcode" && /^\d{8,14}$/.test(String(n.displayable_text || "").trim())) { found = String(n.displayable_text).trim(); return; }
    for (const k in n) walk(n[k], depth + 1);
  };
  walk(d.product_information, 0);
  return found || undefined;
}
function takealotAttr(d, type) {
  const items = (d.product_information && d.product_information.items) || [];
  const it = items.find((x) => x && x.item_type === type);
  const t = it && String(it.displayable_text || "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
  return t || null;
}
const takealotApiUrl = (plid) => `https://api.takealot.com/rest/v-1-14-0/product-details/PLID${plid}?platform=desktop&display_credit=false`;
async function takealotApi(plid, agent, verifiedHost) {
  const r = await fetchStore(takealotApiUrl(plid), { ...(agent || { "user-agent": UA }), accept: "application/json" }, 12000, verifiedHost);
  if (!r.ok) { await r.body?.cancel(); return { error: `Takealot API answered HTTP ${r.status}.` }; }
  const d = JSON.parse(await readLimitedText(r));
  const items = (d.buybox && d.buybox.items) || [];
  const it = items.find((x) => x.is_selected) || items[0];
  if (!it) return { error: "Takealot shows no offer for this product now. This usually means it is out of stock." };
  const price = parsePrice(it.price), was = parsePrice(it.listing_price);
  const img = d.gallery && d.gallery.images && d.gallery.images[0];
  const gtin = takealotBarcode(d), model = takealotAttr(d, "model_number");
  // "Model" is often just the barcode again; keep it only when it is a real model number.
  const mpn = model && /[a-z]/i.test(model) && model.length <= 40 ? model.replace(/\\/g, "") : undefined;
  return { price, was: was && price && was > price ? was : null, currency: "ZAR", title: (d.core && d.core.title) || d.title, image: img ? img.replace("{size}", "pdpxl") : null, source: "takealot-api", gtin, mpn, brand: (d.core && d.core.brand) || undefined };
}

// Shopify shops can price for the visitor's country: our servers abroad saw Lakeland without UK VAT and
// Escentual in USD. For the Shopify shops we know (CMP_SHOPS in src/compare.js), ask for the home country and currency.
function shopifyHomeUrl(url, host) {
  const sh = cmpShopForHost(host);
  if (!sh || sh.kind !== "shopify" || !CMP_COUNTRY[sh.cur]) return url;
  const u = new URL(url); u.searchParams.set("country", CMP_COUNTRY[sh.cur]); u.searchParams.set("currency", sh.cur);
  return u.href;
}

async function getCurrent(canonInfo, origUrl, verifiedHost, agent) {
  const host = new URL(canonInfo.canon).hostname.toLowerCase();
  const tldCur = tldCurrency(host);
  const res = { checked_at: now(), status: "ok" };
  try {
    if (canonInfo.kind === "takealot") {
      const t = await takealotApi(canonInfo.plid, agent, verifiedHost);
      if (t.error) return { ...res, status: "noprice", message: t.error };
      return { ...res, ...t };
    }
    // Shop readers (src/readers.js): an API reader replaces the page fetch; a page reader runs on the page.
    const rd = canonInfo.kind === "amazon" ? null : readerFor(origUrl);
    if (rd && rd.api) {
      const t = await readApi(rd, agent, verifiedHost);
      if (t.error) return { ...res, status: "noprice", message: t.error };
      return { ...res, ...t };
    }
    const target = canonInfo.kind === "amazon" ? canonInfo.canon : shopifyHomeUrl(origUrl, host);
    const pg = await fetchPage(target, tldCur, verifiedHost, agent);
    const blocked = detectBlock(pg.status, pg.html);
    if (blocked) return { ...res, status: "blocked", http: pg.status, message: blocked };
    if (pg.status === 404 || pg.status === 410) return { ...res, status: "error", http: pg.status, message: `The store says this page doesn't exist (HTTP ${pg.status}).` };
    if (pg.status >= 400) return { ...res, status: "error", http: pg.status, message: `The store answered HTTP ${pg.status}.` };
    const ex = extractFromHtml(pg.html, host);
    const pr = rd ? readPage(rd, pg.html) : null;
    if (pr && pr.price) { ex.price = pr.price; ex.was = pr.was || null; ex.currency = pr.currency || ex.currency; ex.source = pr.source; if (pr.title && !ex.title) ex.title = pr.title; }
    let currency = ex.currency, currencyGuessed = false;
    if (!currency && ex.price) { currency = tldCur; currencyGuessed = !!currency && canonInfo.kind !== "amazon"; }
    if (ex.price && canonInfo.kind === "amazon" && tldCur && currency !== tldCur) return { ...res, status: "noprice", http: pg.status, title: ex.title, image: ex.image, message: `Amazon showed us a price in ${currency} instead of ${tldCur} (it does this for visitors outside the country), so we can't read the local price.` };
    if (!ex.price && canonInfo.kind === "amazon") return { ...res, status: "noprice", http: pg.status, title: ex.title, image: ex.image, message: "Amazon didn't show a buy price to us. It often hides the price for visitors outside the country (our checker runs on servers abroad), or the item is unavailable." };
    if (!ex.price) return { ...res, status: "noprice", http: pg.status, title: ex.title, image: ex.image, message: "We loaded the page, but it has no price we can read. Some shops add the price later with JavaScript. Type the price you see." };
    return { ...res, price: ex.price, was: ex.was || null, currency, currency_guessed: currencyGuessed, title: ex.title, image: ex.image, source: ex.source, http: pg.status, gtin: ex.gtin, mpn: ex.mpn, brand: ex.brand };
  } catch (e) {
    if (e instanceof PageReadError) return { ...res, status: "error", message: e.message };
    return { ...res, status: "error", message: /timed? ?out|abort/i.test(String(e)) ? "The store took too long to answer." : "The shop did not answer." };
  }
}

// ---------- Wayback ----------
// Black Friday is the day after the fourth Thursday of November. Use this year's once its week is over.
function lastBlackFriday() {
  const bfOf = (y) => { const wd = new Date(Date.UTC(y, 10, 1)).getUTCDay(); return Date.UTC(y, 10, 1 + ((4 - wd + 7) % 7) + 22); };
  const y = new Date(now()).getUTCFullYear();
  return now() >= bfOf(y) + 4 * 864e5 ? bfOf(y) : bfOf(y - 1);
}
// http/https and a trailing slash on the path don't make a different product page.
// The mobile host (m.) and www. show the same product page.
const sameKey = (s) => s.replace(/^http:/, "https:").replace(/^https:\/\/(?:www\.|m\.)/, "https://").replace(/\/+(?=\?|$)/, "");
function sameProduct(raw, canon) {
  const v = validateUrl(raw);
  if (v.error) return false;
  return sameKey(canonicalize(v.url).canon) === sameKey(canon);
}

function cdxQueries(canonInfo, origUrl) {
  const q = [];
  if (canonInfo.kind === "amazon") {
    const host = stripWww(new URL(canonInfo.canon).hostname);
    q.push({ url: `${host}/dp/${canonInfo.asin}`, prefix: false });
    try {
      const op = new URL(origUrl).pathname;
      const m = op.match(new RegExp(`^(/[^/]+/dp/${canonInfo.asin})`, "i"));
      if (m) q.push({ url: host + m[1], prefix: false });
    } catch {}
  } else {
    q.push({ url: canonInfo.canon, prefix: false });
    const original = new URL(origUrl);
    original.search = new URL(canonInfo.canon).search;
    if (original.href !== canonInfo.canon && sameProduct(original.href, canonInfo.canon)) q.push({ url: original.href, prefix: false });
    // The archive often holds the same page with or without a trailing slash.
    const u = new URL(canonInfo.canon);
    if (!u.search && u.pathname.length > 1) {
      u.pathname = u.pathname.endsWith("/") ? u.pathname.replace(/\/+$/, "") : u.pathname + "/";
      q.push({ url: u.href, prefix: false });
    }
    // The pasted link with all its parameters, the page without parameters, and the mobile host.
    // (The archive index already ignores http/https and www.) Results are kept only for the same product.
    try { const full = new URL(origUrl); full.hash = ""; q.push({ url: full.href, prefix: false }); } catch {}
    const bare = new URL(canonInfo.canon); bare.search = "";
    if (bare.href !== canonInfo.canon) q.push({ url: bare.href, prefix: false });
    const mob = new URL(canonInfo.canon); mob.hostname = "m." + stripWww(mob.hostname);
    if (!/^m\./.test(new URL(canonInfo.canon).hostname)) q.push({ url: mob.href, prefix: false });
  }
  const seenQ = new Set();
  return q.filter((x) => (seenQ.has(x.url) ? false : seenQ.add(x.url)));
}

async function getSnapshots(env, canonInfo, origUrl) {
  const oKey = new URL(origUrl).pathname;
  const key = "cdx-v6:" + JSON.stringify([canonInfo.canon, oKey]);
  const cached = await cacheGet(env, key);
  if (cached) return cached;
  const from = ymd(new Date(now() - HISTORY_DAYS * 864e5));
  let rows = [], status = "ok", message = null;
  const queries = cdxQueries(canonInfo, origUrl);
  const results = await Promise.all(queries.map(async (q) => {
    try {
      const api = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(q.url)}${q.prefix ? "&matchType=prefix" : ""}&from=${from}&output=json&fl=timestamp,original,statuscode,mimetype&filter=!statuscode:[345]..&collapse=timestamp:8&limit=1500`;
      let r;
      for (let attempt = 0; attempt < 3; attempt++) {
        r = await fetch(api, { headers: { "user-agent": "bf-price-check/1.0 (price history tool)" }, redirect: "manual", signal: AbortSignal.timeout(25000) });
        if (attempt === 2 || ![503, 429, 502].includes(r.status)) break;
        await r.body?.cancel();
        await new Promise((ok) => setTimeout(ok, 1500 * (attempt + 1)));
      }
      if (!r.ok) { await r.body?.cancel(); return { err: `The Internet Archive answered HTTP ${r.status}.` }; }
      const txt = await readLimitedText(r);
      if (!txt.trim().startsWith("[")) return { err: "The Internet Archive is busy or offline right now." };
      return { rows: JSON.parse(txt).slice(1) };
    } catch (e) { return { err: "The Internet Archive took too long to answer.", detail: String(e && e.message || e).slice(0, 120) }; }
  }));
  let okCount = 0;
  for (const r of results) { if (r.rows) { okCount++; rows = rows.concat(r.rows); } else { status = "error"; message = r.err; } }
  if (okCount) { status = "ok"; message = null; }
  const seen = new Set();
  rows = rows.filter(([ts, orig]) => {
    if (!/^\d{14}$/.test(ts) || tsToMs(ts) > now() || !sameProduct(orig, canonInfo.canon)) return false;
    const day = ts.slice(0, 8);
    if (day < from || seen.has(day)) return false;
    seen.add(day);
    return true;
  });
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  const picked = pickSnaps(rows);
  // Always keep the capture closest to last Black Friday, if there is one within 3 days.
  const bf = lastBlackFriday();
  let bfRow = null;
  for (const r of rows) { const d = Math.abs(tsToMs(r[0]) - bf); if (d <= 3 * 864e5 && (!bfRow || d < Math.abs(tsToMs(bfRow[0]) - bf))) bfRow = r; }
  if (bfRow && !picked.some((x) => x.ts === bfRow[0])) { picked.push({ ts: bfRow[0], orig: bfRow[1] }); picked.sort((a, b) => a.ts.localeCompare(b.ts)); }
  const val = { status, message, total: rows.length, snaps: picked, queries: queries.map((q, i) => ({ url: q.url, prefix: q.prefix, rows: results[i].rows ? results[i].rows.length : null, error: results[i].err || null, detail: results[i].detail || null })) };
  if (status === "ok") await cachePut(env, key, val, okCount === results.length ? CDX_TTL_MS : 3600e3);
  return val;
}

// Thin out the copies (one per day already, newest first). Products with few copies keep every day,
// so 3 copies a day or two apart still give 3 older prices. Busy products use the smallest spacing
// (1, 2, 3, 4 or 6 days) that fits MAX_SNAPS, so the whole year stays covered.
function pickSnaps(rows) {
  let picked = [];
  for (const days of SNAP_SPACINGS) {
    picked = [];
    let last = Infinity;
    for (let i = rows.length - 1; i >= 0; i--) {
      const t = tsToMs(rows[i][0]);
      if (last - t >= days * 864e5 - 36e5) { picked.push({ ts: rows[i][0], orig: rows[i][1] }); last = t; }
    }
    if (picked.length <= MAX_SNAPS) break;
  }
  return picked.slice(0, MAX_SNAPS).reverse();
}

async function fetchSnapshot(ts, orig, canon) {
  const host = new URL(orig).hostname.toLowerCase();
  try {
    // Wayback often redirects a replay to the exact capture time or the other scheme. Follow it only when it
    // stays on the archive, points to the same product and to a capture close to the requested one.
    let url = `https://web.archive.org/web/${ts}id_/${orig}`, r;
    for (let hop = 0; ; hop++) {
      r = await fetch(url, { headers: { "user-agent": "bf-price-check/1.0 (price history tool)" }, redirect: "manual", signal: AbortSignal.timeout(25000) });
      if (![301, 302, 303, 307, 308].includes(r.status)) break;
      const loc = r.headers.get("location");
      await r.body?.cancel();
      if (!loc || hop >= 3) return { status: "retry", message: "Archive redirect incomplete" };
      const next = new URL(loc, url);
      const m = (next.pathname + next.search).match(/^\/web\/(\d{14})id_\/(.+)$/);
      if (next.hostname !== "web.archive.org" || !m || !sameProduct(m[2], canon) || Math.abs(tsToMs(m[1]) - tsToMs(ts)) > SNAP_REDIRECT_MS)
        return { status: "error", message: "The archive redirected to a different page or date." };
      url = next.href;
    }
    if (!r.ok) {
      await r.body?.cancel();
      return { status: r.status === 429 || r.status >= 500 ? "retry" : "error", message: `Archive HTTP ${r.status}` };
    }
    const html = await readLimitedText(r, true);
    const ex = extractFromHtml(html, host);
    const blk = archivedCopyBlocked(html, ex);
    if (blk) return { status: "blocked", reason: blk.reason, message: blk.message };
    if (!ex.price) return { status: "noprice" };
    const geo = archivedGeoCheck(html, orig, ex);
    if (geo) return { status: "unusable", reason: geo.reason, message: geo.message };
    return { status: "ok", price: ex.price, was: ex.was || null, currency: ex.currency || tldCurrency(host) };
  } catch (e) {
    if (e instanceof PageReadError) return { status: "error", message: e.message };
    return { status: "retry", message: "Archive timeout" };
  }
}

// ---------- D1 helpers ----------
async function cacheGet(env, k) {
  const r = await env.DB.prepare("SELECT v, exp FROM cache WHERE k = ?").bind(k).first().catch(() => null);
  if (!r || r.exp < now()) return null;
  try { return JSON.parse(r.v); } catch { return null; }
}
// Cache writes are never essential: on a D1 error the value is simply not cached. The same value is
// not written again while more than half its time to live is left (no rows written for it).
async function cachePut(env, k, v, ttl) {
  const exp = now() + ttl;
  await softWrite("cache", () => env.DB.prepare("INSERT INTO cache (k, v, exp) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = excluded.exp WHERE cache.v IS NOT excluded.v OR cache.exp < ?")
    .bind(k, JSON.stringify(v), exp, exp - ttl / 2).run());
}
// Rate limits. On Cloudflare they use the Workers Rate Limiting API (bindings RL_* in wrangler.toml,
// same limits per minute): no D1 writes, so a busy day does not use up the D1 free plan's 100,000
// rows written per day. Without the binding (unit tests, old config) they fall back to the D1 table
// `rl`. If the limiter itself fails, the request is allowed (fail open): a limiter outage must not
// take the site down.
const RL_BINDING = { check: "RL_CHECK", snap: "RL_SNAP", req: "RL_REQ", verdict: "RL_VERDICT", others: "RL_OTHERS", cmp: "RL_CMP_IP", cmpshop: "RL_CMP_SHOP" };
async function overLimit(env, bucket, key, limit) {
  const b = env[RL_BINDING[bucket]];
  try {
    if (b && typeof b.limit === "function") return !(await b.limit({ key: bucket + ":" + key })).success;
    const win = Math.floor(now() / 60000);
    const r = await env.DB.prepare("INSERT INTO rl (k, n, win) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = CASE WHEN rl.win = excluded.win THEN rl.n + 1 ELSE 1 END, win = excluded.win RETURNING n").bind(bucket + ":" + key, win).first();
    return !!r && r.n > limit;
  } catch { return false; }
}
const rateLimit = (env, ip, bucket) => overLimit(env, bucket, ip, RL[bucket]);
// Runs a D1 write that is not essential for the answer. On an error (D1 write limit, D1 busy) it
// returns `fallback` instead of failing the request.
let softWriteLogged = 0;
async function softWrite(what, fn, fallback = undefined) {
  try { return await fn(); }
  catch (e) {
    if (now() - softWriteLogged > 60e3) { softWriteLogged = now(); console.log(JSON.stringify({ d1_write_failed: what, error: String(e && e.message || e).slice(0, 160) })); }
    return fallback;
  }
}
// via: null for a check a person asked for, "daily" for the scheduled check.
const checkStmt = (env, canon, cur, via = null) => env.DB.prepare("INSERT INTO checks (url, ts, price, was, currency, source, title, via) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(canon, cur.checked_at, cur.price, cur.was || null, cur.currency || null, cur.source || null, cur.title || null, via);
async function recordCheck(env, canon, cur) {
  if (cur.price) await checkStmt(env, canon, cur).run();
}
// A product someone checked: it joins the daily price saving (seed = 0, before the seed list).
// Its next daily check is about a day after its last live check. A check by a person also
// restarts a product that was paused after many failed checks.
// A cached answer seen again within 12 hours changes nothing that matters (last_viewed is only used in
// days), so track() writes nothing then.
const TRACK_VIEW_MS = 12 * 3600e3;
async function track(env, canon, origUrl, cur) {
  await ensureDailySchema(env);
  const viewed = now();
  const ok = cur.status === "ok";
  const row = await env.DB.prepare(`
    INSERT INTO tracked (url, orig_url, title, added_at, last_viewed, last_checked, last_status, check_count, seed, lane, host, fails, next_check_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM tracked WHERE url = ?) OR (SELECT COUNT(*) FROM tracked WHERE seed = 0) < ?
    ON CONFLICT(url) DO UPDATE SET orig_url = excluded.orig_url, last_viewed = excluded.last_viewed,
      last_checked = MAX(COALESCE(tracked.last_checked, 0), excluded.last_checked),
      last_status = CASE WHEN excluded.last_checked >= COALESCE(tracked.last_checked, 0) THEN excluded.last_status ELSE tracked.last_status END,
      title = COALESCE(excluded.title, tracked.title), check_count = tracked.check_count + 1,
      seed = 0, lane = excluded.lane, host = excluded.host,
      fails = CASE WHEN excluded.fails = 0 OR tracked.next_check_at IS NULL THEN 0 ELSE tracked.fails END,
      next_check_at = CASE WHEN tracked.next_check_at IS NULL OR excluded.last_checked > COALESCE(tracked.last_checked, 0) THEN excluded.next_check_at ELSE tracked.next_check_at END
    WHERE excluded.last_checked > COALESCE(tracked.last_checked, 0) OR tracked.last_viewed IS NULL OR tracked.last_viewed < excluded.last_viewed - ?
      OR tracked.seed IS NOT 0 OR tracked.lane IS NULL OR tracked.next_check_at IS NULL OR tracked.orig_url IS NOT excluded.orig_url
    RETURNING url`).bind(canon, origUrl, cur.title || null, viewed, viewed, cur.checked_at, cur.status, laneFor(canon), hostKey(canon), ok ? 0 : 1, cur.checked_at + DAILY_MS, canon, MAX_TRACKED, TRACK_VIEW_MS).first();
  // No row back: either the list is full, or nothing new to write (D1 rows written are counted per row).
  return !!row || !!(await env.DB.prepare("SELECT 1 AS x FROM tracked WHERE url = ?").bind(canon).first());
}
async function storedHistory(env, canon) {
  const since = now() - HISTORY_DAYS * 864e5;
  // Old page-data rows did not retain the unit, so their amounts cannot be rescaled reliably.
  // Saved checks, Wayback copies and Common Crawl rows (src/archive.js), read from D1 at the same time.
  const [checks, snaps, cc] = await Promise.all([
    env.DB.prepare("SELECT ts, price, was, currency FROM checks WHERE url = ? AND ts >= ? AND source IS NOT 'page-data' ORDER BY ts").bind(canon, since).all(),
    env.DB.prepare("SELECT snap_ts, orig, price, was, currency, status FROM product_snaps WHERE url = ? AND snap_ts >= ? AND status NOT IN ('pending', 'retry')").bind(canon, ymd(new Date(since))).all(),
    archiveRows(env, archiveLookupKeys(canon), since),
  ]);
  return { checks: checks.results || [], snaps: snaps.results || [], cc };
}

// ---------- supported shops ----------
// Shops we read live (from research/retailers.json, see src/shops.js), and shops known to block us.
const SHOPS = SHOP_LIST.works;
function matchShop(list, url) {
  let u; try { u = new URL(url); } catch { return null; }
  const h = stripWww(u.hostname.toLowerCase()), path = u.pathname.toLowerCase();
  return list.find((x) => x.d.some((d) => {
    const i = d.indexOf("/"), dh = i < 0 ? d : d.slice(0, i), dp = i < 0 ? "" : d.slice(i);
    return (h === dh || h.endsWith("." + dh)) && (!dp || path === dp || path.startsWith(dp + "/"));
  })) || null;
}
const shopFor = (url) => matchShop(SHOP_LIST.works, /^https?:/.test(url) ? url : "https://" + url + "/");
const blockedShopFor = (url) => matchShop(SHOP_LIST.blocked, url);

// ---------- shop requests ----------
let requestsTableReady = false;
async function ensureRequestsTable(env) {
  if (requestsTableReady) return;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS shop_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, host TEXT, shop_text TEXT NOT NULL, product_url TEXT, email TEXT, created_at INTEGER NOT NULL, ip_hash TEXT)").run();
  requestsTableReady = true;
}
async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function apiRequest(req, env, ctx) {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!/application\/json/i.test(req.headers.get("content-type") || "")) return json({ error: "Send the form as JSON." }, 415);
  const ip = req.headers.get("cf-connecting-ip") || "0";
  let body;
  try { const t = await req.text(); if (t.length > 6000) return json({ error: "The request is too long." }, 413); body = JSON.parse(t); } catch { return json({ error: "We could not read the form." }, 400); }
  if (!body || typeof body !== "object") return json({ error: "We could not read the form." }, 400);
  // honeypot: real people never fill this hidden field
  if (body.website) return json({ ok: true });
  const clean = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  const shop = clean(body.shop, 200), product = clean(body.product_url, 2048), email = clean(body.email, 254);
  if (shop.length < 2) return json({ error: "Type the shop name or website." }, 400);
  if (product && !/^https?:\/\/[^\s]+\.[^\s]+/i.test(product)) return json({ error: "The product link must start with http:// or https://." }, 400);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json({ error: "Check the email address." }, 400);
  const test = isE2E(req, env);
  if (test && !shop.startsWith("e2e-test")) return json({ error: "Test requests must start with e2e-test." }, 400);
  if (!test && await rateLimit(env, ip, "req")) return json({ error: "You sent many requests. Try again in a minute." }, 429);
  if (!test && !(await verifyTurnstile(env, body.ts, ip))) return json({ error: "We could not check that you are a person. Try again." }, 403);
  let host = null;
  try { host = stripWww(new URL(/^https?:/i.test(shop) ? shop : product || ("https://" + shop)).hostname.toLowerCase()); } catch {}
  if (host && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) host = null;
  await ensureRequestsTable(env);
  await env.DB.prepare("INSERT INTO shop_requests (host, shop_text, product_url, email, created_at, ip_hash) VALUES (?, ?, ?, ?, ?, ?)").bind(host, shop, product || null, email || null, now(), (await sha256("bf-req:" + ip)).slice(0, 32)).run();
  if (!test && ctx) ctx.waitUntil(notifyOwnerOfRequest(env, { shop, host, product, email }).catch(() => {}));
  return json({ ok: true });
}

// ---------- API handlers ----------
async function apiCheck(req, env, ctx) {
  const ip = req.headers.get("cf-connecting-ip") || "0";
  const params = new URL(req.url).searchParams;
  const v = validateUrl(params.get("url"));
  if (v.error) return json({ error: v.error }, 400);
  if (await rateLimit(env, ip, "check")) return json({ error: "Too many checks in one minute. Wait a minute and try again." }, 429);
  const canonInfo = canonicalize(v.url);
  const host = v.url.hostname.toLowerCase();
  const pub = await resolvesPublic(host);
  if (pub === null) return json({ error: "We could not look up the shop's address. Try again in a minute." }, 503);
  if (!pub) return json({ error: "That address doesn't point to a public website." }, 400);
  const fresh = params.get("fresh") === "1";
  const ckey = LIVE_CACHE_PREFIX + canonInfo.canon;
  let current = fresh ? null : await cacheGet(env, ckey);
  let cached = !!current;
  if (!current) {
    current = await getCurrent(canonInfo, v.url.toString(), host);
    // Saving is extra: if D1 refuses a write (for example the daily write limit), the person still
    // gets today's price. softWrite logs the failure once per minute.
    await softWrite("check-cache", () => cachePut(env, ckey, current, current.status === "ok" ? CHECK_TTL_MS : 10 * 60 * 1000));
    await softWrite("check-save", () => recordCheck(env, canonInfo.canon, current));
  }
  const tracked = await softWrite("track", () => track(env, canonInfo.canon, v.url.toString(), current), false);
  const hist = await storedHistory(env, canonInfo.canon).catch(() => ({ checks: [], snaps: [], cc: [] }));
  let verdict = null;
  try { const j = judge(current, hist); verdict = publicVerdict(j); if (tracked && j.verdict) ctx.waitUntil(saveVerdict(env, canonInfo.canon, current.title, j).catch(() => {})); } catch {}
  return json({
    url: v.url.toString(), canonical: canonInfo.canon, host: stripWww(host), tld_currency: tldCurrency(host),
    current, cached, tracked,
    history: {
      archive: hist.snaps.filter((s) => s.status === "ok").map((s) => ({ t: tsToMs(s.snap_ts), ts: s.snap_ts, orig: s.orig, price: s.price, was: s.was, currency: s.currency })),
      archive_failed: hist.snaps.filter((s) => s.status !== "ok" && s.status !== "retry" && s.status !== "blocked" && s.status !== "unusable").length,
      archive_blocked: hist.snaps.filter((s) => s.status === "blocked").length,
      archive_unusable: hist.snaps.filter((s) => s.status === "unusable").length,
      checks: hist.checks.map((c) => ({ t: c.ts, price: c.price, was: c.was, currency: c.currency })),
      cc: archivePoints(hist.cc || [], now() - HISTORY_DAYS * 864e5, current.status === "ok" ? current.price : null).map((p) => ({ t: p.t, price: p.price, was: p.was, currency: p.currency, url: p.url, link: p.link })),
    },
    history_days: HISTORY_DAYS, verdict,
    ids: { gtin: current.gtin || null, mpn: current.mpn || null },
    shop: (() => { const x = shopFor(v.url.href); return x ? { name: x.name } : null; })(),
    blocked_shop: (() => { const x = shopFor(v.url.href) ? null : blockedShopFor(v.url.href); return x ? { name: x.name } : null; })(),
  });
}

// Wayback snapshot list for a product that was checked before
async function apiArchive(req, env) {
  const canon = new URL(req.url).searchParams.get("url") || "";
  const tr = await env.DB.prepare("SELECT url, orig_url FROM tracked WHERE url = ?").bind(canon).first();
  if (!tr) return json({ error: "Check the product first." }, 403);
  let orig = sameProduct(tr.orig_url, canon) ? tr.orig_url : canon;
  const op = new URL(req.url).searchParams.get("orig");
  if (sameProduct(op, canon)) orig = op;
  const canonInfo = canonicalize(new URL(canon));
  const snapsInfo = await getSnapshots(env, canonInfo, orig);
  let pending = [];
  if (snapsInfo.snaps.length) {
    const slots = snapsInfo.snaps.map(() => "(?, ?, ?)").join(", ");
    const values = snapsInfo.snaps.flatMap((s) => [canon, s.ts, s.orig]);
    await env.DB.prepare("INSERT INTO product_snaps (url, snap_ts, orig) VALUES " + slots + " ON CONFLICT(url, snap_ts) DO NOTHING").bind(...values).run();
    const rows = await env.DB.prepare("SELECT snap_ts AS ts, orig FROM product_snaps WHERE url = ? AND (status = 'pending' OR (status = 'retry' AND fetched_at <= ?)) ORDER BY snap_ts").bind(canon, now() - 6 * 3600e3).all();
    const selected = new Set(snapsInfo.snaps.map((s) => s.ts));
    pending = rows.results.filter((s) => selected.has(s.ts));
  }
  return json({ status: snapsInfo.status, message: snapsInfo.message, captures_12mo: snapsInfo.total, captures_6mo: snapsInfo.total, sampled: snapsInfo.snaps.length, pending, queries: snapsInfo.queries });
}

async function apiSnap(req, env) {
  const ip = req.headers.get("cf-connecting-ip") || "0";
  const p = new URL(req.url).searchParams;
  const canon = p.get("url") || "", ts = p.get("ts") || "", orig = p.get("orig") || "";
  if (!/^\d{14}$/.test(ts)) return json({ error: "bad ts" }, 400);
  if (!sameProduct(orig, canon)) return json({ error: "This copy belongs to a different product." }, 400);
  const have = await env.DB.prepare("SELECT s.* FROM product_snaps s JOIN tracked t ON t.url = s.url WHERE s.url = ? AND s.snap_ts = ? AND s.orig = ?").bind(canon, ts, orig).first();
  if (!have) return json({ error: "Look up the archived copies for this product first." }, 403);
  if (have.status !== "pending" && (have.status !== "retry" || now() - have.fetched_at < 6 * 3600e3)) return json({ ts, t: tsToMs(ts), ...have, cached: true });
  if (await rateLimit(env, ip, "snap")) return json({ error: "rate limited", status: "retry" }, 429);
  const r = await fetchSnapshot(ts, orig, canon);
  await env.DB.prepare("UPDATE product_snaps SET price = ?, was = ?, currency = ?, status = ?, fetched_at = ? WHERE url = ? AND snap_ts = ? AND status <> 'ok'").bind(r.price || null, r.was || null, r.currency || null, r.status, now(), canon, ts).run();
  return json({ ts, orig, t: tsToMs(ts), ...r });
}

// Archive copies read before the bot-check / empty-page check existed (PR #17, 25 Nov 2026) were saved as
// "no price". We do not keep the page, so we cannot test it again from D1: mark these copies for one
// more read instead. The next time someone opens the product, /api/archive lists them again and
// /api/snap reads them with today's check (blocked, no price, or a price). Until then they count as
// nothing, not as "no price". Runs once (flag in the cache table).
const SNAP_DETECT_SINCE = Date.UTC(2026, 10, 25, 2, 45);
const SNAP_RELABEL_KEY = "snap-relabel-v1";
async function relabelOldSnaps(env) {
  if (await cacheGet(env, SNAP_RELABEL_KEY)) return 0;
  const r = await env.DB.prepare("UPDATE product_snaps SET status = 'retry', fetched_at = 0 WHERE status = 'noprice' AND COALESCE(fetched_at, 0) < ?").bind(SNAP_DETECT_SINCE).run();
  const n = (r && r.meta && r.meta.changes) || 0;
  await cachePut(env, SNAP_RELABEL_KEY, { at: now(), n }, 400 * 864e5);
  return n;
}

async function cron(env, scheduledTime) {
  await ensureFeatureTables(env);
  try { await relabelOldSnaps(env); } catch {}
  await archiveProbe(env);
  await runDaily(env, scheduledTime);
  // Housekeeping: the cron runs every minute; clean up once every 6 hours, at minute 15.
  const at = new Date(scheduledTime);
  if (at.getUTCMinutes() !== 15 || at.getUTCHours() % 6 !== 0) return;
  await env.DB.prepare("UPDATE alerts SET status = 'expired' WHERE status IN ('pending', 'active') AND created_at < ?").bind(now() - ALERT_DAYS * 864e5).run();
  await env.DB.prepare("DELETE FROM alerts WHERE status = 'pending' AND created_at < ?").bind(now() - 3 * 864e5).run();
  await env.DB.prepare("UPDATE tracked SET last_viewed = ? WHERE url IN (SELECT url FROM alerts WHERE status = 'active')").bind(now()).run();
  await env.DB.prepare("DELETE FROM rl WHERE win < ?").bind(Math.floor(now() / 60000) - 5).run();
  await env.DB.prepare("DELETE FROM cache WHERE exp < ?").bind(now()).run();
  await dailyHousekeeping(env);
}

async function pageHtml(req, env, ctx) {
  const origin = new URL(req.url).origin;
  let html = HTML.split("__ORIGIN__").join(origin).replace("<!--CANONICAL-->", `<link rel="canonical" href="${origin}/">`);
  if (new URL(req.url).pathname === "/") { try { html = await homeWithMeta(req, env, html, ctx); } catch {} }
  // A shared or bookmarked result link (?u= / ?url=): the page starts in its result layout, so nothing moves when the result appears.
  { const q = new URL(req.url).searchParams; if (new URL(req.url).pathname === "/" && (q.get("u") || q.get("url"))) html = html.replace('<html lang="en">', '<html lang="en" class="q">'); }
  return html.replace("<!--NOSCRIPT-->", '<noscript><p class="note" style="text-align:center">Turn on JavaScript to see price history. You can still paste a link and press Check price.</p></noscript>');
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      // Private stats dashboard: its own host, behind Cloudflare Access (see src/stats.js).
      if (mIsStatsHost(url, env)) return await statsApp(req, env, url, false);
      if (mIsDevStats(req, url, env)) return await statsApp(req, env, url, true);
      if (req.method === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type" } });
      if (/^\/api\/(check|archive|snap|others|compare|compare\/shop|verdict|request|alert)$/.test(url.pathname)) { const g = apiGuard(req); if (g) return g; }
      if (url.pathname === "/api/request") return statsTap(req, env, ctx, "request", await apiRequest(req, env, ctx));
      if (url.pathname === "/api/m") return await statsBeacon(req, env, ctx);
      if (url.pathname === "/api/e2e/stats-probe") return await statsProbe(req, env);
      if (url.pathname === "/api/alert") return await apiAlert(req, env, ctx);
      if (url.pathname === "/api/e2e/cleanup") return await apiE2ECleanup(req, env);
      if (url.pathname === "/api/admin/archive-load") return await apiArchiveLoad(req, env);
      if (url.pathname === "/api/admin/price-fix") return await apiPriceFix(req, env);
      if (url.pathname === "/api/e2e/mail-test") return await apiMailTest(req, env);
      if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "method not allowed" }, 405);
      if (url.pathname === "/api/shops") return await apiShops(env, ctx);
      if (url.pathname === "/api/check") return statsTap(req, env, ctx, "check", await apiCheck(req, env, ctx));
      if (url.pathname === "/api/daily-status") return await apiDailyStatus(env);
      if (url.pathname === "/api/archive-stats") return await apiArchiveStats(env);
      if (url.pathname === "/api/config") return json({ wall: env.WALL === "on", alerts: alertsOn(env), min_judged: WALL_MIN_JUDGED, turnstile: turnstileOn(env) ? env.TURNSTILE_SITEKEY : null }, 200, { "cache-control": "public, max-age=300" });
      if (url.pathname === "/api/verdict") return await apiVerdict(req, env);
      if (url.pathname === "/api/compare") return statsTap(req, env, ctx, "compare", await apiCompare(req, env));
      if (url.pathname === "/api/compare/shop") return statsTap(req, env, ctx, "compare_shop", await apiCompareShop(req, env, ctx));
      if (url.pathname === "/api/others") return await apiOthersCompat(req, env);
      if (env.WALL !== "on" && (url.pathname === "/wall" || url.pathname === "/api/wall" || url.pathname === "/api/stats")) return url.pathname === "/wall" ? Response.redirect(url.origin + "/", 302) : json({ error: "off" }, 404);
      if (url.pathname === "/api/wall") return json(await wallData(env), 200, { "cache-control": "public, max-age=300" });
      if (url.pathname === "/api/stats") { const w = await wallData(env); return json({ fake_total: w.fake_total }, 200, { "cache-control": "public, max-age=300" }); }
      const stat = url.pathname.slice(1);
      if (Object.prototype.hasOwnProperty.call(STATIC_IMG, stat)) { const b = Uint8Array.from(atob(STATIC_IMG[stat]), (x) => x.charCodeAt(0)); return new Response(req.method === "HEAD" ? null : b, { headers: { "content-type": stat.endsWith(".png") ? "image/png" : "image/jpeg", "content-length": String(b.length), "cache-control": "public, max-age=604800", "access-control-allow-origin": "*" } }); }
      if (url.pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=86400" } });
      if (url.pathname === "/og.png") return await apiOg(req, env);
      if (url.pathname === "/alert/confirm") return await alertLink(req, env, "confirm");
      if (url.pathname === "/alert/stop") return await alertLink(req, env, "stop");
      if (url.pathname === "/api/archive") return await apiArchive(req, env);
      if (url.pathname === "/api/snap") return await apiSnap(req, env);
      if (["/", "/index.html", "/wall", "/privacy"].includes(url.pathname) && req.method === "GET" && ctx) ctx.waitUntil(statsPageView(req, env).catch(() => {}));
      if (["/", "/index.html", "/wall", "/privacy"].includes(url.pathname)) return new Response(await pageHtml(req, env, ctx), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
      if (url.pathname.startsWith("/fonts/") && FONTS[url.pathname.slice(7)]) return new Response(Uint8Array.from(atob(FONTS[url.pathname.slice(7)]), (c) => c.charCodeAt(0)), { headers: { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable", "access-control-allow-origin": "*" } });
      // The page names the script by its hash. A page loaded before a deploy may ask for an older name:
      // serve the current script for it (short cache), so buttons never stop working after a deploy.
      if (/^\/app\.[0-9a-f]{10}\.js$/.test(url.pathname)) return new Response(APP.js, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": url.pathname === "/" + APP.name ? "public, max-age=31536000, immutable" : "no-cache" } });
      // The result view script, loaded on the first check. An old name (after a deploy) gets today's file, not cached.
      if (/^\/result\.[0-9a-f]{10}\.js$/.test(url.pathname)) return new Response(APP.lazy, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": url.pathname === "/" + APP.lazy_name ? "public, max-age=31536000, immutable" : "no-cache" } });
      if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
      return new Response("Not found", { status: 404 });
    } catch (e) {
      return json({ error: "Something went wrong on our side.", detail: String(e && e.message || e).slice(0, 200) }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cron(env, event.scheduledTime));
  },
};
