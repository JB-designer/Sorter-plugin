import assert from "node:assert/strict";
import test from "node:test";

import "../src/shared/alignment-engine.js";
import { el, makeDocument } from "./mini-dom.mjs";
import { makeRuleKey, normalizePathSkeleton, makeRule } from "../src/core/rules.js";
import { buildBucketState, getBucketRank } from "../src/core/buckets.js";

const engine = globalThis.CardSorterEngine;

/* ------------------------- 测试页面构造 ------------------------- */

function makeCard(index) {
  return el("li", { class: "video-item" }, [
    el("a", { href: `/watch/${1000 + index}` }, [
      el("img", { src: `/thumb/${index}.jpg`, alt: `视频 ${index}` })
    ]),
    el("h3", { class: "title" }, [
      el("a", { href: `/watch/${1000 + index}` }, [`测试标题 ${index} 示例`])
    ]),
    el("span", { class: "dur" }, [`${10 + index}:3${index % 10}`]),
    el("div", { class: "meta" }, [
      el("span", { class: "fv" }, [
        el("i", { class: "icon icon-star" }),
        String((index + 1) * 137)
      ]),
      el("span", { class: "stats" }, [`热度: ${(index + 1) * 50} 收藏: ${(index + 2) * 13} 留言: ${index}`]),
      el("span", { class: "added" }, [`${index + 1}天前`]),
      el("span", { class: "author" }, [`用户${index}`])
    ])
  ]);
}

function makeListingDocument(cardCount = 12) {
  const cards = [];
  for (let i = 0; i < cardCount; i += 1) cards.push(makeCard(i));
  const root = el("body", {}, [
    el("nav", {}, [
      el("ul", {}, [
        el("li", { class: "video-item" }, [
          "导航假卡片 ",
          el("a", { href: "/hot" }, ["当前最热"])
        ])
      ])
    ]),
    el("ul", { class: "list" }, cards),
    el("footer", {}, ["页脚 123"])
  ]);
  return makeDocument(root, "https://example.test/videos?page=2");
}

/* ------------------------- 引擎纯函数 ------------------------- */

test("engine parses compact numbers, byte sizes, durations and dates", () => {
  assert.equal(engine.parseNumber("3.2万"), 32000);
  assert.equal(engine.parseNumber("1,234"), 1234);
  assert.equal(engine.parseNumber("1.5K"), 1500);
  assert.equal(engine.parseNumber("2.5 MB"), Math.round(2.5 * 1024 * 1024));
  assert.equal(engine.parseDurationSeconds("1:02:03"), 3723);
  assert.equal(engine.parseDurationSeconds("12:34"), 754);
  assert.ok(engine.parseDateIso("3天前"));
  assert.ok(engine.parseDateIso("2026-07-01T08:00:00Z"));
  assert.equal(engine.parseDateIso("不是日期"), null);
});

test("slot type detection prefers date/duration over plain number", () => {
  assert.equal(engine.detectSlotType(["2026-01-02", "2026-03-04", "2025-12-31"]).type, "date");
  assert.equal(engine.detectSlotType(["12:30", "1:02:03", "45:00"]).type, "duration");
  assert.equal(engine.detectSlotType(["收藏 12", "收藏 3.4万", "收藏 99"]).type, "number");
  assert.equal(engine.detectSlotType(["苹果", "香蕉", "橘子"]).type, "text");
});

test("label diff separates constant label from changing value", () => {
  assert.equal(engine.extractLabelPart("收藏: 1234", "number"), "收藏");
  assert.equal(engine.extractLabelPart("Downloads 45", "number"), "Downloads");
  assert.equal(engine.extractLabelPart("9,861 views", "number"), "views");
});

/* ------------------------- 发现模式 ------------------------- */

test("discover finds the repeated card cluster and skips nav/footer", () => {
  const doc = makeListingDocument(12);
  const result = engine.discover(doc, { pageUrl: doc.location.href });

  assert.equal(result.ok, true);
  assert.equal(result.cardCount, 12);
  assert.ok(result.signature.includes("li"));
  assert.equal(result.items.length, 12);
});

