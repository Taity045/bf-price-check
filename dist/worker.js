// Black Friday Price Check — Cloudflare Worker
// Routes:  GET /                -> the app (HTML)
//          GET /api/check?url=  -> live price + stored history
//          GET /api/archive?url= -> Wayback snapshot list
//          GET /api/snap?url=&ts=&orig= -> price from one Wayback snapshot (cached forever in D1)
//          scheduled (cron)     -> re-checks tracked URLs once a day
// Bindings: DB (D1)

const CHECK_TTL_MS = 6 * 3600 * 1000;      // cache a live check for 6 h
const CDX_TTL_MS = 12 * 3600 * 1000;       // cache the snapshot list for 12 h
const HISTORY_DAYS = 183;
const SNAP_SPACING_DAYS = 5;
const MAX_SNAPS = 38;
const MAX_TRACKED = 1000;
const RECHECK_AFTER_MS = 20 * 3600 * 1000;
const LIVE_CACHE_PREFIX = "check-v2:";
const RL = { check: 20, snap: 120 };       // requests per IP per minute
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

function tldCurrency(host) {
  for (const [t, c] of TLD_CUR) if (host.endsWith(t)) return c;
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

// Parse "R 1 299,00", "1.299,00 €", "£1,299.99", 1299 -> number
function parsePrice(v) {
  if (v == null) return null;
  if (typeof v === "number") return v > 0 && v < 1e7 ? Math.round(v * 100) / 100 : null;
  let s = decodeEntities(String(v)).replace(/[\s\u00a0\u2009\u202f']/g, "");
  s = s.replace(/[^\d.,-]/g, "");
  if (!s || !/\d/.test(s)) return null;
  s = s.replace(/^[.,-]+|[.,-]+$/g, "");
  const lc = s.lastIndexOf(","), ld = s.lastIndexOf(".");
  if (lc >= 0 && ld >= 0) {
    if (lc > ld) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (lc >= 0) {
    const parts = s.split(",");
    if (parts.length === 2 && parts[1].length <= 2) s = parts[0] + "." + parts[1];
    else s = s.replace(/,/g, "");
  } else if (ld >= 0) {
    const parts = s.split(".");
    if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3)) s = s.replace(/\./g, "");
  }
  const n = parseFloat(s);
  return isFinite(n) && n > 0 && n < 1e7 ? Math.round(n * 100) / 100 : null;
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
  // Every address returned must be public. If no resolver answers, we do not block (fail open).
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
    const p = parsePrice(metas["product:price:amount"] || metas["og:price:amount"] || metas["product:sale_price:amount"] || metas["twitter:data1"] && /\d/.test(metas["twitter:data1"]) && /price/i.test(metas["twitter:label1"] || "") && metas["twitter:data1"]);
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
  if (pay) { p = parsePrice(pay[1]); if (!out.currency) out.currency = symbolCurrency(pay[1]); }
  const w = block.match(/(?:basisPrice|a-text-price)[\s\S]{0,300}?class="a-offscreen">([^<]+)</);
  if (w) was = parsePrice(w[1]);
  if (!p) {
    const whole = block.match(/class="a-price-whole">([\d.,\s]+)/), frac = block.match(/class="a-price-fraction">(\d+)/);
    if (whole) p = parsePrice(whole[1].replace(/[.,]\s*$/, "") + (frac ? "." + frac[1] : ""));
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

function extractFromHtml(html, host) {
  const out = {};
  let source = null;
  if (/(^|\.)amazon\./.test(host)) source = parseAmazon(html, out);
  if (!source) source = parseJsonLd(html, out);
  const metaSrc = parseMeta(html, out);
  if (!source) source = metaSrc;
  if (!source) source = parseFallback(html, out);
  if (!out.title) { const t = html.match(/<title[^>]*>([^<]{1,300})<\/title>/i); if (t) out.title = decodeEntities(t[1].trim()); }
  if (out.title) out.title = decodeEntities(out.title).slice(0, 200);
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

async function fetchStore(url, headers, timeout, verifiedHost) {
  const signal = AbortSignal.timeout(timeout);
  for (let hop = 0; hop <= 5; hop++) {
    const target = validateUrl(url);
    if (target.error) throw new PageReadError(target.error);
    const host = target.url.hostname;
    if (!(hop === 0 && host === verifiedHost) && !(await resolvesPublic(host))) {
      throw new PageReadError("Couldn't verify a public address for the store.");
    }
    const cookie = AMZ_COOKIE[stripWww(host)];
    const r = await fetch(target.url.href, { headers: { ...headers, ...(cookie ? { cookie } : {}) }, redirect: "manual", signal, cf: { cacheTtl: 0 } });
    if (![301, 302, 303, 307, 308].includes(r.status)) return r;
    const next = r.headers.get("location");
    await r.body?.cancel();
    if (!next) throw new PageReadError("The store returned an incomplete redirect.");
    url = new URL(next, target.url).href;
  }
  throw new PageReadError("The store redirected too many times.");
}

async function fetchPage(url, currency, verifiedHost) {
  const headers = { "user-agent": UA, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "accept-language": LANG[currency] || "en-GB,en;q=0.9", "cache-control": "no-cache", "upgrade-insecure-requests": "1", "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none" };
  const r = await fetchStore(url, headers, 15000, verifiedHost);
  return { status: r.status, html: await readLimitedText(r, true) };
}

async function takealotApi(plid) {
  const r = await fetchStore(`https://api.takealot.com/rest/v-1-14-0/product-details/PLID${plid}?platform=desktop&display_credit=false`, { "user-agent": UA, accept: "application/json" }, 12000);
  if (!r.ok) { await r.body?.cancel(); return { error: `Takealot API answered HTTP ${r.status}.` }; }
  const d = JSON.parse(await readLimitedText(r));
  const items = (d.buybox && d.buybox.items) || [];
  const it = items.find((x) => x.is_selected) || items[0];
  if (!it) return { error: "Takealot shows no offer for this product right now (maybe out of stock)." };
  const price = parsePrice(it.price), was = parsePrice(it.listing_price);
  const img = d.gallery && d.gallery.images && d.gallery.images[0];
  return { price, was: was && price && was > price ? was : null, currency: "ZAR", title: (d.core && d.core.title) || d.title, image: img ? img.replace("{size}", "pdpxl") : null, source: "takealot-api" };
}

async function getCurrent(canonInfo, origUrl, verifiedHost) {
  const host = new URL(canonInfo.canon).hostname.toLowerCase();
  const tldCur = tldCurrency(host);
  const res = { checked_at: now(), status: "ok" };
  try {
    if (canonInfo.kind === "takealot") {
      const t = await takealotApi(canonInfo.plid);
      if (t.error) return { ...res, status: "noprice", message: t.error };
      return { ...res, ...t };
    }
    const target = canonInfo.kind === "amazon" ? canonInfo.canon : origUrl;
    const pg = await fetchPage(target, tldCur, verifiedHost);
    const blocked = detectBlock(pg.status, pg.html);
    if (blocked) return { ...res, status: "blocked", http: pg.status, message: blocked };
    if (pg.status === 404 || pg.status === 410) return { ...res, status: "error", http: pg.status, message: `The store says this page doesn't exist (HTTP ${pg.status}).` };
    if (pg.status >= 400) return { ...res, status: "error", http: pg.status, message: `The store answered HTTP ${pg.status}.` };
    const ex = extractFromHtml(pg.html, host);
    let currency = ex.currency, currencyGuessed = false;
    if (!currency && ex.price) { currency = tldCur; currencyGuessed = !!currency && canonInfo.kind !== "amazon"; }
    if (ex.price && canonInfo.kind === "amazon" && tldCur && currency !== tldCur) return { ...res, status: "noprice", http: pg.status, title: ex.title, image: ex.image, message: `Amazon showed us a price in ${currency} instead of ${tldCur} (it does this for visitors outside the country), so we can't read the local price.` };
    if (!ex.price && canonInfo.kind === "amazon") return { ...res, status: "noprice", http: pg.status, title: ex.title, image: ex.image, message: "Amazon didn't show a buy price to us. It often hides the price for visitors outside the country (our checker runs on servers abroad), or the item is unavailable." };
    if (!ex.price) return { ...res, status: "noprice", http: pg.status, title: ex.title, image: ex.image, message: "We loaded the page but couldn't find a machine-readable price on it (the price may be loaded by JavaScript)." };
    return { ...res, price: ex.price, was: ex.was || null, currency, currency_guessed: currencyGuessed, title: ex.title, image: ex.image, source: ex.source, http: pg.status };
  } catch (e) {
    if (e instanceof PageReadError) return { ...res, status: "error", message: e.message };
    return { ...res, status: "error", message: /timed? ?out|abort/i.test(String(e)) ? "The store took too long to answer." : "We couldn't reach the store." };
  }
}

// ---------- Wayback ----------
// http/https and a trailing slash on the path don't make a different product page.
const sameKey = (s) => s.replace(/^http:/, "https:").replace(/\/+(?=\?|$)/, "");
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
  }
  return q;
}

async function getSnapshots(env, canonInfo, origUrl) {
  const oKey = new URL(origUrl).pathname;
  const key = "cdx-v3:" + JSON.stringify([canonInfo.canon, oKey]);
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
  // thin out: newest first, one per SNAP_SPACING_DAYS
  const picked = [];
  let last = Infinity;
  for (let i = rows.length - 1; i >= 0 && picked.length < MAX_SNAPS; i--) {
    const t = tsToMs(rows[i][0]);
    if (last - t >= SNAP_SPACING_DAYS * 864e5 - 36e5) { picked.push({ ts: rows[i][0], orig: rows[i][1] }); last = t; }
  }
  picked.reverse();
  const val = { status, message, total: rows.length, snaps: picked, queries: queries.map((q, i) => ({ url: q.url, prefix: q.prefix, rows: results[i].rows ? results[i].rows.length : null, error: results[i].err || null, detail: results[i].detail || null })) };
  if (status === "ok") await cachePut(env, key, val, okCount === results.length ? CDX_TTL_MS : 3600e3);
  return val;
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
      if (next.hostname !== "web.archive.org" || !m || !sameProduct(m[2], canon) || Math.abs(tsToMs(m[1]) - tsToMs(ts)) > SNAP_SPACING_DAYS * 864e5)
        return { status: "error", message: "The archive redirected to a different page or date." };
      url = next.href;
    }
    if (!r.ok) {
      await r.body?.cancel();
      return { status: r.status === 429 || r.status >= 500 ? "retry" : "error", message: `Archive HTTP ${r.status}` };
    }
    const html = await readLimitedText(r, true);
    if (detectBlock(200, html)) return { status: "blocked", message: "The archived copy is a bot-check page." };
    const ex = extractFromHtml(html, host);
    if (!ex.price) return { status: "noprice" };
    return { status: "ok", price: ex.price, was: ex.was || null, currency: ex.currency || tldCurrency(host) };
  } catch (e) {
    if (e instanceof PageReadError) return { status: "error", message: e.message };
    return { status: "retry", message: "Archive timeout" };
  }
}

// ---------- D1 helpers ----------
async function cacheGet(env, k) {
  const r = await env.DB.prepare("SELECT v, exp FROM cache WHERE k = ?").bind(k).first();
  if (!r || r.exp < now()) return null;
  try { return JSON.parse(r.v); } catch { return null; }
}
async function cachePut(env, k, v, ttl) {
  await env.DB.prepare("INSERT INTO cache (k, v, exp) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = excluded.exp").bind(k, JSON.stringify(v), now() + ttl).run();
}
async function rateLimit(env, ip, bucket) {
  const win = Math.floor(now() / 60000);
  const r = await env.DB.prepare("INSERT INTO rl (k, n, win) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = CASE WHEN rl.win = excluded.win THEN rl.n + 1 ELSE 1 END, win = excluded.win RETURNING n").bind(bucket + ":" + ip, win).first();
  return r && r.n > RL[bucket];
}
async function recordCheck(env, canon, cur) {
  if (cur.price) await env.DB.prepare("INSERT INTO checks (url, ts, price, was, currency, source, title) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(canon, cur.checked_at, cur.price, cur.was || null, cur.currency || null, cur.source || null, cur.title || null).run();
}
async function track(env, canon, origUrl, cur) {
  const viewed = now();
  const row = await env.DB.prepare(`
    INSERT INTO tracked (url, orig_url, title, added_at, last_viewed, last_checked, last_status, check_count)
    SELECT ?, ?, ?, ?, ?, ?, ?, 1
    WHERE EXISTS (SELECT 1 FROM tracked WHERE url = ?) OR (SELECT COUNT(*) FROM tracked) < ?
    ON CONFLICT(url) DO UPDATE SET orig_url = excluded.orig_url, last_viewed = excluded.last_viewed,
      last_checked = MAX(COALESCE(tracked.last_checked, 0), excluded.last_checked),
      last_status = CASE WHEN excluded.last_checked >= COALESCE(tracked.last_checked, 0) THEN excluded.last_status ELSE tracked.last_status END,
      title = COALESCE(excluded.title, tracked.title), check_count = tracked.check_count + 1
    RETURNING url`).bind(canon, origUrl, cur.title || null, viewed, viewed, cur.checked_at, cur.status, canon, MAX_TRACKED).first();
  return !!row;
}
async function storedHistory(env, canon) {
  const since = now() - HISTORY_DAYS * 864e5;
  // Old page-data rows did not retain the unit, so their amounts cannot be rescaled reliably.
  const checks = await env.DB.prepare("SELECT ts, price, was, currency FROM checks WHERE url = ? AND ts >= ? AND source IS NOT 'page-data' ORDER BY ts").bind(canon, since).all();
  const snaps = await env.DB.prepare("SELECT snap_ts, orig, price, was, currency, status FROM product_snaps WHERE url = ? AND snap_ts >= ? AND status NOT IN ('pending', 'retry')").bind(canon, ymd(new Date(since))).all();
  return { checks: checks.results || [], snaps: snaps.results || [] };
}

// ---------- API handlers ----------
async function apiCheck(req, env, ctx) {
  const ip = req.headers.get("cf-connecting-ip") || "0";
  const params = new URL(req.url).searchParams;
  const v = validateUrl(params.get("url"));
  if (v.error) return json({ error: v.error }, 400);
  if (await rateLimit(env, ip, "check")) return json({ error: "Slow down a little — too many checks in a minute. Try again shortly." }, 429);
  const canonInfo = canonicalize(v.url);
  const host = v.url.hostname.toLowerCase();
  if (!(await resolvesPublic(host))) return json({ error: "That address doesn't point to a public website." }, 400);
  const fresh = params.get("fresh") === "1";
  const ckey = LIVE_CACHE_PREFIX + canonInfo.canon;
  let current = fresh ? null : await cacheGet(env, ckey);
  let cached = !!current;
  if (!current) {
    current = await getCurrent(canonInfo, v.url.toString(), host);
    await cachePut(env, ckey, current, current.status === "ok" ? CHECK_TTL_MS : 30 * 60 * 1000);
    await recordCheck(env, canonInfo.canon, current);
  }
  const tracked = await track(env, canonInfo.canon, v.url.toString(), current);
  const hist = await storedHistory(env, canonInfo.canon);
  return json({
    url: v.url.toString(), canonical: canonInfo.canon, host: stripWww(host), tld_currency: tldCurrency(host),
    current, cached, tracked,
    history: {
      archive: hist.snaps.filter((s) => s.status === "ok").map((s) => ({ t: tsToMs(s.snap_ts), ts: s.snap_ts, orig: s.orig, price: s.price, was: s.was, currency: s.currency })),
      archive_failed: hist.snaps.filter((s) => s.status !== "ok" && s.status !== "retry").length,
      checks: hist.checks.map((c) => ({ t: c.ts, price: c.price, was: c.was, currency: c.currency })),
    },
    history_days: HISTORY_DAYS,
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
  return json({ status: snapsInfo.status, message: snapsInfo.message, captures_6mo: snapsInfo.total, sampled: snapsInfo.snaps.length, pending, queries: snapsInfo.queries });
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

async function cron(env, scheduledTime) {
  const due = await env.DB.prepare("SELECT url, orig_url FROM tracked WHERE last_checked IS NULL OR last_checked < ? ORDER BY last_checked LIMIT 1").bind(now() - RECHECK_AFTER_MS).all();
  for (const row of due.results || []) {
    // Always move last_checked forward, so one failing product can't block the queue.
    let cur = { status: "error", checked_at: now() };
    try {
      const orig = sameProduct(row.orig_url, row.url) ? row.orig_url : row.url;
      const v = validateUrl(orig);
      if (v.url) cur = await getCurrent(canonicalize(v.url), v.url.href);
      await recordCheck(env, row.url, cur);
      if (cur.status === "ok") await cachePut(env, LIVE_CACHE_PREFIX + row.url, cur, CHECK_TTL_MS);
    } catch { cur = { ...cur, status: "error" }; }
    await env.DB.prepare("UPDATE tracked SET last_checked = ?, last_status = ?, check_count = check_count + 1 WHERE url = ?").bind(cur.checked_at, cur.status, row.url).run();
  }
  // housekeeping
  if (new Date(scheduledTime).getUTCMinutes() !== 0) return;
  await env.DB.prepare("DELETE FROM rl WHERE win < ?").bind(Math.floor(now() / 60000) - 5).run();
  await env.DB.prepare("DELETE FROM cache WHERE exp < ?").bind(now()).run();
  await env.DB.prepare("DELETE FROM tracked WHERE last_viewed < ?").bind(now() - 120 * 864e5).run();
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (req.method === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET", "access-control-allow-headers": "content-type" } });
      if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "method not allowed" }, 405);
      if (url.pathname === "/api/check") return await apiCheck(req, env, ctx);
      if (url.pathname === "/api/archive") return await apiArchive(req, env);
      if (url.pathname === "/api/snap") return await apiSnap(req, env);
      if (url.pathname === "/" || url.pathname === "/index.html") return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
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

const HTML = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<title>Deal or Dud? \u00b7 Price history check</title>\n<meta name=\"description\" content=\"Paste a product link. See the shop's own prices over the last 6 months and find out if the 'was' price is real.\">\n<meta property=\"og:title\" content=\"Deal or Dud? \u00b7 Price history check\">\n<meta property=\"og:description\" content=\"Is that deal real? Paste a product link and see 6 months of price history.\">\n<meta name=\"theme-color\" content=\"#f3efe6\" media=\"(prefers-color-scheme: light)\">\n<meta name=\"theme-color\" content=\"#15140f\" media=\"(prefers-color-scheme: dark)\">\n<link rel=\"icon\" href=\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' fill='%2317150f'/><text x='16' y='24' font-family='Georgia,serif' font-weight='700' font-size='22' fill='%23f3efe6' text-anchor='middle'>D?</text></svg>\">\n<style>\n:root{\n  --bg:#f3efe6;--field:#fbf9f4;--ink:#17150f;--mut:#6b665b;--rule:#d6cfbf;--soft:#e8e2d4;\n  --good:#1d6b3c;--bad:#b0261c;--meh:#7a5a00;\n  --serif:\"Iowan Old Style\",\"Charter\",\"Bitstream Charter\",\"Palatino Linotype\",Palatino,Georgia,serif;\n  --sans:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,\"Helvetica Neue\",Arial,sans-serif;\n}\n@media (prefers-color-scheme: dark){\n  :root{--bg:#15140f;--field:#1c1b16;--ink:#ece6d6;--mut:#9b9483;--rule:#36332a;--soft:#25231c;--good:#74c690;--bad:#f07a6c;--meh:#dcb44e}\n}\n*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}\nhtml,body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 var(--sans)}\nbody{min-height:100vh;min-height:100dvh;padding:env(safe-area-inset-top) 0 calc(env(safe-area-inset-bottom) + 24px)}\nmain{max-width:640px;margin:0 auto;padding:20px 16px 40px}\nbutton{touch-action:manipulation;min-height:44px;min-width:44px;cursor:pointer;font:inherit;color:inherit;background:none;border:0;border-radius:2px;user-select:none;-webkit-user-select:none}\nbutton:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--ink);outline-offset:3px}\na{color:inherit;text-underline-offset:3px}\n.num{font-variant-numeric:tabular-nums lining-nums}\n.lab{display:block;font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--mut)}\n.hidden{display:none!important}\n\n/* masthead */\n.mast{border-top:4px solid var(--ink);padding-top:8px}\n.mast-top{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid var(--rule);padding-bottom:8px}\nh1{font-family:var(--serif);font-weight:700;font-size:clamp(46px,14vw,76px);line-height:.92;letter-spacing:-.025em;margin:22px 0 14px}\n.dek{font-family:var(--serif);font-size:19px;line-height:1.42;margin:0;max-width:32em}\n\n/* form */\n.check{margin-top:28px}\n.check .lab{margin-bottom:8px}\n.inrow{display:flex}\ninput[type=url],input[type=text],select{min-width:0;height:52px;padding:0 14px;border:1.5px solid var(--ink);border-radius:2px;background:var(--field);color:var(--ink);font:16px var(--sans)}\n#u{flex:1;border-right:0;border-radius:2px 0 0 2px}\ninput:focus,select:focus{outline:none;box-shadow:inset 0 0 0 1px var(--ink)}\ninput::placeholder{color:var(--mut)}\n.paste{height:52px;padding:0 16px;border:1.5px solid var(--ink);border-radius:0 2px 2px 0;font-weight:600}\n.paste:active{background:var(--soft)}\n.go{margin-top:10px;width:100%;height:54px;background:var(--ink);color:var(--bg);font-weight:600;font-size:17px;letter-spacing:.01em}\n.go:active{transform:translateY(1px)}\n.go[disabled]{opacity:.7}\n.tries{margin-top:26px}\n.tries .lab{padding-bottom:6px;border-bottom:1px solid var(--ink)}\n.chip{display:flex;width:100%;align-items:center;justify-content:space-between;gap:12px;min-height:50px;padding:6px 0;border-bottom:1px solid var(--rule);text-align:left;border-radius:0}\n.chip b{font-weight:600}\n.chip .item{color:var(--mut)}\n.chip .cc{font-size:11px;font-weight:600;letter-spacing:.1em;color:var(--mut);display:flex;gap:10px;align-items:center}\n.chip .cc::after{content:\"\u2192\";font-size:16px;letter-spacing:0;color:var(--ink)}\n.chip:active{background:var(--soft)}\n\n.err{margin-top:20px;border-left:3px solid var(--bad);padding:4px 0 4px 14px}\n\n/* result blocks */\n.block{border-top:1px solid var(--rule);padding:22px 0 4px;margin-top:22px}\n#result > .block:first-child{border-top:4px solid var(--ink);margin-top:34px}\n.prod{display:flex;gap:16px;align-items:flex-start;justify-content:space-between}\n.prod img{width:76px;height:76px;object-fit:contain;background:#fff;border:1px solid var(--rule);border-radius:2px;flex:0 0 auto}\n.prod h2{font-family:var(--serif);font-size:23px;line-height:1.2;font-weight:700;margin:6px 0 0;word-break:break-word}\n.prices{display:flex;flex-wrap:wrap;gap:8px 28px;margin-top:18px;align-items:flex-end}\n.pcol{display:flex;flex-direction:column;gap:2px}\n.now{font-family:var(--serif);font-size:46px;font-weight:700;line-height:1;letter-spacing:-.01em}\n.now.dim{font-size:28px}\n.now.none{font-size:22px;color:var(--mut);font-weight:400}\n.was{font-family:var(--serif);font-size:24px;color:var(--mut);text-decoration:line-through;text-decoration-thickness:1.5px;line-height:1.2}\n.claim{font-family:var(--serif);font-size:24px;line-height:1.2}\n.small{font-size:13px;color:var(--mut)}\n#psrc{margin-top:10px}\n.note{font-size:14px;color:var(--mut);margin:12px 0 0}\n.manual{display:grid;grid-template-columns:1fr 1fr 96px;gap:8px;margin-top:12px}\n.manual label{display:flex;flex-direction:column;gap:6px}\n.manual input,.manual select{width:100%}\n.manual select{padding:0 8px;-webkit-appearance:none;appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--ink) 50%),linear-gradient(135deg,var(--ink) 50%,transparent 50%);background-position:calc(100% - 15px) 23px,calc(100% - 10px) 23px;background-size:5px 5px;background-repeat:no-repeat}\n.btn2{width:100%;height:48px;border:1.5px solid var(--ink);font-weight:600;margin-top:10px}\n.btn2:active{background:var(--soft)}\n\n/* verdict */\n.verdict{--v:var(--mut)}\n#result > .verdict{border-top:4px solid var(--v)}\n.verdict.good{--v:var(--good)} .verdict.bad{--v:var(--bad)} .verdict.meh{--v:var(--meh)}\n.verdict::before{content:\"Our verdict\";display:block;font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--mut)}\n.verdict .big{font-family:var(--serif);font-size:clamp(34px,10vw,46px);font-weight:700;line-height:1.02;letter-spacing:-.015em;color:var(--v);margin:8px 0 10px}\n.verdict.unk .big{color:var(--ink)}\n.vbody{font-family:var(--serif);font-size:19px;line-height:1.42;margin:0}\n.flag{margin-top:16px;border-left:3px solid var(--bad);padding:2px 0 2px 12px;font-weight:600}\n.flag.ok{border-color:var(--good)}\n.stats{display:grid;grid-template-columns:repeat(3,1fr);margin-top:20px;border-top:1px solid var(--ink);border-bottom:1px solid var(--rule)}\n.stats.two{grid-template-columns:1fr 1fr;margin-top:0;border-top:0}\n.stat{padding:12px 0 12px 12px;border-left:1px solid var(--rule);display:flex;flex-direction:column-reverse;gap:2px}\n.stat:first-child{border-left:0;padding-left:0}\n.stat b{font-family:var(--serif);font-size:24px;font-weight:700;line-height:1.1}\n.pos{color:var(--good)} .neg{color:var(--bad)}\n\n/* chart */\n.charthead{display:flex;justify-content:space-between;align-items:baseline;gap:8px}\nh3{font-family:var(--serif);font-size:23px;font-weight:700;margin:0;line-height:1.2}\nsvg{display:block;width:100%;height:auto;touch-action:manipulation}\n#chart svg text{font:12px var(--sans);font-variant-numeric:tabular-nums}\n.c-grid{stroke:var(--rule)} .c-base{stroke:var(--ink)}\n.c-ax{fill:var(--mut)}\n.c-was{stroke:var(--bad);stroke-width:1.5;stroke-dasharray:6 5} .c-wast{fill:var(--bad)}\n.c-ln{fill:none;stroke:var(--ink);stroke-width:2}\n.c-ln.gap{stroke-width:1.25;stroke-dasharray:2 5;opacity:.55}\n.c-arch{fill:var(--bg);stroke:var(--ink);stroke-width:2}\n.c-chk{fill:var(--ink)}\n.c-now{fill:var(--ink)} .c-ring{fill:none;stroke:var(--ink);stroke-width:1.5}\n.legend{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:13px;color:var(--mut);margin-top:10px}\n.legend span{display:inline-flex;align-items:center;gap:6px}\n.legend svg{width:auto;height:14px;display:inline-block}\n.tip{min-height:24px;font-size:15px;margin-top:10px}\n.prog{height:2px;background:var(--rule);margin-top:14px}\n.prog i{display:block;height:100%;width:0;background:var(--ink);transition:width .3s}\ndetails{margin-top:8px;border-top:1px solid var(--rule)}\nsummary{min-height:48px;display:flex;align-items:center;cursor:pointer;font-weight:600;touch-action:manipulation;list-style:none}\nsummary::-webkit-details-marker{display:none}\nsummary::after{content:\"+\";margin-left:auto;font-size:20px;font-weight:400}\ndetails[open] summary::after{content:\"\u2212\"}\ntable{width:100%;border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums}\ntd,th{padding:8px 4px 8px 0;border-bottom:1px solid var(--rule);text-align:left}\nth{font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--mut)}\n\n.actions{display:flex;gap:8px;margin-top:22px}\n.actions button{flex:1;height:48px;border:1.5px solid var(--ink);font-weight:600}\n.actions button:active{background:var(--soft)}\n\n/* method */\n.method{margin-top:44px;border-top:4px solid var(--ink);padding-top:16px}\n.method ol{list-style:none;padding:0;margin:14px 0 0;counter-reset:m}\n.method li{counter-increment:m;position:relative;padding:10px 0 10px 30px;border-top:1px solid var(--rule);font-size:15px}\n.method li::before{content:counter(m);position:absolute;left:0;top:9px;font-family:var(--serif);font-weight:700;font-size:17px;line-height:1.35}\nfooter{color:var(--mut);font-size:13px;margin-top:24px;padding-top:12px;border-top:1px solid var(--rule)}\n\n.spin{display:inline-block;width:14px;height:14px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:sp .8s linear infinite;vertical-align:-2px;margin-right:10px}\n@keyframes sp{to{transform:rotate(360deg)}}\n@media (prefers-reduced-motion: reduce){.spin{animation-duration:2.4s}.prog i{transition:none}}\n.toast{position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom));transform:translateX(-50%);background:var(--ink);color:var(--bg);font-weight:600;padding:10px 16px;border-radius:2px;z-index:5;pointer-events:none;opacity:0;transition:opacity .2s}\n.toast.on{opacity:1}\n@media (min-width:600px){\n  main{padding-top:36px}\n  .dek{font-size:21px}\n  .method ol{columns:2;column-gap:28px}\n  .method li{break-inside:avoid}\n}\n</style>\n</head>\n<body>\n<main>\n  <header class=\"mast\">\n    <div class=\"mast-top\"><span class=\"lab\">Price history check</span><span class=\"lab\">South Africa \u00b7 UK</span></div>\n    <h1>Deal or Dud?</h1>\n    <p class=\"dek\">Paste a link to a product. We put today's price next to six months of that shop's own prices, so a made-up \"was\" price has nowhere to hide.</p>\n  </header>\n\n  <section class=\"check\">\n    <form id=\"f\" autocomplete=\"off\">\n      <label class=\"lab\" for=\"u\">Product link</label>\n      <div class=\"inrow\">\n        <input id=\"u\" type=\"url\" inputmode=\"url\" placeholder=\"https://www.takealot.com/\u2026\" required>\n        <button type=\"button\" class=\"paste\" id=\"paste\" aria-label=\"Paste link\">Paste</button>\n      </div>\n      <button class=\"go\" id=\"go\" type=\"submit\">Check the price</button>\n    </form>\n    <div class=\"tries\" id=\"tries\"><span class=\"lab\">Or try one of these</span><div id=\"chips\"></div></div>\n  </section>\n\n  <div id=\"error\" class=\"err hidden\" role=\"alert\"></div>\n\n  <section id=\"result\" class=\"hidden\">\n    <div class=\"block\">\n      <div class=\"prod\">\n        <div style=\"min-width:0\">\n          <span class=\"lab\" id=\"phost\"></span>\n          <h2 id=\"ptitle\"></h2>\n        </div>\n        <img id=\"pimg\" alt=\"\" class=\"hidden\">\n      </div>\n      <div class=\"prices\" id=\"prices\"></div>\n      <div class=\"small\" id=\"psrc\"></div>\n      <div id=\"manualbox\" class=\"hidden\">\n        <p class=\"note\" id=\"manualmsg\"></p>\n        <div class=\"manual\">\n          <label><span class=\"lab\">Price now</span><input type=\"text\" inputmode=\"decimal\" id=\"mnow\" placeholder=\"1299\"></label>\n          <label><span class=\"lab\">\"Was\" price</span><input type=\"text\" inputmode=\"decimal\" id=\"mwas\" placeholder=\"optional\"></label>\n          <label><span class=\"lab\">Currency</span><select id=\"mcur\"><option value=\"\">\u2014</option><option>ZAR</option><option>GBP</option><option>EUR</option><option>USD</option></select></label>\n        </div>\n        <button type=\"button\" class=\"btn2\" id=\"mapply\">Use these prices</button>\n      </div>\n    </div>\n\n    <section class=\"block verdict unk\" id=\"verdict\" aria-live=\"polite\"></section>\n\n    <div class=\"block\">\n      <div class=\"charthead\"><h3>Six months of prices</h3><span class=\"small num\" id=\"cnt\"></span></div>\n      <div class=\"prog\" id=\"prog\"><i></i></div>\n      <div class=\"small\" id=\"progtxt\" style=\"margin-top:8px\"></div>\n      <div id=\"chart\" style=\"margin-top:12px\"></div>\n      <div class=\"legend\">\n        <span><svg viewBox=\"0 0 14 14\"><circle cx=\"7\" cy=\"7\" r=\"4.5\" class=\"c-arch\"/></svg>Archived copy</span>\n        <span><svg viewBox=\"0 0 14 14\"><circle cx=\"7\" cy=\"7\" r=\"3.5\" class=\"c-chk\"/></svg>Our daily check</span>\n        <span><svg viewBox=\"0 0 14 14\"><circle cx=\"7\" cy=\"7\" r=\"6\" class=\"c-ring\"/><circle cx=\"7\" cy=\"7\" r=\"3\" class=\"c-now\"/></svg>Today</span>\n        <span><svg viewBox=\"0 0 22 14\"><line x1=\"0\" x2=\"22\" y1=\"7\" y2=\"7\" class=\"c-was\"/></svg>Shop's \"was\" price</span>\n        <span><svg viewBox=\"0 0 22 14\"><line x1=\"0\" x2=\"22\" y1=\"7\" y2=\"7\" class=\"c-ln gap\"/></svg>No data in between</span>\n      </div>\n      <div class=\"tip num\" id=\"tip\">Tap a point to see its date and price.</div>\n      <details id=\"pts\"><summary>Every data point</summary><div id=\"ptable\"></div></details>\n      <p class=\"note\" id=\"archnote\"></p>\n      <div class=\"hidden\" id=\"retryArch\"><button type=\"button\" class=\"btn2\" id=\"retryArchBtn\">Try the archive again</button></div>\n    </div>\n\n    <div class=\"actions\">\n      <button type=\"button\" id=\"share\">Share this check</button>\n      <button type=\"button\" id=\"again\">Check again</button>\n    </div>\n  </section>\n\n  <section class=\"method\">\n    <h3>How we check</h3>\n    <ol>\n      <li>We read today's price from the product data on the shop's page.</li>\n      <li>We rebuild the last six months from copies of the page saved by the <a href=\"https://web.archive.org\" target=\"_blank\" rel=\"noopener\">Internet Archive</a>, about one a week.</li>\n      <li>We re-check each tracked product about once a day, so its history keeps growing.</li>\n      <li>If the shop's \"was\" price is higher than anything we've seen recently, we say so.</li>\n      <li>Some shops block automated checks, and some pages have no archived copies. When that happens we tell you. We never guess a price.</li>\n    </ol>\n  </section>\n  <footer>Prices change fast. Confirm on the shop's page before you buy.</footer>\n</main>\n<div class=\"toast\" id=\"toast\" role=\"status\"></div>\n\n<script>\n(() => {\nconst $ = (id) => document.getElementById(id);\nconst EXAMPLES = [{\"label\": \"MediaMarkt \\u00b7 AirPods Pro 3\", \"cc\": \"DE\", \"url\": \"https://www.mediamarkt.de/de/product/_apple-airpods-pro-3-in-ear-kopfhorer-bluetooth-white-3013574.html\"}, {\"label\": \"MediaMarkt \\u00b7 Galaxy S26\", \"cc\": \"DE\", \"url\": \"https://www.mediamarkt.de/de/product/_samsung-galaxy-s26-256-gb-black-dual-sim-3033289.html\"}, {\"label\": \"MediaMarkt \\u00b7 Galaxy A57\", \"cc\": \"DE\", \"url\": \"https://www.mediamarkt.de/de/product/_samsung-galaxy-a57-256-gb-awesome-gray-dual-sim-3039261.html\"}, {\"label\": \"MediaMarkt \\u00b7 Galaxy Tab A11\", \"cc\": \"DE\", \"url\": \"https://www.mediamarkt.de/de/product/_samsung-galaxy-tab-a11-wi-fi-tablet-128-gb-11-zoll-grau-3020224.html\"}, {\"label\": \"MediaMarkt \\u00b7 Galaxy S25\", \"cc\": \"DE\", \"url\": \"https://www.mediamarkt.de/de/product/_samsung-galaxy-s25-5g-256-gb-icyblue-dual-sim-2972629.html\"}];\nconst LOC = { ZAR: \"en-ZA\", GBP: \"en-GB\", EUR: \"en-IE\", USD: \"en-US\" };\nconst DAY = 864e5;\nlet state = null, runId = 0;\n\nfunction money(v, cur) {\n  if (v == null || !isFinite(v)) return \"\u2014\";\n  if (!cur) return v.toLocaleString(\"en-GB\") + \" (currency unknown)\";\n  try { return new Intl.NumberFormat(LOC[cur] || \"en-GB\", { style: \"currency\", currency: cur, ...(Number.isInteger(v) ? { minimumFractionDigits: 0 } : {}) }).format(v); }\n  catch { return (cur ? cur + \" \" : \"\") + v.toFixed(2); }\n}\nconst pct = (x) => Math.abs(Math.round(x * 100)) + \"%\";\nconst signed = (x) => (x >= 0 ? \"\u2212\" : \"+\") + Math.abs(Math.round(x * 100)) + \"%\";\nconst fmtDate = (t) => new Date(t).toLocaleDateString(\"en-GB\", { day: \"numeric\", month: \"short\", year: \"numeric\" });\nconst esc = (s) => String(s ?? \"\").replace(/[&<>\"']/g, (c) => ({ \"&\": \"&amp;\", \"<\": \"&lt;\", \">\": \"&gt;\", '\"': \"&quot;\", \"'\": \"&#39;\" }[c]));\nfunction toast(msg) { const t = $(\"toast\"); t.textContent = msg; t.classList.add(\"on\"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove(\"on\"), 1800); }\nfunction parseNum(s) { if (!s) return null; s = String(s).replace(/[^\\d.,]/g, \"\"); if (/,\\d{2}$/.test(s)) s = s.replace(/\\./g, \"\").replace(\",\", \".\"); else s = s.replace(/,/g, \"\"); const n = parseFloat(s); return n > 0 ? n : null; }\n\n// examples\nEXAMPLES.forEach((e) => {\n  const [store, item] = e.label.split(\" \u00b7 \");\n  const b = document.createElement(\"button\"); b.type = \"button\"; b.className = \"chip\";\n  b.innerHTML = `<span><b>${esc(store)}</b>${item ? ` <span class=\"item\">${esc(item)}</span>` : \"\"}</span><span class=\"cc\">${esc(e.cc || \"\")}</span>`;\n  b.addEventListener(\"click\", () => { $(\"u\").value = e.url; run(e.url); });\n  $(\"chips\").appendChild(b);\n});\nif (!EXAMPLES.length) $(\"tries\").classList.add(\"hidden\");\n\n$(\"paste\").addEventListener(\"click\", async () => {\n  try { const t = await navigator.clipboard.readText(); if (t) { const m = t.match(/https?:\\/\\/\\S+/); $(\"u\").value = m ? m[0] : t.trim(); } else toast(\"Clipboard is empty\"); }\n  catch { $(\"u\").focus(); toast(\"Long-press the box and choose Paste\"); }\n});\n$(\"f\").addEventListener(\"submit\", (e) => { e.preventDefault(); const v = $(\"u\").value.trim(); const m = v.match(/https?:\\/\\/\\S+/); run(m ? m[0] : v); });\n$(\"retryArchBtn\").addEventListener(\"click\", () => state && loadSnaps(runId));\n$(\"again\").addEventListener(\"click\", () => state && run(state.url, true));\n$(\"share\").addEventListener(\"click\", async () => {\n  if (!state) return;\n  const link = location.origin + \"/?u=\" + encodeURIComponent(state.url);\n  const text = state.verdictText ? `${state.verdictText}: ${state.title || \"this deal\"}` : \"Is this deal real?\";\n  if (navigator.share) { try { await navigator.share({ title: \"Deal or Dud?\", text, url: link }); return; } catch (e) { if (e && e.name === \"AbortError\") return; } }\n  try { await navigator.clipboard.writeText(link); toast(\"Link copied\"); } catch { prompt(\"Copy this link:\", link); }\n});\n$(\"mapply\").addEventListener(\"click\", () => {\n  if (!state) return;\n  const n = parseNum($(\"mnow\").value), w = parseNum($(\"mwas\").value);\n  if (!n) { toast(\"Type the price you see\"); return; }\n  const currency = $(\"mcur\").value || historyCurrency();\n  if (!currency) { toast(\"Choose the currency\"); $(\"mcur\").focus(); return; }\n  $(\"mcur\").value = currency;\n  state.manual = { price: n, was: w && w > n ? w : null, currency };\n  renderPrices(); renderAll();\n});\n\nfunction showError(msg) { const e = $(\"error\"); e.textContent = msg; e.classList.remove(\"hidden\"); }\n\nasync function run(url, fresh) {\n  if (!url) return;\n  const my = ++runId;\n  $(\"error\").classList.add(\"hidden\");\n  const go = $(\"go\"); go.disabled = true; go.innerHTML = '<span class=\"spin\"></span>Checking\u2026';\n  try {\n    const r = await fetch(\"/api/check?url=\" + encodeURIComponent(url) + (fresh ? \"&fresh=1\" : \"\"));\n    const d = await r.json().catch(() => ({ error: \"Unexpected answer from the server.\" }));\n    if (my !== runId) return;\n    if (!r.ok || d.error) { showError(d.error || \"Something went wrong.\"); return; }\n    history.replaceState(null, \"\", \"/?u=\" + encodeURIComponent(d.url));\n    state = { ...d, title: d.current.title, archive_meta: null, archive: d.history.archive.slice(), manual: null, failed: d.history.archive_failed };\n    $(\"mcur\").value = d.current.currency || d.tld_currency || \"\";\n    $(\"result\").classList.remove(\"hidden\");\n    $(\"tip\").textContent = \"Tap a point to see its date and price.\"; $(\"pts\").open = false;\n    renderHead(); renderPrices(); renderAll();\n    $(\"result\").scrollIntoView({ behavior: \"smooth\", block: \"start\" });\n    if (d.tracked) loadSnaps(my);\n    else {\n      $(\"prog\").classList.add(\"hidden\"); $(\"retryArch\").classList.add(\"hidden\");\n      $(\"progtxt\").textContent = \"Tracking is full. Daily checks and archive lookups are unavailable for this product.\";\n    }\n  } catch (e) { if (my === runId) showError(\"Couldn't reach the checker. Check your connection and try again.\"); }\n  finally { if (my === runId) { go.disabled = false; go.textContent = \"Check the price\"; } }\n}\n\nasync function loadSnaps(my) {\n  $(\"progtxt\").innerHTML = '<span class=\"spin\"></span>Looking for archived copies at the Internet Archive\u2026';\n  $(\"prog\").classList.add(\"hidden\"); $(\"retryArch\").classList.add(\"hidden\");\n  try {\n    const r = await fetch(\"/api/archive?url=\" + encodeURIComponent(state.canonical) + \"&orig=\" + encodeURIComponent(state.url));\n    const d = await r.json();\n    if (my !== runId) return;\n    state.archive_meta = d.error ? { status: \"error\", message: d.error, pending: [] } : d;\n  } catch { if (my !== runId) return; state.archive_meta = { status: \"error\", message: \"couldn't reach the archive\", pending: [] }; }\n  $(\"progtxt\").textContent = \"\";\n  if (state.archive_meta.status !== \"ok\") $(\"retryArch\").classList.remove(\"hidden\");\n  renderAll();\n  const todo = (state.archive_meta.pending || []).slice();\n  const total = todo.length; let done = 0;\n  updProg(done, total);\n  if (!total) return;\n  let i = 0;\n  const worker = async () => {\n    while (i < todo.length && my === runId) {\n      const s = todo[i++];\n      try {\n        const r = await fetch(`/api/snap?url=${encodeURIComponent(state.canonical)}&ts=${s.ts}&orig=${encodeURIComponent(s.orig)}`);\n        const d = await r.json();\n        if (my !== runId) return;\n        if (d.status === \"ok\" && d.price) state.archive.push({ t: d.t, ts: d.ts, orig: d.orig, price: d.price, was: d.was, currency: d.currency });\n        else state.failed++;\n      } catch { if (my !== runId) return; state.failed++; }\n      done++; updProg(done, total); renderAll();\n    }\n  };\n  await Promise.all([worker(), worker(), worker()]);\n}\n\nfunction updProg(done, total) {\n  const p = $(\"prog\"), t = $(\"progtxt\");\n  if (!total) { p.classList.add(\"hidden\"); t.textContent = \"\"; return; }\n  p.classList.remove(\"hidden\"); p.firstElementChild.style.width = Math.round((done / total) * 100) + \"%\";\n  t.textContent = done < total ? `Reading archived copies\u2026 ${done}/${total}` : `Read ${total} archived cop${total === 1 ? \"y\" : \"ies\"}.`;\n}\n\n// The one currency all known history points share, if any.\nfunction historyCurrency() {\n  const set = new Set([...state.archive, ...state.history.checks].map((x) => x.currency).filter(Boolean));\n  return set.size === 1 ? [...set][0] : null;\n}\n\nfunction curPrice() {\n  const c = state.current;\n  if (state.manual) return { price: state.manual.price, was: state.manual.was, currency: state.manual.currency, manual: true };\n  if (c.status === \"ok\" && c.price) return { price: c.price, was: c.was, currency: c.currency || state.tld_currency };\n  return null;\n}\n\nfunction renderHead() {\n  const c = state.current;\n  $(\"ptitle\").textContent = c.title || state.host;\n  $(\"phost\").textContent = c.title ? state.host : \"\";\n  const img = $(\"pimg\");\n  if (c.image) { img.src = c.image; img.classList.remove(\"hidden\"); img.onerror = () => img.classList.add(\"hidden\"); } else img.classList.add(\"hidden\");\n}\n\nfunction renderPrices() {\n  const c = state.current, p = curPrice();\n  const box = $(\"prices\"), src = $(\"psrc\"), mb = $(\"manualbox\");\n  if (p) {\n    const claimed = p.was ? (p.was - p.price) / p.was : null;\n    box.innerHTML = `<div class=\"pcol\"><span class=\"lab\">${p.manual ? \"You entered\" : \"Today\"}</span><span class=\"now num\">${esc(money(p.price, p.currency))}</span></div>`\n      + (p.was ? `<div class=\"pcol\"><span class=\"lab\">Shop's \"was\"</span><span class=\"was num\">${esc(money(p.was, p.currency))}</span></div><div class=\"pcol\"><span class=\"lab\">Claimed saving</span><span class=\"claim num\">${Math.round(claimed * 100)}%</span></div>` : \"\");\n    const when = c.checked_at ? new Date(c.checked_at).toLocaleString(\"en-GB\", { day: \"numeric\", month: \"short\", hour: \"2-digit\", minute: \"2-digit\" }) : \"\";\n    src.textContent = p.manual ? \"Prices entered by you.\" : `Read from the shop ${when}${state.cached ? \" (cached)\" : \"\"} \u00b7 source: ${c.source || \"page\"}${c.currency_guessed ? \" \u00b7 currency guessed from the web address\" : \"\"}${p.was ? \"\" : \" \u00b7 no \\\"was\\\" price on the page\"}`;\n  } else {\n    const arch = state.archive.slice().sort((a, b) => b.t - a.t)[0];\n    if (arch) {\n      box.innerHTML = `<div class=\"pcol\"><span class=\"lab\">Last archived price</span><span class=\"now dim num\">${esc(money(arch.price, arch.currency))}</span></div>` + (arch.was ? `<div class=\"pcol\"><span class=\"lab\">Was</span><span class=\"was num\">${esc(money(arch.was, arch.currency))}</span></div>` : \"\");\n      src.textContent = `We couldn't read today's price. This is the latest archived price, from ${fmtDate(arch.t)}. It may be out of date.`;\n    } else {\n      box.innerHTML = `<div class=\"pcol\"><span class=\"lab\">Today</span><span class=\"now none\">Price not available</span></div>`;\n      src.textContent = \"\";\n    }\n  }\n  if (c.status !== \"ok\" || !c.price) {\n    mb.classList.remove(\"hidden\");\n    $(\"manualmsg\").textContent = (c.message || \"We couldn't read the price.\") + \" Type the price you see on the shop's page and we'll compare it with the history.\";\n  } else mb.classList.add(\"hidden\");\n}\n\nfunction median(a) { const s = [...a].sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; }\n\n// keep the last check of each day\nfunction dedupeDays(list) { const m = new Map(); for (const c of list) m.set(new Date(c.t).toISOString().slice(0, 10), c); return [...m.values()]; }\n\nfunction points() {\n  const cur = curPrice(); const ccy = cur ? cur.currency : null;\n  const all = [\n    ...state.archive.map((a) => ({ ...a, kind: \"archive\" })),\n    ...state.history.checks.map((c) => ({ ...c, kind: \"check\" })),\n  ].filter((x) => x.price && x.t >= Date.now() - 183 * DAY);\n  // keep one currency only\n  const pick = ccy || all.find((x) => x.currency)?.currency;\n  const same = all.filter((x) => pick && x.currency === pick);\n  const pts = same.filter((x) => x.kind === \"archive\").concat(dedupeDays(same.filter((x) => x.kind === \"check\")));\n  pts.sort((a, b) => a.t - b.t);\n  return { pts, other: all.length - same.length, ccy: pick };\n}\n\nfunction renderAll() { if (!curPrice()) renderPrices(); renderChart(); renderArchiveNote(); renderVerdict(); renderTable(); }\n\nfunction setVerdict(cls, big, html) {\n  const el = $(\"verdict\");\n  el.className = \"block verdict \" + cls;\n  el.innerHTML = `<div class=\"big\">${esc(big)}</div>${html}`;\n}\n\nfunction renderVerdict() {\n  const cur = curPrice(); const { pts, other, ccy } = points();\n  const hist = pts.filter((x) => x.t < Date.now() - DAY);\n  const pr = hist.map((x) => x.price);\n  const p90 = hist.filter((x) => x.t >= Date.now() - 90 * DAY).map((x) => x.price);\n  let cls, big, body, flags = \"\";\n  if (!cur?.currency) {\n    body = cur ? \"We need the currency of today's price to compare it with the history.\" : \"We need today's price. Type it in above to compare it with the history.\";\n    if (pr.length) body += ` History so far: lowest ${money(Math.min(...pr), ccy)}, typical ${money(median(pr), ccy)}.`;\n    setVerdict(\"unk\", \"Can't judge yet\", `<p class=\"vbody\">${esc(body)}</p>`); state.verdictText = null; return;\n  }\n  const P = cur.price, W = cur.was, C = cur.currency;\n  if (pr.length < 3) {\n    body = pr.length >= 1 ? `We found only ${pr.length} older price${pr.length === 1 ? \"\" : \"s\"} in ${C} (latest ${money(pr[pr.length - 1], C)} on ${fmtDate(hist[hist.length - 1].t)}). We need at least 3 to judge.` : `We found no older prices in ${C} for this product yet.`;\n    if (state.tracked) body += \" We'll keep checking for new prices.\";\n    if (W) body += ` The shop claims ${Math.round((W - P) / W * 100)}% off ${money(W, C)}. We can't confirm that.`;\n    setVerdict(\"unk\", \"Not enough history\", `<p class=\"vbody\">${esc(body)}</p>`); state.verdictText = null; return;\n  }\n  const low = Math.min(...pr), high = Math.max(...pr), med = median(pr);\n  const high90 = p90.length >= 2 ? Math.max(...p90) : high;\n  const vsMed = (med - P) / med, vsLow = (low - P) / low;\n  const inflated = W && W > high90 * 1.03;\n  const neverSeen = W && W > high * 1.03;\n  if (P <= low * 1.005 && vsMed >= 0.05) { cls = \"good\"; big = \"Real deal\"; body = `This is the lowest price in six months, ${pct(vsMed)} below the usual ${money(med, C)}.`; }\n  else if (inflated && vsMed < 0.05) { cls = \"bad\"; big = \"Fake discount\"; body = `The \"was\" price looks inflated. Today's price is about what it usually costs (${money(med, C)}).`; }\n  else if (P > med * 1.03) { cls = \"bad\"; big = \"Pricier than usual\"; body = `It usually costs ${money(med, C)}. Today's price is ${pct(vsMed)} higher. Wait if you can.`; }\n  else if (vsMed >= 0.05) { cls = \"good\"; big = \"Decent deal\"; body = `${pct(vsMed)} below the usual ${money(med, C)}, but it has been cheaper: ${money(low, C)}.`; }\n  else { cls = \"meh\"; big = \"Same old price\"; body = `Close to the usual ${money(med, C)}. Not a special deal.`; }\n  if (W) {\n    if (neverSeen) flags += `<div class=\"flag\">The \"was\" price of ${esc(money(W, C))} is higher than any price we saw in six months (highest: ${esc(money(high, C))}).</div>`;\n    else if (inflated) flags += `<div class=\"flag\">The \"was\" price of ${esc(money(W, C))} is higher than anything in the last 90 days (highest: ${esc(money(high90, C))}).</div>`;\n    else if (pr.includes(W)) flags += `<div class=\"flag ok\">We previously saw the \"was\" price of ${esc(money(W, C))}.</div>`;\n    else flags += `<p class=\"note\">We haven't observed the exact \"was\" price of ${esc(money(W, C))}.</p>`;\n  }\n  const claimed = W ? `<p class=\"note\">The shop claims ${Math.round((W - P) / W * 100)}% off ${esc(money(W, C))}. Real saving against the usual price: ${esc(money(Math.max(0, med - P), C))}.</p>` : \"\";\n  setVerdict(cls, big, `<p class=\"vbody\">${esc(body)}</p>${flags}\n    <div class=\"stats num\"><div class=\"stat\"><b>${esc(money(low, C))}</b><span class=\"lab\">6-month low</span></div><div class=\"stat\"><b>${esc(money(med, C))}</b><span class=\"lab\">Usual</span></div><div class=\"stat\"><b>${esc(money(high, C))}</b><span class=\"lab\">6-month high</span></div></div>\n    <div class=\"stats two num\"><div class=\"stat\"><b class=\"${vsMed >= 0 ? \"pos\" : \"neg\"}\">${signed(vsMed)}</b><span class=\"lab\">vs usual</span></div><div class=\"stat\"><b class=\"${vsLow >= 0 ? \"pos\" : \"neg\"}\">${signed(vsLow)}</b><span class=\"lab\">vs 6-month low</span></div></div>\n    ${claimed}\n    <p class=\"note\">Based on ${pr.length} older price${pr.length === 1 ? \"\" : \"s\"}${cur.manual ? \" and the price you entered\" : \"\"}.${other ? ` ${other} point(s) with a different or unknown currency were left out.` : \"\"}</p>`);\n  state.verdictText = big;\n}\n\nfunction renderChart() {\n  const { pts, ccy } = points(); const current = curPrice();\n  const cur = current?.currency && current.currency === ccy ? current : null;\n  const W = 600, H = 300, L = 62, R = 14, T = 18, B = 34;\n  const t1 = Date.now(), t0 = t1 - 183 * DAY;\n  const all = pts.map((p) => ({ ...p }));\n  if (cur) all.push({ t: t1, price: cur.price, kind: \"now\", was: cur.was });\n  $(\"cnt\").textContent = `${pts.length} price${pts.length === 1 ? \"\" : \"s\"}`;\n  const ys = all.map((p) => p.price); if (cur && cur.was) ys.push(cur.was);\n  if (!ys.length) { $(\"chart\").innerHTML = `<div class=\"small\" style=\"padding:36px 0;text-align:center;border-top:1px solid var(--rule);border-bottom:1px solid var(--rule)\">No prices to draw yet.</div>`; return; }\n  let lo = Math.min(...ys), hi = Math.max(...ys); if (hi === lo) { hi *= 1.1; lo *= 0.9; }\n  const pad = (hi - lo) * 0.12; lo = Math.max(0, lo - pad); hi += pad;\n  const X = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R), Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);\n  let s = `<svg viewBox=\"0 0 ${W} ${H}\" role=\"img\" aria-label=\"Price chart\">`;\n  for (let i = 0; i <= 4; i++) { const v = lo + ((hi - lo) * i) / 4, y = Y(v); s += `<line x1=\"${L}\" x2=\"${W - R}\" y1=\"${y}\" y2=\"${y}\" class=\"${i === 0 ? \"c-base\" : \"c-grid\"}\"/><text x=\"${L - 8}\" y=\"${y + 4}\" class=\"c-ax\" text-anchor=\"end\">${esc(money(v, ccy).replace(/\\.\\d+$/, \"\"))}</text>`; }\n  for (let m = 0; m <= 6; m++) { const d = new Date(t1 - (6 - m) * 30.5 * DAY); const x = X(d.getTime()); s += `<text x=\"${x}\" y=\"${H - 10}\" class=\"c-ax\" text-anchor=\"middle\">${d.toLocaleDateString(\"en-GB\", { month: \"short\" })}</text>`; }\n  if (cur && cur.was) { const y = Y(cur.was); s += `<line x1=\"${L}\" x2=\"${W - R}\" y1=\"${y}\" y2=\"${y}\" class=\"c-was\"/><text x=\"${W - R}\" y=\"${y - 7}\" class=\"c-wast\" text-anchor=\"end\">\"was\" ${esc(money(cur.was, ccy))}</text>`; }\n  const line = all.slice().sort((a, b) => a.t - b.t);\n  // solid line only between points < 21 days apart; dotted where we have no data in between\n  for (let i = 1; i < line.length; i++) {\n    const a = line[i - 1], c = line[i], gap = c.t - a.t > 21 * DAY;\n    s += `<path d=\"M${X(a.t)} ${Y(a.price)}H${X(c.t)}V${Y(c.price)}\" class=\"c-ln${gap ? \" gap\" : \"\"}\"/>`;\n  }\n  all.forEach((p, i) => {\n    const x = X(p.t), y = Y(p.price);\n    if (p.kind === \"now\") s += `<circle cx=\"${x}\" cy=\"${y}\" r=\"10\" class=\"c-ring\"/><circle cx=\"${x}\" cy=\"${y}\" r=\"5\" class=\"c-now\"/>`;\n    else if (p.kind === \"check\") s += `<circle cx=\"${x}\" cy=\"${y}\" r=\"4\" class=\"c-chk\"/>`;\n    else s += `<circle cx=\"${x}\" cy=\"${y}\" r=\"5\" class=\"c-arch\"/>`;\n    s += `<circle data-i=\"${i}\" cx=\"${x}\" cy=\"${y}\" r=\"18\" fill=\"transparent\" style=\"cursor:pointer\"/>`;\n  });\n  s += `</svg>`;\n  $(\"chart\").innerHTML = s;\n  $(\"chart\").querySelectorAll(\"circle[data-i]\").forEach((c) => c.addEventListener(\"click\", () => {\n    const p = all[+c.dataset.i];\n    $(\"tip\").innerHTML = `<b>${esc(money(p.price, ccy))}</b> \u00b7 ${p.kind === \"now\" ? \"today\" : fmtDate(p.t)} \u00b7 ${p.kind === \"archive\" ? \"archived copy\" : p.kind === \"check\" ? \"our check\" : (cur.manual ? \"entered by you\" : \"shop's page today\")}${p.was ? ` \u00b7 was ${esc(money(p.was, ccy))}` : \"\"}`;\n  }));\n}\n\nfunction renderArchiveNote() {\n  let note = \"\";\n  const ai = state.archive_meta;\n  if (ai) {\n    if (ai.status !== \"ok\") note = `Price history from the Internet Archive isn't available right now: ${ai.message || \"unknown error\"}.`;\n    else if (!ai.captures_6mo) note = \"The Internet Archive has no copies of this page from the last six months, so older prices are missing.\";\n    else note = `The Internet Archive has ${ai.captures_6mo} day${ai.captures_6mo === 1 ? \"\" : \"s\"} with copies of this page in six months; we sampled ${ai.sampled}.`;\n    if (state.failed) note += ` ${state.failed} archived cop${state.failed === 1 ? \"y\" : \"ies\"} had no readable price (bot-check page, or the price was loaded by JavaScript).`;\n  }\n  $(\"archnote\").textContent = note;\n}\n\nfunction renderTable() {\n  const { pts, ccy } = points();\n  if (!pts.length) { $(\"ptable\").innerHTML = `<p class=\"small\">No data points yet.</p>`; return; }\n  $(\"ptable\").innerHTML = `<table><tr><th>Date</th><th>Price</th><th>Was</th><th>Source</th></tr>${pts.slice().reverse().map((p) => `<tr><td>${fmtDate(p.t)}</td><td>${esc(money(p.price, ccy))}</td><td>${p.was ? esc(money(p.was, ccy)) : \"\u2014\"}</td><td>${p.kind === \"archive\" ? `<a href=\"https://web.archive.org/web/${p.ts}/${esc(p.orig || state.canonical)}\" target=\"_blank\" rel=\"noopener\">archive</a>` : \"our check\"}</td></tr>`).join(\"\")}</table>`;\n}\n\nconst qs = new URLSearchParams(location.search).get(\"u\");\nif (qs) { $(\"u\").value = qs; run(qs); }\n})();\n</script>\n</body>\n</html>\n";
