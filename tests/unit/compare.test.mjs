import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { W } from "../helpers/load-worker.mjs";

const id = (title, extra = {}) => W.cmpIdentity({ title, price: 1000, currency: "ZAR", ...extra }, extra.url || "https://www.takealot.com/x/PLID1");
const cand = (title, extra = {}) => ({ title, price: 1000, gtins: [], ...extra });
const level = (src, c) => W.cmpMatch(src, c).level;

describe("compare: same product (true matches)", () => {
  const cases = [
    ["same barcode, different names", id("Apple AirPods 4", { brand: "Apple", gtin: "195949688584" }), cand("Apple AirPods 4 White", { brand: "Apple", gtins: ["0195949688584"] }), "barcode"],
    ["UPC vs EAN with leading zero", id("Logitech MX Master 3S", { brand: "Logitech", gtin: "05099206129382" }), cand("MX Master 3S Graphite", { gtins: ["5099206129382"] }), "barcode"],
    ["model code in title and URL", id("Defy 350L Bottom Freezer Fridge Satin Metallic DAC622", { brand: "Defy" }), cand("Defy 350l Combi C455 Metallic Fridge / Freezer - DAC622"), "model"],
    ["Samsung code with region suffix", id("Samsung 55 inch U8000F 4K Crystal UHD Smart TV", { brand: "Samsung", mpn: "UA55U8000FKXXA" }), cand("Samsung UA55U8000 55-inch 4K UHD LED Smart TV UA55U8000FKXXA"), "model"],
    ["Apple part number region (ZE/A vs ZM/A)", id("Apple AirPods 4 MXP63ZE/A", { brand: "Apple" }), cand("Apple AirPods 4 Wireless Earbuds MXP63ZM/A", { brand: "Apple" }), "model"],
    ["Sony WH-1000XM5 written two ways", id("Sony Wireless Noise-Cancelling Headphones WH-1000XM5", { brand: "Sony" }), cand("Sony WH1000XM5/SME Wireless Noise Cancelling Headphone Silver", { brand: "Sony" }), "model"],
    ["LEGO set number", id("LEGO® Technic Ford Bronco® SUV Model Car Kit, STEM Building Set 42213", { brand: "LEGO" }), cand("LEGO Technic Ford Bronco SUV (42213)"), "model"],
    ["Philips model with slash", id("Philips 2000 Series NA231/00 6,2L Digital Window Airfryer", { brand: "Philips" }), cand("Philips 6.2l Black 2000 Series Digital Airfryer - NA231/00"), "model"],
    ["iPhone by name and storage (other code kinds)", id("Apple iPhone 16 128GB", { brand: "Apple", mpn: "MYED3" }), cand("iPhone 16 128GB Black,Model A3287", { brand: "Apple" }), "name"],
    ["name and specs, extra describing words", id("Apple AirPods 4", { brand: "Apple" }), cand("Apple AirPods 4 Wireless Earbuds with USB-C Charging Case", { brand: "Apple" }), "name"],
    ["JBL Flip 7 without 'waterproof'", id("JBL Flip 7 Portable Waterproof Bluetooth Speaker", { brand: "JBL" }), cand("JBL Flip 7 Portable Bluetooth Speaker - Black", { brand: "JBL" }), "name"],
    ["PS5 written as PlayStation 5", id("PlayStation 5 Slim Digital Edition Console", { brand: "Sony PlayStation" }), cand("Sony PS5 Slim Digital Console"), "name"],
    ["perfume with size", id("Dior Sauvage 100ml Eau de Parfum", { brand: "Dior" }), cand("Sauvage Eau de Parfum 100ml", { brand: "Dior" }), "name"],
    ["BT written for Bluetooth", id("JBL Flip 7 Portable BT Speaker", { brand: "JBL" }), cand("JBL Flip 7 Portable Bluetooth Speaker - Black", { brand: "JBL" }), "name"],
    ["LEGO 'Model Car Kit' is not a bundle", id("LEGO Technic Ford Bronco SUV (42213)", { brand: "LEGO" }), cand("LEGO® Technic Ford Bronco® SUV Model Car Kit, STEM Building Set 42213"), "model"],
    ["ISBN in a book shop's link", id("Atomic Habits", { url: "https://exclusivebooks.co.za/products/9781847941831" }), cand("Atomic Habits - An Easy And Proven Way (Paperback)", { gtins: ["9781847941831"] }), "barcode"],
  ];
  for (const [name, s, c, want] of cases) test(name, () => assert.equal(level(s, c), want, JSON.stringify(W.cmpMatch(s, c))));
});

