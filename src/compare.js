// ---------- Compare: the same product at other shops ----------
// Joined with worker.js and features.js at build time (build.py), so it shares their helpers.
//
// How it works
//   1. /api/compare?url=      builds the product's identity (barcode, brand, model codes, specs) and the
//                             list of shops worth searching (same currency, shops that sell this kind of item).
//   2. /api/compare/shop?url=&shop=  searches ONE shop with its own public site search, then matches strictly.
//      The page calls this once per shop (a few at a time), so each Worker request stays far below the
//      subrequest limit, and results appear shop by shop.
//   3. Results are cached in D1 (per product and shop, and per shop search), and every matched price is saved
//      into the price history of that shop's product page.
// Matching levels (strongest first): same barcode (GTIN/EAN) > same model number > same name and specs.
// A candidate is dropped on any conflict (storage, screen size, volume, weight, pack size, colour, gender,
// variant words such as Pro/Max/Slim/Digital, accessories, bundles, used or imported stock, price far off).

const CMP_UA = "DealOrDud-PriceCompare/1.0 (+https://eish.veldwire.com; compares one product's price when a shopper asks)";
const CMP_TTL = 12 * 3600e3;          // a shop's answer for one product
const CMP_ERR_TTL = 20 * 60e3;        // a failed or busy shop is retried sooner
const CMP_SEARCH_TTL = 6 * 3600e3;    // one search on one shop (shared by all products)
const CMP_SHOP_PER_MIN = 30;          // searches per shop per minute, all visitors together
const CMP_PER_IP_PER_MIN = 240;       // shop calls per visitor per minute (one check makes up to ~20)
// Bump when the matching rules or identity reading change, so cached answers from older rules are not shown.
const CMP_VER = "v5";
const CMP_MAX_SEARCHES = 2;           // searches per shop per product
const CMP_MAX_DETAILS = 3;            // product-detail reads per shop per product (to read barcodes)

// Shops we can search. kind = how we search; sells = kinds of products (see cmpCategory); brands = brand-only shops.
const CMP_SHOPS = [
  { id: "takealot", name: "Takealot", cur: "ZAR", hosts: ["takealot.com"], kind: "takealot", sells: ["*"] },
  { id: "loot", name: "Loot", cur: "ZAR", hosts: ["loot.co.za"], kind: "loot", base: "https://www.loot.co.za", sells: ["*"] },
  { id: "evetech", name: "Evetech", cur: "ZAR", hosts: ["evetech.co.za"], kind: "evetech", base: "https://www.evetech.co.za", sells: ["computer", "electronics"] },
  { id: "computermania", name: "Computer Mania", cur: "ZAR", hosts: ["computermania.co.za"], kind: "shopify", base: "https://computermania.co.za", sells: ["computer", "electronics", "appliances"] },
  { id: "matrix", name: "Matrix Warehouse", cur: "ZAR", hosts: ["matrixwarehouse.co.za"], kind: "shopify", base: "https://matrixwarehouse.co.za", sells: ["computer", "electronics"] },
  { id: "firstshop", name: "First Shop", cur: "ZAR", hosts: ["firstshop.co.za"], kind: "shopify", base: "https://www.firstshop.co.za", sells: ["computer", "electronics", "appliances"] },
  { id: "hirschs", name: "Hirsch's", cur: "ZAR", hosts: ["hirschs.co.za"], kind: "magento", gql: "special", base: "https://www.hirschs.co.za", sells: ["appliances", "electronics"] },
  { id: "okfurniture", name: "OK Furniture", cur: "ZAR", hosts: ["okfurniture.co.za"], kind: "magento", base: "https://www.okfurniture.co.za", off: "robots", sells: ["appliances", "electronics", "home"] },
  { id: "toysrus", name: "Toys R Us", cur: "ZAR", hosts: ["toysrus.co.za"], kind: "magento", base: "https://www.toysrus.co.za", off: "robots", sells: ["toys", "baby", "electronics"] },
  { id: "babiesrus", name: "Babies R Us", cur: "ZAR", hosts: ["babiesrus.co.za"], kind: "magento", base: "https://www.babiesrus.co.za", off: "robots", sells: ["baby"] },
  { id: "bash", name: "Bash (TFG)", cur: "ZAR", hosts: ["bash.com", "zando.co.za", "foschini.co.za", "americanswiss.co.za", "sportscene.co.za", "totalsports.co.za", "markham.co.za", "volpes.co.za", "hi-online.co.za"], kind: "vtex", base: "https://bash.com", sells: ["fashion", "beauty", "electronics", "home"] },
  { id: "superbalist", name: "Superbalist", cur: "ZAR", hosts: ["superbalist.com"], kind: "ldlist", search: "https://superbalist.com/search?q={q}", off: "robots", sells: ["fashion", "beauty", "home"] },
  { id: "studio88", name: "Studio 88", cur: "ZAR", hosts: ["studio-88.co.za"], kind: "magento", base: "https://www.studio-88.co.za", off: "robots", sells: ["fashion"] },
  { id: "puma", name: "PUMA ZA", cur: "ZAR", hosts: ["za.puma.com"], kind: "ldlist", search: "https://za.puma.com/search?q={q}", sells: ["fashion"], brands: ["puma"] },
  { id: "edgars", name: "Edgars", cur: "ZAR", hosts: ["edgars.co.za"], kind: "shopify", base: "https://www.edgars.co.za", sells: ["fashion", "beauty", "home"] },
  { id: "ackermans", name: "Ackermans", cur: "ZAR", hosts: ["ackermans.co.za"], kind: "shopify", base: "https://www.ackermans.co.za", off: "robots", sells: ["electronics", "toys", "baby"] },
  { id: "pep", name: "Pep", cur: "ZAR", hosts: ["pepstores.com"], kind: "shopify", base: "https://www.pepstores.com", off: "robots", sells: ["electronics", "toys", "baby"] },
  { id: "exclusivebooks", name: "Exclusive Books", cur: "ZAR", hosts: ["exclusivebooks.co.za"], kind: "shopify", base: "https://exclusivebooks.co.za", sells: ["books"] },
  { id: "ngf", name: "Norman Goodfellows", cur: "ZAR", hosts: ["ngf.co.za"], kind: "shopify", base: "https://www.ngf.co.za", sells: ["liquor"] },
  { id: "lakeland", name: "Lakeland", cur: "GBP", hosts: ["lakeland.co.uk"], kind: "shopify", base: "https://www.lakeland.co.uk", off: "robots", sells: ["appliances", "home"] },
  // UK
  { id: "allbeauty", name: "allbeauty", cur: "GBP", hosts: ["allbeauty.com"], kind: "shopify", base: "https://allbeauty.com", sells: ["beauty"] },
  { id: "escentual", name: "Escentual", cur: "GBP", hosts: ["escentual.com"], kind: "shopify", base: "https://escentual.com", sells: ["beauty"] },
  { id: "fenwick", name: "Fenwick", cur: "GBP", hosts: ["fenwick.co.uk"], kind: "shopify", base: "https://fenwick.co.uk", sells: ["appliances", "home", "beauty", "electronics"] },
];
// off: "robots" = the shop's robots.txt asks tools not to use the search we would use, so we don't search it
// (it can still be the page someone checks). Checked again at run time (cmpRobotsOk), so new rules apply too.
const cmpShopById = (id) => CMP_SHOPS.find((s) => s.id === id) || null;
function cmpShopForHost(host) {
  const h = stripWww(String(host || "").toLowerCase());
  return CMP_SHOPS.find((s) => s.hosts.some((d) => h === d || h.endsWith("." + d))) || null;
}

