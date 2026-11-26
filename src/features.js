// ---------- Features: verdicts, wall, shop scores, other shops, alerts, share image, email ----------
// This file is joined with worker.js at build time (build.py), so it shares its helpers.

const DAY_MS = 864e5;
const WALL_MIN_JUDGED = 5;          // a shop score needs at least this many judged products
const RANK_MIN_PRODUCTS = 3;        // ... and at least this many products with saved prices
const RANK_MIN_DAYS = 7;            // ... on at least this many different days
// Share of judged products with a fake discount, in %, or null when the shop has too little data.
function shopScore(judged, fake, ready) {
  return judged >= WALL_MIN_JUDGED && ready >= RANK_MIN_PRODUCTS ? Math.round((fake / judged) * 100) : null;
}
const EMAIL_DAILY_CAP = 60;         // max emails per day, all kinds together
const ALERT_MAX_PER_EMAIL = 10;
const ALERT_DAYS = 180;

let featureTablesReady = false;
async function ensureFeatureTables(env) {
  if (featureTablesReady) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS verdicts (url TEXT PRIMARY KEY, host TEXT, title TEXT, verdict TEXT, price REAL, was REAL, currency TEXT, low REAL, med REAL, high REAL, high90 REAL, n INTEGER, gap REAL, archived INTEGER DEFAULT 0, low_t INTEGER, updated_at INTEGER)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_verdicts_v ON verdicts(verdict, gap)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, orig_url TEXT, title TEXT, email TEXT NOT NULL, target REAL NOT NULL, currency TEXT, token TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, sent_at INTEGER, last_price REAL, test INTEGER DEFAULT 0)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_alerts_url ON alerts(url, status)"),
  ]);
  featureTablesReady = true;
}

