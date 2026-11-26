// ---------- In-store flyer deals (printed Black Friday flyers) ----------
// Joined with compare.js and search.js at build time (build.py). Each flyer is built into the Worker from its
// JSON file in data/ (FLM_FLYER, PNP_FLYER, SPAR_FLYER, SHOPRITE_FLYER): the deals were typed from the printed flyers.
//   Food Lover's Market  data/flm-flyer-2026-11-23.json       Western Cape, 23-29 Nov 2026
//   Pick n Pay           data/pnp-flyer-2026-11-26.json       inland provinces, 26-29 Nov 2026 (Smart Shopper)
//   SPAR & TOPS          data/spar-flyer-2026-11-25.json      25-29 Nov 2026 (SPAR Rewards)
//   Shoprite             data/shoprite-flyer-2026-11-26.json  inland provinces, 26-29 Nov 2026; MoneyMarket phones to 6 Dec (Xtra Savings)
// No shop fetches and no D1 rows: search and compare read the lists in memory.
// We never change a price: "price" is the flyer price for the deal, "unit_price" is the price for one item.
//
// Auto-expiry: each deal shows only from 00:00 on its own valid_from to 23:59:59 on its own valid_to, South Africa
// time (UTC+2). After that, search and compare do not show it. A flyer with no live deal is not a searched shop.
const FLY_TZ_MS = 2 * 3600e3;   // South Africa: UTC+2, no summer time
const FLY_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// 2026-11-23 00:00 SAST = 2026-11-22T22:00:00Z; 2026-11-29 23:59:59.999 SAST = 2026-11-29T21:59:59.999Z
const flyDayStart = (d) => Date.parse(d + "T00:00:00Z") - FLY_TZ_MS;
const flyDayEnd = (d) => Date.parse(d + "T23:59:59.999Z") - FLY_TZ_MS;
const flmDayStart = flyDayStart, flmDayEnd = flyDayEnd;
// "valid 23–29 Nov" (or "valid 23 Nov–6 Dec")
function flyValidText(from, to) {
  const [, m1, d1] = from.split("-").map(Number), [, m2, d2] = to.split("-").map(Number);
  return m1 === m2 ? `valid ${d1}\u2013${d2} ${FLY_MONTHS[m2 - 1]}` : `valid ${d1} ${FLY_MONTHS[m1 - 1]}\u2013${d2} ${FLY_MONTHS[m2 - 1]}`;
}

// The flyers. "own": the shop's own brand (sold only there, so never a compare match).
const FLYERS = [
  { id: "flm", data: FLM_FLYER, home: "https://foodloversmarket.co.za/", own: /^food lovers?\b/ },
  { id: "pnpflyer", data: PNP_FLYER, home: "https://www.pnp.co.za/", own: /^(pnp|pick n pay|no name)\b/ },
  { id: "sparflyer", data: SPAR_FLYER, home: "https://www.spar.co.za/", own: /^(spar|tops)\b/ },
  { id: "shopriteflyer", data: SHOPRITE_FLYER, home: "https://www.shoprite.co.za/", own: /^(shoprite|ritebrand)\b/ },
].map((f) => ({ ...f, shop: f.data.shop, region: f.data.region, fine: f.data.fine_print || null, site: f.data.shop + " site",
  label: `${f.data.shop} (${f.data.region} flyer, ${flyValidText(f.data.valid_from, f.data.valid_to)})` }));
const flyerById = (id) => FLYERS.find((f) => f.id === id) || null;
const flyFrom = (f, d) => d.valid_from || f.data.valid_from;
const flyTo = (f, d) => d.valid_to || f.data.valid_to;
const flyDealStart = (f, d) => flyDayStart(flyFrom(f, d));
const flyDealEnd = (f, d) => flyDayEnd(flyTo(f, d));
// One deal is live from the start of its first day to the end of its last day (SAST).
const flyDealLive = (f, d, t = now()) => t >= flyDealStart(f, d) && t <= flyDealEnd(f, d);
const flyLive = (f, t = now()) => (f ? f.data.deals.filter((d) => flyDealLive(f, d, t)) : []);
const flyerActive = (f, t = now()) => flyLive(f, t).length > 0;
// Seconds until the next live deal of this flyer stops (0 when none shows), so no answer is cached past an end.
function flyerSecondsLeft(f, t = now()) {
  const live = flyLive(f, t);
  if (!live.length) return 0;
  return Math.max(0, Math.floor((Math.min(...live.map((d) => flyDealEnd(f, d))) - t) / 1000));
}
// The label of one deal: its own dates (Shoprite MoneyMarket phones run longer than the flyer).
const flyLabel = (f, d) => `${f.shop} (${f.region} flyer, ${flyValidText(flyFrom(f, d), flyTo(f, d))})`;

