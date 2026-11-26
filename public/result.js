// Result view, Saved list, stats and alerts. Loaded on the first check (loadApp in index.html), so it
// is not part of the first view. Core helpers come in from index.html.
__dod(({ $, store, esc, money, toast, showError, openRequest, tsPrepare, tsToken, LOC, getSaved, renderSavedCount, boxMode, setCc }) => {
const DAY = 864e5;
/*DEAL_SCORE*/
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
// Share: the link opens the same check (/?u=). Links from our own hosts point to eish.veldwire.com.
const SHARE_ORIGIN = /(^|\.)veldwire\.com$|\.workers\.dev$/.test(location.hostname) ? "https://eish.veldwire.com" : SITE;
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
function shareInfo() {
  const link = SHARE_ORIGIN + "/?u=" + encodeURIComponent(state.url);
  const v = state.v || {}, p = curPrice(), cmp = state.cmp;
  const lines = [clip(state.title || state.host || "A product", 110)];
  if (p && p.price) lines.push(`${p.manual ? "Price I saw at" : "Price at"} ${state.host}: ${money(p.price, p.currency)}`);
  if (state.deal && state.deal.score != null) lines.push(`Deal Score: ${state.deal.score}/100. ${state.deal.action}.`);
  if (cmp && cmp.best) lines.push(`Cheaper at ${cmp.best.name}: ${money(cmp.best.price, cmp.best.C)}${cmp.best.note ? " " + cmp.best.note : ""} (save ${money(cmp.best.save, cmp.best.C)}).`);
  else {
    if (v.big === "Fake discount" && v.W) lines.push(`Verdict: Fake discount. The shop says it was ${money(v.W, v.C)}, but we did not see that price in the last 90 days.`);
    else if (v.big === "Likely inflated was price" && v.W) lines.push(`Verdict: The "was" price is likely too high. It cost ${money(v.low, v.C)} on ${fmtDate(v.evT)}.`);
    else if (v.big === "Real deal") lines.push("Verdict: Real deal. This is the lowest price we found in 12 months.");
    else if (state.verdictText) lines.push(`Verdict: ${state.verdictText}.`);
    if (cmp && cmp.none) lines.push(`No cheaper exact match at ${cmp.none} other shop${cmp.none === 1 ? "" : "s"}.`);
  }
  const text = lines.join("\n");
  return { link, text, full: text + "\nSee the price history: " + link };
}
// The button says "deal" only when the result is good for the buyer.
function renderShareLab() {
  if (!state) return;
  const good = (state.cmp && state.cmp.best) || ["Real deal", "Decent deal"].includes(state.verdictText);
  $("shareLab").textContent = good ? "Share this deal" : "Share this result";
}
function openShareDlg() {
  const { text, full } = shareInfo();
  $("shareTitle").textContent = $("shareLab").textContent;
  $("shareText").textContent = full;
  $("shareWa").href = "https://wa.me/?text=" + encodeURIComponent(full);
  $("shareMore").classList.toggle("hidden", !navigator.share);
  $("shareDlg").showModal();
}
// Phones: one tap opens the phone's share menu (WhatsApp and other apps). Computers: our menu with WhatsApp and Copy link.
const isPhone = () => matchMedia("(pointer: coarse)").matches;
$("share").addEventListener("click", async () => {
  if (!state) return;
  if (navigator.share && isPhone()) {
    const { link, text } = shareInfo();
    try { await navigator.share({ title: "Deal or Dud?", text: text + "\nSee the price history:", url: link }); return; }
    catch (e) { if (e && e.name === "AbortError") return; }
  }
  openShareDlg();
});
$("shareCopy").addEventListener("click", async () => {
  const { link } = shareInfo();
  try { await navigator.clipboard.writeText(link); toast("Link copied"); } catch { prompt("Copy this link:", link); }
});
$("shareMore").addEventListener("click", async () => {
  const { link, text } = shareInfo();
  try { await navigator.share({ title: "Deal or Dud?", text: text + "\nSee the price history:", url: link }); } catch {}
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
  const my = ++runId; searchId++;
  $("error").classList.add("hidden");
  const go = $("go"); go.disabled = true; go.innerHTML = '<span class="spin"></span>Checking…';
  try {
    const r = await fetch("/api/check?url=" + encodeURIComponent(url) + (fresh ? "&fresh=1" : ""));
    const d = await r.json().catch(() => ({ error: "The checker sent an answer we cannot read. Try again." }));
    if (my !== runId) return;
    if (!r.ok || d.error) { showError(d.error || "The check stopped. Try again."); return; }
    history.replaceState(null, "", "/?u=" + encodeURIComponent(d.url));
    state = { ...d, title: d.current.title, archive_meta: null, archive: d.history.archive.slice(), cc: (d.history.cc || []).slice(), manual: null, failed: d.history.archive_failed, blocked: d.history.archive_blocked || 0, unusable: d.history.archive_unusable || 0 };
    $("mcur").value = d.current.currency || d.tld_currency || window.pasteCur || ""; window.pasteCur = "";
    $("result").classList.remove("hidden");
    $("search").classList.add("hidden"); $("assist").classList.add("hidden"); if (boxMode) boxMode();
    $("tip").textContent = "Tap a point to see its date and price."; $("pts").open = false;
    $("plink").href = d.url;
    $("others").classList.add("hidden"); state.revealed = null;
    // Black Friday week: "cheaper somewhere else?" leads. Its card shows from the first render (no layout shift later).
    const willCmp = !!(d.tracked && d.current.status === "ok");
    state.cmpScore = willCmp ? { done: 0, total: 1, matches: [] } : null; state.dealH = 0;
    $("cmpHead").classList.toggle("hidden", !willCmp);
    if (willCmp) setCmpHead("", "Checking other shops…", "We look for the exact same product for less.");
    renderHead(); renderPrices(); renderSupport(); renderAll(); renderSaveBtn();
    $("result").scrollIntoView({ behavior: "smooth", block: "start" });
    countCheck();
    if (willCmp) loadOthers(my);
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
        else if (d.status === "unusable") state.unusable++;
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

function renderAll() { if (!curPrice()) renderPrices(); renderChart(); renderArchiveNote(); renderVerdict(); renderTable(); renderShareLab(); }

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

// as src/features.js: a real move is >= 5 % and >= R5 (0.50 in other currencies)
const bigMove = (a, b, c) => Math.abs(b - a) >= Math.max(.05 * a, c == "ZAR" ? 5 : .5);
function sparseEvidence(P, W, h, C) {
  const recent = h.filter((x) => x.t >= Date.now() - 183 * DAY && x.price > 0);
  if (!P || !recent.length) return null;
  const pt = recent.reduce((m, x) => (x.price < m.price || (x.price === m.price && x.t > m.t) ? x : m));
  const maxOld = Math.max(...recent.map((x) => x.price));
  // "Inflated" needs a price >= 2 weeks old: a new sale is not a fake.
  const old = recent.filter((x) => x.t <= Date.now() - 14 * DAY);
  if (W && W > P && old.length) {
    const o = old.reduce((m, x) => (x.price < m.price ? x : m));
    if (o.price <= W * 0.9 && maxOld < W * 0.97) return { verdict: "Likely inflated was price", pt: o };
  }
  const mv = bigMove(pt.price, P, C);
  if (pt.price < P && mv) return { verdict: "Seen cheaper before", pt };
  if (pt.price <= P || !mv) return { verdict: "Seen at this price before", pt };
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
  state.dealIn = cur?.currency ? { P: cur.price, W: cur.was || null, C: cur.currency, pts: hist, archived: !!archivedAt } : null;
  if (!cur?.currency) {
    body = cur ? "We need the currency of today's price to compare it with the history." : "We need today's price. Type it in above to compare it with the history.";
    if (pr.length) body += ` History so far: lowest ${money(Math.min(...pr), ccy)}, typical ${money(median(pr), ccy)}.`;
    setVerdict("unk", "Can't judge yet", `<p class="vbody">${esc(body)}</p>`); state.verdictText = null; renderDeal(); return;
  }
  const P = cur.price, W = cur.was, C = cur.currency;
  if (pr.length < 3) {
    const ev = sparseEvidence(P, W, hist, C);
    if (ev) {
      const pt = ev.pt;
      const src = srcLink(pt);
      const when = `${esc(money(pt.price, C))} on ${esc(fmtDate(pt.t))} (${src})`;
      let vb;
      if (ev.verdict === "Likely inflated was price") { cls = "bad"; vb = `Was cheaper before: ${when}. The shop's "was" price of ${esc(money(W, C))} looks inflated.`; }
      else if (ev.verdict === "Seen cheaper before") { cls = "meh"; vb = `Seen cheaper before: ${when}. Today's price is ${esc(pct((P - pt.price) / pt.price))} higher.`; }
      else { cls = "meh"; vb = `About the same price before: ${when}. Today's price is not a special deal.`; }
      state.v = { big: ev.verdict, P, W, C, low: pt.price, evT: pt.t };
      setVerdict(cls, ev.verdict, `<p class="vbody">${vb}</p><p class="note">Based on ${pr.length} older price${pr.length === 1 ? "" : "s"} from the last 6 months. We give a full verdict from 3 older prices.</p>`);
      state.verdictText = ev.verdict; renderDeal(); return;
    }
    body = pr.length >= 1 ? `We found only ${pr.length} older price${pr.length === 1 ? "" : "s"} in ${C} (latest ${money(pr[pr.length - 1], C)} on ${fmtDate(hist[hist.length - 1].t)}). We need at least 3 to judge.` : `We found no older prices in ${C} for this product yet.`;
    body += state.tracked ? " Why: we found few or no older copies of this page in web archives. We saved today's price. We check it again regularly, so the history grows." : " Why: we found few or no older copies of this page in web archives.";
    if (W) body += ` The shop claims ${Math.round((W - P) / W * 100)}% off ${money(W, C)}. We need more history to confirm it.`;
    setVerdict("unk", "Not enough history", `<p class="vbody">${esc(body)}</p>`); state.verdictText = null; renderDeal(); return;
  }
  const low = Math.min(...pr), high = Math.max(...pr), med = median(pr);
  const high90 = p90.length >= 2 ? Math.max(...p90) : high;
  const vsMed = (med - P) / med;
  const inflated = W && W > high90 * 1.03;
  const neverSeen = W && W > high * 1.03;
  const mv = bigMove(med, P, C), cheaper = mv && P < med, dearer = mv && P > med;
  if (P <= low * 1.005 && cheaper) { cls = "good"; big = "Real deal"; body = `This is the lowest price we found in twelve months, ${pct(vsMed)} below the usual ${money(med, C)}.`; }
  else if (inflated && !cheaper) { cls = "bad"; big = "Fake discount"; body = `The "was" price looks inflated. Today's price is about what it usually costs (${money(med, C)}).`; }
  else if (dearer) { cls = "bad"; big = "Pricier than usual"; body = `It usually costs ${money(med, C)}. Today's price is ${pct(vsMed)} higher. Wait if you can.`; }
  else if (cheaper) { cls = "good"; big = "Decent deal"; body = `${pct(vsMed)} below the usual ${money(med, C)}, but it has been cheaper: ${money(low, C)}.`; }
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
  renderDeal();
}
// Deal Score + action (src/score.js): from the history above and, once compare has answers, the other shops.
// Space for the block is kept, so the chart below does not move when the shops answer.
function renderDeal() {
  const v = $("verdict"); if (!v || !state) return;
  let el = document.getElementById("deal");
  if (!el) { el = document.createElement("div"); el.id = "deal"; const big = v.querySelector(".big"); if (big) big.after(el); else v.prepend(el); }
  const i = state.dealIn;
  if (!i || i.archived) { el.className = "deal hidden"; el.innerHTML = ""; state.deal = null; return; }
  const d = dealScore({ P: i.P, W: i.W, C: i.C, pts: i.pts, cmp: state.cmpScore || null, fmt: money });
  state.deal = d;
  el.className = "deal " + d.cls;
  el.setAttribute("aria-live", "polite");
  const sc = d.score != null ? `<span class="dscore num" title="Deal Score: ${d.score} out of 100"><b>${d.score}</b><small>/100</small></span>` : `<span class="dscore none" title="No Deal Score yet"><b>–</b></span>`;
  el.innerHTML = `<div class="dtop">${sc}<span class="dpill">${esc(d.action)}</span><span class="dlab">${d.score != null ? "Deal Score" : "No Deal Score yet"}</span></div>`
    + `<div class="dwhys">${d.reasons.slice(0, 2).map((r) => `<p class="dwhy">${esc(r)}</p>`).join("")}</div>`;
  // never shrink (exact height, not rounded): the chart and buttons below stay where they are
  el.style.minHeight = (state.dealH || 0) + "px";
  const h = el.getBoundingClientRect().height; if (h > (state.dealH || 0)) { state.dealH = h; el.style.minHeight = h + "px"; }
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
  // solid line if points < 45 days apart, else dotted
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
    if (ai.status !== "ok") note = `We could not reach the Internet Archive just now, so its copies are missing. Use "Try the archive again".`;
    else if (!(ai.captures_12mo ?? ai.captures_6mo)) note = "The Internet Archive has no copies of this page from the last twelve months" + ((state.cc || []).length ? "." : ", so older prices are missing.");
    else { const n = ai.captures_12mo ?? ai.captures_6mo; note = `Archived copies: ${n} day${n === 1 ? "" : "s"} in 12 months. We looked at ${ai.sampled}.`; }
    if (state.failed) note += ` ${state.failed} had no price we could read.`;
    if (state.blocked) note += ` ${state.blocked} ${state.blocked === 1 ? "was a bot-check page or an empty page" : "were bot-check pages or empty pages"}, not the product page.`;
    if (state.unusable) note += ` ${state.unusable} showed the price for visitors outside the UK (without UK VAT or in another currency), so we left ${state.unusable === 1 ? "it" : "them"} out.`;
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
    el.innerHTML = state.blocked_shop.geo
      ? `<b>${esc(state.blocked_shop.name)} often blocks our checks.</b> This is its global site. The price changes with your country. Type the price and choose its currency below.`
      : `<b>${esc(state.blocked_shop.name)} often blocks our checks.</b> Type the price below.`;
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
}
function setCmpHead(cls, big, line, jump) {
  $("cmpHead").className = "card cmphead " + cls;
  $("cmpBig").textContent = big; $("cmpLine").textContent = line;
  $("cmpJump").classList.toggle("hidden", !jump);
}
// "Not compared": one small line, not a big card, so the history verdict leads.
const setCmpSlim = (why) => setCmpHead("slim", "", "Not compared with other shops: " + why);
const andList = (a, max = 4) => { a = a.length > max ? [...a.slice(0, max), `${a.length - max} more`] : a; return a.length > 1 ? a.slice(0, -1).join(", ") + " and " + a[a.length - 1] : a[0] || ""; };
// The headline from the compare results: the cheapest exact match in stock that saves at least R5 (or 0.50).
function cmpHeadline(plan, shops, results, herePrice, LEVEL) {
  const C = plan.product.currency, n = shops.length, done = shops.filter((s) => results[s.id]).length;
  const inStock = shops.map((s) => results[s.id]).filter((r) => r && r.status === "match" && r.match && r.match.in_stock);
  const minSave = C === "ZAR" ? 5 : 0.5;
  const cheaper = herePrice == null ? [] : inStock.filter((r) => herePrice - r.match.price >= minSave).sort((a, b) => a.match.price - b.match.price);
  if (cheaper.length) {
    const b = cheaper[0], save = Math.round((herePrice - b.match.price) * 100) / 100;
    const more = cheaper.length > 1 ? ` Also cheaper at ${andList(cheaper.slice(1).map((r) => r.name))}.` : "";
    if (b.match.flyer) {
      // never "1 for R10" when the flyer says "10 for R100": the multi-buy rule is in the headline
      const f = b.match.flyer, each = f.qty > 1;
      const more = cheaper.length > 1 ? ` Also cheaper at ${andList(cheaper.slice(1).map((r) => r.name))}.` : "";
      return ["good", `Cheaper at ${b.name}: ${money(b.match.price, C)}${each ? ` each when you buy ${f.qty}` : ""}`, `Save ${money(save, C)}${each ? " on each item" : ""} (${pct(save / herePrice)}). ${f.need ? f.need + ". " : ""}${f.limit ? f.limit + ". " : ""}${f.badges && f.badges.length ? `Card deal: ${f.badges.join(", ")}. ` : ""}In-store flyer deal: ${f.label.replace(/^[^(]*\(|\)$/g, "")}.${f.fine ? " " + f.fine : ""} Same name and size on the flyer.${more}${done < n ? ` Still checking ${n - done} more.` : ""}`, true, { best: { name: b.name, price: b.match.price, save, C, note: each ? `each when you buy ${f.qty}, in-store flyer deal` : "in-store flyer deal" } }];
    }
    const chk = b.match.level === "name" || b.match.level === "ai" ? " Check the model and colour on the shop's page." : "";
    const same = b.match.level === "ai" ? "An AI check says it is the same product." : `${LEVEL[b.match.level] || "Same product"} as this product.`;
    return ["good", `Cheaper at ${b.name}: ${money(b.match.price, C)}`, `Save ${money(save, C)} (${pct(save / herePrice)}). ${same}${chk}${more}${done < n ? ` Still checking ${n - done} more.` : " Delivery not included."}`, true, { best: { name: b.name, price: b.match.price, save, C } }];
  }
  if (done < n) return ["", `Checking ${n} shop${n === 1 ? "" : "s"}…`, `${done} of ${n} done. We look for the exact same product for less.`];
  const failed = shops.filter((s) => results[s.id] && !["match", "none", "skipped", "robots"].includes(results[s.id].status)).map((s) => s.name);
  const cant = [...shops.filter((s) => results[s.id] && results[s.id].status === "robots").map((s) => s.name), ...(plan.notSearched || []).map((x) => x.name)];
  let line;
  if (herePrice == null && inStock.length) {
    const lo = inStock.reduce((m, r) => (r.match.price < m.match.price ? r : m));
    return ["", `Found at ${inStock.length} other shop${inStock.length === 1 ? "" : "s"}`, `Lowest: ${lo.name}, ${money(lo.match.price, C)}. We can't compare it with this page's price (other currency).`, true];
  }
  if (inStock.length) line = `We checked ${n} shop${n === 1 ? "" : "s"}. ${inStock.length} sell${inStock.length === 1 ? "s" : ""} the exact same product, but not for less.`;
  else line = `We checked ${n} shop${n === 1 ? "" : "s"}. None has the exact same product in stock.`;
  if (failed.length) line += ` Couldn't check ${andList(failed)}.`;
  if (cant.length) line += ` We can't search ${andList(cant)}.`;
  return ["", "No cheaper exact match found", line, true, { none: n }];
}
async function loadOthers(my) {
  if (!state.tracked || !state.current || state.current.status !== "ok") return;
  const canon = state.canonical, sec = $("others");
  let plan;
  const fail = () => { if (my === runId) { setCmpHead("", "Couldn't check other shops", "Try again later with Check again."); state.cmpScore = null; renderDeal(); } };
  try { const r = await fetch("/api/compare?url=" + encodeURIComponent(canon)); if (!r.ok) return fail(); plan = await r.json(); } catch { return fail(); }
  if (my !== runId) return;
  if (!plan || !plan.product) { state.cmpScore = null; renderDeal(); return setCmpSlim("we couldn't read enough about this product."); }
  const here = curPrice(), shops = plan.shops || [], results = Object.assign({}, plan.results || {});
  sec.classList.remove("hidden");
  if (!shops.length) {
    state.cmpScore = null; renderDeal();
    $("otherList").innerHTML = ""; $("cmpProg").classList.add("hidden"); $("cmpStatus").textContent = "";
    $("cmpSum").textContent = plan.reason === "own brand" ? "This is a shop's own brand. Other shops don't sell it, so we didn't compare."
      : plan.noun ? `We don't know other shops here that sell ${plan.noun} yet, so we didn't compare.` : "We couldn't tell what kind of product this is, so we didn't search other shops.";
    setCmpSlim(plan.reason === "own brand" ? "this is a shop's own brand." : plan.noun ? `we don't know other shops that sell ${plan.noun} yet.` : "we couldn't tell what kind of product this is.");
    return;
  }
  const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "just now" : m < 60 ? m + " min ago" : Math.round(m / 60) + " h ago"; };
  // ai = the names are not the same word for word, and an AI check says it is the same product (src/compare.js).
  const LEVEL = { barcode: "Same barcode", model: "Same model number", name: ["groceries", "baby"].includes(plan.product.category) ? "Same name and size" : "Same name and specs", ai: "Same product (AI check)" };
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
      if (m.flyer) {
        // flyer deal (src/flyer.js): the price for one item, the multi-buy rule in words, the shop's home page
        rows.push({ price: m.price, html: `<span class="os"><b>${esc(r.name)}</b><span class="ot">${esc(m.title)}</span><span class="ot">${esc(m.flyer.label)}</span><span class="ot">${esc(m.flyer.need || m.flyer.deal)}${m.flyer.limit ? ". " + esc(m.flyer.limit) : ""}</span>${m.flyer.regular ? `<span class="ot">${esc(m.flyer.regular)}</span>` : ""}${m.flyer.note ? `<span class="ot">${esc(m.flyer.note)}</span>` : ""}${m.flyer.fine ? `<span class="ot">${esc(m.flyer.fine)}</span>` : ""}<span class="tag">In-store flyer deal</span>${(m.flyer.badges || []).map((b) => `<span class="tag card" title="Loyalty card deal">${esc(b)}</span>`).join("")}<span class="tag">Same name and size</span>${isLow(m.price) ? lowTag : ""}</span><span class="op"><b class="num">${esc(money(m.price, m.currency))}${m.flyer.qty > 1 ? " each" : ""}</b>${diff}<a href="${esc(m.url)}" target="_blank" rel="noopener nofollow">Shop site ↗</a></span>` });
        continue;
      }
      rows.push({ price: m.price, html: `<span class="os"><b>${esc(r.name)}</b><span class="ot">${esc(m.title)}</span><span class="tag ${m.level === "barcode" || m.level === "model" ? "sure" : ""}">${esc(LEVEL[m.level] || "Same product")}</span>${m.in_stock && isLow(m.price) ? lowTag : ""}${m.in_stock ? "" : '<span class="tag oos">Out of stock</span>'}</span><span class="op"><b class="num">${esc(money(m.price, m.currency))}</b>${m.was ? `<span class="was small">${esc(money(m.was, m.currency))}</span>` : ""}${m.member ? `<span class="small">${esc(m.member.label)} ${esc(money(m.member.price, m.currency))}</span>` : ""}${diff}<a href="${esc(m.url)}" target="_blank" rel="noopener nofollow">Open ↗</a><span class="small">${esc(ago(r.checked_at))}</span></span>`, oos: !m.in_stock });
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
    const parts = [], names = shops.map((s) => s.name).join(", "), n = shops.length;
    const spec = shops.filter((s) => !s.general), gen = shops.filter((s) => s.general), k = spec.length;
    const specTxt = plan.shopNoun ? `${k} ${plan.shopNoun}${k === 1 ? "" : "s"}` : `${k} shop${k === 1 ? " that sells" : "s that sell"} ${plan.noun}`;
    const genTxt = gen.length ? ` and ${gen.length} general shop${gen.length === 1 ? "" : "s"} (${gen.map((s) => s.name).join(", ")})` : "";
    if (plan.noun && plan.specialists) parts.push(gen.length ? `Checked ${specTxt} (${spec.map((s) => s.name).join(", ")})${genTxt}.` : `Checked ${specTxt}: ${names}.`);
    else if (plan.noun) parts.push(`We don't know shops here that specialise in ${plan.noun} yet, so we checked ${n === 1 ? "a general shop" : "general shops"}: ${names}.`);
    else parts.push(`We couldn't tell what kind of product this is, so we only checked ${n === 1 ? "a general shop" : "general shops"}: ${names}.`);
    if (done === shops.length && !matches.length) parts.push(n === 1 ? "No exact match there." : "No exact match at any of them.");
    if (matches.length && none.length) parts.push(`Not found at: ${none.join(", ")}.`);
    if (failed.length) parts.push(`Couldn't check: ${failed.join(", ")} (try again later).`);
    if (asked.length) parts.push(`Not searched: ${asked.join(", ")} (the shop asks tools not to use its search).`);
    const ns = plan.notSearched || [], nsBy = (w) => ns.filter((x) => x.why === w).map((x) => x.name), and = (a) => a.length > 1 ? a.slice(0, -1).join(", ") + " and " + a[a.length - 1] : a[0];
    const nsTxt = [["robots", "ask tools not to use their search"], ["browser", "show search results only in a browser"], ["blocks", "block tools like ours"]].filter(([w]) => nsBy(w).length).map(([w, t]) => `${and(nsBy(w))} (${t})`);
    if (nsTxt.length && done === shops.length) parts.push(`We can't search ${nsTxt.join("; ")}.`);
    $("cmpSum").textContent = parts.join(" ");
    const [hc, hb, hl, hj, share] = cmpHeadline(plan, shops, results, herePrice, LEVEL);
    setCmpHead(hc, hb, hl, hj || hc === "good");
    state.cmp = share || null;
    // the Deal Score uses the same in-stock matches (same currency only)
    state.cmpScore = herePrice == null ? null : { done, total: shops.length, matches: matches.map((r) => ({ name: r.name, price: r.match.price, in_stock: !!r.match.in_stock, flyerQty: r.match.flyer ? r.match.flyer.qty || 1 : 0 })) };
    renderDeal(); renderShareLab();
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
// ---------- product search by name: /api/search (the shops), then /api/search/shop (one shop at a time) ----------
// A slow shop never blocks the others: each shop's products show as soon as they come in, cheapest first.
let searchId = 0;
const NS_WHY = [["robots", "ask tools not to use their search"], ["browser", "show search results only in a browser"], ["blocks", "block tools like ours"]];
const srchAnd = (a) => (a.length > 1 ? a.slice(0, -1).join(", ") + " and " + a[a.length - 1] : a[0] || "");
const MAX_SHOWN = 30;
async function search(q, c) {
  q = String(q || "").replace(/\s+/g, " ").trim();
  c = c === "GB" ? "GB" : "ZA";
  const my = ++searchId; runId++;
  const where = c === "GB" ? "the UK" : "South Africa";
  document.documentElement.classList.add("q");
  $("error").classList.add("hidden");
  const S = $("search"), go = $("go");
  const finish = () => { if (my !== searchId) return; go.disabled = false; boxMode(); };
  go.disabled = true; go.innerHTML = '<span class="spin"></span>Searching…';
  let plan;
  try {
    const r = await fetch(`/api/search?q=${encodeURIComponent(q)}&c=${c}`);
    plan = await r.json().catch(() => ({ error: "The search sent an answer we cannot read. Try again." }));
    if (my !== searchId) return;
    if (!r.ok || plan.error) { finish(); showError(plan.error || "The search stopped. Try again."); return; }
  } catch { if (my === searchId) { finish(); showError("Couldn't reach the search. Check your connection and try again."); } return; }
  history.replaceState(null, "", "/?q=" + encodeURIComponent(plan.q).replace(/%20/g, "+") + "&c=" + c);
  $("result").classList.add("hidden"); $("assist").classList.add("hidden");
  S.classList.remove("hidden"); boxMode();
  $("sLab").textContent = "Search results · shops in " + where;
  $("sTitle").textContent = "\u201c" + plan.q + "\u201d";
  $("sList").innerHTML = ""; $("sEmpty").classList.add("hidden"); $("sShops").textContent = "";
  document.title = plan.q + " · Search · Deal or Dud?";
  const shops = plan.shops || [], results = {};
  // "Food Lover's Market prices come from its printed flyer, for one item." (one or more flyers)
  const flyerNote = (items) => {
    const names = [...new Set(items.filter((x) => x.flyer).map((x) => x.label.replace(/\s*\(.*$/, "")))];
    if (!names.length) return "";
    return names.length === 1 ? ` ${names[0]} prices come from its printed flyer, for one item.` : ` ${andList(names)} prices come from their printed flyers, for one item.`;
  };
  const render = () => {
    if (my !== searchId) return;
    const done = shops.filter((s) => results[s.id]);
    const seen = new Set(), items = [];
    // flyer deals share one link (the shop's home page): keep them apart by their id
    for (const s of shops) for (const it of ((results[s.id] || {}).items || [])) { const k = it.flyer ? "flyer:" + it.id : it.url; if (!seen.has(k)) { seen.add(k); items.push({ ...it, shop: s.name }); } }
    // a search for a main product (plan.device, src/search.js): the products themselves first, then lowest price
    items.sort((a, b) => (a.rank || 0) - (b.rank || 0) || a.price - b.price);
    const shown = items.slice(0, MAX_SHOWN);
    const dev = plan.device, hidden = done.reduce((n, s) => n + ((results[s.id] || {}).hidden || 0), 0);
    const isLow = (it, i) => i === 0 && done.length === shops.length && (!dev || !it.rank);
    const lowTxt = (it, i) => (isLow(it, i) && items.length > 1 ? (it.flyer && it.multi ? ` · lowest price for one, when you buy ${it.qty}` : dev ? ` · lowest price we found (${dev})` : " · lowest price we found") : "");
    $("sList").innerHTML = shown.map((it, i) => it.flyer
      // a flyer deal: the flyer's own words, the multi-buy rule, no price history (it is not a product page)
      ? `<li class="fl${isLow(it, i) ? " low" : ""}"><div class="st">${esc(it.title)}</div>`
        + `<div class="sm"><span class="sp num">${esc(it.deal)}</span><span class="small">${esc(it.label)}${esc(lowTxt(it, i))}</span></div>`
        + (it.need || it.limit || it.regular ? `<div class="small fn">${esc([it.need, it.limit, it.regular].filter(Boolean).join(". "))}.</div>` : "")
        + (it.note ? `<div class="small fn">${esc(it.note)}</div>` : "")
        + (it.fine ? `<div class="small fn fp">${esc(it.fine)}</div>` : "")
        + `<div class="sa"><span class="ftag">In-store flyer deal</span>${(it.badges || []).map((b) => `<span class="ftag card" title="Loyalty card deal">${esc(b)}</span>`).join("")}<a href="${esc(it.url)}" target="_blank" rel="noopener nofollow">${esc(it.site || "Shop site")} ↗</a></div></li>`
      : `<li${isLow(it, i) ? ' class="low"' : ""}><div class="st">${esc(it.title)}</div>`
      + `<div class="sm"><span class="sp num">${it.from ? "From " : ""}${esc(money(it.price, it.currency))}</span><span class="small">${esc(it.shop)}${esc(lowTxt(it, i))}</span></div>`
      + `<div class="sa"><button type="button" data-u="${esc(it.url)}">Check price history</button><a href="${esc(it.url)}" target="_blank" rel="noopener nofollow">Open at shop ↗</a></div></li>`).join("");
    const shopsWith = new Set(items.map((x) => x.shop)).size;
    if (!shops.length) $("sStatus").textContent = "";
    else if (done.length < shops.length) $("sStatus").innerHTML = `<span class="spin"></span>Searching ${shops.length} shop${shops.length === 1 ? "" : "s"}… ${done.length} of ${shops.length} done.`;
    else $("sStatus").textContent = items.length ? `${items.length > MAX_SHOWN ? `The ${MAX_SHOWN} lowest of ${items.length}` : items.length} product${items.length === 1 ? "" : "s"} at ${shopsWith} shop${shopsWith === 1 ? "" : "s"}, ${dev ? `${dev} first, then lowest price` : "lowest price first"}. The prices come from each shop now.${flyerNote(items)}` : "";
    if (done.length === shops.length && hidden) $("sStatus").textContent += `${items.length ? " " : ""}We did not show ${hidden} accessor${hidden === 1 ? "y" : "ies"}, games or covers. To find them, add the word to your search, for example \u201c${plan.accessory_example}\u201d.`;
    const empty = done.length === shops.length && !items.length;
    $("sEmpty").classList.toggle("hidden", !empty);
    if (empty) $("sEmpty").textContent = shops.length ? `We found no products in stock with all of these words. Use fewer words, or paste a product link.` : `We have no shops in ${where} that we can search for this. Paste a product link to check its price.`;
    const by = (st) => done.filter((s) => (Array.isArray(st) ? st : [st]).includes(results[s.id].status)).map((s) => s.name);
    const parts = [];
    const searched = by(["ok", "none"]);
    if (searched.length) parts.push(`Searched: ${searched.join(", ")}.`);
    const fail = by(["error", "busy", "blocked"]);
    if (fail.length) parts.push(`Couldn't search now: ${fail.join(", ")} (try again later).`);
    const robots = by("robots");
    if (robots.length) parts.push(`Not searched: ${robots.join(", ")} (the shop asks tools not to use its search).`);
    const ns = plan.notSearched || [];
    const nsTxt = NS_WHY.map(([w, t]) => [ns.filter((x) => x.why === w).map((x) => x.name), t]).filter(([n]) => n.length).map(([n, t]) => `${srchAnd(n)} (${t})`);
    if (nsTxt.length && done.length === shops.length) parts.push(`We can't search ${nsTxt.join("; ")}.`);
    $("sShops").textContent = parts.join(" ");
    if (done.length === shops.length) finish();
  };
  render();
  const queue = shops.slice();
  const worker = async () => {
    while (queue.length) {
      const s = queue.shift();
      let r;
      try { const res = await fetch(`/api/search/shop?q=${encodeURIComponent(plan.q)}&c=${c}&shop=${encodeURIComponent(s.id)}`); r = await res.json(); } catch { r = null; }
      if (my !== searchId) return;
      results[s.id] = r && r.status ? r : { shop: s.id, name: s.name, status: "error", items: [] };
      render();
    }
  };
  await Promise.all([worker(), worker(), worker(), worker(), worker()]);
  finish();
}
// ---------- AI Shopping Assistant: /api/assist (src/assist.js) ----------
// The server reads the request (Workers AI or rules), searches the shops, and sends the top 3 real products.
// Every product, price, shop and link here comes from a shop's own site. The AI only writes the short reasons.
const shareUrl = (q, c) => SITE + "/?q=" + encodeURIComponent(q).replace(/%20/g, "+") + "&c=" + c;
let assistShare = "";
async function assist(q, c) {
  q = String(q || "").replace(/\s+/g, " ").trim();
  c = c === "GB" ? "GB" : "ZA";
  const my = ++searchId; runId++;
  document.documentElement.classList.add("q");
  $("error").classList.add("hidden");
  const S = $("assist"), go = $("go");
  const finish = () => { if (my !== searchId) return; go.disabled = false; boxMode(); };
  go.disabled = true; go.innerHTML = '<span class="spin"></span>Finding picks…';
  $("result").classList.add("hidden"); $("search").classList.add("hidden");
  S.classList.remove("hidden");
  const where = (x) => (x === "GB" ? "the UK" : "South Africa");
  $("asLab").textContent = "AI Shopping Assistant · shops in " + where(c);
  $("asTitle").textContent = "\u201c" + q + "\u201d";
  $("asWhat").textContent = "";
  $("asStatus").innerHTML = '<span class="spin"></span>Checking shops now…';
  ["asH", "asNoteTop", "asEmpty", "asMore", "asAct"].forEach((id) => $(id).classList.add("hidden"));
  $("asPicks").innerHTML = ""; $("asList").innerHTML = ""; $("asShops").textContent = "";
  $("asMore").open = false;
  document.title = q + " · Picks · Deal or Dud?";
  boxMode();
  let d;
  try {
    const r = await fetch(`/api/assist?q=${encodeURIComponent(q)}&c=${c}`);
    d = await r.json().catch(() => ({ error: "The search sent an answer we cannot read. Try again." }));
    if (my !== searchId) return;
    if (!r.ok || d.error) { S.classList.add("hidden"); finish(); showError(d.error || "The search stopped. Try again."); return; }
  } catch { if (my === searchId) { S.classList.add("hidden"); finish(); showError("Couldn't reach the search. Check your connection and try again."); } return; }
  // a budget in pounds searches UK shops (and rand, South African shops)
  if (d.country !== c && setCc) setCc(d.country);
  history.replaceState(null, "", "/?q=" + encodeURIComponent(d.q).replace(/%20/g, "+") + "&c=" + d.country);
  assistShare = shareUrl(d.q, d.country);
  $("asLab").textContent = "AI Shopping Assistant · shops in " + where(d.country);
  $("asWhat").textContent = d.understanding || "";
  const picks = d.picks || [], more = d.more || [];
  // shops with a match among all matches (not only the products on the page)
  const shopsN = d.shop_count != null ? d.shop_count : new Set(picks.concat(more).map((x) => x.shop)).size;
  $("asStatus").textContent = picks.length ? `We found ${d.total} matching product${d.total === 1 ? "" : "s"} at ${shopsN} shop${shopsN === 1 ? "" : "s"}. The prices come from each shop now.` : "";
  $("asH").classList.toggle("hidden", !picks.length);
  $("asH").textContent = picks.length === 1 ? "Top pick" + (d.intent && d.intent.maxBudget != null ? " for your budget" : "") : `Top ${picks.length} picks` + (d.intent && d.intent.maxBudget != null ? " for your budget" : "");
  const noteTop = picks.length && d.note ? d.note : "";
  $("asNoteTop").textContent = noteTop; $("asNoteTop").classList.toggle("hidden", !noteTop);
  const ob = (it) => (it.over_budget ? '<span class="obud">Over budget</span>' : "");
  $("asPicks").innerHTML = picks.map((p, i) => `<li><span class="rk">#${i + 1}${i === 0 ? " Best match" : ""}</span>${ob(p)}`
    + `<div class="st">${esc(p.title)}</div>`
    + `<div class="sm"><span class="sp num">${esc(money(p.price, p.currency))}</span><span class="small">${esc(p.shop)}</span></div>`
    + `<p class="why">${esc(p.reason)}</p>`
    + `<div class="sa"><button type="button" data-u="${esc(p.url)}">Check price history</button><a href="${esc(p.url)}" target="_blank" rel="noopener nofollow">Open at shop ↗</a></div></li>`).join("");
  $("asEmpty").classList.toggle("hidden", !!picks.length);
  if (!picks.length) $("asEmpty").textContent = d.note || "We found no products in stock that match. Use other words, or paste a product link.";
  $("asMore").classList.toggle("hidden", !more.length);
  $("asMoreSum").textContent = `All matching results (${more.length} more)`;
  $("asList").innerHTML = more.map((it) => `<li><div class="st">${esc(it.title)}</div>`
    + `<div class="sm"><span class="sp num">${esc(money(it.price, it.currency))}</span><span class="small">${esc(it.shop)}</span>${ob(it)}</div>`
    + `<div class="sa"><button type="button" data-u="${esc(it.url)}">Check price history</button><a href="${esc(it.url)}" target="_blank" rel="noopener nofollow">Open at shop ↗</a></div></li>`).join("");
  $("asAct").classList.toggle("hidden", !picks.length);
  const sh = d.shops || {}, parts = [];
  if ((sh.searched || []).length) parts.push(`Searched: ${sh.searched.join(", ")}.`);
  if ((sh.failed || []).length) parts.push(`Couldn't search now: ${sh.failed.join(", ")} (try again later).`);
  if ((sh.robots || []).length) parts.push(`Not searched: ${sh.robots.join(", ")} (the shop asks tools not to use its search).`);
  const ns = sh.notSearched || [];
  const nsTxt = NS_WHY.map(([w, t]) => [ns.filter((x) => x.why === w).map((x) => x.name), t]).filter(([n]) => n.length).map(([n, t]) => `${srchAnd(n)} (${t})`);
  if (nsTxt.length) parts.push(`We can't search ${nsTxt.join("; ")}.`);
  $("asShops").textContent = parts.join(" ");
  finish();
}
$("asShare").addEventListener("click", async () => {
  if (!assistShare) return;
  try { if (navigator.share && matchMedia("(pointer:coarse)").matches) { await navigator.share({ title: "Top picks · Deal or Dud?", url: assistShare }); return; } } catch (e) { if (e && e.name === "AbortError") return; }
  try { await navigator.clipboard.writeText(assistShare); toast("Link copied."); } catch { prompt("Copy this link:", assistShare); }
});
// "Check price history": runs the normal check on that product (Back returns to the search)
const checkFromList = (list) => (e) => {
  const b = e.target.closest("button[data-u]"); if (!b) return;
  const u = b.dataset.u;
  list.querySelectorAll('button[aria-busy="true"]').forEach((x) => { x.removeAttribute("aria-busy"); x.textContent = "Check price history"; });
  b.setAttribute("aria-busy", "true"); b.textContent = "Checking…";
  history.pushState(null, "", location.href);
  $("u").value = u;
  run(u).finally(() => { b.removeAttribute("aria-busy"); b.textContent = "Check price history"; });
};
["sList", "asPicks", "asList"].forEach((id) => $(id).addEventListener("click", checkFromList($(id))));

return { run, search, assist, openSaved, ask: () => (state && !state.shop ? [state.host, state.url] : ["", ""]) };
});
