// Shops whose product pages Common Crawl holds (see research in bf-sources/report.md), strongest first.
// surt: Common Crawl index key prefix. path: regex on the URL path that marks a product page.
// ccy: the only currency we accept from this shop's pages.
export const CC_SHOPS = [
  { name: "Dunelm", surt: "com,dunelm)/", path: /^\/product\/[^/]+-\d{8,}\/?$/, ccy: "GBP" },
  { name: "Wickes", surt: "uk,co,wickes)/", path: /\/p\/\d+\/?$/, ccy: "GBP" },
  { name: "Lookfantastic", surt: "com,lookfantastic)/", path: /^\/p\/[^/]+\/\d{7,9}\/?$|\/\d{7,9}\.html$/, ccy: "GBP" },
  { name: "Cult Beauty", surt: "uk,co,cultbeauty)/", path: /^\/p\/[^/]+\/\d{7,9}\/?$|\/\d{7,9}\.html$/, ccy: "GBP" },
  { name: "Apple UK", surt: "com,apple)/uk/shop/", path: /^\/uk\/shop\/(product|buy-)[^?]*$/, ccy: "GBP" },
  { name: "Cashbuild", surt: "za,co,cashbuild)/", path: /^\/[a-z0-9-]+\/\d{3,}-[a-z0-9-]+\/?$/, ccy: "ZAR" },
  { name: "Studio 88", surt: "za,co,studio-88)/", path: /^\/[a-z0-9]+(-[a-z0-9]+){3,}\/?$/, ccy: "ZAR" },
  { name: "PUMA ZA", surt: "com,puma,za)/", path: /^\/pd\/[^/]+\/\d{6}\.html$/, ccy: "ZAR" },
  { name: "Cycle Lab", surt: "com,cyclelab)/", path: /^\/product\/[^/]+\/?$/, ccy: "ZAR" },
  { name: "Bash (TFG)", surt: "com,bash)/", path: /^\/[^/]+\/p\/?$/, ccy: "ZAR" },
  { name: "M&S", surt: "com,marksandspencer)/", path: /^\/[^/]+\/p\/[a-z]{2,4}\d{5,}\/?$/, ccy: "GBP" },
  { name: "JD Sports", surt: "uk,co,jdsports)/", path: /^\/product\/[^/]+\/\d{6,}\/?$/, ccy: "GBP" },
  { name: "Richer Sounds", surt: "com,richersounds)/", path: /^\/[a-z0-9]+(-[a-z0-9]+){2,}\/?$/, ccy: "GBP" },
  { name: "Loot", surt: "za,co,loot)/", path: /^\/product\/[^/]+\/[a-z0-9-]+\/?$/, ccy: "ZAR" },
  { name: "Evetech", surt: "za,co,evetech)/", path: /^\/[^/]+\/[^/]{2,}\/\d{2,6}\/?$/, ccy: "ZAR" },
  { name: "OneDayOnly", surt: "za,co,onedayonly)/", path: /^\/products\/[^/]+\/?$/, ccy: "ZAR" },
  { name: "Woolworths", surt: "za,co,woolworths)/", path: /^\/prod\/.*\/_\/A-[0-9A-Za-z]+\/?$/, ccy: "ZAR" },
  { name: "Sportsmans Warehouse", surt: "za,co,sportsmanswarehouse)/", path: /^\/product\/[^/]+\/?$/, ccy: "ZAR" },
  { name: "Miladys", surt: "com,miladys)/", path: /^\/[a-z0-9-]+-\d{9}\/?$/, ccy: "ZAR" },
  { name: "Sheet Street", surt: "com,sheetstreet)/", path: /^\/[a-z0-9-]+-\d{9}\/?$/, ccy: "ZAR" },
  { name: "First Shop", surt: "za,co,firstshop)/", path: /^\/products\/[^/]+\/?$/, ccy: "ZAR" },
  // Thinner coverage: loaded after the 22 above when the daily write budget allows.
  { name: "Cotton On ZA", surt: "com,cottonon)/za/", path: /\d{6,7}-\d{2,3}\.html$/, ccy: "ZAR" },
  { name: "IKEA UK", surt: "com,ikea)/gb/en/p/", path: /^\/gb\/en\/p\/[^/]+\/?$/, ccy: "GBP" },
  { name: "Edgars", surt: "za,co,edgars)/", path: /^\/products\/[^/]+\/?$/, ccy: "ZAR" },
  { name: "Exclusive Books", surt: "za,co,exclusivebooks)/", path: /^\/products\/[^/]+\/?$/, ccy: "ZAR" },
  { name: "Computer Mania", surt: "za,co,computermania)/", path: /^\/products\/[^/]+\/?$/, ccy: "ZAR" },
  { name: "Pep", surt: "com,pepstores)/", path: /^\/products\/[^/]+\/?$/, ccy: "ZAR" },
  { name: "Faithful to Nature", surt: "za,co,faithful-to-nature)/", path: /^\/[a-z0-9-]+-\d{4,7}\/?$/, ccy: "ZAR" },
];
