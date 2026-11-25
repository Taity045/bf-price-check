// Result view, Saved list, stats and alerts. Loaded on the first check (loadApp in index.html), so it
// is not part of the first view. Core helpers come in from index.html.
__dod(({ $, store, esc, money, toast, showError, openRequest, tsPrepare, tsToken, LOC, getSaved, renderSavedCount }) => {
const DAY = 864e5;
const SITE = location.origin;
let state = null, runId = 0;
const pct = (x) => Math.abs(Math.round(x * 100)) + "%";
const fmtDate = (t) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
function parseNum(s) {
  // A typed price is human text next to a currency box: same rules as parseTextPrice(v, { currency: true }) in src/worker.js.
  if (!s) return null; s = String(s).replace(/[^\d.,]/g, "").replace(/^[.,]+|[.,]+$/g, "");
  if (!/\d/.test(s)) return null;
  const num = (n) => (isFinite(n) && n > 0 && n < 1e7 ? Math.round(n * 100) / 100 : null);
  const lc = s.lastIndexOf(","), ld = s.lastIndexOf(".");
  if (lc >= 0 && ld >= 0) {
    const dec = lc > ld ? "," : ".", grp = dec === "," ? "." : ",";
    const [int, frac, extra] = s.split(dec);
    if (extra !== undefined || !new RegExp("^\\d{1,3}(\\" + grp + "\\d{3})*$").test(int)) return null;
    return num(parseFloat(int.split(grp).join("") + "." + frac));
  }
  if (lc < 0 && ld < 0) return num(parseFloat(s));
  const parts = s.split(lc >= 0 ? "," : ".");
  const grouped = /^[1-9]\d{0,2}$/.test(parts[0]) && parts.slice(1).every((x) => x.length === 3);
  if (grouped) return num(parseFloat(parts.join("")));
  if (parts.length > 2) return null;
  return num(parseFloat(parts[0] + "." + parts[1]));
}

$("retryArchBtn").addEventListener("click", () => state && loadSnaps(runId));
$("again").addEventListener("click", () => state && run(state.url, true));
function shareInfo() {
  const link = SITE + "/?u=" + encodeURIComponent(state.url);
  const v = state.v || {}, t = state.title || "this deal";
  let text;
  if (v.big === "Fake discount" && v.W) text = `Caught a fake discount! ${t}: the shop says it was ${money(v.W, v.C)}, but we did not see that price in the last 90 days.`;
  else if (v.big === "Likely inflated was price" && v.W) text = `${t}: the shop says it was ${money(v.W, v.C)}, but it cost ${money(v.low, v.C)} on ${fmtDate(v.evT)}.`;
  else if (v.big === "Real deal") text = `Real deal! ${t} is at the lowest price we found in 12 months: ${money(v.P, v.C)}.`;
  else if (state.verdictText) text = `${state.verdictText}: ${t}`;
  else text = `Is this deal real? ${t}`;
  return { link, text };
}
$("share").addEventListener("click", () => {
  if (!state) return;
  const { link, text } = shareInfo();
  $("shareText").textContent = text;
  $("shareWa").href = "https://wa.me/?text=" + encodeURIComponent(text + " " + link);
  $("shareMore").classList.toggle("hidden", !navigator.share);
  $("shareDlg").showModal();
});
$("shareCopy").addEventListener("click", async () => {
  const { link } = shareInfo();
  try { await navigator.clipboard.writeText(link); toast("Link copied"); } catch { prompt("Copy this link:", link); }
});
$("shareMore").addEventListener("click", async () => {
  const { link, text } = shareInfo();
  try { await navigator.share({ title: "Deal or Dud?", text, url: link }); } catch {}
});
$("mapply").addEventListener("click", () => {
  if (!state) return;
  const n = parseNum($("mnow").value), w = parseNum($("mwas").value);
  if (!n) { toast("Type the price you see"); return; }
  const currency = $("mcur").value || historyCurrency();
  if (!currency) { toast("Choose the currency"); $("mcur").focus(); return; }
  $("mcur").value = currency;
  state.manual = { price: n, was: w && w > n ? w : null, currency };
  renderPrices(); renderAll();
});

async function run(url, fresh) {
  if (!url) return;
  document.documentElement.classList.add("q");
  const my = ++runId;
  $("error").classList.add("hidden");
  const go = $("go"); go.disabled = true; go.innerHTML = '<span class="spin"></span>Checking…';
  try {
    const r = await fetch("/api/check?url=" + encodeURIComponent(url) + (fresh ? "&fresh=1" : ""));
    const d = await r.json().catch(() => ({ error: "The checker sent an answer we cannot read. Try again." }));
    if (my !== runId) return;
    if (!r.ok || d.error) { showError(d.error || "The check stopped. Try again."); return; }
    history.replaceState(null, "", "/?u=" + encodeURIComponent(d.url));
    state = { ...d, title: d.current.title, archive_meta: null, archive: d.history.archive.slice(), cc: (d.history.cc || []).slice(), manual: null, failed: d.history.archive_failed, blocked: d.history.archive_blocked || 0 };
    $("mcur").value = d.current.currency || d.tld_currency || "";
    $("result").classList.remove("hidden");
    $("tip").textContent = "Tap a point to see its date and price."; $("pts").open = false;
    $("plink").href = d.url;
    $("others").classList.add("hidden"); state.revealed = null;
    renderHead(); renderPrices(); renderSupport(); renderAll(); renderSaveBtn();
    $("result").scrollIntoView({ behavior: "smooth", block: "start" });
    countCheck();
    if (d.tracked) loadSnaps(my).then(() => finalize(my));
    else {
      finalize(my);
      $("prog").classList.add("hidden"); $("retryArch").classList.add("hidden");
      $("progtxt").textContent = "Tracking is full. Daily checks and archive lookups are unavailable for this product.";
    }
  } catch (e) { if (my === runId) showError("Couldn't reach the checker. Check your connection and try again."); }
  finally { if (my === runId) { go.disabled = false; go.textContent = "Check price"; } }
}

async function loadSnaps(my) {
  $("progtxt").innerHTML = '<span class="spin"></span>Looking for archived copies at the Internet Archive…';
  $("prog").classList.add("hidden"); $("retryArch").classList.add("hidden");
  try {
    const r = await fetch("/api/archive?url=" + encodeURIComponent(state.canonical) + "&orig=" + encodeURIComponent(state.url));
    const d = await r.json();
    if (my !== runId) return;
    state.archive_meta = d.error ? { status: "error", message: d.error, pending: [] } : d;
  } catch { if (my !== runId) return; state.archive_meta = { status: "error", message: "couldn't reach the archive", pending: [] }; }
  $("progtxt").textContent = "";
  if (state.archive_meta.status !== "ok") $("retryArch").classList.remove("hidden");
  renderAll();
  const todo = (state.archive_meta.pending || []).slice();
  const total = todo.length; let done = 0;
  updProg(done, total);
  if (!total) return;
  let i = 0;
  const worker = async () => {
    while (i < todo.length && my === runId) {
      const s = todo[i++];
      try {
        const r = await fetch(`/api/snap?url=${encodeURIComponent(state.canonical)}&ts=${s.ts}&orig=${encodeURIComponent(s.orig)}`);
        const d = await r.json();
        if (my !== runId) return;
        if (d.status === "ok" && d.price) state.archive.push({ t: d.t, ts: d.ts, orig: d.orig, price: d.price, was: d.was, currency: d.currency });
        else if (d.status === "blocked") state.blocked++;
        else state.failed++;
      } catch { if (my !== runId) return; state.failed++; }
      done++; updProg(done, total); renderAll();
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

function updProg(done, total) {
  const p = $("prog"), t = $("progtxt");
  if (!total) { p.classList.add("hidden"); t.textContent = ""; return; }
  p.classList.remove("hidden"); p.firstElementChild.style.width = Math.round((done / total) * 100) + "%";
  t.textContent = done < total ? `Reading archived copies… ${done}/${total}` : `Read ${total} archived cop${total === 1 ? "y" : "ies"}.`;
}

// The one currency all known history points share, if any.
function historyCurrency() {
  const set = new Set([...state.archive, ...(state.cc || []), ...state.history.checks].map((x) => x.currency).filter(Boolean));
  return set.size === 1 ? [...set][0] : null;
}

function curPrice() {
  const c = state.current;
  if (state.manual) return { price: state.manual.price, was: state.manual.was, currency: state.manual.currency, manual: true };
  if (c.status === "ok" && c.price) return { price: c.price, was: c.was, currency: c.currency || state.tld_currency };
  return null;
}

function renderHead() {
  const c = state.current;
  $("ptitle").textContent = c.title || state.host;
  $("phost").textContent = c.title ? state.host : "";
  const img = $("pimg");
  if (c.image) { img.src = c.image; img.classList.remove("hidden"); img.onerror = () => img.classList.add("hidden"); } else img.classList.add("hidden");
}

function renderPrices() {
  const c = state.current, p = curPrice();
  const box = $("prices"), src = $("psrc"), mb = $("manualbox");
  if (p) {
    const claimed = p.was ? (p.was - p.price) / p.was : null;
    box.innerHTML = `<span class="now num">${esc(money(p.price, p.currency))}</span>`
      + (p.was ? `<span class="was num">${esc(money(p.was, p.currency))}</span><span class="claim num">${Math.round(claimed * 100)}% off, says the shop</span>` : "");
    const when = c.checked_at ? new Date(c.checked_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
    src.textContent = p.manual ? "You entered these prices." : `Read from the shop ${when}${c.currency_guessed ? " · currency guessed from the web address" : ""}`;
  } else {
    const arch = [...state.archive, ...(state.cc || [])].sort((a, b) => b.t - a.t)[0];
    if (arch) {
      box.innerHTML = `<span class="now dim num">${esc(money(arch.price, arch.currency))}</span>` + (arch.was ? `<span class="was num">${esc(money(arch.was, arch.currency))}</span>` : "") + `<span class="claim">Latest archived price</span>`;
      src.textContent = `From an archived copy of ${fmtDate(arch.t)}. Check today's price on the shop's page.`;
    } else {
      box.innerHTML = `<span class="now none">We could not read the price</span>`;
      src.textContent = "";
    }
  }
  if (c.status !== "ok" || !c.price) {
    mb.classList.remove("hidden");
    $("manualmsg").textContent = (c.status === "blocked" ? "This shop blocks our check." : "We could not read today's price.") + " Type the price you see on the shop's page to compare it.";
  } else mb.classList.add("hidden");
}

// Black Friday is the day after the fourth Thursday of November. Use this year's once its week is over.
function lastBlackFriday() {
  const bfOf = (y) => { const wd = new Date(Date.UTC(y, 10, 1)).getUTCDay(); return Date.UTC(y, 10, 1 + ((4 - wd + 7) % 7) + 22); };
  const y = new Date().getUTCFullYear();
  return Date.now() >= bfOf(y) + 4 * DAY ? bfOf(y) : bfOf(y - 1);
}
function median(a) { const s = [...a].sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; }

// Where an older price came from, as a link to the source when there is one.
function srcLink(p, short) {
  if (p.kind === "archive") return `<a href="https://web.archive.org/web/${esc(p.ts)}/${esc(p.orig || state.canonical)}" target="_blank" rel="noopener">${short ? "archive" : "web archive copy"}</a>`;
  if (p.kind === "cc") return `<a href="${esc(p.link || "https://commoncrawl.org/")}" target="_blank" rel="noopener" title="Common Crawl's index record for the archived copy of this page">${short ? "Common Crawl" : "web archive copy (Common Crawl)"}</a>`;
  return "our saved check";
}
// keep the last check of each day
function dedupeDays(list) { const m = new Map(); for (const c of list) m.set(new Date(c.t).toISOString().slice(0, 10), c); return [...m.values()]; }

function points() {
  const cur = curPrice(); const ccy = cur ? cur.currency : null;
  // A Common Crawl price on the same day and at the same price as an Internet Archive copy is the
  // same evidence (the Internet Archive holds copies of Common Crawl's crawls): show it once.
  const dk = (x) => new Date(x.t).toISOString().slice(0, 10) + "|" + x.currency + "|" + x.price;
  const wbSeen = new Set(state.archive.map(dk));
  const all = [
    ...state.archive.map((a) => ({ ...a, kind: "archive" })),
    ...(state.cc || []).filter((a) => !wbSeen.has(dk(a))).map((a) => ({ ...a, kind: "cc" })),
    ...state.history.checks.map((c) => ({ ...c, kind: "check" })),
  ].filter((x) => x.price && x.t >= Date.now() - 365 * DAY);
  // keep one currency only
  const pick = ccy || all.find((x) => x.currency)?.currency;
  const same = all.filter((x) => pick && x.currency === pick);
  const pts = same.filter((x) => x.kind === "archive" || x.kind === "cc").concat(dedupeDays(same.filter((x) => x.kind === "check")));
  pts.sort((a, b) => a.t - b.t);
  return { pts, other: all.length - same.length, ccy: pick };
}

function renderAll() { if (!curPrice()) renderPrices(); renderChart(); renderArchiveNote(); renderVerdict(); renderTable(); }

function setVerdict(cls, big, html) {
  const el = $("verdict");
  el.className = "card verdict " + cls;
  el.innerHTML = `<div class="big">${esc(big)}</div>${html}`;
  if (cls !== "unk" && state.revealed !== big) { state.revealed = big; void el.offsetWidth; el.classList.add("reveal"); }
  if (state.said !== big) { state.said = big; $("sr").textContent = "Verdict: " + big + "."; }
  el.dataset.revealed = state.revealed || "";
  if (cls === "unk") state.v = null;
}
// One line from real chart data: the lowest price in 12 months and when.
function bestLine(P, C) {
  const { pts, ccy } = points();
  if (ccy !== C || pts.length < 3) return "";
  const low = pts.reduce((m, x) => (x.price < m.price ? x : m));
  if (P != null && P <= low.price) return `<p class="best">Today's price is the lowest we found in the last 12 months.</p>`;
  return `<p class="best">Lowest price we found in the last 12 months: <b>${esc(money(low.price, C))}</b> in ${esc(new Date(low.t).toLocaleDateString("en-GB", { month: "long", year: "numeric" }))}.</p>`;
}

// Evidence from 1 or 2 older prices (same rules as sparseEvidence in src/features.js).
function sparseEvidence(P, W, h) {
  const recent = h.filter((x) => x.t >= Date.now() - 183 * DAY && x.price > 0);
  if (!P || !recent.length) return null;
  const pt = recent.reduce((m, x) => (x.price < m.price || (x.price === m.price && x.t > m.t) ? x : m));
  const maxOld = Math.max(...recent.map((x) => x.price));
  // "Inflated" needs a price from at least 2 weeks ago: a sale that started a few days ago is not a fake.
  const old = recent.filter((x) => x.t <= Date.now() - 14 * DAY);
  if (W && W > P && old.length) {
    const o = old.reduce((m, x) => (x.price < m.price ? x : m));
    if (o.price <= W * 0.9 && maxOld < W * 0.97) return { verdict: "Likely inflated was price", pt: o };
  }
  if (pt.price < P * 0.98) return { verdict: "Seen cheaper before", pt };
  if (pt.price <= P * 1.02) return { verdict: "Seen at this price before", pt };
  return null;
}
function renderVerdict() {
  let cur = curPrice(); const { pts, other, ccy } = points();
  let hist = pts.filter((x) => x.t < Date.now() - DAY);
  let archivedAt = null;
  if (!cur?.currency && !state.manual && ccy && hist.length >= 4) {
    const last = hist[hist.length - 1];
    cur = { price: last.price, was: last.was, currency: ccy };
    archivedAt = last.t; hist = hist.slice(0, -1);
  }
  const pr = hist.map((x) => x.price);
  const p90 = hist.filter((x) => x.t >= Date.now() - 90 * DAY).map((x) => x.price);
  let cls, big, body, flags = "";
  if (!cur?.currency) {
    body = cur ? "We need the currency of today's price to compare it with the history." : "We need today's price. Type it in above to compare it with the history.";
    if (pr.length) body += ` History so far: lowest ${money(Math.min(...pr), ccy)}, typical ${money(median(pr), ccy)}.`;
    setVerdict("unk", "Can't judge yet", `<p class="vbody">${esc(body)}</p>`); state.verdictText = null; return;
  }
  const P = cur.price, W = cur.was, C = cur.currency;
  if (pr.length < 3) {
    const ev = sparseEvidence(P, W, hist);
    if (ev) {
      const pt = ev.pt;
      const src = srcLink(pt);
      const when = `${esc(money(pt.price, C))} on ${esc(fmtDate(pt.t))} (${src})`;
      let vb;
      if (ev.verdict === "Likely inflated was price") { cls = "bad"; vb = `Was cheaper before: ${when}. The shop's "was" price of ${esc(money(W, C))} looks inflated.`; }
      else if (ev.verdict === "Seen cheaper before") { cls = "meh"; vb = `Seen cheaper before: ${when}. Today's price is ${esc(pct((P - pt.price) / pt.price))} higher.`; }
      else { cls = "meh"; vb = `Same price before: ${when}. Today's price is not a special deal.`; }
      state.v = { big: ev.verdict, P, W, C, low: pt.price, evT: pt.t };
      setVerdict(cls, ev.verdict, `<p class="vbody">${vb}</p><p class="note">Based on ${pr.length} older price${pr.length === 1 ? "" : "s"} from the last 6 months. We give a full verdict from 3 older prices.</p>`);
      state.verdictText = ev.verdict; return;
    }
    body = pr.length >= 1 ? `We found only ${pr.length} older price${pr.length === 1 ? "" : "s"} in ${C} (latest ${money(pr[pr.length - 1], C)} on ${fmtDate(hist[hist.length - 1].t)}). We need at least 3 to judge.` : `We found no older prices in ${C} for this product yet.`;
    body += state.tracked ? " Why: we found few or no older copies of this page in web archives. We saved today's price. We check it again regularly, so the history grows." : " Why: we found few or no older copies of this page in web archives.";
    if (W) body += ` The shop claims ${Math.round((W - P) / W * 100)}% off ${money(W, C)}. We need more history to confirm it.`;
    setVerdict("unk", "Not enough history", `<p class="vbody">${esc(body)}</p>`); state.verdictText = null; return;
  }
  const low = Math.min(...pr), high = Math.max(...pr), med = median(pr);
  const high90 = p90.length >= 2 ? Math.max(...p90) : high;
  const vsMed = (med - P) / med;
  const inflated = W && W > high90 * 1.03;
  const neverSeen = W && W > high * 1.03;
  if (P <= low * 1.005 && vsMed >= 0.05) { cls = "good"; big = "Real deal"; body = `This is the lowest price we found in twelve months, ${pct(vsMed)} below the usual ${money(med, C)}.`; }
  else if (inflated && vsMed < 0.05) { cls = "bad"; big = "Fake discount"; body = `The "was" price looks inflated. Today's price is about what it usually costs (${money(med, C)}).`; }
  else if (P > med * 1.03) { cls = "bad"; big = "Pricier than usual"; body = `It usually costs ${money(med, C)}. Today's price is ${pct(vsMed)} higher. Wait if you can.`; }
  else if (vsMed >= 0.05) { cls = "good"; big = "Decent deal"; body = `${pct(vsMed)} below the usual ${money(med, C)}, but it has been cheaper: ${money(low, C)}.`; }
  else { cls = "meh"; big = "Same old price"; body = `Close to the usual ${money(med, C)}. Not a special deal.`; }
  if (W) {
    if (neverSeen) flags += `<div class="flag">The "was" price of ${esc(money(W, C))} is higher than any price we saw in twelve months (highest: ${esc(money(high, C))}).</div>`;
    else if (inflated) flags += `<div class="flag">The "was" price of ${esc(money(W, C))} is higher than anything in the last 90 days (highest: ${esc(money(high90, C))}).</div>`;
    else if (pr.includes(W)) flags += `<div class="flag ok">We previously saw the "was" price of ${esc(money(W, C))}.</div>`;
    else flags += `<p class="note">We haven't observed the exact "was" price of ${esc(money(W, C))}.</p>`;
  }
  const bf = lastBlackFriday(), bfLo = bf - 4 * DAY, bfHi = bf + 4 * DAY;
  const bfPts = hist.filter((x) => x.t >= bfLo && x.t < bfHi);
  const bfLine = bfPts.length ? (() => { const b = bfPts.reduce((m, x) => (x.price < m.price ? x : m)); return `<p class="note">Last Black Friday (late Nov ${new Date(bf).getUTCFullYear()}): ${esc(money(b.price, C))} on ${esc(fmtDate(b.t))}${P < b.price ? ", so today is cheaper." : P > b.price ? `, so today is ${esc(pct((P - b.price) / b.price))} higher.` : ", the same as today."}</p>`; })() : "";
  state.v = { big, P, W, C, high90, med, low };
  const claimed = W ? `<p class="note">The shop claims ${Math.round((W - P) / W * 100)}% off ${esc(money(W, C))}. Real saving against the usual price: ${esc(money(Math.max(0, med - P), C))}.</p>` : "";
  setVerdict(cls, big, `<p class="vbody">${esc(body)}</p>${flags}
    <div class="stats num"><div class="stat"><b>${esc(money(low, C))}</b><span class="lab">Lowest we found</span></div><div class="stat"><b>${esc(money(med, C))}</b><span class="lab">Usual price</span></div><div class="stat"><b>${esc(money(high, C))}</b><span class="lab">Highest we found</span></div></div>
    ${bestLine(P, C)}${bfLine}${claimed}
    ${archivedAt ? `<p class="note">Compared using the latest archived price (${esc(fmtDate(archivedAt))}).</p>` : ""}<p class="note">Based on ${pr.length} older price${pr.length === 1 ? "" : "s"}${cur.manual ? " and the price you entered" : ""}.${other ? ` ${other} point(s) with a different or unknown currency were left out.` : ""}</p>`);
  state.verdictText = big;
}

function renderChart() {
  const { pts, ccy } = points(); const current = curPrice();
  const cur = current?.currency && current.currency === ccy ? current : null;
  const W = Math.max(300, Math.round($("chart").clientWidth || 600)), H = W < 520 ? 220 : 280, R = 12, T = 16, B = 28;
  const axMoney = (v) => { try { return new Intl.NumberFormat(LOC[ccy] || "en-GB", { style: "currency", currency: ccy, maximumFractionDigits: 0 }).format(v); } catch { return String(Math.round(v)); } };
  const t1 = Date.now(), t0 = t1 - 365 * DAY;
  const all = pts.map((p) => ({ ...p }));
  if (cur) all.push({ t: t1, price: cur.price, kind: "now", was: cur.was });
  $("cnt").textContent = `${pts.length} price${pts.length === 1 ? "" : "s"}`;
  const ys = all.map((p) => p.price); if (cur && cur.was) ys.push(cur.was);
  if (!ys.length) { $("chart").innerHTML = `<div class="small" style="padding:36px 0;text-align:center;border-top:1px solid var(--line);border-bottom:1px solid var(--line)">No prices to draw yet.</div>`; return; }
  let lo = Math.min(...ys), hi = Math.max(...ys); if (hi === lo) { hi *= 1.1; lo *= 0.9; }
  const pad = (hi - lo) * 0.12; lo = Math.max(0, lo - pad); hi += pad;
  const L = Math.max(44, Math.max(axMoney(lo).length, axMoney(hi).length) * 7 + 12);
  const X = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R), Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Price chart">`;
  for (let i = 0; i <= 4; i++) { const v = lo + ((hi - lo) * i) / 4, y = Y(v); s += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" class="${i === 0 ? "c-base" : "c-grid"}"/><text x="${L - 8}" y="${y + 4}" class="c-ax" text-anchor="end">${esc(axMoney(v))}</text>`; }
  for (let m = 0; m <= 12; m += (W < 520 ? 3 : 2)) { const d = new Date(t1 - (12 - m) * 30.4 * DAY); const x = X(d.getTime()); s += `<text x="${x}" y="${H - 10}" class="c-ax" text-anchor="middle">${d.toLocaleDateString("en-GB", { month: "short" })}</text>`; }
  if (cur && cur.was) { const y = Y(cur.was); s += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" class="c-was"/><text x="${W - R}" y="${y - 7}" class="c-wast" text-anchor="end">"was" ${esc(money(cur.was, ccy))}</text>`; }
  const line = all.slice().sort((a, b) => a.t - b.t);
  // solid line only between points < 45 days apart; dotted where we have no data in between
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], c = line[i], gap = c.t - a.t > 45 * DAY;
    s += `<path d="M${X(a.t)} ${Y(a.price)}H${X(c.t)}V${Y(c.price)}" class="c-ln${gap ? " gap" : ""}"/>`;
  }
  all.forEach((p, i) => {
    const x = X(p.t), y = Y(p.price);
    if (p.kind === "now") s += `<circle cx="${x}" cy="${y}" r="10" class="c-ring"/><circle cx="${x}" cy="${y}" r="5" class="c-now"/>`;
    else if (p.kind === "check") s += `<circle cx="${x}" cy="${y}" r="4" class="c-chk"/>`;
    else s += `<circle cx="${x}" cy="${y}" r="5" class="c-arch"/>`;
    s += `<circle data-i="${i}" cx="${x}" cy="${y}" r="18" fill="transparent" style="cursor:pointer"/>`;
  });
  s += `</svg>`;
  $("chart").innerHTML = s;
  $("chart").querySelectorAll("circle[data-i]").forEach((c) => c.addEventListener("click", () => {
    const p = all[+c.dataset.i];
    $("tip").innerHTML = `<b>${esc(money(p.price, ccy))}</b> · ${p.kind === "now" ? "today" : fmtDate(p.t)} · ${p.kind === "archive" ? "archived copy" : p.kind === "cc" ? "web archive copy (Common Crawl)" : p.kind === "check" ? "our check" : (cur.manual ? "entered by you" : "shop's page today")}${p.was ? ` · was ${esc(money(p.was, ccy))}` : ""}`;
  }));
}

function renderArchiveNote() {
  let note = "";
  const ai = state.archive_meta;
  if (ai) {
    if (ai.status !== "ok") note = `We could not get archive copies just now, so archive prices are missing. Use "Try the archive again".`;
    if (ai.status !== "ok" && (state.cc || []).length) note = `We could not reach the Internet Archive just now, so its copies are missing. Use "Try the archive again".`;
    else if (!(ai.captures_12mo ?? ai.captures_6mo)) note = "The Internet Archive has no copies of this page from the last twelve months" + ((state.cc || []).length ? "." : ", so older prices are missing.");
    else { const n = ai.captures_12mo ?? ai.captures_6mo; note = `Archived copies: ${n} day${n === 1 ? "" : "s"} in 12 months. We looked at ${ai.sampled}.`; }
    if (state.failed) note += ` ${state.failed} had no price we could read.`;
    if (state.blocked) note += ` ${state.blocked} ${state.blocked === 1 ? "was a bot-check page or an empty page" : "were bot-check pages or empty pages"}, not the product page.`;
  }
  const ccN = points().pts.filter((x) => x.kind === "cc").length; // after same-day duplicates are dropped
  if (ccN) note = `Common Crawl web archive: ${ccN} older price${ccN === 1 ? "" : "s"}. ` + note;
  $("archnote").textContent = note;
}

function renderTable() {
  const { pts, ccy } = points();
  if (!pts.length) { $("ptable").innerHTML = `<p class="small">No data points yet.</p>`; return; }
  $("ptable").innerHTML = `<table><tr><th>Date</th><th>Price</th><th>Was</th><th>Source</th></tr>${pts.slice().reverse().map((p) => `<tr><td>${fmtDate(p.t)}</td><td>${esc(money(p.price, ccy))}</td><td>${p.was ? esc(money(p.was, ccy)) : "—"}</td><td>${srcLink(p, true)}</td></tr>`).join("")}</table>`;
}

function renderSupport() {
  const el = $("unsup");
  const ok = state.current.status === "ok" && state.current.price;
  if (state.shop || (state.blocked_shop && ok)) { el.classList.add("hidden"); el.innerHTML = ""; return; }
  if (state.blocked_shop) {
    el.innerHTML = `<b>${esc(state.blocked_shop.name)} often blocks our checks.</b> Type the price below.`;
    el.classList.remove("hidden"); return;
  }
  el.innerHTML = ok
    ? `<b>This shop is not on our list yet.</b>We read the price. Check it against the shop's page.<button type="button" class="btn2" id="unsupAsk">Ask us to add this shop</button>`
    : `<b>We do not check this shop yet.</b>Type the price you see below, or ask us to add the shop.<button type="button" class="btn2" id="unsupAsk">Ask us to add this shop</button>`;
  el.classList.remove("hidden");
  $("unsupAsk").addEventListener("click", () => openRequest(state.host, state.url));
}

let rz; addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => state && renderChart(), 150); });
// ---------- after a check: server verdict, stats, other shops ----------
function finalize(my) {
  if (my !== runId || !state) return;
  fetch("/api/verdict?url=" + encodeURIComponent(state.canonical)).catch(() => {});
  countVerdict(state.verdictText, state.canonical);
  updateSaved(state);
  loadOthers(my);
}
async function loadOthers(my) {
  if (!state.tracked || !state.current || state.current.status !== "ok") return;
  const canon = state.canonical, sec = $("others");
  let plan;
  try { const r = await fetch("/api/compare?url=" + encodeURIComponent(canon)); if (!r.ok) return; plan = await r.json(); } catch { return; }
  if (my !== runId || !plan || !plan.product) return;
  const here = curPrice(), shops = plan.shops || [], results = Object.assign({}, plan.results || {});
  sec.classList.remove("hidden");
  if (!shops.length) {
    $("otherList").innerHTML = ""; $("cmpProg").classList.add("hidden"); $("cmpStatus").textContent = "";
    $("cmpSum").textContent = "We don't search other shops for this kind of product in this country yet.";
    return;
  }
  const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "just now" : m < 60 ? m + " min ago" : Math.round(m / 60) + " h ago"; };
  const LEVEL = { barcode: "Same barcode", model: "Same model number", name: "Same name and specs" };
  const render = () => {
    const done = shops.filter((s) => results[s.id]).length;
    const matches = shops.map((s) => results[s.id]).filter((r) => r && r.status === "match" && r.match);
    const inStock = matches.filter((r) => r.match.in_stock).map((r) => r.match.price);
    const herePrice = here && here.currency === plan.product.currency ? here.price : null;
    const low = Math.min(...inStock, herePrice ?? Infinity);
    const isLow = (p) => p != null && Math.abs(p - low) < 0.5;
    const nLow = inStock.filter(isLow).length + (isLow(herePrice) ? 1 : 0);
    const lowTag = matches.length && nLow ? `<span class="tag cheap">${nLow > 1 ? "Same lowest price" : "Cheapest"}</span>` : "";
    const rows = [];
    if (herePrice != null) rows.push({ here: true, price: herePrice, html: `<span class="os"><b>${esc(state.shop ? state.shop.name : state.host)}</b><span class="ot">This page</span>${isLow(herePrice) ? lowTag : ""}</span><span class="op"><b class="num">${esc(money(herePrice, here.currency))}</b></span>` });
    for (const r of matches.sort((a, b) => (b.match.in_stock - a.match.in_stock) || a.match.price - b.match.price)) {
      const m = r.match, d = herePrice != null ? m.price - herePrice : null;
      const diff = d == null || !m.in_stock ? "" : Math.abs(d) < 0.5 ? '<span class="diff">Same price</span>' : `<span class="diff ${d < 0 ? "less" : ""}">${esc(money(Math.abs(Math.round(d)), m.currency))} ${d < 0 ? "less" : "more"}</span>`;
      rows.push({ price: m.price, html: `<span class="os"><b>${esc(r.name)}</b><span class="ot">${esc(m.title)}</span><span class="tag ${m.level === "name" ? "" : "sure"}">${LEVEL[m.level]}</span>${m.in_stock && isLow(m.price) ? lowTag : ""}${m.in_stock ? "" : '<span class="tag oos">Out of stock</span>'}</span><span class="op"><b class="num">${esc(money(m.price, m.currency))}</b>${m.was ? `<span class="was small">${esc(money(m.was, m.currency))}</span>` : ""}${diff}<a href="${esc(m.url)}" target="_blank" rel="noopener nofollow">Open ↗</a><span class="small">${esc(ago(r.checked_at))}</span></span>`, oos: !m.in_stock });
    }
    const waiting = shops.filter((s) => !results[s.id]);
    $("otherList").innerHTML = rows.map((r) => `<li class="${r.here ? "here" : ""}${r.oos ? " oos" : ""}">${r.html}</li>`).join("")
      + (waiting.length ? `<li class="wait"><span class="os"><b>Checking ${waiting.length} more shop${waiting.length === 1 ? "" : "s"}…</b><span class="ot">${esc(waiting.slice(0, 6).map((s) => s.name).join(", "))}${waiting.length > 6 ? "…" : ""}</span></span></li>` : "");
    const pctDone = Math.round((done / shops.length) * 100);
    $("cmpProg").classList.toggle("hidden", done === shops.length);
    $("cmpProg").firstElementChild.style.width = pctDone + "%";
    sec.setAttribute("aria-busy", done < shops.length ? "true" : "false");
    $("cmpStatus").textContent = done < shops.length ? `${done} of ${shops.length} shops checked` : `${shops.length} shop${shops.length === 1 ? "" : "s"} checked`;
    const none = shops.filter((s) => results[s.id] && results[s.id].status === "none").map((s) => s.name);
    const failed = shops.filter((s) => results[s.id] && !["match", "none", "skipped", "robots"].includes(results[s.id].status)).map((s) => s.name);
    const asked = shops.filter((s) => results[s.id] && results[s.id].status === "robots").map((s) => s.name);
    const parts = [];
    if (done === shops.length && !matches.length) parts.push(`We didn't find this exact product at the ${shops.length} other shop${shops.length === 1 ? "" : "s"} we searched.`);
    if (matches.length && none.length) parts.push(`Not found at: ${none.join(", ")}.`);
    if (failed.length) parts.push(`Couldn't check: ${failed.join(", ")} (try again later).`);
    if (asked.length) parts.push(`Not searched: ${asked.join(", ")} (the shop asks tools not to use its search).`);
    $("cmpSum").textContent = parts.join(" ");
  };
  render();
  const queue = shops.filter((s) => !results[s.id]);
  const worker = async () => {
    while (queue.length) {
      const s = queue.shift();
      let r;
      try { const res = await fetch(`/api/compare/shop?url=${encodeURIComponent(canon)}&shop=${encodeURIComponent(s.id)}`); r = await res.json(); } catch { r = null; }
      if (my !== runId) return;
      results[s.id] = r && r.status ? r : { shop: s.id, name: s.name, status: "error" };
      render();
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

// ---------- saved products (this device only) ----------
const MAX_SAVED = 30;
function renderSaveBtn() { const on = !!state && getSaved().some((x) => x.canon === state.canonical); $("save").textContent = on ? "Saved ✓" : "Save"; $("save").setAttribute("aria-pressed", on); }
function itemFrom(st) { const p = curPrice(); return { url: st.url, canon: st.canonical, title: st.title || st.host, host: st.host, price: p ? p.price : null, currency: p ? p.currency : null, verdict: st.verdictText || null, t: Date.now() }; }
function updateSaved(st) { const list = getSaved(), i = list.findIndex((x) => x.canon === st.canonical); if (i >= 0) { list[i] = itemFrom(st); store.set("saved", list); } }
$("save").addEventListener("click", () => {
  if (!state) return;
  let list = getSaved();
  if (list.some((x) => x.canon === state.canonical)) { list = list.filter((x) => x.canon !== state.canonical); toast("Removed from Saved"); }
  else { list.unshift(itemFrom(state)); list = list.slice(0, MAX_SAVED); toast("Saved on this device"); }
  store.set("saved", list); renderSaveBtn(); renderSavedCount(); checkBadges();
});
const vcls = (v) => ({ "Real deal": "good", "Decent deal": "good", "Fake discount": "bad", "Pricier than usual": "bad", "Same old price": "meh" }[v] || "");
function renderSavedList() {
  const list = getSaved();
  if (!list.length) { $("savedList").innerHTML = `<li><span class="small">Nothing saved yet. Check a product and tap Save.</span></li>`; return; }
  $("savedList").innerHTML = list.map((x, i) => `<li><span><a href="/?u=${encodeURIComponent(x.url)}">${esc(x.title)}</a><br><span class="small">${esc(x.host)} · <span class="num">${x.price ? esc(money(x.price, x.currency)) : "No price"}</span></span> ${x.verdict ? `<span class="chip ${vcls(x.verdict)}">${esc(x.verdict)}</span>` : ""}</span><button type="button" class="linkbtn" data-rm="${i}" aria-label="Remove ${esc(x.title)}">Remove</button></li>`).join("");
  $("savedList").querySelectorAll("[data-rm]").forEach((b) => b.addEventListener("click", () => { const l = getSaved(); l.splice(+b.dataset.rm, 1); store.set("saved", l); renderSavedList(); renderSavedCount(); if (state) renderSaveBtn(); }));
}
let recheckOn = false;
async function recheckSaved() {
  if (recheckOn) return; recheckOn = true;
  const note = $("savedNote");
  const todo = getSaved().filter((x) => Date.now() - (x.t || 0) > 30 * 60e3).slice(0, 10);
  let done = 0;
  for (const it of todo) {
    if (!$("savedDlg").open) break;
    note.innerHTML = `<span class="spin"></span>Checking for new prices… ${done}/${todo.length}`;
    try {
      const r = await fetch("/api/check?url=" + encodeURIComponent(it.url));
      if (r.status === 429) { note.textContent = "We stopped for now: too many checks in a minute. Open this list again soon."; recheckOn = false; return; }
      const d = await r.json();
      if (r.ok && d.current) {
        const l = getSaved(), i = l.findIndex((x) => x.canon === it.canon);
        if (i >= 0) { const c = d.current; l[i] = { ...l[i], price: c.status === "ok" ? c.price : l[i].price, currency: c.status === "ok" ? c.currency : l[i].currency, verdict: d.verdict ? d.verdict.verdict : l[i].verdict, t: Date.now() }; store.set("saved", l); renderSavedList(); }
      }
    } catch { note.textContent = "We could not reach the checker. Check your connection."; recheckOn = false; return; }
    done++;
  }
  note.textContent = todo.length ? `Updated ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}.` : "";
  recheckOn = false;
}
function showTab(which) {
  const s = which === "stats";
  $("tabSaved").setAttribute("aria-selected", !s); $("tabStats").setAttribute("aria-selected", s);
  $("tabSaved").tabIndex = s ? -1 : 0; $("tabStats").tabIndex = s ? 0 : -1;
  $("paneSaved").classList.toggle("hidden", s); $("paneStats").classList.toggle("hidden", !s);
  if (s) renderStats();
}
$("tabSaved").addEventListener("click", () => showTab("saved"));
$("tabStats").addEventListener("click", () => showTab("stats"));
// Arrow keys, Home and End move between the tabs (WAI-ARIA tabs pattern).
document.querySelector("#savedDlg [role=tablist]").addEventListener("keydown", (e) => {
  const tabs = ["tabSaved", "tabStats"], i = tabs.indexOf(document.activeElement.id);
  if (i < 0) return;
  const k = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
  if (k === undefined) return;
  e.preventDefault();
  const id = tabs[(k + tabs.length) % tabs.length];
  showTab(id === "tabStats" ? "stats" : "saved"); $(id).focus();
});
function openSaved() { showTab("saved"); renderSavedList(); $("savedNote").textContent = ""; $("savedDlg").showModal(); recheckSaved(); }


// ---------- your stats and badges (this device only) ----------
const today = () => new Date().toISOString().slice(0, 10);
function countCheck() {
  const st = store.get("stats", { checks: 0, days: [], fakes: [], deals: [] });
  st.checks++; if (!st.days.includes(today())) st.days = st.days.concat(today()).slice(-60);
  store.set("stats", st); checkBadges();
}
function countVerdict(v, canon) {
  if (!v) return;
  const st = store.get("stats", { checks: 0, days: [], fakes: [], deals: [] });
  if (v === "Fake discount" && !st.fakes.includes(canon)) st.fakes = st.fakes.concat(canon).slice(-200);
  if ((v === "Real deal" || v === "Decent deal") && !st.deals.includes(canon)) st.deals = st.deals.concat(canon).slice(-200);
  store.set("stats", st); checkBadges();
}
function streak(days) {
  const set = new Set(days); let n = 0; const d = new Date();
  if (!set.has(d.toISOString().slice(0, 10))) d.setUTCDate(d.getUTCDate() - 1);
  while (set.has(d.toISOString().slice(0, 10))) { n++; d.setUTCDate(d.getUTCDate() - 1); }
  return n;
}
const BADGES = [
  { id: "first", name: "First check", how: "Check one product.", ok: (s) => s.checks >= 1 },
  { id: "spot1", name: "Fake spotter", how: "Catch 1 fake discount.", ok: (s) => s.fakes.length >= 1 },
  { id: "spot5", name: "Fake hunter", how: "Catch 5 fake discounts.", ok: (s) => s.fakes.length >= 5 },
  { id: "spot10", name: "Fake buster", how: "Catch 10 fake discounts.", ok: (s) => s.fakes.length >= 10 },
  { id: "deal", name: "Deal hunter", how: "Find a real or decent deal.", ok: (s) => s.deals.length >= 1 },
  { id: "streak3", name: "3-day streak", how: "Check prices 3 days in a row.", ok: (s) => streak(s.days) >= 3 },
];
function checkBadges() {
  const st = store.get("stats", { checks: 0, days: [], fakes: [], deals: [] });
  const had = store.get("badges", []), now = BADGES.filter((b) => b.ok(st)).map((b) => b.id);
  const fresh = now.filter((id) => !had.includes(id));
  if (fresh.length) { store.set("badges", now); const b = BADGES.find((x) => x.id === fresh[fresh.length - 1]); setTimeout(() => toast("New badge: " + b.name), 600); }
}
function renderStats() {
  const st = store.get("stats", { checks: 0, days: [], fakes: [], deals: [] });
  $("myStats").innerHTML = `<div class="stat"><b>${st.checks}</b><span class="lab">Checks</span></div><div class="stat"><b>${st.fakes.length}</b><span class="lab">Fakes caught</span></div><div class="stat"><b>${streak(st.days)}</b><span class="lab">Day streak</span></div>`;
  $("badges").innerHTML = BADGES.map((b) => `<div class="badge${b.ok(st) ? " on" : ""}"><b>${b.ok(st) ? "★ " : ""}${esc(b.name)}</b><span class="small">${esc(b.how)}</span></div>`).join("");
}

$("alertBtn").addEventListener("click", () => {
  if (!state) return;
  const p = curPrice();
  $("aTarget").value = p ? String(Math.floor(p.price * 0.9)) : ""; $("aMsg").textContent = ""; $("aMsg").className = "fmsg";
  $("aSend").disabled = false; $("aSend").textContent = "Start alert";
  $("alertDlg").showModal(); $("aEmail").focus(); tsPrepare("aTs");
});
$("alertForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("aMsg"), btn = $("aSend"), bad = (t) => { msg.textContent = t; msg.className = "fmsg bad"; };
  const target = parseNum($("aTarget").value), email = $("aEmail").value.trim();
  if (!target) { bad("Type the price you want to pay."); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { bad("Check the email address."); return; }
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Sending…';
  try {
    const r = await fetch("/api/alert", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: state.canonical, email, target, website: $("aWeb").value, ts: await tsToken("aTs") }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) { bad(d.error || "We could not start the alert."); btn.disabled = false; btn.textContent = "Start alert"; return; }
    msg.textContent = "Check your email and click the link to start the alert."; msg.className = "fmsg ok"; btn.textContent = "Sent";
  } catch { bad("We could not reach the checker. Try again."); btn.disabled = false; btn.textContent = "Start alert"; }
});
return { run, openSaved, ask: () => (state && !state.shop ? [state.host, state.url] : ["", ""]) };
});
