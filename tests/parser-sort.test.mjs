import assert from "node:assert/strict";
import test from "node:test";

import {
  parseDate,
  parseDuration,
  parseLabeledNumber,
  parseNumber
} from "../src/core/parsers.js";
import { analyzePageTargetRange, hasEnoughDateCoverage, locateDateRangePages, verifyDescendingChronology } from "../src/core/crawler.js";
import { buildFieldCatalog, getDefaultRulesForCatalog, isSortableField } from "../src/core/fields.js";
import { buildBucketState, getBucketRank } from "../src/core/buckets.js";
import { applyFiltersAndSort } from "../src/core/sort.js";
import { derivePageUrlFactory } from "../src/core/source.js";

test("parses compact public metric formats", () => {
  assert.equal(parseNumber("1.2万"), 12000);
  assert.equal(parseNumber("3.5K"), 3500);
  assert.equal(parseNumber("2,500"), 2500);
  assert.equal(parseNumber("1.5K"), 1500);
  assert.equal(parseNumber("comments 3"), 3);
  assert.equal(parseLabeledNumber("热度: 157 收藏: 3 留言: 0 积分: 5000", ["收藏"]), 3);
  assert.equal(parseLabeledNumber("留言 6", ["留言"]), 6);
  assert.equal(parseLabeledNumber("6 則留言 9,861 次瀏覽", ["留言"]), null);
});

test("normalizes compact numbers before sorting", () => {
  const items = [
    dynamicItem("small", { views: parseNumber("2") }, 0),
    dynamicItem("large", { views: parseNumber("1.5K") }, 1)
  ];

  const sorted = applyFiltersAndSort(
    items,
    [{ field: "views", direction: "desc", enabled: true }],
    { fieldCatalog: buildFieldCatalog(items) }
  );

  assert.deepEqual(sorted.map((video) => video.title), ["large", "small"]);
});

test("ten different values or fewer than ten cards are sorted exactly (no bands)", () => {
  const items = [1, 2, 3, 4, 5, 6, 7].map((views, index) =>
    dynamicItem(`item ${views}`, { views }, index)
  );
  const catalog = buildFieldCatalog(items);
  const state = buildBucketState(items, catalog, {
    sourceUrl: "https://example.test/list",
    scopeFilters: { date: false, page: false, all: true }
  });

  assert.equal(state.fields.views.exact, true);
  assert.equal(state.fields.views.exactReason, "few");
  assert.equal(getBucketRank(1, state.fields.views), 1);
  assert.equal(getBucketRank(7, state.fields.views), 7);
});

test("bands come from all cards: 9,000–10,000 still splits into several round bands", () => {
  const values = Array.from({ length: 150 }, (_, i) => 9000 + ((i * 37) % 1001));
  const items = values.map((favorites, index) => dynamicItem(`item ${index}`, { favorites }, index));
  const state = buildBucketState(items, buildFieldCatalog(items), {});
  const field = state.fields.favorites;
  assert.equal(field.exact, false);
  assert.ok(field.bands.length >= 3 && field.bands.length <= 7, `got ${field.bands.length} bands`);
  for (const band of field.bands) assert.match(band.label, /^9,\d00–(?:9|10),\d{3}$|^9,\d{3}$|^10,000$/);
});

test("bucket sorting compares priority buckets before the next rule", () => {
  const items = [
    dynamicItem("same bucket weak comments", { views: 900, comments: 5 }, 0),
    dynamicItem("same bucket strong comments", { views: 999, comments: 35 }, 1),
    dynamicItem("higher views bucket", { views: 1500, comments: 1 }, 2),
    dynamicItem("missing views", { comments: 100 }, 3)
  ];
  const fieldCatalog = buildFieldCatalog(items);
  const bucketState = {
    fields: {
      views: { thresholds: [100, 200, 1000, 2000], zeroSeparated: false },
      comments: { thresholds: [10, 20, 30, 40], zeroSeparated: false }
    }
  };

  const sorted = applyFiltersAndSort(
    items,
    [
      { field: "views", direction: "desc", mode: "bucket", enabled: true },
      { field: "comments", direction: "desc", mode: "bucket", enabled: true }
    ],
    { fieldCatalog, bucketState }
  );

  assert.deepEqual(sorted.map((video) => video.title), [
    "higher views bucket",
    "same bucket strong comments",
    "same bucket weak comments",
    "missing views"
  ]);
});