describe("compare: different products (false matches are rejected)", () => {
  const cases = [
    ["iPhone 128GB vs 256GB", id("Apple iPhone 16 128GB", { brand: "Apple" }), cand("Apple iPhone 16 256GB", { brand: "Apple" })],
    ["iPhone 16 vs 16 Pro", id("Apple iPhone 16 128GB", { brand: "Apple" }), cand("Apple iPhone 16 Pro 128GB", { brand: "Apple" })],
    ["iPhone 16 vs 16e", id("Apple iPhone 16 128GB", { brand: "Apple" }), cand("Apple iPhone 16E 128GB - Black", { brand: "Apple" })],
    ["page with several sizes vs one size", id("Sauvage Eau de Parfum", { brand: "Dior" }), cand("Dior Sauvage 100ml Eau de Parfum", { brand: "Dior" })],
    ["phone without storage vs one storage", id("Apple iPhone 16", { brand: "Apple" }), cand("Apple iPhone 16 128GB", { brand: "Apple" })],
    ["camera starter kit is a bundle", id("Canon EOS R50 Mirrorless Camera Body", { brand: "Canon" }), cand("Canon EOS R50 Mirrorless Camera Body Starter Kit", { brand: "Canon" })],
    ["ISBN of another edition", id("Atomic Habits", { url: "https://exclusivebooks.co.za/products/9781847941831" }), cand("Atomic Habits (Hardcover)", { gtins: ["9780735211292"] })],
    ["iPhone 16 vs 15", id("Apple iPhone 16 128GB", { brand: "Apple" }), cand("iPhone 15 128GB Blue", { brand: "Apple" })],
    ["AirPods 4 vs AirPods 4 with ANC", id("Apple AirPods 4", { brand: "Apple" }), cand("Apple AirPods 4 with Active Noise Cancellation", { brand: "Apple" })],
    ["AirPods 4 vs AirPods 5", id("Apple AirPods 4", { brand: "Apple" }), cand("Apple AirPods 5", { brand: "Apple" })],
    ["AirPods vs a case for AirPods", id("Apple AirPods 4", { brand: "Apple" }), cand("Silicone Case for Apple AirPods 4", { price: 150 })],
    ["phone vs screen protector", id("Samsung Galaxy S25 256GB", { brand: "Samsung" }), cand("Samsung Galaxy S25 256GB Tempered Glass Screen Protector", { brand: "Samsung", price: 120 })],
    ["55 vs 65 inch TV", id("Samsung 55\" Crystal UHD Smart TV", { brand: "Samsung" }), cand("Samsung 65\" Crystal UHD Smart TV", { brand: "Samsung" })],
    ["TV model year letter differs", id("Samsung 55 Television - QA55S90FAKXXA 4K OLED", { brand: "Samsung" }), cand("Samsung 139cm (55\") OLED Vision AI Smart Television - QA55S90HAUXXA")],
    ["PS5 Digital vs Disc", id("PlayStation 5 Slim Digital Edition Console", { brand: "Sony" }), cand("Sony PlayStation 5 Slim Console with disc drive")],
    ["PS5 vs PS5 bundle", id("PlayStation 5 Slim Digital Edition Console", { brand: "Sony" }), cand("Sony PlayStation 5 Slim Digital Edition + EA FC 26")],
    ["PS5 vs PS5 Pro", id("PlayStation 5 Slim Digital Edition Console", { brand: "Sony" }), cand("Sony PlayStation 5 Pro Digital Console")],
    ["parallel import", id("Samsung Galaxy Buds3 Pro", { brand: "Samsung" }), cand("Samsung Galaxy Buds3 Pro Parallel Import", { brand: "Samsung" })],
    ["refurbished", id("Apple iPhone 15 128GB", { brand: "Apple" }), cand("Apple iPhone 15 128GB (Renewed)", { brand: "Apple" })],
    ["different brand", id("Philips 6.2L Digital Airfryer", { brand: "Philips" }), cand("Russell Hobbs 6.2L Digital Airfryer", { brand: "Russell Hobbs" })],
    ["Forerunner 265 vs 265 Music", id("Garmin Forerunner 265", { brand: "Garmin" }), cand("Forerunner 265 Music - Black", { brand: "Garmin" })],
    ["Forerunner 265 vs 265S", id("Garmin Forerunner 265", { brand: "Garmin" }), cand("Garmin Forerunner 265S", { brand: "Garmin" })],
    ["Sony XM5 vs XM6", id("Sony WH-1000XM5", { brand: "Sony" }), cand("Sony WH1000XM6 Noise Cancelling Wireless Headphone Black WH-1000XM6/BME", { brand: "Sony" })],
    ["perfume without size", id("Dior Sauvage 100ml Eau de Parfum", { brand: "Dior" }), cand("Sauvage Eau de Parfum", { brand: "Dior" })],
    ["perfume 100ml vs 60ml", id("Dior Sauvage 100ml Eau de Parfum", { brand: "Dior" }), cand("Dior Sauvage 60ml Eau de Parfum", { brand: "Dior" })],
    ["Eau de Parfum vs Eau de Toilette", id("Dior Sauvage 100ml Eau de Parfum", { brand: "Dior" }), cand("Dior Sauvage 100ml Eau de Toilette", { brand: "Dior" })],
    ["Eau de Parfum vs Parfum", id("Dior Sauvage 100ml Eau de Parfum", { brand: "Dior" }), cand("Dior Sauvage Parfum 100ml", { brand: "Dior" })],
    ["air fryer 6.2L vs 4.1L", id("Philips 2000 Series 6.2L Digital Airfryer", { brand: "Philips" }), cand("Philips 2000 Series 4.1L Digital Airfryer", { brand: "Philips" })],
    ["colour differs", id("Apple iPhone 16 128GB Black", { brand: "Apple" }), cand("Apple iPhone 16 128GB Pink", { brand: "Apple" })],
    ["different barcodes", id("Apple AirPods 4", { brand: "Apple", gtin: "195949688584" }), cand("Apple AirPods 4", { brand: "Apple", gtins: ["195949688591"] })],
    ["mens vs womens shoe", id("Nike Air Force 1 '07 Men's", { brand: "Nike" }), cand("Nike Air Force 1 '07 Women's", { brand: "Nike" })],
    ["Nike style codes differ", id("Nike Air Force 1 '07 CW2288-111", { brand: "Nike" }), cand("Nike Air Force 1 '07 DD8959-100", { brand: "Nike" })],
    ["LEGO set numbers differ", id("LEGO Technic Ford Bronco 42213", { brand: "LEGO" }), cand("LEGO Technic Ferrari FXX K 42212")],
    ["price far off for a name match", id("Apple AirPods 4", { brand: "Apple" }), cand("Apple AirPods 4", { brand: "Apple", price: 250 })],
    ["two laptops with the same chip are not the same", id("Lenovo IdeaPad Slim 3 15 i7-13620H 16GB 512GB", { brand: "Lenovo" }), cand("HP Victus 15 i7-13620H 16GB 512GB", { brand: "HP" })],
    ["no brand, name only", id("Atomic Habits"), cand("Atomic Habits")],
  ];
  for (const [name, s, c] of cases) test(name, () => assert.equal(level(s, c), null, JSON.stringify(W.cmpMatch(s, c))));
  test("fashion needs a barcode or model number", () => {
    const s = id("Nike Air Force 1 '07 Men's White", { brand: "Nike" });
    assert.equal(W.cmpMatch(s, cand("Nike Men's Air Force 1 '07 White Sneaker", { brand: "Nike" }), { noNameMatch: true }).level, null);
    assert.equal(W.cmpMatch(s, cand("Nike Men's Air Force 1 '07 White Sneaker", { brand: "Nike", gtins: ["194500874909"] }), { noNameMatch: true }).level, null);
  });
});

