import assert from "node:assert/strict";
import test from "node:test";

import "../src/shared/alignment-engine.js";
import { el, makeDocument } from "./mini-dom.mjs";

const engine = globalThis.CardSorterEngine;

function page(cards, url = "https://example.com/list") {
  return makeDocument(el("body", {}, [el("div", { class: "grid" }, cards)]), url);
}

// 一张卡片拆成并排两块:上面是作品图和标题,下面是作者头像、名字和点赞数
function splitCard(i) {
  return el("div", { class: "shot-box" }, [
    el("div", { class: "card-picture" }, [
      el("figure", {}, [el("img", { src: `/shots/${i}.png`, alt: "" })]),
      el("a", { href: `/works/${i}` }, [el("h4", { class: "work-title" }, [`Poster study ${i}`])])
    ]),
    el("div", { class: "card-details" }, [
      el("a", { href: `/people/${i}` }, [
        el("img", { src: `/avatars/${i}.png`, width: "24", height: "24", class: "avatar" }),
        el("span", { class: "display-name" }, [`Maker ${i}`])
      ]),
      el("span", { class: "likes" }, [`${100 + i * 7}`]),
      el("span", { class: "views" }, [`${(2000 + i * 90).toLocaleString("en-US")}`])
    ])
  ]);
}

test("a card split into a picture half and a numbers half is read as one card", () => {
  const result = engine.discover(page(Array.from({ length: 12 }, (_, i) => splitCard(i))));
  assert.equal(result.items.length, 12);
  assert.equal(result.items[3].title, "Poster study 3");
  assert.equal(result.items[3].thumbnailUrl, "https://example.com/shots/3.png");
  const likes = result.candidates.find((c) => !c.excluded && c.canonicalId === "likes");
  assert.ok(likes, "likes field found");
  assert.equal(result.items[3].metrics[likes.id], 121);
});

// 一排按钮:整排有一段总说明,每个按钮有自己的说明,卡片上看得见的数字有时是缩写
function postCard(i) {
  const replies = 10 + i;
  const reposts = 200 + i * 3;
  const viewsExact = 15000 + i * 1234;
  const viewsShort = (viewsExact / 10000).toFixed(1) + "万";
  return el("article", { class: "post" }, [
    el("img", { src: `/a/${i}.png`, alt: "" }),
    el("div", { class: "post-text" }, [`Notes from the trail, part ${i}`]),
    el("div", { role: "group", "aria-label": `${replies} 回复、${reposts} 次转帖、${viewsExact} 次查看` }, [
      el("button", { "aria-label": `${replies} 回复。回复` }, [el("span", {}, [String(replies)])]),
      el("button", { "aria-label": `${reposts} 次转帖。转帖` }, [el("span", {}, [String(reposts)])]),
      el("a", { href: `/p/${i}/stats`, "aria-label": `${viewsExact} 次查看。查看帖子分析` }, [el("span", {}, [viewsShort])])
    ]),
    el("a", { href: `/p/${i}` }, ["open"])
  ]);
}

test("button names come from each button, not from the whole row's summary", () => {
  const result = engine.discover(page(Array.from({ length: 12 }, (_, i) => postCard(i))));
  const names = result.candidates.filter((c) => !c.excluded && c.type === "number").map((c) => c.siteLabel);
  assert.ok(names.includes("回复"), names.join(" | "));
  assert.ok(names.includes("转帖"), names.join(" | "));
  assert.ok(names.includes("查看"), names.join(" | "));
  assert.ok(names.every((name) => !/、|。/.test(name)), names.join(" | "));
});
