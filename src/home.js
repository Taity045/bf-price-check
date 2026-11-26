// ---------- Home page: "Today's genuine deals" (GET /api/home) ----------
// Joined with the other files at build time (build.py). Only real data, never a guess:
//   1. Price drops from our own checks (D1 table verdicts): the verdict is "Real deal" (lowest price in our history)
//      or "Decent deal" (clearly under the usual price), the shop price was checked in the last 3 days with no error,
//      and the saved verdict price is the same as the last checked price.
//   2. Live flyer deals (src/flyer.js) where the printed flyer gives a normal price that is higher than the deal price.
// One small D1 read at most every HOME_TTL per Worker instance (memory), plus the Cache API on the custom domain.
// No D1 writes. Expired flyer deals never show: the cache never lives past the end of a shown deal.
const HOME_TTL = 5 * 60e3;              // ms: one answer is kept this long
const HOME_FRESH = 3 * 864e5;           // ms: a price drop shows only when the shop price was checked this recently
const HOME_DROPS = 12;                  // price drops in the answer (at most)
const HOME_FLYER = 12;                  // flyer deals in the answer (at most)
const HOME_PER_SHOP = 8;                // flyer deals per shop (so one shop does not fill the list)
const HOME_CACHE_URL = "https://home-deals.cache/v1";
const HOME_LABEL = { "Real deal": "Lowest price we found", "Decent deal": "Lower than usual" };
let HOME_MEM = null;                    // { at, exp, val }

const homeCc = (cur) => (cur === "ZAR" ? "ZA" : cur === "GBP" ? "GB" : null);
const homeRound = (n) => Math.round(n * 100) / 100;

// Price drops from D1. Every number comes from the verdicts row: price, usual (median) price and how many older prices.
async function homeDrops(env, t = now()) {
  if (!env || !env.DB) return [];
  try {
    const r = await env.DB.prepare(`SELECT v.url AS url, v.host AS host, v.title AS title, v.verdict AS verdict, v.price AS price, v.currency AS currency,
        v.low AS low, v.med AS med, v.n AS n, tr.last_checked AS checked
      FROM verdicts v JOIN tracked tr ON tr.url = v.url
      WHERE v.verdict IN ('Real deal', 'Decent deal') AND COALESCE(v.archived, 0) = 0 AND v.price > 0 AND v.med > v.price
        AND v.currency IN ('ZAR', 'GBP') AND v.title IS NOT NULL AND v.title != ''
        AND tr.last_status = 'ok' AND tr.last_checked >= ?
        AND v.price = (SELECT c.price FROM checks c WHERE c.url = v.url AND c.price IS NOT NULL ORDER BY c.ts DESC LIMIT 1)
      ORDER BY (v.med - v.price) / v.med DESC LIMIT ?`).bind(t - HOME_FRESH, HOME_DROPS).all();
    return (r.results || []).map((x) => homeDropItem(x)).filter(Boolean);
  } catch { return []; }
}
function homeDropItem(x) {
  const cc = homeCc(x.currency), label = HOME_LABEL[x.verdict];
  if (!cc || !label || !(x.price > 0) || !(x.med > x.price)) return null;
  let shop = x.host;
  try { shop = shopName(x.host); } catch {}
  return { kind: "drop", cc, shop, title: String(x.title).slice(0, 140), price: x.price, currency: x.currency, label,
    good: x.verdict === "Real deal", usual: homeRound(x.med), saving: homeRound(x.med - x.price), pct: Math.round(((x.med - x.price) / x.med) * 100),
    n: x.n || 0, checked: x.checked, href: "/?u=" + encodeURIComponent(x.url) };
}

