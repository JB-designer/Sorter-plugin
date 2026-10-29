import assert from "node:assert/strict";
import test from "node:test";

import "../src/shared/alignment-engine.js";
import { el, makeDocument } from "./mini-dom.mjs";
import { makeRule } from "../src/core/rules.js";

const engine = globalThis.CardSorterEngine;
const TOPICS = ["Garden", "Travel", "Cooking"];

function page(cards, url = "https://example.com/list") {
  return makeDocument(el("body", {}, [el("div", { class: "grid" }, cards)]), url);
}

// 整张卡片就是一个链接;meta 行里分类标签可有可无,有的时候浏览数前面多一个 "·"
function linkCard(i, { topic = false, inner = null } = {}) {
  const meta = [];
  if (topic) meta.push(el("span", { class: "tag" }, [TOPICS[i % 3]]));
  const views = [el("span", {}, [`${(1000 + i * 137).toLocaleString("en-US")} views`])];
  if (topic) views.unshift(el("span", {}, ["·"]));
  meta.push(el("span", { class: "dot" }, views));
  meta.push(el("span", { class: "dot" }, [el("span", {}, ["·"]), el("span", {}, [`${i + 1} hours ago`])]));
  const children = [
    el("div", { class: "cover" }, [el("img", { src: `/img/${i}.jpg`, alt: "" })]),
    el("h3", {}, [`Sample post number ${i}`]),
    el("div", { class: "meta" }, meta)
  ];
  if (inner) children.push(inner);
  return el("a", { href: `/v/item-${i}`, class: "card" }, children);
}

function viewsFields(result) {
  return result.candidates.filter((c) => !c.excluded && c.canonicalId === "views");
}

test("a card that is itself the link opens its own page", () => {
  const result = engine.discover(page(Array.from({ length: 26 }, (_, i) => linkCard(i))));
  assert.equal(result.items.length, 26);
  assert.equal(result.items[4].videoUrl, "https://example.com/v/item-4");
});

test("the card's own link wins over a smaller link inside it", () => {
  const cards = Array.from({ length: 26 }, (_, i) => linkCard(i, { inner: el("a", { href: `/topic/${i % 3}` }, ["More in this topic"]) }));
  const result = engine.discover(page(cards));
  assert.equal(result.items[7].videoUrl, "https://example.com/v/item-7");
});

test("the same number split by an optional tag becomes one field on every card", () => {
  const cards = Array.from({ length: 26 }, (_, i) => linkCard(i, { topic: i < 10 }));
  const result = engine.discover(page(cards));
  const views = viewsFields(result);
  assert.equal(views.length, 1);
  assert.equal(views[0].coverage.count, 26);
  assert.ok(views[0].preChecked);
  assert.ok(result.items.every((item, i) => item.metrics[views[0].id] === 1000 + i * 137));
});

test("a small split piece (under 30% of cards) is still merged in", () => {
  const cards = Array.from({ length: 26 }, (_, i) => linkCard(i, { topic: i < 3 }));
  const result = engine.discover(page(cards));
  const views = viewsFields(result);
  assert.equal(views.length, 1);
  assert.ok(result.items.every((item) => item.metrics[views[0].id] != null));
});

test("two different numbers with the same meaning on one card are never merged", () => {
  const cards = Array.from({ length: 26 }, (_, i) => el("div", { class: "card" }, [
    el("h3", {}, [el("a", { href: `/v/${i}` }, [`Sample post number ${i}`])]),
    el("p", { class: "a" }, [`${10 + i} views`]),
    el("p", { class: "b" }, [`${5000 + i * 300} views`])
  ]));
  const result = engine.discover(page(cards));
  const views = viewsFields(result);
  assert.equal(views.length, 2);
  assert.ok(views.every((field) => !field.altPaths));
});

test("a saved rule keeps the merged positions for the next pages", () => {
  const first = engine.discover(page(Array.from({ length: 26 }, (_, i) => linkCard(i, { topic: i < 10 }))));
  const rule = makeRule({ url: "https://example.com/list", candidates: first.candidates });
  const next = page(Array.from({ length: 26 }, (_, i) => linkCard(i, { topic: i >= 16 })), "https://example.com/list?page=2");
  const applied = engine.applyRule(next, rule, { pageUrl: "https://example.com/list?page=2", page: 2 });
  const id = viewsFields(first)[0].id;
  assert.equal(applied.fieldCoverage[id].count, 26);
});
