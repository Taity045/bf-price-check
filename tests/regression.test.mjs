import assert from 'node:assert/strict';
import test from 'node:test';
import { worker } from './helpers/load-worker.mjs';
import { testDb, schema } from './helpers/db.mjs';

// Integration tests: the whole worker against an in-memory D1 and a fake network.
const localDatabase = () => testDb();

// DNS-over-HTTPS resolvers used by resolvesPublic().
const DOH = new Set(['1.1.1.1', 'dns.google', 'cloudflare-dns.com']);
const product = 'https://shop.example/product?variant=large';
const ts = new Date(Date.now() - 8 * 86400000).toISOString().replace(/\D/g, '').slice(0, 14);

function publicDns(url) {
  return Response.json({ Status: 0, Answer: url.searchParams.get('type') === 'A' ? [{ type: 1, data: '1.1.1.1' }] : [] });
}

function fixture(t, remote, dns = publicDns) {
  const { db, env } = localDatabase();
  t.after(() => db.close());
  t.mock.method(globalThis, 'fetch', (raw, init) => {
    const url = new URL(raw);
    return DOH.has(url.hostname) ? dns(url) : remote(url, init);
  });
  return {
    db,
    async api(path, args = { url: product }) {
      const r = await worker.fetch(new Request('https://checker.example/api/' + path + '?' + new URLSearchParams(args), { headers: { 'user-agent': 'Mozilla/5.0 (regression test)' } }), env, { waitUntil() {} });
      return { status: r.status, body: await r.json() };
    },
    async tick(time) {
      let job;
      // Minute 0 of the hour: not a seed-list slot (minute 5, 15, ...), so no extra network calls.
      await worker.scheduled({ scheduledTime: time - (time % 3600000) }, env, { waitUntil(p) { job = p; } });
      await job;
    },
  };
}

function page(price = 1999) {
  return new Response('<script>' + JSON.stringify({
    currentPrice: { currencyCode: 'GBP', centAmount: price },
    listPrice: { amount: 29.99, currencyCode: 'GBP' },
  }) + '</script>');
}

test('live prices, cached prices and stored history use the same units', async (t) => {
  const { db, api } = fixture(t, () => page());
  db.prepare('INSERT INTO cache VALUES (?, ?, ?)').run('chk:' + product, '{"price":1999}', Date.now() + 3600000);
  for (const [price, source] of [[1999, 'page-data'], [19.5, 'json-ld']]) {
    db.prepare('INSERT INTO checks(url, ts, price, source) VALUES (?, ?, ?, ?)').run(product, Date.now() - 86400000, price, source);
  }
  const { body } = await api('check');
  assert.equal(body.current.price, 19.99);
  assert.equal(body.current.was, 29.99);
  assert.equal(body.current.currency, 'GBP');
  assert.deepEqual(body.history.checks.map(p => p.price), [19.5, 19.99]);
  assert.equal((await api('check')).body.cached, true);
  db.exec(schema);
  assert.equal(db.prepare('SELECT count(*) AS n FROM tracked').get().n, 1);
});

test('redirects are checked before download and cron revalidates DNS', async (t) => {
  const lookups = [], visits = [];
  let available = true;
  const { api, db, tick } = fixture(t, (url, init) => {
    visits.push(url.hostname);
    assert.equal(init.redirect, 'manual');
    if (url.hostname === 'shop.example') return Response.redirect('https://prices.example/item');
    return page();
  }, url => {
    lookups.push(url.searchParams.get('name'));
    // Later the redirect target starts pointing at a private address (DNS rebinding).
    return available ? publicDns(url) : Response.json({ Status: 0, Answer: url.searchParams.get('type') === 'A' ? [{ type: 1, data: '127.0.0.1' }] : [] });
  });
  assert.equal((await api('check')).body.current.price, 19.99);
  assert.deepEqual(visits, ['shop.example', 'prices.example']);
  assert.ok(lookups.includes('prices.example'));
  available = false;
  db.exec('UPDATE tracked SET last_checked = 0, next_check_at = 0');
  await tick(Date.now());
  assert.equal(db.prepare('SELECT last_status FROM tracked').get().last_status, 'error');
  assert.equal((await api('check')).status, 400);
  assert.equal(visits.length, 2);
});

