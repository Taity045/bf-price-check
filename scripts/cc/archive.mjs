#!/usr/bin/env node
// Common Crawl price backfill for BF Price Check.
//
//   node scripts/cc/archive.mjs collect --out DIR [--crawls latest|12m|CC-MAIN-2026-47,...] [--shops "Dunelm,Wickes"]
//                                       [--idx-dir DIR] [--cdx-dir DIR] [--concurrency 16]
//       Finds each shop's product pages in Common Crawl's public index (data.commoncrawl.org), downloads
//       each archived page with one byte-range request, and reads its price with the site's own reader.
//       Writes DIR/captures.jsonl (one line per page read; resumable).
//   node scripts/cc/archive.mjs recheck --out DIR [--cdx-dir DIR] [--max N] [--again REASON]
//       UK shops: re-reads captures collected before the UK price check (archivedGeoCheck) and writes
//       DIR/geo.jsonl. reduce keeps a UK capture only when its copy confirmed the UK GBP price.
//   node scripts/cc/archive.mjs reduce --out DIR
//       Sanity filter per product, then one row per run of the same price -> DIR/rows.jsonl (load order).
//   node scripts/cc/archive.mjs upload --out DIR --endpoint URL [--max-writes 15000] [--mode load|append]
//       Sends rows to the worker's admin endpoint (key in env ARCHIVE_LOAD_KEY, never printed).
//       DIR/upload_state.json remembers what was sent, so the next day's run continues.
//
// Public data only: Common Crawl's index and WARC files, read under its terms of use.
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import zlib from "node:zlib";
import { W } from "../../tests/helpers/load-worker.mjs";
import { CC_SHOPS } from "./shops.mjs";
import { readArchivedPage, productKey, cleanSeries, toSegments } from "./read.mjs";

const UA = "bf-price-check-backfill/1.0 (+https://eish.veldwire.com; price history from Common Crawl)";
const DATA = "https://data.commoncrawl.org/";
const args = Object.fromEntries(process.argv.slice(3).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "1"] : null).filter(Boolean));
const cmd = process.argv[2];
const OUT = args.out || "cc-archive";
if (cmd !== "latest") mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const DAY = 864e5;

// Polite use of data.commoncrawl.org: a few requests at a time (--concurrency), and a short pause
// before retrying when the server says it is busy (503/429). --rate caps requests per second.
const MAX_RATE = +(args.rate || 20);
let nextSlot = 0;
async function slot() {
  const t = Date.now(), at = Math.max(nextSlot, t);
  nextSlot = at + 1000 / MAX_RATE;
  if (at > t) await sleep(at - t);
}
let busy = 0, timeouts = 0, okCount = 0, otherErr = 0;
setInterval(() => log(`progress: ok ${okCount}, busy ${busy}, timeouts ${timeouts}, errors ${otherErr}`), 60000).unref();
async function get(url, range, tries = 8) {
  for (let t = 0; t < tries; t++) {
    await slot();
    try {
      const r = await fetch(url, { headers: { "user-agent": UA, ...(range ? { range: `bytes=${range[0]}-${range[0] + range[1] - 1}` } : {}) }, signal: AbortSignal.timeout(range ? 20000 : 120000) });
      if (r.status === 503 || r.status === 429 || r.status >= 500) { await r.body?.cancel(); busy++; await sleep(300 + Math.random() * 700 * (t + 1)); continue; }
      if (!(r.status === 200 || r.status === 206)) { await r.body?.cancel(); return { status: r.status }; }
      const buf = Buffer.from(await r.arrayBuffer());
      okCount++;
      return { status: r.status, buf };
    } catch (e) { if (e && (e.name === "TimeoutError" || e.name === "AbortError")) timeouts++; else otherErr++; await sleep(1000 * (t + 1)); }
  }
  return { status: 0 };
}

