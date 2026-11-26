// ---------- Search: find a product by its name at the shops we can search ----------
// Joined with worker.js and compare.js at build time (build.py), so it uses the compare shop searches.
//
// How it works
//   1. /api/search?q=&c=ZA|GB         checks the words and gives the list of shops to search (same country,
//                                     shops that sell this kind of product), plus the shops we can't search.
//   2. /api/search/shop?q=&c=&shop=   searches ONE shop with its own public site search (CMP_SEARCH), and
//                                     keeps only in-stock products whose name has every word of the search.
//      The page calls this once per shop (a few at a time), so a slow shop never blocks the fast ones.
//   3. Each shop's answer is kept for SRCH_TTL in the Cloudflare cache (Cache API: no D1 writes).
//      robots.txt is checked for every shop (cmpRobotsOk), and the shop limits of compare apply.
// Prices are the shops' own live prices. We never add or change a price.

const SRCH_MIN = 2, SRCH_MAX = 120;      // characters in a search
const SRCH_TTL = 20 * 60;                // seconds: one shop's answer for one search
const SRCH_PER_SHOP = 8;                 // products per shop in the answer
const SRCH_MAX_SHOPS = 12;               // shops per search
const SRCH_TIMEOUT = 8000;               // ms for one shop's search (AB-43: was 14 s; a slower shop still fills the cache)
const SRCH_CC = { ZA: "ZAR", GB: "GBP", UK: "GBP" };
const SRCH_VER = "v3";               // v2: main products before accessories; v3: one-word forms, spelling fixes (AB-43)
// When we can't tell the kind of product, search the general shops and the shops that sell many kinds of things.
const SRCH_BROAD = ["electronics", "appliances", "home"];
// Words that do not need to be in a product's name.
const SRCH_SKIP = new Set(["the", "a", "an", "and", "of", "for", "with", "in", "on", "new", "buy", "cheap", "cheapest", "best", "price", "deal", "deals", "sale", "online", "sa", "uk"]);

// A link (https://…, or a domain with a path such as takealot.com/…) or a product name?
function srchIsLink(v) {
  const s = String(v || "").trim();
  if (!s) return false;
  if (/https?:\/\/\S+/i.test(s)) return true;
  if (/^(www\.)?[\w-]+(\.[\w-]+)+\/\S*/i.test(s)) return true;
  // one word with a domain ending: "takealot.com", "www.loot.co.za"
  return !/\s/.test(s) && /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|co\.za|za|co\.uk|uk|net|org|eu|de|fr|nl|ie|io|shop|store|to|co)$/i.test(s);
}

