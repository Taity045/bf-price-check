// Reads one archived product page and decides if its price is safe to show. Pure: no network.
// W = the worker's own functions (extractFromHtml, detectBlock, canonicalize, tldCurrency), so archived
// pages are read exactly like a live check.

// Price sources that come from the shop's structured product data. "price-block" (a guess from the
// visible page text) is not trusted for archive copies.
export const TRUSTED_SOURCES = new Set(["json-ld", "og-meta", "microdata", "schema-in-script", "datalayer", "page-data-v2", "analytics-data"]);
const PRODUCT_SIGNAL = [
  /"@type"\s*:\s*\[?\s*"(?:Product|ProductGroup|IndividualProduct)"/i,
  /<meta[^>]+(?:property|name)=["']og:type["'][^>]+content=["'](?:og:)?product/i,
  /<meta[^>]+content=["'](?:og:)?product["'][^>]+(?:property|name)=["']og:type/i,
  /itemtype=["']https?:\/\/schema\.org\/Product["']/i,
  /(?:property|name)=["']product:price:amount["']/i,
  // Shop analytics data for a product detail view (used with the datalayer price sources).
  /["']event["']\s*:\s*["'](?:view_item|productDetail|detail)["']|["']ecommerce["']\s*:\s*\{[\s\S]{0,300}["'](?:detail|items|products)["']|["']product_?id["']\s*:/i,
];
const OOS = /"availability"\s*:\s*"(?:https?:\/\/schema\.org\/)?(?:OutOfStock|SoldOut|Discontinued)"|(?:property|name)=["'](?:product|og):availability["'][^>]+content=["'](?:out of stock|oos|sold out)/i;
const INSTOCK = /"availability"\s*:\s*"(?:https?:\/\/schema\.org\/)?(?:InStock|LimitedAvailability|OnlineOnly|PreOrder|BackOrder)"|(?:property|name)=["'](?:product|og):availability["'][^>]+content=["'](?:in stock|instock|available|preorder)/i;

export const sameKey = (s) => s.replace(/^http:/, "https:").replace(/^https:\/\/(?:www\.|m\.)/, "https://").replace(/\/+(?=\?|$)/, "").toLowerCase();
const lastSeg = (u) => { try { return new URL(u).pathname.replace(/\/+$/, "").split("/").pop().toLowerCase(); } catch { return ""; } };

// Product key: the same canonical URL the live check uses (canonicalize), always https.
// Returns null for links with product-choosing parameters (sizes, colours, SKUs): those can show a
// different price than the plain product page, so they are skipped.
export function productKey(W, url) {
  let u;
  try { u = new URL(url.replace(/^http:/, "https:")); } catch { return null; }
  if (W.archiveKey) return W.archiveKey(u.href);
  const c = W.canonicalize(u);
  if (new URL(c.canon).search) return null;
  return c.canon;
}

export function readArchivedPage(W, html, url, shop) {
  if (W.detectBlock(200, html)) return { ok: false, reason: "bot-page" };
  const host = new URL(url).hostname.toLowerCase();
  const ex = W.extractFromHtml(html, host);
  if (!ex.price) return { ok: false, reason: "no-price" };
  if (!TRUSTED_SOURCES.has(ex.source)) return { ok: false, reason: "untrusted-source" };
  if (!PRODUCT_SIGNAL.some((r) => r.test(html))) return { ok: false, reason: "not-product" };
  if (OOS.test(html) && !INSTOCK.test(html)) return { ok: false, reason: "out-of-stock" };
  const currency = ex.currency || W.tldCurrency(host);
  if (currency !== shop.ccy) return { ok: false, reason: "currency" };
  const price = Number(ex.price);
  if (!Number.isFinite(price) || price <= 0 || price >= 1e6) return { ok: false, reason: "bad-price" };
  // A page whose canonical link names another product (a redirect to a category, the home page, or
  // a different item) is not this product's price.
  const cm = html.match(/<link[^>]+rel=["']canonical["'][^>]*>/i);
  const href = cm && (cm[0].match(/href=["']([^"']+)["']/i) || [])[1];
  if (href) {
    let abs = null; try { abs = new URL(href.replace(/&amp;/g, "&"), url).href; } catch {}
    if (abs) {
      const a = sameKey(abs.split("?")[0]), b = sameKey(url.split("?")[0]);
      if (a !== b && lastSeg(abs) !== lastSeg(url)) return { ok: false, reason: "canonical-mismatch" };
    }
  }
  let was = ex.was ? Number(ex.was) : null;
  if (!(was > price) || was > price * 5) was = null;
  return { ok: true, price, was, currency, title: ex.title || null, source: ex.source };
}

// Within one product's archive copies: drop a price that is far from the product's usual price
// (a misread like £14 -> £1), and give up on the product when the copies still disagree wildly.
export const SPREAD = 2.5;
export function cleanSeries(points) {
  const pts = points.filter((p) => p.price > 0).sort((a, b) => a.t - b.t);
  if (!pts.length) return [];
  const s = pts.map((p) => p.price).sort((a, b) => a - b), n = s.length;
  const med = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  const kept = pts.filter((p) => p.price >= med / SPREAD && p.price <= med * SPREAD);
  if (!kept.length) return [];
  const lo = Math.min(...kept.map((p) => p.price)), hi = Math.max(...kept.map((p) => p.price));
  if (hi / lo > 3) return [];
  // Two copies only and far apart: we can't tell which one is right, so keep neither.
  if (kept.length === 2 && hi / lo > 2) return [];
  return kept;
}

// One row per run of the same price: first capture, last capture and how many copies agreed.
export function toSegments(points) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.price - p.price) < 0.005) { last.last_seen = p.t; last.n++; last.last_crawl = p.crawl; if (p.was && !last.was) last.was = p.was; continue; }
    out.push({ captured_at: p.t, last_seen: p.t, n: 1, price: p.price, was: p.was || null, currency: p.currency, url: p.url, crawl: p.crawl, last_crawl: p.crawl });
  }
  return out;
}