test("discover surfaces favorites/heat/comments via label diff with full coverage", () => {
  const doc = makeListingDocument(12);
  const result = engine.discover(doc, { pageUrl: doc.location.href });

  // "热度: 50 收藏: 26 留言: 0" 是同一文本节点 → 复合拆分产出 text-pair 来源
  const favorites = result.candidates.find((c) => c.canonicalId === "favorites" && c.source === "text-pair");
  assert.ok(favorites, "favorites candidate should exist");
  assert.equal(favorites.type, "number");
  assert.equal(favorites.coverage.count, 12);
  assert.equal(favorites.excluded, false);

  const heat = result.candidates.find((c) => c.canonicalId === "heat");
  assert.ok(heat, "heat candidate should exist");

  const comments = result.candidates.find((c) => c.canonicalId === "comments");
  assert.ok(comments, "comments candidate should exist");
});

test("discover classifies duration and relative date slots", () => {
  const doc = makeListingDocument(12);
  const result = engine.discover(doc, { pageUrl: doc.location.href });

  assert.ok(result.candidates.some((c) => c.type === "duration" && !c.excluded));
  assert.ok(result.candidates.some((c) => c.type === "date" && !c.excluded));
});

test("titles and author names never become sortable candidates", () => {
  const doc = makeListingDocument(12);
  const result = engine.discover(doc, { pageUrl: doc.location.href });

  for (const candidate of result.candidates) {
    if (candidate.excluded) continue;
    const example = String(candidate.examples[0] || "");
    assert.ok(!example.includes("测试标题"), `title leaked into sortable: ${example}`);
    assert.ok(!example.includes("用户"), `author leaked into sortable: ${example}`);
  }
});

test("discovered items carry parsed metric values", () => {
  const doc = makeListingDocument(12);
  const result = engine.discover(doc, { pageUrl: doc.location.href });
  const favorites = result.candidates.find((c) => c.canonicalId === "favorites" && c.source === "text-pair");
  const item3 = result.items[3];

  assert.equal(item3.metrics[favorites.id], (3 + 2) * 13);
  assert.ok(item3.videoUrl.includes("/watch/1003"));
  assert.ok(item3.metrics.uploadDate, "canonical uploadDate alias should be set");
  assert.ok(item3.metrics.durationSeconds, "canonical durationSeconds alias should be set");
});

/* ------------------------- 规则套用与点选取数 ------------------------- */

test("applyRule re-extracts items with saved slots and reports coverage", () => {
  const doc = makeListingDocument(12);
  const discovered = engine.discover(doc, { pageUrl: doc.location.href });
  const rule = makeRule({
    url: doc.location.href,
    cardSignature: discovered.signature,
    candidates: discovered.candidates
  });

  const applied = engine.applyRule(doc, rule, { pageUrl: doc.location.href });
  assert.equal(applied.ok, true);
  assert.equal(applied.healthy, true);
  assert.equal(applied.items.length, 12);

  const enabledSlots = rule.slots.filter((slot) => slot.enabled && !slot.excluded);
  assert.ok(enabledSlots.length >= 3);
  for (const slot of enabledSlots) {
    assert.ok(applied.fieldCoverage[slot.id].count >= 9, `${slot.id} coverage too low`);
  }
});

test("generalizeFromElement builds a candidate from a clicked value element", () => {
  const doc = makeListingDocument(12);
  const cards = doc.querySelectorAll("li[class*='video-item']").filter((c) => c.querySelector("img"));
  const statsSpan = cards[5].querySelector("[class*='stats']");

  const picked = engine.generalizeFromElement(doc, statsSpan);
  assert.equal(picked.ok, true);
  // 复合文本(热度/收藏/留言)一次拆出多个候选
  assert.ok(picked.candidates.length >= 2, "composite text should yield multiple candidates");
  for (const candidate of picked.candidates) {
    assert.equal(candidate.source, "picker");
    assert.equal(candidate.coverage.count, 12);
    assert.notEqual(candidate.type, "text");
  }
  assert.ok(picked.candidates.some((c) => c.canonicalId === "favorites"));
});

test("generalizeFromElement rejects text-only elements", () => {
  const doc = makeListingDocument(12);
  const cards = doc.querySelectorAll("li[class*='video-item']").filter((c) => c.querySelector("img"));
  const author = cards[2].querySelector("[class*='author']");

  const picked = engine.generalizeFromElement(doc, author);
  assert.equal(picked.ok, false);
  assert.ok(["not-sortable-text", "not-sortable-type", "no-value-text"].includes(picked.reason));
});

/* ------------------------- 论坛式结构(纯文本节点 + br + 图标计数) ------------------------- */