test("default numeric rule uses bucket mode without adding date as a sort layer", () => {
  const items = [
    dynamicItem("older", { views: 10, uploadDate: "2026-06-01T00:00:00.000Z" }, 0),
    dynamicItem("newer", { views: 20, uploadDate: "2026-07-01T00:00:00.000Z" }, 1)
  ];
  const rules = getDefaultRulesForCatalog(buildFieldCatalog(items));

  assert.equal(rules.length, 1);
  assert.equal(rules[0].field, "views");
  assert.equal(rules[0].mode, "bucket");
});

test("text-only titles are not sortable rules", () => {
  const catalog = buildFieldCatalog([dynamicItem("title only", {}, 0)]);
  const sortableIds = catalog.filter(isSortableField).map((field) => field.id);

  assert.equal(sortableIds.includes("title"), false);
  assert.deepEqual(getDefaultRulesForCatalog(catalog), []);
});

test("person-name view labels are not sortable fields", () => {
  const items = [
    dynamicItem("one", { views: 192000, "Lauren Phillips Videos Views": 192000 }, 0),
    dynamicItem("two", { views: 420000, "Brandi Love Videos Views": 420000 }, 1),
    dynamicItem("three", { views: 1000, videosViewCount: 1000 }, 2)
  ];
  const catalog = buildFieldCatalog(items);
  const sortableIds = catalog.filter(isSortableField).map((field) => field.id);
  const views = catalog.find((field) => field.id === "views");

  assert.equal(views?.count, 3);
  assert.equal(sortableIds.includes("views"), true);
  assert.equal(sortableIds.some((id) => /lauren|brandi|videos-view/i.test(id)), false);
});

test("short repeated custom numeric labels remain sortable", () => {
  const items = [
    dynamicItem("one", { Seeders: 3 }, 0),
    dynamicItem("two", { Seeders: 9 }, 1),
    dynamicItem("three", { Seeders: 12 }, 2)
  ];
  const sortableIds = buildFieldCatalog(items).filter(isSortableField).map((field) => field.id);

  assert.ok(sortableIds.includes("seeders"));
});

test("layout and css attribute names are not sortable metrics", () => {
  const items = [
    dynamicItem("one", { absolute: 2, flex: 1, relative: 0, "rounded full": 4 }, 0),
    dynamicItem("two", { absolute: 2, flex: 1, relative: 0, "rounded full": 4 }, 1),
    dynamicItem("three", { absolute: 2, flex: 1, relative: 0, "rounded full": 4 }, 2)
  ];
  const sortableIds = buildFieldCatalog(items).filter(isSortableField).map((field) => field.id);

  assert.equal(sortableIds.some((id) => /absolute|flex|relative|rounded/.test(id)), false);
});

test("mod-site-style public metrics remain sortable", () => {
  const items = [
    dynamicItem("one", { downloads: 9, endorsements: 0, "file-size": 22_800_000 }, 0),
    dynamicItem("two", { downloads: 45, endorsements: 1, "file-size": 203_000_000 }, 1),
    dynamicItem("three", { downloads: 35, endorsements: 3, "file-size": 13_600_000 }, 2)
  ];
  const sortableIds = buildFieldCatalog(items).filter(isSortableField).map((field) => field.id);

  assert.ok(sortableIds.includes("downloads"));
  assert.ok(sortableIds.includes("endorsements"));
  assert.ok(sortableIds.includes("file-size"));
});

