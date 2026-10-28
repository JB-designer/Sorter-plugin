import assert from "node:assert/strict";
import test from "node:test";

import { applyFiltersAndSort, normalizeRules } from "../src/core/sort.js";
import { buildBucketState } from "../src/core/buckets.js";

const catalog = [
  { id: "likes", type: "number", label: "Likes" },
  { id: "views", type: "number", label: "Views" }
];
const card = (title, metrics, sourcePage, discoveryOrder) => ({ title, metrics, sourcePage, discoveryOrder });

test("fix 1: a single grouped rule still sorts by the exact number", () => {
  const values = [9241, 9659, 9070, 9066, 9957, 8227, 8201, 8198, 120, 5000, 7400, 9999];
  const items = values.map((likes, i) => card("c" + i, { likes }, 1 + Math.floor(i / 4), i % 4));
  const bucketState = buildBucketState(items, catalog, {});
  const sorted = applyFiltersAndSort(items, [{ field: "likes", direction: "desc", mode: "bucket" }], { fieldCatalog: catalog, bucketState });
  assert.deepEqual(sorted.map((c) => c.metrics.likes), [...values].sort((a, b) => b - a));
});

test("fix 1: the last rule is exact, earlier rules keep their grouping", () => {
  const rules = normalizeRules([
    { field: "likes", mode: "bucket" },
    { field: "views", mode: "bucket" },
    { field: "off", mode: "bucket", enabled: false }
  ]);
  assert.deepEqual(rules.map((r) => r.mode), ["bucket", "exact"]);
  assert.equal(normalizeRules([{ field: "likes", mode: "bucket" }])[0].mode, "exact");
});

test("fix 2: equal values keep the site's order (page, then position), not interleaved pages", () => {
  const items = [];
  for (let page = 1; page <= 3; page += 1) for (let pos = 0; pos < 3; pos += 1) items.push(card(`p${page}#${pos}`, { likes: 0 }, page, pos));
  const shuffled = [items[4], items[8], items[0], items[6], items[2], items[7], items[1], items[5], items[3]];
  const sorted = applyFiltersAndSort(shuffled, [{ field: "likes", direction: "desc" }], { fieldCatalog: catalog });
  assert.deepEqual(sorted.map((c) => c.title), ["p1#0", "p1#1", "p1#2", "p2#0", "p2#1", "p2#2", "p3#0", "p3#1", "p3#2"]);
});

test("fix 2: ties without page info fall back to position, then input order", () => {
  const items = [card("b", { likes: 1 }, undefined, 1), card("a", { likes: 1 }, undefined, 0), card("c", { likes: 1 }), card("d", { likes: 1 })];
  const sorted = applyFiltersAndSort(items, [{ field: "likes", direction: "desc" }], { fieldCatalog: catalog });
  assert.deepEqual(sorted.map((c) => c.title), ["a", "b", "c", "d"]);
});
