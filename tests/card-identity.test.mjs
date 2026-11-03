import assert from "node:assert/strict";
import test from "node:test";

import "../src/shared/alignment-engine.js";
import { el, makeDocument } from "./mini-dom.mjs";

const engine = globalThis.CardSorterEngine;

function page(cards, url = "https://example.com/home") {
  return makeDocument(el("body", {}, [el("div", { class: "feed" }, cards)]), url);
}

// 作者 + 发帖时间的帖子:头像、名字、账号都链到作者主页,只有时间链到帖子本身
function post(i) {
  const author = `writer${i % 4}`;
  return el("article", { class: "post" }, [
    el("a", { href: `/${author}` }, [el("img", { src: `/avatars/${author}.jpg`, alt: "" })]),
    el("div", { class: "header" }, [
      el("a", { href: `/${author}` }, [el("span", { class: "user-name" }, [`Writer number ${i % 4}`])]),
      el("a", { href: `/${author}` }, [`@${author}`]),
      el("a", { href: `/${author}/status/${1000 + i}` }, [el("time", { datetime: "2026-11-03T08:00:00Z" }, [`${i + 1}h`])])
    ]),
    el("div", { class: "body" }, [`Post body text ${i}`]),
    el("div", { class: "actions" }, [
      el("span", { class: "likes" }, [`${100 + i * 7} likes`]),
      el("span", { class: "shares" }, [`${10 + i} shares`])
    ])
  ]);
}

test("a post with an author link and a time link opens the post, not the author", () => {
  const result = engine.discover(page(Array.from({ length: 12 }, (_, i) => post(i))));
  assert.equal(result.items.length, 12);
  assert.equal(result.items[5].videoUrl, "https://example.com/writer1/status/1005");
});

// 预览文字(不用作者名)靠页面布局判断,mini-dom 没有布局,所以在样本页上验证,不在这里测

test("posts by the same author are not merged as duplicates", () => {
  const result = engine.discover(page(Array.from({ length: 12 }, (_, i) => post(i))));
  const urls = new Set(result.items.map((item) => item.videoUrl));
  assert.equal(urls.size, 12);
});