test("parses durations from clock and text forms", () => {
  assert.equal(parseDuration("00:01:31"), 91);
  assert.equal(parseDuration("1:02:03"), 3723);
  assert.equal(parseDuration("1小时 2分钟 3秒"), 3723);
});

test("parses relative upload dates", () => {
  const now = new Date("2026-06-30T12:00:00.000Z");
  assert.equal(parseDate("10 分钟 前", now), "2026-06-30T11:50:00.000Z");
  assert.equal(parseDate("添加时间: 1 小时 前", now), "2026-06-30T11:00:00.000Z");
});

test("sorts by favorites first, then upload date", () => {
  const items = [
    item("old high", 20, localDay("2026-06-01"), 0),
    item("new low", 3, localDay("2026-06-29"), 1),
    item("new high", 20, localDay("2026-06-28"), 2),
    item("missing favorite", null, localDay("2026-06-30"), 3)
  ];

  const sorted = applyFiltersAndSort(
    items,
    [
      { field: "favorites", direction: "desc", enabled: true },
      { field: "uploadDate", direction: "desc", enabled: true }
    ],
    { startDate: "2026-06-01", endDate: "2026-06-30" }
  );

  assert.deepEqual(
    sorted.map((video) => video.title),
    ["new high", "old high", "new low", "missing favorite"]
  );
});

test("filters date range before sorting", () => {
  const items = [
    item("inside", 1, "2026-06-15T00:00:00.000Z", 0),
    item("outside", 999, "2026-05-31T00:00:00.000Z", 1)
  ];

  const sorted = applyFiltersAndSort(items, [{ field: "favorites", direction: "desc", enabled: true }], {
    startDate: "2026-06-01",
    endDate: "2026-06-30"
  });

  assert.deepEqual(sorted.map((video) => video.title), ["inside"]);
});

test("filters page range before sorting", () => {
  const items = [
    { ...dynamicItem("page 299 high", { views: 999 }, 0), sourcePage: 299 },
    { ...dynamicItem("page 300 low", { views: 2 }, 1), sourcePage: 300 },
    { ...dynamicItem("page 450 high", { views: 1500 }, 2), sourcePage: 450 },
    { ...dynamicItem("page 501 mid", { views: 100 }, 3), sourcePage: 501 }
  ];

  const sorted = applyFiltersAndSort(items, [{ field: "views", direction: "desc", enabled: true }], {
    scopeMode: "page",
    startPage: 300,
    endPage: 500,
    fieldCatalog: buildFieldCatalog(items)
  });

  assert.deepEqual(sorted.map((video) => video.title), ["page 450 high", "page 300 low"]);
});

test("filters date and page scopes as an intersection", () => {
  const items = [
    { ...dynamicItem("right page wrong date", { views: 999, uploadDate: "2026-05-01T00:00:00.000Z" }, 0), sourcePage: 350 },
    { ...dynamicItem("wrong page right date", { views: 888, uploadDate: "2026-06-15T00:00:00.000Z" }, 1), sourcePage: 250 },
    { ...dynamicItem("right page right date", { views: 777, uploadDate: "2026-06-20T00:00:00.000Z" }, 2), sourcePage: 450 }
  ];

  const sorted = applyFiltersAndSort(items, [{ field: "views", direction: "desc", enabled: true }], {
    scopeFilters: { date: true, page: true, all: false },
    startDate: "2026-06-01",
    endDate: "2026-06-30",
    startPage: 300,
    endPage: 500,
    fieldCatalog: buildFieldCatalog(items)
  });

  assert.deepEqual(sorted.map((video) => video.title), ["right page right date"]);
});

