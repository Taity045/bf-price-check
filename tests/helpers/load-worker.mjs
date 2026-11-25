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
  "parsePrice", "parseTextPrice", "readerFor", "readerTarget", "readApi", "readPage", "vtexProduct", "mrpProduct", "pnpProduct", "wooProduct", "sfccRsc", "netflorist", "clicksPage", "absolutePets", "decodeEntities", "symbolCurrency", "tldCurrency",
  "isPrivateIPv4", "isPrivateIPv6", "validateUrl", "resolvesPublic", "canonicalize",
  "parseJsonLd", "parseMeta", "parseAmazon", "parseDataLayer", "parseMainPriceBlock", "parseFallback",
  "pageAmount", "detectBlock", "extractFromHtml", "takealotBarcode", "takealotApi", "getCurrent",
  "sameProduct", "matchShop", "shopFor", "blockedShopFor", "archivedGeoCheck", "ukArchiveShop",
  "rateLimit", "overLimit", "softWrite", "cacheGet", "cachePut",
  "median", "historyPoints", "judge", "sparseEvidence", "cdxQueries", "publicVerdict",
  "escHtml", "apiGuard", "verdictStmt", "shopScore", "track", "cron",
  "laneFor", "hostKey", "nextCheckAt", "pickBatch", "savedDays", "parseRobots", "robotsAllows", "takealotSeeds",
  "ensureDailySchema", "backfillLanes", "runDaily", "dueSeedDept", "refreshSeeds", "dailyHousekeeping", "apiDailyStatus",
  "DAILY_MS", "DAILY_CAPS", "SEED_CAPS", "MAX_FAILS", "MAX_SEEDS", "BOT_UA", "STALE_MS", "CLAIM_MS", "isE2E", "verifyTurnstile", "notifyOwnerOfRequest",
  "mDay", "mHuman", "mDevice", "mRefDomain", "mTeam", "verifyAccess", "statsData", "statsHtml", "M_CLICKS",
  "archiveKey", "apiPriceFix", "PRICE_FIX_BEFORE", "archiveLookupKeys", "archiveBatchStmt", "archiveRowsFor", "archiveProbe", "archiveRows", "archivePoints", "ccIndexLink", "cleanArchiveRow", "apiArchiveLoad", "apiArchiveStats", "ensureArchiveTables", "ARCHIVE_DAILY_CAP", "storedHistory", "apiCheck", "archivedCopyBlocked", "visibleTextLength", "pickSnaps", "fetchSnapshot", "getSnapshots", "historyLevel", "historyProductKey", "computeShopHistory", "shopHistory", "apiShops", "historyNote", "relabelOldSnaps", "SNAP_DETECT_SINCE",
  "CMP_SHOPS", "CMP_SEARCH", "CMP_DETAIL", "cmpNorm", "cmpWords", "cmpCodes", "cmpCodesMatch", "cmpGtin", "cmpAttrs", "cmpIdentity", "cmpIdentityFromCurrent", "cmpApplyDetail", "cmpCodesConflict", "cmpCategory", "cmpCatOf", "cmpWooItem", "cmpPlan", "cmpQuery", "cmpCoreQuery", "cmpMatch", "cmpSearchShop", "cmpShopForHost", "takealotAttr", "cmpShortQuery", "cmpOwnBrand", "cmpGroceryCheck", "cmpGroceryClose", "cmpGtinCheck", "cmpPnpItem", "cmpPnpMember", "cmpMorrisonsItem", "CMP_NOT_SEARCHED", "pnpFacts",
];

const source = [
  "const FONTS = {};",
  "const STATIC_IMG = " + JSON.stringify(Object.fromEntries(["og-home.png", "og-home.jpg", "og-square.jpg", "favicon.ico", "apple-touch-icon.png"].map((n) => [n, readFileSync(new URL("public/" + n, root)).toString("base64")]))) + ";",
  'const APP = { name: "app.0123456789.js", js: "", lazy_name: "result.0123456789.js", lazy: "" };',
  read("src/shops.js"),
  read("src/worker.js"),
  read("src/readers.js"),
  read("src/features.js"),
  read("src/archive.js"),
  read("src/daily.js"),
  read("src/compare.js"),
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
