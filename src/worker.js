// Black Friday Price Check — Cloudflare Worker
// Routes:  GET /                -> the app (HTML)
//          GET /api/check?url=  -> live price + stored history + Wayback snapshot list
//          GET /api/snap?url=&ts=&orig= -> price from one Wayback snapshot (cached forever in D1)
//          scheduled (cron)     -> re-checks tracked URLs once a day
// Bindings: DB (D1)

const CHECK_TTL_MS = 6 * 3600 * 1000;      // cache a live check for 6 h
const CDX_TTL_MS = 12 * 3600 * 1000;       // cache the snapshot list for 12 h
const HISTORY_DAYS = 183;
const SNAP_SPACING_DAYS = 7;
const MAX_SNAPS = 26;
const MAX_TRACKED = 1000;
const RECHECK_AFTER_MS = 20 * 3600 * 1000;
const CRON_BATCH = 6;
const RL = { check: 20, snap: 120 };       // requests per IP per minute
const MAX_HTML = 4 * 1024 * 1024;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const TLD_CUR = [[".co.za","ZAR"],[".za","ZAR"],[".co.uk","GBP"],[".uk","GBP"],[".com.de","EUR"],[".de","EUR"],[".fr","EUR"],[".nl","EUR"],[".be","EUR"],[".es","EUR"],[".it","EUR"],[".ie","EUR"],[".at","EUR"],[".pt","EUR"],[".fi","EUR"],[".gr","EUR"],[".lu","EUR"],[".sk","EUR"],[".si","EUR"],[".ee","EUR"],[".lv","EUR"],[".lt","EUR"],[".hr","EUR"],[".mt","EUR"],[".cy","EUR"]];
const LANG = { ZAR: "en-ZA,en;q=0.9", GBP: "en-GB,en;q=0.9", EUR: "en-GB,en;q=0.8,de;q=0.6,nl;q=0.5,fr;q=0.5" };
const KNOWN_CUR = new Set(["ZAR","GBP","EUR","USD"]);

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
  if (p.length !== 4 || p.some((x) => isNaN(x) || x < 0 || x > 255)) return false;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
function isPrivateIPv6(ip) {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, "");
  return s === "::1" || s === "::" || s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe8") || s.startsWith("fe9") || s.startsWith("fea") || s.startsWith("feb") || s.startsWith("::ffff:") || s.startsWith("64:ff9b");
}

function validateUrl(raw) {
  if (!raw || raw.length > 2048) return { error: "Paste a product link (http or https)." };
  let u;
  try { u = new URL(raw.trim()); } catch { return { error: "That doesn't look like a valid link." }; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { error: "Only http(s) product links are allowed." };
  if (u.username || u.password) return { error: "Links with login details are not allowed." };
  if (u.port && u.port !== "80" && u.port !== "443") return { error: "Only standard web ports are allowed." };
  const h = u.hostname.toLowerCase();
  if (!h.includes(".") || h === "localhost" || /\.(local|internal|lan|home|corp|localhost|arpa)$/.test(h)) return { error: "That address is not a public website." };
  if (/^[\d.]+$/.test(h) || h.includes(":") || h.startsWith("[")) return { error: "Use the store's normal web address, not an IP address." };
  if (/(^|\.)workers\.dev$|(^|\.)archive\.org$/.test(h)) return { error: "That isn't a store page." };
  u.hash = "";
  return { url: u };
}

const dnsCache = new Map();
async function resolvesPublic(host) {
  if (dnsCache.has(host)) return dnsCache.get(host);
  let ok = true;
  try {
    for (const type of ["A", "AAAA"]) {
      const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(4000) });
      const d = await r.json();
      for (const a of d.Answer || []) {
        if (a.type === 1 && isPrivateIPv4(a.data)) ok = false;
        if (a.type === 28 && isPrivateIPv6(a.data)) ok = false;
      }
      if (type === "A" && d.Status === 3) { ok = false; break; } // NXDOMAIN
    }
  } catch { /* DNS lookup failed: let the fetch decide */ }
  dnsCache.set(host, ok);
  return ok;
}