describe("compare: helpers", () => {
  test("model codes", () => {
    assert.deepEqual(W.cmpCodes("Samsung UA55U8000FKXXA 55\" 4K"), ["ua55u8000fkxxa"]);
    assert.deepEqual(W.cmpCodes("Apple AirPods 4 MXP63ZE/A"), ["mxp63"]);
    assert.ok(W.cmpCodes("Nike Air Force 1 '07 CW2288-111").includes("cw2288111"));
    assert.deepEqual(W.cmpCodes("128GB 1500W 5000mAh USB-C 4K HDR10+ i7-13700H RTX4060 Wi-Fi 6E"), []);
    assert.deepEqual(W.cmpCodes("LEGO Star Wars 75192 Millennium Falcon", "LEGO"), ["lego75192"]);
    assert.equal(W.cmpCodesMatch(["ua55du7000"], ["ua55du7000kxxa"]), "ua55du7000");
    assert.equal(W.cmpCodesMatch(["qa55s90"], ["qa55s90fakxxa"]), null);
    assert.equal(W.cmpCodesConflict(["myed3"], ["a3287"]), false);
    assert.equal(W.cmpCodesConflict(["qa55s90fakxxa"], ["qa55s90hauxxa"]), true);
  });
  test("barcodes", () => {
    assert.equal(W.cmpGtin("0195949688584"), "195949688584");
    assert.equal(W.cmpGtin("2000858299333"), null);   // shop-internal
    assert.equal(W.cmpGtin("123"), null);
    assert.equal(W.cmpGtin(null), null);
  });
  test("specs", () => {
    const a = W.cmpAttrs("Samsung 139cm (55\") Galaxy 256GB 1TB 6,2L 1700W 3 Pack Black");
    assert.deepEqual([...a.inch], [55]); assert.deepEqual([...a.storage], [256, 1024]); assert.deepEqual([...a.ml], [6200]);
    assert.deepEqual([...a.watt], [1700]); assert.deepEqual([...a.pack], [3]); assert.deepEqual([...a.colour], ["black"]);
  });
  test("search words drop filler and colours", () => {
    assert.equal(W.cmpQuery(id("Apple AirPods 4", { brand: "Apple" })), "apple airpods 4");
    assert.equal(W.cmpQuery(id("Garmin Forerunner 265 - Black/White", { brand: "Garmin" })), "garmin forerunner 265");
    assert.equal(W.cmpQuery(id("Forerunner 265", { brand: "Garmin" })), "garmin forerunner 265");
    assert.equal(W.cmpQuery(id("Xbox Series X 1TB Console", { brand: "Microsoft" })).includes(" x "), true, "keeps the X in Series X");
    assert.equal(/ s( |$)/.test(W.cmpQuery(id("Amazon Kindle Paperwhite 7\" WiFi 16GB With S/O", { brand: "Amazon" }))), false, "drops stray single letters");
  });
  test("category and shop plan", () => {
    const tv = id("Samsung 55 inch Crystal UHD Smart TV", { brand: "Samsung" });
    assert.equal(W.cmpCategory(tv), "electronics");
    const plan = W.cmpPlan(tv, "www.takealot.com", "ZAR");
    assert.ok(!plan.shops.some((s) => s.id === "takealot"), "never the shop it came from");
    assert.ok(plan.shops.some((s) => s.id === "hirschs"));
    assert.ok(!plan.shops.some((s) => s.id === "exclusivebooks" || s.id === "ngf" || s.id === "lakeland"));
    assert.equal(W.cmpCategory(id("Atomic Habits", { gtin: "9781847941831" })), "books");
    const book = W.cmpPlan(id("Atomic Habits", { gtin: "9781847941831" }), "www.takealot.com", "ZAR");
    assert.deepEqual(book.shops.map((s) => s.id).sort(), ["exclusivebooks", "loot"]);
    assert.ok(W.cmpPlan(id("Puma Speedcat OG", { brand: "Puma" }), "superbalist.com", "ZAR").shops.some((s) => s.id === "puma"));
    assert.ok(!W.cmpPlan(id("Nike Air Force 1", { brand: "Nike" }), "superbalist.com", "ZAR").shops.some((s) => s.id === "puma"));
    assert.deepEqual(W.cmpPlan(id("Kettle 1.7L", { brand: "Smeg" }), "www.lakeland.co.uk", "GBP").shops.map((s) => s.id), []);
    assert.deepEqual(W.cmpPlan(id("Air fryer 5L", { brand: "Ninja" }), "www.dunelm.com", "GBP").shops.map((s) => s.id), ["lakeland"]);
    assert.deepEqual(W.cmpPlan(id("AirPods 4", { brand: "Apple" }), "www.mediamarkt.de", "EUR").shops, []);
    assert.equal(W.cmpShopForHost("www.sportscene.co.za").id, "bash");
  });
  test("a shop option (size) is picked from the product's variants", () => {
    const s = id("Dior Sauvage 100ml Eau de Parfum", { brand: "Dior", price: 3999 });
    const c = cand("Sauvage Eau de Parfum", { brand: "Dior", price: 2355, range: true });
    W.cmpApplyDetail(s, c, { variants: [{ title: "60ml", price: 2355, barcode: "3348901368254" }, { title: "100ml", price: 3245, barcode: "3348901368247" }, { title: "200ml", price: 4870, barcode: "3348901428545" }] });
    assert.equal(c.price, 3245); assert.equal(c.range, false); assert.deepEqual(c.gtins, ["3348901368247"]);
    assert.equal(W.cmpMatch(s, c).level, "name");
  });
});
