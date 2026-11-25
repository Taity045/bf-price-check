// ---------- Web archive prices from Common Crawl (offline backfill, read from D1 only) ----------
// This file is joined with worker.js at build time (build.py), so it shares its helpers.
// scripts/cc/archive.mjs reads archived product pages from Common Crawl with the same price reader as a
// live check, keeps only safe prices, and loads one row per run of the same price into archive_prices
// through POST /api/admin/archive-load. A check reads these rows from D1; it never calls Common Crawl.

const ARCHIVE_SOURCE = "common crawl";
const ARCHIVE_DAILY_CAP = 15000;     // rows written per UTC day by the loader (D1 Free: 100,000 for everything)
const ARCHIVE_MAX_ROWS = 400;        // rows per load request
const ARCHIVE_SPREAD = 3;            // an archive price more than 3x away from today's price is not shown
// Link parameters that never change the product or its price on these shops (seen in archived links).
// They are removed before the product key is made, so archive rows match the link people paste.
const ARCHIVE_JUNK = /^(rctxt|affil|thg_ppc_campaign|trk_[a-z_]+|utm_[a-z_]+|fnode|cid|afid|prevpage|extid|image|referrer|isfromplp|gad_campaignid|gad_source|applink|_br_psugg_q|gbraid|wbraid|gclsrc|gclid|srsltid|cm_mmc|reviews)$/i;

// Product key for archive rows: the live check's canonical link, without junk parameters.
// null when the link still has parameters that may pick a size, colour or SKU (another price).
function archiveKey(raw) {
  let u;
  try { u = new URL(String(raw).replace(/^http:/i, "https:")); } catch { return null; }
  for (const k of [...u.searchParams.keys()]) if (ARCHIVE_JUNK.test(k)) u.searchParams.delete(k);
  const c = canonicalize(u);
  if (new URL(c.canon).search) return null;
  return c.canon;
}
// Keys to look up for one checked product: its key, with and without a trailing slash and www.
function archiveLookupKeys(canon, origUrl) {
  const out = new Set();
  for (const raw of [canon, origUrl]) {
    const k = raw && archiveKey(raw);
    if (!k) continue;
    const u = new URL(k);
    const paths = u.pathname.length > 1 ? [u.pathname.replace(/\/+$/, ""), u.pathname.replace(/\/+$/, "") + "/"] : [u.pathname];
    const h = u.hostname.replace(/^www\./, "");
    for (const host of [h, "www." + h]) for (const p of paths) out.add(`https://${host}${p}`);
  }
  return [...out].slice(0, 8);
}

// Rows for a product from the last HISTORY_DAYS. Never throws: no table yet means no rows.
let archiveTableSeen = false;
async function archiveRows(env, keys, since) {
  if (!keys.length) return [];
  try {
    const r = await env.DB.prepare(`SELECT product_key, captured_at, last_seen, n, price, was, currency, url, crawl, last_crawl FROM archive_prices WHERE product_key IN (${keys.map(() => "?").join(", ")}) AND last_seen >= ? ORDER BY captured_at LIMIT 500`).bind(...keys, since).all();
    archiveTableSeen = true;
    return r.results || [];
  } catch { return []; }
}

// Daily saving: one statement for a whole batch (run inside its D1 batch), then the rows per product.
// No statement when the table does not exist yet would fail the batch, so the table is checked first.
function archiveBatchStmt(env, urls, since) {
  if (!archiveTableSeen) return [];
  const keys = [...new Set(urls.flatMap((u) => archiveLookupKeys(u)))].slice(0, 90);
  if (!keys.length) return [];
  return [env.DB.prepare(`SELECT product_key, captured_at, last_seen, n, price, was, currency, url, crawl, last_crawl FROM archive_prices WHERE product_key IN (${keys.map(() => "?").join(", ")}) AND last_seen >= ? ORDER BY captured_at LIMIT 500`).bind(...keys, since)];
}
// Once per isolate (cron): does the table exist yet? Then the daily batches read it.
async function archiveProbe(env) {
  if (archiveTableSeen) return;
  try { await env.DB.prepare("SELECT 1 FROM archive_prices LIMIT 1").all(); archiveTableSeen = true; } catch {}
}
function archiveRowsFor(url, rows) {
  if (!rows || !rows.length) return [];
  const keys = new Set(archiveLookupKeys(url));
  return rows.filter((r) => keys.has(r.product_key));
}

