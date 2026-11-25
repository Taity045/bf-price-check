# Deal or Dud? — Black Friday price checker

Live: https://bf-price-check.tm-deal-lab.workers.dev

Paste a product link from an online store. The tool shows:

1. **Today's price and the "was" price**, read server-side from the product page.
2. **A 12-month price chart**, rebuilt from Internet Archive (Wayback Machine) copies of the page, plus our own daily re-checks.
3. **A verdict** that flags inflated "was" prices and shows the real discount against the 12-month low and the median ("usual") price.

The tool never invents prices. If a store blocks the check, or there is no history, the page says so. The user can type the price they see to get a verdict anyway (shown as "entered by you").

## How it works

| Part | What it does |
|---|---|
| `src/worker.js` | Cloudflare Worker: API, page parsing, Wayback lookups, rate limit, cache, cron |
| `public/index.html` | The app (vanilla HTML/CSS/JS, inline SVG chart, mobile first) |
| `examples.json` | Example links shown as chips on the home page |
| `schema.sql` | D1 tables |
| `build.py` | Inlines the HTML into `dist/worker.js` and writes `deploy_exec.js` |
| `deploy_exec.js` | Payload for the Cloudflare MCP `execute` tool (applies schema, uploads Worker with D1 binding, enables workers.dev, sets cron) |
| `test_full.py`, `test_urls.txt` | End-to-end API test against real product URLs |
| `tests/ui_test.js` | Headless Chrome test at iPhone size (390×844, touch) |

### API

- `GET /api/check?url=<product url>[&fresh=1]` → live price (`current`), stored history (archive points + daily checks). Live results are cached 6 h (30 min when the check failed).
- `GET /api/archive?url=<canonical>&orig=<pasted url>` → Wayback CDX lookup (last 365 days, one capture per ~6 days, max 64 plus the one nearest Black Friday 2025). Cached 12 h.
- `GET /api/snap?url=<canonical>&ts=<14-digit>&orig=<archived url>` → price from one archived copy. Stored forever in D1 (failed fetches retried after 6 h).
- The cron runs every minute and checks the oldest product due for a refresh after 20 hours. That provides 1,440 check slots per day for up to 1,000 tracked products.

### Price extraction (in order)

1. Site-specific: **Takealot public API** (`api.takealot.com/rest/v-1-14-0/product-details/PLID…`: `price` and `listing_price`), **Amazon** price block (`priceToPay`, `basisPrice`/List Price).
2. **JSON-LD** `Product`/`ProductGroup`/`Offer`/`AggregateOffer` incl. `priceSpecification` with `StrikethroughPrice`/`ListPrice` (= "was").
3. **OpenGraph / product meta tags** (`product:price:amount`, `og:price:amount`, `product:original_price:amount`) and **microdata** (`itemprop="price"`).
4. **schema.org Offer embedded in a script** (JSON-LD built by JavaScript or app state; the enclosing JSON object is extracted and parsed).
5. Common shop data fields (`salePrice`, `finalPrice`, `wasPrice`…) and the GA4 e-commerce data layer.

Currency comes from the page or a supported country domain (.co.za → ZAR, .co.uk → GBP, euro TLDs → EUR). If neither supplies a currency, the UI labels the amount and withholds the verdict. The chart and verdict compare prices in one currency. Amazon results in a different currency (Amazon shows USD to foreign visitors) are rejected.

### Verdict rules (client side)