// ---------- verdict (same rules as the page) ----------
function median(a) { const s = [...a].sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; }
function historyPoints(hist, ccy, price) {
  const since = now() - HISTORY_DAYS * DAY_MS;
  const wb = hist.snaps.filter((s) => s.status === "ok" && s.price).map((s) => ({ t: tsToMs(s.snap_ts), price: s.price, was: s.was, currency: s.currency, kind: "archive" }));
  // Common Crawl copies (src/archive.js): first and last copy of each run of the same price.
  // The Internet Archive also holds copies of Common Crawl's crawls, so a Common Crawl price on the
  // same day as an Internet Archive price that matches is the same evidence: count it once.
  const day = (t) => new Date(t).toISOString().slice(0, 10);
  const wbSeen = new Set(wb.map((x) => day(x.t) + "|" + x.currency + "|" + x.price));
  const arch = wb.concat(archivePoints(hist.cc || [], since, price)
    .filter((p) => !wbSeen.has(day(p.t) + "|" + p.currency + "|" + p.price))
    .map((p) => ({ t: p.t, price: p.price, was: p.was, currency: p.currency, kind: "cc", link: p.link })));
  const byDay = new Map();
  for (const c of hist.checks) if (c.price) byDay.set(new Date(c.ts).toISOString().slice(0, 10), { t: c.ts, price: c.price, was: c.was, currency: c.currency, kind: "check" });
  const all = arch.concat([...byDay.values()]).filter((x) => x.t >= since);
  const pick = ccy || (all.find((x) => x.currency) || {}).currency;
  return { pts: all.filter((x) => pick && x.currency === pick).sort((a, b) => a.t - b.t), ccy: pick };
}
// With only 1 or 2 older prices we still show real evidence: one older price from the last 6 months
// that is clearly under the shop's "was" price, or at or under today's price. Never a guess.
const SPARSE_DAYS = 183;
// A move only counts when it is big enough to matter: at least 5 % and at least R5 (0.50 in pounds and
// other currencies). Smaller moves are "Same old price" / "Seen at this price before".
const MOVE_PCT = 0.05;
const minMove = (ccy) => (ccy === "ZAR" ? 5 : 0.5);
const bigMove = (from, to, ccy) => Math.abs(to - from) >= Math.max(MOVE_PCT * from, minMove(ccy));
const SPARSE_VERDICTS = ["Likely inflated was price", "Seen cheaper before", "Seen at this price before"];
function sparseEvidence(P, W, h, C) {
  const recent = h.filter((x) => x.t >= now() - SPARSE_DAYS * DAY_MS && x.price > 0);
  if (!P || !recent.length) return null;
  const pt = recent.reduce((m, x) => (x.price < m.price || (x.price === m.price && x.t > m.t) ? x : m));
  const maxOld = Math.max(...recent.map((x) => x.price));
  // "Inflated" needs a price from at least 2 weeks ago: a sale that started a few days ago is not a fake.
  const old = recent.filter((x) => x.t <= now() - 14 * DAY_MS);
  if (W && W > P && old.length) {
    const o = old.reduce((m, x) => (x.price < m.price ? x : m));
    if (o.price <= W * 0.9 && maxOld < W * 0.97) return { verdict: "Likely inflated was price", pt: o };
  }
  if (pt.price < P && bigMove(pt.price, P, C)) return { verdict: "Seen cheaper before", pt };
  if (pt.price <= P || !bigMove(pt.price, P, C)) return { verdict: "Seen at this price before", pt };
  return null;
}
function judge(current, hist) {
  let cur = current && current.status === "ok" && current.price && current.currency ? { price: current.price, was: current.was, currency: current.currency } : null;
  const { pts, ccy } = historyPoints(hist, cur && cur.currency, cur && cur.price);
  let h = pts.filter((x) => x.t < now() - DAY_MS), archived = 0;
  if (!cur && ccy && h.length >= 4) { const last = h[h.length - 1]; cur = { price: last.price, was: last.was, currency: ccy }; h = h.slice(0, -1); archived = 1; }
  const out = { verdict: null, n: h.length, pts, archived };
  if (!cur) return out;
  Object.assign(out, { price: cur.price, was: cur.was || null, currency: cur.currency });
  if (h.length < 3) {
    const ev = sparseEvidence(cur.price, cur.was, h, cur.currency);
    if (!ev) { out.verdict = "Not enough history"; return out; }
    return Object.assign(out, { verdict: ev.verdict, low: ev.pt.price, low_t: ev.pt.t, evidence: { price: ev.pt.price, t: ev.pt.t, kind: ev.pt.kind } });
  }
  const pr = h.map((x) => x.price), p90 = h.filter((x) => x.t >= now() - 90 * DAY_MS).map((x) => x.price);
  const low = Math.min(...pr), high = Math.max(...pr), med = median(pr), high90 = p90.length >= 2 ? Math.max(...p90) : high;
  const P = cur.price, W = cur.was, vsMed = (med - P) / med, inflated = W && W > high90 * 1.03;
  const cheaper = P < med && bigMove(med, P, cur.currency), dearer = P > med && bigMove(med, P, cur.currency);
  let v;
  if (P <= low * 1.005 && cheaper) v = "Real deal";
  else if (inflated && !cheaper) v = "Fake discount";
  else if (dearer) v = "Pricier than usual";
  else if (cheaper) v = "Decent deal";
  else v = "Same old price";
  const lowPt = h.reduce((m, x) => (x.price < m.price ? x : m));
  return Object.assign(out, { verdict: v, low, med, high, high90, gap: v === "Fake discount" ? (W - high90) / high90 : null, low_t: lowPt.t });
}
async function saveVerdict(env, canon, title, j) {
  if (!j.verdict) return;
  await ensureFeatureTables(env);
  await verdictStmt(env, canon, title, j).run();
}
function verdictStmt(env, canon, title, j) {
  const host = stripWww(new URL(canon).hostname.toLowerCase());
  return env.DB.prepare(`INSERT INTO verdicts (url, host, title, verdict, price, was, currency, low, med, high, high90, n, gap, archived, low_t, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET host = excluded.host, title = COALESCE(excluded.title, verdicts.title), verdict = excluded.verdict, price = excluded.price, was = excluded.was, currency = excluded.currency, low = excluded.low, med = excluded.med, high = excluded.high, high90 = excluded.high90, n = excluded.n, gap = excluded.gap, archived = excluded.archived, low_t = excluded.low_t, updated_at = excluded.updated_at
    WHERE verdicts.verdict IS NOT excluded.verdict OR verdicts.price IS NOT excluded.price OR verdicts.was IS NOT excluded.was OR verdicts.currency IS NOT excluded.currency
      OR verdicts.low IS NOT excluded.low OR verdicts.med IS NOT excluded.med OR verdicts.high IS NOT excluded.high OR verdicts.high90 IS NOT excluded.high90
      OR verdicts.n IS NOT excluded.n OR verdicts.gap IS NOT excluded.gap OR verdicts.archived IS NOT excluded.archived OR verdicts.low_t IS NOT excluded.low_t
      OR verdicts.host IS NOT excluded.host OR (excluded.title IS NOT NULL AND verdicts.title IS NOT excluded.title)`)
    .bind(canon, host, title || null, j.verdict, j.price ?? null, j.was ?? null, j.currency ?? null, j.low ?? null, j.med ?? null, j.high ?? null, j.high90 ?? null, j.n, j.gap ?? null, j.archived, j.low_t ?? null, now());
}
async function latestCurrent(env, canon) {
  const c = await cacheGet(env, LIVE_CACHE_PREFIX + canon);
  if (c && c.status === "ok") return c;
  const r = await env.DB.prepare("SELECT ts, price, was, currency, title FROM checks WHERE url = ? AND price IS NOT NULL ORDER BY ts DESC LIMIT 1").bind(canon).first();
  if (r && r.ts > now() - 3 * DAY_MS) return { status: "ok", price: r.price, was: r.was, currency: r.currency, title: r.title, checked_at: r.ts };
  return c || null;
}
async function refreshVerdict(env, canon) {
  const cur = await latestCurrent(env, canon);
  const hist = await storedHistory(env, canon);
  const j = judge(cur, hist);
  const t = await env.DB.prepare("SELECT title FROM tracked WHERE url = ?").bind(canon).first();
  await saveVerdict(env, canon, (cur && cur.title) || (t && t.title), j);
  return j;
}
// Deal Score from history only (src/score.js). The page adds the other shops when compare is done.
// No live price (only an archived one): no score.
const publicDeal = (j) => {
  if (!j || !j.price || !j.currency || j.archived) return null;
  const d = dealScore({ P: j.price, W: j.was, C: j.currency, pts: j.pts, now: now() });
  return { score: d.score, action: d.action, reasons: d.reasons };
};
const publicVerdict = (j) => j && j.verdict ? { verdict: j.verdict, price: j.price, was: j.was, currency: j.currency, n: j.n, low: j.low ?? null, low_t: j.low_t ?? null, med: j.med ?? null } : null;

