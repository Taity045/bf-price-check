# Deal or Dud? — price checker

Live:
- https://eish.veldwire.com (custom domain)
- https://bf-price-check.tm-deal-lab.workers.dev (workers.dev, kept working)
- https://stats.veldwire.com (private stats dashboard, owner only; see [Private stats](#private-stats))

Paste a product link from an online shop. The site shows:

1. **Today's price and the "was" price**, read on the server from the shop's product page.
2. **A price history chart**, made from public web archive copies of the page (Internet Archive and Common Crawl) and from prices we save when people check the product.
3. **A verdict**: Real deal, Decent deal, Same old price, Pricier than usual, Fake discount (from 3 or more older prices). With only 1 or 2 older prices from the last 6 months: Likely inflated was price, Seen cheaper before, or Seen at this price before, each with the date, the source and a link to the archived copy. Otherwise: Not enough history.

The site never invents prices. If a shop blocks the check, or there is no history, the page says so. You can type the price you see to get a verdict anyway (shown as "entered by you").

## Where the prices come from (and the limits)

- **Today's price**: the shop's product page (for Takealot: its public product API).
- **Older prices**: (a) Internet Archive copies of the same page from the last 12 months, (b) Common Crawl copies of the same page from the last 12 months (see [Common Crawl archive prices](#common-crawl-archive-prices)), and (c) prices this site saved: when someone checks a product, and then about once a day by the daily price saving (see [Daily price saving](#daily-price-saving)), which also covers a seed list of up to 300 popular Takealot products.
- Many products have few or no archive copies. This is true for most Takealot products (their pages are built by JavaScript, so archive copies have no price). So "Not enough history" is common at first. The result says why. The history grows by about one price a day per product. A verdict needs 3 older prices (older than 24 h), so a new product can get a verdict after about 4 days of daily saving.
- Shops that block automatic checks (or say no in robots.txt) get no daily saving; for those, only checks by people add prices.
- The same text is on the site: footer link "Where prices come from" (opens the Shops dialog).

## Common Crawl archive prices

[Common Crawl](https://commoncrawl.org/) is a free, public archive of the web, with a new crawl about once a month. For 22 of our shops it holds copies of many product pages (strongest: Dunelm, Wickes, Lookfantastic, Cult Beauty, Apple UK, Cashbuild, Studio 88, PUMA ZA, Cycle Lab; then Bash, M&S, JD Sports, Richer Sounds, Loot, Evetech, OneDayOnly, Woolworths and Woolworths Food, Sportsmans Warehouse, Miladys, Sheet Street, First Shop). Takealot refuses Common Crawl's robot, so there is nothing for Takealot. Research and test numbers: `bf-sources/report.md` (on the box).

**How it works.** Nothing here runs during a check: a check only reads rows from D1 (one indexed query, run together with the other history queries).
1. `scripts/cc/archive.mjs collect` finds each shop's product pages in Common Crawl's public index on `data.commoncrawl.org` (`cluster.idx` + index blocks, by byte range), downloads each archived page with one byte-range request (a few at a time, with a pause when the server is busy), and reads it with the site's own price reader (`extractFromHtml`).
2. **Sanity filter** (`scripts/cc/read.mjs`): a copy is dropped when it is a bot-check page, has no product data (JSON-LD/microdata/Open Graph product or a product data layer), shows out of stock, has another currency than the shop, has a zero or absurd price, has a canonical link to another page, or only has a price guessed from the page text. Links with size/colour/SKU parameters are skipped (they can show another price). Per product, a price more than 2.5x away from the product's median is dropped; a product whose copies still differ more than 3x (or two copies more than 2x) is dropped entirely. The worker also never shows an archive price more than 3x away from today's price.
3. **UK price check** (`archivedGeoCheck` in `src/worker.js`, used by `read.mjs` and by the Internet Archive reader): Common Crawl and the Internet Archive fetch pages from outside the UK, and some UK shops then show another price. Lakeland (Shopify Markets) shows its prices without UK VAT to US visitors (1/1.2 of the UK price, still in GBP); others switch currency. A copy of a UK shop counts only when the page itself confirms the UK price: the currency in its structured data is GBP (the `.co.uk` domain alone is not enough), there is no `valueAddedTaxIncluded: false`, and on Shopify pages `Shopify.country` is `GB` and `Shopify.currency.active` is `GBP`. Any other copy is **unusable**: skipped, counted, never a price (no ratio guessing). `recheck` downloads again the UK copies read before this check existed and writes `geo.jsonl`; `reduce` keeps a UK copy only when it was confirmed, and marks its rows `geo: "GB"`. The load endpoint refuses GBP rows without `geo: "GB"`, so an older loader cannot save unchecked UK rows. On a product's page, Internet Archive copies that fail the check are left out and the archive note says how many.
4. `reduce` keeps only price changes: one row per run of the same price, with the first copy (`captured_at`), the last copy (`last_seen`) and how many copies agreed (`n`).
5. `upload` sends rows to `POST /api/admin/archive-load` (header `Authorization: Bearer <ARCHIVE_LOAD_KEY>`; without the right key the endpoint answers 404). The worker checks every row again (supported shop, same host, shop currency, UK check passed for GBP rows, sane price and date) and writes it to `archive_prices`. It stops at **15,000 rows per UTC day** (reset 02:00 SAST) (`ARCHIVE_DAILY_CAP`), so loading never uses up the D1 free plan's 100,000 daily row writes (the site, the daily saving and the stats need the rest). A bigger load goes in daily batches; the loader remembers what it sent.
6. The product key is the live check's canonical link (`canonicalize`), with junk link parameters (`rctxt`, `affil`, `utm_*` …) removed (`archiveKey`). A check looks up its key with and without `www.` and a trailing slash, so the check, the 1–2 price evidence verdicts and the full verdicts all use these rows.
7. On the site each point says "web archive copy (Common Crawl)" and links to Common Crawl's public index record for that copy (`index.commoncrawl.org/<crawl>-index?url=…`). Common Crawl has no public page viewer.

**First load (12 months, crawls CC-MAIN-2025-47 to CC-MAIN-2026-47)** ran on the box, strongest shops first, products still on sale with a copy from 3–6 months ago first. **New crawls**: `.github/workflows/archive.yml` runs daily; when a crawl newer than `LOADED_UP_TO` is out, it reads it (up to 4.5 hours a run, continuing the next day from the Actions cache) and appends its prices (`--mode append`: same price extends the product's latest row, a new price adds a row). Run it by hand from the Actions tab with a crawl id. `GET /api/archive-stats` shows rows and products per shop.

```
# on any machine with Node 22+ (the key is the ARCHIVE_LOAD_KEY repo secret)
node scripts/cc/archive.mjs collect --out cc-archive --crawls CC-MAIN-2026-47 --shops "Dunelm,Wickes" --concurrency 4
node scripts/cc/archive.mjs reduce --out cc-archive
ARCHIVE_LOAD_KEY=… node scripts/cc/archive.mjs upload --out cc-archive --max-writes 30000
```

Common Crawl's terms of use apply; crawled content may be subject to the shops' own terms. We store only the price facts (price, was price, date, link), not page content.

## Daily price saving

Code: `src/daily.js` (joined into the Worker by `build.py`). Tests: `tests/unit/daily.test.mjs`.

**What it does.** Every product that someone checks joins the daily list (`tracked`, `seed = 0`). A seed list of popular Takealot products is added too (`seed = 1`): the bestsellers of 12 departments (computers, phones, TV and audio, gaming, cameras, home and kitchen, DIY, sport, beauty, toys, baby, garden), from Takealot's public search API, 25 one-price products each, at most 300. Each department list is read again about once a week. About once a day the Worker reads each product's price and saves it in `checks` with `via = 'daily'`. Verdicts use these saved prices together with archive prices (the same rule: at least 3 older prices).

**Schedule.** Cron `* * * * *` (every minute). Each run:

1. takes the products whose `next_check_at` has passed: people's products first, then seed products, oldest first;
2. reads at most **4 Takealot products** (JSON API, small) and **1 shop page** (HTML, up to 4 MB) — a run that also reads a seed department reads 2 Takealot products and no page;
3. saves the price, the verdict and the next check time in one D1 batch.

That gives about 5,700 Takealot checks and 1,440 shop-page checks a day, far more than the products we have now.

**Next check.**

| Result | Next check |
|---|---|
| Price read | in 23 h (one check per calendar day) |
| Not viewed for 60 days (seed: not on a bestseller list for 60 days) | weekly (daily again when someone checks it; a product with a price alert stays daily) |
| Failed (blocked, no price, error) | 6 h, 1 day, 2, 4, then 7 days |
| 8 failures in a row, HTTP 404/410, robots.txt says no, or shop on the blocked list | paused (`next_check_at` is NULL) until someone checks it again |
| robots.txt not reachable (5xx) | in 1 h, not counted as a failure |

Seed products that left the bestseller lists 60 days ago are removed from `tracked`; people's products nobody viewed for 120 days are removed. Their saved prices stay in `checks`.

**Limits and why.** Workers Free plan, per cron run (from developers.cloudflare.com, checked 2026-11-25): **10 ms CPU**, **50 subrequests**, **50 D1 queries** (a batch counts as one), 15 min wall time, 5 cron triggers per account. One Takealot product costs about 0.2 ms CPU to parse; a shop page costs 0.1–5 ms (measured on 40 real pages), so one page per run keeps a run well under 10 ms. A full run uses about 10 fetches (products, robots.txt, DNS checks) and 6–8 D1 queries. A run that dies (for example at the CPU limit) has already "claimed" its products for 6 h and counted a failure, so a product that always breaks a run ends up paused instead of blocking the queue. Free plan daily limits are not a concern at this size: 1,440 cron runs of 100,000 requests a day; D1 reads use the `idx_tracked_due` index.

**Being polite.** The daily check says who it is (user agent `Mozilla/5.0 (compatible; DealOrDudBot/1.0; +https://eish.veldwire.com/#priceSrc)`), obeys robots.txt (group `DealOrDudBot`, else `*`; cached for a day), reads at most one page a minute in total and at most 4 Takealot API calls a minute, and does not try to get past blocks or bot checks. In a test from a home connection, 29 of 40 shop pages that work for people's checks also worked for this honest user agent; the others answer 403 or a bot check, so those products get no daily saving.

**More volume.** If the daily list grows past about 1,400 shop-page products (or 5,700 Takealot products), runs fall behind. Workers Paid (USD 5 a month) raises the limits to 30 s CPU and 10,000 subrequests per run; then raise `DAILY_CAPS` in `src/daily.js`.

**How to check that it runs.**

- `curl https://eish.veldwire.com/api/daily-status` → products in the list (people's and seed), due now, paused, prices saved in the last 24 h, time of the last daily save. Counts only, no links. Cached 5 minutes.
- Each run logs one line: `{"daily":{"picked":5,"saved":5,"failed":0,"paused":0,"skipped":0,...}}`. See it live with `npx wrangler tail bf-price-check --format pretty`, or in the Cloudflare dashboard (Workers Logs are on, `[observability]` in `wrangler.toml`).
- D1: `npx wrangler d1 execute bf-price-check-db --remote --command "SELECT COUNT(*) AS n, COUNT(DISTINCT url) AS products, datetime(MAX(ts)/1000,'unixepoch') AS last FROM checks WHERE via = 'daily' AND ts > (strftime('%s','now') - 86400) * 1000"` (token needs D1 Read or Edit).

**Schema.** New columns, added by the Worker on first use (`ensureDailySchema`, since SQLite has no `ADD COLUMN IF NOT EXISTS`): `tracked.seed`, `lane` (`takealot` or `page`), `host`, `fails`, `next_check_at`, `days` (days with a saved price in 12 months, for the shop ranking rule); `checks.via`. Indexes `idx_tracked_due (lane, seed, next_check_at)` and `idx_checks_via_ts (via, ts)`. `schema.sql` has the columns for a new database.

**Shop ranking rule.** A shop score (on the wall, which is off) needs at least 5 judged products **and** at least 3 products with saved prices on 7 or more different days.

## Copy rules

Simple English (ASD-STE100 style): short sentences, active voice. Confident and honest: say what we do and what we found, with no hedges ("may work", "might") and no apologies, and no claims we cannot back with a price. When we cannot read a price or find history, the page says so and tells the user what to do next. No owner name or email anywhere. `tests/e2e_features.mjs` fails if known hedgy lines come back.

## Shops we check

`src/shops.js` is generated by `scripts/make_shops.py` from the research file `research/retailers.json` (that folder is written by another worker; this repo only reads it). It holds:

- `works`: shops with `live_status = works` (35 ZA + 14 UK), plus MediaMarkt Germany (checked live). Served at `/api/shops` and shown in the footer "Shops we check" dialog. Amazon is not on the list.
- `blocked`: shops known to block our checks (Amazon and others). For those the result says "<Shop> often blocks our checks. You can type the price below." and shows the manual price box (no "ask us to add" form).

Re-make it: `python3 scripts/make_shops.py --add "MediaMarkt Germany,DE,mediamarkt.de"`. Matching uses the host plus an optional path prefix (for example `samsung.com/za`).

## Features

The home page stays clean: heading, link box, Check price, 3 example links (Takealot, Evetech, Cycle Lab), and a short 3-step line on desktop. Everything else is behind small links or on the result page.

| Feature | Where | Data |
|---|---|---|
| Other shops (price compare) | Result page: the same product's price today at other shops in the same country and currency. See [Other shops](#other-shops-price-compare) | Each shop's own public search |
| Saved, Your stats, badges | Header "Saved" | Your browser only (localStorage) |
| Deep links | `/?url=<product link>` and `/?u=<product link>` open the site and run a check (used by shared links). For these links the server adds `class="q"` to `<html>`, so the first paint already uses the compact result layout (no centred hero, steps or footer while the result loads): no layout shift when the result appears (CLS < 0.02 at 360–1440 px, tested in e2e) | — |
| Link previews (WhatsApp chats and Status) | OG and Twitter tags in the first 1 KB of `/` and `/?u=` / `/?url=` | First `og:image`: `/og-home.jpg` (static 1200×630 JPEG, 50 KB). Second `og:image`: `/og-square.jpg` (600×600 JPEG, 31 KB). Both with content-length and a 7-day cache. A product card `/og.png?u=…` (PNG) replaces the first image once it is made (D1 cache). Remake the static images with `scripts/make_og_static.py`. `/robots.txt` allows all |
| Fake discount wall and shop scores | `/wall` — **off** (`WALL = "off"`) | D1 `verdicts` |
| Price alerts | Result "Alert me" — **off** (`ALERTS = "off"`) | D1 `alerts` |
| Ask us to add a shop | Footer, and on results for unknown shops | D1 `shop_requests`, plus an email to the owner |
| Privacy | `/privacy` | — |
| Accessibility | Whole site | Screen readers hear one short line ("Verdict: …") from a hidden `role=status` region when the verdict changes, not the whole result on every redraw. The Saved / Your stats tabs follow the WAI-ARIA tabs pattern (arrow keys, Home, End, one tab stop). |

### Feature flags (`wrangler.toml` `[vars]`)

- `WALL`: `on`/`off`. Off hides the wall link and counter, `/wall` goes to `/`, `/api/wall` and `/api/stats` return 404. Turn on when there are at least about 10 real fake-discount catches from ZA/UK shops.
- `ALERTS`: `on`/`off`. Needs Workers Paid and Email Sending onboarding to email anyone (the Free plan sends only to verified addresses).
- `SITE_URL` (links in emails), `MAIL_FROM` (sender address).

### Worker secrets (never in the repo)

- `OWNER_EMAIL`: where shop requests are emailed. Must be a verified destination in Cloudflare Email Routing.
- `E2E_KEY`: lets test runs skip email and rate limits and remove their own rows (`POST /api/e2e/cleanup`).
- `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`: the Cloudflare Access team name and the stats application's Audience (AUD) tag. Without both, `stats.veldwire.com` answers 403 to everyone.
- `STATS_ALLOWED_EMAILS` (optional): comma-separated emails allowed on the stats page. If not set, the page allows only `OWNER_EMAIL`.
- `TURNSTILE_SECRET` plus var `TURNSTILE_SITEKEY`: turn on Cloudflare Turnstile on the forms (the code is ready: invisible "interaction-only" widget, server check in `verifyTurnstile`). **Not set now.** Turnstile is free, but making the widget needs the `challenge-widgets` permission, which the deploy token and the Cloudflare connector do not have (checked 2026-11-25). To turn it on: Cloudflare dashboard → Turnstile → Add widget (hostnames `eish.veldwire.com`, `bf-price-check.tm-deal-lab.workers.dev`, mode Managed), put the site key in `wrangler.toml` `TURNSTILE_SITEKEY`, and run `npx wrangler secret put TURNSTILE_SECRET`. Until then the forms use a honeypot and rate limits.

- `ARCHIVE_LOAD_KEY`: key for the Common Crawl loader (`POST /api/admin/archive-load`). Kept as a GitHub repo secret of the same name; the deploy job puts it on the worker once (`wrangler secret put`) if it is not there yet. Without it the endpoint answers 404.

Set a secret: `npx wrangler secret put OWNER_EMAIL`.

## Shop readers (South African shops)

Some big SA shops do not put the price in standard product data (JSON-LD), or show it only after their app loads. For these shops `src/readers.js` reads the price from the data the shop's own site uses. All of it is public: the same pages and API calls a normal browser makes on a product page. robots.txt is obeyed (also by the daily saving, which checks robots.txt on the API host). No bot walls are passed.

| Shop | How | Source label |
|---|---|---|
| Bash and TFG brands (Foschini, Markham, Sportscene, Totalsports, American Swiss, @home) | Public VTEX catalog API on bash.com, by the product slug in the link (`/<slug>/p`). TFG brand sites send product links to bash.com, so all brands use the bash.com API. Lowest in-stock size wins; "was" is the list price. | `vtex-api` |
| Mr Price, Mr Price Home, Mr Price Sport | The shop's public GraphQL API (`apiprd.omni.mrpg.com`), by the SKU at the end of the link, with the shop's `store` header. A POST query (read only). | `mrp-graphql` |
| Pick n Pay | Public product API (`/pnphybris/v2/pnp-spa/products/<code>`), store code WC44 (the default online store). | `pnp-occ` |
| Cape Union Mart, Poetry (and other SFCC Next.js shops of the same group) | Product data in the page's Next.js stream (`list_price` / `sale_price` in cents), matched by the product code in the link. | `rsc-data` |
| NetFlorist | `initialProductData` in the page's `__NEXT_DATA__` (read by a small regex, not a full parse of the 300 KB block). | `next-data` |
| Clicks | The visible price block and the page's `productPrice` field. Clicks' JSON-LD has no price. | `clicks-page` |
| Absolute Pets | The main price block (lowest price for "from R…" products). The page's dataLayer price is without VAT, so it is not used. | `absolutepets-page` |

API readers replace the page download, so these checks are faster than a normal page read (about 0.1–1 s). If a reader finds no price, the normal page parsing runs as before. Amazon and Takealot are not changed.

**Tests**: `tests/unit/readers.test.mjs` with saved real responses in `tests/fixtures/shops/`. Live check: `node tests/live_readers.mjs` (readers on this machine) or `node tests/live_readers.mjs https://eish.veldwire.com` (the deployed Worker, `fresh=1`), on the real products in `tests/live_readers.txt`.

**Shops list**: `src/shops.js` is made by `scripts/make_shops.py` from `research/retailers.json`, with `data/live_status.json` applied on top (newer live checks). Run `RESEARCH=<path to retailers.json> python3 scripts/make_shops.py` if the research folder is not in your checkout.

## Other shops (price compare)

On a result page the "Other shops" panel (under the price chart and the buttons, so rows that arrive later never push the chart or buttons down) shows the same product's price today at other shops we support, in the same country and currency. The page asks the worker which shops to search (`/api/compare`), then asks each shop in parallel (`/api/compare/shop`, 4 at a time), so rows appear as shops answer and one slow shop does not hold up the rest. Each answer is one Worker call with a few sub-requests, well inside the Free plan's 50.

**Shops searched** (`CMP_SHOPS` in `src/compare.js`), each through its own public search, with an honest user agent (`DealOrDud-PriceCompare/1.0 (+https://eish.veldwire.com; …)`), at most 30 searches a minute per shop, results cached 6–12 h:

- ZA, all kinds: Takealot (public search API), Loot.
- ZA electronics: Evetech, Computer Mania, Matrix Warehouse, First Shop.
- ZA home and appliances: Hirsch's. Books: Exclusive Books. Liquor: Norman Goodfellows.
- ZA fashion, sport and general: Bash (TFG: Sportscene, Totalsports, Foschini…), PUMA ZA (PUMA only), Edgars.
- UK beauty: allbeauty, Escentual. UK department store (beauty, kitchen, home, some electronics): Fenwick.

**robots.txt is respected.** Before a shop's search (or product details) is used, the worker reads that shop's `robots.txt` (cached 24 h) and checks the exact path for our token `DealOrDud-PriceCompare` (or `*`), per RFC 9309. If the path is disallowed the shop is not searched and the page says "Not searched: … (the shop asks tools not to use its search)"; if `robots.txt` does not answer (5xx), the shop is skipped for now and asked again within an hour. Shops whose `robots.txt` disallows the search we would use are switched off in `CMP_SHOPS` (`off: "robots"`): OK Furniture, Toys R Us, Babies R Us, Superbalist, Studio 88, Ackermans, Pep and Lakeland. Products from those shops can still be checked and compared against the other shops.

**Currency**: Shopify shops can price for the visitor's country (our servers abroad saw Escentual in USD and Lakeland without UK VAT). Checking a product page at a Shopify shop we know (`CMP_SHOPS`) adds `?country=…&currency=…` for its home country, and every compare request to a Shopify shop asks for the shop's home country and currency (`country=GB&currency=GBP`, `country=ZA&currency=ZAR`), and an answer the shop says is priced in another currency is refused.

Shops are picked by the product's kind (electronics, appliances, books, fashion…) so a book is not searched at a TV shop. The shop the product came from is not searched again.

**How a match is decided** (strict on purpose: fewer, correct matches beat more matches):

1. **Same barcode** (EAN/UPC/ISBN from the product data, the shop's search, or the shop's product page). A different barcode on both sides means a different product.
2. **Same model number** (MPN, Samsung/Sony/Apple part numbers, LEGO set numbers, Nike style codes, …).
3. **Same name and specs**: same brand, the same core words and numbers, and none of these differ: storage (128 GB vs 256 GB), screen size, ml or grams, litres, pack size, year, men's/women's, colour (when both name one), variant words (Pro, Max, Plus, Ultra, Mini, Lite, Slim, Digital, Disc, SE, FE, ANC, Music, Solar, EDP vs EDT…).

Game and special editions (Fortnite, Game Pass, Zelda, limited/anniversary editions…) must be named on both sides or neither. If the other shop names a size (storage, ml, g) that this page does not, it is left out: the page may sell several sizes. Barcodes are also read from page microdata (`itemprop="gtin13"`) and ISBNs from book shop links.

A candidate is always rejected if it is an accessory or case for the product, used/refurbished/parallel import/renewed, a bundle, or its price is far from this page's price (model matches: under ⅓ or over 3×; name matches: under ½ or over 2×). Shopify shops with several sizes or colours are read per variant, and the variant is picked by barcode or by a unique spec fit; if that is not possible the row is left out. Fashion needs a barcode or model number (names like "Air Force 1 '07" cover many colours).

Each row shows the shop, price (and "was" price), the difference against this page, the match level ("Same barcode", "Same model number", "Same name and specs"), stock, a link to the shop's page and when it was checked. The cheapest in-stock offer is marked "Cheapest"; when two or more in-stock offers (this page included) share the lowest price, each is marked "Same lowest price", and an offer within 0.50 of this page's price shows "Same price". Under the list: shops that did not have it, shops not searched because of their robots.txt, and shops we could not check (blocked or down) — never a guessed price.

**History**: every price found by the compare is saved in `checks` with source `compare-<shop>`, and barcode/model matches are added to `tracked`, so the hourly re-check and later visits build price history for the same product at more shops.

**Live test** (`node scripts/compare_live.mjs <urls>` or `LIST=file OUT=results.json`): runs the real search and matching for each planned shop and prints every match with its level. Results from the last run are in the PR that added this feature.

## Code layout

| Part | What it does |
|---|---|
| `src/worker.js` | Worker: API, page parsing, archive lookups, rate limits, cache, cron, routes |
| `src/features.js` | Verdicts, wall, email, alerts, Turnstile, API bot checks |
| `src/archive.js` | Common Crawl archive prices: product keys, D1 reads, points with source links, the admin load endpoint, `/api/archive-stats` |
| `scripts/cc/` | Common Crawl backfill: `archive.mjs` (collect, recheck, reduce, upload), `read.mjs` (sanity filter), `shops.mjs` (shops and product link patterns) |
| `src/compare.js` | Other shops price compare: shop adapters, product identity, strict matching, caching, history |
| `src/daily.js` | Daily price saving: cron batches, back-off, robots.txt, Takealot seed list, `/api/daily-status` |
| `src/stats.js` | Private stats: cookieless daily counts, click beacon, Cloudflare Access JWT check, dashboard |
| `src/og.js`, `src/og_font.js` | Share card PNG renderer and server meta tags |
| `src/readers.js` | Shop readers for SA shops without standard price data (TFG/VTEX, Mr Price, Pick n Pay, Cape Union Mart, Poetry, NetFlorist, Clicks, Absolute Pets) |
| `src/shops.js` | Shops we check / known blocked (generated from research + `data/live_status.json`) |
| `public/index.html` | The app (plain HTML/CSS/JS, inline SVG chart, mobile first; desktop layout from 900 px) |
| `public/fonts/`, `public/og-home.*`, `public/og-square.jpg` | Self-hosted font subsets, static share cards |
| `examples.json` | Example links on the home page |
| `schema.sql` | D1 tables |
| `build.py` | Minifies JS/CSS (esbuild, Chrome 70 / Safari 12 targets), embeds fonts, script, card and HTML into `dist/worker.js` |

### API

- `GET /api/check?url=<product url>` → today's price and saved history. Cached 6 h (30 min after a failed check).
- `GET /api/archive?url=<canonical>&orig=<pasted url>` → archive index (last 365 days, any capture). Cached 12 h (cache key `cdx-v5:`). It asks the Wayback CDX index for these URL forms and keeps only captures of the same product: the canonical URL, with and without a trailing slash, the pasted URL (with its query, without `#…`), the canonical URL without its query, and the `m.` mobile host. `http`/`https` and `www.`/`m.` count as the same page. Product-ID-only URLs (for example `/PLID123` without the name part) are not searched, because the CDX index has no wildcard in the middle of a path.
- `GET /api/snap?url=…&ts=…&orig=…` → price from one archive copy, kept in D1.
- `GET /api/archive-stats` → Common Crawl rows and products per shop host, and rows loaded per day (cached 1 h).
- `POST /api/admin/archive-load` → loader only (secret key; 404 without it). See [Common Crawl archive prices](#common-crawl-archive-prices).
- `POST /api/admin/price-fix` → one-off maintenance (same key; 404 without it), run from the manual workflow **Price fix** (`.github/workflows/maintenance.yml`). Before PR #14 (2026-11-25 02:20:56 UTC) our servers abroad read Lakeland without UK VAT and Escentual in USD. `{"apply": false}` lists the rows saved before then that are priced in another currency than the shop's, or are Lakeland reads where the UK price (the next read, or the shop's own product data for GB now) is 1.19–1.21× the saved one; `{"apply": true}` deletes them, the verdicts for those products, and their cached checks, identities, compare answers and share images (plus compare answers that used Lakeland as the other shop). Rows without that evidence stay and are listed as `kept_no_evidence`. With `multi_urls` (workflow input) it instead checks those product links again with the shop's own data and, where the page sells options at different prices, lists/deletes the `compare-*` rows saved there (one option's price under a link whose own check reads the default option). Since this fix the compare no longer saves such a pick to history (`multi` in `cmpSaveHistory`). With `snap_rows` (workflow input, `url|snap_ts`, up to 8) it downloads those saved Internet Archive copies of UK shops again and runs the UK price check (`archivedGeoCheck`); a copy that fails it is kept as status `unusable` with no price (not shown, not fetched again), and the product's verdicts and cached checks are removed. A copy the check confirms is left alone.
- `/api/check` also returns `history.cc`: Common Crawl points (`t`, `price`, `was`, `currency`, `url`, `link`).
- `GET /api/daily-status` → counts for the daily price saving (no links). Cached 5 min.
- `GET /api/compare?url=<product url>` → which shops will be searched for this product, plus any cached answers. Only for products someone checked first.
- `GET /api/compare/shop?url=<product url>&shop=<id>` → one shop's answer: `match` (with title, price, was, link, in stock, match level, time checked), `none`, `blocked`, `error`, `busy` or `skipped`. Cached 12 h (20 min after an error).
- `GET /api/shops`, `/api/config`, `/api/others` (old pages; answers from the compare cache), `POST /api/verdict`, `POST /api/request`, `POST /api/alert`.
- `GET /og-home.jpg`, `/og-square.jpg`, `/og-home.png`, `/og.png?u=…`, `/robots.txt`.
- `POST /api/m` (body: a button name such as `share`) → counts one click. Always 204. Only known names from the same site are counted.

### Price extraction (in order)

1. Site-specific: **Takealot public API** (`api.takealot.com/rest/v-1-14-0/product-details/PLID…`: `price` and `listing_price`), **Amazon** price block (`priceToPay`, `basisPrice`/List Price).
2. **JSON-LD** `Product`/`ProductGroup`/`Offer`/`AggregateOffer` incl. `priceSpecification` with `StrikethroughPrice`/`ListPrice` (= "was").
3. **OpenGraph / product meta tags** (`product:price:amount`, `og:price:amount`, `product:original_price:amount`) and **microdata** (`itemprop="price"`).
4. **schema.org Offer embedded in a script** (JSON-LD built by JavaScript or app state; the enclosing JSON object is extracted and parsed).
5. Common shop data fields (`salePrice`, `finalPrice`, `wasPrice`…) and the GA4 e-commerce data layer.

Number format: two parsers in `src/worker.js`.
- **Structured data** (`parsePrice`): JSON-LD `offers.price`, `itemprop="price"` / meta `content`, `og:`/`product:price:amount`, shop JSON APIs (Takealot, other-shops compare), data layers. These are machine format, so **"." is always the decimal point**, whatever the digit count: `999.990` → 999.99, `1299.000` → 1299, `1.299` → 1.30. Also accepted because each has one reading only: `1,299.00` / `1,299` (comma groups), `1299,00` (comma and 1–2 digits), `1.299,00` (European). Anything else (`1.299.000`, `1299,000`) gives no price; we do not guess.
- **Visible text** (`parseTextPrice`): the shop's price block, Amazon's price text, `twitter:data1`, a price the user types (`parseNum` in the page uses the same rules). With both marks, the last one is the decimal mark (`1.299,00`, `1,299.99`). Commas only: `1,299` is a group, `12,5` / `1299,00` are decimals. Dots only: `1.299.000` (2+ groups) is groups; `1.299` / `999.990` (one group) are thousands **only next to a currency sign or code** (`€999.990` → 999 990; the price block and the typed price always have a currency), otherwise unclear → no price; `1299.000` / `12.5` are decimals.
- **Structured wins:** for every shop except Amazon, structured data is read first and the visible block is used only when there is no structured price. If they disagree, the structured price is used (unit tests cover this). Amazon pages have no product JSON-LD, so Amazon uses its price text.

Currency comes from the page or a supported country domain (.co.za → ZAR, .co.uk → GBP, euro TLDs → EUR). If neither supplies a currency, the UI labels the amount and withholds the verdict. The chart and verdict compare prices in one currency. Amazon results in a different currency (Amazon shows USD to foreign visitors) are rejected.

### Verdict rules (client side)

Older prices = archive points + saved checks older than 24 h, last 365 days.
- 1 or 2 older prices → evidence verdicts, using only prices from the last 183 days (same rules in `src/features.js` `sparseEvidence` and the client mirror in `public/index.html`):
  - **Likely inflated was price**: the shop shows a "was" price above today's price, a price from at least 14 days ago is ≤ 90 % of the "was" price, and no recent older price reached 97 % of it. (A price from the last 2 weeks is not enough: a sale may have started a few days ago.)
  - **Seen cheaper before**: the lowest recent older price is under today's price by a real move (see below).
  - **Seen at this price before**: the lowest recent older price is at or under today's price by less than a real move, or above it by less than a real move (shown as "About the same price before").
  - The line shows the price, the date and the source ("web archive copy" links to `web.archive.org/web/<ts>/<url>`, or "our saved check"), plus "Based on N older price(s) from the last 6 months. We give a full verdict from 3 older prices." These verdicts are not counted as "judged" on the wall.
- no usable older price → "Not enough history" (the shop's claim is shown but not confirmed, with a line that says why)
- A **real move** is at least 5 % and at least R5 (0.50 in pounds and other currencies). Smaller moves are never called a deal or a rise.
- price ≤ 12-month low and a real move under the median → **Real deal**
- "was" price > 103 % of the 90-day high (or 12-month high if < 2 points in 90 days) and price not a real move under median → **Fake discount**
- price a real move over the median → **Pricier than usual**
- a real move under the median → **Decent deal**; otherwise **Same old price**
- A red flag is always shown when the "was" price is higher than anything seen in 90 days / 12 months.

### Abuse protection

- Only `http(s)` URLs, standard ports, no credentials, no IP-address hosts, no `localhost`/`.local`/`.internal` etc.
- Store requests, redirects and scheduled checks require public DNS answers (DoH: 1.1.1.1, then dns.google). Every A/AAAA address must be public. **Fails closed:** if no resolver answers, `resolvesPublic` returns `null`; `/api/check` answers 503 "We could not look up the shop's address. Try again in a minute.", redirects are refused, and the daily cron retries in 1 hour without counting a product failure. NXDOMAIN (no such name) passes the DNS step, and the fetch then fails.
- Max 4 MB per page, 15 s timeout for stores, 25 s for the archive.
- Rate limit (per IP per minute): 20 checks, 120 archive-copy reads, 40 verdict saves, 240 other-shop lookups (one per shop), 5 shop requests. Each shop also gets at most 30 searches a minute from the whole site. On Cloudflare these use the Workers Rate Limiting API (`[[ratelimits]]` bindings `RL_*` in `wrangler.toml`). Its counts are kept per Cloudflare location and are approximate, and it writes nothing to D1. Without the bindings (unit tests) the code uses the D1 table `rl`. If the limiter fails, the request is allowed.
- Archive reads require a tracked product and an original URL and timestamp selected from its Wayback index results. Product-defining query parameters are part of the match.
- Max 1,000 tracked products from people's checks (plus up to 300 seed products); products not viewed for 120 days are dropped from the daily list.

Preview bots (WhatsApp, facebookexternalhit, etc.) can always fetch pages and share images; the bot check applies only to `/api/*`.

## D1 database

`bf-price-check-db` (`65e86f16-42db-4c07-bbd7-20ba0308d47e`), binding `DB`.

| Table | What it holds |
|---|---|
| `checks` | Live prices we read (url, time, price, was, currency, source; `via = 'daily'` for the daily price saving). Prices found by the compare are saved with source `compare-<shop>` |
| `product_snaps` | Prices read from Internet Archive copies |
| `archive_prices` | Common Crawl prices: one row per run of the same price (`product_key`, `captured_at`, `last_seen`, `n`, `price`, `was`, `currency`, `source = 'common crawl'`, `url`, `crawl`, `last_crawl`). `WITHOUT ROWID`, so each row is one write |
| `archive_load` | Rows the loader wrote per UTC day (for the daily cap) |
| `tracked` | Products in the daily price saving: people's checks (`seed = 0`) and the Takealot seed list (`seed = 1`), with `next_check_at`, `fails` |
| `verdicts` | Latest verdict per product (wall, scores, share card) |
| `alerts` | Price alerts (off) |
| `shop_requests` | "Ask us to add a shop" requests (made on first use) |
| `cache` | Cache (shop pages, robots.txt, archive lists). The same value is not written again while more than half its time to live is left |
| `rl` | Rate-limit counters, only when the `RL_*` bindings are missing, plus the daily mail counter |
| `m_counts` | Stats: daily totals only (`day`, `metric`, `key`, `n`). Kept 400 days |
| `m_seen`, `m_salt` | Stats: today's salted visitor hashes and today's random salt. Deleted at the start of each new day |

### Rows written (D1 Free plan: 100,000 a day)

D1 counts every row and every index entry a query changes, and the count resets at 00:00 UTC (02:00 SAST). If the limit is used up, D1 refuses writes until the reset. A check still answers then: the price we read is shown, but it is not cached or saved (`tracked: false`), and the Worker logs one `{"d1_write_failed": ...}` line a minute. Stats writes fail silently.

See where writes come from (GraphQL Analytics API, dataset `d1QueriesAdaptiveGroups`, `sum { rowsWritten }` by `dimensions.query`, filtered by `databaseId` and `datetime`), or Cloudflare dashboard → D1 → `bf-price-check-db` → Metrics.

Writes that change nothing are skipped (every changed row and every changed index entry counts): `track()` writes nothing for a cached answer seen again within 12 hours, a verdict is written only when a value changed (`updated_at` = last change), a seed product's `last_viewed` moves at most once in 20 hours, and the daily check does not fill the check cache. Indexes that nothing reads (`idx_tracked_last`, `idx_checks_via_ts`) are dropped in `schema.sql`.

Read shop requests:

```
npx wrangler d1 execute bf-price-check-db --remote --command "SELECT id, datetime(created_at/1000,'unixepoch') AS at, host, shop_text, product_url, email FROM shop_requests ORDER BY id DESC LIMIT 50"
```

(The token needs D1 Read or Edit; the Cloudflare dashboard D1 console also works.) Only a hash of the IP address is kept. Requests are not shown anywhere public.

## Tests and CI/CD

| Command | What it does | Network |
|---|---|---|
| `npm test` | Unit and integration tests (`tests/unit/*.test.mjs`, `tests/regression.test.mjs`) | none |
| `npm run test:e2e -- http://127.0.0.1:8787` | Browser tests (desktop and phone) against `wrangler dev` with a local D1 | local only |
| `npm run test:smoke -- URL` | Post-deploy check of a live site | live site |
| `node tests/e2e_features.mjs [BASE] [SHOTDIR]` | Full live suite: layout at 360–1920 px light/dark, forms, `?url=` links on both domains, share tags, privacy | live site |
| `node tests/e2e_redesign.mjs [BASE]`, `node tests/e2e_review.mjs [BASE]` | Live click-through suites | live site |
| `[E2E_KEY=…] node tests/stats_smoke.mjs [STATS_URL] [SITE_URL]` | The stats host is private (403 or Access login, never 200) and the dev shortcut is closed. With the live test key, also runs one made-up page view through the real counter (`POST /api/e2e/stats-probe`), checks it was counted, and removes it again | live site |
| `node scripts/cf_token_check.mjs` | What the Cloudflare API token can do (never prints it) | Cloudflare API |

The live suites read the test key from `$E2E_KEY` and remove their test rows at the end.

Run the browser tests locally:

```bash
npm ci && python3 build.py
npx wrangler d1 execute bf-price-check-db --local --file schema.sql
npx wrangler dev --port 8787 &
npm run test:e2e -- http://127.0.0.1:8787
```

`.github/workflows/ci.yml` runs on every pull request and every push to `main`:

1. **Build and test**: `npm ci`, `python3 build.py`, `npm test`, browser tests against `wrangler dev`.
2. **Cloudflare token permissions**: read-only report (never blocks).
3. **Deploy to Cloudflare** (push to `main` only, after tests pass): applies `schema.sql` when the token has D1 Edit, `wrangler deploy`, then smoke tests on workers.dev and on the custom domain, and a check that `stats.veldwire.com` is not readable without Access. A failed smoke test fails the run.

Secrets used in GitHub: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

## Deploy

A push to `main` deploys (after the tests pass). **Deploy through CI only.** Several workers change this repo in parallel (daily saving, other features); a hand deploy from an old checkout overwrites their live code. Always `git pull` (merge the latest `main`) before you push. Emergency only: `git pull && python3 build.py && npx wrangler deploy`.

Test locally the same way CI does: `npx wrangler d1 execute bf-price-check-db --local --file schema.sql`, put a random `E2E_KEY=…` in `.dev.vars` (git-ignored), `npx wrangler dev --port 8787`, then `E2E_KEY=… node tests/e2e_features.mjs http://127.0.0.1:8787`. Locally, the alert links and the absolute preview-image checks fail (no alerts, the site URL is the live domain); run those on the live site.

Cloudflare resources: Worker `bf-price-check`, D1 `bf-price-check-db`, cron `* * * * *` (daily price saving), custom domains `eish.veldwire.com` and `stats.veldwire.com` (zone veldwire.com), workers.dev on. Cloudflare Web Analytics is turned on for the zone and adds its beacon on the custom domain.

## Known limits

- Many big stores block requests from cloud servers (HTTP 403/bot checks): in tests Argos, Currys, bol.com, Zalando, Incredible, iStore, Makro, Dis-Chem; John Lewis returned 520, Otto 400. For these the tool shows the latest archived price (if any) and lets the user type the price.
- Amazon hides the buy box from foreign visitors for some products (e.g. Kindle devices). Items that ship internationally (books etc.) work.
- Wayback coverage of product pages is thin, especially for South African stores (often 0–3 copies in 12 months). Common Crawl adds monthly copies for 22 shops, but not Takealot, and only for products it happened to crawl. Takealot product pages are rendered by JavaScript, so archived copies have no price. History therefore mostly grows from the prices we save: when people check, and about once a day for each product in the daily list.
- The Internet Archive sometimes answers 503 or is slow; the tool retries and shows a "Try the archive again" button.
- Marketplace listings (Amazon, MediaMarkt, Takealot) can change seller, so archived prices may be from a different seller.
- Other shops: shops that block us, whose search is built by JavaScript only, or whose robots.txt disallows their search are not searched. Tried for the UK (November 2026): Currys, Argos, AO.com, Very, Superdrug and Dunelm block cloud requests (403/406); John Lewis, Wickes, Lookfantastic and Boots disallow their search in robots.txt; Halfords, Richer Sounds and Cult Beauty build results with JavaScript only. Tried for ZA: Checkers/Shoprite blocks (403); Woolworths, Yuppiechef and Cashbuild disallow search in robots.txt; Cycle Lab, Sportsmans and Outdoor Warehouse, Bob Shop, OneDayOnly, Faithful to Nature, Bargain Books, Cotton On, Sheet Street and Miladys have no usable server-side search. UK electronics coverage is thin (Fenwick only). Fashion items match only when the other shop shows the same barcode or style code, which most ZA fashion shops do not.
- Free-plan Worker limits (CPU time, 50 sub-requests per call) apply; each archive copy is fetched in its own request to stay inside them, and the daily price saving works in small batches every minute.

## Private stats

Dashboard: **https://stats.veldwire.com** (owner only). It shows the last 7, 30 or 90 days: visitors, page views, price checks, share of checks where we read a price, shops, shares, a daily chart (visitors, page views, checks), check outcomes, top shops with their read rate, countries, referring sites, devices, button clicks and other events (shop requests sent, compare searches and matches, shared links opened). Each number shows the change against the period before. Light and dark follow the system setting. It is one server-rendered page with an inline SVG chart and no scripts (about 24 KB).

**What is counted** (daily totals, days in SAST):

| Metric | How |
|---|---|
| Page views | Server side, on each GET of `/`, `/privacy`, `/wall` by a browser. Bots, link previews (WhatsApp, Facebook…), scripts, prefetches and our own test runs are left out (bots get their own total). |
| Visitors | Once per day per device and browser: SHA-256 of today's random salt + IP + browser string, cut to 20 hex characters, kept only for today. The salt is random, made each day and deleted the next day with all hashes, so the IP can't be recovered and a visitor can't be followed across days. The range total is a sum of daily visitors. |
| Country, device | Counted once per visitor per day. Country from Cloudflare (`request.cf.country`), device (phone, tablet, desktop) from the browser string. |
| Referrer | The referring site's domain only, never the path. No referrer = "Direct, apps or WhatsApp". |
| Checks, outcomes, shops | From each `/api/check` answer: price read, no price found, shop blocked us, error, bad link, rate limited; the shop's host and whether we read a price. |
| Clicks | `navigator.sendBeacon("/api/m", name)` on Share (and WhatsApp, Copy link, More apps), Save, opening another shop's offer (compare), Request a shop, Saved list, Shops list, example links. Only the button name is sent. |
| Events | Shop requests sent, compare searches and matches, shared links opened (`/?u=`). |

No cookies, no local storage, no tracking library, no raw IP addresses, no full URLs from other sites. The site's short Privacy page sums this up for visitors. Counting runs after the answer is sent (`ctx.waitUntil`), so pages are not slower: one D1 write batch per page view. D1 was chosen over Workers Analytics Engine because the worker can read D1 directly; Analytics Engine needs a separate API token to query.

**Access control (fail closed).** `stats.veldwire.com` is meant to sit behind Cloudflare Access. The worker also checks the `Cf-Access-Jwt-Assertion` header on every request: RS256 signature against the team's public keys (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, cached for an hour), issuer, audience (`ACCESS_AUD`), expiry, and that the email is the owner's (`OWNER_EMAIL`, or `STATS_ALLOWED_EMAILS`). Anything missing or wrong = 403. Until `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set, everyone gets 403. The dashboard is only served on that host; the main site and workers.dev never serve it.

**Set up Access (once, in the Cloudflare dashboard):**

1. Zero Trust → choose a team name (for example `veldwire`) and the Free plan (up to 50 users).
2. Zero Trust → Access → Applications → Add an application → Self-hosted. Name: `BF stats`. Domain: `stats.veldwire.com`. Session: 24 hours.
3. Add a policy: Action **Allow**, Include → **Emails** → your email. Login method: One-time PIN (or Google). Save.
4. Open the application again and copy the **Application Audience (AUD) Tag**.
5. Workers & Pages → `bf-price-check` → Settings → Variables and Secrets → add two **Secrets** (type Secret, not Text, so deploys keep them): `ACCESS_TEAM_DOMAIN` = your team name (or `<team>.cloudflareaccess.com`), `ACCESS_AUD` = the AUD tag.
6. Open https://stats.veldwire.com, sign in with your email, done.

**Local development:** with `STATS_DEV=1` in `.dev.vars`, `wrangler dev` serves the dashboard at `http://127.0.0.1:8787/__stats` without Access. The shortcut needs that variable *and* a plain-http request from 127.0.0.1, so it can't open on Cloudflare (where `cf-connecting-ip` is the real visitor). Never set `STATS_DEV` on the live worker. `STATS_COUNT_E2E=1` (local only) counts the browser tests' own traffic so the tests can check the counters.

## Privacy summary

`/privacy` is three short lines for friends and family, not a legal page: we save product links and prices for price history; we do not save who you are (no accounts, no names, no tracking cookies); we keep an email only if someone types it into a form.

Full detail of what the code stores: product links that people check and the prices we read; shop requests (shop, link, and an email only if given) with a hash of the IP address; price alerts when they are on; daily stats totals (visits, checks, button names, country, device, referring domain), with visitors counted by a hash that uses a salt deleted every day. Saved products, stats and badges stay in the browser. The site runs on Cloudflare (Web Analytics without cookies; Turnstile when it is set up). Keep the page text in step with this list.
