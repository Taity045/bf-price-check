// ---------- Deal Score (0-100) and the action: one pure function for the server and the page ----------
// build.py joins this file to the Worker AND writes it into public/result.js (/*DEAL_SCORE*/), so the
// score on the page and the score in /api/check come from the same code. No network, no AI, no guesses:
// only the history points we have and the shop matches that compare found.
//
// dealScore({ P, W, C, pts, now, cmp }) -> { score, action, cls, reasons, why }
//   P, W, C  today's price, the shop's "was" price (or null), the currency
//   pts      older prices in the same currency (more than 1 day old), [{ t, price }]
//   fmt      optional money format (the page passes its own, so prices look the same as on the page)
//   cmp      null, or { done, total, matches: [{ name, price, in_stock, flyerQty }] } from compare
//   score    0-100, or null when we have neither 3 older prices nor a shop match (never a fake score)
//   action   "Buy now" | "Buy elsewhere" | "Wait" | "Fair price" | "Check first"
const DS_DAY = 864e5;
const DS_MIN_PTS = 3;                       // older prices for a history score
const DS_HIKE_DAYS = 45;                    // "recent" for a price rise before Black Friday
// A cheaper shop counts when it saves at least 3 % or at least R20 (2.00 in pounds), and never less than R5 (0.50).
const dsMinSave = (C) => (C === "ZAR" ? 5 : 0.5);
const dsBigSave = (C) => (C === "ZAR" ? 20 : 2);
const dsMove = (a, b, C) => Math.abs(b - a) >= Math.max(0.05 * a, C === "ZAR" ? 5 : 0.5);
const dsMedian = (a) => { const s = [...a].sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const dsMoney = (v, C) => {
  const sym = C === "ZAR" ? "R" : C === "GBP" ? "£" : C === "EUR" ? "€" : C === "USD" ? "$" : "";
  const n = Math.round(v * 100) / 100, s = (Number.isInteger(n) ? n.toFixed(0) : n.toFixed(2)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return sym ? sym + s : s + " " + (C || "");
};
const dsPct = (x) => Math.round(Math.abs(x) * 100) + "%";
const dsClamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
function dsCompare(P, C, cmp) {
  if (!cmp || !(P > 0)) return null;
  const inStock = (cmp.matches || []).filter((m) => m && m.in_stock && m.price > 0);
  const ok = inStock.filter((m) => !(m.flyerQty > 1));        // a multi-buy flyer deal is not a price for one item
  const save = (m) => Math.round((P - m.price) * 100) / 100;
  const real = (m) => save(m) >= dsMinSave(C) && (save(m) / P >= 0.03 || save(m) >= dsBigSave(C));
  const byPrice = (a, b) => a.price - b.price;
  const cheaper = ok.filter(real).sort(byPrice);
  const small = ok.filter((m) => !real(m) && save(m) >= dsMinSave(C)).sort(byPrice)[0] || null;
  const multi = inStock.filter((m) => m.flyerQty > 1 && save(m) >= dsMinSave(C)).sort(byPrice)[0] || null;
  const dearer = ok.filter((m) => m.price - P >= dsMinSave(C)).length;
  const same = ok.length - cheaper.length - dearer;
  return { n: ok.length, best: cheaper[0] || null, more: cheaper.length - 1, small, multi, dearer, same, done: cmp.done >= cmp.total, total: cmp.total || 0 };
}
function dealScore(o = {}) {
  const d = dsRaw(o);
  // the score agrees with the action: "Buy elsewhere" and "Wait" stay under 50, "Buy now" is 65 or more
  if (d.score != null) {
    if (d.action === "Buy elsewhere" || d.action === "Wait") d.score = Math.min(d.score, 49);
    else if (d.action === "Buy now") d.score = Math.max(d.score, 65);
  }
  return d;
}
function dsRaw({ P, W = null, C, pts = [], now = Date.now(), cmp = null, fmt = null } = {}) {
  const M = fmt || dsMoney;
  const out = { score: null, action: "Check first", cls: "unk", reasons: [], why: {} };
  if (!(P > 0) || !C) { out.reasons.push("We need today's price to give a score."); return out; }
  const h = (pts || []).filter((x) => x && x.price > 0 && x.t < now - DS_DAY).sort((a, b) => a.t - b.t);
  const x = dsCompare(P, C, cmp);
  let s = 50, hist = null;
  if (h.length >= DS_MIN_PTS) {
    const pr = h.map((p) => p.price), low = Math.min(...pr), med = dsMedian(pr);
    const p90 = h.filter((p) => p.t >= now - 90 * DS_DAY).map((p) => p.price), high90 = p90.length >= 2 ? Math.max(...p90) : Math.max(...pr);
    const vsMed = (med - P) / med;
    const cheaper = P < med && dsMove(med, P, C), dearer = P > med && dsMove(med, P, C);
    const atLow = P <= low * 1.005;
    // a rise in the last 45 days: the highest recent price is 5 % over the usual price before it, and today is not under that usual price
    const old = h.filter((p) => p.t < now - DS_HIKE_DAYS * DS_DAY), recent = h.filter((p) => p.t >= now - DS_HIKE_DAYS * DS_DAY);
    const oldMed = old.length >= 2 ? dsMedian(old.map((p) => p.price)) : null;
    const hikeTop = recent.length ? Math.max(...recent.map((p) => p.price)) : null;
    const hike = oldMed != null && hikeTop != null && hikeTop > oldMed && dsMove(oldMed, hikeTop, C) && P > oldMed && dsMove(oldMed, P, C);
    const inflated = !!(W && W > P && W > high90 * 1.03 && !cheaper);
    s += dsClamp(vsMed * 200, -40, 30);
    if (atLow) s += 15; else if (P <= low * 1.05) s += 7;
    if (hike) s -= 10;
    if (inflated) s -= 10;
    // few points: less sure, so the score stays nearer the middle
    const sure = Math.min(1, 0.7 + (h.length - DS_MIN_PTS) * 0.06);
    s = 50 + (s - 50) * sure;
    hist = { n: h.length, low, med, atLow, cheaper, dearer, hike, oldMed, inflated, vsMed };
    out.why.hist = hist;
  }
  if (x) {
    out.why.cmp = x;
    if (x.best) s -= dsClamp(((P - x.best.price) / P) * 300, 15, 45);
    else if (x.n) s += Math.min(10, 4 * x.dearer + 2 * x.same);
  }
  const haveCmp = !!(x && (x.best || x.n));
  if (!hist && !haveCmp) {
    // honest: no score from nothing
    const n = h.length;
    out.reasons.push(n ? `We have only ${n} older price${n === 1 ? "" : "s"}. We need ${DS_MIN_PTS} to give a score.` : "Not enough price history yet. We need 3 older prices to give a score.");
    if (x && x.done && x.total) out.reasons.push(`No other shop sells the exact same product in stock.`);
    else if (cmp && !x?.done) out.reasons.push("We are still checking other shops.");
    return out;
  }
  out.score = Math.round(dsClamp(s, 0, 100));
  const r = out.reasons;
  if (x && x.best) {
    const save = Math.round((P - x.best.price) * 100) / 100;
    out.action = "Buy elsewhere"; out.cls = "bad";
    r.push(`${x.best.name} sells the same product for ${M(x.best.price, C)}. You save ${M(save, C)} (${dsPct(save / P)}).`);
    if (x.more > 0) r.push(`${x.more} more shop${x.more === 1 ? " is" : "s are"} also cheaper.`);
    return out;
  }
  if (hist) {
    const { med, low, n } = hist;
    if (hist.hike) {
      out.action = "Wait"; out.cls = "bad";
      r.push(`The price went up in the last ${DS_HIKE_DAYS} days. Before that, it usually cost ${M(hist.oldMed, C)}.`);
    } else if (hist.dearer) {
      out.action = "Wait"; out.cls = "bad";
      r.push(`Today's price is ${dsPct(hist.vsMed)} more than the usual ${M(med, C)}.`);
    } else if (hist.inflated) {
      out.action = "Fair price"; out.cls = "meh";
      r.push(`The "was" price of ${M(W, C)} is higher than all prices we found in 90 days. The real price did not go down.`);
    } else if (hist.cheaper && (hist.atLow || hist.vsMed >= 0.1)) {
      out.action = "Buy now"; out.cls = "good";
      r.push(hist.atLow ? `This is the lowest price we found in ${n} older prices. It is ${dsPct(hist.vsMed)} less than the usual ${M(med, C)}.`
        : `Today's price is ${dsPct(hist.vsMed)} less than the usual ${M(med, C)}. The lowest we found is ${M(low, C)}.`);
    } else {
      out.action = "Fair price"; out.cls = "meh";
      r.push(hist.cheaper ? `Today's price is ${dsPct(hist.vsMed)} less than the usual ${M(med, C)}, but it was ${M(low, C)} before.`
        : `Today's price is close to the usual ${M(med, C)}. It is not a special deal.`);
    }
  } else {
    out.action = "Fair price"; out.cls = "meh";
    r.push(`Not enough price history yet. We compare only with other shops.`);
  }
  if (x && x.small) r.push(`${x.small.name} is ${M(Math.round((P - x.small.price) * 100) / 100, C)} cheaper. The saving is small.`);
  else if (x && x.multi) r.push(`${x.multi.name} is cheaper only when you buy ${x.multi.flyerQty}.`);
  else if (x && x.n) r.push(`No cheaper exact match at ${x.n} other shop${x.n === 1 ? "" : "s"} that sell${x.n === 1 ? "s" : ""} it.`);
  if (x && !x.done && r.length < 2) r.push("We are still checking other shops.");
  return out;
}