function makeBareTextCard(i) {
  return el("div", { class: "well" }, [
    el("a", { href: `/watch.php?id=key${i}&page=1` }, [
      el("img", { src: `/t/${i}.jpg` }),
      el("span", { class: "duration" }, [`00:1${i % 10}:2${i % 10}`])
    ]),
    el("a", { href: `/watch.php?id=key${i}&page=1`, class: "video-title" }, [`帖子标题第${i}篇示例内容`]),
    `Added: ${i + 1} d   From: user${i}`,
    el("br"),
    `Views: ${(i + 1) * 700} Favorites: ${(i + 2) * 55}`,
    el("br"),
    `Comments: ${i * 3} Point: 2000`,
    el("img", { src: "https://x.test/images/like.png" }),
    `${(i + 1) * 9}`,
    el("img", { src: "https://x.test/images/dislike.png" }),
    ` ${i + 2}`
  ]);
}

test("forum-style bare text metrics under the card root are all discovered", () => {
  const cards = [];
  for (let i = 0; i < 12; i += 1) cards.push(makeBareTextCard(i));
  const doc = makeDocument(el("body", {}, [el("div", { class: "listchannel" }, cards)]), "https://forum.test/list.php?sort=new");
  const result = engine.discover(doc, { pageUrl: doc.location.href });

  assert.equal(result.cardCount, 12);
  const byCanonical = (id) => result.candidates.find((c) => c.canonicalId === id && !c.excluded);

  assert.ok(byCanonical("views"), "Views should be discovered from bare text");
  assert.ok(byCanonical("favorites"), "Favorites should be discovered from bare text");
  assert.ok(byCanonical("comments"), "Comments should be discovered from bare text");
  assert.ok(byCanonical("uploadDate"), "Added: 15 d must classify as a date despite the username noise");
  assert.equal(byCanonical("uploadDate").type, "date");
  assert.ok(byCanonical("likes"), "bare count after like.png icon should map to likes");
  assert.ok(byCanonical("dislikes"), "bare count after dislike.png icon should map to dislikes");
  assert.ok(result.candidates.some((c) => c.type === "duration" && !c.excluded), "duration badge");

  // Point: 2000 全站恒定 → 不是指标,不应出现
  assert.ok(!result.candidates.some((c) => c.canonicalId === "score" && !c.excluded && !c.suspect), "constant Point must not become a sortable field");

  const item3 = result.items[3];
  assert.equal(item3.metrics[byCanonical("favorites").id], (3 + 2) * 55);
  assert.equal(item3.metrics[byCanonical("likes").id], 4 * 9);
  assert.equal(item3.metrics[byCanonical("dislikes").id], 5);
  assert.ok(item3.metrics.uploadDate, "uploadDate alias from Added");
});

test("mod-site-style listings: downloads, endorsements, file size and ISO dates classify correctly", () => {
  const cards = [];
  for (let i = 0; i < 10; i += 1) {
    cards.push(el("div", { class: "mod-tile" }, [
      el("a", { href: `/mods/${100 + i}` }, [el("img", { src: `/i/${i}.jpg` })]),
      el("p", { class: "tile-name" }, [el("a", { href: `/mods/${100 + i}` }, [`Awesome Mod ${i} SE`])]),
      el("div", { class: "meta" }, [
        el("span", { class: "stat-downloads" }, [el("i", { class: "icon-download" }), `${(i + 1) * 1234}`]),
        el("span", { class: "stat" }, [`Endorsements ${(i + 1) * 7}`]),
        el("span", { class: "filesize" }, [`${(i + 1).toFixed(1)} MB`]),
        el("time", { datetime: `2026-0${(i % 6) + 1}-15T00:00:00Z` }, [`Jun ${i + 1}, 2026`])
      ])
    ]));
  }
  const doc = makeDocument(el("body", {}, [el("div", { class: "grid" }, cards)]), "https://mods.test/game-a/mods");
  const result = engine.discover(doc, { pageUrl: doc.location.href });

  assert.equal(result.cardCount, 10);
  assert.ok(result.candidates.some((c) => c.canonicalId === "downloads" && !c.excluded));
  assert.ok(result.candidates.some((c) => c.canonicalId === "endorsements" && !c.excluded));
  const fileSize = result.candidates.find((c) => c.canonicalId === "fileSize");
  assert.ok(fileSize && !fileSize.excluded, "byte-size slot should classify as File size");
  assert.ok(
    result.candidates.filter((c) => c.type === "date" && !c.excluded).length >= 1,
    "ISO datetime must classify as date, not duration"
  );
  assert.ok(!result.candidates.some((c) => c.type === "duration" && !c.excluded), "no duration exists on this page");

  const item = result.items[2];
  assert.ok(item.metrics.uploadDate, "date alias set");
  assert.equal(item.metrics.durationSeconds, undefined, "no bogus duration alias");
  const fileSizeValue = item.metrics[fileSize.id];
  assert.equal(fileSizeValue, Math.round(3.0 * 1024 * 1024), "file size normalized to bytes");
});