// A public link that shows Common Crawl holds this copy: its index record for the page in that crawl.
const ccIndexLink = (crawl, url) => crawl && /^CC-MAIN-\d{4}-\d{2}$/.test(crawl) ? `https://index.commoncrawl.org/${crawl}-index?url=${encodeURIComponent(url)}&output=json` : "https://commoncrawl.org/";

// Points for the chart and verdicts: the first and the last copy of each run of the same price.
// Prices far away from today's price are left out (never show a doubtful price).
function archivePoints(rows, since, price) {
  const pts = [];
  for (const r of rows) {
    if (!(r.price > 0) || !r.currency) continue;
    if (price > 0 && (r.price > price * ARCHIVE_SPREAD || r.price < price / ARCHIVE_SPREAD)) continue;
    const base = { price: r.price, was: r.was || null, currency: r.currency, url: r.url, kind: "cc" };
    if (r.captured_at >= since) pts.push({ ...base, t: r.captured_at, crawl: r.crawl, link: ccIndexLink(r.crawl, r.url) });
    if (r.last_seen !== r.captured_at && r.last_seen >= since) pts.push({ ...base, t: r.last_seen, crawl: r.last_crawl || r.crawl, link: ccIndexLink(r.last_crawl || r.crawl, r.url) });
  }
  return pts;
}

let archiveTablesReady = false;
async function ensureArchiveTables(env) {
  if (archiveTablesReady) return;
  await env.DB.batch([
    // WITHOUT ROWID: one stored row per price row (no extra index write), which keeps loading inside the free plan.
    env.DB.prepare("CREATE TABLE IF NOT EXISTS archive_prices (product_key TEXT NOT NULL, captured_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, n INTEGER NOT NULL DEFAULT 1, price REAL NOT NULL, was REAL, currency TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'common crawl', url TEXT NOT NULL, crawl TEXT, last_crawl TEXT, PRIMARY KEY (product_key, captured_at)) WITHOUT ROWID"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS archive_load (day TEXT PRIMARY KEY, written INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0)"),
  ]);
  archiveTablesReady = true;
  archiveTableSeen = true;
}

function timingSafeEq(a, b) {
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i % (x.length || 1)] || 0) ^ (y[i % (y.length || 1)] || 0);
  return d === 0;
}

// Checks one row sent by the loader. Returns the clean row or null.
function cleanArchiveRow(r, nowMs) {
  if (!r || typeof r !== "object") return null;
  const key = typeof r.key === "string" && r.key.length <= 600 ? archiveKey(r.key) : null;
  if (!key || key !== r.key) return null;
  const shop = shopFor(key);
  if (!shop) return null;
  const host = stripWww(new URL(key).hostname.toLowerCase());
  let url; try { url = new URL(String(r.url)); } catch { return null; }
  if (!/^https?:$/.test(url.protocol) || stripWww(url.hostname.toLowerCase()) !== host || url.href.length > 1000) return null;
  const price = Number(r.price), was = r.was == null ? null : Number(r.was);
  if (!Number.isFinite(price) || price <= 0 || price >= 1e6) return null;
  if (was !== null && !(Number.isFinite(was) && was > price && was <= price * 5)) return null;
  const currency = String(r.currency || "");
  if (currency !== ({ UK: "GBP", ZA: "ZAR" })[shop.cc]) return null;
  const t0 = Number(r.captured_at), t1 = Number(r.last_seen ?? r.captured_at);
  const oldest = nowMs - 2 * 366 * 864e5;
  if (!Number.isInteger(t0) || !Number.isInteger(t1) || t0 < oldest || t1 < t0 || t1 > nowMs + 864e5) return null;
  const crawl = /^CC-MAIN-\d{4}-\d{2}$/.test(r.crawl || "") ? r.crawl : null, lastCrawl = /^CC-MAIN-\d{4}-\d{2}$/.test(r.last_crawl || "") ? r.last_crawl : crawl;
  const n = Math.max(1, Math.min(1000, Math.floor(Number(r.n) || 1)));
  return { key, captured_at: t0, last_seen: t1, n, price: Math.round(price * 100) / 100, was: was === null ? null : Math.round(was * 100) / 100, currency, url: url.href, crawl, last_crawl: lastCrawl };
}