test('a redirect destination that resolves to a private address is never downloaded', async (t) => {
  // An empty or failed DNS answer is allowed on purpose (fail open, see resolvesPublic); a private answer is not.
  const visits = [];
  const { api } = fixture(t, url => {
    visits.push(url.hostname);
    return Response.redirect('https://unresolved.example/item');
  }, url => url.searchParams.get('name') === 'shop.example' ? publicDns(url) : Response.json({ Status: 0, Answer: url.searchParams.get('type') === 'A' ? [{ type: 1, data: '10.0.0.7' }] : [] }));
  assert.equal((await api('check')).body.current.status, 'error');
  assert.deepEqual(visits, ['shop.example']);
});

test('only indexed captures of the requested product variant enter archive history', async (t) => {
  const other = product.replace('large', 'small');
  const archived = product + '&utm_source=example';
  let replayCount = 0;
  const { api, db } = fixture(t, (url, init) => {
    if (url.hostname === 'shop.example') return page();
    if (url.pathname.startsWith('/cdx/')) {
      assert.equal(url.searchParams.get('url'), product);
      return Response.json([['timestamp', 'original'], [ts, other], [ts, archived]]);
    }
    assert.equal(init.redirect, 'manual');
    replayCount++;
    return page(2499);
  });
  db.exec('CREATE TABLE snaps (url, snap_ts, price, status)');
  db.prepare('INSERT INTO snaps VALUES (?, ?, 2500, ?)').run(product, ts, 'ok');
  assert.deepEqual((await api('check')).body.history.archive, []);
  assert.deepEqual((await api('archive')).body.pending, [{ ts, orig: archived }]);
  assert.equal((await api('snap', { url: product, ts, orig: other })).status, 400);
  assert.equal((await api('snap', { url: product, ts, orig: product })).status, 403);
  for (let i = 0; i < 2; i++) {
    assert.equal((await api('snap', { url: product, ts, orig: archived })).body.price, 24.99);
  }
  assert.equal(replayCount, 1);
  assert.deepEqual((await api('archive')).body.pending, []);
  assert.equal((await api('check')).body.history.archive[0].orig, archived);
});

test('oversized streaming store and replay bodies are cut at the limit and still parsed', async (t) => {
  let cancellations = 0;
  const head = new TextEncoder().encode('<script type="application/ld+json">{"@type":"Product","offers":{"@type":"Offer","price":"19.99","priceCurrency":"GBP"}}</script>');
  const { api } = fixture(t, url => {
    if (url.pathname.startsWith('/cdx/')) return Response.json([['timestamp', 'original'], [ts, product]]);
    let first = true;
    return new Response(new ReadableStream({
      pull(controller) { controller.enqueue(first ? head : new TextEncoder().encode(' '.repeat(1024 * 1024))); first = false; },
      cancel() { cancellations++; },
    }));
  });
  assert.equal((await api('check')).body.current.price, 19.99);
  await api('archive');
  assert.equal((await api('snap', { url: product, ts, orig: product })).body.price, 19.99);
  assert.equal(cancellations, 2);
});

test('tracking parameters do not split a product', async (t) => {
  const cdx = [];
  const { api } = fixture(t, url => {
    if (url.pathname.startsWith('/cdx/')) { cdx.push([url.searchParams.get('url'), url.searchParams.get('matchType')]); return Response.json([['timestamp', 'original']]); }
    return page();
  });
  const az = (await api('check', { url: 'https://www.amazon.co.uk/dp/B0ABCDEFGH?_encoding=UTF8&smid=A3P5ROKL5A1OLE&language=en_GB' })).body;
  assert.equal(az.canonical, 'https://www.amazon.co.uk/dp/B0ABCDEFGH');
  await api('archive', { url: az.canonical, orig: az.url });
  assert.deepEqual(cdx[0], ['amazon.co.uk/dp/B0ABCDEFGH', null], 'exact CDX query, no prefix match');
  const shop = (await api('check', { url: 'https://shop.example/p/123?ref=homepage&cmp=email&utm_source=x' })).body;
  assert.equal(shop.canonical, 'https://shop.example/p/123');
});

