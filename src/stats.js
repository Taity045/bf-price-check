// ---------- private stats (cookieless, aggregate only) ----------
// What we count, per day (South African time): page views, unique-ish visitors, price checks and
// their outcomes, shops, button clicks, countries, referrer domains and device types. Only daily
// totals are stored (table m_counts). A visitor is a SHA-256 hash of a random salt + IP + browser,
// truncated; the salt changes every day and the old salt and hashes are deleted, so a visitor can't
// be followed from one day to the next and the hash can't be turned back into an IP. No cookies,
// no client library: the page sends one small sendBeacon per tracked button press.
// The dashboard lives on its own host (STATS_HOST, default stats.veldwire.com) behind Cloudflare
// Access. The worker checks the Access JWT itself and fails closed: no valid token = 403.
const STATS_HOST_DEFAULT = "stats.veldwire.com";
const M_OFFSET_MS = 2 * 3600e3;            // Africa/Johannesburg is UTC+2 all year (no daylight saving)
const M_KEEP_DAYS = 400;
const M_CLICKS = ["share", "share_whatsapp", "share_copy", "share_more", "save", "compare_open", "request_open", "saved_open", "shops_open", "example"];
const M_OUTCOMES = ["ok", "noprice", "blocked", "error", "invalid", "rate_limited"];
const M_BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|discord|slack|skype|headless|lighthouse|pagespeed|pingdom|uptime|monitor|curl|wget|python|node|axios|undici|go-http|java\/|okhttp|scrapy|httpx|libwww|smoke|playwright|puppeteer|phantom/i;

const mDay = (t = now()) => new Date(t + M_OFFSET_MS).toISOString().slice(0, 10);
const mHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function mSha(s) { return mHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); }

function mHuman(req) {
  const ua = req.headers.get("user-agent") || "";
  return /^Mozilla\/5\.0 \(/.test(ua) && !M_BOT.test(ua) && req.headers.get("purpose") !== "prefetch" && req.headers.get("sec-purpose") == null;
}
function mDevice(ua) {
  ua = String(ua || "");
  if (/iPad|Tablet|PlayBook|Silk|Kindle|(Android(?!.*Mobile))/i.test(ua)) return "tablet";
  if (/Mobi|iPhone|iPod|Android|Windows Phone|Opera Mini/i.test(ua)) return "phone";
  return "desktop";
}
// The referring site's domain only (never the path). null = our own site, which we don't count.
function mRefDomain(ref, selfHost) {
  if (!ref) return "direct";
  let h;
  try { const u = new URL(ref); if (!/^https?:$/.test(u.protocol)) return "other"; h = stripWww(u.hostname.toLowerCase()); } catch { return "other"; }
  if (h === stripWww(String(selfHost || "").toLowerCase()) || h === "veldwire.com" || h.endsWith(".veldwire.com") || h.endsWith(".workers.dev")) return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) || h.length > 80) return "other";
  if (/(^|\.)(google)\.[a-z.]+$/.test(h)) return "google";
  if (/(^|\.)(facebook\.com|fb\.com|l\.facebook\.com|lm\.facebook\.com)$/.test(h)) return "facebook.com";
  if (h === "t.co" || h === "x.com" || h === "twitter.com") return "x.com";
  return h;
}
function mCountry(req) { const c = String((req.cf && req.cf.country) || "").toUpperCase(); return /^[A-Z][A-Z0-9]$/.test(c) ? c : "XX"; }
// Requests from the browser tests (x-e2e-key) are not counted, unless the local test worker asks for it.
const mSkip = (req, env) => isE2E(req, env) && env.STATS_COUNT_E2E !== "1";