/* ------------------------- 模组站结构(svg + sr-only + data-e2eid,数字独居) ------------------------- */

function makeRealModSiteCard(i) {
  const stat = (name, label, value) => el("p", { class: "text-body-sm text-neutral-moderate flex items-center gap-x-1" }, [
    el("svg", { viewBox: "0 0 24 24", role: "presentation", class: "shrink-0 shrink-0" }),
    el("span", { class: "sr-only" }, [label]),
    el("span", { "data-e2eid": `mod-tile-${name}` }, [value])
  ]);
  return el("div", { class: "mod-tile" }, [
    el("a", { href: `/games/x/mods/${100 + i}` }, [el("img", { src: `/i/${i}.jpg` })]),
    el("p", { class: "tile-name" }, [el("a", { href: `/games/x/mods/${100 + i}` }, [`Awesome Mod ${i} SE`])]),
    el("div", { class: "mt-auto flex min-h-8 items-center gap-x-4" }, [
      stat("endorsements", "Endorsements", `${(i + 1)}.${i % 10}k`),
      stat("downloads", "Downloads", `${(i + 2) * 31}`),
      stat("file-size", "File size", `${(i + 1).toFixed(1)}MB`)
    ])
  ]);
}

function makeRealModSiteDocument(count = 10) {
  const cards = [];
  for (let i = 0; i < count; i += 1) cards.push(makeRealModSiteCard(i));
  return makeDocument(el("body", {}, [el("div", { class: "grid" }, cards)]), "https://mods.test/games/x/mods?sort=endorsements");
}

test("real mod-site structure: sr-only siblings and data-e2eid name solo numbers", () => {
  const doc = makeRealModSiteDocument(10);
  const result = engine.discover(doc, { pageUrl: doc.location.href });

  assert.equal(result.cardCount, 10);

  const endorsements = result.candidates.find((c) => c.canonicalId === "endorsements");
  assert.ok(endorsements, "endorsements should be named via sr-only/data-e2eid hints");
  assert.equal(endorsements.excluded, false);
  assert.equal(endorsements.suspect, false, "named metric must not be suspect");
  assert.equal(endorsements.preChecked, true, "endorsements should be pre-checked");

  const downloads = result.candidates.find((c) => c.canonicalId === "downloads");
  assert.ok(downloads, "downloads should be named via sr-only/data-e2eid hints");
  assert.equal(downloads.excluded, false);
  assert.equal(downloads.preChecked, true, "downloads should be pre-checked");

  const fileSize = result.candidates.find((c) => c.canonicalId === "fileSize" && !c.excluded);
  assert.ok(fileSize, "file size should classify");

  const item = result.items[3];
  assert.equal(item.metrics[downloads.id], 5 * 31);
  assert.equal(item.metrics[endorsements.id], 4300, "4.3k parses to 4300");
});

test("real mod-site structure: picking a solo number by text node yields a named candidate", () => {
  const doc = makeRealModSiteDocument(10);
  const span = doc.querySelector("[data-e2eid='mod-tile-downloads']");
  assert.ok(span, "downloads span exists");

  const picked = engine.generalizeFromTextNode(doc, span, 0);
  assert.equal(picked.ok, true);
  const candidate = picked.candidates[0];
  assert.equal(candidate.type, "number");
  assert.equal(candidate.coverage.count, 10);
  assert.equal(candidate.canonicalId, "downloads", "picker must name the clicked number, not '(没名字的数字)'");
});

test("solo-number climb never steals the name of a neighboring metric", () => {
  // 两个并排的纯数字指标(无图标无隐藏文字):爬升遇到"邻居是另一个数字"必须停,宁可无名也不能张冠李戴
  const cards = [];
  for (let i = 0; i < 8; i += 1) {
    cards.push(el("li", { class: "row-item" }, [
      el("a", { href: `/post/${i}` }, [el("img", { src: `/p/${i}.jpg` })]),
      el("h3", { class: "title" }, [el("a", { href: `/post/${i}` }, [`Post number ${i} title`])]),
      el("div", { class: "nums" }, [
        el("span", { class: "n1" }, [`${(i + 1) * 11}`]),
        el("span", { class: "n2" }, [`${(i + 1) * 7}`])
      ])
    ]));
  }
  const doc = makeDocument(el("body", {}, [el("ul", { class: "list" }, cards)]), "https://plain.test/list");
  const result = engine.discover(doc, { pageUrl: doc.location.href });
  const named = result.candidates.filter((c) => c.canonicalId && c.type === "number" && !c.excluded);
  assert.equal(named.length, 0, "bare neighboring numbers must stay unnamed rather than mislabeled");
});

