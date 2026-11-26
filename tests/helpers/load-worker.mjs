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
  "cmpAiKind", "cmpAiPick", "cmpAiParse", "cmpAiJudge", "cmpAiText", "CMP_AI_MODEL", "CMP_AI_DAILY", "CMP_AI_TIMEOUT", "CMP_AI_SYSTEM", "CMP_VER", "CMP_CLEF_MODEL", "CMP_CLEF_TIMEOUT", "CMP_CLEF_MIN", "cmpClefInput", "cmpClefParse", "cmpShopById",
  "FLM_FLYER", "FLM_FROM", "FLM_UNTIL", "FLM_LABEL", "FLM_HOME", "flmActive", "flmSecondsLeft", "flmDealText", "flmItem", "flmSearch", "flmMatchWhy", "flmCompare", "flmCompareAnswer", "flmVariants", "flmValidText", "FLYERS", "PNP_FLYER", "SPAR_FLYER", "SHOPRITE_FLYER", "flyerById", "flyerActive", "flyerSecondsLeft", "flyerSearch", "flyerCompare", "flyerCompareAnswer", "flyItem", "flyDealLive", "flyLimit", "flyBadges", "flyRegular", "flyNote", "flyersFor", "flyersGrocery", "flyerHits", "srchTokens", "srchHasTok",
  "srchIsLink", "srchClean", "srchCountry", "srchWords", "srchKey", "srchPlan", "srchHas", "srchFilter", "srchCacheUrl", "apiSearch", "apiSearchShop", "SRCH_TTL", "SRCH_MIN", "SRCH_MAX", "srchDevice", "srchKind",
  "asIsAssist", "AS_VER", "asClean", "asBudget", "asRules", "asMerge", "asAiJson", "asIntent", "asPairs", "asFits", "asCandidates", "asPick", "asScore", "asRuleReason", "asReasonOk", "asReasons", "asValidate", "asUnderstanding", "asModelKey", "asSameModel", "asTail", "asHasTerm", "apiAssist", "AS_REASON_SYSTEM", "asFeats", "asUse", "asBudgetLine", "asNoBudget", "AS_AI_DAILY", "AS_AI_TIMEOUT", "AS_TTL", "AS_ASK_RE", "asAiReset", "asOffTopic", "AS_OFF_RE", "AS_OFF_MSG", "AS_RL_MSG", "AS_RL_MIN", "AS_RL_HOUR", "asRateLimited", "asRlReset", "asOrCall", "asOrReset", "asAiCall", "AS_OR_MODELS", "AS_OR_URL", "AS_OR_TIMEOUT", "AS_OR_DEADLINE", "AS_OR_DAILY", "AS_INTENT_KEYS", "AS_REASON_KEYS", "AS_SHOP_SOFT", "AS_SHOP_TIMEOUT", "AS_ENOUGH", "AS_INTENT_MS", "AS_REASON_MS", "AS_REASON_SKIP", "asSearchAll", "srchAlias", "srchShopQ", "asBulk", "asPackN", "asFixQueries", "asFlyerCands", "asGroceryFits", "asStripBulk", "AS_PARTS", "AS_FLOOR", "asAiList", "asAiPick", "asPickParse", "asPickShape", "asPickLine", "asDedupe", "asRank", "asRel", "AS_PICK_SYSTEM", "AS_AI_N", "AS_PICK_MS", "AS_PICK_END",
  "dealScore", "dsRaw", "dsCompare", "publicDeal",
  "apiHome", "homeDeals", "homeListHtml", "homeCard", "homeInPage", "homeMoney", "homeDrops", "homeFlyer", "homeDropItem", "homeMemReset", "HOME_TTL", "HOME_FRESH", "HOME_LABEL",
];

const source = [
  "const FLM_FLYER = " + read("data/flm-flyer-2026-11-23.json") + ";",
  "const PNP_FLYER = " + read("data/pnp-flyer-2026-11-26.json") + ";",
  "const SPAR_FLYER = " + read("data/spar-flyer-2026-11-25.json") + ";",
  "const SHOPRITE_FLYER = " + read("data/shoprite-flyer-2026-11-26.json") + ";",
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
  read("src/search.js"),
  read("src/assist.js"),
  read("src/score.js"),
  read("src/flyer.js"),
  read("src/home.js"),
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