async function apiVerdict(req, env) {
  const ip = req.headers.get("cf-connecting-ip") || "0";
  const canon = new URL(req.url).searchParams.get("url") || "";
  const tr = await env.DB.prepare("SELECT url FROM tracked WHERE url = ?").bind(canon).first();
  if (!tr) return json({ error: "Check the product first." }, 403);
  if (await rateLimit(env, ip, "verdict")) return json({ error: "rate limited" }, 429);
  return json({ verdict: publicVerdict(await refreshVerdict(env, canon)) });
}

// ---------- wall, shop scores, counter ----------
function shopName(host) { const s = shopFor(host) || blockedShopFor("https://" + host + "/"); return s ? s.name : host; }
async function wallData(env) {
  const cached = await cacheGet(env, "wall-v1");
  if (cached) return cached;
  await ensureFeatureTables(env);
  const fakes = await env.DB.prepare("SELECT url, host, title, price, was, currency, high90, gap, archived, updated_at FROM verdicts WHERE verdict = 'Fake discount' AND gap IS NOT NULL ORDER BY gap DESC LIMIT 30").all();
  const shops = await env.DB.prepare("SELECT host, COUNT(*) AS products, SUM(CASE WHEN verdict IN ('Real deal', 'Decent deal', 'Same old price', 'Pricier than usual', 'Fake discount') THEN 1 ELSE 0 END) AS judged, SUM(CASE WHEN verdict = 'Fake discount' THEN 1 ELSE 0 END) AS fake FROM verdicts GROUP BY host ORDER BY judged DESC, products DESC LIMIT 40").all();
  const checks = await env.DB.prepare("SELECT t.url AS url, COUNT(c.id) AS n FROM tracked t JOIN checks c ON c.url = t.url GROUP BY t.url").all().catch(() => ({ results: [] }));
  const perHost = {};
  for (const r of checks.results || []) { try { const h = stripWww(new URL(r.url).hostname.toLowerCase()); perHost[h] = (perHost[h] || 0) + r.n; } catch {} }
  const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM verdicts WHERE verdict = 'Fake discount'").first();
  // A shop gets a score only when enough of its products have real saved history (see shopScore).
  const ready = await env.DB.prepare("SELECT host, SUM(CASE WHEN days >= ? THEN 1 ELSE 0 END) AS n FROM tracked GROUP BY host").bind(RANK_MIN_DAYS).all().catch(() => ({ results: [] }));
  const readyBy = Object.fromEntries((ready.results || []).map((r) => [r.host, r.n || 0]));
  const val = {
    fakes: (fakes.results || []).map((r) => ({ ...r, shop: shopName(r.host) })),
    shops: (shops.results || []).map((r) => ({ host: r.host, shop: shopName(r.host), products: r.products, judged: r.judged, fake: r.fake, checks: perHost[r.host] || 0, ready: readyBy[r.host] || 0, pct: shopScore(r.judged, r.fake, readyBy[r.host] || 0) })),
    fake_total: total ? total.n : 0, min_judged: WALL_MIN_JUDGED, rank_min_products: RANK_MIN_PRODUCTS, rank_min_days: RANK_MIN_DAYS, updated_at: now(),
  };
  await cachePut(env, "wall-v1", val, 10 * 60e3);
  return val;
}

