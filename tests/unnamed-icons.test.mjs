import assert from "node:assert/strict";
import test from "node:test";

import "../src/shared/alignment-engine.js";
import { el, makeDocument } from "./mini-dom.mjs";
import { fieldName } from "../src/core/result-view.js";
import { makeRule } from "../src/core/rules.js";

const engine = globalThis.CardSorterEngine;

const ARROW = () => el("svg", { viewBox: "0 0 24 24", class: "x1" }, [el("path", { d: "M12 3v12m-5-5l5 5 5-5", stroke: "#ff0000", onclick: "alert(1)" })]);
const STAR = () => el("svg", { viewBox: "0 0 24 24" }, [el("path", { d: "M12 2l3 6 6 1-5 4 1 6-5-3-5 3 1-6-5-4 6-1z", fill: "#123456" })]);

// 图标没有任何名字线索的卡片(像 3D 模型站):⬇ 773 · ☆ 4.9
function iconCards(count) {
  const cards = [];
  for (let i = 0; i < count; i += 1) {
    cards.push(el("article", { class: "card" }, [
      el("a", { href: `/m/${i}` }, [el("img", { src: `/t/${i}.jpg`, width: "300", height: "200" })]),
      el("h3", { class: "title" }, [`Model number ${i}`]),
      el("div", { class: "stats" }, [
        el("span", { class: "a1" }, [ARROW()]),
        el("span", { class: "b2" }, [String(100 + i * 37)]),
        el("span", { class: "a1" }, [STAR()]),
        el("span", { class: "c3" }, [`${(3 + (i % 3) * 0.5).toFixed(1)}`])
      ])
    ]));
  }
  return makeDocument(el("body", {}, [el("main", { class: "grid" }, cards)]), "https://models.test/list");
}

test("a number with no name keeps a safe copy of the card's own icon", () => {
  const result = engine.discover(iconCards(8));
  const sortable = result.candidates.filter((c) => !c.excluded);
  assert.equal(sortable.length, 2, JSON.stringify(sortable.map((c) => c.examples)));
  for (const candidate of sortable) {
    assert.equal(candidate.label, "");
    assert.equal(candidate.icon?.kind, "svg");
    assert.match(candidate.icon.markup, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 24 24">/);
    assert.doesNotMatch(candidate.icon.markup, /onclick|class=|#ff0000|#123456/);
  }
  const [first, second] = sortable;
  assert.notEqual(first.icon.markup, second.icon.markup, "each number keeps its own icon");
});

test("the icon is saved with the site settings", () => {
  const result = engine.discover(iconCards(6));
  const rule = makeRule({ url: "https://models.test/list", candidates: result.candidates });
  assert.ok(rule.slots.filter((s) => !s.excluded).every((s) => s.icon && s.icon.kind === "svg"));
});

test("unnamed numbers never show the internal code", () => {
  assert.equal(fieldName({ id: "metric-6-o5wvj", label: "" }), "数字");
  assert.equal(fieldName({ id: "metric-6-o5wvj", label: "", exampleValue: "773" }), "数字（如 773）");
  assert.equal(fieldName({ id: "likes-abc", label: "点赞数 Likes" }), "点赞数");
});

test("a hint with two different meanings is not guessed; synonyms still are", () => {
  function hinted(cls) {
    const cards = [];
    for (let i = 0; i < 6; i += 1) {
      cards.push(el("article", { class: "card" }, [
        el("a", { href: `/i/${i}` }, [el("img", { src: `/t/${i}.jpg`, width: "300", height: "200" })]),
        el("h3", { class: "title" }, [`Item ${i}`]),
        el("div", { class: "row" }, [el("i", { class: cls }), String(10 + i * 7)])
      ]));
    }
    const doc = makeDocument(el("body", {}, [el("main", {}, cards)]), "https://hint.test/");
    return engine.discover(doc).candidates.filter((c) => !c.excluded);
  }
  assert.equal(hinted("icon-download")[0].canonicalId, "downloads");
  assert.equal(hinted("stats download share")[0].canonicalId, "", "download + share: don't guess");
  assert.equal(hinted("icon-dislike")[0].canonicalId, "dislikes");
  assert.equal(hinted("heart like")[0].canonicalId, "likes", "heart + like mean the same thing");
});

test("two numbers guessed to the same name both fall back to icons", () => {
  const cards = [];
  for (let i = 0; i < 6; i += 1) {
    cards.push(el("article", { class: "card" }, [
      el("a", { href: `/i/${i}` }, [el("img", { src: `/t/${i}.jpg`, width: "300", height: "200" })]),
        el("h3", { class: "title" }, [`Item ${i}`]),
      el("div", { class: "r1" }, [el("i", { class: "icon-download" }), String(10 + i * 7)]),
      el("div", { class: "r2" }, [el("i", { class: "fa-download-alt" }), String(500 + i * 3)])
    ]));
  }
  const doc = makeDocument(el("body", {}, [el("main", {}, cards)]), "https://dup.test/");
  const sortable = engine.discover(doc).candidates.filter((c) => !c.excluded);
  assert.equal(sortable.length, 2);
  assert.ok(sortable.every((c) => c.label === "" && c.canonicalId === ""), JSON.stringify(sortable.map((c) => c.label)));
});

test("new words in the list name numbers: makes, shares, followers", () => {
  function labelled(word) {
    const cards = [];
    for (let i = 0; i < 6; i += 1) {
      cards.push(el("article", { class: "card" }, [
        el("a", { href: `/i/${i}` }, [el("img", { src: `/t/${i}.jpg`, width: "300", height: "200" })]),
        el("h3", { class: "title" }, [`Item ${i}`]),
        el("div", { class: "row" }, [`${word}: ${10 + i * 7}`])
      ]));
    }
    const doc = makeDocument(el("body", {}, [el("main", {}, cards)]), "https://words.test/");
    return engine.discover(doc).candidates.filter((c) => !c.excluded)[0];
  }
  assert.equal(labelled("Makes").canonicalId, "makes");
  assert.equal(labelled("Shares").canonicalId, "shares");
  assert.equal(labelled("粉丝").canonicalId, "followers");
});