test("all indexed scope ignores date and page filters", () => {
  const items = [
    { ...dynamicItem("old page", { views: 10, uploadDate: "2020-01-01T00:00:00.000Z" }, 0), sourcePage: 1 },
    { ...dynamicItem("new page", { views: 20, uploadDate: "2026-06-20T00:00:00.000Z" }, 1), sourcePage: 999 }
  ];

  const sorted = applyFiltersAndSort(items, [{ field: "views", direction: "desc", enabled: true }], {
    scopeFilters: { date: false, page: false, all: true },
    startDate: "2026-06-01",
    endDate: "2026-06-30",
    startPage: 300,
    endPage: 500,
    fieldCatalog: buildFieldCatalog(items)
  });

  assert.deepEqual(sorted.map((video) => video.title), ["new page", "old page"]);
});

test("sorting layer no longer hardcodes per-site filters; missing metrics sink to the end", () => {
  // 卡片归属判定现在发生在识别阶段(结构聚类 + 用户确认的站点规则),排序层不做站点特判。
  const items = [
    { ...dynamicItem("Ruth Lee", {}, 0), videoUrl: "https://media.example.com/people/ruth-lee", thumbnailUrl: "model.jpg" },
    { ...dynamicItem("Notice to Users", {}, 1), videoUrl: "https://help.media.example.com/articles/notice", thumbnailUrl: "notice.jpg" },
    { ...dynamicItem("Real video by duration", { views: 100, durationSeconds: 600 }, 2), videoUrl: "https://media.example.com/watch.php?id=abc", thumbnailUrl: "video.jpg" },
    { ...dynamicItem("Real video by id", { views: 200 }, 3), videoUrl: "https://media.example.com/watch.php?id=def", thumbnailUrl: "video2.jpg" }
  ];

  const sorted = applyFiltersAndSort(items, [{ field: "views", direction: "desc", enabled: true }], {
    sourceUrl: "https://media.example.com/videos",
    scopeFilters: { date: false, page: false, all: true },
    fieldCatalog: buildFieldCatalog(items)
  });

  assert.deepEqual(sorted.map((video) => video.title), [
    "Real video by id",
    "Real video by duration",
    "Ruth Lee",
    "Notice to Users"
  ]);
});

test("non-video listing paths that merely contain video are not forced into video cards", () => {
  const items = [
    { ...dynamicItem("Game post", { views: 100 }, 0), videoUrl: "https://games.example.com/post/puzzle-1", thumbnailUrl: "game.jpg" },
    { ...dynamicItem("Game post two", { views: 200 }, 1), videoUrl: "https://games.example.com/post/puzzle-2", thumbnailUrl: "game2.jpg" }
  ];

  const sorted = applyFiltersAndSort(items, [{ field: "views", direction: "desc", enabled: true }], {
    sourceUrl: "https://games.example.com/category/video-game/puzzle",
    scopeFilters: { date: false, page: false, all: true },
    fieldCatalog: buildFieldCatalog(items)
  });

  assert.deepEqual(sorted.map((video) => video.title), ["Game post two", "Game post"]);
});

test("filters keyword after target date range", () => {
  const items = [
    {
      ...item("inside keyword", 1, "2026-06-15T00:00:00.000Z", 0),
      author: "Alice",
      rawText: "public text"
    },
    {
      ...item("inside other", 999, "2026-06-16T00:00:00.000Z", 1),
      author: "Bob",
      rawText: "public text"
    },
    {
      ...item("outside keyword", 9999, "2026-05-15T00:00:00.000Z", 2),
      author: "Alice",
      rawText: "public text"
    }
  ];

  const sorted = applyFiltersAndSort(items, [{ field: "favorites", direction: "desc", enabled: true }], {
    startDate: "2026-06-01",
    endDate: "2026-06-30",
    query: "alice"
  });

  assert.deepEqual(sorted.map((video) => video.title), ["inside keyword"]);
});