// ---------- which crawls ----------
async function crawlExists(id) {
  try { const r = await fetch(`${DATA}cc-index/collections/${id}/indexes/cluster.idx`, { method: "HEAD", headers: { "user-agent": UA }, signal: AbortSignal.timeout(20000) }); return r.ok; } catch { return false; }
}
async function listCrawls() {
  try {
    const r = await fetch("https://index.commoncrawl.org/collinfo.json", { headers: { "user-agent": UA }, signal: AbortSignal.timeout(30000) });
    if (r.ok) return (await r.json()).map((x) => x.id).filter((id) => /^CC-MAIN-\d{4}-\d{2}$/.test(id));
  } catch {}
  // The index server is often busy; fall back to probing week numbers on the data server.
  const ids = [], y = new Date().getUTCFullYear();
  for (const yy of [y, y - 1]) for (let w = 53; w >= 1; w--) ids.push(`CC-MAIN-${yy}-${String(w).padStart(2, "0")}`);
  const found = [];
  for (let i = 0; i < ids.length; i += 12) {
    const ok = await Promise.all(ids.slice(i, i + 12).map(crawlExists));
    ids.slice(i, i + 12).forEach((id, j) => ok[j] && found.push(id));
  }
  return found;
}
async function pickCrawls() {
  const spec = args.crawls || "12m";
  // --after ID: only crawls newer than ID (the box backfill loaded everything up to it).
  const after = (list) => args.after ? list.filter((id) => id > args.after) : list;
  if (/^CC-MAIN/.test(spec)) return after(spec.split(","));
  const all = after((await listCrawls()).sort().reverse());
  if (spec === "latest") return all.slice(0, 1);
  // 12m: crawls from the last 12 months (by the crawl's year-week).
  const cutoff = Date.now() - 372 * DAY;
  return all.filter((id) => { const [, y, w] = id.match(/(\d{4})-(\d{2})/); return Date.UTC(+y, 0, 1) + (+w - 1) * 7 * DAY >= cutoff; });
}

// ---------- index ----------
async function clusterIdx(crawl) {
  const local = args["idx-dir"] && `${args["idx-dir"]}/${crawl}.idx`;
  let text;
  if (local && existsSync(local)) text = readFileSync(local, "latin1");
  else {
    const r = await get(`${DATA}cc-index/collections/${crawl}/indexes/cluster.idx`);
    if (!r.buf) throw new Error(`cluster.idx for ${crawl}: HTTP ${r.status}`);
    text = r.buf.toString("latin1");
  }
  const keys = [], rows = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const p = line.split("\t");
    keys.push(p[0].split(" ")[0]); rows.push([p[1], +p[2], +p[3]]);
  }
  return { keys, rows };
}
function lowerBound(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }
async function cdxLines(crawl, idx, surt) {
  const cdxDir = args["cdx-dir"];
  if (cdxDir) {
    const f = `${cdxDir}/${crawl}__${surt.replace(/\//g, "_").replace(/\)/g, "").replace(/,/g, ".")}.jsonl.gz`;
    if (existsSync(f)) return zlib.gunzipSync(readFileSync(f)).toString("utf8").split("\n").slice(1).filter(Boolean).map((l) => JSON.parse(l));
  }
  const i0 = Math.max(0, lowerBound(idx.keys, surt) - 1), out = [];
  for (let i = i0; i < idx.keys.length && (idx.keys[i] < surt || idx.keys[i].startsWith(surt)); i++) {
    const [file, off, len] = idx.rows[i];
    const r = await get(`${DATA}cc-index/collections/${crawl}/indexes/${file}`, [off, len]);
    if (!r.buf) throw new Error(`index block ${crawl} ${file}: HTTP ${r.status}`);
    for (const line of zlib.gunzipSync(r.buf).toString("utf8").split("\n")) {
      if (!line.startsWith(surt)) continue;
      const sp = line.indexOf(" ", line.indexOf(" ") + 1);
      try { out.push(JSON.parse(line.slice(sp + 1))); } catch {}
    }
  }
  return out;
}

// ---------- WARC record ----------
async function warcHtml(rec) {
  const r = await get(DATA + rec.filename, [+rec.offset, +rec.length]);
  if (!r.buf) return { err: `HTTP ${r.status}` };
  const raw = zlib.gunzipSync(r.buf);
  const h1 = raw.indexOf("\r\n\r\n"), wh = raw.subarray(0, h1).toString(), rest = raw.subarray(h1 + 4), h2 = rest.indexOf("\r\n\r\n");
  const hh = rest.subarray(0, h2).toString();
  let body = rest.subarray(h2 + 4);
  const ce = (hh.match(/^content-encoding:\s*(\S+)/im) || [])[1];
  try { if (ce === "gzip") body = zlib.gunzipSync(body); else if (ce === "br") body = zlib.brotliDecompressSync(body); } catch {}
  const date = (wh.match(/WARC-Date: (\S+)/) || [])[1];
  return { html: body.toString("utf8"), t: date ? Date.parse(date) : null };
}