// The search words, cleaned: { q } or { error }.
function srchClean(raw) {
  const q = String(raw == null ? "" : raw).normalize("NFC").replace(/[\u0000-\u001f\u007f<>{}\\`]/g, " ").replace(/\s+/g, " ").trim();
  if (!q) return { error: "Type a product name or paste a product link." };
  if (srchIsLink(q)) return { error: "That is a link. Paste it to check its price." };
  if (q.length < SRCH_MIN) return { error: `Type at least ${SRCH_MIN} letters or numbers.` };
  if (q.length > SRCH_MAX) return { error: `Use ${SRCH_MAX} characters or fewer.` };
  if (!/[\p{L}\p{N}]/u.test(q)) return { error: "Type a product name with letters or numbers." };
  if (!srchWords(q).length) return { error: "Type a product name, for example PS5 Slim." };
  return { q };
}
// AB-43: a search with no product found goes on to the AI Shopping Assistant (once), except a bare number,
// barcode or product code ("6001234567890", "SM-S928B", "KLF03CREU"): the AI can't do more with those.
function srchAiOk(q) {
  const s = String(q || "").trim();
  if (!s || srchIsLink(s)) return false;
  if (/^[\d\s.,\-\/#]+$/.test(s)) return false;
  // one word of letters and numbers with 3 or more numbers, or letters and numbers mixed more than once ("MQD83ZM/A")
  if (!/\s/.test(s) && s.length >= 6 && /^[a-z0-9][a-z0-9\-_.\/]*$/i.test(s)) {
    const runs = s.replace(/[^a-z0-9]/gi, "").match(/[a-z]+|\d+/gi) || [];
    if ((s.match(/\d/g) || []).length >= 3 || runs.length >= 3) return false;
  }
  if (typeof asOffTopic === "function" && asOffTopic(s)) return false;
  return true;
}
// The visitor's country from Cloudflare (request.cf.country), for a search with no country: the UK or South Africa.
const srchVisitorCc = (req) => (req && req.cf && req.cf.country === "GB" ? "GB" : "ZA");
const srchCountry = (c) => { const k = String(c || "ZA").toUpperCase(); return SRCH_CC[k] ? (k === "UK" ? "GB" : k) : null; };
// AB-41: everyday short names. A search and a product name are both read with the name the shops use, so
// "coke" finds "Coca-Cola", "redbull" finds "Red Bull", "air pods" finds "AirPods" (and the other way).
// ("PlayStation 5" = "ps5" is in cmpNorm.) Words only: "coke" in "Coca-Cola" itself is not changed.
const SRCH_ALIAS = [
  [/\bcoca[\s-]*cola\b|\bcokes?\b/g, "coca cola"],
  [/\bred[\s-]*bulls?\b/g, "red bull"],
  [/\bair[\s-]+pods\b/g, "airpods"],
  [/(?<!\b(?:can|could|should|do|will|would|may|shall|did)\s)\bi[\s-]+phones?\b/g, "iphone"],
  [/\bi[\s-]+pads?\b/g, "ipad"],
  [/\bmac[\s-]+books?\b/g, "macbook"],
  [/\bplay[\s-]*station[\s-]*5\b/g, "ps5"],
];
// AB-43: words written as one word or as two ("airfryer" = "air fryer", "smart watch" = "smartwatch"). A search
// and a product name are both read as one word, so each finds the other. [pattern, one word, words for the shop]
const SRCH_COMPOUND = [
  [/\bair[\s-]*fryers?\b/g, "airfryer", "air fryer"],
  [/\bsmart[\s-]*watch(?:es)?\b/g, "smartwatch", "smartwatch"],
  [/\bsmart[\s-]*phones?\b/g, "smartphone", "smartphone"],
  [/\bpower[\s-]*banks?\b/g, "powerbank", "power bank"],
  [/\bhair[\s-]*dr[yi]ers?\b/g, "hairdryer", "hair dryer"],
  [/\bhead[\s-]*sets?\b/g, "headset", "headset"],
  [/\bhead[\s-]*phones?\b/g, "headphones", "headphones"],
  [/\bear[\s-]*buds?\b/g, "earbuds", "earbuds"],
  [/\bear[\s-]*phones?\b/g, "earphones", "earphones"],
  [/\bsound[\s-]*bars?\b/g, "soundbar", "soundbar"],
  [/\bdish[\s-]*washers?\b/g, "dishwasher", "dishwasher"],
  [/\bplay[\s-]*station\b/g, "playstation", "playstation"],
  [/\blap[\s-]+tops?\b/g, "laptop", "laptop"],
  [/\bweb[\s-]*cams?\b/g, "webcam", "webcam"],
  [/\btooth[\s-]*brush(?:es)?\b/g, "toothbrush", "toothbrush"],
  [/\bmicro[\s-]+waves?\b/g, "microwave", "microwave"],
  [/\bfoot[\s-]*balls?\b/g, "football", "football"],
  [/\bback[\s-]*packs?\b/g, "backpack", "backpack"],
  [/\bskate[\s-]*boards?\b/g, "skateboard", "skateboard"],
  [/\btread[\s-]*mills?\b/g, "treadmill", "treadmill"],
];
function srchAlias(s) {
  let t = String(s == null ? "" : s).toLowerCase().replace(/[\u2010-\u2015]/g, "-");
  for (const [re, to] of SRCH_ALIAS) t = t.replace(re, to);
  for (const [re, one] of SRCH_COMPOUND) t = t.replace(re, one);
  return t;
}
// ---------- AB-43: small spelling mistakes in a search ----------
// A search word of 5 or more letters that is not a known word, and is one letter away (one letter more, less,
// changed, or two letters in the wrong order) from exactly one known word, is read as that word:
// "samsng" -> "samsung", "iphne" -> "iphone", "garmn" -> "garmin", "hisnse" -> "hisense", "frige" -> "fridge".
// Known words are never changed ("cable" stays "cable", not "table"). Only the search is changed, never a product name.
const SRCH_KNOWN = new Set(("samsung apple iphone ipad macbook airpods imac garmin hisense philips panasonic lenovo huawei xiaomi "
  + "nokia motorola google pixel nintendo switch xbox playstation dyson bosch siemens whirlpool kelvinator smeg russell hobbs kenwood "
  + "breville delonghi nespresso krups tefal sunbeam salton logitech razer corsair steelseries hyperx asus acer dell lenovo "
  + "hewlett packard canon nikon fujifilm gopro bose sennheiser beats marshall sonos skullcandy fitbit amazfit polar coros suunto "
  + "forerunner fenix venu vivoactive instinct realme honor tecno infinix alcatel nothing toshiba sharp microsoft surface "
  + "kindle amazon chromecast roku lego barbie mattel hasbro adidas puma reebok asics salomon brooks saucony converse skechers "
  + "crocs levis weber cadac makita dewalt ryobi stanley karcher hoover morphy richards ninja instant cuisinart nutribullet "
  + "oneplus galaxy redmi seagate sandisk kingston crucial intel ryzen radeon nvidia geforce epson brother netgear linksys "
  + "anker baseus ugreen volkano defy telefunken skyworth sinotec jameson johnnie walker heineken castle hennessy "
  + "phone phones smartphone cellphone tablet tablets laptop laptops notebook computer desktop monitor monitors keyboard mouse "
  + "router printer speaker speakers soundbar headphones headset earbuds earphones charger chargers cable cables adapter battery "
  + "batteries camera cameras drone console consoles controller watch watches smartwatch tracker television screen projector "
  + "fridge fridges freezer refrigerator kettle kettles toaster microwave stove blender mixer juicer airfryer fryer fryers vacuum "
  + "cleaner washing machine washer dryer tumble dishwasher heater aircon steamer coffee espresso grinder shaver trimmer clipper "
  + "clippers toothbrush hairdryer straightener curler purifier humidifier dehumidifier mattress pillow pillows duvet towel towels "
  + "bedding couch chair chairs table tables desk curtain curtains cooker frying knife knives cutlery glass glasses braai grill "
  + "cooler bicycle helmet scooter skateboard treadmill dumbbell dumbbells weights tent tents sleeping camping backpack luggage "
  + "suitcase handbag wallet shoes sneaker sneakers trainer trainers boots sandals slippers jacket hoodie shirt shirts tshirt jeans "
  + "dress shorts short socks perfume cologne fragrance lipstick mascara shampoo conditioner sunscreen moisturiser serum diapers "
  + "nappies stroller formula puzzle games gaming books novel guitar piano drums ukulele microphone tripod lenses memory storage "
  + "drive flash graphics processor motherboard powerbank solar inverter generator torch flashlight bulbs extension plug socket "
  + "smart wireless bluetooth portable electric cordless digital analog stainless steel black white silver large small ultra "
  + "lite slim edition series model version running fitness sport sports outdoor indoor kitchen bathroom bedroom garden office "
  + "school children unisex water bottle flask house match stand stands cover covers cases charging station hdmi gold green "
  + "brown purple orange yellow pink beige grey gray cream sleep power plate plates bowls bowl spoon spoons boxes paper "
  + "bread butter cheese chicken coca cola juice drinks energy chips chocolate biscuits cereal sugar flour pasta sauce "
  + "infant toddler womens girls ladies baby kids cycling bikes ebike mountain gravel tyres tubes pedals saddle "
  + "light lights lamp lamps clock clocks frame frames mirror mirrors brush brushes razor razors blade blades oven ovens "
  + "charge sync cooking baking travel music video photo gift gifts party "
  + "airtag homepod echo ereader reader print prints inkjet laser toner office chair gamer racing wheel wheels pro max plus mini").split(" ").filter(Boolean));
// One letter away: one letter more, less or changed, or two letters next to each other in the wrong order.
function srchEd1(a, b) {
  if (a === b) return false;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0; while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}
const srchKnown = (w) => SRCH_KNOWN.has(w) || SRCH_SKIP.has(w) || (w.endsWith("s") && SRCH_KNOWN.has(w.slice(0, -1))) || (w.endsWith("es") && SRCH_KNOWN.has(w.slice(0, -2)));
const SRCH_KNOWN_LONG = [...SRCH_KNOWN].filter((w) => w.length >= 5);
// The known word for a search word with a small spelling mistake, or the word itself.
function srchFixWord(w) {
  if (w.length < 5 || !/^[a-z]+$/.test(w) || srchKnown(w)) return w;
  let hit = null;
  // a letter more or less at the end is another form of the word, not a mistake ("charge", "charger")
  for (const k of SRCH_KNOWN_LONG) if (srchEd1(w, k) && !k.startsWith(w) && !w.startsWith(k)) { if (hit && hit !== k) return w; hit = k; }
  return hit || w;
}
const srchFix = (t) => String(t).replace(/[a-z]+/g, (w) => srchFixWord(w));
// The search as we read it: short names, one-word forms, spelling fixed ("samsng airfryer" -> "samsung airfryer").
const srchRead = (q) => srchFix(srchAlias(q));
// The search words to send to a shop: the shops' own name when the search uses a short name ("coke" -> "coca cola"),
// the spelling fixed ("samsng" -> "samsung"), and the words most shops use ("airfryer" -> "air fryer").
function srchShopQ(q) {
  let a = srchRead(q);
  for (const [, one, shop] of SRCH_COMPOUND) a = a.replace(new RegExp("\\b" + one + "\\b", "g"), shop);
  a = a.replace(/\s+/g, " ").trim();
  return a === String(q).toLowerCase().replace(/\s+/g, " ").trim() ? q : a;
}
// The spelling we used instead of the search, when a word was changed ("samsung galaxy" for "samsng galaxy"), or null.
function srchFixed(q) {
  const a = srchAlias(q), b = srchFix(a);
  return a === b ? null : srchShopQ(q);
}
// The words that must be in a product's name (normalised the same way as compare: "PlayStation 5" = "ps5").
const srchWords = (q) => [...new Set(cmpWords(srchRead(q)).filter((w) => !SRCH_SKIP.has(w) && w !== "-" && w !== "+"))];
const srchKey = (q) => srchWords(q).join(" ");

// Which shops to search: same currency, not off (robots.txt or no search), shops that sell this kind of product.
function srchPlan(q, country) {
  const cur = SRCH_CC[country];
  // In-store flyer deals (src/flyer.js): a flyer is a searched shop only when one of its live deals has these words.
  const hits = cur === "ZAR" ? flyerHits(q) : [], flyers = hits.map((h) => h.f);
  // a flyer deal names a grocery ("chicken wings", "watermelons"): search the grocery shops too
  const fq = srchShopQ(q);
  const cat = cmpCatOf(fq) || cmpCatOf(q) || (flyersGrocery(hits) ? "groceries" : null);
  const words = new Set(srchWords(q));
  const want = (s) => s.sells.includes("*") || (cat ? s.sells.includes(cat) : s.sells.some((x) => SRCH_BROAD.includes(x)));
  const shops = [], notSearched = [];
  for (const s of CMP_SHOPS) {
    if (s.cur !== cur || s.flyer) continue;
    if (s.brands && !s.brands.some((b) => words.has(b))) continue;
    if (!want(s) && !s.brands) continue;
    if (s.off === "robots") { notSearched.push({ name: s.name, why: "robots" }); continue; }
    if (s.off || !CMP_SEARCH[s.kind]) continue;
    shops.push({ id: s.id, name: s.name, general: s.sells.includes("*") });
  }
  // general shops first (they answer for most searches), then specialists; slow shops last
  const slow = (id) => (cmpShopById(id) || {}).slow ? 1 : 0;
  shops.sort((a, b) => slow(a.id) - slow(b.id) || b.general - a.general);
  // the flyer answers from memory at once: first, so it is never cut off by SRCH_MAX_SHOPS
  shops.unshift(...flyers.map((x) => { const f = cmpShopById(x.id); return { id: f.id, name: f.name, general: false, flyer: true }; }));
  for (const x of CMP_NOT_SEARCHED[cur] || []) {
    const cats = x.cats || CMP_NOT_SEARCHED_CATS;
    if (cat ? cats.includes(cat) : cats.some((c) => SRCH_BROAD.includes(c))) notSearched.push({ name: x.name, why: x.why });
  }
  const dev = srchDevice(fq);
  return { category: cat, noun: cat ? CMP_CAT_NOUN[cat] || null : null, currency: cur, device: dev ? dev.label : null, accessory_example: dev ? q + " " + dev.ex : null, shops: shops.slice(0, SRCH_MAX_SHOPS).map(({ id, name, flyer }) => (flyer ? { id, name, flyer: true } : { id, name })), notSearched };
}

// Does this product name have every search word? Short words must be whole words; a word with digits
// can also be part of a joined word ("buds3"); a long word can be plural or singular ("kettle", "kettles").
// The words of a name, and the same words joined in twos and threes ("buds 3" = "buds3"; "ps5" does not match "ps500").
function srchTokens(title) {
  const tw = cmpWords(srchAlias(title)), set = new Set(tw);
  for (let i = 0; i < tw.length; i++) { set.add(tw[i] + (tw[i + 1] || "")); if (tw[i + 2]) set.add(tw[i] + tw[i + 1] + tw[i + 2]); }
  return { tw, set };
}
const srchHas = (words, title) => srchHasTok(words, srchTokens(title));
function srchHasTok(words, { tw, set }) {
  return words.every((w) => {
    if (set.has(w)) return true;
    if (/^\d+$/.test(w)) return tw.some((t) => t === w || new RegExp("^" + w + "(st|nd|rd|th)$").test(t));
    if (w.length >= 4 && tw.some((t) => t === w + "s" || t === w + "es" || w === t + "s" || w === t + "es")) return true;
    // AB-43: a long search word we do not know, with one letter wrong in the search or in the shop's name
    // ("forrunner" = "forerunner"). Known words must match ("cable" never finds "table").
    if (w.length >= 6 && /^[a-z]+$/.test(w) && !srchKnown(w)) return tw.some((t) => t.length >= 5 && srchEd1(w, t));
    return false;
  });
}
// ---------- Main products before accessories ----------
// A search for a main product ("PS5", "iPhone 16", "Dyson V15") without an accessory word: the products
// themselves come first, and clear accessories (controllers, covers, cables, games…) are left out, so a
// R120 cable never comes before a R13,499 console. "PS5 controller" or "iPhone 16 case" still finds them.
// Text is in cmpNorm form ("PlayStation 5" = "ps5", "disc edition" = "disc").
const SRCH_ACC_WORDS = "accessor(?:y|ies)|controllers?|gamepads?|joy-?cons?|dualsense|dualshock|headsets?|remotes?|cables?|cords?|leads?|adapters?|adaptors?|chargers?|charging (?:stand|station|dock|pad|cable)|docks?|docking|stands?|holders?|mounts?|cases?|covers?|faceplates?|shells?|sleeves?|pouch(?:es)?|bags?|backpacks?|skins?|decals?|stickers?|protectors?|tempered|screen guard|glass protector|straps?|bands?|wristbands?|loops?|filters?|grips?|thumb ?grips?|ear ?tips|ear ?hooks|batter(?:y|ies) pack|power ?banks?|replacement|spare|refills?|attachments?|tools?|brush(?:es)? heads?|nozzles?|steering wheels?|racing wheels?|wheel base|pedals?|joysticks?|arcade sticks?|fight(?:ing)? sticks?|headphones? stand|cooling fans?|fans? for|vouchers?|gift cards?|subscriptions?|psn|game ?pass|membership|games?|wall mounts?";
const SRCH_ACC = new RegExp("\\b(?:" + SRCH_ACC_WORDS + ")\\b");
// Families of main products: the search words that name one, what its main product looks like, and extra accessory words.
const SRCH_DEVICES = [
  { id: "console", ex: "controller", label: "consoles", q: /\b(ps5|ps4|xbox|nintendo switch|switch 2|switch oled|switch lite|steam deck|rog ally|legion go|playstation portal)\b/,
    main: /\b(consoles?|slim|pro|digital|disc|oled model|lite|series [xs]|steam deck|rog ally|legion go|portal)\b/,
    acc: /\b(earbuds|headphones|pulse (?:elite|explore|3d)|camera|vr2? (?:charging|cover)|(?:media|tv) remote|charging station|game titles?)\b|\((?:ps[45]|xbox[^)]*|nintendo switch|switch)\)\s*$|\b(?:ea sports|fc ?2\d|fifa|call of duty|spider-?man|god of war|astro bot|mario|zelda|pokemon|minecraft|hogwarts|gta|grand theft auto|ghost of|battlefield|elden ring|assassins creed|resident evil|final fantasy|gran turismo|lego [a-z]+ game)\b/ },
  { id: "phone", ex: "case", label: "phones", q: /\b(iphone|galaxy [saz]\d+|galaxy note|pixel \d|redmi|xiaomi \d|oppo (?:a|reno|find)|huawei (?:p|nova|mate)|nothing phone|honor \d|vivo [vxy]\d)\b/,
    main: /\b(smartphones?|cellphones?|mobile phones?|\d+(?:gb|tb)|dual sim|5g|unlocked)\b/, acc: /\b(magsafe (?:wallet|charger)|wallet|stylus|s pen)\b/ },
  { id: "tablet", ex: "case", label: "tablets", q: /\b(ipad|galaxy tab|tab s\d+|surface pro|kindle)\b/, main: /\b(tablets?|wi-?fi|cellular|lte|\d+(?:gb|tb)|e-?reader)\b/, acc: /\b(folio|keyboards?|apple pencil|pencils?|stylus|s pen)\b/ },
  { id: "laptop", ex: "sleeve", label: "laptops", q: /\b(macbook|macbook air|macbook pro|chromebook|thinkpad|zenbook|vivobook|ideapad|xps \d+|surface laptop|galaxy book)\b/, main: /\b(laptops?|notebooks?|\d+(?:gb|tb)|m[1-5]\b|core i\d|ryzen|chip)\b/, acc: /\b(sleeve|hub|docking station)\b/ },
  { id: "earbuds", ex: "case", label: "earbuds and headphones", q: /\b(airpods|galaxy buds|buds\d|pixel buds|wh-?1000xm\d|wf-?1000xm\d|bose quietcomfort|beats (?:studio|solo|fit|powerbeats))\b/,
    main: /\b(earbuds|earphones|headphones|wireless|anc|bluetooth|true wireless|airpods (?:pro|max|\d)|galaxy buds|pixel buds|wh-?1000xm\d|wf-?1000xm\d)\b/, acc: /\b(silicone|protective|keychain|carabiner|ear ?tips|ear ?hooks|anti-?lost|cleaning kit)\b/, strip: /\b(?:with|w|and)\s+(?:magsafe\s+|wireless\s+|usbc\s+|lightning\s+)*charging case\b|\bcharging case\b/g },
  { id: "watch", ex: "strap", label: "watches", q: /\b(garmin|apple watch|galaxy watch|fitbit|amazfit|huawei watch|forerunner|fenix|venu|vivoactive|instinct|coros)\b/, main: /\b(watch(?:es)?|smartwatch|gps|forerunner|fenix|venu|vivoactive|instinct|epix|enduro|approach|edge \d+|tracker|series \d+|ultra)\b/, acc: /\b(quickfit|charging (?:clip|cable)|bumper)\b/,
    strip: /\b(?:aluminium|aluminum|titanium|stainless steel|steel|ceramic|fibre-reinforced polymer|polymer|\d+mm)\s+(?:[a-z]+\s+){0,2}case\b/g },
  { id: "dyson", ex: "filter", label: "Dyson products", q: /\bdyson\b/, main: /\b(vacuums?|cordless|stick|airwrap|supersonic|corrale|purifiers?|fans? heater|hot\s?\+\s?cool|humidifier|airstrait|v\d+|gen5|detect|absolute)\b/, acc: /\b(wand|crevice|soft roller|cleaner head|battery|batteries)\b/ },
  { id: "camera", ex: "case", label: "cameras", q: /\b(gopro|dji (?:osmo|mini|air|avata|pocket)|insta360|sony a\d+|canon eos|nikon z)\b/, main: /\b(cameras?|drones?|action cam|mirrorless|body|kit|hero ?\d+)\b/, acc: /\b(lens(?:es)? (?:cap|hood)|tripod|selfie stick|memory card|sd card|propellers?|nd filters?)\b/ },
];
// The family of a search for a main product, or null (no family, or the search has an accessory word in it).
function srchDevice(q) {
  const nq = cmpNorm(q);
  const d = SRCH_DEVICES.find((x) => x.q.test(nq));
  if (!d) return null;
  if (SRCH_ACC.test(nq) || d.acc.test(nq) || CMP_ACCESSORY.test(nq)) return null;
  return d;
}
// "main" (the product itself), "acc" (an accessory, a game, a cover…) or "other" (can't tell).
// The words after "+", "with" or "bundle" are the extras in a bundle ("PS5 Slim Console + DualSense Controller").
function srchKind(dev, title) {
  let t = cmpNorm(title);
  if (dev.strip) t = t.replace(dev.strip, " ");
  const head = t.split(/\s\+\s|\s&\s|\b(?:with|incl(?:udes?|uding)?|bundle|plus|and free|\+)\b/)[0] || t;
  // a console or a console bundle: the game in its name ("Switch 2 Mario Kart World Bundle") does not make it a game
  if (dev.id === "console" && /\b(consoles?|bundle)\b/.test(t) && !SRCH_ACC.test(head)) return "main";
  if (SRCH_ACC.test(head) || dev.acc.test(head) || CMP_ACCESSORY.test(t)) return "acc";
  if (dev.main.test(head)) return "main";
  return "other";
}
const SRCH_RANK = { main: 0, other: 1, acc: 2 };

// Keep real, in-stock products with an exact price that match the search; no accessories or used stock
// unless the search asks for them. A search for a main product: the products themselves first, then
// products we can't tell, cheapest first in each; clear accessories are left out (counted in "hidden").
function srchFilter(q, shop, list, info) {
  const words = srchWords(q), fq = srchShopQ(q), nq = cmpNorm(fq);
  const wantAcc = CMP_ACCESSORY.test(nq) || /\b(case|cover|charger|cable|stand|strap|controller|skin|protector)\b/.test(nq);
  const wantUsed = CMP_CONDITION.test(nq);
  const dev = srchDevice(fq);
  const seen = new Set(), out = [];
  let hidden = 0;
  for (const c of list || []) {
    if (!c || !c.title || !c.url || !(c.price > 0) || c.in_stock === false) continue;
    let u; try { u = new URL(c.url); } catch { continue; }
    if (u.protocol !== "https:" && u.protocol !== "http:") continue;
    const host = cmpShopForHost(u.hostname);
    if (!host || host.id !== shop.id) continue;           // only links on this shop's own site
    if (seen.has(u.href)) continue;
    const same = cmpNorm(c.title) + "|" + c.price;          // colour versions with the same name and price: show one
    if (seen.has(same)) continue;
    // some shops keep the brand apart from the name ("KLF03 Kettle", brand Smeg): show and match both
    const brand = c.brand ? decodeEntities(String(c.brand)).replace(/\s+/g, " ").trim() : "";
    const low = String(c.title).toLowerCase();
    const title = brand && brand.length < 40 && !brand.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length > 1 && low.includes(w)) ? brand + " " + c.title : String(c.title);
    const t = cmpNorm(title);
    if (!srchHas(words, title)) continue;
    if (!wantAcc && CMP_ACCESSORY.test(t)) { if (dev) hidden++; continue; }
    if (!wantUsed && CMP_CONDITION.test(t)) continue;
    const kind = dev ? srchKind(dev, title) : null;
    if (kind === "acc") { hidden++; seen.add(u.href); seen.add(same); continue; }
    seen.add(u.href); seen.add(same);
    const row = { title: title.replace(/\s+/g, " ").trim().slice(0, 200), price: Math.round(c.price * 100) / 100, was: c.was && c.was > c.price ? Math.round(c.was * 100) / 100 : null, from: !!c.range, currency: shop.cur, url: u.href };
    if (dev) row.rank = SRCH_RANK[kind];
    out.push(row);
  }
  if (info) info.hidden = hidden;
  return out.sort((a, b) => (a.rank || 0) - (b.rank || 0) || a.price - b.price).slice(0, SRCH_PER_SHOP);
}

// Cloudflare cache (per data centre). Not on workers.dev or in tests: then every search goes to the shop
// (each shop fetch is also kept 10 minutes by cmpFetch).
const srchCacheUrl = (shop, country, q) => `https://search-cache.eish.veldwire.com/${SRCH_VER}/${country}/${shop}/${encodeURIComponent(srchKey(q))}`;
async function srchCacheGet(key) {
  try { if (typeof caches === "undefined" || !caches.default) return null; const r = await caches.default.match(key); return r ? await r.json() : null; } catch { return null; }
}
async function srchCachePut(key, v, ttl) {
  try { if (typeof caches === "undefined" || !caches.default) return; await caches.default.put(key, new Response(JSON.stringify(v), { headers: { "content-type": "application/json", "cache-control": "public, max-age=" + ttl } })); } catch {}
}
const srchIp = (req) => req.headers.get("cf-connecting-ip") || "0";

// GET /api/search?q=&c=  -> { q, country, currency, category, shops, notSearched }
async function apiSearch(req, env) {
  const sp = new URL(req.url).searchParams;
  const v = srchClean(sp.get("q")); if (v.error) return json({ error: v.error }, 400);
  const country = srchCountry(sp.get("c") || srchVisitorCc(req)); if (!country) return json({ error: "Choose South Africa or the UK." }, 400);
  if (!isE2E(req, env) && await rateLimit(env, srchIp(req), "search")) return json({ error: "Too many searches. Wait a minute and try again." }, 429);
  const plan = srchPlan(v.q, country);
  // a plan with flyer deals is never kept past the end of any of their deals
  const age = Math.min(300, ...plan.shops.filter((s) => s.flyer).map((s) => flyerSecondsLeft(flyerById(s.id))));
  const fixed = srchFixed(v.q);
  return json({ q: v.q, country, ...plan, ...(fixed ? { fixed } : {}), ai_fallback: srchAiOk(v.q) }, 200, { "cache-control": "public, max-age=" + age });
}

// GET /api/search/shop?q=&c=&shop=  -> { shop, name, status, items }
// status: ok (items found), none, robots, blocked, busy, error
async function apiSearchShop(req, env, ctx) {
  const sp = new URL(req.url).searchParams;
  const v = srchClean(sp.get("q")); if (v.error) return json({ error: v.error }, 400);
  const country = srchCountry(sp.get("c") || srchVisitorCc(req)); if (!country) return json({ error: "Choose South Africa or the UK." }, 400);
  const shop = cmpShopById(sp.get("shop") || "");
  // Flyer deals: from memory, no shop fetch, no cache (so nothing shows after the flyer ends).
  if (shop && shop.flyer) {
    if (country !== "ZA") return json({ error: "unknown shop" }, 400);
    const f = flyerById(shop.id);
    if (!flyerActive(f)) return json({ shop: shop.id, name: shop.name, status: "ended", items: [], flyer: true }, 200, { "cache-control": "no-store" });
    const items = flyerSearch(f, v.q);
    return json({ shop: shop.id, name: shop.name, status: items.length ? "ok" : "none", items, flyer: true, label: f.label, fine: f.fine, checked_at: now() }, 200, { "cache-control": "public, max-age=" + Math.min(300, flyerSecondsLeft(f)) });
  }
  if (!shop || !srchPlan(v.q, country).shops.some((s) => s.id === shop.id)) return json({ error: "unknown shop" }, 400);
  const base = { shop: shop.id, name: shop.name };
  const key = srchCacheUrl(shop.id, country, v.q);
  const hit = await srchCacheGet(key);
  if (hit) return json({ ...hit, cached: true });
  if (!isE2E(req, env) && await cmpIpLimited(env, srchIp(req))) return json({ ...base, status: "busy", items: [] }, 429);
  const rb = await cmpRobotsOk(env, shop);
  if (rb === false) { const out = { ...base, status: "robots", items: [], checked_at: now() }; await srchCachePut(key, out, 6 * 3600); return json(out); }
  if (rb === "retry") return json({ ...base, status: "error", items: [] });
  if (await cmpShopBusy(env, shop)) return json({ ...base, status: "busy", items: [] });
  let list, status = "ok", timer = null;
  // AB-43: the page waits SRCH_TIMEOUT at most. A slower shop goes on in the background (ctx.waitUntil) and its
  // answer is kept in the cache, so the next search (or Search again) shows it at once.
  const run = CMP_SEARCH[shop.kind](shop, srchShopQ(v.q));
  try {
    list = await Promise.race([run, new Promise((_, no) => { timer = setTimeout(() => no(new CmpError("timeout", "slow")), SRCH_TIMEOUT); })]);
  } catch (e) { status = e instanceof CmpError && e.kind === "blocked" ? "blocked" : e instanceof CmpError && e.kind === "slow" ? "slow" : "error"; }
  finally { clearTimeout(timer); }
  if (status === "slow" && ctx && ctx.waitUntil) {
    ctx.waitUntil(run.then((l) => { const items = srchFilter(v.q, shop, l, {}); return srchCachePut(key, { ...base, status: items.length ? "ok" : "none", items, checked_at: now() }, SRCH_TTL); }).catch(() => {}));
  } else if (status === "slow") run.catch(() => {});
  if (status !== "ok") return json({ ...base, status, items: [] });
  const info = {};
  const items = srchFilter(v.q, shop, list, info);
  const out = { ...base, status: items.length ? "ok" : "none", items, checked_at: now() };
  if (info.hidden) out.hidden = info.hidden;
  const put = srchCachePut(key, out, SRCH_TTL);
  if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put;
  return json(out);
}
