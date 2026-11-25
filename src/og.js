// ---------- share image (PNG) ----------
// Draws a 1200x630 card with pre-made anti-aliased glyphs (src/og_font.js) and writes a PNG. No wasm needed.
const OG_W = 1200, OG_H = 630;
let ogGlyphs = null;
async function inflate(b64) {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const ds = new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream("deflate")));
  return new Uint8Array(await ds.arrayBuffer());
}
async function loadGlyphs() {
  if (ogGlyphs) return ogGlyphs;
  const g = {};
  for (const k of Object.keys(OG_FONT)) g[k] = { ...OG_FONT[k], bits: await inflate(OG_FONT[k].d) };
  return (ogGlyphs = g);
}
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
class Canvas {
  constructor(w, h, bg) { this.w = w; this.h = h; this.px = new Uint8Array(w * h * 3); this.rect(0, 0, w, h, bg); }
  rect(x, y, w, h, col, a = 1) {
    const [r, g, b] = hex(col);
    x = Math.max(0, Math.round(x)); y = Math.max(0, Math.round(y));
    const x2 = Math.min(this.w, x + Math.round(w)), y2 = Math.min(this.h, y + Math.round(h));
    if (x2 <= x || y2 <= y) return;
    const p = this.px;
    if (a >= 1) {
      const row = new Uint8Array((x2 - x) * 3);
      for (let i = 0; i < row.length; i += 3) { row[i] = r; row[i + 1] = g; row[i + 2] = b; }
      for (let j = y; j < y2; j++) p.set(row, (j * this.w + x) * 3);
      return;
    }
    for (let j = y; j < y2; j++) for (let i = x; i < x2; i++) {
      const o = (j * this.w + i) * 3;
      p[o] += (r - p[o]) * a; p[o + 1] += (g - p[o + 1]) * a; p[o + 2] += (b - p[o + 2]) * a;
    }
  }
  disc(cx, cy, rad, col) {
    const [r, g, b] = hex(col);
    for (let j = Math.floor(cy - rad - 1); j <= cy + rad + 1; j++) for (let i = Math.floor(cx - rad - 1); i <= cx + rad + 1; i++) {
      if (i < 0 || j < 0 || i >= this.w || j >= this.h) continue;
      const d = Math.hypot(i + 0.5 - cx, j + 0.5 - cy), a = Math.max(0, Math.min(1, rad - d + 0.5));
      if (!a) continue;
      const o = (j * this.w + i) * 3, p = this.px;
      p[o] += (r - p[o]) * a; p[o + 1] += (g - p[o + 1]) * a; p[o + 2] += (b - p[o + 2]) * a;
    }
  }
  text(font, str, x, base, col, maxW) {
    const [r, g, b] = hex(col);
    let pen = x;
    for (const ch of str) {
      const gl = font.g[ch] || font.g["?"];
      if (maxW && pen + gl[5] > x + maxW) break;
      const [off, w, h, l, t] = gl;
      const gx = Math.round(pen + l), gy = Math.round(base + t);
      for (let j = 0; j < h; j++) {
        const yy = gy + j; if (yy < 0 || yy >= this.h) continue;
        for (let i = 0; i < w; i++) {
          const a = font.bits[off + j * w + i] / 255; if (!a) continue;
          const xx = gx + i; if (xx < 0 || xx >= this.w) continue;
          const o = (yy * this.w + xx) * 3, p = this.px;
          p[o] += (r - p[o]) * a; p[o + 1] += (g - p[o + 1]) * a; p[o + 2] += (b - p[o + 2]) * a;
        }
      }
      pen += gl[5];
    }
    return pen - x;
  }
}
const measure = (font, s) => [...s].reduce((w, ch) => w + (font.g[ch] || font.g["?"])[5], 0);
function ogClean(s) { return String(s || "").replace(/[\u00a0\u202f\u2009]/g, " ").replace(/[^\x20-\x7e£€–—…‘’“”·×→]/g, ""); }
function wrap(font, s, maxW, maxLines) {
  const words = ogClean(s).split(/\s+/).filter(Boolean), lines = [];
  let line = "";
  for (const w of words) {
    const t = line ? line + " " + w : w;
    if (measure(font, t) <= maxW) { line = t; continue; }
    if (line) lines.push(line);
    line = w;
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    let last = lines[maxLines - 1];
    while (last && measure(font, last + "…") > maxW) last = last.slice(0, -1);
    lines[maxLines - 1] = last.replace(/\s+$/, "") + "…";
  }
  return lines;
}
const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
  dv.setUint32(0, data.length); out.set([...type].map((c) => c.charCodeAt(0)), 4); out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
async function encodePng(cv) {
  const raw = new Uint8Array((cv.w * 3 + 1) * cv.h);
  for (let y = 0; y < cv.h; y++) { raw[y * (cv.w * 3 + 1)] = 0; raw.set(cv.px.subarray(y * cv.w * 3, (y + 1) * cv.w * 3), y * (cv.w * 3 + 1) + 1); }
  const z = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, cv.w); dv.setUint32(4, cv.h); ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", z), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const OG_LOC = { ZAR: "en-ZA", GBP: "en-GB", EUR: "en-IE", USD: "en-US" };