async function collect() {
  const crawls = await pickCrawls();
  if (!crawls.length) { log("no new crawl to collect"); return; }
  const deadline = args["max-minutes"] ? Date.now() + +args["max-minutes"] * 60e3 : Infinity;
  const shops = args.shops ? CC_SHOPS.filter((s) => args.shops.split(",").includes(s.name)) : CC_SHOPS;
  log("crawls", crawls.join(" "), "shops", shops.length);
  const capFile = `${OUT}/captures.jsonl`, done = new Set();
  if (existsSync(capFile)) for (const l of readFileSync(capFile, "utf8").split("\n")) if (l) { try { const c = JSON.parse(l); if (c.ok || !/^(HTTP|error)/.test(c.reason || "")) done.add(c.crawl + "|" + c.key); } catch {} }
  const conc = +(args.concurrency || 12);
  // With a local copy of the index lines (--cdx-dir), finish one shop at a time (strongest first);
  // otherwise read each crawl's index once and go through all shops.
  const pairs = args["cdx-dir"] ? shops.flatMap((shop) => crawls.map((crawl) => [crawl, shop])) : crawls.flatMap((crawl) => shops.map((shop) => [crawl, shop]));
  let idx = null, idxCrawl = null;
  // --recent-only: first fetch products that are in the two newest crawls (still sold), all their copies.
  const recentKeys = new Map();
  // --with-3to6m: and only those that also have a copy from 3 to 6 months ago (the most useful evidence).
  if (args["recent-only"]) {
    if (!args["cdx-dir"]) throw new Error("--recent-only needs --cdx-dir");
    const sorted = [...crawls].sort(), newest = sorted.slice(-2);
    const crawlTime = (id) => { const [, y, w] = id.match(/(\d{4})-(\d{2})/); return Date.UTC(+y, 0, 1) + (+w - 1) * 7 * DAY; };
    const mid = sorted.filter((c) => crawlTime(c) >= Date.now() - 190 * DAY && crawlTime(c) <= Date.now() - 85 * DAY);
    const keysIn = async (list, shop) => {
      const set = new Set();
      for (const c of list) for (const rec of await cdxLines(c, null, shop.surt)) {
        try { if (rec.status === "200" && shop.path.test(new URL(rec.url).pathname)) { const k = productKey(W, rec.url); if (k) set.add(k); } } catch {}
      }
      return set;
    };
    for (const shop of shops) {
      let set = await keysIn(newest, shop);
      if (args["with-3to6m"]) { const m = await keysIn(mid, shop); set = new Set([...set].filter((k) => m.has(k))); }
      recentKeys.set(shop.name, set);
    }
    if (args["with-3to6m"]) log("3-6 month crawls:", mid.join(" "));
  }
  for (const [crawl, shop] of pairs) {
    {
      if (!args["cdx-dir"] && idxCrawl !== crawl) { idx = null; idx = await clusterIdx(crawl); idxCrawl = crawl; }
      const lines = await cdxLines(crawl, idx, shop.surt);
      const only = recentKeys.get(shop.name);
      // One page per product per crawl: product pages with HTTP 200 and HTML only.
      const byKey = new Map();
      for (const rec of lines) {
        if (rec.status !== "200" || !/html/.test(rec.mime || "") || !rec.filename?.includes("/warc/")) continue;
        let u; try { u = new URL(rec.url); } catch { continue; }
        if (!shop.path.test(u.pathname)) continue;
        const key = productKey(W, rec.url);
        if (!key || done.has(crawl + "|" + key) || (only && !only.has(key))) continue;
        const prev = byKey.get(key);
        if (!prev || rec.url.length < prev.url.length) byKey.set(key, rec);
      }
      const jobs = [...byKey.entries()];
      let i = 0, ok = 0;
      const t0 = Date.now();
      await Promise.all(Array.from({ length: conc }, async () => {
        while (i < jobs.length && Date.now() < deadline) {
          const [key, rec] = jobs[i++];
          let line;
          try {
            const w = await warcHtml(rec);
            if (w.err) line = { crawl, shop: shop.name, key, url: rec.url, ok: false, reason: w.err };
            else {
              const r = readArchivedPage(W, w.html, rec.url, shop);
              line = { crawl, shop: shop.name, key, url: rec.url, t: w.t, ...r };
              delete line.source; delete line.title;
              if (r.ok) ok++;
            }
          } catch (e) { line = { crawl, shop: shop.name, key, url: rec.url, ok: false, reason: "error" }; }
          appendFileSync(capFile, JSON.stringify(line) + "\n");
        }
      }));
      if (Date.now() >= deadline) { log("time limit reached; the next run continues from here"); return; }
      log(crawl, shop.name, "pages", jobs.length, "prices", ok, `${((Date.now() - t0) / 1000).toFixed(0)}s`, busy ? `busy:${busy}` : "");
    }
  }
  log("collect done");
}