let mReady = false;
async function mTables(env) {
  if (mReady) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS m_counts (day TEXT NOT NULL, metric TEXT NOT NULL, key TEXT NOT NULL DEFAULT '', n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, metric, key))"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS m_seen (day TEXT NOT NULL, h TEXT NOT NULL, PRIMARY KEY (day, h))"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS m_salt (day TEXT PRIMARY KEY, salt TEXT NOT NULL)"),
  ]);
  mReady = true;
}
const mInc = (env, day, metric, key = "", by = 1) => env.DB.prepare("INSERT INTO m_counts (day, metric, key, n) VALUES (?, ?, ?, ?) ON CONFLICT (day, metric, key) DO UPDATE SET n = n + excluded.n").bind(day, metric, String(key).slice(0, 80), by);

let mSaltMem = null;
// Today's salt. The first visit of a new day makes it and deletes older salts and visitor hashes.
async function mSalt(env, day) {
  if (mSaltMem && mSaltMem.day === day) return mSaltMem.salt;
  let row = await env.DB.prepare("SELECT salt FROM m_salt WHERE day = ?").bind(day).first();
  if (!row) {
    const salt = mHex(crypto.getRandomValues(new Uint8Array(16)));
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO m_salt (day, salt) VALUES (?, ?)").bind(day, salt),
      env.DB.prepare("DELETE FROM m_salt WHERE day < ?").bind(day),
      env.DB.prepare("DELETE FROM m_seen WHERE day < ?").bind(day),
      env.DB.prepare("DELETE FROM m_counts WHERE day < ?").bind(mDay(now() - M_KEEP_DAYS * 864e5)),
    ]);
    row = await env.DB.prepare("SELECT salt FROM m_salt WHERE day = ?").bind(day).first();
  }
  mSaltMem = { day, salt: row.salt };
  return row.salt;
}

async function statsPageView(req, env) {
  if (mSkip(req, env)) return;
  await mTables(env);
  const day = mDay();
  if (!mHuman(req)) { await mInc(env, day, "bot").run(); return; }
  const ua = req.headers.get("user-agent") || "", url = new URL(req.url);
  const salt = await mSalt(env, day);
  const h = (await mSha(salt + "|" + (req.headers.get("cf-connecting-ip") || "") + "|" + ua)).slice(0, 20);
  const fresh = await env.DB.prepare("INSERT OR IGNORE INTO m_seen (day, h) VALUES (?, ?)").bind(day, h).run();
  const ref = mRefDomain(req.headers.get("referer"), url.hostname);
  const s = [mInc(env, day, "pv")];
  if (ref) s.push(mInc(env, day, "ref", ref));
  if (url.searchParams.has("u")) s.push(mInc(env, day, "event", "shared_link_open"));
  const isNew = !!(fresh.meta && fresh.meta.changes > 0);
  if (isNew) s.push(mInc(env, day, "visitors"), mInc(env, day, "country", mCountry(req)), mInc(env, day, "device", mDevice(ua)));
  await env.DB.batch(s);
  return { day, h, ref, isNew };
}