// ---------- same product, other shops: see compare.js ----------

// ---------- email ----------
const emailReady = (env) => !!(env.EMAIL && typeof env.EMAIL.send === "function" && env.MAIL_FROM);
const alertsOn = (env) => emailReady(env) && env.ALERTS === "on";
async function sendMail(env, msg) {
  if (!emailReady(env)) return { ok: false, error: "email not set up" };
  const day = new Date().toISOString().slice(0, 10);
  const r = await env.DB.prepare("INSERT INTO rl (k, n, win) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = rl.n + 1 RETURNING n").bind("mail:" + day, Math.floor(now() / 60000) + 2000).first();
  if (r && r.n > EMAIL_DAILY_CAP) return { ok: false, error: "daily email cap" };
  try {
    const res = await env.EMAIL.send({ from: { email: env.MAIL_FROM, name: "Deal or Dud?" }, ...msg });
    return { ok: true, id: res && res.messageId };
  } catch (e) { return { ok: false, error: String((e && (e.code || e.message)) || e).slice(0, 160) }; }
}
const escHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
async function notifyOwnerOfRequest(env, row) {
  if (!env.OWNER_EMAIL) return { ok: false, error: "no owner address" };
  const lines = [`Shop: ${row.shop}`, `Website: ${row.host || "-"}`, `Product link: ${row.product || "-"}`, `Email for update: ${row.email || "-"}`, `Time: ${new Date().toISOString()}`];
  return sendMail(env, {
    to: env.OWNER_EMAIL, subject: `Shop request: ${row.host || row.shop}`.slice(0, 120),
    text: "Someone asked us to add a shop to Deal or Dud?\n\n" + lines.join("\n") + "\n",
    html: "<p>Someone asked us to add a shop to Deal or Dud?</p><ul>" + lines.map((l) => `<li>${escHtml(l)}</li>`).join("") + "</ul>",
    ...(row.email ? { replyTo: row.email } : {}),
  });
}

