import test from "node:test";
import assert from "node:assert/strict";
import {
  bandOf,
  breaksThreeTimesRule,
  computeBandEdges,
  describeBands,
  distinctSorted,
  looksLikeStarRating
} from "../src/core/bands.js";
import { buildBucketState } from "../src/core/buckets.js";
import { applyFiltersAndSort } from "../src/core/sort.js";

function groups(values, edges) {
  const g = new Map();
  for (const v of values) {
    const b = bandOf(v, edges);
    if (!g.has(b)) g.set(b, []);
    g.get(b).push(v);
  }
  return g;
}

const sig = (e) => (e === 0 ? 1 : Math.abs(e).toExponential().split("e")[0].replace(".", "").replace("-", "").replace(/0+$/, "").length);

test("bands: fewer than 10 cards or 7 or fewer distinct values -> exact", () => {
  assert.deepEqual(computeBandEdges([4210, 380, 9100, 12500, 395, 4480, 51, 12000]), [380, 395, 4210, 4480, 9100, 12000, 12500]);
  const fewValues = Array.from({ length: 50 }, (_, i) => [1, 2, 3, 5, 8, 13, 21][i % 7]);
  assert.deepEqual(computeBandEdges(fewValues), [2, 3, 5, 8, 13, 21]);
  assert.deepEqual(computeBandEdges(Array(40).fill(1234)), []);
});

test("bands: the 3x jump is always an edge (90% at 1-10, 10% at 5,000-6,000)", () => {
  const values = [];
  for (let i = 0; i < 135; i += 1) values.push(1 + (i % 10));
  for (let i = 0; i < 15; i += 1) values.push(5000 + i * 61);
  const edges = computeBandEdges(values);
  assert.notEqual(bandOf(10, edges), bandOf(5000, edges));
  const top = Math.max(...[...groups(values, edges).keys()]);
  assert.ok(groups(values, edges).get(top).every((v) => v >= 5000), "all 5,000+ cards are in the top band(s)");
});

test("bands: a giant outlier gets its own top band", () => {
  const values = Array.from({ length: 149 }, (_, i) => 100 + ((i * 53) % 901));
  values.push(2000000);
  const edges = computeBandEdges(values);
  const g = groups(values, edges);
  assert.deepEqual(g.get(Math.max(...g.keys())), [2000000]);
});

test("bands: labels are round ranges, single values stay single, top band ends on a round number", () => {
  const values = [41200, 48600, 44100, 31500, 37900, 35000, 29900, 22300, 21000, 25000, 23000, 18000, 15000, 12000, 9000, 8000, 5000, 3000, 2000, 1000];
  const bands = describeBands(values, computeBandEdges(values));
  assert.equal(bands[0].label, "40,000–49,900");
  assert.equal(bands[1].label, "30,000–39,900");
  assert.equal(bands.reduce((sum, band) => sum + band.count, 0), values.length);
  const single = describeBands([10, 10, 10, 3], [10]);
  assert.equal(single[0].label, "10");
  for (const band of bands) assert.doesNotMatch(band.label, /档|分组|group|band/i);
});

test("bands: star ratings are recognised and kept exact", () => {
  assert.equal(looksLikeStarRating([4.7, 4.6, 3.9, 5]), true);
  assert.equal(looksLikeStarRating([4, 5, 3], "评分"), true);
  assert.equal(looksLikeStarRating([4, 5, 3], "Downloads"), false);
  assert.equal(looksLikeStarRating([4.7, 120]), false);
  const items = Array.from({ length: 30 }, (_, i) => ({ metrics: { rating: Number((3 + (i % 21) / 10).toFixed(1)) } }));
  const state = buildBucketState(items, [{ id: "rating", label: "Rating", type: "number" }]);
  assert.equal(state.fields.rating.exact, true);
  assert.equal(state.fields.rating.exactReason, "rating");
});

test("bands: sorting by bands then likes never puts a 3x bigger number below", () => {
  const values = Array.from({ length: 200 }, (_, i) => Math.round(10 ** (5.7 * ((i * 7919) % 200 / 200) ** 2.2)));
  const items = values.map((dl, i) => ({ title: `m${i}`, sourcePage: 1 + Math.floor(i / 20), discoveryOrder: i % 20, metrics: { dl, likes: (i * 37) % 800 } }));
  const catalog = [{ id: "dl", type: "number", label: "Downloads" }, { id: "likes", type: "number", label: "Likes" }];
  const bucketState = buildBucketState(items, catalog);
  const sorted = applyFiltersAndSort(items, [{ field: "dl", direction: "desc", mode: "bucket" }, { field: "likes", direction: "desc", mode: "exact" }], { fieldCatalog: catalog, bucketState });
  const dl = sorted.map((item) => item.metrics.dl);
  for (let i = 0; i < dl.length; i += 1) {
    for (let j = i + 1; j < dl.length; j += 1) {
      assert.ok(!(dl[j] >= 10 && dl[j] > 3 * dl[i]), `${dl[j]} sits below ${dl[i]}`);
    }
  }
});

// 性质测试:3,000 个随机列表(与第 6 轮工程师报告相同的 7 类生成器)
test("bands: property test on 3,000 random lists", () => {
  let seed = 9;
  const r = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const gens = [
    () => Math.round(10 ** (6 * r() ** 2)),
    () => Math.round(9000 + 1000 * r()),
    () => (r() < 0.9 ? 1 + Math.floor(10 * r()) : 5000 + Math.floor(1000 * r())),
    () => Math.round(r() * 50) * 100,
    () => (r() < 0.5 ? Math.floor(r() * 5) : Math.floor(r() * 3e6)),
    () => Math.round(r() * 20 - 10),
    () => Math.round(r() * 1000) / 10
  ];
  const problems = { overlap: 0, rule3x: 0, crowded: 0, orderDependent: 0, notRound: 0, over12Narrow: 0 };
  let lists = 0;
  for (let t = 0; t < 3000; t += 1) {
    const n = 10 + Math.floor(r() * 400);
    const values = Array.from({ length: n }, gens[t % gens.length]);
    const d = distinctSorted(values);
    if (d.length <= 1) continue;
    lists += 1;
    const edges = computeBandEdges(values);
    if (JSON.stringify(edges) !== JSON.stringify(computeBandEdges([...values].reverse()))) problems.orderDependent += 1;
    const g = groups(values, edges);
    const keys = [...g.keys()].sort((a, b) => a - b);
    for (let i = 1; i < keys.length; i += 1) {
      if (Math.max(...g.get(keys[i - 1])) >= Math.min(...g.get(keys[i]))) problems.overlap += 1;
    }
    for (const vs of g.values()) {
      if (vs.length > 0.35 * n && new Set(vs).size > 1) { problems.crowded += 1; break; }
    }
    for (const vs of g.values()) {
      if (breaksThreeTimesRule(vs)) { problems.rule3x += 1; break; }
    }
    if (edges.some((x) => !d.includes(x) && sig(x) > 2 && !(sig(x) === 3 && /5$/.test(String(Math.abs(x)).replace(/0+$/, "").replace(".", ""))))) problems.notRound += 1;
    const positive = d.filter((x) => x > 0);
    const spread = positive.length ? positive[positive.length - 1] / positive[0] : 1;
    if (g.size > 12 && spread < 1e5) problems.over12Narrow += 1;
  }
  assert.ok(lists > 2900);
  assert.deepEqual(problems, { overlap: 0, rule3x: 0, crowded: 0, orderDependent: 0, notRound: 0, over12Narrow: 0 });
});