test("keyword matches title, author, raw text, and prepared search text", () => {
  const items = [
    {
      ...item("plain title", 1, "2026-06-15T00:00:00.000Z", 0),
      author: "Creator One",
      rawText: "visible public tags"
    },
    {
      ...item("other", 2, "2026-06-15T00:00:00.000Z", 1),
      searchText: "custom hidden index phrase"
    }
  ];

  assert.deepEqual(
    applyFiltersAndSort(items, [], { query: "creator" }).map((video) => video.title),
    ["plain title"]
  );
  assert.deepEqual(
    applyFiltersAndSort(items, [], { query: "public tags" }).map((video) => video.title),
    ["plain title"]
  );
  assert.deepEqual(
    applyFiltersAndSort(items, [], { query: "hidden phrase" }).map((video) => video.title),
    ["other"]
  );
});

test("builds sort dropdown fields from discovered item metrics only", () => {
  const items = [
    dynamicItem("one", { views: 1500, comments: 7, uploadDate: "2026-05-23T00:00:00.000Z" }, 0),
    dynamicItem("two", { views: 2, comments: 1, uploadDate: "2026-05-24T00:00:00.000Z" }, 1)
  ];

  const catalog = buildFieldCatalog(items);
  const ids = catalog.map((field) => field.id);

  assert.ok(ids.includes("views"));
  assert.ok(ids.includes("comments"));
  assert.ok(ids.includes("uploadDate"));
  assert.equal(ids.includes("favorites"), false);
  assert.equal(ids.includes("score"), false);
});

test("empty field catalog does not fake one detected title card", () => {
  const catalog = buildFieldCatalog([]);
  const title = catalog.find((field) => field.id === "title");
  assert.equal(title?.count, 0);
});

test("reports insufficient date coverage for binary seek samples", () => {
  assert.equal(
    hasEnoughDateCoverage([
      { page: 1, knownDates: 0 },
      { page: 50, knownDates: 0 },
      { page: 100, knownDates: 0 }
    ]),
    false
  );
});

test("marks newer pages as not yet reaching the target date range", () => {
  const relation = analyzePageTargetRange(
    [
      item("newest", 1, "2026-06-15T00:00:00.000Z", 0),
      item("newer", 1, "2026-06-01T00:00:00.000Z", 1)
    ],
    { startDate: "2019-01-31", endDate: "2020-12-30" }
  );

  assert.equal(relation.relation, "newer-than-target");
  assert.equal(relation.matchedDates, 0);
});

test("marks pages inside the target date range", () => {
  const relation = analyzePageTargetRange(
    [
      item("inside", 1, "2020-06-15T00:00:00.000Z", 0),
      item("also inside", 1, "2019-02-01T00:00:00.000Z", 1)
    ],
    { startDate: "2019-01-31", endDate: "2020-12-30" }
  );

  assert.equal(relation.relation, "intersects-target");
  assert.equal(relation.matchedDates, 2);
});

test("marks older pages as past the target date range", () => {
  const relation = analyzePageTargetRange(
    [
      item("old", 1, "2018-12-31T00:00:00.000Z", 0),
      item("older", 1, "2018-01-01T00:00:00.000Z", 1)
    ],
    { startDate: "2019-01-31", endDate: "2020-12-30" }
  );

  assert.equal(relation.relation, "older-than-target");
  assert.equal(relation.matchedDates, 0);
});

test("binary date seek locates the target page range without linear scanning", async () => {
  const totalPages = 6276;
  const startDate = "2020-01-01";
  const endDate = "2020-12-31";
  const requestedPages = new Set();
  const located = await locateDateRangePages({
    totalPages,
    startDate,
    endDate,
    getBounds: async (page) => {
      requestedPages.add(page);
      return syntheticDailyBounds(page);
    }
  });

  assert.equal(located.targetFound, true);
  assert.equal(located.targetStartPage, daysBetween("2026-01-01", endDate) + 1);
  assert.equal(located.targetEndPage, daysBetween("2026-01-01", startDate) + 1);
  assert.ok(requestedPages.size < 40);
});