const TRACKING = /^(utm_.*|gclid|gclsrc|dclid|fbclid|msclkid|mc_cid|mc_eid|ref|ref_|tag|linkCode|linkId|camp|creative|creativeASIN|psc|th|smid|spm|srsltid|_ga|_gl|cmp|cmpid|affiliate|aff|source|campaign|keywords|qid|sr|sprefix|crid|dib|dib_tag|pd_rd_.*|pf_rd_.*|content-id|social_share|starsLeft|ascsubtag|igshid|trk|zanpid|awc|sv1|sv_campaign_id|ito|mcid|cm_mmc|s_kwcid|ef_id|gad_source|gbraid|wbraid)$/i;

function canonicalize(u) {
  const c = new URL(u.toString());
  c.hash = "";
  const host = c.hostname.toLowerCase();
  // Amazon: /dp/ASIN
  if (/(^|\.)amazon\./.test(host)) {
    const m = c.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/asin)\/([A-Z0-9]{10})/i);
    if (m) return { canon: `https://${host.startsWith("www.") ? host : "www." + host}/dp/${m[1].toUpperCase()}`, kind: "amazon", asin: m[1].toUpperCase() };
  }
  if (/(^|\.)takealot\.com$/.test(host)) {
    const m = c.pathname.match(/PLID(\d+)/i);
    if (m) return { canon: `https://www.takealot.com${c.pathname.replace(/\/+$/, "")}`, kind: "takealot", plid: m[1] };
  }
  if (/(^|\.)woolworths\.co\.za$/.test(host)) {
    const m = c.pathname.match(/\/_\/(A-[0-9A-Za-z]+)/);
    if (m) return { canon: `https://www.woolworths.co.za/prod/_/${m[1]}`, kind: "woolworths", alt: c.origin.replace("//woolworths", "//www.woolworths") + c.pathname };
  }
  for (const k of [...c.searchParams.keys()]) if (TRACKING.test(k)) c.searchParams.delete(k);
  c.searchParams.sort();
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
  let m = html.match(/"(?:salePrice|sale_price|finalPrice|final_price|currentPrice|current_price|sellingPrice|offerPrice)"\s*:\s*\{?\s*(?:"(?:value|amount|centAmount)"\s*:\s*)?"?(\d[\d.,]*)"?/);
  if (m && parsePrice(m[1])) {
    out.price = parsePrice(m[1]);
    const w = html.match(/"(?:wasPrice|was_price|listPrice|list_price|regularPrice|regular_price|originalPrice|original_price|strikethroughPrice|oldPrice|old_price|rrp)"\s*:\s*\{?\s*(?:"(?:value|amount)"\s*:\s*)?"?(\d[\d.,]*)"?/);
    if (w && parsePrice(w[1]) > out.price) out.was = parsePrice(w[1]);
    const c = html.match(/"(?:currency|currencyCode|priceCurrency)"\s*:\s*"(ZAR|GBP|EUR|USD)"/);
    if (c && !out.currency) out.currency = c[1];
    return "page-data";
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
async function fetchPage(url, currency) {
  const h0 = stripWww(new URL(url).hostname.toLowerCase());
  const extra = AMZ_COOKIE[h0] ? { cookie: AMZ_COOKIE[h0] } : {};
  const r = await fetch(url, {
    headers: { ...extra, "user-agent": UA, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "accept-language": LANG[currency] || "en-GB,en;q=0.9", "cache-control": "no-cache", "upgrade-insecure-requests": "1", "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none" },
    redirect: "follow", signal: AbortSignal.timeout(15000), cf: { cacheTtl: 0 },
  });
  const len = +(r.headers.get("content-length") || 0);
  if (len > MAX_HTML) return { status: r.status, html: "", tooBig: true, finalUrl: r.url };
  let html = await r.text();
  if (html.length > MAX_HTML) html = html.slice(0, MAX_HTML);
  return { status: r.status, html, finalUrl: r.url };
}

async function takealotApi(plid) {
  const r = await fetch(`https://api.takealot.com/rest/v-1-14-0/product-details/PLID${plid}?platform=desktop&display_credit=false`, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) return { error: `Takealot API answered HTTP ${r.status}.` };
  const d = await r.json();
  const items = (d.buybox && d.buybox.items) || [];
  const it = items.find((x) => x.is_selected) || items[0];
  if (!it) return { error: "Takealot shows no offer for this product right now (maybe out of stock)." };
  const price = parsePrice(it.price), was = parsePrice(it.listing_price);
  const img = d.gallery && d.gallery.images && d.gallery.images[0];
  return { price, was: was && price && was > price ? was : null, currency: "ZAR", title: (d.core && d.core.title) || d.title, image: img ? img.replace("{size}", "pdpxl") : null, source: "takealot-api" };
}

async function getCurrent(canonInfo, origUrl) {
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
    const pg = await fetchPage(target, tldCur);
    if (pg.finalUrl) {
      const fh = new URL(pg.finalUrl).hostname;
      if (/^[\d.]+$/.test(fh) && isPrivateIPv4(fh)) return { ...res, status: "error", message: "Redirected to a private address." };
    }
    if (pg.tooBig) return { ...res, status: "error", message: "The page is too large to read." };
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
    return { ...res, status: "error", message: /timed? ?out|abort/i.test(String(e)) ? "The store took too long to answer." : "We couldn't reach the store." };
  }
}

// ---------- Wayback ----------
function cdxQueries(canonInfo, origUrl) {
  const q = [];
  if (canonInfo.kind === "amazon") {
    const host = stripWww(new URL(canonInfo.canon).hostname);
    q.push({ url: `${host}/dp/${canonInfo.asin}`, prefix: true });
    try {
      const op = new URL(origUrl).pathname;
      const m = op.match(new RegExp(`^(/[^/]+/dp/${canonInfo.asin})`, "i"));
      if (m) q.push({ url: host + m[1], prefix: true });
    } catch {}
  } else {
    const u = new URL(canonInfo.canon);
    const noQuery = u.origin + u.pathname;
    q.push({ url: canonInfo.canon, prefix: false });
    try { const o = new URL(origUrl); const op = o.origin + o.pathname; if (stripWww(op) !== stripWww(canonInfo.canon)) q.push({ url: op, prefix: false }); } catch {}
    if (u.search) q.push({ url: noQuery, prefix: false });
    else if (!u.pathname.endsWith("/")) q.push({ url: noQuery + "/", prefix: false });
  }
  return q;
}

async function getSnapshots(env, canonInfo, origUrl) {
  let oKey = ""; try { const o = new URL(origUrl); oKey = o.pathname; } catch {}
  const key = "cdx:" + canonInfo.canon + "|" + oKey;
  const cached = await cacheGet(env, key);
  if (cached) return cached;
  const from = ymd(new Date(now() - HISTORY_DAYS * 864e5));
  let rows = [], status = "ok", message = null;
  const queries = cdxQueries(canonInfo, origUrl);
  const results = await Promise.all(queries.map(async (q) => {
    try {
      const api = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(q.url)}${q.prefix ? "&matchType=prefix" : ""}&from=${from}&output=json&fl=timestamp,original,statuscode,mimetype&filter=!statuscode:[345]..&filter=mimetype:text/html|warc/revisit&collapse=timestamp:8&limit=1500`;
      let r;
      for (let attempt = 0; attempt < 3; attempt++) {
        r = await fetch(api, { headers: { "user-agent": "bf-price-check/1.0 (price history tool)" }, signal: AbortSignal.timeout(25000) });
        if (r.status !== 503 && r.status !== 429 && r.status !== 502) break;
        await new Promise((ok) => setTimeout(ok, 1500 * (attempt + 1)));
      }
      if (!r.ok) return { err: `The Internet Archive answered HTTP ${r.status}.` };
      const txt = await r.text();
      if (!txt.trim().startsWith("[")) return { err: "The Internet Archive is busy or offline right now." };
      return { rows: JSON.parse(txt).slice(1) };
    } catch (e) { return { err: "The Internet Archive took too long to answer." }; }
  }));
  let okCount = 0;
  for (const r of results) { if (r.rows) { okCount++; rows = rows.concat(r.rows); } else { status = "error"; message = r.err; } }
  if (okCount) { status = "ok"; message = null; }
  { const seen = new Set(); rows = rows.filter((r) => { const k = r[0].slice(0, 8); if (seen.has(k)) return false; seen.add(k); return true; }); }
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  // thin out: newest first, one per SNAP_SPACING_DAYS
  const picked = [];
  let last = Infinity;
  for (let i = rows.length - 1; i >= 0 && picked.length < MAX_SNAPS; i--) {
    const t = tsToMs(rows[i][0]);
    if (last - t >= SNAP_SPACING_DAYS * 864e5 - 36e5) { picked.push({ ts: rows[i][0], orig: rows[i][1] }); last = t; }
  }
  picked.reverse();
  const val = { status, message, total: rows.length, snaps: picked, queries: queries.map((q, i) => ({ url: q.url, prefix: q.prefix, rows: results[i].rows ? results[i].rows.length : null, error: results[i].err || null })) };
  if (status === "ok") await cachePut(env, key, val, okCount === results.length ? CDX_TTL_MS : 3600e3);
  return val;
}

async function fetchSnapshot(ts, orig) {
  const host = new URL(orig).hostname.toLowerCase();
  try {
    const r = await fetch(`https://web.archive.org/web/${ts}id_/${orig}`, { headers: { "user-agent": "bf-price-check/1.0 (price history tool)" }, redirect: "follow", signal: AbortSignal.timeout(25000) });
    if (r.status === 429 || r.status >= 500) return { status: "retry", message: `Archive HTTP ${r.status}` };
    if (!r.ok) return { status: "error", message: `Archive HTTP ${r.status}` };
    let html = await r.text();
    if (html.length > MAX_HTML) html = html.slice(0, MAX_HTML);
    if (detectBlock(200, html)) return { status: "blocked", message: "The archived copy is a bot-check page." };
    const ex = extractFromHtml(html, host);
    if (!ex.price) return { status: "noprice" };
    return { status: "ok", price: ex.price, was: ex.was || null, currency: ex.currency || tldCurrency(host) };
  } catch (e) {
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
  const exists = await env.DB.prepare("SELECT url FROM tracked WHERE url = ?").bind(canon).first();
  if (exists) {
    await env.DB.prepare("UPDATE tracked SET last_viewed = ?, last_checked = ?, last_status = ?, title = COALESCE(?, title), check_count = check_count + 1 WHERE url = ?").bind(now(), cur.checked_at, cur.status, cur.title || null, canon).run();
    return true;
  }
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM tracked").first();
  if (n && n.n >= MAX_TRACKED) return false;
  await env.DB.prepare("INSERT INTO tracked (url, orig_url, title, added_at, last_viewed, last_checked, last_status, check_count) VALUES (?, ?, ?, ?, ?, ?, ?, 1)").bind(canon, origUrl, cur.title || null, now(), now(), cur.checked_at, cur.status).run();
  return true;
}
async function storedHistory(env, canon) {
  const since = now() - HISTORY_DAYS * 864e5;
  const checks = await env.DB.prepare("SELECT ts, price, was, currency FROM checks WHERE url = ? AND ts >= ? ORDER BY ts").bind(canon, since).all();
  const snaps = await env.DB.prepare("SELECT snap_ts, price, was, currency, status, fetched_at FROM snaps WHERE url = ?").bind(canon).all();
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
  const ckey = "chk:" + canonInfo.canon;
  let current = fresh ? null : await cacheGet(env, ckey);
  let cached = !!current;
  if (!current) {
    current = await getCurrent(canonInfo, v.url.toString());
    await cachePut(env, ckey, current, current.status === "ok" ? CHECK_TTL_MS : 30 * 60 * 1000);
    await recordCheck(env, canonInfo.canon, current);
  }
  const tracked = await track(env, canonInfo.canon, v.url.toString(), current);
  const hist = await storedHistory(env, canonInfo.canon);
  return json({
    url: v.url.toString(), canonical: canonInfo.canon, host: stripWww(host), tld_currency: tldCurrency(host),
    current, cached, tracked,
    history: {
      archive: hist.snaps.filter((s) => s.status === "ok").map((s) => ({ t: tsToMs(s.snap_ts), ts: s.snap_ts, price: s.price, was: s.was, currency: s.currency })),
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
  let orig = tr.orig_url || canon;
  const op = new URL(req.url).searchParams.get("orig");
  if (op) { try { const o = new URL(op); if ((o.protocol === "https:" || o.protocol === "http:") && stripWww(o.hostname.toLowerCase()) === stripWww(new URL(canon).hostname.toLowerCase()) && canonicalize(o).canon === canon) orig = o.toString(); } catch {} }
  const canonInfo = canonicalize(new URL(orig));
  const snapsInfo = await getSnapshots(env, canonInfo, orig);
  const rows = await env.DB.prepare("SELECT snap_ts, status, fetched_at FROM snaps WHERE url = ?").bind(canon).all();
  const done = new Map((rows.results || []).map((s) => [s.snap_ts, s]));
  const pending = snapsInfo.snaps.filter((s) => { const d = done.get(s.ts); return !d || (d.status === "retry" && now() - d.fetched_at > 6 * 3600e3); });
  return json({ status: snapsInfo.status, message: snapsInfo.message, captures_6mo: snapsInfo.total, sampled: snapsInfo.snaps.length, pending, queries: snapsInfo.queries });
}

async function apiSnap(req, env) {
  const ip = req.headers.get("cf-connecting-ip") || "0";
  const p = new URL(req.url).searchParams;
  const canon = p.get("url") || "", ts = p.get("ts") || "", orig = p.get("orig") || "";
  if (!/^\d{14}$/.test(ts)) return json({ error: "bad ts" }, 400);
  let o;
  try { o = new URL(orig); } catch { return json({ error: "bad orig" }, 400); }
  let c;
  try { c = new URL(canon); } catch { return json({ error: "bad url" }, 400); }
  if (stripWww(o.hostname.toLowerCase()) !== stripWww(c.hostname.toLowerCase())) return json({ error: "host mismatch" }, 400);
  const tr = await env.DB.prepare("SELECT url FROM tracked WHERE url = ?").bind(canon).first();
  if (!tr) return json({ error: "Check the product first." }, 403);
  const have = await env.DB.prepare("SELECT snap_ts, price, was, currency, status, fetched_at FROM snaps WHERE url = ? AND snap_ts = ?").bind(canon, ts).first();
  if (have && (have.status !== "retry" || now() - have.fetched_at < 6 * 3600e3)) return json({ ts, t: tsToMs(ts), ...have, cached: true });
  if (await rateLimit(env, ip, "snap")) return json({ error: "rate limited", status: "retry" }, 429);
  const r = await fetchSnapshot(ts, orig);
  await env.DB.prepare("INSERT INTO snaps (url, snap_ts, price, was, currency, status, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(url, snap_ts) DO UPDATE SET price = excluded.price, was = excluded.was, currency = excluded.currency, status = excluded.status, fetched_at = excluded.fetched_at").bind(canon, ts, r.price || null, r.was || null, r.currency || null, r.status, now()).run();
  return json({ ts, t: tsToMs(ts), ...r });
}

async function cron(env) {
  const due = await env.DB.prepare("SELECT url, orig_url FROM tracked WHERE last_checked IS NULL OR last_checked < ? ORDER BY last_checked LIMIT ?").bind(now() - RECHECK_AFTER_MS, CRON_BATCH).all();
  for (const row of due.results || []) {
    let canonInfo;
    try { canonInfo = canonicalize(new URL(row.orig_url || row.url)); } catch { continue; }
    const cur = await getCurrent(canonInfo, row.orig_url || row.url);
    await recordCheck(env, row.url, cur);
    await env.DB.prepare("UPDATE tracked SET last_checked = ?, last_status = ?, check_count = check_count + 1 WHERE url = ?").bind(cur.checked_at, cur.status, row.url).run();
    if (cur.status === "ok") await cachePut(env, "chk:" + row.url, cur, CHECK_TTL_MS);
  }
  // housekeeping
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
    ctx.waitUntil(cron(env));
  },
};
