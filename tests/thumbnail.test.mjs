import assert from "node:assert/strict";
import test from "node:test";

import "../src/shared/alignment-engine.js";
import { el, makeDocument } from "./mini-dom.mjs";

const engine = globalThis.CardSorterEngine;

// 每张卡片:封面区 + 标题 + 价格;cover(i) 决定封面区里放什么图
function cards(count, cover) {
  const list = [];
  for (let i = 0; i < count; i += 1) {
    list.push(el("li", { class: "col" }, [el("article", { class: "post" }, [
      el("a", { href: `/p/${i}` }, cover(i)),
      el("h3", {}, [el("a", { href: `/p/${i}` }, [`Post title ${i}`])]),
      el("p", { class: "price" }, [`$${10 + i * 3}.50`])
    ])]));
  }
  return engine.discover(makeDocument(el("body", {}, [el("ol", { class: "row" }, list)]), "https://example.com/list"));
}

function thumbs(result) {
  return result.items.map((item) => item.thumbnailUrl);
}

test("lazy image: the real address in data-src beats a shared svg placeholder in src", () => {
  const result = cards(6, (i) => [el("img", { src: "/theme/images/t1.svg", "data-src": `/uploads/${i}.jpg` })]);
  assert.deepEqual(thumbs(result), [0, 1, 2, 3, 4, 5].map((i) => `https://example.com/uploads/${i}.jpg`));
});

test("lazy image: a data: gif in src falls through to data-original", () => {
  const result = cards(6, (i) => [el("img", { src: "data:image/gif;base64,R0lGODlhAQABAAAAACw=", "data-original": `/c/${i}.png` })]);
  assert.equal(result.items[2].thumbnailUrl, "https://example.com/c/2.png");
});

test("plain images keep working, and data-src equal to src is fine", () => {
  const plain = cards(6, (i) => [el("img", { src: `/img/${i}.jpg` })]);
  assert.equal(plain.items[3].thumbnailUrl, "https://example.com/img/3.jpg");
  const same = cards(6, (i) => [el("img", { src: `/img/${i}.jpg`, "data-src": `/img/${i}.jpg` })]);
  assert.equal(same.items[3].thumbnailUrl, "https://example.com/img/3.jpg");
});

test("a small author avatar before the cover is skipped", () => {
  const result = cards(6, (i) => [
    el("img", { class: "avatar", src: "/u/1.jpg", width: "20", height: "20" }),
    el("img", { src: `/cover/${i}.jpg` })
  ]);
  assert.equal(result.items[0].thumbnailUrl, "https://example.com/cover/0.jpg");
});

test("a card with only a placeholder gets no thumbnail, so the letter tile shows", () => {
  const result = cards(6, () => [el("img", { src: "/assets/loading.gif" })]);
  assert.ok(thumbs(result).every((url) => url === ""));
});

test("<picture><source srcset> is read", () => {
  const result = cards(6, (i) => [el("picture", {}, [el("source", { srcset: `/w/${i}.webp 1x, /w/${i}@2x.webp 2x` })])]);
  assert.equal(result.items[1].thumbnailUrl, "https://example.com/w/1.webp");
});

test("thumbnail changes never change which cards are kept or their numbers", () => {
  const before = cards(6, (i) => [el("img", { src: `/img/${i}.jpg` })]);
  const after = cards(6, (i) => [el("img", { src: "/theme/t1.svg", "data-src": `/img/${i}.jpg` })]);
  assert.equal(after.items.length, before.items.length);
  assert.deepEqual(after.items.map((x) => x.metrics), before.items.map((x) => x.metrics));
});