// Live flyer deals with a printed normal price above the deal price. The saving is the flyer's own numbers.
function homeFlyer(t = now()) {
  const out = [];
  for (const f of FLYERS) {
    const rows = flyLive(f, t).filter((d) => d.price > 0 && d.unit_price > 0 && d.regular_price > d.price)
      .map((d) => ({ f, d, saving: homeRound(d.regular_price - d.price) }))
      .sort((a, b) => b.saving - a.saving || a.d.title.localeCompare(b.d.title)).slice(0, HOME_PER_SHOP);
    out.push(...rows);
  }
  return out.sort((a, b) => b.saving - a.saving || a.d.title.localeCompare(b.d.title)).slice(0, HOME_FLYER).map(({ f, d, saving }) => {
    const x = flmDealText(d);
    return { kind: "flyer", cc: "ZA", shop: f.shop, title: d.title, price: d.price, currency: "ZAR", qty: d.qty || 1, deal: x.deal,
      limit: x.limit, badges: flyBadges(d), regular: d.regular_price, saving, pct: Math.round((saving / d.regular_price) * 100),
      label: "Flyer deal", valid: flyValidText(flyFrom(f, d), flyTo(f, d)), region: f.region, until: flyDealEnd(f, d),
      href: "/?q=" + encodeURIComponent(d.title).replace(/%20/g, "+") + "&c=ZA" };
  });
}

// The whole answer: price drops first (our own price history), then flyer deals.
async function homeDeals(env, t = now()) {
  const [drops, flyer] = [await homeDrops(env, t), homeFlyer(t)];
  const ends = flyer.map((x) => x.until).filter((u) => u > t);
  const exp = Math.min(t + HOME_TTL, ...ends);
  return { deals: drops.concat(flyer), drops: drops.length, flyer: flyer.length, updated_at: t, expires_at: exp };
}

async function apiHome(req, env, ctx) {
  const t = now();
  if (HOME_MEM && HOME_MEM.exp > t) return homeJson(HOME_MEM.val, t);
  const cache = typeof caches !== "undefined" && caches.default ? caches.default : null;
  if (cache && !isE2E(req, env)) {
    try {
      const hit = await cache.match(HOME_CACHE_URL);
      if (hit) { const val = await hit.json(); if (val && val.expires_at > t) { HOME_MEM = { exp: val.expires_at, val }; return homeJson(val, t); } }
    } catch {}
  }
  const val = await homeDeals(env, t);
  HOME_MEM = { exp: val.expires_at, val };
  if (cache) {
    const secs = Math.max(1, Math.floor((val.expires_at - t) / 1000));
    try { ctx.waitUntil(cache.put(HOME_CACHE_URL, new Response(JSON.stringify(val), { headers: { "content-type": "application/json", "cache-control": "public, max-age=" + secs } }))); } catch {}
  }
  return homeJson(val, t);
}
// Live deals only: a flyer deal that ended since the answer was made is dropped here too.
function homeJson(val, t) {
  const deals = val.deals.filter((x) => !x.until || x.until > t);
  const secs = Math.max(0, Math.min(300, Math.floor((val.expires_at - t) / 1000)));
  return json({ ...val, deals }, 200, { "cache-control": "public, max-age=" + secs });
}
const homeMemReset = () => { HOME_MEM = null; };