// ---------- price drop alerts ----------
async function apiAlert(req, env, ctx) {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!/application\/json/i.test(req.headers.get("content-type") || "")) return json({ error: "Send the form as JSON." }, 415);
  const test = isE2E(req, env);
  if (!alertsOn(env) && !test) return json({ error: "Price alerts are not available yet." }, 503);
  const ip = req.headers.get("cf-connecting-ip") || "0";
  let b; try { const t = await req.text(); if (t.length > 4000) return json({ error: "The request is too long." }, 413); b = JSON.parse(t); } catch { return json({ error: "We could not read the form." }, 400); }
  if (!b || typeof b !== "object") return json({ error: "We could not read the form." }, 400);
  if (b.website) return json({ ok: true });
  if (!test && !(await verifyTurnstile(env, b.ts, ip))) return json({ error: "We could not check that you are a person. Try again." }, 403);
  const email = String(b.email || "").trim().slice(0, 254), target = parseTextPrice(b.target, { currency: true }), canon = String(b.url || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json({ error: "Check the email address." }, 400);
  if (!target) return json({ error: "Type the price you want to pay." }, 400);
  if (await rateLimit(env, ip, "req")) return json({ error: "You sent many requests. Try again in a minute." }, 429);
  const tr = await env.DB.prepare("SELECT url, orig_url, title FROM tracked WHERE url = ?").bind(canon).first();
  if (!tr) return json({ error: "Check the product first." }, 403);
  await ensureFeatureTables(env);
  const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM alerts WHERE email = ? AND status IN ('pending', 'active')").bind(email).first();
  if (cnt && cnt.n >= ALERT_MAX_PER_EMAIL) return json({ error: `You have ${ALERT_MAX_PER_EMAIL} alerts already. Stop one first.` }, 400);
  const cur = await latestCurrent(env, canon);
  const token = (await sha256(crypto.randomUUID() + email)).slice(0, 32);
  const row = await env.DB.prepare("INSERT INTO alerts (url, orig_url, title, email, target, currency, token, status, created_at, last_price, test) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?) RETURNING id")
    .bind(canon, tr.orig_url, (cur && cur.title) || tr.title || null, email, target, (cur && cur.currency) || tldCurrency(new URL(canon).hostname) || null, token, now(), (cur && cur.price) || null, test ? 1 : 0).first();
  const base = new URL(req.url).origin;
  const confirm = `${base}/alert/confirm?id=${row.id}&t=${token}`, stop = `${base}/alert/stop?id=${row.id}&t=${token}`;
  if (!test) {
    const m = await sendMail(env, { to: email, subject: "Confirm your price alert", text: `Click this link to start the price alert for ${(cur && cur.title) || canon}:\n${confirm}\n\nWe will send one email when the price is ${target} or lower.\nTo stop: ${stop}\n`, html: `<p>Click to start the price alert for <b>${escHtml((cur && cur.title) || canon)}</b>:</p><p><a href="${confirm}">Start the alert</a></p><p>We will send one email when the price is ${escHtml(target)} or lower.</p><p><a href="${stop}">Stop this alert</a></p>` });
    if (!m.ok) { await env.DB.prepare("DELETE FROM alerts WHERE id = ?").bind(row.id).run(); return json({ error: "We could not send the email. Try again later." }, 502); }
  }
  return json({ ok: true, ...(test ? { id: row.id, confirm, stop } : {}) });
}
function smallPage(title, body) {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(title)}</title><style>body{font:16px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:480px;margin:0 auto;padding:48px 16px;color:#111214}a{color:inherit}@media (prefers-color-scheme:dark){body{background:#111214;color:#eceef1}}</style><h1 style="font-size:24px">${escHtml(title)}</h1><p>${escHtml(body)}</p><p><a href="/">Go to Deal or Dud?</a></p>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}
async function alertLink(req, env, action) {
  const p = new URL(req.url).searchParams;
  const id = parseInt(p.get("id") || "", 10), t = p.get("t") || "";
  if (!id || !/^[0-9a-f]{32}$/.test(t)) return smallPage("Link not valid", "This link is not complete. Copy the full link from the email.");
  await ensureFeatureTables(env);
  const row = await env.DB.prepare("SELECT id, status FROM alerts WHERE id = ? AND token = ?").bind(id, t).first();
  if (!row) return smallPage("Alert not found", "This alert does not exist or was removed.");
  if (action === "stop") { await env.DB.prepare("UPDATE alerts SET status = 'stopped' WHERE id = ?").bind(id).run(); return smallPage("Alert stopped", "We will not send more emails for this alert."); }
  if (row.status === "pending") await env.DB.prepare("UPDATE alerts SET status = 'active' WHERE id = ?").bind(id).run();
  return smallPage(row.status === "stopped" ? "Alert stopped" : "Alert started", row.status === "stopped" ? "This alert was stopped before." : "We will send you one email when the price drops to your price.");
}
async function checkAlerts(env, canon, cur, base) {
  if (!cur || cur.status !== "ok" || !cur.price) return;
  await ensureFeatureTables(env);
  const rows = await env.DB.prepare("SELECT id, email, target, currency, token, title FROM alerts WHERE url = ? AND status = 'active' AND test = 0 AND target >= ?").bind(canon, cur.price).all();
  for (const a of rows.results || []) {
    if (a.currency && cur.currency && a.currency !== cur.currency) continue;
    if (!alertsOn(env)) continue;
    const stop = `${base}/alert/stop?id=${a.id}&t=${a.token}`, look = `${base}/?u=${encodeURIComponent(canon)}`;
    const m = await sendMail(env, { to: a.email, subject: `Price drop: ${(a.title || "your product").slice(0, 80)}`, text: `The price is now ${cur.price} ${cur.currency || ""}. Your price was ${a.target}.\nSee the price history: ${look}\nShop: ${canon}\n\nThis was a one-time alert. Stop link: ${stop}\n`, html: `<p>The price of <b>${escHtml(a.title || canon)}</b> is now <b>${escHtml(cur.price)} ${escHtml(cur.currency || "")}</b>. Your price was ${escHtml(a.target)}.</p><p><a href="${look}">See the price history</a> · <a href="${escHtml(canon)}">Open the shop</a></p><p style="color:#666">This was a one-time alert. <a href="${stop}">Stop</a></p>` });
    if (m.ok) await env.DB.prepare("UPDATE alerts SET status = 'sent', sent_at = ?, last_price = ? WHERE id = ?").bind(now(), cur.price, a.id).run();
  }
}

// ---------- test runs ----------
function isE2E(req, env) { const k = req.headers.get("x-e2e-key"); return !!(env.E2E_KEY && k && k.length >= 16 && k === env.E2E_KEY); }
// Sends one test shop-request email to the owner and shows the result (never the address).
async function apiMailTest(req, env) {
  if (req.method !== "POST" || !isE2E(req, env)) return json({ error: "not found" }, 404);
  const r = await notifyOwnerOfRequest(env, { shop: "Test request (setup check)", host: "example.co.za", product: "https://www.example.co.za/test-product", email: "" });
  return json({ email_ready: emailReady(env), owner_set: !!env.OWNER_EMAIL, ...r });
}
async function apiE2ECleanup(req, env) {
  if (req.method !== "POST" || !isE2E(req, env)) return json({ error: "not found" }, 404);
  await ensureFeatureTables(env); await ensureRequestsTable(env);
  const a = await env.DB.prepare("DELETE FROM alerts WHERE test = 1").run();
  const s = await env.DB.prepare("DELETE FROM shop_requests WHERE shop_text LIKE 'e2e-test%'").run();
  return json({ ok: true, alerts: a.meta.changes, shop_requests: s.meta.changes });
}

// ---------- bot protection ----------
const turnstileOn = (env) => !!(env.TURNSTILE_SITEKEY && env.TURNSTILE_SECRET);
async function verifyTurnstile(env, token, ip) {
  if (!turnstileOn(env)) return true;
  if (!token || typeof token !== "string" || token.length > 2048) return false;
  try {
    const body = new FormData(); body.append("secret", env.TURNSTILE_SECRET); body.append("response", token); body.append("remoteip", ip);
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body, signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    return !!d.success;
  } catch { return false; }
}
const BAD_UA = /bot\b|bot\/|crawl|spider|slurp|scrapy|python-requests|python-urllib|aiohttp|httpx|go-http-client|wget|libwww|java\/|okhttp/i;
// Light checks for the API: no empty or scraper user agents, and no calls from other websites' pages.
function apiGuard(req) {
  const ua = req.headers.get("user-agent") || "";
  if (!ua || BAD_UA.test(ua)) return json({ error: "Automated requests are not allowed. Use the website." }, 403);
  const site = req.headers.get("sec-fetch-site");
  if (site === "cross-site") return json({ error: "Use the website to check prices." }, 403);
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) return json({ error: "Use the website to check prices." }, 403);
  return null;
}

