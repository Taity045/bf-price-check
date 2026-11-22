// Headless Chrome UI test at iPhone size (390x844, touch). Usage: node ui_test.js BASE_URL OUT_DIR
const { chromium } = require('/tmp/pw/node_modules/playwright-core');
const base = process.argv[2] || 'https://bf-price-check.lala-board.workers.dev';
const out = process.argv[3] || '..';
const res = []; const ok = (n, p, i = '') => { res.push({ n, p: !!p, i }); console.log((p ? 'PASS ' : 'FAIL ') + n + (i ? ' — ' + i : '')); };
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  ctx.setDefaultTimeout(90000);
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(base + '/?v=' + Date.now(), { waitUntil: 'networkidle' });
  await p.screenshot({ path: out + '/screenshot-1-home.png' });
  const audit = async (sels) => p.evaluate((sels) => { const o = []; for (const s of sels) { const el = [...document.querySelectorAll(s)].find(e => e.offsetParent); if (!el) { o.push({ s, missing: true }); continue; } el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); o.push({ s, w: Math.round(r.width), h: Math.round(r.height), ta: getComputedStyle(el).touchAction, hit: !!hit && (hit === el || el.contains(hit)) }); } scrollTo(0, 0); return o; }, sels);
  for (const a of await audit(['#u', '#paste', '#go', '.chip'])) ok(`Target ${a.s} ${a.w}x${a.h} touch-action:${a.ta} not covered`, !a.missing && a.w >= 44 && a.h >= 44 && (a.s === '#u' || /manipulation/.test(a.ta)) && a.hit);
  const bg = await p.evaluate(() => getComputedStyle(document.querySelector('.bgfx')).pointerEvents);
  ok('Decorative layer has pointer-events:none', bg === 'none');
  // bad input
  await p.fill('#u', 'http://127.0.0.1/admin'); await p.tap('#go');
  await p.waitForSelector('#error:not(.hidden)'); ok('Private IP is rejected', /not a public|IP address/i.test(await p.textContent('#error')), await p.textContent('#error'));
  // 1) Currys example chip (live blocked -> archive history + manual)
  await p.tap('.chip >> text=Currys');
  await p.waitForSelector('#result:not(.hidden)');
  await p.waitForFunction(() => /Read \d+ archived|no copies|isn't available|has \d+ day/.test(document.body.innerText), null, { timeout: 120000 }).catch(() => {});
  await p.waitForTimeout(1500);
  const cur1 = await p.evaluate(() => ({ prices: document.getElementById('prices').innerText, src: document.getElementById('psrc').innerText, manual: !document.getElementById('manualbox').classList.contains('hidden'), verdict: document.getElementById('verdict').innerText, dots: document.querySelectorAll('#chart circle[data-i]').length, note: document.getElementById('archnote').innerText }));
  ok('Currys: blocked live price explained + manual entry shown', cur1.manual, cur1.src);
  ok('Currys: archive dots drawn', cur1.dots >= 3, `${cur1.dots} dots; ${cur1.note}`);
  await p.screenshot({ path: out + '/screenshot-2-currys-blocked-live.png', fullPage: true });
  await p.fill('#mnow', '129'); await p.fill('#mwas', '179'); await p.tap('#mapply'); await p.waitForTimeout(400);
  const v2 = await p.evaluate(() => document.getElementById('verdict').innerText);
  ok('Manual price gives a verdict', /deal|price|discount/i.test(v2), v2.split('\n').slice(0, 2).join(' | '));
  const t = await p.$('#chart circle[data-i]'); if (t) { await t.tap(); await p.waitForTimeout(200); ok('Tap on chart dot shows tooltip', /·/.test(await p.textContent('#tip')), await p.textContent('#tip')); }
  await p.evaluate(() => document.getElementById('verdict').scrollIntoView({ block: 'start' }));
  await p.screenshot({ path: out + '/screenshot-3-currys-manual-verdict.png' });
  // 2) MediaMarkt (live + history)
  await p.evaluate(() => scrollTo(0, 0));
  await p.tap('.chip >> text=MediaMarkt');
  await p.waitForFunction(() => /MTJV3ZM|AIRPODS PRO 2ND/i.test(document.getElementById('ptitle').innerText), null, { timeout: 90000 });
  await p.waitForFunction(() => /Read \d+ archived|no copies|isn't available|has \d+ day/.test(document.body.innerText), null, { timeout: 120000 }).catch(() => {});
  await p.waitForTimeout(1500);
  const mm = await p.evaluate(() => ({ prices: document.getElementById('prices').innerText, verdict: document.getElementById('verdict').innerText }));
  ok('MediaMarkt: live EUR price shown', /€/.test(mm.prices), mm.prices.replace(/\n/g, ' '));
  await p.screenshot({ path: out + '/screenshot-4-mediamarkt.png', fullPage: true });
  // 3) Takealot (live, was price, no history)
  await p.evaluate(() => scrollTo(0, 0));
  await p.tap('.chip >> text=Takealot');
  await p.waitForFunction(() => /AirPods Pro 3/.test(document.getElementById('ptitle').innerText), null, { timeout: 90000 });
  await p.waitForTimeout(4000);
  const tk = await p.evaluate(() => ({ prices: document.getElementById('prices').innerText, verdict: document.getElementById('verdict').innerText }));
  ok('Takealot: ZAR price + was price', /R/.test(tk.prices) && /claimed/.test(tk.prices), tk.prices.replace(/\n/g, ' '));
  ok('Takealot: honest "not enough history"', /Not enough history|history/i.test(tk.verdict), tk.verdict.split('\n')[0]);
  await p.screenshot({ path: out + '/screenshot-5-takealot.png' });
  // buttons at the bottom of the result
  for (const a of await audit(['#share', '#again', '#pts summary', '#mapply'])) if (!a.missing) ok(`Target ${a.s} ${a.w}x${a.h} touch-action:${a.ta} not covered`, a.w >= 44 && a.h >= 44 && a.hit);
  await p.evaluate(() => { navigator.share = undefined; navigator.clipboard.writeText = async () => {}; });
  await p.evaluate(() => document.getElementById('share').scrollIntoView({ block: 'center' }));
  await p.tap('#share'); await p.waitForTimeout(300);
  ok('Share button responds (copy toast)', /copied/i.test(await p.textContent('#toast')), await p.textContent('#toast'));
  await p.tap('#pts summary'); await p.waitForTimeout(200);
  ok('Data point table opens', await p.evaluate(() => document.getElementById('pts').open));
  // bottom of page reachable and tappable
  await p.evaluate(() => scrollTo(0, document.body.scrollHeight)); await p.waitForTimeout(300);
  const bottomHit = await p.evaluate(() => { const el = document.getElementById('again'); el.scrollIntoView({ block: 'end' }); const r = el.getBoundingClientRect(); const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return h === el || el.contains(h); });
  ok('Bottom buttons are not covered', bottomHit);
  await p.screenshot({ path: out + '/screenshot-6-bottom.png' });
  // share link loads directly
  const p2 = await ctx.newPage();
  await p2.goto(base + '/?u=' + encodeURIComponent('https://www.amazon.co.uk/Atomic-Habits-Proven-Build-Break/dp/1847941834'), { waitUntil: 'networkidle' });
  await p2.waitForFunction(() => /Atomic Habits/.test(document.getElementById('ptitle').innerText), null, { timeout: 90000 });
  await p2.waitForTimeout(5000);
  const az = await p2.evaluate(() => ({ prices: document.getElementById('prices').innerText, verdict: document.getElementById('verdict').innerText.split('\n')[0] }));
  ok('Shared link (?u=) auto-runs: Amazon UK', /£/.test(az.prices), az.prices.replace(/\n/g, ' ') + ' | ' + az.verdict);
  await p2.screenshot({ path: out + '/screenshot-7-amazon-uk-shared-link.png', fullPage: true });
  ok('No JavaScript errors', errs.length === 0, errs.join(' | '));
  await b.close();
  require('fs').writeFileSync(out + '/ui_test_results.json', JSON.stringify(res, null, 1));
  console.log(`\n${res.filter(r => r.p).length}/${res.length} passed`);
})().catch(e => { console.error(e); process.exit(1); });
