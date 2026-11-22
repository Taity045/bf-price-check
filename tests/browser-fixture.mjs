import worker from '../dist/worker.js';
import { localDatabase } from './local-db.mjs';

function page(title, price, currency) {
  const data = { '@type': 'Product', name: title, offers: { price, priceCurrency: currency } };
  return new Response('<script type="application/ld+json">' + JSON.stringify(data) + '</script>');
}

function remote(raw) {
  const url = new URL(raw);
  switch (url.hostname) {
    case 'cloudflare-dns.com':
      return Response.json({ Status: 0, Answer: url.searchParams.get('type') === 'A' ? [{ type: 1, data: '1.1.1.1' }] : [] });
    case 'www.currys.co.uk':
      return new Response('', { status: 403 });
    case 'www.mediamarkt.de':
      return page('AirPods Pro 2nd gen', 269, 'EUR');
    case 'api.takealot.com':
      return Response.json({ title: 'AirPods Pro 3', buybox: { items: [{ price: 4499, listing_price: 5499 }] } });
    case 'www.amazon.co.uk':
      return page('Atomic Habits', 8, 'GBP');
    case 'shop.example':
      return page('Unspecified currency', 20);
    case 'web.archive.org': {
      const original = url.searchParams.get('url');
      if (!url.pathname.startsWith('/cdx/')) return page('Archived offer', 169, 'GBP');
      const rows = [['timestamp', 'original']];
      if (original.includes('currys.co.uk')) {
        for (const days of [10, 20, 30]) {
          const ts = new Date(Date.now() - days * 86400000).toISOString().replace(/\D/g, '').slice(0, 14);
          rows.push([ts, original]);
        }
      }
      return Response.json(rows);
    }
    default: throw new Error('Missing browser fixture for ' + raw);
  }
}

export async function installFixture(context, base) {
  const { env, db } = localDatabase();
  const insert = db.prepare('INSERT INTO checks (url, ts, price, currency) VALUES (?, ?, ?, ?)');
  for (const days of [5, 10]) insert.run('https://shop.example/unknown', Date.now() - days * 86400000, 100, 'GBP');
  for (const [days, currency] of [[5, null], [10, 'EUR']]) {
    insert.run('https://www.amazon.co.uk/dp/1847941834', Date.now() - days * 86400000, 100, currency);
  }
  const previousFetch = globalThis.fetch;
  globalThis.fetch = remote;
  context.on('close', () => { globalThis.fetch = previousFetch; db.close(); });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort();
    const response = await worker.fetch(new Request(url), env, {});
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  });
}