const FLY_FLM = flyerById("flm");
const FLM_ID = "flm";
const FLM_HOME = FLY_FLM.home;
const FLM_FROM = flyDayStart(FLM_FLYER.valid_from);
const FLM_UNTIL = flyDayEnd(FLM_FLYER.valid_to);
const flmActive = (t = now()) => flyerActive(FLY_FLM, t);
const flmSecondsLeft = (t = now()) => flyerSecondsLeft(FLY_FLM, t);
const flmValidText = () => flyValidText(FLM_FLYER.valid_from, FLM_FLYER.valid_to);
const FLM_LABEL = FLY_FLM.label;
const flmR = (n) => "R" + (Math.round(n * 100) / 100).toFixed(2);

// A per-customer limit in plain words: "max 5 deals" -> "Max 5 deals per customer".
function flyLimit(s) {
  s = String(s || "").trim();
  if (!s) return null;
  if (/^max\b/i.test(s)) { s = "Max" + s.slice(3); if (!/per customer/i.test(s)) s += " per customer"; }
  return s;
}
// The deal in plain words, from the flyer's own text. A multi-buy never reads as a price for one item.
//   deal:  "10 for R100 (R10.00 each)", "R29.99 each", "R59.00 per kg", "R99.00 for the combo", "From R62.00"
//   need:  "R10.00 each when you buy 10 (R100 total)" (multi-buys only)
//   limit: "2 deals per customer", "Max 5 deals per customer" (when the flyer says so)
function flmDealText(d) {
  let t = String(d.deal_text || "").trim(), paren = null;
  const pm = t.match(/^(.*?)\s*\(([^)]*)\)$/);
  if (pm && /customer|\bmax\b|\bdeals?\b/i.test(pm[2])) { t = pm[1].trim(); paren = pm[2]; }
  const limit = flyLimit(paren) || flyLimit(d.limit);
  const m = t.match(/^(any\s+)?(\d+)\s+for\s+R\s?(\d+(?:\.\d+)?)$/i);
  if (m && +m[2] > 1) {
    const any = !!m[1], n = +m[2], total = "R" + m[3], each = flmR(d.unit_price);
    return { deal: `${any ? "Any " : ""}${n} for ${total} (${each} each)`, need: `${each} each when you buy ${any ? "any " : ""}${n} (${total} total)`, limit, unit: "each", multi: true };
  }
  if (/^per\s+(kg|pack|deal)$/i.test(t)) { const u = t.split(/\s+/)[1].toLowerCase(); return { deal: `${flmR(d.price)} per ${u}`, need: null, limit, unit: u, multi: false }; }
  if (/^combo$/i.test(t) || d.is_combo) return { deal: d.price_basis ? `${flmR(d.price)} ${d.price_basis} (combo)` : `${flmR(d.price)} for the combo`, need: null, limit, unit: "combo", multi: false };
  if (/^from$/i.test(t)) return { deal: `From ${flmR(d.price)}`, need: null, limit, unit: "each", multi: false };
  return { deal: `${flmR(d.price)} each`, need: null, limit, unit: "each", multi: false };
}
// Loyalty card badges, only from the flyer's own marks.
function flyBadges(d) {
  const b = [];
  if (d.smart_shopper) b.push("Smart Shopper");
  if (d.rewards_card) b.push("SPAR Rewards");
  if (d.xtra_savings) b.push("Xtra Savings");
  return b;
}
// The flyer's normal price. On a multi-buy it is the price for all items: "Normal price R43.98 for 2".
const flyRegular = (d) => (d.regular_price > 0 ? `Normal price ${flmR(d.regular_price)}${d.qty > 1 ? ` for ${d.qty}` : ""}` : null);
// A short note for the buyer (only notes that help: not notes about how the flyer was typed).
function flyNote(d) {
  if (/MoneyMarket/i.test(String(d.note || ""))) return "MoneyMarket deal. You must pair and activate a SIM in store. Only at selected stores.";
  if (/^from$/i.test(String(d.deal_text || "").trim())) return "The price changes by variant. This is the lowest price.";
  return null;
}