// ---------- reduce ----------
async function readJsonl(f, fn) {
  const rl = createInterface({ input: createReadStream(f), crlfDelay: Infinity });
  for await (const l of rl) if (l) { try { fn(JSON.parse(l)); } catch {} }
}
// UK shops (GBP): a capture counts only when its own page confirmed the UK price (geo "GB", set by
// readArchivedPage, or by "recheck" for captures read before that check existed). Unconfirmed copies
// are counted as unusable, never as a price.
const GBP_SHOPS = new Set(CC_SHOPS.filter((s) => s.ccy === "GBP").map((s) => s.name));
const geoFile = () => `${OUT}/geo.jsonl`;
async function readGeo() {
  const m = new Map();
  if (existsSync(geoFile())) await readJsonl(geoFile(), (g) => m.set(g.crawl + "|" + g.key, g));
  return m;
}
function geoOk(c, geo) {
  if (!GBP_SHOPS.has(c.shop)) return true;
  if (c.geo === "GB") return true;
  const g = geo.get(c.crawl + "|" + c.key);
  return !!(g && g.geo === "GB" && Math.abs((g.price ?? c.price) - c.price) < 0.005);
}

async function reduce() {
  const now = Date.now(), w36 = [now - 183 * DAY, now - 91 * DAY];
  const byKey = new Map(), reasons = {};
  const geo = await readGeo();
  await readJsonl(`${OUT}/captures.jsonl`, (c) => {
    if (c.ok && !geoOk(c, geo)) { const g = geo.get(c.crawl + "|" + c.key); c = { ...c, ok: false, reason: g ? "uk-unusable" : "uk-unchecked" }; }
    reasons[c.ok ? "ok" : c.reason] = (reasons[c.ok ? "ok" : c.reason] || 0) + 1;
    if (!c.ok || !c.t || c.t < now - 372 * DAY) return;
    if (!byKey.has(c.key)) byKey.set(c.key, { shop: c.shop, pts: [] });
    byKey.get(c.key).pts.push({ t: c.t, price: c.price, was: c.was, currency: c.currency, url: c.url, crawl: c.crawl });
  });
  const rank = new Map(CC_SHOPS.map((s, i) => [s.name, i]));
  const products = [], stats = {};
  let dropped = 0, droppedPts = 0;
  const recentCut = now - 45 * DAY;
  for (const [key, v] of byKey) {
    const st = stats[v.shop] ||= { products: 0, rows: 0, with_3to6m: 0, dropped_products: 0, dropped_points: 0 };
    const kept = cleanSeries(v.pts);
    if (!kept.length) { dropped++; st.dropped_products++; continue; }
    droppedPts += v.pts.length - kept.length; st.dropped_points += v.pts.length - kept.length;
    const segs = toSegments(kept);
    if (GBP_SHOPS.has(v.shop)) for (const sg of segs) sg.geo = "GB";
    const has36 = kept.some((p) => p.t >= w36[0] && p.t <= w36[1]);
    const recent = kept.some((p) => p.t >= recentCut);
    st.products++; st.rows += segs.length; if (has36) st.with_3to6m++;
    // Load order: the 22 strongest shops first; inside, products with a 3-6 month price that are
    // still sold, then 3-6 month only, then still sold, then the rest.
    const tier = rank.get(v.shop) < 9 ? 0 : rank.get(v.shop) < 21 ? 1 : 2;
    const pri = (has36 ? 2 : 0) + (recent ? 1 : 0);
    products.push({ key, shop: v.shop, tier, pri, r: rank.get(v.shop), segs });
  }
  products.sort((a, b) => a.tier - b.tier || b.pri - a.pri || a.r - b.r || (a.key < b.key ? -1 : 1));
  const lines = products.map((p) => JSON.stringify({ key: p.key, shop: p.shop, pri: p.pri, segs: p.segs }));
  writeFileSync(`${OUT}/rows.jsonl`, lines.join("\n") + "\n");
  const total = products.reduce((s, p) => s + p.segs.length, 0);
  const summary = { built_at: new Date().toISOString(), products: products.length, rows: total, dropped_products: dropped, dropped_points: droppedPts, page_reads: reasons, per_shop: stats };
  writeFileSync(`${OUT}/reduce_summary.json`, JSON.stringify(summary, null, 1));
  log(JSON.stringify({ products: products.length, rows: total, dropped, droppedPts, reasons }));
}