test("binary date seek reports no target pages when range is older than the listing", async () => {
  const located = await locateDateRangePages({
    totalPages: 100,
    startDate: "1999-01-01",
    endDate: "1999-12-31",
    getBounds: async (page) => syntheticDailyBounds(page)
  });

  assert.equal(located.targetFound, false);
  assert.equal(located.targetStartPage, null);
  assert.equal(located.targetEndPage, null);
});

test("chronology verification rejects non-date-sorted page samples", () => {
  assert.equal(
    verifyDescendingChronology([
      syntheticBound(1, "2026-01-01"),
      syntheticBound(50, "2020-01-01"),
      syntheticBound(100, "2024-01-01")
    ]),
    false
  );
});

test("derives page URLs from pagination links", () => {
  const factory = derivePageUrlFactory("https://example.test/list?category=recent", {
    pageLinks: [
      { page: 2, url: "https://example.test/list?category=recent&page=2" },
      { page: 6276, url: "https://example.test/list?category=recent&page=6276" }
    ]
  });

  assert.equal(factory(501), "https://example.test/list?category=recent&page=501");
});

test("sorts a 50k synthetic index without changing tie order", () => {
  const items = Array.from({ length: 50000 }, (_, index) =>
    item(`video-${index}`, index % 250, `2026-06-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`, index)
  );

  const sorted = applyFiltersAndSort(items, [{ field: "favorites", direction: "desc", enabled: true }], {});

  assert.equal(sorted.length, 50000);
  assert.equal(sorted[0].metrics.favorites, 249);
  assert.ok(sorted[0].discoveryOrder < sorted[1].discoveryOrder);
});

function item(title, favorites, uploadDate, discoveryOrder) {
  return {
    title,
    discoveryOrder,
    metrics: {
      favorites,
      uploadDate,
      heat: 0,
      comments: 0,
      score: 0,
      durationSeconds: 60
    }
  };
}

function dynamicItem(title, metrics, discoveryOrder) {
  return {
    title,
    discoveryOrder,
    metrics,
    metricDetails: Object.fromEntries(
      Object.keys(metrics).map((field) => [field, { id: field, source: "test" }])
    )
  };
}

function makeListingCard({ title, href, image, meta }) {
  const imageElement = fakeElement({
    tagName: "img",
    attributes: { src: image, alt: title }
  });
  const link = fakeElement({
    tagName: "a",
    attributes: { href },
    textContent: title,
    children: [imageElement]
  });
  return fakeElement({
    tagName: "article",
    className: "post-card",
    textContent: `${title} ${meta}`,
    children: [
      link,
      fakeElement({ tagName: "span", className: "meta", textContent: meta })
    ]
  });
}

function fakeDocument(root) {
  return {
    body: root,
    querySelector(selector) {
      return root.querySelector(selector);
    },
    querySelectorAll(selector) {
      return root.querySelectorAll(selector);
    }
  };
}

