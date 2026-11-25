// ---------- Daily price saving ----------
// This file is joined with worker.js at build time (build.py), so it shares its helpers.
//
// Goal: save the price of every product that people check about once a day, and of a seed list of
// popular Takealot products, so each product builds up its own price history.
//
// Cloudflare Workers Free plan, per cron invocation (developers.cloudflare.com/workers/platform/limits,
// /d1/platform/limits, checked 2026-11-25): 10 ms CPU, 50 external subrequests, 50 D1 queries
// (a D1 batch counts as one query), 15 min wall time; 5 cron triggers per account.
// So the work is split into many small runs: the cron runs every minute and each run checks a
// small batch (DAILY_CAPS). Each product has a next_check_at time; a run takes the products that
// are due, people's products (seed = 0) before seed products (seed = 1).
//
// Lanes: "takealot" products are read from Takealot's public JSON API (small, cheap to parse).
// "page" products are read from the shop's HTML page (can be up to 4 MB, more CPU), so a run
// reads at most one page.
//
// Politeness: the scheduled check says who it is (BOT_UA), obeys robots.txt (cached for a day),
// reads at most one page per run (so at most one request a minute to a shop) and at most
// DAILY_CAPS.takealot Takealot API calls a run. It does not try to get past blocks: a shop that
// blocks us is paused for that product after repeated failures.

const DAILY_MS = 23 * 3600e3;           // a little under 24 h, so each product gets one check per calendar day
const HOUR_MS = 3600e3;
const STALE_MS = 60 * 864e5;            // not viewed (or not on a bestseller list) for 60 days -> weekly
const STALE_EVERY_MS = 7 * 864e5;
const FAIL_BACKOFF_MS = [6 * HOUR_MS, DAILY_MS, 2 * 864e5, 4 * 864e5, 7 * 864e5];
const MAX_FAILS = 8;                    // consecutive failed checks before we pause a product (~4 weeks)
const CLAIM_MS = 6 * HOUR_MS;           // a run that dies (CPU limit) leaves its products due again in 6 h
const DAILY_CAPS = { takealot: 4, page: 1 };
const SEED_CAPS = { takealot: 2, page: 0 };  // runs that also refresh the seed list do less other work
const MAX_SEEDS = 300;
const SEED_PER_DEPT = 25;
const SEED_REFRESH_MS = 7 * 864e5;
const SEED_DROP_MS = 60 * 864e5;        // seed products that left the bestseller lists 60 days ago are dropped
// Takealot departments (slugs from the search API's Department facet) for the seed list.
const SEED_DEPTS = ["computers", "cellular-gps", "tv-audio-video", "gaming", "cameras", "home-kitchen", "diy-tools-machinery", "sport", "beauty", "toys", "baby", "pool-garden"];
const BOT_TOKEN = "DealOrDudBot";
const BOT_UA = `Mozilla/5.0 (compatible; ${BOT_TOKEN}/1.0; +https://eish.veldwire.com/#priceSrc)`;
const BOT_HEADERS = { "user-agent": BOT_UA };
const ROBOTS_TTL_MS = 864e5;
const TAKEALOT_API_HOST = "api.takealot.com";