// ---------- recheck ----------
// Captures of UK shops read before the UK check existed: download each copy again and run the same
// check (archivedGeoCheck through readArchivedPage). Writes DIR/geo.jsonl: geo "GB" when the copy
// confirms the UK price, else unusable with the reason. --max N caps the downloads per run.
async function recheck() {
  const geo = await readGeo(), todo = new Map();
  await readJsonl(`${OUT}/captures.jsonl`, (c) => {
    const g = geo.get(c.crawl + "|" + c.key);
    if (!c.ok || !GBP_SHOPS.has(c.shop) || c.geo === "GB" || (g && !(args.again && g.unusable === args.again))) return;
    todo.set(c.crawl + "|" + c.key, c);
  });
  const max = +(args.max || 1e9), conc = +(args.concurrency || 4);
  const jobs = [...todo.values()].slice(0, max);
  log(`recheck: ${todo.size} UK captures not checked yet; this run ${jobs.length}`);
  if (!jobs.length) return;
  // The index record (WARC file and byte range) of each capture, from the cached index files.
  const need = new Map();
  for (const c of jobs) { const shop = CC_SHOPS.find((s) => s.name === c.shop); (need.get(c.crawl + "|" + shop.surt) || need.set(c.crawl + "|" + shop.surt, []).get(c.crawl + "|" + shop.surt)).push(c); }
  const recs = new Map();
  for (const [ck] of need) {
    const [crawl, surt] = ck.split("|");
    let lines; try { lines = await cdxLines(crawl, await indexFor(crawl, surt), surt); } catch (e) { log(`index ${crawl} ${surt}: ${e.message}`); continue; }
    // One crawl can hold several copies of a link: match the copy by its capture time.
    for (const rec of lines) if (rec.status === "200") recs.set(crawl + "|" + rec.url + "|" + rec.timestamp, rec);
  }
  const counts = {};
  let i = 0;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (i < jobs.length) {
      const c = jobs[i++], shop = CC_SHOPS.find((s) => s.name === c.shop);
      const ts14 = c.t ? new Date(c.t).toISOString().replace(/[-:T]/g, "").slice(0, 14) : "";
      const rec = recs.get(c.crawl + "|" + c.url + "|" + ts14);
      let line;
      if (!rec) line = { crawl: c.crawl, key: c.key, url: c.url, price: c.price, unusable: "no-index-record" };
      else {
        const w = await warcHtml(rec).catch(() => ({ err: "error" }));
        if (w.err) { counts.retry = (counts.retry || 0) + 1; continue; }  // network: try again next run
        const r = readArchivedPage(W, w.html, c.url, shop);
        if (r.ok && r.geo === "GB" && Math.abs(r.price - c.price) < 0.005) line = { crawl: c.crawl, key: c.key, url: c.url, price: c.price, geo: "GB" };
        else line = { crawl: c.crawl, key: c.key, url: c.url, price: c.price, unusable: r.ok ? "price-changed" : r.reason, ...(r.ok ? { reread: r.price } : {}) };
      }
      const k = line.geo ? "uk-confirmed" : line.unusable;
      counts[k] = (counts[k] || 0) + 1;
      appendFileSync(geoFile(), JSON.stringify(line) + "\n");
    }
  }));
  log("recheck done " + JSON.stringify(counts));
}
const cdxFile = (crawl, surt) => args["cdx-dir"] && `${args["cdx-dir"]}/${crawl}__${surt.replace(/\//g, "_").replace(/\)/g, "").replace(/,/g, ".")}.jsonl.gz`;
const idxCache = new Map();
async function indexFor(crawl, surt) {
  const f = cdxFile(crawl, surt);
  if (f && existsSync(f)) return null;  // cdxLines reads the cached file
  if (!idxCache.has(crawl)) idxCache.set(crawl, await clusterIdx(crawl));
  return idxCache.get(crawl);
}

