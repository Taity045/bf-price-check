// ---------- Food Lover's Market flyer deals (in-store specials from a printed flyer) ----------
// Joined with compare.js and search.js at build time (build.py). FLM_FLYER is built into the Worker from
// data/flm-flyer-2026-11-23.json: the deals were typed from the 8 pages of the Western Cape Black Friday flyer.
// No shop fetches and no D1 rows: search and compare read the list in memory.
// We never change a price: "price" is the flyer price for the deal, "unit_price" is the price for one item.
//
// The deals show only from the start of the first day to the end of the last day, South Africa time
// (UTC+2). After that, search and compare do not show them, and Food Lover's Market is not a searched shop.

const FLM_ID = "flm";
const FLM_HOME = "https://foodloversmarket.co.za/";
const FLM_TZ_MS = 2 * 3600e3;   // South Africa: UTC+2, no summer time
const FLM_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// 2026-11-23 00:00 SAST = 2026-11-22T22:00:00Z; 2026-11-29 23:59:59.999 SAST = 2026-11-29T21:59:59.999Z
const flmDayStart = (d) => Date.parse(d + "T00:00:00Z") - FLM_TZ_MS;
const flmDayEnd = (d) => Date.parse(d + "T23:59:59.999Z") - FLM_TZ_MS;
const FLM_FROM = flmDayStart(FLM_FLYER.valid_from);
const FLM_UNTIL = flmDayEnd(FLM_FLYER.valid_to);
const flmActive = (t = now()) => t >= FLM_FROM && t <= FLM_UNTIL;
// Seconds until the deals stop (0 when they do not show), so no answer is cached past the end.
const flmSecondsLeft = (t = now()) => (flmActive(t) ? Math.max(0, Math.floor((FLM_UNTIL - t) / 1000)) : 0);

// "valid 23–29 Nov" (or "valid 28 Nov–2 Dec")
function flmValidText() {
  const [, m1, d1] = FLM_FLYER.valid_from.split("-").map(Number), [, m2, d2] = FLM_FLYER.valid_to.split("-").map(Number);
  return m1 === m2 ? `valid ${d1}\u2013${d2} ${FLM_MONTHS[m2 - 1]}` : `valid ${d1} ${FLM_MONTHS[m1 - 1]}\u2013${d2} ${FLM_MONTHS[m2 - 1]}`;
}
const FLM_LABEL = `Food Lover's Market (${FLM_FLYER.region} flyer, ${flmValidText()})`;
const flmR = (n) => "R" + (Math.round(n * 100) / 100).toFixed(2);

// The deal in plain words, from the flyer's own text. A multi-buy never reads as a price for one item.
//   deal:  "10 for R100 (R10.00 each)", "R29.99 each", "R59.00 per kg", "R99.00 for the combo"
//   need:  "R10.00 each when you buy 10 (R100 total)" (multi-buys only)
//   limit: "2 deals per customer" (when the flyer says so)
function flmDealText(d) {
  const t = String(d.deal_text || "").trim();
  const m = t.match(/^(any\s+)?(\d+)\s+for\s+R\s?(\d+(?:\.\d+)?)(?:\s*\((.+)\))?$/i);
  if (m && +m[2] > 1) {
    const any = !!m[1], n = +m[2], total = "R" + m[3], each = flmR(d.unit_price);
    return { deal: `${any ? "Any " : ""}${n} for ${total} (${each} each)`, need: `${each} each when you buy ${any ? "any " : ""}${n} (${total} total)`, limit: m[4] ? m[4].trim() : null, unit: "each", multi: true };
  }
  if (/^per\s+(kg|pack|deal)$/i.test(t)) { const u = t.split(/\s+/)[1].toLowerCase(); return { deal: `${flmR(d.price)} per ${u}`, need: null, limit: null, unit: u, multi: false }; }
  if (/^combo$/i.test(t) || d.is_combo) return { deal: `${flmR(d.price)} for the combo`, need: null, limit: null, unit: "combo", multi: false };
  return { deal: `${flmR(d.price)} each`, need: null, limit: null, unit: "each", multi: false };
}

// One row for search and compare: only values from the flyer data.
function flmItem(d) {
  const x = flmDealText(d);
  return { id: d.id, title: d.title, price: d.unit_price, total: d.price, qty: d.qty, currency: "ZAR", url: FLM_HOME, flyer: true,
    deal: x.deal, need: x.need, limit: x.limit, unit: x.unit, multi: x.multi, label: FLM_LABEL, region: FLM_FLYER.region,
    valid_from: FLM_FLYER.valid_from, valid_to: FLM_FLYER.valid_to, until: FLM_UNTIL };
}

// Search: deals whose name (with the brand) has every search word; lowest price for one item first.
function flmSearch(q, t = now()) {
  if (!flmActive(t)) return [];
  const words = srchWords(q);
  if (!words.length) return [];
  const out = [];
  for (const d of FLM_FLYER.deals) {
    const name = d.brand && !cmpNorm(d.title).includes(cmpNorm(d.brand)) ? d.brand + " " + d.title : d.title;
    if (srchHas(words, name)) out.push(flmItem(d));
  }
  return out.sort((a, b) => a.price - b.price || a.title.localeCompare(b.title)).slice(0, SRCH_PER_SHOP);
}

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
function flmMatchWhy(src, d) {
  if (!d || d.is_combo || !d.brand) return "no brand or a combo";
  const db = cmpBrand(d.brand);
  if (!db || FLM_OWN.test(db) || /\//.test(d.brand)) return "own brand";
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
function flmCompare(src, t = now()) {
  if (!flmActive(t) || !src || !src.title) return null;
  let best = null;
  for (const d of FLM_FLYER.deals) {
    if (flmMatchWhy(src, d)) continue;
    if (src.price && (d.unit_price < src.price * 0.3 || d.unit_price > src.price * 3)) continue;
    if (!best || d.unit_price < best.unit_price) best = d;
  }
  return best ? flmItem(best) : null;
}
// GET /api/compare/shop?shop=flm: the flyer answer (no cache, no D1 rows, no price history: it is not a shop page).
function flmCompareAnswer(id) {
  const shop = cmpShopById(FLM_ID);
  if (!flmActive()) return { shop: FLM_ID, name: shop.name, status: "skipped", checked_at: now(), match: null };
  const it = flmCompare(id);
  const match = it ? { title: it.title, price: it.price, was: null, currency: "ZAR", url: FLM_HOME, in_stock: true, level: "flyer", flyer: { deal: it.deal, need: it.need, limit: it.limit, qty: it.qty, total: it.total, label: it.label, region: it.region, valid_to: it.valid_to, until: it.until } } : null;
  return { shop: FLM_ID, name: shop.name, status: match ? "match" : "none", match, checked_at: now(), message: null, ai: null, flyer: true };
}