// ---------- price history per shop (shops list) ----------
// Counted from what we really hold, never a fixed list: per product, its older prices (older than a day,
// last 12 months) from our saved checks (daily saving included), Wayback copies we read, and Common Crawl
// rows. Cached in D1; a stale copy is served at once and rebuilt in the background.
const SHOP_HISTORY_KEY = "shop-history-v1";
const SHOP_HISTORY_FRESH_MS = 6 * 3600e3;
const SHOP_HISTORY_KEEP_MS = 7 * DAY_MS;
const HISTORY_GOOD = 25;      // products with 3+ older prices for "good"
const HISTORY_SOME = 3;       // products with 3+ older prices for "some" ...
const HISTORY_SOME_ANY = 10;  // ... or products with at least one older price
function historyLevel(full, any) {
  if (full >= HISTORY_GOOD) return "good";
  if (full >= HISTORY_SOME || any >= HISTORY_SOME_ANY) return "some";
  return "building";
}
// One key per product across sources: host without www, path without a trailing slash, query kept.
function historyProductKey(u) {
  try { const x = new URL(String(u).replace(/^http:/i, "https:")); return stripWww(x.hostname.toLowerCase()) + (x.pathname.replace(/\/+$/, "") || "/") + x.search; } catch { return null; }
}
async function computeShopHistory(env) {
  const t = now(), since = t - HISTORY_DAYS * DAY_MS, older = t - DAY_MS;
  // Count distinct days with an older price per product, over all three sources, so the same day
  // seen by our own check, the Internet Archive and Common Crawl counts once.
  const per = new Map();   // product key -> { days: Set, url }
  const add = (url, day) => { const k = historyProductKey(url); if (!k || day == null) return; const e = per.get(k) || { days: new Set(), url }; e.days.add(String(day)); per.set(k, e); };
  const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
  const q = async (sql, ...b) => { try { return (await env.DB.prepare(sql).bind(...b).all()).results || []; } catch { return []; } };
  const [checks, snaps, cc] = await Promise.all([
    q("SELECT url, CAST(ts / 86400000 AS INTEGER) AS d FROM checks WHERE price IS NOT NULL AND ts >= ? AND ts < ? AND source IS NOT 'page-data' GROUP BY url, d", since, older),
    q("SELECT url, substr(snap_ts, 1, 8) AS d FROM product_snaps WHERE status = 'ok' AND price IS NOT NULL AND snap_ts >= ? GROUP BY url, d", ymd(new Date(since))),
    q("SELECT product_key AS url, captured_at AS a, last_seen AS b FROM archive_prices WHERE last_seen >= ? AND captured_at < ?", since, older),
  ]);
  for (const r of checks) add(r.url, dayOf(r.d * DAY_MS));
  for (const r of snaps) add(r.url, r.d);
  for (const r of cc) { if (r.a >= since) add(r.url, dayOf(r.a)); if (r.b > r.a && r.b < older) add(r.url, dayOf(r.b)); }
  const shops = {};
  for (const s of SHOPS) shops[s.name] = { any: 0, full: 0 };
  for (const e of per.values()) {
    const s = shopFor(e.url);
    if (!s || !shops[s.name]) continue;
    shops[s.name].any++;
    if (e.days.size >= 3) shops[s.name].full++;
  }
  for (const k of Object.keys(shops)) shops[k].level = historyLevel(shops[k].full, shops[k].any);
  return { updated_at: t, shops };
}
async function shopHistory(env, ctx) {
  let c = null;
  try { c = await cacheGet(env, SHOP_HISTORY_KEY); } catch {}
  const rebuild = async () => { const v = await computeShopHistory(env); try { await cachePut(env, SHOP_HISTORY_KEY, v, SHOP_HISTORY_KEEP_MS); } catch {} return v; };
  if (c && c.shops) {
    if (now() - c.updated_at > SHOP_HISTORY_FRESH_MS && ctx && ctx.waitUntil) ctx.waitUntil(rebuild().catch(() => {}));
    return c;
  }
  return rebuild();
}
const SHOP_COUNTRY = { ZA: "South Africa", UK: "United Kingdom", DE: "Germany" };
// Plain words for the shops list (sent with /api/shops so the first page view stays small).
function historyNote(level) {
  return level === "good" || level === "some" ? `Price history: ${level}` : "We read today's price. History is building up.";
}
async function apiShops(env, ctx) {
  let h = null;
  try { h = await shopHistory(env, ctx); } catch {}
  return json({
    shops: SHOPS.map(({ name, cc, d }) => {
      const x = h && h.shops[name];
      return { name, cc, where: SHOP_COUNTRY[cc] || cc, host: d[0], history: x ? x.level : null, note: x ? historyNote(x.level) : "", products_with_history: x ? x.full : null, products_with_any: x ? x.any : null };
    }),
    history_updated_at: h ? h.updated_at : null,
  }, 200, { "cache-control": "public, max-age=900" });
}