// ---------- text normalising ----------
const CMP_COLOURS = ["black", "white", "silver", "grey", "gray", "gold", "blue", "red", "green", "pink", "purple", "yellow", "orange", "brown", "beige", "cream", "navy", "midnight", "starlight", "graphite", "rose", "lavender", "teal", "mint", "khaki", "olive", "burgundy", "maroon", "charcoal", "ivory", "coral", "lilac", "violet", "turquoise", "aqua", "bronze", "copper", "champagne", "sage", "stone", "sand", "tan", "natural", "desert", "ultramarine", "cobalt", "indigo", "obsidian", "porcelain", "hazel", "lemongrass"];
const CMP_COLOUR_SET = new Set(CMP_COLOURS);
const CMP_COLOUR_ALIAS = { gray: "grey", charcoal: "grey", graphite: "grey", ivory: "white", cream: "white", porcelain: "white" };
// Words that make a different product when only one side has them.
// Strong ones are checked for every match; weak ones (screen and naming words) only for name matches.
const CMP_VARIANT_STRONG = new Set(["pro", "max", "plus", "ultra", "mini", "lite", "slim", "digital", "disc", "se", "fe", "anc", "fold", "flip", "cellular", "xl"]);
const CMP_VARIANT = new Set([...CMP_VARIANT_STRONG, "neo", "edge", "note", "s", "air", "oled", "qled", "fhd", "uhd", "hd", "4k", "8k", "studio", "sport", "classic", "x", "e", "music", "solar", "sapphire", "lte", "signature", "elixir", "intense", "absolu", "parfum", "toilette", "cologne", "edp", "edt", "edc", "junior", "kids", "mk2", "ii", "iii", "iv"]);
// Describing words: may be missing on one side without making a different product.
const CMP_GENERIC = new Set(["portable", "waterproof", "water", "resistant", "bluetooth", "wireless", "wired", "smart", "speaker", "headphones", "headphone", "headset", "earbuds", "earphones", "buds", "in-ear", "over-ear", "on-ear", "true", "stereo", "audio", "sound", "pod", "pods", "capsule", "coffee", "machine", "maker", "console", "gaming", "game", "phone", "smartphone", "cellphone", "mobile", "dual", "sim", "esim", "watch", "smartwatch", "gps", "running", "fitness", "tracker", "tv", "television", "led", "display", "screen", "mouse", "keyboard", "performance", "ergonomic", "digital", "window", "analog", "airfryer", "fryer", "air-fryer", "kettle", "cordless", "electric", "stainless", "steel", "fridge", "freezer", "combi", "eco", "bottom", "top", "mount", "door", "frost", "free", "no", "with", "charging", "case", "usbc", "cable", "black", "white", "building", "set", "kit", "toy", "toys", "stem", "model", "car", "for", "adults", "boys", "girls", "years", "age", "ages", "spray", "fragrance", "perfume", "eau", "de", "mens", "womens", "unisex", "men", "women", "him", "her", "paperback", "hardcover", "book", "camera", "drone", "tablet", "ereader", "e-reader", "kindle", "wifi", "inch", "uhd", "crystal", "hdr", "edition", "bundle", "pack", "piece", "pieces", "pcs", "new", "latest", "original", "genuine", "series", "range", "collection", "classic", "premium", "deluxe", "standard", "regular", "ultra", "slim", "pro", "max", "plus"]);
// Words that say nothing about which product it is.
const CMP_STOP = new Set(["the", "and", "with", "of", "a", "an", "in", "on", "by", "to", "new", "edition", "version", "official", "genuine", "original", "brand", "free", "shipping", "sa", "south", "africa", "local", "stock", "local stock", "model", "series", "colour", "color", "size", "inch", "inches", "gen", "generation", "includes", "including", "incl", "w", "only", "set", "item", "product", "unit", "1pc", "pc", "piece"]);
const CMP_ACCESSORY = /\b(compatible|replacement|protector|tempered|skins?|decals?|stickers?|refill|refills|spare)\b|\b(case|cover|sleeve|pouch|strap|band|stand|holder|mount|dock|charger|cable|adapter|controller|remote|lens|filter|bag)\s+(for|compatible|to\s+fit)\b|\bfor\s+(apple|samsung|iphone|ipad|airpods|galaxy|ps5|ps4|playstation|xbox|nintendo|switch|macbook|sony|huawei|xiaomi|oppo|garmin|fitbit|gopro|dji|nikon|canon|lg|hisense|tcl)\b/i;
const CMP_CONDITION = /\b(refurbished|refurb|renewed|pre[- ]?owned|second[- ]?hand|used|demo|ex[- ]?demo|open[- ]?box|grade\s+[a-c]|parallel\s+import|imported|import|grey\s+import|b-grade|cpo)\b/i;
// Game or special editions (often a console with a game): the word must be on both sides or neither.
const CMP_EDITION = /\b(fortnite|call of duty|cod|ea sports|fc ?2\d|fifa|spider-?man|marvel|astro bot|god of war|mario|kart|zelda|pokemon|minecraft|hogwarts|gta|grand theft auto|ghost of|battlefield|flowering|chaos|game ?pass|limited edition|special edition|anniversary|collectors?)\b/gi;
const cmpEditions = (t) => new Set((cmpNorm(t).match(CMP_EDITION) || []).map((x) => x.toLowerCase().replace(/\s+/g, " ")));
const CMP_BUNDLE = /\s\+\s|\bbundle\b|\bcombo\b|\bvoucher\b|\b(?<!(?:model|building|car|construction|lego|technic|brick|bricks)\s)kit\b|\bwith\s+(?:game|controller|headset|voucher)|\b\d+\s*(?:x|pack|pk)\s+(?:of\s+)?/i;