// ---------- pure helpers (unit tested) ----------
function laneFor(canon) {
  try { return canonicalize(new URL(canon)).kind === "takealot" ? "takealot" : "page"; } catch { return "page"; }
}
function hostKey(canon) {
  try { return stripWww(new URL(canon).hostname.toLowerCase()); } catch { return null; }
}
// When to check a product next, after a check at time t. null = paused (no more daily checks).
// ok: we read a price. fails: consecutive failed checks, this one included. gone: HTTP 404/410
// or a robots.txt rule says no. lastViewed: last time a person checked it (or, for a seed product,
// the last time it was on a bestseller list). alert: it has an active price alert.
function nextCheckAt({ t, ok, fails = 0, gone = false, lastViewed = 0, alert = false }) {
  if (gone) return null;
  const stale = !alert && t - (lastViewed || 0) > STALE_MS;
  if (ok) return t + (stale ? STALE_EVERY_MS : DAILY_MS);
  if (fails >= MAX_FAILS) return null;
  const wait = FAIL_BACKOFF_MS[Math.min(Math.max(fails, 1), FAIL_BACKOFF_MS.length) - 1];
  return t + Math.max(wait, stale ? STALE_EVERY_MS : 0);
}
// Picks this run's products from the due lists (already sorted: people's products first, then the
// oldest due). At most caps[lane] per lane, and one product per shop in the page lane.
function pickBatch(rows, caps) {
  const out = [], n = { takealot: 0, page: 0 }, hosts = new Set(), seen = new Set();
  for (const r of rows) {
    const lane = r.lane === "takealot" ? "takealot" : "page";
    if (seen.has(r.url) || n[lane] >= (caps[lane] || 0)) continue;
    if (lane === "page") { if (hosts.has(r.host)) continue; hosts.add(r.host); }
    seen.add(r.url); n[lane]++; out.push(r);
  }
  return out;
}
// Number of different UTC days with a saved price, in the history window.
function savedDays(checks, t = now()) {
  const since = t - HISTORY_DAYS * 864e5, days = new Set();
  for (const c of checks) if (c.price && c.ts >= since) days.add(new Date(c.ts).toISOString().slice(0, 10));
  return days.size;
}
// robots.txt: keep the rules of the group for our bot, or else the "*" group (RFC 9309).
function parseRobots(txt, token = BOT_TOKEN) {
  const groups = []; let cur = null, lastWasAgent = false;
  for (let line of String(txt).slice(0, 512 * 1024).split(/\r?\n/)) {
    line = line.replace(/#.*/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === "user-agent") {
      if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase()); lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (key === "allow" || key === "disallow") && cur.rules.length < 1000) cur.rules.push([key === "allow", val]);
    }
  }
  const t = token.toLowerCase();
  const mine = groups.filter((g) => g.agents.includes(t));
  const pick = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  return pick.flatMap((g) => g.rules).filter(([, p]) => p !== "");  // an empty rule allows everything
}
function robotsPattern(p) {
  const end = p.endsWith("$"); if (end) p = p.slice(0, -1);
  return new RegExp("^" + p.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (end ? "$" : ""));
}
// Longest matching rule wins; on a tie, Allow wins. No matching rule: allowed.
function robotsAllows(rules, pathAndQuery) {
  let best = null;
  for (const [allow, p] of rules) {
    if (!robotsPattern(p).test(pathAndQuery)) continue;
    if (!best || p.length > best[1].length || (p.length === best[1].length && allow)) best = [allow, p];
  }
  return !best || best[0];
}
// Seed products from one Takealot bestseller search result. Only products with one price (no
// variants with different prices), so the product page price is clear.
function takealotSeeds(d, dept, max = SEED_PER_DEPT) {
  const sec = (d && d.sections) || {};
  const crumbs = (sec.breadcrumbs && sec.breadcrumbs.results) || [];
  // An unknown department makes the API answer with the whole-site list: check that it is the right one.
  if (!crumbs.some((c) => c.breadcrumb && c.breadcrumb.department_slug === dept)) return { error: "department not confirmed" };
  const out = [];
  for (const r of (sec.products && sec.products.results) || []) {
    const v = r && r.product_views; const core = v && v.core; const bb = v && v.buybox_summary;
    if (!core || !/^\d+$/.test(String(core.id)) || !/^[a-z0-9-]+$/.test(core.slug || "")) continue;
    if (!bb || !Array.isArray(bb.prices) || bb.prices.length !== 1 || bb.is_preorder) continue;
    out.push({ url: `https://www.takealot.com/${core.slug}/PLID${core.id}`, title: String(core.title || "").slice(0, 300) || null });
    if (out.length >= max) break;
  }
  return { seeds: out };
}