// ---------- upload ----------
async function upload() {
  const key = process.env.ARCHIVE_LOAD_KEY;
  if (!key) throw new Error("Set ARCHIVE_LOAD_KEY");
  const endpoint = args.endpoint || "https://eish.veldwire.com/api/admin/archive-load";
  const maxWrites = +(args["max-writes"] || 15000);
  const stateFile = `${OUT}/upload_state.json`;
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { written: 0, per_shop: {}, sent: [] };
  const sent = new Set(state.sent || []);
  const products = [];
  // --shops: only these shops (for example the ones whose collection is complete).
  const only = args.shops ? new Set(args.shops.split(",")) : null;
  // --min-pri 2: only products with a readable price from 3-6 months ago (pri 2 or 3).
  const minPri = +(args["min-pri"] || 0);
  await readJsonl(`${OUT}/rows.jsonl`, (p) => { if (!sent.has(p.key) && (!only || only.has(p.shop)) && p.pri >= minPri) products.push(p); });
  let written = 0, i = 0, stop = null;
  const BATCH = +(args.batch || 150);
  const save = () => { state.sent = [...sent]; writeFileSync(stateFile, JSON.stringify(state)); };
  while (i < products.length && written < maxWrites) {
    const chunk = [];
    let n = 0;
    while (i < products.length && n < BATCH) { const p = products[i++]; chunk.push(p); n += p.segs.length; }
    const rows = chunk.flatMap((p) => p.segs.map((s) => ({ key: p.key, ...s })));
    let res;
    for (let t = 0; t < 5; t++) {
      try {
        const r = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "user-agent": UA }, body: JSON.stringify({ mode: args.mode || "load", rows }), signal: AbortSignal.timeout(60000) });
        res = { status: r.status, body: await r.json().catch(() => ({})) };
        if ([200, 400, 401, 404, 413, 429].includes(r.status)) break;
      } catch (e) { res = { status: 0, body: { error: String(e) } }; }
      await sleep(3000 * (t + 1));
    }
    if (!res || res.status !== 200) { stop = `${res?.status} ${JSON.stringify(res?.body).slice(0, 200)}`; break; }
    written += res.body.written || 0;
    state.written = (state.written || 0) + (res.body.written || 0);
    state.rejected = (state.rejected || 0) + (res.body.rejected || 0);
    for (const p of chunk) { sent.add(p.key); const s = state.per_shop[p.shop] ||= { products: 0, rows: 0 }; s.products++; s.rows += p.segs.length; }
    if (sent.size % 2000 < chunk.length) save();
    if (res.body.cap_left !== undefined && res.body.cap_left < BATCH) { stop = "daily cap on the worker reached"; break; }
  }
  state.last_run = new Date().toISOString();
  save();
  log(`products sent this run ${i}/${products.length} left before this run; rows written this run ${written}; total written ${state.written}${stop ? "; stopped: " + stop : ""}`);
}

if (cmd === "latest") { const all = (await listCrawls()).sort(); const id = all[all.length - 1] || ""; console.log(args.after && id <= args.after ? "" : id); }
else if (cmd === "collect") await collect();
else if (cmd === "reduce") await reduce();
else if (cmd === "recheck") await recheck();
else if (cmd === "upload") await upload();
else { console.log("usage: collect | recheck | reduce | upload (see the top of this file)"); process.exit(1); }
