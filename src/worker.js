// Black Friday Price Check — Cloudflare Worker
// Routes:  GET /                -> the app (HTML)
//          GET /api/check?url=  -> live price + stored history
//          GET /api/archive?url= -> Wayback snapshot list
//          GET /api/snap?url=&ts=&orig= -> price from one Wayback snapshot (cached forever in D1)
//          scheduled (cron)     -> re-checks tracked URLs once a day
// Bindings: DB (D1)

const CHECK_TTL_MS = 6 * 3600 * 1000;      // cache a live check for 6 h
const CDX_TTL_MS = 12 * 3600 * 1000;       // cache the snapshot list for 12 h
const HISTORY_DAYS = 365;
const SNAP_SPACING_DAYS = 6;
const MAX_SNAPS = 64;
const MAX_TRACKED = 1000;
const RECHECK_AFTER_MS = 20 * 3600 * 1000;
const LIVE_CACHE_PREFIX = "check-v3:";
const RL = { check: 20, snap: 120, req: 5 };       // requests per IP per minute
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
  const price = parsePrice(pm[2]);
  if (!price) return null;
  out.price = price;
  if (!out.currency) out.currency = symbolCurrency(pm[0]);
  const wm = strikeTxt.replace(/<[^>]+>/g, " ").match(amt);
  const was = wm && parsePrice(wm[2]);
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

function extractFromHtml(html, host) {
  const out = {};
  let source = null;
  if (/(^|\.)amazon\./.test(host)) source = parseAmazon(html, out);
  if (!source) source = parseJsonLd(html, out);
  const metaSrc = parseMeta(html, out);
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
  const key = "cdx-v4:" + JSON.stringify([canonInfo.canon, oKey]);
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
  // Always keep the capture closest to last Black Friday (28 Nov 2025), if there is one within 3 days.
  const bf = Date.UTC(2025, 10, 28);
  let bfRow = null;
  for (const r of rows) { const d = Math.abs(tsToMs(r[0]) - bf); if (d <= 3 * 864e5 && (!bfRow || d < Math.abs(tsToMs(bfRow[0]) - bf))) bfRow = r; }
  if (bfRow && !picked.some((x) => x.ts === bfRow[0])) { picked.push({ ts: bfRow[0], orig: bfRow[1] }); picked.sort((a, b) => a.ts.localeCompare(b.ts)); }
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

// ---------- supported shops ----------
// Shops whose pages we read reliably. "archive" = the shop blocks live checks, so we use archived copies only.
const SHOPS = [
  { name: "Takealot", host: "takealot.com", cc: "ZA" },
  { name: "Woolworths", host: "woolworths.co.za", cc: "ZA" },
  { name: "Checkers", host: "checkers.co.za", cc: "ZA" },
  { name: "Clicks", host: "clicks.co.za", cc: "ZA" },
  { name: "Loot", host: "loot.co.za", cc: "ZA" },
  { name: "Evetech", host: "evetech.co.za", cc: "ZA" },
  { name: "Cycle Lab", host: "cyclelab.com", cc: "ZA" },
  { name: "Amazon South Africa", host: "amazon.co.za", cc: "ZA" },
  { name: "Amazon UK", host: "amazon.co.uk", cc: "UK" },
  { name: "Currys", host: "currys.co.uk", cc: "UK", archive: true },
  { name: "MediaMarkt Germany", host: "mediamarkt.de", cc: "DE" },
  { name: "Amazon Germany", host: "amazon.de", cc: "DE" },
];
function shopFor(host) {
  const h = stripWww(String(host || "").toLowerCase());
  return SHOPS.find((x) => h === x.host || h.endsWith("." + x.host)) || null;
}

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
async function apiRequest(req, env) {
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
  if (await rateLimit(env, ip, "req")) return json({ error: "You sent many requests. Try again in a minute." }, 429);
  let host = null;
  try { host = stripWww(new URL(/^https?:/i.test(shop) ? shop : product || ("https://" + shop)).hostname.toLowerCase()); } catch {}
  if (host && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) host = null;
  await ensureRequestsTable(env);
  await env.DB.prepare("INSERT INTO shop_requests (host, shop_text, product_url, email, created_at, ip_hash) VALUES (?, ?, ?, ?, ?, ?)").bind(host, shop, product || null, email || null, now(), (await sha256("bf-req:" + ip)).slice(0, 32)).run();
  return json({ ok: true });
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
    await cachePut(env, ckey, current, current.status === "ok" ? CHECK_TTL_MS : 10 * 60 * 1000);
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
    shop: (() => { const x = shopFor(host); return x ? { name: x.name, archive: !!x.archive } : null; })(),
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
      if (req.method === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type" } });
      if (url.pathname === "/api/request") return await apiRequest(req, env);
      if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "method not allowed" }, 405);
      if (url.pathname === "/api/shops") return json({ shops: SHOPS.map(({ name, host, cc, archive }) => ({ name, host, cc, archive: !!archive })) }, 200, { "cache-control": "public, max-age=3600" });
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
