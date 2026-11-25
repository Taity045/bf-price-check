// Loads the worker the same way build.py assembles it (shops.js + worker.js + features.js + daily.js +
// og.js + og_font.js), with small stand-ins for the build-time constants, and adds named exports so unit
// tests can call the pure functions. Nothing here touches the network.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  "median", "historyPoints", "judge", "sparseEvidence", "cdxQueries", "publicVerdict",
  "escHtml", "apiGuard", "verdictStmt", "shopScore", "track", "cron",
  "laneFor", "hostKey", "nextCheckAt", "pickBatch", "savedDays", "parseRobots", "robotsAllows", "takealotSeeds",
  "ensureDailySchema", "backfillLanes", "runDaily", "dueSeedDept", "refreshSeeds", "dailyHousekeeping", "apiDailyStatus",
  "DAILY_MS", "DAILY_CAPS", "SEED_CAPS", "MAX_FAILS", "MAX_SEEDS", "BOT_UA", "STALE_MS", "CLAIM_MS", "isE2E", "verifyTurnstile", "notifyOwnerOfRequest",
  "mDay", "mHuman", "mDevice", "mRefDomain", "mTeam", "verifyAccess", "statsData", "statsHtml", "M_CLICKS",
];

const source = [
  "const FONTS = {};",
  "const STATIC_IMG = {};",
  'const APP = { name: "app.0123456789.js", js: "" };',
  read("src/shops.js"),
  read("src/worker.js"),
  read("src/features.js"),
  read("src/daily.js"),
  read("src/og.js"),
  read("src/stats.js"),
  read("src/og_font.js").replace("export const OG_FONT", "const OG_FONT"),
  "const HTML = " + JSON.stringify(read("public/index.html")) + ";",
  `export { ${NAMES.join(", ")} };`,
].join("\n");

const dir = new URL("tests/.tmp/", root);
mkdirSync(dir, { recursive: true });
// Test files run in parallel processes: name the file by its content and write it atomically.
const file = new URL(`worker.${createHash("sha1").update(source).digest("hex").slice(0, 12)}.mjs`, dir);
if (!existsSync(file)) {
  const tmp = new URL(`worker.${process.pid}.${Date.now()}.tmp`, dir);
  writeFileSync(tmp, source);
  renameSync(tmp, file);
}
const mod = await import(pathToFileURL(fileURLToPath(file)).href);
export const worker = mod.default;
export const W = mod;