function ogMoney(v, cur) {
  if (v == null) return "";
  try { return new Intl.NumberFormat(OG_LOC[cur] || "en-GB", { style: "currency", currency: cur || "USD", ...(Number.isInteger(v) ? { minimumFractionDigits: 0 } : {}) }).format(v).replace(/[\u00a0\u202f]/g, " "); } catch { return (cur ? cur + " " : "") + v; }
}
const VCOL = { "Real deal": "#0b7a3e", "Decent deal": "#0b7a3e", "Fake discount": "#cc2418", "Pricier than usual": "#cc2418", "Same old price": "#8a5a00", "Likely inflated was price": "#cc2418", "Seen cheaper before": "#8a5a00", "Seen at this price before": "#8a5a00" };
async function renderOg(info) {
  const F = await loadGlyphs();
  const ink = "#111214", mut = "#5f6368", line = "#e3e5e8";
  const col = VCOL[info.verdict] || ink;
  const cv = new Canvas(OG_W, OG_H, "#fbfaf6");
  cv.rect(0, 0, OG_W, 14, col);
  cv.rect(72, 68, 40, 28, ink); cv.rect(75, 71, 34, 22, "#ffc21a"); // price tag mark
  cv.text(F.s, "Deal or Dud?", 120, 93, ink);
  if (!info.verdict && !info.price) {
    wrap(F.h1, "You think you found a good deal? Let's find out!", 1056, 3).forEach((l, i) => cv.text(F.h1, l, 72, 250 + i * 92, ink));
    cv.text(F.b, "Paste a product link. Compare it with older prices.", 72, 520, mut);
    cv.rect(0, OG_H - 24, OG_W, 24, "#ffc21a");
    return encodePng(cv);
  }
  cv.text(F.h1, ogClean(info.verdict || "Is this deal real?"), 72, 205, col, 1056);
  const tl = wrap(F.b, info.title || info.host || "", 1056, 2);
  tl.forEach((l, i) => cv.text(F.b, l, 72, 265 + i * 46, ink));
  const yP = 265 + tl.length * 46 + 80;
  const pw = cv.text(F.h2, ogMoney(info.price, info.currency), 72, yP, ink);
  if (info.was) {
    const ws = "was " + ogMoney(info.was, info.currency);
    const x0 = 72 + pw + 28, ww = measure(F.b, ws), w0 = measure(F.b, "was ");
    cv.text(F.b, ws, x0, yP, mut);
    cv.rect(x0 + w0, yP - 12, ww - w0, 3, mut);
  }
  // facts line
  const facts = [];
  if (info.verdict === "Fake discount" && info.high90) facts.push(`Highest in 90 days: ${ogMoney(info.high90, info.currency)}`);
  else if (info.low) facts.push(`Lowest we found: ${ogMoney(info.low, info.currency)}`);
  if (info.med) facts.push(`Usual: ${ogMoney(info.med, info.currency)}`);
  if (!info.verdict && info.was && info.price) facts.push(`The shop says ${Math.round((1 - info.price / info.was) * 100)}% off. We need more history to judge.`);
  if (facts.length) cv.text(F.s, ogClean(facts.join("  ·  ")), 72, yP + 62, mut, 640);
  // sparkline
  const pts = (info.pts || []).slice(-40);
  const cx0 = 800, cx1 = 1120, cy0 = 330, cy1 = 470;
  if (pts.length >= 2) {
    const ys = pts.map((p) => p.price).concat(info.price ? [info.price] : []), lo = Math.min(...ys), hi = Math.max(...ys) === lo ? lo * 1.1 + 1 : Math.max(...ys);
    const t0 = pts[0].t, t1 = Date.now();
    const X = (t) => cx0 + ((t - t0) / Math.max(1, t1 - t0)) * (cx1 - cx0), Y = (v) => cy1 - ((v - lo) / (hi - lo)) * (cy1 - cy0);
    cv.rect(cx0, cy1 + 6, cx1 - cx0, 2, line);
    const all = pts.map((p) => ({ x: X(p.t), y: Y(p.price) }));
    if (info.price) all.push({ x: cx1, y: Y(info.price) });
    for (let i = 1; i < all.length; i++) {
      const a = all[i - 1], b = all[i];
      cv.rect(a.x, a.y - 2, b.x - a.x + 2, 4, ink);
      cv.rect(b.x - 1, Math.min(a.y, b.y) - 2, 4, Math.abs(b.y - a.y) + 4, ink);
    }
    if (info.price) { cv.disc(cx1, Y(info.price), 11, ink); cv.disc(cx1, Y(info.price), 8, "#ffc21a"); }
    cv.text(F.s, "Prices we found", cx0, cy1 + 46, mut);
  }
  cv.rect(0, OG_H - 64, OG_W, 64, "#ffc21a"); cv.rect(0, OG_H - 66, OG_W, 2, ink);
  cv.text(F.s, ogClean(`${info.host || ""}  ·  Prices from the shop and the Internet Archive`), 72, OG_H - 24, ink, 1056);
  return encodePng(cv);
}
async function ogInfo(env, canon) {
  await ensureFeatureTables(env);
  const v = await env.DB.prepare("SELECT * FROM verdicts WHERE url = ?").bind(canon).first();
  const host = stripWww(new URL(canon).hostname.toLowerCase());
  const hist = await storedHistory(env, canon);
  if (v) return { ...v, host, pts: historyPoints(hist, v.currency).pts, verdict: v.verdict === "Not enough history" ? null : v.verdict };
  const cur = await latestCurrent(env, canon);
  if (cur && cur.price) return { host, title: cur.title, price: cur.price, was: cur.was, currency: cur.currency, pts: historyPoints(hist, cur.currency).pts, updated_at: cur.checked_at };
  return null;
}
async function apiOg(req, env) {
  const u = new URL(req.url).searchParams.get("u") || "";
  let canon = null;
  if (u) { const vv = validateUrl(u); if (vv.url) canon = canonicalize(vv.url).canon; }
  let info = null;
  if (canon) { const tr = await env.DB.prepare("SELECT url FROM tracked WHERE url = ?").bind(canon).first(); if (tr) info = await ogInfo(env, canon); }
  const key = "og-v3:" + (info ? canon + ":" + (info.updated_at || 0) : "home");
  const c = await cacheGet(env, key);
  let png;
  if (c && c.b64) png = Uint8Array.from(atob(c.b64), (x) => x.charCodeAt(0));
  else {
    png = await renderOg(info || {});
    let s = ""; for (let i = 0; i < png.length; i += 0x8000) s += String.fromCharCode(...png.subarray(i, i + 0x8000));
    if (png.length < 700000) await cachePut(env, key, { b64: btoa(s) }, 7 * DAY_MS).catch(() => {});
  }
  return new Response(png, { headers: { "content-type": "image/png", "content-length": String(png.length), "cache-control": "public, max-age=86400", "access-control-allow-origin": "*" } });
}
// Server-side meta tags for shared links (/?u=...), so chat apps show the verdict and price.
async function homeWithMeta(req, env, html, ctx) {
  const url = new URL(req.url);
  const u = url.searchParams.get("u") || url.searchParams.get("url");
  if (!u) return html;
  const vv = validateUrl(u); if (!vv.url) return html;
  const canon = canonicalize(vv.url).canon;
  let info = null;
  try { const tr = await env.DB.prepare("SELECT url FROM tracked WHERE url = ?").bind(canon).first(); if (tr) info = await ogInfo(env, canon); } catch {}
  if (!info) return html;
  const money = (v) => ogMoney(v, info.currency);
  const title = `${info.verdict ? info.verdict + ": " : ""}${info.title || info.host}`.slice(0, 120);
  const desc = [info.price ? `Now ${money(info.price)}` : "", info.was ? `the shop says it was ${money(info.was)}` : "", info.verdict === "Fake discount" && info.high90 ? `but the highest price in 90 days was ${money(info.high90)}` : info.low ? `lowest we found ${money(info.low)}` : ""].filter(Boolean).join(", ") + ".";
  // Chat apps wait only a short time for the image. Use the product card only when it is already made; else use the fixed card and make it now.
  const dyn = `${url.origin}/og.png?u=${encodeURIComponent(canon)}&v=${info.updated_at || 0}`;
  const ready = await cacheGet(env, "og-v3:" + canon + ":" + (info.updated_at || 0)).catch(() => null);
  if (!ready && ctx) ctx.waitUntil(apiOg(new Request(dyn), env).catch(() => {}));
  const img = ready ? dyn : `${url.origin}/og-home.jpg`;
  const pageUrl = url.origin + "/?u=" + encodeURIComponent(u);
  const meta = `<!--OG--><meta property="og:type" content="website">\n<meta property="og:site_name" content="Deal or Dud?">\n<meta property="og:title" content="${escHtml(title)}">\n<meta property="og:description" content="${escHtml(desc)}">\n<meta property="og:url" content="${escHtml(pageUrl)}">\n<meta property="og:image" content="${escHtml(img)}">\n<meta property="og:image:secure_url" content="${escHtml(img)}">\n<meta property="og:image:type" content="${ready ? "image/png" : "image/jpeg"}">\n<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">\n<meta property="og:image" content="${url.origin}/og-square.jpg">\n<meta property="og:image:type" content="image/jpeg">\n<meta property="og:image:width" content="600">\n<meta property="og:image:height" content="600">\n<meta name="twitter:card" content="summary_large_image">\n<meta name="twitter:image" content="${escHtml(img)}"><!--/OG-->`;
  const ns = `<noscript><div class="card" style="margin-top:20px"><p class="small">${escHtml(info.host || "")}</p><h2>${escHtml(info.title || "")}</h2>${info.verdict ? `<p><b>${escHtml(info.verdict)}</b></p>` : ""}<p class="num">${escHtml(desc)}</p><p class="small">Turn on JavaScript to see the full price history.</p></div></noscript>`;
  return html.replace(/<!--OG-->[\s\S]*?<!--\/OG-->/, () => meta).replace("<!--NOSCRIPT-->", ns);
}