// POST /api/e2e/stats-probe (test key only): runs one made-up page view through the real counting
// code on the live database, checks that it was counted, then takes it back out. Answers only
// yes/no, never the stats themselves.
async function statsProbe(req, env) {
  if (req.method !== "POST" || !isE2E(req, env)) return json({ error: "not found" }, 404);
  await mTables(env);
  const day = mDay();
  const get = async () => Object.fromEntries(((await env.DB.prepare("SELECT metric, n FROM m_counts WHERE day = ? AND key = '' AND metric IN ('pv', 'visitors')").bind(day).all()).results || []).map((r) => [r.metric, r.n]));
  const before = await get();
  const ip = "198.51.100." + (1 + Math.floor(Math.random() * 250)) + "-" + mHex(crypto.getRandomValues(new Uint8Array(4)));
  const fake = new Request(new URL("/", req.url), { headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36", "cf-connecting-ip": ip, referer: "https://stats-probe.invalid/" } });
  const r = await statsPageView(fake, env);
  const after = await get();
  const pv = (after.pv || 0) - (before.pv || 0) >= 1, visitor = (after.visitors || 0) - (before.visitors || 0) >= 1;
  // take the made-up visit back out
  const undo = [mInc(env, r.day, "pv", "", -1), mInc(env, r.day, "ref", r.ref, -1), env.DB.prepare("DELETE FROM m_seen WHERE day = ? AND h = ?").bind(r.day, r.h)];
  if (r.isNew) undo.push(mInc(env, r.day, "visitors", "", -1), mInc(env, r.day, "country", "XX", -1), mInc(env, r.day, "device", "desktop", -1));
  undo.push(env.DB.prepare("DELETE FROM m_counts WHERE day = ? AND n <= 0").bind(r.day));
  await env.DB.batch(undo);
  const back = await get();
  return json({ page_view_counted: pv, visitor_counted: visitor, removed_again: (back.pv || 0) === (before.pv || 0) && (back.visitors || 0) === (before.visitors || 0) });
}

// Counts an API answer after it is sent (reads a copy of the response; never delays the answer).
function statsTap(req, env, ctx, kind, res) {
  try {
    if (!ctx || mSkip(req, env) || !mHuman(req)) return res;
    const copy = res.clone(), status = res.status;
    ctx.waitUntil((async () => {
      await mTables(env);
      const day = mDay();
      if (kind === "check") {
        if (status === 400) return void await mInc(env, day, "outcome", "invalid").run();
        if (status === 429) return void await mInc(env, day, "outcome", "rate_limited").run();
        if (status !== 200) return void await mInc(env, day, "outcome", "error").run();
        const d = await copy.json();
        const st = d.current && d.current.status;
        const outcome = st === "ok" || st === "noprice" || st === "blocked" ? st : "error";
        const host = String(d.host || "").toLowerCase().slice(0, 80) || "unknown";
        const s = [mInc(env, day, "check"), mInc(env, day, "outcome", outcome), mInc(env, day, "shop", host)];
        if (outcome === "ok") s.push(mInc(env, day, "shop_ok", host));
        await env.DB.batch(s);
      } else if (kind === "others" && status === 200) {
        const d = await copy.json();
        await env.DB.batch([mInc(env, day, "event", "compare_search"), ...(d.matches && d.matches.length ? [mInc(env, day, "event", "compare_found")] : [])]);
      } else if (kind === "request" && status === 200) {
        await mInc(env, day, "event", "request_sent").run();
      }
    })().catch(() => {}));
  } catch {}
  return res;
}

// POST /api/m  body: one click name. Always 204, so it never shows errors in the page.
async function statsBeacon(req, env, ctx) {
  const done = new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  if (req.method !== "POST" || mSkip(req, env) || !mHuman(req)) return done;
  const origin = req.headers.get("origin");
  if ((origin && origin !== new URL(req.url).origin) || req.headers.get("sec-fetch-site") === "cross-site") return done;
  const name = (await req.text().catch(() => "")).slice(0, 40).trim();
  if (!M_CLICKS.includes(name)) return done;
  ctx.waitUntil(mTables(env).then(() => mInc(env, mDay(), "click", name).run()).catch(() => {}));
  return done;
}

// ---------- Cloudflare Access check ----------
let mJwks = null;
async function mAccessKeys(team, force) {
  if (!force && mJwks && mJwks.team === team && now() - mJwks.at < 3600e3) return mJwks.keys;
  if (force && mJwks && mJwks.team === team && now() - mJwks.at < 30e3) return mJwks.keys; // refetch at most every 30 s
  const r = await fetch(`https://${team}/cdn-cgi/access/certs`, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error("certs " + r.status);
  const d = await r.json(), keys = new Map();
  for (const k of d.keys || []) {
    if (k.kty !== "RSA" || !k.kid) continue;
    try { keys.set(k.kid, await crypto.subtle.importKey("jwk", { kty: "RSA", n: k.n, e: k.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"])); } catch {}
  }
  mJwks = { team, at: now(), keys };
  return keys;
}
const mB64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const mB64Json = (s) => JSON.parse(new TextDecoder().decode(mB64(s)));
function mTeam(env) {
  const t = String(env.ACCESS_TEAM_DOMAIN || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (/^[a-z0-9-]+$/.test(t)) return t + ".cloudflareaccess.com";
  return /^[a-z0-9-]+\.cloudflareaccess\.com$/.test(t) ? t : null;
}
// Returns { ok: true, email } or { ok: false, reason }. Any doubt = not ok.
async function verifyAccess(req, env) {
  const team = mTeam(env), aud = String(env.ACCESS_AUD || "").trim();
  if (!team || !aud) return { ok: false, reason: "Cloudflare Access is not set up for this page yet." };
  const token = req.headers.get("cf-access-jwt-assertion") || "";
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "Sign in through Cloudflare Access to see this page." };
  try {
    const head = mB64Json(parts[0]), body = mB64Json(parts[1]);
    if (head.alg !== "RS256" || !head.kid) return { ok: false, reason: "The sign-in token is not valid." };
    let key = (await mAccessKeys(team)).get(head.kid);
    if (!key) key = (await mAccessKeys(team, true)).get(head.kid);
    if (!key) return { ok: false, reason: "The sign-in token is not valid." };
    const good = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, mB64(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
    if (!good) return { ok: false, reason: "The sign-in token is not valid." };
    const t = Math.floor(now() / 1000);
    const auds = Array.isArray(body.aud) ? body.aud : [body.aud];
    if (body.iss !== `https://${team}` || !auds.includes(aud)) return { ok: false, reason: "The sign-in token is for another application." };
    if (!(typeof body.exp === "number" && body.exp > t) || (typeof body.nbf === "number" && body.nbf > t + 60)) return { ok: false, reason: "The sign-in has expired. Reload the page." };
    const allow = String(env.STATS_ALLOWED_EMAILS || env.OWNER_EMAIL || "").toLowerCase().split(/[,\s]+/).filter(Boolean);
    const email = String(body.email || "").toLowerCase();
    if (allow.length && !allow.includes(email)) return { ok: false, reason: "This account is not allowed to see this page." };
    if (!email) return { ok: false, reason: "This sign-in has no email address." };
    return { ok: true, email };
  } catch { return { ok: false, reason: "We could not check the sign-in. Try again." }; }
}

// ---------- dashboard ----------
const mIsStatsHost = (url, env) => url.hostname === String(env.STATS_HOST || STATS_HOST_DEFAULT).toLowerCase();
// Local development only: /__stats skips Access when STATS_DEV=1 (set only in .dev.vars, never in
// wrangler.toml) AND the request comes from this machine. wrangler dev rewrites the URL to the route's
// host, so a local request is plain http from 127.0.0.1. On Cloudflare, cf-connecting-ip is the real
// visitor address (set by Cloudflare, never loopback), so this can't match in production.
const mLoopback = (ip) => ip === "127.0.0.1" || ip === "::1";
const mIsDevStats = (req, url, env) => env.STATS_DEV === "1" && (url.pathname === "/__stats" || url.pathname.startsWith("/__stats/"))
  && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || (url.protocol === "http:" && mLoopback(req.headers.get("cf-connecting-ip") || "")));
const M_HEADERS = { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" };

async function statsApp(req, env, url, dev) {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: M_HEADERS });
  const who = dev ? { ok: true, email: "dev" } : await verifyAccess(req, env);
  if (!who.ok) return new Response(mDeniedHtml(who.reason), { status: 403, headers: { ...M_HEADERS, "content-type": "text/html; charset=utf-8" } });
  const path = dev ? url.pathname.slice("/__stats".length) || "/" : url.pathname;
  const days = [7, 30, 90].includes(+url.searchParams.get("days")) ? +url.searchParams.get("days") : 30;
  if (path === "/api/data") return new Response(JSON.stringify(await statsData(env, days)), { headers: { ...M_HEADERS, "content-type": "application/json; charset=utf-8" } });
  if (path === "/" || path === "/index.html") return new Response(statsHtml(await statsData(env, days), dev ? "/__stats" : "", mDevice(req.headers.get("user-agent")) === "phone"), { headers: { ...M_HEADERS, "content-type": "text/html; charset=utf-8" } });
  if (path === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n", { headers: { ...M_HEADERS, "content-type": "text/plain" } });
  return new Response("Not found", { status: 404, headers: M_HEADERS });
}

async function statsData(env, days, t = now()) {
  await mTables(env);
  const dayList = [], prevStart = mDay(t - (2 * days - 1) * 864e5);
  for (let i = days - 1; i >= 0; i--) dayList.push(mDay(t - i * 864e5));
  const start = dayList[0];
  const rows = (await env.DB.prepare("SELECT day, metric, key, n FROM m_counts WHERE day >= ?").bind(prevStart).all()).results || [];
  const series = Object.fromEntries(dayList.map((d) => [d, { day: d, pv: 0, visitors: 0, checks: 0, ok: 0, bot: 0 }]));
  const totals = { pv: 0, visitors: 0, checks: 0, ok: 0, bot: 0 }, prev = { pv: 0, visitors: 0, checks: 0, ok: 0 };
  const groups = { outcome: {}, shop: {}, shop_ok: {}, country: {}, ref: {}, device: {}, click: {}, event: {} };
  for (const r of rows) {
    const cur = r.day >= start, n = Number(r.n) || 0;
    const k = r.metric === "pv" ? "pv" : r.metric === "visitors" ? "visitors" : r.metric === "check" ? "checks" : r.metric === "bot" ? "bot" : r.metric === "outcome" && r.key === "ok" ? "ok" : null;
    if (k) { if (cur) { totals[k] += n; if (series[r.day]) series[r.day][k] += n; } else if (k in prev) prev[k] += n; }
    if (cur && groups[r.metric]) groups[r.metric][r.key] = (groups[r.metric][r.key] || 0) + n;
  }
  const top = (o, lim) => Object.entries(o).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, lim).map(([key, n]) => ({ key, n }));
  const today = series[dayList[dayList.length - 1]];
  return {
    days, from: start, to: dayList[dayList.length - 1], generated: t, tz: "SAST (UTC+2)",
    today, totals, prev, series: dayList.map((d) => series[d]),
    outcomes: M_OUTCOMES.map((key) => ({ key, n: groups.outcome[key] || 0 })),
    shops: top(groups.shop, 12).map((s) => ({ ...s, ok: groups.shop_ok[s.key] || 0 })),
    shop_count: Object.keys(groups.shop).length,
    countries: top(groups.country, 12), referrers: top(groups.ref, 10), devices: top(groups.device, 3),
    clicks: top(groups.click, 20), events: groups.event,
  };
}

function mDeniedHtml(reason) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Private</title><style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;padding:20px}main{max-width:420px}h1{font-size:22px;margin:0 0 6px}p{margin:0;opacity:.75}</style></head><body><main><h1>403 · This page is private</h1><p>${escHtml(reason)}</p></main></body></html>`;
}

const mFmt = (n) => Number(n || 0).toLocaleString("en-ZA").replace(/\u00a0/g, " ");
const mPct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
function mFlag(cc) { return /^[A-Z]{2}$/.test(cc) && cc !== "XX" ? String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0))) : "🌐"; }
function mCountryName(cc) {
  if (cc === "XX") return "Unknown"; if (cc === "T1") return "Tor";
  try { return new Intl.DisplayNames(["en"], { type: "region" }).of(cc) || cc; } catch { return cc; }
}
function mDelta(cur, prev) {
  if (!prev) return cur ? `<span class="d up">new</span>` : `<span class="d">–</span>`;
  const p = Math.round(((cur - prev) / prev) * 100);
  return `<span class="d ${p > 0 ? "up" : p < 0 ? "down" : ""}">${p > 0 ? "▲" : p < 0 ? "▼" : ""}${Math.abs(p)}%</span>`;
}
function mBars(list, { label = (k) => escHtml(k), sub = null, empty = "No data yet." } = {}) {
  if (!list.length || !list.some((x) => x.n)) return `<p class="empty">${empty}</p>`;
  const max = Math.max(...list.map((x) => x.n), 1);
  return `<ol class="bars">${list.map((x) => `<li><div class="bl"><span class="bk">${label(x.key)}</span><span class="bn num">${mFmt(x.n)}${sub ? ` <small>${sub(x)}</small>` : ""}</span></div><i style="width:${Math.max(2, (x.n / max) * 100).toFixed(1)}%"></i></li>`).join("")}</ol>`;
}
function mTicks(max) {
  const raw = Math.max(1, max / 4), p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((m) => m * p).find((x) => x >= raw);
  return { step, top: Math.ceil(max / step) * step || step * 4 };
}
function mChart(series, phone = false) {
  const W = phone ? 360 : 720, H = phone ? 230 : 220, L = phone ? 30 : 36, R = 8, T = 12, B = 26, n = series.length;
  const max = Math.max(4, ...series.map((d) => Math.max(d.pv, d.visitors, d.checks)));
  const { step: tick, top: nice } = mTicks(max);
  const x = (i) => L + ((W - L - R) * (i + 0.5)) / n, y = (v) => T + (H - T - B) * (1 - v / nice), bw = Math.max(2, ((W - L - R) / n) * 0.62);
  const grid = Array.from({ length: Math.round(nice / tick) + 1 }, (_, i) => i * tick).map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="g"/><text x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" class="ax" text-anchor="end">${mFmt(v)}</text>`).join("");
  const bars = series.map((d, i) => `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${y(d.visitors).toFixed(1)}" width="${bw.toFixed(1)}" height="${(y(0) - y(d.visitors)).toFixed(1)}" rx="2" class="bv"><title>${d.day}: ${d.visitors} visitors, ${d.pv} page views, ${d.checks} checks</title></rect>`).join("");
  const line = (k, cls) => `<polyline class="${cls}" points="${series.map((d, i) => `${x(i).toFixed(1)},${y(d[k]).toFixed(1)}`).join(" ")}"/>` + series.map((d, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(d[k]).toFixed(1)}" r="${n > 40 || phone ? 1.6 : 2.6}" class="${cls}p"><title>${d.day}: ${d[k]} ${k === "pv" ? "page views" : "checks"}</title></circle>`).join("");
  const every = Math.ceil(n / (phone ? 5 : 8));
  const labels = series.map((d, i) => (i % every === 0 || i === n - 1) && !(i !== n - 1 && n - 1 - i < every / 2) ? `<text x="${x(i).toFixed(1)}" y="${H - 8}" class="ax" text-anchor="middle">${d.day.slice(8)}/${d.day.slice(5, 7)}</text>` : "").join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily visitors, page views and checks">${grid}${bars}${line("pv", "lp")}${line("checks", "lc")}${labels}</svg>`;
}

const M_MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const mNice = (day, year) => `${+day.slice(8)} ${M_MON[+day.slice(5, 7) - 1]}${year ? " " + day.slice(0, 4) : ""}`;
function statsHtml(d, base = "", phone = false) {
  const t = d.totals, okRate = t.checks ? mPct(t.ok, t.checks) + "%" : "–";
  const shares = d.clicks.filter((c) => /^share_/.test(c.key)).reduce((a, c) => a + c.n, 0);
  const outcomeTotal = d.outcomes.reduce((a, o) => a + o.n, 0);
  const OUT = { ok: ["Price read", "o1"], noprice: ["No price found", "o2"], blocked: ["Shop blocked us", "o3"], error: ["Error", "o4"], invalid: ["Bad link", "o5"], rate_limited: ["Rate limited", "o6"] };
  const CLICK = { share: "Share (opened)", share_whatsapp: "Share → WhatsApp", share_copy: "Share → Copy link", share_more: "Share → More apps", save: "Save", compare_open: "Other shop opened (compare)", request_open: "Request a shop (opened)", saved_open: "Saved list opened", shops_open: "Shops list opened", example: "Example link" };
  const EV = { request_sent: "Shop requests sent", compare_search: "Compare searches", compare_found: "Compare found a match", shared_link_open: "Shared links opened" };
  const kpi = (label, v, prev, extra = "") => `<div class="kpi"><div class="kl">${label}</div><div class="kv num">${v}</div><div class="ks">${extra}${prev}</div></div>`;
  const updated = new Date(d.generated + M_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ");
  const range = [7, 30, 90].map((n) => `<a href="${base}/?days=${n}"${n === d.days ? ' aria-current="page"' : ""}>${n} days</a>`).join("");
  const events = Object.keys(EV).map((k) => ({ key: k, n: d.events[k] || 0 }));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Stats · Deal or Dud?</title>
<style>
:root{color-scheme:light dark;--bg:#f6f6f3;--card:#fff;--ink:#16181d;--mute:#666b75;--line:#e4e4df;--acc:#1f6feb;--acc2:#e8590c;--acc3:#2f9e44;--bar:#1f6feb2b;--r:12px}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--ink:#e9ebef;--mute:#9aa0ab;--line:#262a33;--acc:#5b9dff;--acc2:#ff8f4d;--acc3:#55c46b;--bar:#5b9dff33}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1120px;margin:0 auto;padding:20px 16px 40px}header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;margin-bottom:16px}
h1{font-size:20px;margin:0}.sub{margin:2px 0 0;color:var(--mute);font-size:13px}h2{font-size:15px;margin:0 0 12px}
.range{display:flex;gap:4px;background:var(--card);border:1px solid var(--line);border-radius:999px;padding:3px}.range a{padding:5px 12px;border-radius:999px;color:var(--mute);text-decoration:none;font-weight:600;font-size:13px}.range a[aria-current]{background:var(--ink);color:var(--bg)}
.num{font-variant-numeric:tabular-nums}.grid{display:grid;gap:12px}.kpis{grid-template-columns:repeat(2,1fr)}@media(min-width:760px){.kpis{grid-template-columns:repeat(3,1fr)}.two{grid-template-columns:1fr 1fr}.three{grid-template-columns:repeat(3,1fr)}}@media(min-width:1060px){.kpis{grid-template-columns:repeat(6,1fr)}}
.card,.kpi{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:14px 16px}.kl{color:var(--mute);font-size:13px}.kv{font-size:26px;font-weight:700;letter-spacing:-.01em;margin:2px 0}.ks{font-size:12px;color:var(--mute)}
.d{font-weight:600}.d.up{color:var(--acc3)}.d.down{color:var(--acc2)}section{margin-top:12px}
svg{width:100%;height:auto;display:block}.g{stroke:var(--line)}.ax{fill:var(--mute);font-size:11px}.bv{fill:var(--acc);opacity:.22}.lp{fill:none;stroke:var(--acc);stroke-width:2}.lpp{fill:var(--acc)}.lc{fill:none;stroke:var(--acc2);stroke-width:2}.lcp{fill:var(--acc2)}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--mute);margin-top:6px}.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}
.bars{list-style:none;margin:0;padding:0;display:grid;gap:8px}.bars li{position:relative}.bl{display:flex;justify-content:space-between;gap:10px;font-size:14px;position:relative;z-index:1;padding:3px 8px}.bk{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bn{font-weight:600;white-space:nowrap}.bn small{color:var(--mute);font-weight:500}.bars i{position:absolute;inset:0 auto 0 0;background:var(--bar);border-radius:6px}
.stack{display:flex;height:14px;border-radius:7px;overflow:hidden;background:var(--line);margin:4px 0 12px}.stack span{display:block;height:100%}
.o1{background:var(--acc3)}.o2{background:#f59f00}.o3{background:var(--acc2)}.o4{background:#c92a2a}.o5{background:#868e96}.o6{background:#7950f2}
.olist{list-style:none;margin:0;padding:0;display:grid;gap:6px;font-size:14px}.olist li{display:flex;justify-content:space-between;gap:8px}.olist b{font-weight:600}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:7px}
.empty{color:var(--mute);margin:0;font-size:14px}footer{margin-top:18px;font-size:12px;color:var(--mute)}
</style></head><body><div class="wrap">
<header><div><h1>Deal or Dud? stats</h1><p class="sub">${mNice(d.from, d.from.slice(0, 4) !== d.to.slice(0, 4))} – ${mNice(d.to, true)} · change vs the ${d.days} days before</p></div><nav class="range" aria-label="Date range">${range}</nav></header>
<div class="grid kpis">
${kpi("Visitors", mFmt(t.visitors), mDelta(t.visitors, d.prev.visitors), `Today ${mFmt(d.today.visitors)} · `)}
${kpi("Page views", mFmt(t.pv), mDelta(t.pv, d.prev.pv), `Today ${mFmt(d.today.pv)} · `)}
${kpi("Price checks", mFmt(t.checks), mDelta(t.checks, d.prev.checks), `Today ${mFmt(d.today.checks)} · `)}
${kpi("Price read", okRate, "", `${mFmt(t.ok)} of ${mFmt(t.checks)} checks`)}
${kpi("Shops checked", mFmt(d.shop_count), "", "Different shop websites")}
${kpi("Shares", mFmt(shares), "", `${mFmt(d.events.shared_link_open || 0)} shared links opened`)}
</div>
<section class="card"><h2>Daily visitors, page views and checks</h2>${mChart(d.series, phone)}<div class="legend"><span><i style="background:var(--bar);outline:1px solid var(--acc)"></i>Visitors</span><span><i style="background:var(--acc)"></i>Page views</span><span><i style="background:var(--acc2)"></i>Checks</span></div></section>
<div class="grid two"><section class="card"><h2>Check outcomes</h2>${outcomeTotal ? `<div class="stack" role="img" aria-label="Check outcomes">${d.outcomes.filter((o) => o.n).map((o) => `<span class="${OUT[o.key][1]}" style="width:${((o.n / outcomeTotal) * 100).toFixed(2)}%" title="${OUT[o.key][0]}: ${o.n}"></span>`).join("")}</div><ul class="olist">${d.outcomes.map((o) => `<li><span><i class="dot ${OUT[o.key][1]}"></i>${OUT[o.key][0]}</span><b class="num">${mFmt(o.n)} <small>(${mPct(o.n, outcomeTotal)}%)</small></b></li>`).join("")}</ul>` : `<p class="empty">No checks yet.</p>`}</section>
<section class="card"><h2>Top shops</h2>${mBars(d.shops, { sub: (x) => `· ${mPct(x.ok, x.n)}% read` })}</section></div>
<div class="grid three"><section class="card"><h2>Countries</h2>${mBars(d.countries, { label: (k) => `${mFlag(k)} ${escHtml(mCountryName(k))}` })}</section>
<section class="card"><h2>Where visitors came from</h2>${mBars(d.referrers, { label: (k) => (k === "direct" ? "Direct, apps or WhatsApp" : escHtml(k)) })}</section>
<section class="card"><h2>Devices</h2>${mBars(d.devices, { label: (k) => ({ phone: "📱 Phone", desktop: "💻 Desktop", tablet: "Tablet" }[k] || escHtml(k)) })}</section></div>
<div class="grid two"><section class="card"><h2>Button clicks</h2>${mBars(d.clicks, { label: (k) => escHtml(CLICK[k] || k), empty: "No clicks yet." })}</section>
<section class="card"><h2>Other events</h2>${mBars(events.filter((e) => e.n).sort((a, b) => b.n - a.n), { label: (k) => escHtml(EV[k] || k), empty: "Nothing yet." })}</section></div>
<footer>Updated ${updated} SAST. ${mFmt(t.bot)} visits from bots and link previews were left out. Days run midnight to midnight SAST. Visitors are counted once per day per device and browser, without cookies, so the range total is a sum of daily visitors. Only daily totals are stored; no IP addresses.</footer>
</div></body></html>`;
}