function cmpNorm(s) {
  return decodeEntities(String(s || "")).toLowerCase()
    .replace(/[\u2019'`´]/g, "")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/(\d)[,](\d)/g, "$1.$2")
    .replace(/(\d+(?:\.\d+)?)\s*(?:"|''|\u201d|\u2033|-?\s*inch(?:es)?\b|-in\b)/g, " $1in ")
    .replace(/\beau\s+de\s+parfum\b/g, " edp ").replace(/\beau\s+de\s+toilette\b/g, " edt ").replace(/\beau\s+de\s+cologne\b/g, " edc ")
    .replace(/\bplay\s*station\s*(\d)\b/g, " ps$1 ")
    .replace(/\bwi[\s-]?fi\b/g, " wifi ")
    .replace(/\bbt\b/g, " bluetooth ")
    .replace(/\busb[\s-]?type[\s-]?c\b|\busb[\s-]?c\b/g, " usbc ")
    .replace(/\b(\d)\s?k\b/g, " $1k ")
    .replace(/\bactive[\s-]+noise[\s-]+cancell?(?:ation|ing)\b|\bnoise[\s-]+cancell?(?:ation|ing)\b/g, " anc ")
    .replace(/\bdis[ck]\s+(?:drive|edition|version)\b|\bdisk\b/g, " disc ")
    .replace(/\b(\d+)(?:st|nd|rd|th)\s*(?:gen|generation)\b/g, " $1 ")
    .replace(/\b(?:gen|generation)\s*(\d+)\b/g, " $1 ")
    .replace(/\bmen(?:s)?\b|\bmale\b/g, " mens ")
    .replace(/\bwom[ae]n(?:s)?\b|\bladies\b|\bfemale\b/g, " womens ")
    .replace(/\b(?:jnr|youth|boys|girls|kid|childrens|children|infants?|toddlers?|grade\s?school|gs|ps|td)\b/g, " kids ")
    .replace(/\b(\d+(?:\.\d+)?)\s*(gb|tb|mb|mah|wh|kw|w|v|hz|l|lt|ltr|litres?|liters?|ml|kg|g|cm|mm|pcs|pieces|pack|pk|piece)\b/g, " $1$2 ")
    .replace(/\s+/g, " ").trim();
}
const cmpWords = (s) => cmpNorm(s).split(/[\s,()|\[\]{}:;!?*&/]+/).flatMap((t) => t.split(/(?<=[a-z])-(?=[a-z])|-(?=\d+in$)/)).map((t) => t.replace(/^[^a-z0-9.+]+|[^a-z0-9+]+$/g, "")).filter(Boolean);

// Product codes: letters and digits together (UA55DU7000KXXA, SM-S931B, CW2288-111, MXP63ZE/A, 75192 for LEGO).
// Not product codes: sizes and units, chip and connector names (shared by many different products).
const CMP_CHIP = /^(i[3579]\d{3,5}[a-z]{0,3}|r[3579]\d{4}[a-z]{0,3}|ryzen\d+|rtx\d{4}[a-z]{0,3}|gtx\d{4}[a-z]{0,2}|rx\d{4}[a-z]{0,3}|arc[ab]\d{3}|m[1-5](pro|max|ultra)?|snapdragon\w*|dimensity\d+|helio\w*|exynos\d+|hdr\d+|ip[x\d]\d|wifi\d[a-z]?|bt\d+|usb\d+|qi\d|ddr\d|lpddr\d+x?|pcie\d|gen\d+|hdmi\d*|ps\d|ax\d{4}|be\d{4}|ac\d{4})$/;
const CMP_NOT_CODE = /^(\d+(gb|tb|mb|mah|wh|kw|w|v|hz|khz|mm|cm|m|kg|g|mg|ml|l|lt|ltr|in|mp|k|p|x|pcs|pk|pack|piece|pieces|th|nd|rd|st|ft|yr|yrs|years|mths|months|gbps|mbps|fps|rpm|db|nm|ghz|mhz|core|cores|bit|dpi|lm|pin|way|sp|seater|port|ports|bar|psi)|(usbc|wifi\d*|ddr\d|lpddr\d+x?|pcie\d*|gen\d+|ps\d|rtx|gtx|hdmi\d*|bt\d*|ip\d\d|a\d{2}|m\d|i\d|r\d|s\d{2}|x\d))$/;
function cmpCodes(text, brand) {
  const out = new Set();
  const raw = decodeEntities(String(text || "")).toLowerCase();
  // Nike/Jordan style codes: CW2288-111
  for (const m of raw.matchAll(/\b([a-z]{2}\d{4})[-\s_]?(\d{3})\b/g)) out.add(m[1] + m[2]);
  for (let t of raw.split(/[\s,()|\[\]{}:;"!?*&]+/)) {
    t = t.replace(/^[^a-z0-9]+|[^a-z0-9/]+$/g, "");
    if (!t) continue;
    // Apple part numbers: MXP63ZE/A -> MXP63 (the letters after the base name the region)
    const ap = t.match(/^([a-z0-9]{5})(?:[a-z]{1,2})?\/a$/);
    if (ap && /[a-z]/.test(ap[1]) && /\d/.test(ap[1])) { out.add(ap[1]); continue; }
    for (const part of t.split("/")) {
      const c = part.replace(/[-._]/g, "");
      if (c.length < 5 || c.length > 20 || !/[a-z]/.test(c) || !/\d/.test(c) || CMP_NOT_CODE.test(c)) continue;
      if (/^\d+[a-z]{1,3}$/.test(c) || /^[a-z]+\d{1,2}$/.test(c) || CMP_CHIP.test(c)) continue;   // 1500w, iphone16, i7-13700h
      out.add(c);
    }
  }
  // LEGO set numbers are plain digits
  if (/lego/i.test(String(brand || "") + " " + raw)) for (const m of raw.matchAll(/\b(\d{4,6})\b/g)) if (!/^(19|20)\d\d$/.test(m[1])) out.add("lego" + m[1]);
  return [...out];
}
function cmpCodesMatch(a, b) {
  for (const x of a) for (const y of b) {
    if (x === y) return x;
    const [s, l] = x.length <= y.length ? [x, y] : [y, x];
    if (s.length >= 8 && l.startsWith(s) && /^[a-z]{1,6}$/.test(l.slice(s.length))) return s;     // UA55DU7000 vs UA55DU7000KXXA
  }
  return null;
}
// Barcodes compare without leading zeros (UPC 12 = EAN 13 = GTIN 14). Shop-internal EAN-13s (prefix 2) are ignored.
const cmpGtin = (g) => { const s = String(g || "").replace(/\D/g, "").replace(/^0+/, ""); return s.length >= 8 && s.length <= 14 && !(s.length === 13 && s[0] === "2") ? s : null; };

function cmpAttrs(title) {
  const w = cmpWords(title), a = { storage: new Set(), inch: new Set(), cm: new Set(), ml: new Set(), g: new Set(), watt: new Set(), pack: new Set(), year: new Set(), colour: new Set(), gender: new Set(), variant: new Set(), nums: new Set(), words: new Set() };
  for (let i = 0; i < w.length; i++) {
    const t = w[i];
    let m;
    if ((m = t.match(/^(\d+(?:\.\d+)?)(gb|tb)$/))) a.storage.add(+m[1] * (m[2] === "tb" ? 1024 : 1));
    else if ((m = t.match(/^(\d+(?:\.\d+)?)in$/))) a.inch.add(Math.round(+m[1]));
    else if ((m = t.match(/^(\d+(?:\.\d+)?)cm$/))) a.cm.add(Math.round(+m[1]));
    else if ((m = t.match(/^(\d+(?:\.\d+)?)(l|lt|ltr|litres?|liters?|ml)$/))) a.ml.add(Math.round(+m[1] * (m[2] === "ml" ? 1 : 1000)));
    else if ((m = t.match(/^(\d+(?:\.\d+)?)(kg|g)$/))) a.g.add(Math.round(+m[1] * (m[2] === "kg" ? 1000 : 1)));
    else if ((m = t.match(/^(\d+(?:\.\d+)?)(w|kw)$/))) a.watt.add(Math.round(+m[1] * (m[2] === "kw" ? 1000 : 1)));
    else if ((m = t.match(/^(\d+)(pcs|pieces|pack|pk|piece)$/))) a.pack.add(+m[1]);
    else if (/^(19[89]\d|20[0-4]\d)$/.test(t)) a.year.add(+t);
    else if (/^\d+$/.test(t)) {
      const nx = w[i + 1] || "";
      if (/^(pack|pk|pcs|pieces|piece)$/.test(nx)) { a.pack.add(+t); i++; }
      else a.nums.add(String(+t));
    }
    else if (CMP_COLOUR_SET.has(t)) a.colour.add(CMP_COLOUR_ALIAS[t] || t);
    else if (t === "mens" || t === "womens" || t === "kids" || t === "unisex") a.gender.add(t);
    else if (CMP_VARIANT.has(t)) a.variant.add(t);
    else if (/^[a-z]+\d+[a-z]*$|^\d+[a-z]+$/.test(t) && !/^\d+(mah|wh|v|hz|mm|mb)$/.test(t)) a.words.add(t);   // s25, m4, ps5, 128gb handled above
    else if (/^[a-z][a-z.+]*$/.test(t) && !CMP_STOP.has(t) && t.length > 1) a.words.add(t);
  }
  return a;
}
const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const overlap = (a, b) => [...a].some((x) => b.has(x));

function cmpBrand(b) { return String(b || "").toLowerCase().replace(/&amp;/g, "&").replace(/[^a-z0-9&]+/g, " ").trim() || null; }

// The product's identity, from the checked page (title, brand, barcode, model number).
function cmpIdentity(cur, canon) {
  const title = String(cur.title || "").replace(/\s+/g, " ").trim();
  let brand = cmpBrand(cur.brand);
  if (brand && /^(generic|unbranded|no brand|other|none|n a)$/.test(brand)) brand = null;
  const titleCodes = cmpCodes(title, brand);
  const codes = cmpCodes(title + " " + (cur.mpn || ""), brand);
  let urlCodes = [];
  try { urlCodes = cmpCodes(new URL(canon).pathname.replace(/\/PLID\d+/i, "").replace(/[-_]/g, " "), brand).filter((c) => !codes.includes(c)); } catch {}
  let gtin = cmpGtin(cur.gtin);
  // book shops often put the ISBN in the link
  if (!gtin) { try { const m = new URL(canon).pathname.match(/(?:^|[^\d])(97[89]\d{10})(?!\d)/); if (m) gtin = m[1]; } catch {} }
  return { title, brand, gtin, gtins: [gtin].filter(Boolean), mpn: cur.mpn || null, codes, titleCodes, urlCodes, price: cur.price || null, currency: cur.currency || null };
}

// What kind of product it is, so we only ask shops that sell it.
const CMP_CATS = [
  ["books", /\b(paperback|hardcover|hardback|novel|isbn|book)\b/],
  ["liquor", /\b(whisk(?:e)?y|gin|vodka|wine|brandy|rum|beer|cider|champagne|tequila|liqueur|bourbon|cognac|sherry|port|merlot|shiraz|pinotage|chardonnay|sauvignon|cabernet)\b/],
  ["computer", /\b(laptop|notebook|chromebook|macbook|ssd|nvme|hdd|ddr\d|ram|graphics card|gpu|rtx|gtx|radeon|ryzen|intel core|motherboard|monitor|keyboard|mouse|router|mesh|printer|ink|toner|flash drive|memory card|micro ?sd|webcam|desktop pc|gaming pc|power supply|psu|cpu cooler|nas|ups)\b/],
  ["electronics", /\b(phone|iphone|smartphone|galaxy|pixel|tablet|ipad|airpods|ear ?buds|earphones|headphones|headset|speaker|soundbar|tv|television|oled|qled|ps5|ps4|xbox|nintendo|switch 2|console|smart ?watch|watch|apple watch|fitness tracker|camera|gopro|drone|kindle|power ?bank|charger|bluetooth|projector|e-?reader|tracker|airtag|homepod|echo|chromecast|fire tv)\b/],
  ["appliances", /\b(air ?fryer|fryer|kettle|toaster|microwave|fridge|refrigerator|freezer|washing machine|washer|tumble dryer|dishwasher|vacuum|blender|mixer|food processor|coffee machine|espresso|nespresso|iron|steamer|heater|fan|air ?con(?:ditioner)?|stove|oven|hob|juicer|slow cooker|pressure cooker|multi ?cooker|hair ?dryer|straightener|shaver|trimmer|toothbrush|purifier|dehumidifier|humidifier)\b/],
  ["toys", /\b(lego|toy|toys|doll|barbie|hot wheels|puzzle|board game|nerf|playset|action figure|plush|duplo|playmobil|ride[- ]on|scooter|rc car|remote control car|beyblade|pokemon cards?)\b/],
  ["baby", /\b(pram|stroller|car seat|nappy|nappies|diaper|baby|infant formula|feeding bottle|pacifier|dummy|cot|camping cot|baby monitor)\b/],
  ["fashion", /\b(shoes?|sneakers?|trainers?|boots?|sandals?|slides?|slippers?|heels|loafers?|t-?shirt|tee|shirt|jeans|dress|jacket|hoodie|sweater|jumper|shorts|socks|cap|beanie|tights|leggings|bra|briefs|boxers|trousers|pants|skirt|blazer|coat|tracksuit|joggers|backpack|handbag|wallet|sunglasses|air force|air max|jordan|dunk|yeezy|ultraboost|samba|gazelle|stan smith|chuck taylor|old skool|gel[- ]\w+)\b/],
  ["beauty", /\b(perfume|eau de|edp|edt|parfum|cologne|fragrance|moisturi[sz]er|serum|cleanser|toner|sunscreen|spf|lipstick|mascara|foundation|concealer|shampoo|conditioner|skincare|cerave|la roche|the ordinary|nivea|body lotion|face wash|hair oil|nail polish)\b/],
  ["home", /\b(duvet|pillow|towel|bedding|sheet set|cookware|frying pan|pot set|knife|cutlery|glassware|mug|dinner set|curtain|rug|lamp|mattress|bed|sofa|chair|table|storage|organiser|candle|cushion|braai|gas braai|cooler box)\b/],
];
function cmpCategory(id) {
  const t = cmpNorm(id.title);
  if (id.gtin && /^97[89]\d{10}$/.test(id.gtin)) return "books";
  for (const [cat, re] of CMP_CATS) if (re.test(t)) return cat;
  return null;
}

// Which shops to search for this product (same currency, not the shop it came from).
function cmpPlan(id, sourceHost, currency) {
  const cat = cmpCategory(id), from = cmpShopForHost(sourceHost);
  const shops = [], skipped = [];
  for (const s of CMP_SHOPS) {
    if (from && s.id === from.id) continue;
    if (s.off) continue;
    if (s.cur !== currency) continue;
    if (s.brands && !(id.brand && s.brands.includes(id.brand))) { skipped.push({ id: s.id, name: s.name, why: "brand" }); continue; }
    const sells = s.sells.includes("*") || (cat ? s.sells.includes(cat) : !s.sells.every((x) => ["books", "liquor", "baby"].includes(x)));
    if (!sells) { skipped.push({ id: s.id, name: s.name, why: "category" }); continue; }
    shops.push({ id: s.id, name: s.name });
  }
  return { category: cat, shops, skipped };
}

// Search words: brand + the words that name the product (no colours, no filler), at most 7 words.
function cmpQuery(id) {
  const words = [];
  const brand = id.brand && !cmpNorm(id.title).includes(id.brand) ? id.brand : null;
  if (brand) words.push(brand);
  for (const t of cmpNorm(id.title).replace(/[()\[\]|,:;!?*"]/g, " ").split(/[\s/]+/)) {
    const c = t.replace(/^[^a-z0-9]+|[^a-z0-9+]+$/g, "");
    if (!c || CMP_STOP.has(c) || c === "-" || c === "+" || (/^[a-z]$/.test(c) && c !== "x") || /^\d+(pcs|pieces|pack|pk)$/.test(c)) continue;
    if (CMP_COLOUR_SET.has(c) && words.length >= 2) continue;
    if (words.includes(c)) continue;
    words.push(c);
    if (words.length >= 7) break;
  }
  return words.join(" ");
}

// ---------- matching ----------
// Returns { level: "barcode" | "model" | "name", code? } or { level: null, why }.
function cmpMatch(src, cand, opts = {}) {
  const sg = new Set(src.gtins || []), cg = new Set((cand.gtins || []).map(cmpGtin).filter(Boolean));
  const gtinSame = [...cg].some((g) => sg.has(g));
  const cTitle = String(cand.title || "");
  const sb = src.brand, cb = cmpBrand(cand.brand);
  const sn = cmpNorm(src.title), cn = cmpNorm(cTitle);
  if (gtinSame) return { level: "barcode" };
  // both have barcodes and they differ: a different product or variant
  if (sg.size && cg.size) return { level: null, why: "different barcode" };
  const brandInName = sb && (cmpHasWord(cn, sb) || cmpHasWord(cTitle.toLowerCase(), sb) || sb.split(" ").some((w) => w.length >= 3 && (cmpHasWord(cn, w) || cmpHasWord(cTitle.toLowerCase(), w))));
  if (sb && cb && sb !== cb && !cb.includes(sb) && !sb.includes(cb) && !brandInName) return { level: null, why: "different brand" };
  if (sb && !cb && !brandInName) return { level: null, why: "brand not in name" };
  if (CMP_ACCESSORY.test(cn) && !CMP_ACCESSORY.test(sn)) return { level: null, why: "accessory" };
  if (CMP_CONDITION.test(cn) && !CMP_CONDITION.test(sn)) return { level: null, why: "used, refurbished or imported" };
  if (CMP_BUNDLE.test(cTitle) && !CMP_BUNDLE.test(src.title)) return { level: null, why: "bundle" };
  if (!setEq(cmpEditions(src.title), cmpEditions(cTitle))) return { level: null, why: "different edition" };
  const A = cmpAttrs(src.title), B = cmpAttrs(cTitle);
  for (const k of ["storage", "inch", "ml", "g", "pack", "year", "gender"]) if (A[k].size && B[k].size && !setEq(A[k], B[k])) return { level: null, why: "different " + k };
  if (!A.inch.size && !B.inch.size && A.cm.size && B.cm.size && !setEq(A.cm, B.cm)) return { level: null, why: "different size" };
  if (A.colour.size && B.colour.size && !overlap(A.colour, B.colour)) return { level: null, why: "different colour" };
  const strong = (s) => new Set([...s].filter((x) => CMP_VARIANT_STRONG.has(x)));
  if (!setEq(strong(A.variant), strong(B.variant))) return { level: null, why: "different variant" };
  const price = cand.price, sp = src.price;
  const ratio = price && sp ? price / sp : 1;
  const sCodes = src.codes.concat(src.urlCodes || []), cCodes = cmpCodes(cTitle + " " + (cand.mpn || "") + " " + (cand.codeText || ""), cb || sb);
  const code = cmpCodesMatch(sCodes, cCodes);
  if (code) {
    if (ratio < 0.33 || ratio > 3) return { level: null, why: "price far off" };
    // the same model code but a different numbered model (e.g. 55 vs 65 inch in one code family) is caught above
    return { level: "model", code };
  }
  // Model codes on both sides that do not match: a different model.
  // Model codes of the same kind on both sides that do not match: a different model. (Codes of different kinds,
  // such as Apple's A3287 and part number MYED3, say nothing about each other.)
  const cTitleCodes = cmpCodes(cTitle + " " + (cand.mpn || ""), cb || sb);
  if (cmpCodesConflict(src.codes, cTitleCodes)) return { level: null, why: "different model number" };
  if (opts.noNameMatch) return { level: null, why: "needs barcode or model number" };
  // Name and specs: every distinctive word and number of the source is in the candidate, and the candidate has
  // no extra numbers or variant words. Not used when the source title names a model number the candidate lacks.
  if ((src.titleCodes || src.codes).length) return { level: null, why: "model number missing" };
  if (!sb) return { level: null, why: "no brand" };
  if (!setEq(A.variant, B.variant)) return { level: null, why: "different variant" };
  if (!setEq(A.nums, B.nums)) return { level: null, why: "different numbers" };
  if (A.watt.size && B.watt.size && !setEq(A.watt, B.watt)) return { level: null, why: "different power" };
  for (const k of ["storage", "inch", "ml", "g"]) if (A[k].size && !B[k].size) return { level: null, why: "missing spec" };
  // the other shop names a size this page does not (a page with several sizes): we can't tell which size this price is for
  for (const k of ["storage", "ml", "g"]) if (B[k].size && !A[k].size) return { level: null, why: "size not on this page" };
  const isCode = (w) => /\d/.test(w) && /[a-z]/.test(w) && w.length >= 5;
  const core = [...A.words].filter((w) => w !== sb && !sb.split(" ").includes(w) && !CMP_GENERIC.has(w) && !isCode(w));
  // a product line named by a variant word and a number (JBL Flip 7) is enough; otherwise it needs a name word
  if (!core.length && !(A.variant.size && A.nums.size)) return { level: null, why: "name too short" };
  const missing = core.filter((w) => !B.words.has(w) && !cmpHasWord(cn, w));
  if (missing.length) return { level: null, why: "missing words: " + missing.slice(0, 3).join(", ") };
  // the candidate may add plain describing words, but not more than a few
  const extra = [...B.words].filter((w) => !A.words.has(w) && !cmpHasWord(sn, w) && w !== cb && !(cb && cb.split(" ").includes(w)) && !CMP_GENERIC.has(w) && !isCode(w));
  if (extra.length > 6) return { level: null, why: "too many other words" };
  const specs = A.storage.size + A.inch.size + A.ml.size + A.g.size + A.nums.size;
  if (!specs && core.length < 2 && !A.variant.size) return { level: null, why: "name too general" };
  if (ratio < 0.5 || ratio > 2) return { level: null, why: "price far off" };
  return { level: "name" };
}
const CMP_RANK = { barcode: 3, model: 2, name: 1 };
const cmpShape = (c) => c.replace(/[a-z]/g, "a").replace(/\d/g, "9");
function cmpCodesConflict(a, b) {
  if (!a.length || !b.length) return false;
  if (cmpCodesMatch(a, b)) return false;
  // conflict only between codes of the same kind: same letter/digit pattern, or the same first two characters
  return a.some((x) => b.some((y) => cmpShape(x) === cmpShape(y) || (x.slice(0, 2) === y.slice(0, 2) && Math.abs(x.length - y.length) <= 3)));
}
function cmpHasWord(text, w) { const e = String(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); return new RegExp("(^|[^a-z0-9])" + e + "($|[^a-z0-9])").test(text); }

// ---------- shop searches ----------
async function cmpFetch(url, { accept = "application/json", timeout = 10000, method = "GET", body, headers = {} } = {}) {
  const u = new URL(url);
  const r = await fetch(u.href, { method, body, headers: { "user-agent": CMP_UA, accept, "accept-language": "en-ZA,en-GB;q=0.9,en;q=0.8", ...headers }, redirect: "manual", signal: AbortSignal.timeout(timeout), cf: { cacheTtl: 600, cacheEverything: method === "GET" } });
  if ([301, 302, 303, 307, 308].includes(r.status)) {
    // follow one redirect, only within the same shop
    const loc = r.headers.get("location"); await r.body?.cancel();
    const next = loc && new URL(loc, u);
    if (!next || stripWww(next.hostname) !== stripWww(u.hostname)) throw new CmpError("redirected", "error");
    return cmpFetch(next.href, { accept, timeout, method, body, headers });
  }
  if (r.status === 403 || r.status === 429 || r.status === 503) { await r.body?.cancel(); throw new CmpError("HTTP " + r.status, "blocked"); }
  if (!r.ok) { await r.body?.cancel(); throw new CmpError("HTTP " + r.status, "error"); }
  return r;
}
class CmpError extends Error { constructor(m, kind) { super(m); this.kind = kind; } }
async function cmpJson(url, opts) { const r = await cmpFetch(url, opts); const t = await readLimitedText(r); try { return JSON.parse(t); } catch { throw new CmpError("not JSON", "error"); } }
// Shopify shops can price for the visitor's country (Shopify Markets: another currency, or without the
// home country's VAT). Ask for the shop's home country and currency, and refuse an answer the shop says
// it priced in another currency.
const CMP_COUNTRY = { GBP: "GB", ZAR: "ZA" };
async function cmpShopifyJson(shop, url) {
  const r = await cmpFetch(url + (url.includes("?") ? "&" : "?") + (CMP_COUNTRY[shop.cur] ? "country=" + CMP_COUNTRY[shop.cur] + "&" : "") + "currency=" + shop.cur);
  const cc = (String(r.headers.get("set-cookie") || "").match(/cart_currency=([A-Z]{3})/) || [])[1];
  const t = await readLimitedText(r);
  if (cc && cc !== shop.cur) throw new CmpError("prices in another currency", "error");
  try { return JSON.parse(t); } catch { throw new CmpError("not JSON", "error"); }
}
async function cmpHtml(url, opts) { const r = await cmpFetch(url, { accept: "text/html,application/xhtml+xml", ...opts }); const t = await readLimitedText(r, true); if (detectBlock(200, t)) throw new CmpError("bot check", "blocked"); return t; }
const absUrl = (base, u) => { try { const x = new URL(u, base); x.hash = ""; return x.href; } catch { return null; } };

// Each returns a list of candidates: { title, brand, price, was, url, in_stock, gtins, mpn, codeText }
const CMP_SEARCH = {
  async takealot(shop, q) {
    const d = await cmpJson(`https://api.takealot.com/rest/v-1-11-0/searches/products?qsearch=${encodeURIComponent(q)}`);
    const res = (((d.sections || {}).products || {}).results) || [];
    return res.slice(0, 12).map((x) => x.product_views || {}).map((v) => {
      const prices = ((v.buybox_summary || {}).prices || []).map(parsePrice).filter(Boolean);
      const st = v.stock_availability_summary || {};
      return { id: v.core && v.core.id, title: v.core && v.core.title, brand: v.core && v.core.brand, url: v.core && v.core.id ? `https://www.takealot.com/${v.core.slug || "x"}/PLID${v.core.id}` : null,
        price: prices.length === 1 ? prices[0] : null, range: prices.length > 1, was: parsePrice((v.buybox_summary || {}).listing_price) || null,
        in_stock: st.is_in_stock !== false || !!st.is_leadtime, gtins: [] };
    }).filter((x) => x.id && x.title);
  },
  async loot(shop, q) {
    const html = await cmpHtml(`${shop.base}/search?cat=b&terms=${encodeURIComponent(q)}`, { timeout: 15000 });
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new CmpError("no data", "error");
    const d = JSON.parse(m[1]);
    const ps = (((((d.props || {}).pageProps || {}).initialState || {}).searchResult || {}).products) || [];
    return ps.slice(0, 12).map((p) => p.productInfo || {}).map((p) => ({ title: p.fullTitle || p.name, brand: p.brand && p.brand.label, price: parsePrice(p.price), was: parsePrice(p.listPrice) || null,
      url: p.shareLink && p.shareLink.uri ? absUrl(shop.base, p.shareLink.uri) : null, in_stock: p.available !== false, gtins: [p.barcode].filter(Boolean) })).filter((x) => x.title && x.url && x.price);
  },
  async evetech(shop, q) {
    const html = (await cmpHtml(`${shop.base}/search?query=${encodeURIComponent(q)}`)).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    const out = [], seen = new Set();
    const re = /"objectID":"C\d+"/g; let m;
    while ((m = re.exec(html)) && out.length < 12) {
      const txt = enclosingObject(html, m.index); if (!txt) continue;
      let o; try { o = JSON.parse(txt); } catch { continue; }
      if (!o.Name || !o.Url || seen.has(o.Url)) continue; seen.add(o.Url);
      if (!absUrl(shop.base, o.Url) || stripWww(new URL(absUrl(shop.base, o.Url)).hostname) !== "evetech.co.za") continue;
      out.push({ title: o.Name, brand: null, price: parsePrice(o.PriceIncVat), url: absUrl(shop.base, o.Url), in_stock: /in stock/i.test(String(o.Stock || "")), gtins: [], mpn: o.ItemCode || null });
    }
    return out;
  },
  async shopify(shop, q) {
    const d = await cmpShopifyJson(shop, `${shop.base}/search/suggest.json?q=${encodeURIComponent(q)}&resources%5Btype%5D=product&resources%5Blimit%5D=10&resources%5Boptions%5D%5Bunavailable_products%5D=last`);
    const ps = ((((d.resources || {}).results) || {}).products) || [];
    return ps.map((p) => ({ title: p.title, brand: p.vendor, price: parsePrice(p.price), was: parsePrice(p.compare_at_price_min) > parsePrice(p.price) ? parsePrice(p.compare_at_price_min) : null, url: p.url ? absUrl(shop.base, String(p.url).split("?")[0]) : null,
      range: !!(p.price_min && p.price_max && parsePrice(p.price_min) !== parsePrice(p.price_max)),
      in_stock: p.available !== false, gtins: /^\d{8,14}$/.test(String(p.handle || "")) ? [p.handle] : [], handle: p.handle, codeText: p.handle ? p.handle.replace(/-/g, " ") : "" })).filter((x) => x.title && x.url && x.price);
  },
  async magento(shop, q) {
    const fields = shop.gql === "special"
      ? "name sku url_key stock_status special_price price { regularPrice { amount { value currency } } }"
      : "name sku url_key url_suffix stock_status price_range { minimum_price { final_price { value currency } regular_price { value } } }";
    const query = `{ products(search: ${JSON.stringify(q)}, pageSize: 12) { items { ${fields} } } }`;
    const d = await cmpJson(`${shop.base}/graphql?query=${encodeURIComponent(query)}`, { headers: { "content-type": "application/json" } });
    const items = (((d.data || {}).products || {}).items) || [];
    return items.filter(Boolean).map((p) => {
      let price, was = null, cur;
      if (shop.gql === "special") { const reg = (((p.price || {}).regularPrice || {}).amount) || {}; cur = reg.currency; price = parsePrice(p.special_price) || parsePrice(reg.value); if (p.special_price && parsePrice(reg.value) > price) was = parsePrice(reg.value); }
      else { const mp = ((p.price_range || {}).minimum_price) || {}; price = parsePrice((mp.final_price || {}).value); cur = (mp.final_price || {}).currency; const rg = parsePrice((mp.regular_price || {}).value); if (rg && price && rg > price) was = rg; }
      if (cur && cur !== shop.cur) price = null;
      return { title: decodeEntities(p.name || "").trim(), brand: null, price, was, url: p.url_key ? `${shop.base}/${p.url_key}${p.url_suffix || ""}` : null, in_stock: p.stock_status !== "OUT_OF_STOCK", gtins: [], codeText: (p.url_key || "").replace(/-/g, " ") };
    }).filter((x) => x.title && x.url && x.price);
  },
  async vtex(shop, q) {
    const d = await cmpJson(`${shop.base}/api/catalog_system/pub/products/search?ft=${encodeURIComponent(q)}&_from=0&_to=11`);
    return (Array.isArray(d) ? d : []).map((p) => {
      let price = null, was = null, avail = false; const gtins = [];
      for (const it of p.items || []) {
        if (it.ean) gtins.push(it.ean);
        for (const s of it.sellers || []) { const o = s.commertialOffer || {}; const pr = parsePrice(o.Price); if (pr && o.AvailableQuantity > 0) { avail = true; if (!price || pr < price) { price = pr; was = parsePrice(o.ListPrice) > pr ? parsePrice(o.ListPrice) : null; } } }
      }
      if (!price) for (const it of p.items || []) for (const s of it.sellers || []) { const pr = parsePrice((s.commertialOffer || {}).Price); if (pr && (!price || pr < price)) price = pr; }
      return { title: p.productName, brand: p.brand, price, was, url: p.link && absUrl(shop.base, p.link), in_stock: avail, gtins };
    }).filter((x) => x.title && x.url && x.price);
  },
  async ldlist(shop, q) {
    const html = await cmpHtml(shop.search.replace("{q}", encodeURIComponent(q)));
    const out = [];
    const re = /<script[^>]+type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi; let m;
    while ((m = re.exec(html))) {
      let d; try { d = JSON.parse(m[1].trim()); } catch { continue; }
      for (const node of Array.isArray(d) ? d : [d]) {
        if (!node || !typeHas(node, ["ItemList"])) continue;
        for (const el of (node.itemListElement || []).slice(0, 16)) {
          const it = el.item || el; if (!it || !it.name) continue;
          const o = Array.isArray(it.offers) ? it.offers[0] : it.offers || {};
          if (o.priceCurrency && o.priceCurrency !== shop.cur) continue;
          const g = it.gtin13 || it.gtin || it.gtin12 || it.gtin14 || (/^\d{12,14}$/.test(String(it.sku || "")) ? it.sku : null);
          out.push({ title: decodeEntities(it.name), brand: typeof it.brand === "object" ? it.brand && it.brand.name : it.brand, price: parsePrice(o.price), url: absUrl(shop.search, it.url || o.url), in_stock: !/OutOfStock|SoldOut/i.test(String(o.availability || "")), gtins: g ? [g] : [], mpn: it.mpn || null, codeText: String(it.url || "").replace(/[-_/]/g, " ") });
        }
      }
    }
    return out.filter((x) => x.title && x.url && x.price);
  },
};
// Extra reads that give a candidate's barcode (and the exact price) before it is accepted.
const CMP_DETAIL = {
  async takealot(shop, c) { const d = await takealotApi(c.id); if (d.error) return null; return { gtins: [d.gtin].filter(Boolean), price: d.price, was: d.was || null, title: d.title, brand: d.brand }; },
  async shopify(shop, c) {
    if (!c.handle) return null;
    const d = await cmpShopifyJson(shop, `${shop.base}/products/${encodeURIComponent(c.handle)}.js`);
    const vs = Array.isArray(d.variants) ? d.variants : [];
    return { gtins: vs.map((v) => v.barcode).filter(Boolean), mpn: vs.length === 1 ? vs[0].sku || null : null, single: vs.length === 1,
      variants: vs.map((v) => ({ title: v.title === "Default Title" ? "" : String(v.title || ""), price: typeof v.price === "number" ? Math.round(v.price) / 100 : parsePrice(v.price), barcode: v.barcode || null, sku: v.sku || null, available: v.available !== false })) };
  },
};

// Use a product's detail read: its barcode(s), exact price, and for shops with options (size, storage, colour)
// the one option that matches the checked product.
function cmpApplyDetail(id, c, d) {
  c.detailed = true;
  if (d.variants && d.variants.length) {
    const A = cmpAttrs(id.title);
    let pick = null;
    if (id.gtin) pick = d.variants.find((v) => cmpGtin(v.barcode) === id.gtin) || null;
    if (!pick && d.variants.length > 1) {
      const fits = d.variants.filter((v) => {
        const B = cmpAttrs(v.title);
        for (const k of ["storage", "inch", "ml", "g", "pack"]) if (A[k].size && !(B[k].size && setEq(A[k], B[k]))) return false;
        if (A.colour.size && B.colour.size && !overlap(A.colour, B.colour)) return false;
        return true;
      });
      if (fits.length === 1) pick = fits[0];
      else if (fits.length > 1 && fits.every((v) => v.price === fits[0].price)) { c.price = fits[0].price; c.range = false; }
    }
    if (!pick && d.variants.length === 1) pick = d.variants[0];
    if (pick) {
      if (pick.title && !(" " + cmpNorm(c.title) + " ").includes(" " + cmpNorm(pick.title) + " ")) c.title = c.title + " " + pick.title;
      if (pick.price) c.price = pick.price;
      c.gtins = [pick.barcode].filter(Boolean);
      if (pick.sku && !c.mpn) c.mpn = pick.sku;
      c.in_stock = pick.available;
      c.range = false;
    } else if (!c.range) c.gtins = d.gtins || [];
    return;
  }
  if (d.gtins) c.gtins = d.gtins;
  if (d.price) { c.price = d.price; c.range = false; }
  if (d.was) c.was = d.was;
  if (d.mpn && !c.mpn) c.mpn = d.mpn;
}

// Search one shop for one product: up to CMP_MAX_SEARCHES searches, strict matching, best match only.
// robots.txt for the compare search (RFC 9309; our token, else "*"). Cached a day; 4xx = no rules; 5xx/no answer = not now.
const CMP_ROBOTS_TOKEN = "DealOrDud-PriceCompare";
function cmpRobotsTargets(shop) {
  const ex = { takealot: ["https://api.takealot.com", "/rest/v-1-11-0/searches/products?qsearch=x"], loot: [shop.base, "/search?cat=b&terms=x"], evetech: [shop.base, "/search?query=x"],
    shopify: [shop.base, "/search/suggest.json?q=x&resources%5Btype%5D=product"], magento: [shop.base, "/graphql?query=x"], vtex: [shop.base, "/api/catalog_system/pub/products/search?ft=x"] }[shop.kind];
  const out = ex ? [ex] : [];
  if (shop.kind === "ldlist" && shop.search) { const u = new URL(shop.search.replace("{q}", "x")); out.push([u.origin, u.pathname + u.search]); }
  if (shop.kind === "shopify") out.push([shop.base, "/products/x.js"]);
  return out;
}
async function cmpRobotsRules(env, origin) {
  const key = "robots-cmp:" + origin;
  let v = await cacheGet(env, key);
  if (!v) {
    try {
      const r = await fetch(origin + "/robots.txt", { headers: { "user-agent": CMP_UA, accept: "text/plain" }, redirect: "follow", signal: AbortSignal.timeout(6000) });
      if (r.status >= 500) { await r.body?.cancel(); v = { retry: true }; }
      else if (!r.ok) { await r.body?.cancel(); v = { rules: [] }; }
      else v = { rules: parseRobots(await readLimitedText(r, true), CMP_ROBOTS_TOKEN) };
    } catch { v = { retry: true }; }
    await cachePut(env, key, v, v.retry ? 3600e3 : 864e5);
  }
  return v;
}
async function cmpRobotsOk(env, shop) {
  for (const [origin, path] of cmpRobotsTargets(shop)) {
    const v = await cmpRobotsRules(env, origin);
    if (v.retry) return "retry";
    if (!robotsAllows(v.rules, path)) return false;
  }
  return true;
}

async function cmpSearchShop(env, shop, id) {
  const rb = await cmpRobotsOk(env, shop);
  if (rb === false) return { status: "robots", message: "robots.txt asks tools not to use this search" };
  if (rb === "retry") return { status: "error", message: "robots.txt not available" };
  const queries = [];
  if (id.gtin && ["takealot", "shopify", "loot", "magento", "vtex"].includes(shop.kind)) queries.push(id.gtin);
  const code = id.codes.find((c) => !c.startsWith("lego")) || null;
  if (code && id.mpn) queries.push(String(id.mpn).slice(0, 40));
  else if (code) queries.push((id.brand ? id.brand + " " : "") + code);
  queries.push(cmpQuery(id));
  const fashion = cmpCategory(id) === "fashion";
  let best = null, searched = 0, details = 0, lastErr = null, candidates = 0;
  const tried = new Set();
  for (const q of queries) {
    if (!q || tried.has(q) || searched >= CMP_MAX_SEARCHES) continue;
    tried.add(q);
    let list;
    const key = `cmps-v1:${shop.id}:${q.toLowerCase()}`;
    list = await cacheGet(env, key);
    if (!list) {
      if (await cmpShopBusy(env, shop.id)) { lastErr = new CmpError("busy", "busy"); break; }
      searched++;
      try { list = await CMP_SEARCH[shop.kind](shop, q); await cachePut(env, key, list, CMP_SEARCH_TTL); }
      catch (e) { lastErr = e instanceof CmpError ? e : new CmpError(/timed? ?out|abort/i.test(String(e)) ? "timeout" : "failed", "error"); continue; }
    }
    candidates += list.length;
    for (const c of list) {
      let m = cmpMatch(id, c, { noNameMatch: fashion });
      // A plausible candidate without a barcode: read its details once to confirm (or rule out) the barcode.
      const detail = CMP_DETAIL[shop.kind];
      // (matched by model or name: confirm by barcode or get the exact price; found by a barcode search: check it)
      const byBarcodeSearch = q === id.gtin && list.indexOf(c) < 2;
      const soft = !m.level && (m.why === "missing spec" || c.range);
      const worth = detail && details < CMP_MAX_DETAILS && !c.detailed && ((!(c.gtins || []).length && ((m.level && (id.gtin || c.range)) || byBarcodeSearch)) || (soft && !/brand|accessory|bundle|used|variant|model/.test(m.why || "")));
      if (worth) {
        details++;
        try {
          const d = await detail(shop, c);
          if (d) { cmpApplyDetail(id, c, d); m = cmpMatch(id, c, { noNameMatch: fashion }); }
        } catch {}
      }
      if (!m.level || !c.price || c.range) continue;
      const r = { shop: shop.id, name: shop.name, title: c.title, price: c.price, was: c.was && c.was > c.price ? c.was : null, currency: shop.cur, url: c.url, in_stock: c.in_stock !== false, level: m.level, code: m.code || null };
      if (!best || CMP_RANK[r.level] > CMP_RANK[best.level] || (CMP_RANK[r.level] === CMP_RANK[best.level] && (r.in_stock && !best.in_stock || (r.in_stock === best.in_stock && r.price < best.price)))) best = r;
    }
    if (best && best.level !== "name") break;
  }
  if (best) return { status: "match", match: best, candidates };
  if (lastErr && !candidates) return { status: lastErr.kind === "blocked" ? "blocked" : lastErr.kind === "busy" ? "busy" : "error", message: lastErr.message };
  return { status: "none", candidates };
}

// Rate Limiting API on Cloudflare, D1 table `rl` without it (see overLimit in worker.js).
const cmpShopBusy = (env, shopId) => overLimit(env, "cmpshop", shopId, CMP_SHOP_PER_MIN);
const cmpIpLimited = (env, ip) => overLimit(env, "cmp", ip, CMP_PER_IP_PER_MIN);

// The identity of a checked product (cached). For Shopify shops the product's own .js gives the barcode.
async function cmpIdentityFor(env, canon) {
  const key = "cmpid-" + CMP_VER + ":" + canon;
  const c = await cacheGet(env, key);
  if (c) return c;
  const cur = await latestCurrent(env, canon);
  if (!cur || cur.status !== "ok" || !cur.title || !cur.price) return null;
  const id = await cmpIdentityFromCurrent(cur, canon);
  await cachePut(env, key, id, CMP_TTL);
  return id;
}
async function cmpIdentityFromCurrent(cur, canon) {
  const host = new URL(canon).hostname.toLowerCase();
  const currency = cur.currency || tldCurrency(host);
  const extra = { ...cur };
  const from = cmpShopForHost(host);
  if (from && from.kind === "shopify" && !cur.gtin) {
    const h = new URL(canon).pathname.match(/\/products\/([^/?#]+)/);
    if (h) { try { const d = await CMP_DETAIL.shopify(from, { handle: decodeURIComponent(h[1]) }); if (d && d.single) { extra.gtin = d.gtins[0] || null; extra.mpn = extra.mpn || d.mpn; } } catch {} }
  }
  const id = cmpIdentity(extra, canon);
  id.currency = currency;
  return id;
}

async function cmpGuard(req, env) {
  const canon = new URL(req.url).searchParams.get("url") || "";
  const tr = await env.DB.prepare("SELECT url FROM tracked WHERE url = ?").bind(canon).first();
  if (!tr) return { error: json({ error: "Check the product first." }, 403) };
  return { canon };
}

// GET /api/compare?url=  -> the plan, plus answers already cached
async function apiCompare(req, env) {
  const g = await cmpGuard(req, env); if (g.error) return g.error;
  const ip = req.headers.get("cf-connecting-ip") || "0";
  if (await cmpIpLimited(env, ip)) return json({ error: "rate limited" }, 429);
  const id = await cmpIdentityFor(env, g.canon);
  if (!id) return json({ product: null, shops: [], skipped: [], results: {}, reason: "no price" });
  const host = new URL(g.canon).hostname;
  const plan = cmpPlan(id, host, id.currency);
  const results = {};
  if (plan.shops.length) {
    const keys = plan.shops.map((s) => "cmp-" + CMP_VER + ":" + s.id + ":" + g.canon);
    const rows = await env.DB.prepare(`SELECT k, v, exp FROM cache WHERE k IN (${keys.map(() => "?").join(",")})`).bind(...keys).all();
    for (const r of rows.results || []) if (r.exp > now()) { try { const v = JSON.parse(r.v); results[v.shop] = v; } catch {} }
  }
  return json({ product: { title: id.title, brand: id.brand, gtin: id.gtin, codes: id.codes, currency: id.currency, category: plan.category }, shops: plan.shops, skipped: plan.skipped, results, reason: plan.shops.length ? null : "no shops" });
}

// GET /api/compare/shop?url=&shop=  -> one shop's answer
async function apiCompareShop(req, env, ctx) {
  const g = await cmpGuard(req, env); if (g.error) return g.error;
  const shop = cmpShopById(new URL(req.url).searchParams.get("shop") || "");
  if (!shop) return json({ error: "unknown shop" }, 400);
  const key = "cmp-" + CMP_VER + ":" + shop.id + ":" + g.canon;
  const cached = await cacheGet(env, key);
  if (cached) return json({ ...cached, cached: true });
  const ip = req.headers.get("cf-connecting-ip") || "0";
  if (await cmpIpLimited(env, ip)) return json({ shop: shop.id, name: shop.name, status: "busy" }, 429);
  const id = await cmpIdentityFor(env, g.canon);
  if (!id) return json({ shop: shop.id, name: shop.name, status: "none" });
  const plan = cmpPlan(id, new URL(g.canon).hostname, id.currency);
  if (!plan.shops.some((s) => s.id === shop.id)) return json({ shop: shop.id, name: shop.name, status: "skipped" });
  let r;
  try { r = await cmpSearchShop(env, shop, id); } catch (e) { r = { status: "error", message: "failed" }; }
  const out = { shop: shop.id, name: shop.name, status: r.status, match: r.match || null, checked_at: now(), message: r.status === "match" || r.status === "none" ? null : r.message || null };
  await cachePut(env, key, out, ["match", "none", "robots"].includes(r.status) ? CMP_TTL : CMP_ERR_TTL);
  if (r.match) {
    const save = cmpSaveHistory(env, r.match).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(save); else await save;
  }
  return json(out);
}

// A matched price is a real price at that shop: save it into that page's history (and keep the page
// on the daily re-check list when we are sure it is the same product).
async function cmpSaveHistory(env, m) {
  const v = validateUrl(m.url); if (v.error) return;
  const ci = canonicalize(v.url);
  const cur = { status: "ok", checked_at: now(), price: m.price, was: m.was || null, currency: m.currency, source: "compare-" + m.shop, title: m.title };
  await recordCheck(env, ci.canon, cur);
  if (m.level !== "name") await track(env, ci.canon, v.url.href, cur);
}

// Old pages (loaded before this version) still call /api/others: answer with the cached matches.
async function apiOthersCompat(req, env) {
  const g = await cmpGuard(req, env); if (g.error) return g.error;
  const rows = await env.DB.prepare("SELECT v, exp FROM cache WHERE k LIKE ? LIMIT 40").bind("cmp-" + CMP_VER + ":%:" + g.canon).all();
  const matches = [];
  for (const r of rows.results || []) if (r.exp > now()) { try { const v = JSON.parse(r.v); if (v.match) matches.push({ shop: v.name, title: v.match.title, price: v.match.price, currency: v.match.currency, url: v.match.url, match: v.match.level === "barcode" ? "barcode" : v.match.level === "model" ? "model number" : "name and specs" }); } catch {} }
  return json({ matches, searched: [] });
}
