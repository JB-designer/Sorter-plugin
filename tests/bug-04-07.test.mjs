import assert from "node:assert/strict";
import test from "node:test";

import "../src/shared/alignment-engine.js";
import { el, makeDocument } from "./mini-dom.mjs";
import { fieldName } from "../src/core/result-view.js";
import { makePageUrlTemplates } from "../src/core/pagination.js";
import { detectTotalPages, totalFromText } from "../src/core/page-range.js";

const engine = globalThis.CardSorterEngine;
const WORDS = ["One", "Two", "Three", "Four", "Five"];

function grid(cards) {
  return makeDocument(el("body", {}, [el("ol", { class: "row" }, cards)]), "https://shop.test/");
}

function sortable(result) {
  return result.candidates.filter((c) => !c.excluded && c.type !== "text");
}

// 书店式卡片:价格前面贴着货币符号,星级只写在 class 里
function bookCards(count, rating) {
  const cards = [];
  for (let i = 0; i < count; i += 1) {
    cards.push(el("li", { class: "col" }, [el("article", { class: "product_pod" }, [
      el("a", { href: `/b/${i}` }, [el("img", { src: `/i/${i}.jpg` })]),
      rating(i),
      el("h3", {}, [el("a", { href: `/b/${i}` }, [`Book title ${i}`])]),
      el("p", { class: "price_color" }, [`£${(10 + i * 2.37).toFixed(2)}`])
    ])]));
  }
  return grid(cards);
}

test("bug 04: a price glued to its currency sign is a sortable price", () => {
  const result = engine.discover(bookCards(10, () => el("span", {}, [])));
  const price = sortable(result).find((c) => c.canonicalId === "price");
  assert.ok(price, "£51.77 should be read as a price");
  assert.equal(fieldName(price), "价格");
  assert.equal(result.items[1].metrics[price.id], 12.37);
});

test("bug 05: star ratings written only in the code are read", () => {
  const fromWord = engine.discover(bookCards(10, (i) => el("p", { class: `star-rating ${WORDS[i % 5]}` }, [el("i", { class: "icon-star" }), el("i", { class: "icon-star" })])));
  const rating = sortable(fromWord).find((c) => c.canonicalId === "score");
  assert.ok(rating, "class word Three → 3");
  assert.deepEqual(fromWord.items.slice(0, 5).map((item) => item.metrics[rating.id]), [1, 2, 3, 4, 5]);

  const fromWidth = engine.discover(bookCards(10, (i) => el("div", { class: "rating" }, [el("span", { class: "fill", style: `width: ${20 * ((i % 5) + 1)}%` }, [])])));
  const widthRating = sortable(fromWidth).find((c) => c.canonicalId === "score");
  assert.ok(widthRating, "a filled bar width is a rating");
  assert.equal(fromWidth.items[3].metrics[widthRating.id], 4);

  const fromIcons = engine.discover(bookCards(10, (i) => el("div", { class: "stars" },
    [0, 1, 2, 3, 4].map((k) => el("i", { class: k <= i % 5 ? "star full" : "star empty" }, [])))));
  const iconRating = sortable(fromIcons).find((c) => c.canonicalId === "score");
  assert.ok(iconRating, "counting filled stars gives the rating");
  assert.equal(fromIcons.items[2].metrics[iconRating.id], 3);
});

test("bug 05: a rating already written as a number is not listed twice", () => {
  const doc = bookCards(10, (i) => el("div", { class: "stars" }, [
    ...[0, 1, 2, 3, 4].map((k) => el("i", { class: k <= i % 5 ? "star full" : "star empty" }, [])),
    el("span", { class: "value" }, [`${((i % 5) + 1).toFixed(1)}`])
  ]));
  const ratings = sortable(engine.discover(doc)).filter((c) => /^[1-5]\.0$/.test(c.examples[0]) || c.attr === "rating");
  assert.equal(ratings.length, 1);
});

test("bug 05: random class names are never read as ratings", () => {
  const doc = bookCards(10, (i) => el("div", { class: `badge level-${i}` }, [el("i", { class: "full" }), el("i", { class: "empty" }), el("i", { class: "full" })]));
  assert.ok(!sortable(engine.discover(doc)).some((c) => c.attr === "rating"));
});

test("bug 07: the same number written twice in a card shows up once, with the visible form and a short name", () => {
  const cards = [];
  for (let i = 0; i < 10; i += 1) {
    const size = `${(i + 1) * 7}B`;
    cards.push(el("article", { class: "card" }, [
      el("a", { href: `/m/${i}` }, [el("img", { src: `/i/${i}.jpg` })]),
      el("h4", {}, [`org/model-${i}`]),
      el("div", { class: "meta" }, [el("span", { title: `Number of parameters in the model: ${size}` }, [size]), el("span", {}, [`${(i + 2) * 113}`])])
    ]));
  }
  const result = engine.discover(grid(cards));
  const params = sortable(result).filter((c) => /B$/.test(c.examples[0]));
  assert.equal(params.length, 1, "one field for the model size");
  assert.equal(params[0].canonicalId, "parameters");
  assert.equal(fieldName(params[0]), "参数量");
  assert.equal(params[0].examples[0], "7B");
});

