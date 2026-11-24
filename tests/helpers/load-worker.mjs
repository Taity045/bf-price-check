// Loads the worker the same way build.py assembles it (shops.js + worker.js + features.js + og.js +
// og_font.js), with small stand-ins for the build-time constants, and adds named exports so unit
// tests can call the pure functions. Nothing here touches the network.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = new URL("../../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");

export const NAMES = [
  "SHOP_LIST", "RL", "MAX_TRACKED", "LIVE_CACHE_PREFIX",
  "parsePrice", "decodeEntities", "symbolCurrency", "tldCurrency",
  "isPrivateIPv4", "isPrivateIPv6", "validateUrl", "resolvesPublic", "canonicalize",
  "parseJsonLd", "parseMeta", "parseAmazon", "parseDataLayer", "parseMainPriceBlock", "parseFallback",
  "pageAmount", "detectBlock", "extractFromHtml", "takealotBarcode", "takealotApi", "getCurrent",
  "sameProduct", "matchShop", "shopFor", "blockedShopFor",
  "rateLimit", "cacheGet", "cachePut",
  "median", "historyPoints", "judge", "publicVerdict",
  "escHtml", "apiGuard", "isE2E", "verifyTurnstile", "notifyOwnerOfRequest",
];

const source = [
  "const FONTS = {};",
  'const APP = { name: "app.0123456789.js", js: "" };',
  read("src/shops.js"),
  read("src/worker.js"),
  read("src/features.js"),
  read("src/og.js"),
  read("src/og_font.js").replace("export const OG_FONT", "const OG_FONT"),
  "const HTML = " + JSON.stringify(read("public/index.html")) + ";",
  `export { ${NAMES.join(", ")} };`,
].join("\n");

const dir = new URL("tests/.tmp/", root);
mkdirSync(dir, { recursive: true });
const file = new URL("worker.unit.mjs", dir);
writeFileSync(file, source);
const mod = await import(pathToFileURL(fileURLToPath(file)).href);
export const worker = mod.default;
export const W = mod;