function fakeElement({ textContent = "", attributes = {}, children = [], tagName = "div", id = "", className = "" } = {}) {
  const element = {
    tagName: tagName.toUpperCase(),
    id,
    className,
    children,
    previousElementSibling: null,
    nextElementSibling: null,
    parentElement: null,
    textContent,
    getAttribute(name) {
      return attributes[name] ?? null;
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll(selector) {
      if (selector === ":scope > *") return children;
      return allDescendants(this).filter((candidate) => matchesFakeSelector(candidate, selector));
    },
    closest(selector) {
      let current = this;
      while (current) {
        if (matchesFakeSelector(current, selector)) return current;
        current = current.parentElement;
      }
      return null;
    },
    contains(other) {
      let current = other;
      while (current) {
        if (current === this) return true;
        current = current.parentElement;
      }
      return false;
    }
  };
  children.forEach((child, index) => {
    child.parentElement = element;
    child.previousElementSibling = children[index - 1] || null;
    child.nextElementSibling = children[index + 1] || null;
  });
  return element;
}

function allDescendants(element) {
  const descendants = [];
  for (const child of element.children || []) {
    descendants.push(child, ...allDescendants(child));
  }
  return descendants;
}

function matchesFakeSelector(element, selector) {
  return selector
    .split(",")
    .map((part) => part.trim())
    .some((part) => matchesSingleSelector(element, part));
}

function matchesSingleSelector(element, selector) {
  if (!selector || selector === "*") return true;
  const tagName = element.tagName.toLowerCase();
  const className = String(element.className?.baseVal || element.className || "").toLowerCase();
  if (selector.includes(" ")) {
    return selector.split(/\s+/).some((part) => matchesSingleSelector(element, part));
  }
  if (selector === "a[href]") return tagName === "a" && Boolean(element.getAttribute("href"));
  if (selector === "img" || selector === "picture" || selector === "video") return tagName === selector;
  if (/^h[1-4]$/.test(selector)) return tagName === selector;
  if (selector === "[datetime]") return Boolean(element.getAttribute("datetime"));
  if (selector === "[title]") return Boolean(element.getAttribute("title"));
  if (selector === "[aria-label]") return Boolean(element.getAttribute("aria-label"));
  if (selector === "[class*='icon']") return className.includes("icon");
  if (selector === "span[class*='icon']") return tagName === "span" && className.includes("icon");
  if (selector === "[class*='title']") return className.includes("title");
  if (selector === "[class*='name']") return className.includes("name");
  if (selector.startsWith("[class*='")) {
    const needle = selector.match(/\[class\*='([^']+)'\]/)?.[1] || "";
    return className.includes(needle);
  }
  if (selector.startsWith(".")) return className.split(/\s+/).includes(selector.slice(1).toLowerCase());
  if (/^[a-z][a-z0-9-]*$/i.test(selector)) return tagName === selector.toLowerCase();
  if (selector.startsWith("script")) return tagName === "script";
  if (selector.startsWith("[itemprop")) return false;
  return false;
}

function syntheticDailyBounds(page) {
  // 每页一天,按本地日(日期只有"天"时,插件按本地零点存)
  const date = new Date(2026, 0, 1 - (page - 1));
  const timestamp = date.getTime();
  const label = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return {
    page,
    knownDates: 8,
    oldest: label,
    newest: label,
    oldestTime: timestamp,
    newestTime: timestamp
  };
}

function syntheticBound(page, date) {
  const timestamp = Date.parse(`${date}T00:00:00.000Z`);
  return {
    page,
    knownDates: 8,
    oldest: date,
    newest: date,
    oldestTime: timestamp,
    newestTime: timestamp
  };
}

function daysBetween(newerDate, olderDate) {
  const newer = Date.parse(`${newerDate}T00:00:00.000Z`);
  const older = Date.parse(`${olderDate}T00:00:00.000Z`);
  return Math.round((newer - older) / (24 * 60 * 60 * 1000));
}

// 纯日期 "YYYY-MM-DD" 在当前时区的本地零点(ISO 字符串)
function localDay(text) {
  const [year, month, day] = text.split("-").map(Number);
  return new Date(year, month - 1, day).toISOString();
}

test("menu and section labels are filtered out of sortable fields", () => {
  const items = [
    dynamicItem("real item", { views: 54000, durationSeconds: 90 }, 0),
    dynamicItem("noise one", { "Most Viewed": 18, "Editors Choice": 2, favorited: 1 }, 1),
    dynamicItem("noise two", { "Watch the full making-of story": 8, "Top Channel Picks of the Week": 12 }, 2)
  ];
  const sortableIds = buildFieldCatalog(items).filter(isSortableField).map((field) => field.id);

  assert.ok(sortableIds.includes("views"));
  assert.ok(sortableIds.includes("durationSeconds"));
  assert.equal(sortableIds.some((id) => /most-viewed|editors-choice|favorited|making-of|channel/i.test(id)), false);
});