// One row for search and compare: only values from the flyer data.
function flyItem(f, d) {
  const x = flmDealText(d);
  return { id: d.id, title: d.title, price: d.unit_price, total: d.price, qty: d.qty, currency: "ZAR", url: f.home, flyer: true,
    deal: x.deal, need: x.need, limit: x.limit, unit: x.unit, multi: x.multi, label: flyLabel(f, d), region: f.region,
    valid_from: flyFrom(f, d), valid_to: flyTo(f, d), until: flyDealEnd(f, d),
    shop: f.shop, site: f.site, fine: f.fine, badges: flyBadges(d), regular: flyRegular(d), note: flyNote(d) };
}
const flmItem = (d) => flyItem(FLY_FLM, d);

// Search: deals whose name (with the brand) has every search word; lowest price for one item first.
// Expired deals and deals not started yet are never in the answer.
function flyerSearch(f, q, t = now()) {
  const words = srchWords(q);
  if (!f || !words.length) return [];
  const out = [];
  for (const d of flyLive(f, t)) {
    const name = d.brand && !cmpNorm(d.title).includes(cmpNorm(d.brand)) ? d.brand + " " + d.title : d.title;
    if (srchHas(words, name)) out.push(flyItem(f, d));
  }
  return out.sort((a, b) => a.price - b.price || a.title.localeCompare(b.title)).slice(0, SRCH_PER_SHOP);
}
const flmSearch = (q, t = now()) => flyerSearch(FLY_FLM, q, t);
// The flyers with a live deal for these words (South Africa only), in FLYERS order.
const flyersFor = (q, t = now()) => FLYERS.filter((f) => flyerSearch(f, q, t).length > 0);
// Do the matching deals name groceries (not only appliances or phones)?
const FLY_NOT_GROCERY = /appliance|home &|moneymarket/i;
const flyersGrocery = (q, t = now()) => FLYERS.some((f) => flyLive(f, t).some((d) => !FLY_NOT_GROCERY.test(d.section || "") && flyerSearch(f, q, t).some((x) => x.id === d.id)));

// ---------- compare: the same product on the flyer (strict) ----------
// Only branded single items (no combos, no fresh or butchery items without a brand, not the shop's own brand).
// Same brand, the same pack size (one of the flyer's sizes) and the same number in a pack, and no other words:
// every naming word of the checked product must be on the flyer line ("Chopped or Peeled" covers both).
const FLM_OWN = /^food lovers?\b/;
const FLM_FILL = new Set([...CMP_GROCERY_FILLER, "assorted", "flavours", "flavour", "variety", "in", "and", "or", "with", "the", "of", "a", "packs", "pack", "pk", "bottles", "punnet", "punnets", "excl", "x"]);
const flmSizeRe = /\d+(?:[.,]\d+)?\s*(?:kg|g|ml|l)\b/i;
// "18s", "2s", "4s" on a flyer = the number in a pack
function flmPack(title, A) {
  const s = new Set(A.pack);
  for (const t of cmpWords(title)) { const m = t.match(/^(\d+)s$/); if (m) s.add(+m[1]); }
  return s.size ? s : new Set([1]);
}
const flmNameWords = (title, brandWords) => cmpWords(title.replace(/\([^)]*\)/g, " "))
  .filter((w) => !brandWords.includes(w) && !FLM_FILL.has(w) && !CMP_STOP.has(w) && !/^\d+(?:\.\d+)?(kg|g|ml|l|lt|ltr|litres?|liters?|cl|pcs|pack|pk|s)?$/.test(w) && !/^[-+%/]+$/.test(w));
// The flyer line as one or more products: "Sunlight Washing Powder 2 kg or Auto Liquid 1.5 L" is two.
function flmVariants(d) {
  const clean = String(d.title).replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  const parts = clean.split(/\s+or\s+/i);
  const brand = String(d.brand || "");
  if (parts.length > 1 && parts.every((p) => flmSizeRe.test(p))) return parts.map((p, i) => (i === 0 || cmpNorm(p).startsWith(cmpNorm(brand)) ? p : brand + " " + p));
  return [clean];
}
// Words of a flyer line next to "or" or a comma are the choices ("Chopped or Peeled"): not needed.
function flmChoiceWords(variant, brandWords) {
  const segs = cmpNorm(variant).split(/\s*,\s*|\s+or\s+/);
  const req = [], opt = new Set();
  let plain = false;   // a choice with no naming words ("Original or Tangy"): the plain product is one of the choices
  segs.forEach((seg, i) => {
    const w = flmNameWords(seg, brandWords);
    if (!w.length) { plain = true; return; }
    if (segs.length > 1) { if (i < segs.length - 1) opt.add(w[w.length - 1]); if (i > 0) opt.add(w[0]); }
    for (const x of w) if (!opt.has(x)) req.push(x);
  });
  return { req, opt, plain };
}
const flmSame = (a, b) => a === b || a + "s" === b || b + "s" === a || a + "es" === b || b + "es" === a;
const flmIn = (w, list) => list.some((x) => flmSame(w, x));

