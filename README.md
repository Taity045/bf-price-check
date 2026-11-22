# Deal or Dud? — Black Friday price checker

Live: https://bf-price-check.lala-board.workers.dev

Paste a product link from an online store. The tool shows:

1. **Today's price and the "was" price**, read server-side from the product page.
2. **A 6-month price chart**, rebuilt from Internet Archive (Wayback Machine) copies of the page, plus our own daily re-checks.
3. **A verdict** that flags inflated "was" prices and shows the real discount against the 6-month low and the median ("usual") price.

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
- `GET /api/archive?url=<canonical>&orig=<pasted url>` → Wayback CDX lookup (last 183 days, one capture per ~7 days, max 26). Cached 12 h.
- `GET /api/snap?url=<canonical>&ts=<14-digit>&orig=<archived url>` → price from one archived copy. Stored forever in D1 (failed fetches retried after 6 h).
- Cron `15 * * * *`: re-checks up to 6 tracked products per run that were not checked in 20 h → every tracked product is re-checked about once a day.

### Price extraction (in order)

1. Site-specific: **Takealot public API** (`api.takealot.com/rest/v-1-14-0/product-details/PLID…`: `price` and `listing_price`), **Amazon** price block (`priceToPay`, `basisPrice`/List Price).
2. **JSON-LD** `Product`/`ProductGroup`/`Offer`/`AggregateOffer` incl. `priceSpecification` with `StrikethroughPrice`/`ListPrice` (= "was").
3. **OpenGraph / product meta tags** (`product:price:amount`, `og:price:amount`, `product:original_price:amount`) and **microdata** (`itemprop="price"`).
4. **schema.org Offer embedded in a script** (JSON-LD built by JavaScript or app state; the enclosing JSON object is extracted and parsed).
5. Common shop data fields (`salePrice`, `finalPrice`, `wasPrice`…) and the GA4 e-commerce data layer.

Currency comes from the page; if the page has none, it is taken from the web address (.co.za → ZAR, .co.uk → GBP, euro TLDs → EUR) and the UI says "currency guessed". The chart and verdict only compare prices in one currency. Amazon results in a different currency (Amazon shows USD to foreign visitors) are rejected.

### Verdict rules (client side)

Older prices = archive points + daily checks older than 24 h, last 183 days.
- fewer than 2 older prices → "Not enough history" (the store's claim is shown but not confirmed)
- price ≤ 6-month low and ≥ 5 % under the median → **Real deal**
- "was" price > 103 % of the 90-day high (or 6-month high if < 2 points in 90 days) and price not ≥ 5 % under median → **Fake discount**
- price > 103 % of median → **Pricier than usual**
- ≥ 5 % under median → **Decent deal**; otherwise **Same old price**
- A red flag is always shown when the "was" price is higher than anything seen in 90 days / 6 months.

### Abuse protection

- Only `http(s)` URLs, standard ports, no credentials, no IP-address hosts, no `localhost`/`.local`/`.internal` etc.
- DNS check through Cloudflare DoH: hosts that resolve to private/reserved IPv4/IPv6 ranges are refused.
- Max 4 MB per page, 15 s timeout for stores, 25 s for the archive.
- Rate limit (D1, per IP per minute): 20 checks, 120 archive-copy reads.
- `/api/archive` and `/api/snap` only work for products that were checked first; archived URL host must match.
- Max 1,000 tracked products; products not viewed for 120 days are dropped from the daily re-check.

## Deploy / edit

```bash
python3 build.py                 # writes dist/worker.js and deploy_exec.js
# then run deploy_exec.js through the Cloudflare MCP "execute" tool (account 8746524b5d7c1ba84abb3db21517d7a7)
```

Cloudflare resources: Worker `bf-price-check`, D1 database `bf-price-check-db` (`65e86f16-42db-4c07-bbd7-20ba0308d47e`) bound as `DB`, cron `15 * * * *`. No routes, no DNS, no custom domain.

Note: the URL contains the account's workers.dev subdomain. If the subdomain is renamed, the URL changes to `https://bf-price-check.<new-subdomain>.workers.dev`.

## Known limits

- Many big stores block requests from cloud servers (HTTP 403/bot checks): in tests Argos, Currys, bol.com, Zalando, Incredible, iStore, Makro, Dis-Chem; John Lewis returned 520, Otto 400. For these the tool shows the latest archived price (if any) and lets the user type the price.
- Amazon hides the buy box from foreign visitors for some products (e.g. Kindle devices). Items that ship internationally (books etc.) work.
- Wayback coverage of product pages is thin, especially for South African stores (often 0–3 copies in 6 months). Takealot product pages are rendered by JavaScript, so archived copies have no price. History therefore mostly grows from the daily re-checks.
- The Internet Archive sometimes answers 503 or is slow; the tool retries and shows a "Try the archive again" button.
- Marketplace listings (Amazon, MediaMarkt, Takealot) can change seller, so archived prices may be from a different seller.
- Free-plan Worker limits (CPU time, 50 sub-requests per call) apply; each archive copy is fetched in its own request to stay inside them.
