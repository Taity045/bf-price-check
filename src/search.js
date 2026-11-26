// ---------- Search: find a product by its name at the shops we can search ----------
// Joined with worker.js and compare.js at build time (build.py), so it uses the compare shop searches.
//
// How it works
//   1. /api/search?q=&c=ZA|GB         checks the words and gives the list of shops to search (same country,
//                                     shops that sell this kind of product), plus the shops we can't search.
//   2. /api/search/shop?q=&c=&shop=   searches ONE shop with its own public site search (CMP_SEARCH), and
//                                     keeps only in-stock products whose name has every word of the search.
//      The page calls this once per shop (a few at a time), so a slow shop never blocks the fast ones.
//   3. Each shop's answer is kept for SRCH_TTL in the Cloudflare cache (Cache API: no D1 writes).
//      robots.txt is checked for every shop (cmpRobotsOk), and the shop limits of compare apply.
// Prices are the shops' own live prices. We never add or change a price.

const SRCH_MIN = 2, SRCH_MAX = 120;      // characters in a search
const SRCH_TTL = 20 * 60;                // seconds: one shop's answer for one search
const SRCH_PER_SHOP = 8;                 // products per shop in the answer
const SRCH_MAX_SHOPS = 12;               // shops per search
const SRCH_TIMEOUT = 14000;              // ms for one shop's search
const SRCH_CC = { ZA: "ZAR", GB: "GBP", UK: "GBP" };
const SRCH_VER = "v1";
// When we can't tell the kind of product, search the general shops and the shops that sell many kinds of things.
const SRCH_BROAD = ["electronics", "appliances", "home"];
// Words that do not need to be in a product's name.
const SRCH_SKIP = new Set(["the", "a", "an", "and", "of", "for", "with", "in", "on", "new", "buy", "cheap", "cheapest", "best", "price", "deal", "deals", "sale", "online", "sa", "uk"]);

// A link (https://…, or a domain with a path such as takealot.com/…) or a product name?
function srchIsLink(v) {
  const s = String(v || "").trim();
  if (!s) return false;
  if (/https?:\/\/\S+/i.test(s)) return true;
  if (/^(www\.)?[\w-]+(\.[\w-]+)+\/\S*/i.test(s)) return true;
  // one word with a domain ending: "takealot.com", "www.loot.co.za"
  return !/\s/.test(s) && /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|co\.za|za|co\.uk|uk|net|org|eu|de|fr|nl|ie|io|shop|store|to|co)$/i.test(s);
}