test("bug 07: two different metrics that happen to match are kept apart", () => {
  const cards = [];
  for (let i = 0; i < 10; i += 1) {
    cards.push(el("article", { class: "card" }, [
      el("a", { href: `/m/${i}` }, [el("img", { src: `/i/${i}.jpg` })]),
      el("h4", {}, [`Item ${i}`]),
      el("span", { class: "a" }, [`${i % 2} likes`]),
      el("span", { class: "b" }, [`${i % 2} comments`])
    ]));
  }
  const result = engine.discover(grid(cards));
  assert.ok(sortable(result).some((c) => c.canonicalId === "likes"));
  assert.ok(sortable(result).some((c) => c.canonicalId === "comments"));
});

test("long names from site tooltips are shortened in the menu", () => {
  assert.equal(fieldName({ label: "Number of things a person did here today" }), "Number of things a pe…");
  assert.equal(fieldName({ label: "下载量 Downloads" }), "下载量");
});

test("numbers inside a container whose class mentions title are still numbers", () => {
  const cards = [];
  for (let i = 0; i < 10; i += 1) {
    cards.push(el("div", { class: "grid-item", role: "article" }, [
      el("a", { href: `/p/${i}` }, [el("img", { src: `/i/${i}.jpg` })]),
      el("div", { class: "TitleOwner-titleStatsContainer" }, [
        el("a", { href: `/p/${i}`, class: "Title-title" }, [`Project ${i}`]),
        el("div", { class: "Stats" }, [el("span", {}, [`${(i + 1) * 61}`]), el("span", {}, [`${(i + 1) * 0.7}K`])])
      ])
    ]));
  }
  assert.equal(sortable(engine.discover(grid(cards))).length, 2);
});

test("cards whose picture sits deep inside buttons are still found from their link", () => {
  const deep = (child, levels) => (levels ? el("div", {}, [deep(child, levels - 1)]) : child);
  const cards = [];
  for (let i = 0; i < 8; i += 1) {
    cards.push(el("div", { role: "group" }, [
      el("a", { href: `/experiences/${i}` }, [el("span", {}, [])]),
      deep(el("button", {}, [el("span", {}, [el("div", {}, [el("picture", {}, [el("img", { src: `/i/${i}.jpg` })])])])]), 5),
      el("div", {}, [`Walk number ${i}`]),
      el("div", {}, [`From $${20 + i * 5}`]),
      el("div", {}, [`${(i + 1) * 13} reviews`])
    ]));
  }
  const result = engine.discover(makeDocument(el("body", {}, [el("div", {}, cards.map((c) => el("div", {}, [c])))]), "https://trip.test/s"));
  assert.equal(result.cardCount, 8);
  assert.ok(sortable(result).some((c) => c.canonicalId === "price"));
});

test("bug 06: page addresses like page-2.html are understood", () => {
  const templates = makePageUrlTemplates([{ text: "2", href: "https://books.test/catalogue/page-2.html" }], "https://books.test/");
  assert.equal(templates[0].make(7), "https://books.test/catalogue/page-7.html");
  assert.equal(detectTotalPages([{ text: "2", href: "/catalogue/page-2.html" }, { text: "3", href: "/catalogue/page-3.html" }], "https://books.test/", 1), 3);
});

test("bug 06: page totals written as text are read", () => {
  assert.equal(totalFromText(["Page 1 of 50"]), 50);
  assert.equal(totalFromText(["共 12 页"]), 12);
  assert.equal(totalFromText(["3D 彙整 - 第 2 頁，總計 105 頁"]), 105);
  assert.equal(totalFromText(["Showing 2 of 5 photos"]), null);
});

test("bug 06: page links that repeat the page number elsewhere still group together", () => {
  const base = "https://shop.test/s?k=x";
  const anchors = [2, 3, 4].map((n) => ({ text: String(n), href: `${base}&page=${n}&ref=pg_${n}` }));
  assert.equal(detectTotalPages(anchors, base, 1), 4);
});

test("codes, hidden ids, positions and number fragments move to the can't-sort list", () => {
  const cards = [];
  for (let i = 0; i < 10; i += 1) {
    const price = (5 + i * 1.37).toFixed(2);
    cards.push(el("article", { class: "card", "data-asin": String(1546176187 + i * 7919) }, [
      el("a", { href: `/p/${i}` }, [el("img", { src: `/i/${i}.jpg`, "data-image-index": String(i + 1) })]),
      el("h4", {}, [`Product ${i}`]),
      el("span", { class: "offscreen" }, [`$${price}`]),
      el("span", { class: "whole" }, [price.split(".")[0]]),
      el("span", { class: "code" }, [`${1793082377961 + i}-qc${i}x`]),
      el("span", { class: "series" }, [`Book ${i + 2} of ${i + 9}: Story ${i}`]),
      el("span", { class: "dl" }, [`${(i + 3) * 211} downloads`])
    ]));
  }
  const result = engine.discover(grid(cards));
  const kept = sortable(result);
  assert.deepEqual(kept.map((c) => c.canonicalId).sort(), ["downloads", "price"]);
  const hidden = result.candidates.filter((c) => c.excludedWhy);
  assert.ok(hidden.some((c) => c.excludedWhy === "code"));
  assert.ok(hidden.some((c) => c.excludedWhy === "fragment"));
});

test("a named measure that is the same on every card is kept (newest list: all downloads 0)", () => {
  const cards = [];
  for (let i = 0; i < 10; i += 1) {
    cards.push(el("article", { class: "card" }, [
      el("a", { href: `/m/${i}` }, [el("img", { src: `/i/${i}.jpg` })]),
      el("h4", {}, [`Mod ${i}`]),
      el("span", { class: "dl" }, [`${i === 9 ? 1 : 0} downloads`])
    ]));
  }
  assert.ok(sortable(engine.discover(grid(cards))).some((c) => c.canonicalId === "downloads"));
});