// POST /api/admin/archive-load  (Authorization: Bearer <ARCHIVE_LOAD_KEY>)
// mode "load": insert rows that are not there yet (first backfill).
// mode "append": a newer crawl; extend the product's latest row when the price is the same, else add a row.
async function apiArchiveLoad(req, env) {
  if (!env.ARCHIVE_LOAD_KEY || String(env.ARCHIVE_LOAD_KEY).length < 32) return json({ error: "not found" }, 404);
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ") || !timingSafeEq(auth.slice(7), env.ARCHIVE_LOAD_KEY)) return json({ error: "not found" }, 404);
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  let body;
  try { const t = await req.text(); if (t.length > 400000) return json({ error: "too large" }, 413); body = JSON.parse(t); } catch { return json({ error: "bad json" }, 400); }
  const mode = body && body.mode === "append" ? "append" : "load";
  const list = Array.isArray(body && body.rows) ? body.rows : [];
  if (!list.length || list.length > ARCHIVE_MAX_ROWS) return json({ error: `send 1 to ${ARCHIVE_MAX_ROWS} rows` }, 400);
  await ensureArchiveTables(env);
  const day = new Date(now()).toISOString().slice(0, 10);
  const cap = Number(env.ARCHIVE_DAILY_CAP) > 0 ? Number(env.ARCHIVE_DAILY_CAP) : ARCHIVE_DAILY_CAP;
  const used = (await env.DB.prepare("SELECT written FROM archive_load WHERE day = ?").bind(day).first())?.written || 0;
  if (used + list.length * (mode === "append" ? 2 : 1) > cap) return json({ error: "daily load cap reached", day, written_today: used, cap, cap_left: 0 }, 429);
  const rows = [], rejected = [];
  list.forEach((r, i) => { const c = cleanArchiveRow(r, now()); if (c) rows.push(c); else rejected.push(i); });
  const stmts = [];
  for (const r of rows) {
    if (mode === "load") {
      stmts.push(env.DB.prepare("INSERT INTO archive_prices (product_key, captured_at, last_seen, n, price, was, currency, source, url, crawl, last_crawl) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(product_key, captured_at) DO NOTHING")
        .bind(r.key, r.captured_at, r.last_seen, r.n, r.price, r.was, r.currency, ARCHIVE_SOURCE, r.url, r.crawl, r.last_crawl));
    } else {
      // Same price as the latest row: move its last_seen forward. Else add a new row (unless it is there).
      stmts.push(env.DB.prepare(`UPDATE archive_prices SET last_seen = ?, n = n + 1, last_crawl = ? WHERE product_key = ? AND captured_at = (SELECT MAX(captured_at) FROM archive_prices WHERE product_key = ?) AND ABS(price - ?) < 0.005 AND last_seen < ?`)
        .bind(r.last_seen, r.last_crawl, r.key, r.key, r.price, r.last_seen));
      stmts.push(env.DB.prepare(`INSERT INTO archive_prices (product_key, captured_at, last_seen, n, price, was, currency, source, url, crawl, last_crawl)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM archive_prices WHERE product_key = ? AND captured_at <= ? AND last_seen >= ?)
          AND (SELECT COALESCE(MAX(captured_at), 0) FROM archive_prices WHERE product_key = ?) < ?
        ON CONFLICT(product_key, captured_at) DO NOTHING`)
        .bind(r.key, r.captured_at, r.last_seen, r.n, r.price, r.was, r.currency, ARCHIVE_SOURCE, r.url, r.crawl, r.last_crawl, r.key, r.last_seen, r.captured_at, r.key, r.captured_at));
    }
  }
  let written = 0;
  if (stmts.length) {
    const res = await env.DB.batch(stmts);
    for (const x of res) written += Number((x.meta && x.meta.changes) || 0);
  }
  await env.DB.prepare("INSERT INTO archive_load (day, written, requests) VALUES (?, ?, 1) ON CONFLICT(day) DO UPDATE SET written = archive_load.written + excluded.written, requests = archive_load.requests + 1").bind(day, written).run();
  return json({ ok: true, mode, received: list.length, accepted: rows.length, rejected: rejected.length, written, written_today: used + written, cap, cap_left: cap - used - written });
}

// GET /api/archive-stats: how many archive rows and products we hold, per shop host (public, cached).
async function apiArchiveStats(env) {
  const c = await cacheGet(env, "archive-stats-v1");
  if (c) return json(c);
  let out = { rows: 0, products: 0, shops: [] };
  try {
    const r = await env.DB.prepare("SELECT substr(product_key, 9, instr(substr(product_key, 9), '/') - 1) AS host, COUNT(*) AS rows, COUNT(DISTINCT product_key) AS products FROM archive_prices GROUP BY host ORDER BY rows DESC").all();
    out = { rows: 0, products: 0, shops: (r.results || []).map((x) => ({ host: stripWww(x.host), rows: x.rows, products: x.products })) };
    for (const s of out.shops) { out.rows += s.rows; out.products += s.products; }
    const d = await env.DB.prepare("SELECT day, written FROM archive_load ORDER BY day DESC LIMIT 7").all();
    out.load_days = d.results || [];
  } catch {}
  out.updated_at = now();
  await cachePut(env, "archive-stats-v1", out, 3600e3);
  return json(out);
}

