import assert from "node:assert/strict";
import test from "node:test";

import { makePageUrlTemplates, pagesLookIdentical } from "../src/core/pagination.js";

test("wordpress-style path pagination (/tag/3d/page/2/) is derived and reusable", () => {
  const templates = makePageUrlTemplates(
    [
      { text: "2", href: "https://blog.example.com/tag/models/page/2/" },
      { text: "3", href: "https://blog.example.com/tag/models/page/3/" }
    ],
    "https://blog.example.com/tag/models"
  );
  const first = templates[0];
  assert.ok(first.name.startsWith("path:"), `path template should rank first, got ${first.name}`);
  assert.equal(first.make(7), "https://blog.example.com/tag/models/page/7/");
});

test("query-param pagination keeps other params intact", () => {
  const templates = makePageUrlTemplates(
    [{ text: "2", href: "https://shop.example.com/list.php?sort=new&page=2" }],
    "https://shop.example.com/list.php?sort=new"
  );
  const query = templates.find((t) => t.name === "query:page");
  assert.ok(query, "query:page template should exist");
  const url = new URL(query.make(9));
  assert.equal(url.searchParams.get("page"), "9");
  assert.equal(url.searchParams.get("sort"), "new");
});

test("bare numeric path segment (/videos/2) is derived", () => {
  const templates = makePageUrlTemplates(
    [{ text: "2", href: "https://site.test/videos/2" }],
    "https://site.test/videos"
  );
  const path = templates.find((t) => t.name === "path:segment");
  assert.ok(path);
  assert.equal(path.make(15), "https://site.test/videos/15");
});

test("without pagination anchors there are still multiple fallback candidates", () => {
  const templates = makePageUrlTemplates([], "https://a.test/tag/3d");
  assert.ok(templates.length >= 3, "need several fallbacks to try");
  const names = templates.map((t) => t.name);
  assert.ok(names.includes("fallback:path-page"));
  assert.ok(names.includes("fallback:query-page"));
  const pathFallback = templates.find((t) => t.name === "fallback:path-page");
  assert.equal(pathFallback.make(2), "https://a.test/tag/3d/page/2/");
});

test("pagesLookIdentical detects pagination failure but tolerates partial overlap", () => {
  const pageA = ["/post/a", "/post/b", "/post/c", "/post/d", "/post/e"];
  const samePage = [...pageA];
  const nextPage = ["/post/f", "/post/g", "/post/h", "/post/i", "/post/j"];
  const pinnedOverlap = ["/post/a", "/post/f", "/post/g", "/post/h", "/post/i"];

  assert.equal(pagesLookIdentical(pageA, samePage), true, "identical page must be flagged");
  assert.equal(pagesLookIdentical(pageA, nextPage), false, "disjoint pages are fine");
  assert.equal(pagesLookIdentical(pageA, pinnedOverlap), false, "20% pinned overlap is normal");
});

test("zero-based page parameter (link 2 → ?p=1) is learned from the page links", () => {
  const templates = makePageUrlTemplates(
    [
      { text: "1", href: "https://models.example/list?p=0&sort=trending" },
      { text: "2", href: "https://models.example/list?p=1&sort=trending" },
      { text: "3", href: "https://models.example/list?p=2&sort=trending" },
      { text: "100", href: "https://models.example/list?p=99&sort=trending" }
    ],
    "https://models.example/list"
  );
  const first = templates[0];
  assert.equal(first.name, "linear:p", `learned template should rank first, got ${first.name}`);
  const url = new URL(first.make(7));
  assert.equal(url.searchParams.get("p"), "6");
  assert.equal(url.searchParams.get("sort"), "trending");
  assert.equal(new URL(first.make(1)).searchParams.get("p"), "0");
});

test("item-offset parameter (link 2 → ?start=25) is learned from the page links", () => {
  const templates = makePageUrlTemplates(
    [
      { text: "2", href: "https://books.example/top?start=25&filter=" },
      { text: "3", href: "https://books.example/top?start=50&filter=" },
      { text: "4", href: "https://books.example/top?start=75&filter=" }
    ],
    "https://books.example/top"
  );
  const learned = templates.find((t) => t.name === "linear:start");
  assert.ok(learned, "linear:start template should exist");
  assert.equal(new URL(learned.make(1)).searchParams.get("start"), "0");
  assert.equal(new URL(learned.make(10)).searchParams.get("start"), "225");
});

test("a single link or inconsistent numbers never produce a learned template", () => {
  const single = makePageUrlTemplates(
    [{ text: "2", href: "https://site.test/list?p=1" }],
    "https://site.test/list"
  );
  assert.ok(!single.some((t) => t.name.startsWith("linear:")));

  const messy = makePageUrlTemplates(
    [
      { text: "2", href: "https://site.test/list?id=40" },
      { text: "3", href: "https://site.test/list?id=41" },
      { text: "4", href: "https://site.test/list?id=97" }
    ],
    "https://site.test/list"
  );
  assert.ok(!messy.some((t) => t.name.startsWith("linear:")));
});

test("sites that already matched keep the same first template (no learned duplicate)", () => {
  const anchors = [
    { text: "2", href: "https://shop.test/items?page=2" },
    { text: "3", href: "https://shop.test/items?page=3" }
  ];
  const templates = makePageUrlTemplates(anchors, "https://shop.test/items");
  assert.equal(templates[0].name, "query:page");
  assert.ok(!templates.some((t) => t.name.startsWith("linear:")));
});
