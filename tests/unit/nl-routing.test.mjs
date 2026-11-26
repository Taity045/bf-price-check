// AB-40: natural-language shopping phrases ("iphone with a good camera") go to the AI Shopping Assistant when no
// mode pill is on; product, model and category names stay on the normal search. The page and the server use one rule.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { W } from "../helpers/load-worker.mjs";

const NL = ["iphone with a good camera", "best air fryer", "laptop with long battery", "cheap running watch", "phone with big screen", "phone with a big screen",
  "laptop with long battery life", "laptop that can run games", "tv that has hdmi 2.1", "earbuds good for the gym", "cheapest ps5", "affordable fridge", "reliable washing machine",
  "top headphones", "great earbuds", "good tablet", "what tablet should i get", "which phone has the best camera", "looking for a kettle", "need a laptop", "want a tv",
  "recommend a phone", "budget laptop", "samsung phone with good battery", "headphones with strong noise cancelling", "Best air fryer", "IPHONE WITH A GOOD CAMERA"];
const PLAIN = ["iphone 16", "iphone 18 pro", "garmin forerunner 265", "coca cola", "ps5 slim", "gaming laptops", "running watches", "air fryers", "tvs", "samsung 65 inch tv", "coffee",
  "best PS5 deals", "Case for iPhone 16", "Charger for MacBook Air", "iPhone 16 Pro 256GB", "Samsung Galaxy S25 Ultra 256GB", "Sony WH-1000XM5", "Jungle Oats 1 kg", "Kitkat white chocolate"];

const page = readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");
const pageRe = (0, eval)(page.match(/const ASK_RE = (\/.+\/i);\n/)[1]);

describe("AB-40: natural-language auto-routing", () => {
  test("natural shopping phrases use the assistant", () => { for (const q of NL) assert.equal(W.asIsAssist(q), true, q); });
  test("product, model and category names stay on the normal search", () => { for (const q of PLAIN) assert.equal(W.asIsAssist(q), false, q); });
  test("the page rule agrees with the server for every phrase", () => {
    assert.equal(pageRe.source, W.AS_ASK_RE.source);
    for (const q of [...NL, ...PLAIN]) assert.equal(pageRe.test(q), W.asIsAssist(q), q);
  });
  test("pills: Find a product forces the normal search, Ask AI forces the assistant, no pill uses the rule", () => {
    assert.match(page, /mode === "ai" \|\| OFF_RE\.test\(s\) \|\| \(mode !== "find" && ASK_RE\.test\(s\)\)/);
  });
  test("a search with no result and 3 or more words offers Ask AI instead", () => {
    assert.match(page, /<button type="button" class="aigo hidden" id="sAskAi">Ask AI instead<\/button>/);
    const rj = readFileSync(new URL("../../public/result.js", import.meta.url), "utf8");
    assert.match(rj, /\$\("sAskAi"\)\.classList\.toggle\("hidden", !\(empty && shops\.length && q\.split\(" "\)\.length >= 3\)\)/);
    assert.match(rj, /\$\("sAskAi"\)\.onclick = \(\) => \{ \$\("u"\)\.value = q; assist\(q, c\); \};/);
  });
});