// ---------- one-off price fix: geo-priced Shopify reads saved before PR #14 ----------
// Before #14 (deployed 2026-11-25 02:20:56 UTC) our servers abroad read Lakeland without UK VAT (exactly
// 1/1.2 of the UK price) and Escentual in USD. POST /api/admin/price-fix (same key as the archive load)
// with {"apply": false} lists what would go; {"apply": true} deletes those rows, the verdicts built on them
// and the cached checks, identities, compare answers and share images for those products.
const PRICE_FIX_BEFORE = Date.UTC(2026, 10, 25, 2, 20, 56);
const PRICE_FIX_EXVAT_HOSTS = ["lakeland.co.uk"];
function priceFixHome(url) {
  let host; try { host = stripWww(new URL(url).hostname.toLowerCase()); } catch { return null; }
  const sh = cmpShopForHost(host);
  return sh ? sh.cur : tldCurrency(host);
}
async function priceFixPlan(env) {
  const { results } = await env.DB.prepare("SELECT id, url, ts, price, currency, source, via FROM checks WHERE ts < ? ORDER BY url, ts").bind(PRICE_FIX_BEFORE).all();
  const bad = [];
  for (const r of results) {
    let host = ""; try { host = stripWww(new URL(r.url).hostname.toLowerCase()); } catch {}
    const home = priceFixHome(r.url);
    if (home && r.currency && r.currency !== home) bad.push({ ...r, why: `priced in ${r.currency}, shop sells in ${home}` });
    else if (PRICE_FIX_EXVAT_HOSTS.includes(host)) bad.push({ ...r, exvat: true, why: "read without UK VAT (shop priced for a visitor abroad)" });
  }
  // evidence: the same product read after the fix
  const urls = [...new Set(bad.map((r) => r.url))];
  const after = {};
  for (const u of urls) {
    const a = await env.DB.prepare("SELECT price, currency, ts FROM checks WHERE url = ? AND ts >= ? ORDER BY ts DESC LIMIT 1").bind(u, PRICE_FIX_BEFORE).first();
    if (a) after[u] = a;
  }
  // no read after the fix: ask the shop now, for its home country (Shopify product .js)
  for (const u of urls) {
    if (after[u]) continue;
    const sh = cmpShopForHost(new URL(u).hostname.toLowerCase()); const h = new URL(u).pathname.match(/\/products\/([^/?#]+)/);
    if (!sh || sh.kind !== "shopify" || !h) continue;
    try { const d = await cmpShopifyJson(sh, `${sh.base}/products/${h[1]}.js`); const ps = (d.variants || []).map((v) => v.price / 100); if (ps.length) after[u] = { prices: ps, currency: sh.cur, live: true }; } catch {}
  }
  for (const r of bad) {
    const a = after[r.url]; if (!a) continue;
    r.after = a.live ? { prices: a.prices, currency: a.currency, read: "live now" } : { price: a.price, currency: a.currency };
    if (a.currency === r.currency && r.price) { const ps = a.live ? a.prices : [a.price]; r.ratio_after = ps.map((p) => Math.round((p / r.price) * 10000) / 10000).sort((x, y) => Math.abs(x - 1.2) - Math.abs(y - 1.2))[0]; }
  }
  // ex-VAT rows go only with evidence: the UK price is 1.2x (19-21 %) the saved one
  return { bad: bad.filter((r) => !r.exvat || (r.ratio_after >= 1.19 && r.ratio_after <= 1.21)), kept: bad.filter((r) => r.exvat && !(r.ratio_after >= 1.19 && r.ratio_after <= 1.21)).map((r) => ({ id: r.id, url: r.url, price: r.price, ratio_after: r.ratio_after || null })), urls };
}
async function apiPriceFix(req, env) {
  if (!env.ARCHIVE_LOAD_KEY || String(env.ARCHIVE_LOAD_KEY).length < 32) return json({ error: "not found" }, 404);
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ") || !timingSafeEq(auth.slice(7), env.ARCHIVE_LOAD_KEY)) return json({ error: "not found" }, 404);
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  let body = {}; try { body = JSON.parse((await req.text()) || "{}"); } catch { return json({ error: "bad json" }, 400); }
  if (Array.isArray(body.multi_urls)) return priceFixMulti(env, body.multi_urls, body.apply === true);
  const { bad, kept } = await priceFixPlan(env);
  const urls = [...new Set(bad.map((r) => r.url))];
  const out = { before: new Date(PRICE_FIX_BEFORE).toISOString(), rows: bad.map((r) => ({ id: r.id, url: r.url, at: new Date(r.ts).toISOString(), price: r.price, currency: r.currency, source: r.source, via: r.via, why: r.why, after: r.after || null, ratio_after: r.ratio_after || null })), products: urls.length, kept_no_evidence: kept, applied: false };
  if (body.apply !== true || !bad.length) return json(out);
  const del = { checks: 0, verdicts: 0, cache: 0 };
  for (let i = 0; i < bad.length; i += 50) {
    const ids = bad.slice(i, i + 50).map((r) => r.id);
    const r = await env.DB.prepare(`DELETE FROM checks WHERE id IN (${ids.map(() => "?").join(",")}) AND ts < ?`).bind(...ids, PRICE_FIX_BEFORE).run();
    del.checks += r.meta.changes || 0;
  }
  for (const u of urls) {
    del.verdicts += (await env.DB.prepare("DELETE FROM verdicts WHERE url = ?").bind(u).run()).meta.changes || 0;
    // check-*:<url>, cmpid-*:<url>, cmp-*:<shop>:<url>, og-*:<url>:<ts>
    del.cache += (await env.DB.prepare("DELETE FROM cache WHERE (k LIKE 'check-%' OR k LIKE 'cmpid-%' OR k LIKE 'cmp-%' OR k LIKE 'og-%') AND (substr(k, -length(?1)) = ?1 OR instr(k, ':' || ?1 || ':') > 0)").bind(u).run()).meta.changes || 0;
  }
  // compare answers that used a Lakeland page as the other shop
  del.cache += (await env.DB.prepare("DELETE FROM cache WHERE k LIKE 'cmp-%:lakeland:%'").run()).meta.changes || 0;
  return json({ ...out, applied: true, deleted: del });
}

// Compare rows saved for one option of a page that sells several options at different prices (before
// cmpSaveHistory skipped them): the page's own check reads its default option, so the two mixed in one
// history (Edgars Sauvage 100ml R3 245 vs the page's default 60ml R2 355). Each URL is checked again with
// the shop's product data; only compare-* rows go, the page's own reads stay.
async function priceFixMulti(env, list, apply) {
  const urls = [...new Set(list.map(String))].slice(0, 20);
  const out = { urls: [], applied: apply, deleted: { checks: 0, verdicts: 0, cache: 0 } };
  for (const u of urls) {
    let sh = null, h = null; try { sh = cmpShopForHost(new URL(u).hostname.toLowerCase()); h = new URL(u).pathname.match(/\/products\/([^/?#]+)/); } catch {}
    const one = { url: u, prices: null, multi: false, rows: [] };
    if (sh && sh.kind === "shopify" && h) { try { const d = await cmpShopifyJson(sh, `${sh.base}/products/${h[1]}.js`); one.prices = (d.variants || []).map((v) => [v.title, v.price / 100]); } catch {} }
    one.multi = !!one.prices && new Set(one.prices.map((x) => x[1])).size > 1;
    if (one.multi) {
      one.rows = (await env.DB.prepare("SELECT id, ts, price, currency, source FROM checks WHERE url = ? AND source LIKE 'compare-%' ORDER BY ts").bind(u).all()).results.map((r) => ({ ...r, at: new Date(r.ts).toISOString() }));
      if (apply && one.rows.length) {
        out.deleted.checks += (await env.DB.prepare("DELETE FROM checks WHERE url = ? AND source LIKE 'compare-%'").bind(u).run()).meta.changes || 0;
        out.deleted.verdicts += (await env.DB.prepare("DELETE FROM verdicts WHERE url = ?").bind(u).run()).meta.changes || 0;
        out.deleted.cache += (await env.DB.prepare("DELETE FROM cache WHERE (k LIKE 'check-%' OR k LIKE 'og-%') AND (substr(k, -length(?1)) = ?1 OR instr(k, ':' || ?1 || ':') > 0)").bind(u).run()).meta.changes || 0;
      }
    }
    out.urls.push(one);
  }
  return json(out);
}