// ---------- schema ----------
// New columns on existing tables are added here (SQLite has no ADD COLUMN IF NOT EXISTS).
const DAILY_COLUMNS = {
  tracked: [["seed", "INTEGER DEFAULT 0"], ["lane", "TEXT"], ["host", "TEXT"], ["fails", "INTEGER DEFAULT 0"], ["next_check_at", "INTEGER"], ["days", "INTEGER DEFAULT 0"]],
  checks: [["via", "TEXT"]],
};
let dailySchemaReady = false;
async function ensureDailySchema(env) {
  if (dailySchemaReady) return;
  for (const [table, cols] of Object.entries(DAILY_COLUMNS)) {
    const have = new Set(((await env.DB.prepare(`PRAGMA table_info(${table})`).all()).results || []).map((c) => c.name));
    for (const [name, type] of cols) {
      if (have.has(name)) continue;
      // Two isolates can race here; "duplicate column" from the other one is fine.
      try { await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`).run(); } catch (e) { if (!/duplicate column/i.test(String(e && e.message || e))) throw e; }
    }
  }
  // Only the index the daily pick needs. (idx_checks_via_ts and idx_tracked_last were dropped to save
  // rows written: every index is one more row written per change; schema.sql drops them.)
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_tracked_due ON tracked(lane, seed, next_check_at)").run();
  dailySchemaReady = true;
}
// Rows written without a lane (from before daily saving, or by an older deploy during a rollout):
// give them a lane, a host and a next check time. Uses idx_tracked_due, so it is cheap to run often.
async function backfillLanes(env, limit = 200) {
  const old = await env.DB.prepare("SELECT url, last_checked, last_status FROM tracked WHERE lane IS NULL LIMIT ?").bind(limit).all();
  const rows = old.results || [];
  if (rows.length) {
    await env.DB.batch(rows.map((r) => env.DB.prepare("UPDATE tracked SET lane = ?, host = ?, seed = COALESCE(seed, 0), fails = ?, next_check_at = ? WHERE url = ?")
      .bind(laneFor(r.url), hostKey(r.url), r.last_status === "ok" ? 0 : 1, (r.last_checked || 0) + DAILY_MS, r.url)));
  }
  return rows.length;
}

// ---------- robots.txt ----------
// The host was checked for a public address just before (verifiedHost); redirects are checked by fetchStore.
async function robotsRules(env, origin, memo) {
  if (memo.has(origin)) return memo.get(origin);
  const key = "robots:" + origin;
  let v = await cacheGet(env, key);
  if (!v) {
    try {
      const r = await fetchStore(origin + "/robots.txt", { "user-agent": BOT_UA, accept: "text/plain" }, 6000, new URL(origin).hostname);
      // RFC 9309: 4xx = no rules; 5xx or no answer = treat as "not now".
      if (r.status >= 500) { await r.body?.cancel(); v = { retry: true }; }
      else if (!r.ok) { await r.body?.cancel(); v = { rules: [] }; }
      else v = { rules: parseRobots(await readLimitedText(r, true)) };
    } catch { v = { retry: true }; }
    await cachePut(env, key, v, v.retry ? HOUR_MS : ROBOTS_TTL_MS);
  }
  memo.set(origin, v);
  return v;
}

// ---------- one run ----------
async function runDaily(env, scheduledTime, opts = {}) {
  const t0 = now(), at = new Date(scheduledTime || t0);
  await ensureDailySchema(env);
  await backfillLanes(env);
  // Every 10 minutes (minute 5, 15, ...) a run may refresh one department of the seed list.
  const seedSlot = opts.seedSlot ?? at.getUTCMinutes() % 10 === 5;
  const dept = seedSlot ? await dueSeedDept(env) : null;
  const caps = opts.caps || (dept ? SEED_CAPS : DAILY_CAPS);
  const sum = { at: at.toISOString(), picked: 0, saved: 0, failed: 0, paused: 0, skipped: 0, seeds_added: 0 };

  // 1) Due products: people's first, then seeds; oldest due first; plus products with active alerts.
  const due = (lane, seed, n) => env.DB.prepare("SELECT url, orig_url, lane, host, seed, fails, last_viewed, title FROM tracked WHERE lane = ? AND seed = ? AND next_check_at <= ? ORDER BY next_check_at LIMIT ?").bind(lane, seed, t0, n);
  const [ut, st, up, sp, al] = await env.DB.batch([
    due("takealot", 0, caps.takealot * 2 || 1), due("takealot", 1, caps.takealot * 2 || 1),
    due("page", 0, 8), due("page", 1, 8),
    env.DB.prepare("SELECT DISTINCT url FROM alerts WHERE status = 'active' AND test = 0"),
  ]);
  const rows = [...(ut.results || []), ...(st.results || []), ...(up.results || []), ...(sp.results || [])];
  const alerts = new Set((al.results || []).map((r) => r.url));
  const batch = pickBatch(rows, caps);

  // 2) Claim them (so an overlapping run skips them) and read their saved history, in one batch.
  if (batch.length) {
    const since = t0 - HISTORY_DAYS * 864e5;
    const res = await env.DB.batch([
      ...batch.map((r) => env.DB.prepare("UPDATE tracked SET next_check_at = ?, fails = COALESCE(fails, 0) + 1 WHERE url = ? AND next_check_at <= ? RETURNING url").bind(t0 + CLAIM_MS, r.url, t0)),
      ...batch.map((r) => env.DB.prepare("SELECT ts, price, was, currency FROM checks WHERE url = ? AND ts >= ? AND source IS NOT 'page-data' ORDER BY ts").bind(r.url, since)),
      ...batch.map((r) => env.DB.prepare("SELECT snap_ts, orig, price, was, currency, status FROM product_snaps WHERE url = ? AND snap_ts >= ? AND status NOT IN ('pending', 'retry')").bind(r.url, ymd(new Date(since)))),
      // Common Crawl rows for the whole batch (src/archive.js), in the same round trip.
      ...archiveBatchStmt(env, batch.map((r) => r.url), since),
    ]);
    const k = batch.length, memo = { robots: new Map(), dns: new Map() };
    const jobs = batch.map((r, i) => ({ row: r, claimed: (res[i].results || []).length > 0, hist: { checks: res[k + i].results || [], snaps: res[2 * k + i].results || [], cc: archiveRowsFor(r.url, res[3 * k] && res[3 * k].results) } })).filter((j) => j.claimed);
    sum.picked = jobs.length;
    // Takealot products one after another (polite to one host); the page product at the same time.
    const lanes = ["takealot", "page"].map((lane) => jobs.filter((j) => (j.row.lane === "takealot" ? "takealot" : "page") === lane));
    await Promise.all(lanes.map(async (list) => {
      for (const j of list) {
        try { await checkOne(env, j, alerts, memo, sum); }
        catch (e) {
          // Never let one product stop the run; it counts as a failed check.
          const t = now(), fails = (j.row.fails || 0) + 1;
          sum.failed++;
          await env.DB.prepare("UPDATE tracked SET last_checked = ?, last_status = 'error', check_count = check_count + 1, fails = ?, next_check_at = ? WHERE url = ?")
            .bind(t, fails, nextCheckAt({ t, ok: false, fails, lastViewed: j.row.last_viewed, alert: alerts.has(j.row.url) }), j.row.url).run().catch(() => {});
        }
      }
    }));
  }

  // 3) Seed list refresh (one department per seed slot, each about once a week).
  if (dept) await refreshSeeds(env, dept, sum).catch(async (e) => {
    sum.seed_error = String(e && e.message || e).slice(0, 120);
    await cachePut(env, "seed-dept:" + dept, { error: sum.seed_error }, HOUR_MS).catch(() => {});  // try this department again in an hour
  });
  sum.ms = now() - t0;
  console.log(JSON.stringify({ daily: sum }));
  return sum;
}

async function checkOne(env, job, alerts, memo, sum) {
  const row = job.row, t = now();
  const orig = sameProduct(row.orig_url, row.url) ? row.orig_url : row.url;
  const v = validateUrl(orig);
  const fails = (row.fails || 0) + 1;
  let cur = { status: "error", checked_at: t }, gone = false, note = null;
  if (!v.url) { gone = true; note = "bad-url"; }
  else if (blockedShopFor(v.url.href)) { gone = true; note = "blocked-shop"; }
  else {
    const canonInfo = canonicalize(v.url);
    // robots.txt is checked for the URL we really fetch: the API for an API shop reader (src/readers.js).
    const target = canonInfo.kind === "takealot" ? new URL(takealotApiUrl(canonInfo.plid)) : canonInfo.kind === "amazon" ? new URL(canonInfo.canon) : new URL(readerTarget(v.url.href));
    const checkHost = target.hostname.toLowerCase();
    // 1) The shop's address must be public (checked again on every run: DNS can change).
    if (!memo.dns.has(checkHost)) memo.dns.set(checkHost, await resolvesPublic(checkHost));
    if (memo.dns.get(checkHost) === null) note = "dns-unavailable";
    else if (!memo.dns.get(checkHost)) cur = { ...cur, message: "Couldn't verify a public address for the store." };
    else {
      // 2) robots.txt must allow the page, 3) then read the price.
      const robots = await robotsRules(env, target.origin, memo.robots);
      if (robots.retry) note = "robots-unavailable";
      else if (!robotsAllows(robots.rules, target.pathname + target.search)) { gone = true; note = "robots"; }
      else {
        cur = await getCurrent(canonInfo, v.url.href, checkHost, BOT_HEADERS);
        if (cur.http === 404 || cur.http === 410) gone = true;
      }
    }
  }
  const ok = cur.status === "ok" && !!cur.price;
  if (note === "robots-unavailable" || note === "dns-unavailable") {
    // Not the product's fault (robots.txt or DNS lookup did not answer): try again in an hour, without counting a failure.
    await env.DB.prepare("UPDATE tracked SET next_check_at = ?, fails = ? WHERE url = ?").bind(t + HOUR_MS, row.fails || 0, row.url).run();
    sum.skipped++; return;
  }
  const next = nextCheckAt({ t, ok, fails: ok ? 0 : fails, gone, lastViewed: row.last_viewed, alert: alerts.has(row.url) });
  const status = note || cur.status;
  const stmts = [];
  let j = null;
  if (ok) {
    stmts.push(checkStmt(env, row.url, cur, "daily"));
    const hist = { checks: [...job.hist.checks, { ts: cur.checked_at, price: cur.price, was: cur.was, currency: cur.currency }], snaps: job.hist.snaps, cc: job.hist.cc || [] };
    try { j = judge(cur, hist); } catch { j = null; }
    if (j && j.verdict) stmts.push(verdictStmt(env, row.url, cur.title || row.title, j));
    stmts.push(env.DB.prepare("UPDATE tracked SET last_checked = ?, last_status = ?, check_count = check_count + 1, fails = 0, next_check_at = ?, days = ?, title = COALESCE(?, title) WHERE url = ?")
      .bind(t, "ok", next, savedDays(hist.checks, t), cur.title || null, row.url));
  } else {
    stmts.push(env.DB.prepare("UPDATE tracked SET last_checked = ?, last_status = ?, check_count = check_count + 1, fails = ?, next_check_at = ? WHERE url = ?")
      .bind(t, status, fails, next, row.url));
  }
  await env.DB.batch(stmts);
  if (ok) sum.saved++; else sum.failed++;
  if (next === null) sum.paused++;
  if (ok && alerts.has(row.url)) await checkAlerts(env, row.url, cur, env.SITE_URL || "https://eish.veldwire.com").catch(() => {});
}

// The first department whose seed list is older than a week (or never read), or null.
async function dueSeedDept(env) {
  const keys = SEED_DEPTS.map((d) => "seed-dept:" + d);
  const fresh = await env.DB.prepare(`SELECT k FROM cache WHERE exp > ? AND k IN (${keys.map(() => "?").join(", ")})`).bind(now(), ...keys).all();
  const done = new Set((fresh.results || []).map((r) => r.k));
  return SEED_DEPTS.find((d) => !done.has("seed-dept:" + d)) || null;
}
async function refreshSeeds(env, dept, sum) {
  const t = now();
  sum.seed_dept = dept;
  const url = `https://${TAKEALOT_API_HOST}/rest/v-1-14-0/searches/products,breadcrumbs?sort=BestSelling&department_slug=${encodeURIComponent(dept)}`;
  const target = new URL(url);
  const robots = await robotsRules(env, target.origin, new Map());
  if (robots.retry) return;
  if (!robotsAllows(robots.rules, target.pathname + target.search)) { await cachePut(env, "seed-dept:" + dept, { robots: true }, SEED_REFRESH_MS); return; }
  const r = await fetchStore(url, { ...BOT_HEADERS, accept: "application/json" }, 12000);
  if (!r.ok) { await r.body?.cancel(); await cachePut(env, "seed-dept:" + dept, { http: r.status }, 6 * HOUR_MS); return; }
  const res = takealotSeeds(JSON.parse(await readLimitedText(r)), dept);
  if (res.error) { await cachePut(env, "seed-dept:" + dept, { error: res.error }, SEED_REFRESH_MS); sum.seed_error = res.error; return; }
  // New seed products only while there are fewer than MAX_SEEDS; products already tracked are
  // marked as still popular (last_viewed), so they keep their daily check.
  const stmts = res.seeds.map((s) => env.DB.prepare(`
    INSERT INTO tracked (url, orig_url, title, added_at, last_viewed, check_count, seed, lane, host, fails, next_check_at, days)
    SELECT ?, ?, ?, ?, ?, 0, 1, 'takealot', 'takealot.com', 0, ?, 0
    WHERE EXISTS (SELECT 1 FROM tracked WHERE url = ?) OR (SELECT COUNT(*) FROM tracked WHERE seed = 1) < ?
    ON CONFLICT(url) DO UPDATE SET last_viewed = excluded.last_viewed, title = COALESCE(tracked.title, excluded.title)
    WHERE tracked.last_viewed IS NULL OR tracked.last_viewed < excluded.last_viewed - ? OR (tracked.title IS NULL AND excluded.title IS NOT NULL)
    `).bind(s.url, s.url, s.title, t, t, t, s.url, MAX_SEEDS, 20 * HOUR_MS));
  const count = () => env.DB.prepare("SELECT COUNT(*) AS n FROM tracked WHERE seed = 1");
  const out = await env.DB.batch([count(), ...stmts, count()]);
  sum.seeds_added = out[out.length - 1].results[0].n - out[0].results[0].n;
  sum.seeds_seen = res.seeds.length;
  await cachePut(env, "seed-dept:" + dept, { n: res.seeds.length }, SEED_REFRESH_MS);
}

async function dailyHousekeeping(env) {
  const t = now();
  await env.DB.batch([
    // Seed products that have not been on a bestseller list for 60 days, and nobody checked.
    env.DB.prepare("DELETE FROM tracked WHERE seed = 1 AND last_viewed < ? AND url NOT IN (SELECT url FROM alerts WHERE status = 'active')").bind(t - SEED_DROP_MS),
    // People's products nobody viewed for 120 days. Their saved prices stay in `checks`.
    env.DB.prepare("DELETE FROM tracked WHERE seed = 0 AND last_viewed < ?").bind(t - 120 * 864e5),
  ]);
}

// ---------- status (counts only, no URLs) ----------
async function apiDailyStatus(env) {
  const c = await cacheGet(env, "daily-status-v1");
  if (c) return json(c, 200, { "cache-control": "public, max-age=300" });
  await ensureDailySchema(env);
  const t = now();
  const [tr, sv] = await env.DB.batch([
    env.DB.prepare("SELECT seed, COUNT(*) AS n, SUM(CASE WHEN next_check_at IS NULL THEN 1 ELSE 0 END) AS paused, SUM(CASE WHEN next_check_at <= ? THEN 1 ELSE 0 END) AS due, SUM(CASE WHEN last_status = 'ok' AND last_checked >= ? THEN 1 ELSE 0 END) AS ok_24h FROM tracked GROUP BY seed").bind(t, t - 864e5),
    env.DB.prepare("SELECT COUNT(*) AS n, MAX(ts) AS last FROM checks WHERE via = 'daily' AND ts >= ?").bind(t - 864e5),
  ]);
  const by = Object.fromEntries((tr.results || []).map((r) => [r.seed ? "seed" : "checked", { products: r.n, due_now: r.due || 0, paused: r.paused || 0, read_ok_last_24h: r.ok_24h || 0 }]));
  const s = (sv.results || [])[0] || {};
  const v = { schedule: "every minute, small batches", products: { checked_by_people: by.checked || { products: 0 }, popular_seed_list: by.seed || { products: 0 } }, daily_prices_saved_last_24h: s.n || 0, last_daily_save: s.last ? new Date(s.last).toISOString() : null, updated_at: new Date(t).toISOString() };
  await cachePut(env, "daily-status-v1", v, 5 * 60e3);
  return json(v, 200, { "cache-control": "public, max-age=300" });
}
