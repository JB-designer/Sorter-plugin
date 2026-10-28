import test from "node:test";
import assert from "node:assert/strict";
import { buildResultView, describePageList, describeSortSentence, formatCardValue } from "../src/core/result-view.js";
import { buildBucketState } from "../src/core/buckets.js";
import { applyFiltersAndSort, normalizeRules } from "../src/core/sort.js";

const catalog = [{ id: "dl", label: "下载量", type: "number" }, { id: "likes", label: "点赞数", type: "number" }];
const downloads = [41200, 48600, 44100, 31500, 37900, 35000, 29900, 22300, 21000, 25000, 23000, 18000, 15000, 12000, 9000, 8000, 5000, 3000, 2000, 1000, null, null];
const items = downloads.map((dl, i) => ({ title: `m${i}`, sourcePage: 1, discoveryOrder: i, metrics: { dl, likes: (i * 397) % 3000 } }));
const rules = [{ field: "dl", direction: "desc", mode: "bucket" }, { field: "likes", direction: "desc", mode: "exact" }];

function view(sortRules = rules) {
  const bucketState = buildBucketState(items, catalog);
  const sorted = applyFiltersAndSort(items, sortRules, { fieldCatalog: catalog, bucketState });
  return buildResultView({ items: sorted, sortRules, fieldCatalog: catalog, bucketState });
}

test("results: a divider at each band start, missing values last, counts add up", () => {
  const v = view();
  assert.equal(v.sections[0].label, "下载量 40,000–49,900");
  assert.equal(v.sections[0].count, 3);
  const last = v.sections[v.sections.length - 1];
  assert.equal(last.kind, "missing");
  assert.equal(last.label, "无下载量");
  assert.equal(last.count, 2);
  assert.equal(v.sections.reduce((sum, s) => sum + s.count, 0), items.length);
  for (const s of v.sections) assert.doesNotMatch(s.label, /档|分组/);
});

test("results: card 1 has nothing bold; a new band bolds downloads; inside a band likes are bold", () => {
  const v = view();
  const entries = v.sections.flatMap((s) => s.entries);
  assert.equal(entries[0].bold, null);
  assert.equal(entries[1].bold, "likes");
  assert.equal(v.sections[1].entries[0].bold, "dl");
  assert.equal(v.hasBold, true);
  assert.equal(v.keyLine, undefined, "no \"bold = …\" line: the dividers explain the order");
  assert.equal(v.sortSentence, "下载量 › 点赞数");
});

test("results: exact first rule has no band dividers but still a missing section", () => {
  const exact = [{ field: "dl", direction: "desc", mode: "exact" }, { field: "likes", direction: "desc" }];
  const v = view(exact);
  assert.equal(v.sections[0].kind, "plain");
  assert.equal(v.sections[v.sections.length - 1].kind, "missing");
  assert.equal(describeSortSentence(normalizeRules(exact), catalog, null), "下载量 › 点赞数");
});

test("results: page list and card values", () => {
  assert.equal(describePageList([1, 2, 3, 5]), "第 1–3、5 页");
  assert.equal(describePageList([7]), "第 7 页");
  assert.equal(formatCardValue({ metrics: { x: 41200 }, metricRaw: { x: "41.2K" } }, { id: "x", type: "number" }), "41.2K");
  assert.equal(formatCardValue({ metrics: { x: 41200 }, metricRaw: { x: "下载 41200" } }, { id: "x", type: "number" }), "41,200");
  assert.equal(formatCardValue({ metrics: {} }, { id: "x", type: "number" }), "—");
});

test("card values keep the site's short forms, including byte sizes", () => {
  const f = { id: "s", type: "number" };
  assert.equal(formatCardValue({ metrics: { s: 27367834 }, metricRaw: { s: "26.1 MB" } }, f), "26.1 MB");
  assert.equal(formatCardValue({ metrics: { s: 41200 }, metricRaw: { s: "41.2K" } }, f), "41.2K");
  assert.equal(formatCardValue({ metrics: { s: 41234 }, metricRaw: { s: "Downloads 41234" } }, f), "41,234");
  assert.equal(formatCardValue({ metrics: {} }, f), "—");
});