// Is the checked product (compare identity: title, brand) the same as this flyer deal? null or the reason.
function flmMatchWhy(src, d, own = FLM_OWN) {
  if (!d || d.is_combo || !d.brand) return "no brand or a combo";
  const db = cmpBrand(d.brand);
  if (!db || own.test(db) || /\//.test(d.brand)) return "own brand";
  const bw = cmpWords(d.brand);
  const sw = cmpWords(src.title), sset = new Set(sw);
  const joined = new Set(sw.map((w, i) => w + (sw[i + 1] || "")));
  const brandIn = bw.every((w) => sset.has(w)) || joined.has(bw.join("")) || (src.brand && cmpWords(src.brand).join(" ") === bw.join(" "));
  if (!brandIn) return "other brand";
  const A = cmpAttrs(src.title), sizes = A.ml.size + A.g.size;
  if (sizes !== 1) return sizes ? "more than one size" : "no pack size";
  const sp = flmPack(src.title, A);
  let why = "different size";
  for (const v of flmVariants(d)) {
    const B = cmpAttrs(v);
    const sizeOk = A.ml.size ? [...A.ml].every((x) => B.ml.has(x)) : [...A.g].every((x) => B.g.has(x));
    if (!sizeOk) continue;
    if (!setEq(sp, flmPack(v, B))) { why = "different pack"; continue; }
    const { req, opt, plain } = flmChoiceWords(v, bw);
    const all = [...req, ...opt];
    const dJoined = all.map((w, i) => w + (all[i + 1] || ""));
    // the checked product's naming words, joined words split back ("weetbix" = "weet bix")
    const s = flmNameWords(src.title, bw).filter((w) => !(src.brand && cmpWords(src.brand).includes(w)));
    const extra = s.filter((w) => !flmIn(w, all) && !dJoined.includes(w));
    if (extra.length) { why = "other words: " + extra.slice(0, 3).join(", "); continue; }
    const hasReq = (w) => s.some((x) => flmSame(x, w)) || s.some((x) => dJoined.includes(x) && x.startsWith(w));
    if (req.length && !s.some((x) => flmIn(x, req) || (dJoined.includes(x) && req.some((r) => x.startsWith(r))))) { why = "name too short"; continue; }
    // the first naming word or the last one (the kind of product: Oats, Rice, Mayonnaise) must be there
    if (req.length && !hasReq(req[0]) && !hasReq(req[req.length - 1])) { why = "name too short"; continue; }
    if (opt.size && !plain && !s.some((x) => flmIn(x, [...opt]))) { why = "which kind"; continue; }
    return null;
  }
  return why;
}
// The best flyer deal for a checked product, or null. A price far from the checked price is not trusted.
function flyerCompare(f, src, t = now()) {
  if (!f || !src || !src.title) return null;
  let best = null;
  for (const d of flyLive(f, t)) {
    if (flmMatchWhy(src, d, f.own)) continue;
    if (src.price && (d.unit_price < src.price * 0.3 || d.unit_price > src.price * 3)) continue;
    if (!best || d.unit_price < best.unit_price) best = d;
  }
  return best ? flyItem(f, best) : null;
}
const flmCompare = (src, t = now()) => flyerCompare(FLY_FLM, src, t);
// GET /api/compare/shop?shop=<flyer id>: the flyer answer (no cache, no D1 rows, no price history: it is not a shop page).
function flyerCompareAnswer(f, id) {
  const shop = cmpShopById(f.id);
  if (!flyerActive(f)) return { shop: f.id, name: shop.name, status: "skipped", checked_at: now(), match: null };
  const it = flyerCompare(f, id);
  const match = it ? { title: it.title, price: it.price, was: null, currency: "ZAR", url: f.home, in_stock: true, level: "flyer", flyer: { deal: it.deal, need: it.need, limit: it.limit, qty: it.qty, total: it.total, label: it.label, region: it.region, valid_to: it.valid_to, until: it.until, shop: it.shop, site: it.site, fine: it.fine, badges: it.badges, regular: it.regular, note: it.note } } : null;
  return { shop: f.id, name: shop.name, status: match ? "match" : "none", match, checked_at: now(), message: null, ai: null, flyer: true };
}
const flmCompareAnswer = (id) => flyerCompareAnswer(FLY_FLM, id);