/* ------------------------- URL 骨架 ------------------------- */

test("rule keys ignore query values and numeric path segments", () => {
  assert.equal(makeRuleKey("https://site.test/videos?page=2"), makeRuleKey("https://site.test/videos?page=9"));
  assert.equal(makeRuleKey("https://site.test/search?q=cat"), makeRuleKey("https://site.test/search?q=dog"));
  assert.equal(makeRuleKey("https://site.test/videos/page/2"), makeRuleKey("https://site.test/videos/page/3"));
  assert.notEqual(makeRuleKey("https://site.test/videos"), makeRuleKey("https://site.test/channels"));
  assert.equal(normalizePathSkeleton("/v/page-2/2026-05"), "/v/*/*");
});

/* ------------------------- 新 bucket 规范 ------------------------- */

test("bands use every card read; a huge outlier gets its own top band", () => {
  const items = [];
  for (let i = 0; i < 80; i += 1) {
    items.push({
      sourcePage: Math.floor(i / 40) + 1,
      discoveryOrder: i % 40,
      metrics: { favorites: i < 60 ? 5 + i * 25 : 999999 } // 后 20 项是超界爆款
    });
  }
  const catalog = [{ id: "favorites", label: "收藏", type: "number" }];
  const state = buildBucketState(items, catalog, { sampleSize: 60 });
  const field = state.fields.favorites;

  // 新规则:用全部已读卡片(不再只看前 60 张);爆款(3 倍以上的跳跃)单独一档放最上面
  assert.equal(field.min, 5);
  assert.equal(field.max, 999999);
  assert.equal(field.exact, false);
  const top = getBucketRank(999999, field);
  assert.ok(top > getBucketRank(1480, field), "爆款单独一档");
  assert.ok(getBucketRank(1480, field) > getBucketRank(5, field));
  assert.equal(getBucketRank(-10, field), 1, "低于最小值的数落在最下面一档");
});

test("durations stay exact; identical values collapse to one band", () => {
  const items = [60, 120, 300, 600, 3600].map((seconds, index) => ({
    sourcePage: 1,
    discoveryOrder: index,
    metrics: { durationSeconds: seconds }
  }));
  const catalog = [{ id: "durationSeconds", label: "时长", type: "duration" }];
  const state = buildBucketState(items, catalog, {});
  // 时长暂时按准确数值排(不分档)
  assert.equal(state.fields.durationSeconds.exact, true);
  assert.ok(getBucketRank(3600, state.fields.durationSeconds) > getBucketRank(60, state.fields.durationSeconds));

  const flat = buildBucketState(
    [{ sourcePage: 1, discoveryOrder: 0, metrics: { views: 7 } }, { sourcePage: 1, discoveryOrder: 1, metrics: { views: 7 } }],
    [{ id: "views", label: "views", type: "number" }],
    {}
  );
  assert.equal(getBucketRank(7, flat.fields.views), 1, "全同值退化为单桶");
});

test("a labelled pair whose value is a date keeps the whole date (\"Updated: 2026-10-14\")", () => {
  const cards = [];
  for (let i = 0; i < 10; i += 1) {
    cards.push(el("div", { class: "mod-tile" }, [
      el("a", { href: `/mods/${300 + i}` }, [`Some Mod ${i}`]),
      el("span", { class: "stat" }, [`Likes: ${(i + 3) * 11}`]),
      el("span", { class: "upd" }, [`Updated: 2026-0${(i % 9) + 1}-1${i % 10}`])
    ]));
  }
  const doc = makeDocument(el("body", {}, [el("div", { class: "grid" }, cards)]), "https://fixture.test/mods");
  const result = engine.discover(doc, { pageUrl: doc.location.href });
  const date = result.candidates.find((c) => c.type === "date" && !c.excluded);
  assert.ok(date, "date slot must survive the label/value split");
  assert.equal(result.items[3].metrics.uploadDate.slice(0, 10), "2026-04-13");
});