// ---------- the deal cards, written into the home page (no layout shift, no extra request) ----------
// Every deal for both countries is in the page; the page shows the ones for the chosen country (data-cc), 4 at first.
const HOME_FIRST = 4;
const HOME_LOC = { ZAR: "en-ZA", GBP: "en-GB" };
function homeMoney(v, cur) {   // same as money() on the page
  try { return new Intl.NumberFormat(HOME_LOC[cur] || "en-GB", { style: "currency", currency: cur, ...(Number.isInteger(v) ? { minimumFractionDigits: 0 } : {}) }).format(v); }
  catch { return cur + " " + Number(v).toFixed(2); }
}
const homeAgo = (checked, t) => { const d = Math.floor((t - checked) / 864e5); return d <= 0 ? "Checked today" : d === 1 ? "Checked 1 day ago" : `Checked ${d} days ago`; };
function homeCard(x, t) {
  const e = escHtml, m = (v) => e(homeMoney(v, x.currency));
  const fly = x.kind === "flyer";
  const meta = fly
    ? `Normal price ${m(x.regular)}${x.qty > 1 ? ` for ${x.qty}` : ""} · <b>Save ${m(x.saving)}</b><br>${e(x.valid)} · ${e(x.region)}${x.badges && x.badges.length ? " · " + e(x.badges.join(", ")) : ""}${x.limit ? " · " + e(x.limit) : ""}`
    : `<b>${m(x.saving)} under</b> the usual ${m(x.usual)} · from ${x.n} older prices<br>${homeAgo(x.checked, t)}`;
  const price = fly && x.qty > 1 ? `${m(x.price)} <small>for ${x.qty}</small>` : m(x.price);
  return `<a class="dcard" href="${e(x.href)}" data-kind="${x.kind}"><span class="dshop">${e(x.shop)}${x.cc === "GB" ? " · UK" : ""}${fly ? " · flyer" : ""}</span>`
    + `<span class="dtag${fly ? " fly" : ""}">${e(x.label)}</span><b class="dtitle">${e(x.title)}</b><span class="dprice num">${price}</span><span class="dmeta">${meta}</span></a>`;
}
// The list for the page: one <li> per deal (data-cc, data-until), then the empty notes for each country.
function homeListHtml(val, t = now()) {
  const live = (val && val.deals ? val.deals : []).filter((x) => !x.until || x.until > t);
  const n = { ZA: 0, GB: 0 };
  const items = live.map((x) => { const i = n[x.cc]++; return `<li data-cc="${x.cc}" data-kind="${x.kind}"${x.until ? ` data-until="${x.until}"` : ""}${x.cc !== "ZA" || i >= HOME_FIRST ? " hidden" : ""}>${homeCard(x, t)}</li>`; }).join("");
  return items
    + `<li class="dempty" data-empty="ZA"${n.ZA ? " hidden" : ""}>No genuine deals to show right now. Search a product or paste a link to check it.</li>`
    + `<li class="dempty" data-empty="GB" hidden>No checked UK price drops right now. Search a product or paste a link to check it.</li>`;
}
// The home page with today's deals in it. Only on the plain home page (not on a shared result or search link).
async function homeInPage(req, env, html) {
  const url = new URL(req.url);
  const sp = url.searchParams;
  if (url.pathname !== "/" || sp.get("u") || sp.get("url") || sp.get("q")) return html;
  const t = now();
  let val = HOME_MEM && HOME_MEM.exp > t ? HOME_MEM.val : null;
  if (!val) { val = await homeDeals(env, t); HOME_MEM = { exp: val.expires_at, val }; }
  const za = (val.deals || []).filter((x) => x.cc === "ZA" && (!x.until || x.until > t));
  const fly = za.some((x) => x.kind === "flyer"), drop = za.some((x) => x.kind === "drop");
  const note = (drop ? "Price drops come from prices we checked at the shop. " : "") + (fly ? "Flyer deals come from the shop's printed flyer and stop after its last day. " : "") + (za.length ? "Tap a deal to check it." : "We show only prices we checked, and flyer deals for the dates on the flyer.");
  return html.replace('<ul class="dgrid" id="dealList"></ul>', `<ul class="dgrid" id="dealList">${homeListHtml(val, t)}</ul>`)
    .replace(/<button type="button" class="linkbtn more hidden" id="dealsAll" aria-expanded="false" aria-controls="dealList">View all<\/button>/,
      `<button type="button" class="linkbtn more${za.length > HOME_FIRST ? "" : " hidden"}" id="dealsAll" aria-expanded="false" aria-controls="dealList">View all (${za.length})</button>`)
    .replace(/(<p class="small dnote" id="dealsNote">)[^<]*(<\/p>)/, `$1${escHtml(note)}$2`);
}