Older prices = archive points + daily checks older than 24 h, last 365 days.
- fewer than 2 older prices → "Not enough history" (the store's claim is shown but not confirmed)
- price ≤ 12-month low and ≥ 5 % under the median → **Real deal**
- "was" price > 103 % of the 90-day high (or 12-month high if < 2 points in 90 days) and price not ≥ 5 % under median → **Fake discount**
- price > 103 % of median → **Pricier than usual**
- ≥ 5 % under median → **Decent deal**; otherwise **Same old price**
- A red flag is always shown when the "was" price is higher than anything seen in 90 days / 12 months.

### Abuse protection

- Only `http(s)` URLs, standard ports, no credentials, no IP-address hosts, no `localhost`/`.local`/`.internal` etc.
- Store requests, redirects and scheduled checks require successful public DNS resolution through Cloudflare DoH.
- Max 4 MB per page, 15 s timeout for stores, 25 s for the archive.
- Rate limit (D1, per IP per minute): 20 checks, 120 archive-copy reads.
- Archive reads require a tracked product and an original URL and timestamp selected from its Wayback index results. Product-defining query parameters are part of the match.
- Max 1,000 tracked products; products not viewed for 120 days are dropped from the daily re-check.

## Deploy / edit

For local checks, use Node 22.13+ and Python 3. The browser suite uses installed Google Chrome. Set `CHROME_PATH` to use another Chromium executable.

```bash
npm ci
python3 build.py
npm test
npm run test:ui
```

The default browser suite runs the built Worker with SQLite and local store and archive fixtures. To run against a deployment, pass its URL to `npm run test:ui -- URL`. The browser test prints its temporary screenshot directory. The API smoke test accepts a deployment URL through `BASE_URL`.

On upgrade, the Worker re-reads indexed archive captures into `product_snaps`, which records their original URLs. Existing tracking records stay in place. Legacy snapshot rows lack that URL, and legacy `page-data` checks lack the amount unit. The Worker excludes those rows from verdicts and retains other live price history.

```bash
python3 build.py                 # writes dist/worker.js and deploy_exec.js
# then run deploy_exec.js through the Cloudflare MCP "execute" tool (account 8746524b5d7c1ba84abb3db21517d7a7)
```

Cloudflare resources: Worker `bf-price-check`, D1 database `bf-price-check-db` (`65e86f16-42db-4c07-bbd7-20ba0308d47e`) bound as `DB`, cron `* * * * *`. No routes, no DNS, no custom domain.

Note: the URL contains the account's workers.dev subdomain. If the subdomain is renamed, the URL changes to `https://bf-price-check.<new-subdomain>.workers.dev`.

## Tests and CI/CD

| Command | What it does | Network |
|---|---|---|
| `npm test` | Unit and integration tests (`tests/unit/*.test.mjs`, `tests/regression.test.mjs`): price readers on saved pages in `tests/fixtures`, verdict rules, SSRF guard, shop request form, rate limiter, HTML escaping. Under 1 second. | none |
| `npm run test:e2e -- http://127.0.0.1:8787` | Browser tests (desktop and phone) against `wrangler dev` with a local D1. Price checks are faked in the browser; pages, forms and D1 are real. | local only |
| `npm run test:smoke -- URL` | Post-deploy check of a live site: home page, one real price check, input validation. | live site |
| `node scripts/cf_token_check.mjs` | Shows what the Cloudflare API token can do (read-only calls, never prints the token). | Cloudflare API |

Run the browser tests locally:

```bash
npm ci && python3 build.py
npx wrangler d1 execute bf-price-check-db --local --file schema.sql
npx wrangler dev --port 8787 &       # local Worker + local D1
npm run test:e2e -- http://127.0.0.1:8787
```

`.github/workflows/ci.yml` runs on every pull request and every push to `main`:

1. **Build and test**: `npm ci`, `python3 build.py`, `npm test`, then the browser tests against `wrangler dev`. Screenshots and the worker log are kept as the `e2e-artifacts` artifact.
2. **Cloudflare token permissions**: read-only report in the job summary (never blocks).
3. **Deploy to Cloudflare** (push to `main` only, after the tests pass, one deploy at a time): applies `schema.sql` to D1 when the token has D1 Edit (skipped otherwise; the Worker creates its tables itself), `wrangler deploy`, then the smoke test on the workers.dev address and on the custom domain. A failed smoke test fails the run.

Secrets used: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

## Known limits

- Many big stores block requests from cloud servers (HTTP 403/bot checks): in tests Argos, Currys, bol.com, Zalando, Incredible, iStore, Makro, Dis-Chem; John Lewis returned 520, Otto 400. For these the tool shows the latest archived price (if any) and lets the user type the price.
- Amazon hides the buy box from foreign visitors for some products (e.g. Kindle devices). Items that ship internationally (books etc.) work.
- Wayback coverage of product pages is thin, especially for South African stores (often 0–3 copies in 12 months). Takealot product pages are rendered by JavaScript, so archived copies have no price. History therefore mostly grows from the daily re-checks.
- The Internet Archive sometimes answers 503 or is slow; the tool retries and shows a "Try the archive again" button.
- Marketplace listings (Amazon, MediaMarkt, Takealot) can change seller, so archived prices may be from a different seller.
- Free-plan Worker limits (CPU time, 50 sub-requests per call) apply; each archive copy is fetched in its own request to stay inside them.

## Shop requests

People can ask us to add a shop (button "Ask us to add this shop"). The Worker stores each request in D1 table `shop_requests` (it creates the table on first use). Only a hash of the IP is kept. Requests are not shown anywhere public.

Read them:

```
npx wrangler d1 execute bf-price-check-db --remote --command "SELECT id, datetime(created_at/1000,'unixepoch') AS at, host, shop_text, product_url, email FROM shop_requests ORDER BY id DESC LIMIT 50"
```

(The token needs D1 Read or Edit for this; the Cloudflare dashboard D1 console works too.)

The list of shops we check is `SHOPS` in `src/worker.js` (also served at `/api/shops`).

## Features (Nov 2026)

All extra features stay off the home page. They sit behind small links (header "Saved", footer links) or show only on a result.

| Feature | Where | Data |
|---|---|---|
| Other shops | Result page, only when a match is strong (same barcode or model number) | Takealot public API |
| Saved and Your stats | Header "Saved" | Your browser only (localStorage) |
| Badges and streak | Saved > Your stats | Your browser only |
| Bookmark button | Footer "Bookmark button" | Opens `/?url=<page>` on this site |
| Share card | `/og.png?u=<link>`, and server meta tags on `/?u=<link>` | D1 `verdicts` |
| Fake discount wall and shop scores | `/wall` | D1 `verdicts` (score shown from 5 judged products) |
| Best time to buy | Verdict card | Chart points |
| Price alerts | Result "Alert me" (hidden while `ALERTS = "off"`) | D1 `alerts` |
| Privacy | `/privacy` | — |

Tables `verdicts` and `alerts` are made at run time (`CREATE TABLE IF NOT EXISTS`).

### Settings

`wrangler.toml` vars: `SITE_URL` (links in emails), `MAIL_FROM` (sender address), `ALERTS` (`on`/`off`).

Worker secrets (never in the repo):

- `OWNER_EMAIL`: where shop requests are emailed. Must be a verified destination address in Cloudflare Email Routing.
- `E2E_KEY`: lets test runs skip email and remove their own rows (`POST /api/e2e/cleanup`).
- `TURNSTILE_SECRET` plus var `TURNSTILE_SITEKEY`: turn on Cloudflare Turnstile on the forms. Without them the forms use the honeypot and rate limits only.

Set a secret: `npx wrangler secret put OWNER_EMAIL`.

### Price alerts

On the Workers Free plan, Cloudflare Email can send only to verified addresses. To send alerts to anyone: move to Workers Paid, onboard the sender domain in Email Sending, then set `ALERTS = "on"`.

### Tests

```
node tests/e2e_redesign.mjs [BASE] [SHOTDIR]
node tests/e2e_features.mjs [BASE] [SHOTDIR]
```

The test key is read from `$E2E_KEY` or `/workspace/bf-secrets/e2e_key`. Both suites remove their test rows at the end.

### Fonts and build

`build.py` minifies the page script and CSS with esbuild (targets Chrome 70, Safari 12), names the script and fonts by hash, and embeds them in the Worker. Fonts are self-hosted subsets (Bricolage Grotesque, IBM Plex Mono; SIL Open Font License). Re-make them with `scripts/make_fonts.py`; the share-image glyphs with `scripts/make_og_font.py`.