// The search words, cleaned: { q } or { error }.
function srchClean(raw) {
  const q = String(raw == null ? "" : raw).normalize("NFC").replace(/[\u0000-\u001f\u007f<>{}\\`]/g, " ").replace(/\s+/g, " ").trim();
  if (!q) return { error: "Type a product name or paste a product link." };
  if (srchIsLink(q)) return { error: "That is a link. Paste it to check its price." };
  if (q.length < SRCH_MIN) return { error: `Type at least ${SRCH_MIN} letters or numbers.` };
  if (q.length > SRCH_MAX) return { error: `Use ${SRCH_MAX} characters or fewer.` };
  if (!/[\p{L}\p{N}]/u.test(q)) return { error: "Type a product name with letters or numbers." };
  if (!srchWords(q).length) return { error: "Type a product name, for example PS5 Slim." };
  return { q };
}
const srchCountry = (c) => { const k = String(c || "ZA").toUpperCase(); return SRCH_CC[k] ? (k === "UK" ? "GB" : k) : null; };
// The words that must be in a product's name (normalised the same way as compare: "PlayStation 5" = "ps5").
const srchWords = (q) => [...new Set(cmpWords(q).filter((w) => !SRCH_SKIP.has(w) && w !== "-" && w !== "+"))];
const srchKey = (q) => srchWords(q).join(" ");

// Which shops to search: same currency, not off (robots.txt or no search), shops that sell this kind of product.
function srchPlan(q, country) {
  const cur = SRCH_CC[country];
  const cat = cmpCatOf(q);
  const words = new Set(srchWords(q));
  const want = (s) => s.sells.includes("*") || (cat ? s.sells.includes(cat) : s.sells.some((x) => SRCH_BROAD.includes(x)));
  const shops = [], notSearched = [];
  for (const s of CMP_SHOPS) {
    if (s.cur !== cur) continue;
    if (s.brands && !s.brands.some((b) => words.has(b))) continue;
    if (!want(s) && !s.brands) continue;
    if (s.off === "robots") { notSearched.push({ name: s.name, why: "robots" }); continue; }
    if (s.off || !CMP_SEARCH[s.kind]) continue;
    shops.push({ id: s.id, name: s.name, general: s.sells.includes("*") });
  }
  // general shops first (they answer for most searches), then specialists; slow shops last
  const slow = (id) => (cmpShopById(id) || {}).slow ? 1 : 0;
  shops.sort((a, b) => slow(a.id) - slow(b.id) || b.general - a.general);
  for (const x of CMP_NOT_SEARCHED[cur] || []) {
    const cats = x.cats || CMP_NOT_SEARCHED_CATS;
    if (cat ? cats.includes(cat) : cats.some((c) => SRCH_BROAD.includes(c))) notSearched.push({ name: x.name, why: x.why });
  }
  return { category: cat, noun: cat ? CMP_CAT_NOUN[cat] || null : null, currency: cur, shops: shops.slice(0, SRCH_MAX_SHOPS).map(({ id, name }) => ({ id, name })), notSearched };
}

// Does this product name have every search word? Short words must be whole words; a word with digits
// can also be part of a joined word ("buds3"); a long word can be plural or singular ("kettle", "kettles").
function srchHas(words, title) {
  const tw = cmpWords(title), set = new Set(tw);
  // two or three words next to each other, joined ("buds 3" = "buds3"; "ps5" does not match "ps500")
  for (let i = 0; i < tw.length; i++) { set.add(tw[i] + (tw[i + 1] || "")); if (tw[i + 2]) set.add(tw[i] + tw[i + 1] + tw[i + 2]); }
  return words.every((w) => {
    if (set.has(w)) return true;
    if (/^\d+$/.test(w)) return tw.some((t) => t === w || new RegExp("^" + w + "(st|nd|rd|th)$").test(t));
    if (w.length >= 4) return tw.some((t) => t === w + "s" || t === w + "es" || w === t + "s" || w === t + "es");
    return false;
  });
}
// Keep real, in-stock products with an exact price that match the search; no accessories or used stock
// unless the search asks for them. Cheapest first.
function srchFilter(q, shop, list) {
  const words = srchWords(q), nq = cmpNorm(q);
  const wantAcc = CMP_ACCESSORY.test(nq) || /\b(case|cover|charger|cable|stand|strap|controller|skin|protector)\b/.test(nq);
  const wantUsed = CMP_CONDITION.test(nq);
  const seen = new Set(), out = [];
  for (const c of list || []) {
    if (!c || !c.title || !c.url || !(c.price > 0) || c.in_stock === false) continue;
    let u; try { u = new URL(c.url); } catch { continue; }
    if (u.protocol !== "https:" && u.protocol !== "http:") continue;
    const host = cmpShopForHost(u.hostname);
    if (!host || host.id !== shop.id) continue;           // only links on this shop's own site
    if (seen.has(u.href)) continue;
    const same = cmpNorm(c.title) + "|" + c.price;          // colour versions with the same name and price: show one
    if (seen.has(same)) continue;
    // some shops keep the brand apart from the name ("KLF03 Kettle", brand Smeg): show and match both
    const brand = c.brand ? decodeEntities(String(c.brand)).replace(/\s+/g, " ").trim() : "";
    const low = String(c.title).toLowerCase();
    const title = brand && brand.length < 40 && !brand.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length > 1 && low.includes(w)) ? brand + " " + c.title : String(c.title);
    const t = cmpNorm(title);
    if (!srchHas(words, title)) continue;
    if (!wantAcc && CMP_ACCESSORY.test(t)) continue;
    if (!wantUsed && CMP_CONDITION.test(t)) continue;
    seen.add(u.href); seen.add(same);
    out.push({ title: title.replace(/\s+/g, " ").trim().slice(0, 200), price: Math.round(c.price * 100) / 100, was: c.was && c.was > c.price ? Math.round(c.was * 100) / 100 : null, from: !!c.range, currency: shop.cur, url: u.href });
  }
  return out.sort((a, b) => a.price - b.price).slice(0, SRCH_PER_SHOP);
}

// Cloudflare cache (per data centre). Not on workers.dev or in tests: then every search goes to the shop
// (each shop fetch is also kept 10 minutes by cmpFetch).
const srchCacheUrl = (shop, country, q) => `https://search-cache.eish.veldwire.com/${SRCH_VER}/${country}/${shop}/${encodeURIComponent(srchKey(q))}`;
async function srchCacheGet(key) {
  try { if (typeof caches === "undefined" || !caches.default) return null; const r = await caches.default.match(key); return r ? await r.json() : null; } catch { return null; }
}
async function srchCachePut(key, v, ttl) {
  try { if (typeof caches === "undefined" || !caches.default) return; await caches.default.put(key, new Response(JSON.stringify(v), { headers: { "content-type": "application/json", "cache-control": "public, max-age=" + ttl } })); } catch {}
}
const srchIp = (req) => req.headers.get("cf-connecting-ip") || "0";

// GET /api/search?q=&c=  -> { q, country, currency, category, shops, notSearched }
async function apiSearch(req, env) {
  const sp = new URL(req.url).searchParams;
  const v = srchClean(sp.get("q")); if (v.error) return json({ error: v.error }, 400);
  const country = srchCountry(sp.get("c")); if (!country) return json({ error: "Choose South Africa or the UK." }, 400);
  if (!isE2E(req, env) && await rateLimit(env, srchIp(req), "search")) return json({ error: "Too many searches. Wait a minute and try again." }, 429);
  const plan = srchPlan(v.q, country);
  return json({ q: v.q, country, ...plan }, 200, { "cache-control": "public, max-age=300" });
}

// GET /api/search/shop?q=&c=&shop=  -> { shop, name, status, items }
// status: ok (items found), none, robots, blocked, busy, error
async function apiSearchShop(req, env, ctx) {
  const sp = new URL(req.url).searchParams;
  const v = srchClean(sp.get("q")); if (v.error) return json({ error: v.error }, 400);
  const country = srchCountry(sp.get("c")); if (!country) return json({ error: "Choose South Africa or the UK." }, 400);
  const shop = cmpShopById(sp.get("shop") || "");
  if (!shop || !srchPlan(v.q, country).shops.some((s) => s.id === shop.id)) return json({ error: "unknown shop" }, 400);
  const base = { shop: shop.id, name: shop.name };
  const key = srchCacheUrl(shop.id, country, v.q);
  const hit = await srchCacheGet(key);
  if (hit) return json({ ...hit, cached: true });
  if (!isE2E(req, env) && await cmpIpLimited(env, srchIp(req))) return json({ ...base, status: "busy", items: [] }, 429);
  const rb = await cmpRobotsOk(env, shop);
  if (rb === false) { const out = { ...base, status: "robots", items: [], checked_at: now() }; await srchCachePut(key, out, 6 * 3600); return json(out); }
  if (rb === "retry") return json({ ...base, status: "error", items: [] });
  if (await cmpShopBusy(env, shop)) return json({ ...base, status: "busy", items: [] });
  let list, status = "ok";
  try {
    list = await Promise.race([CMP_SEARCH[shop.kind](shop, v.q), new Promise((_, no) => setTimeout(() => no(new CmpError("timeout", "error")), SRCH_TIMEOUT))]);
  } catch (e) { status = e instanceof CmpError && e.kind === "blocked" ? "blocked" : "error"; }
  if (status !== "ok") return json({ ...base, status, items: [] });
  const items = srchFilter(v.q, shop, list);
  const out = { ...base, status: items.length ? "ok" : "none", items, checked_at: now() };
  const put = srchCachePut(key, out, SRCH_TTL);
  if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put;
  return json(out);
}