test('a failed AAAA lookup does not block a store with a public A record', async (t) => {
  const { api } = fixture(t, () => page(), url => url.searchParams.get('type') === 'A' ? publicDns(url) : Response.json({ Status: 2 }));
  const r = await api('check');
  assert.equal(r.status, 200);
  assert.equal(r.body.current.price, 19.99);
});

test('archive replay redirects are followed only to the same product and a nearby capture', async (t) => {
  const near = new Date(Date.now() - 8 * 86400000 + 3600000).toISOString().replace(/\D/g, '').slice(0, 14);
  let target = `https://web.archive.org/web/${near}id_/${product}`;
  const { api } = fixture(t, url => {
    if (url.hostname === 'shop.example') return page();
    if (url.pathname.startsWith('/cdx/')) return Response.json([['timestamp', 'original'], [ts, product]]);
    if (url.pathname.startsWith(`/web/${ts}`)) return new Response(null, { status: 302, headers: { location: target } });
    return page(2499);
  });
  await api('check'); await api('archive');
  assert.equal((await api('snap', { url: product, ts, orig: product })).body.price, 24.99);
});

test('a redirect to another product is stored as an error', async (t) => {
  const { api } = fixture(t, url => {
    if (url.hostname === 'shop.example') return page();
    if (url.pathname.startsWith('/cdx/')) return Response.json([['timestamp', 'original'], [ts, product]]);
    return new Response(null, { status: 302, headers: { location: `https://web.archive.org/web/${ts}id_/https://shop.example/other` } });
  });
  await api('check'); await api('archive');
  assert.equal((await api('snap', { url: product, ts, orig: product })).body.status, 'error');
});

test('a takealot link with extra parameters still uses the takealot API', async (t) => {
  const hosts = [];
  const { api } = fixture(t, url => {
    hosts.push(url.hostname);
    return Response.json({ buybox: { items: [{ is_selected: true, price: 4499, listing_price: 5499 }] }, core: { title: 'AirPods' } });
  });
  const r = (await api('check', { url: 'https://www.takealot.com/foo/PLID12345?offer=1' })).body;
  assert.equal(r.current.source, 'takealot-api');
  assert.equal(r.canonical, 'https://www.takealot.com/foo/PLID12345');
  assert.deepEqual(hosts, ['api.takealot.com']);
});

test('a product that throws during a scheduled check does not block the queue', async (t) => {
  const { db, env } = localDatabase();
  t.after(() => db.close());
  t.mock.method(globalThis, 'fetch', (raw) => DOH.has(new URL(raw).hostname) ? publicDns(new URL(raw)) : page());
  db.prepare('INSERT INTO tracked (url, last_checked, last_viewed) VALUES (?, 0, ?)').run(product, Date.now());
  const failing = { DB: { prepare(sql) { if (sql.startsWith('INSERT INTO checks')) throw new Error('D1 down'); return env.DB.prepare(sql); }, batch: (list) => env.DB.batch(list) } };
  let job;
  await worker.scheduled({ scheduledTime: Date.now() - (Date.now() % 3600000) }, failing, { waitUntil(p) { job = p; } });
  await job;
  const row = db.prepare('SELECT last_checked, last_status FROM tracked').get();
  assert.ok(row.last_checked > 0);
  assert.equal(row.last_status, 'error');
});

test('at capacity existing products remain tracked and the oldest one is refreshed first', async (t) => {
  const { api, db, tick } = fixture(t, () => page());
  const insert = db.prepare('INSERT INTO tracked (url, last_checked, last_viewed) VALUES (?, ?, ?)');
  for (let n = 0; n < 1000; n++) insert.run('https://shop.example/' + n, n, Date.now());
  assert.equal((await api('check')).body.tracked, false);
  assert.equal((await api('check', { url: 'https://shop.example/999' })).body.tracked, true);
  await tick(Date.now());
  assert.equal(db.prepare('SELECT last_status FROM tracked WHERE url = ?').get('https://shop.example/0').last_status, 'ok');
  assert.equal(db.prepare('SELECT count(*) AS n FROM tracked').get().n, 1000);
});
