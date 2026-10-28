import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseAll,
  chooseThisPage,
  createPageRange,
  describePageRange,
  describeScope,
  detectTotalPages,
  pagesToRead,
  resolveBefore,
  setStart,
  stepEnd,
  typeEnd
} from "../src/core/page-range.js";

const line = (view) => view.lineParts.map((part) => (typeof part === "string" ? part : part.b)).join("");

test("F1: page 1 of 32 starts at pages 1-5", () => {
  const view = describePageRange(createPageRange({ current: 1, total: 32 }));
  assert.equal(view.startPage, 1);
  assert.equal(view.endText, "5");
  assert.equal(line(view), "读取第 1–5 页，共 5 页");
  assert.equal(view.ctaLabel, "排序第 1–5 页");
  assert.equal(view.allLabel, "全部 32 页");
  assert.equal(describeScope({ current: 1, cardCount: 24, total: 32 }), "第 1 页 · 24 张卡片 · 共 32 页");
});

test("F1: +10 from 5 goes 15 -> 25 -> 32 and stops at the end", () => {
  let s = createPageRange({ current: 1, total: 32 });
  s = stepEnd(s, 10); assert.equal(s.end, 15);
  s = stepEnd(s, 10); assert.equal(s.end, 25);
  s = stepEnd(s, 10); assert.equal(s.end, 32);
  assert.equal(describePageRange(s).plusDisabled, true);
  assert.equal(describePageRange(s).jumpPlusDisabled, true);
});

test("F2: on page 7 the default is 7-11; typing 20 reads 14 pages", () => {
  let s = createPageRange({ current: 7, total: 32 });
  assert.equal(line(describePageRange(s)), "读取第 7–11 页，共 5 页");
  s = typeEnd(s, "20");
  const view = describePageRange(s);
  assert.equal(line(view), "读取第 7–20 页，共 14 页");
  assert.equal(view.ctaLabel, "排序第 7–20 页");
  assert.equal(view.note, null);
});

test("F2: -10 never goes below the current page; at the current page - and -10 are grey", () => {
  let s = createPageRange({ current: 7, total: 32 });
  s = stepEnd(s, -10);
  assert.equal(s.end, 7);
  const view = describePageRange(s);
  assert.equal(view.thisOn, true);
  assert.equal(view.minusDisabled, true);
  assert.equal(view.jumpMinusDisabled, true);
  assert.equal(view.ctaLabel, "排序本页");
  assert.equal(line(view), "仅第 7 页（本页）");
});

test("F2: 'Only this page' sets the box to the current page", () => {
  const s = chooseThisPage(typeEnd(createPageRange({ current: 7, total: 32 }), "20"));
  assert.equal(s.end, 7);
  assert.deepEqual(pagesToRead(s), [7]);
  assert.equal(describePageRange(s).ctaLabel, "排序本页");
});

test("F3: unknown total -> 'read until the list ends', max 100, - goes back to the previous number", () => {
  let s = createPageRange({ current: 1, total: null });
  let view = describePageRange(s);
  assert.equal(view.allLabel, "读到末页");
  assert.equal(line(view), "读取第 1–5 页，列表提前结束则停止");
  s = chooseAll(s);
  view = describePageRange(s);
  assert.equal(view.endText, "末页");
  assert.equal(line(view), "读到末页（第 1–100 页，最多 100 页）");
  assert.equal(view.plusDisabled, true);
  assert.equal(view.jumpPlusDisabled, true);
  assert.equal(view.ctaLabel, "读到末页并排序");
  assert.match(view.hint, /请勿关闭此标签页/);
  s = stepEnd(s, -1);
  assert.equal(s.end, 5, "- is the undo step");
});

test("F4a: typing 150 on page 7 (total unknown) is changed to 106 with a lasting note", () => {
  const s = typeEnd(createPageRange({ current: 7, total: null }), "150");
  const view = describePageRange(s);
  assert.equal(s.end, 106);
  assert.equal(line(view), "读取第 7–106 页，列表提前结束则停止");
  assert.equal(view.note.title, "⚠ 单次最多读取 100 页");
  assert.equal(view.note.body, "从第 7 页起最多读到第 106 页，结束页已改为第 106 页。");
  assert.equal(view.plusDisabled, true);
  assert.equal(view.ctaLabel, "排序第 7–106 页");
});

test("F4b: typing 50 on a 32-page list -> information note, reads to page 32", () => {
  const s = typeEnd(createPageRange({ current: 1, total: 32 }), "50");
  const view = describePageRange(s);
  assert.equal(s.end, 32);
  assert.equal(view.note.tone, "info");
  assert.equal(view.note.title, "ⓘ 该列表只有 32 页");
  assert.equal(view.note.body, "结束页已改为第 32 页。");
});

test("F4c: typing 5 on page 7 -> warning with two fixes, button disabled until one is picked", () => {
  let s = typeEnd(createPageRange({ current: 7, total: 32 }), "5");
  let view = describePageRange(s);
  assert.equal(view.endWarning, true);
  assert.equal(view.ctaEnabled, false);
  assert.equal(view.note.title, "⚠ 第 5 页在起始页（第 7 页）之前");
  assert.deepEqual(view.note.actions.map((a) => a.label), ["改为第 7–11 页", "从第 1 页开始"]);
  const asCount = resolveBefore(s, "asCount");
  assert.deepEqual([asCount.start, asCount.end], [7, 11]);
  const fromOne = resolveBefore(s, "fromOne");
  assert.deepEqual([fromOne.start, fromOne.end], [1, 5]);
  view = describePageRange(fromOne);
  assert.equal(view.ctaEnabled, true);
});

test("F4d: 'All 32 pages' on page 7 reads the whole list from page 1", () => {
  const s = chooseAll(createPageRange({ current: 7, total: 32 }));
  const view = describePageRange(s);
  assert.deepEqual([s.start, s.end], [1, 32]);
  assert.equal(line(view), "读取第 1–32 页（全部）");
  assert.equal(view.allOn, true);
  assert.equal(view.ctaLabel, "排序第 1–32 页");
});

test("F4: empty box or 0 disables the button with a hint; only digits are accepted", () => {
  for (const text of ["", "0", "abc"]) {
    const view = describePageRange(typeEnd(createPageRange({ current: 1, total: 32 }), text));
    assert.equal(view.ctaEnabled, false);
    assert.equal(view.hint, "未设置结束页");
  }
  assert.equal(typeEnd(createPageRange({ current: 1, total: 32 }), "1a2").end, 12);
});

test("All N pages on a list longer than 100 pages reads 1-100 and says why", () => {
  const s = chooseAll(createPageRange({ current: 3, total: 250 }));
  assert.deepEqual([s.start, s.end], [1, 100]);
  assert.match(s.note.title, /单次最多读取 100 页/);
});

test("start from another page keeps the end within [start, start+99]", () => {
  const s = setStart(createPageRange({ current: 1, total: 300 }), 50);
  assert.equal(s.start, 50);
  assert.equal(s.end, 50);
  assert.equal(stepEnd(s, 200).end, 149);
});

test("total pages are read from page-number links only", () => {
  const base = "https://mods.example/list?page=1";
  const anchors = [
    { text: "1", href: "/list?page=1" }, { text: "2", href: "/list?page=2" }, { text: "3", href: "/list?page=3" },
    { text: "32", href: "/list?page=32" }, { text: "500", href: "/mod/500" }, { text: "Next", href: "/list?page=2" }
  ];
  assert.equal(detectTotalPages(anchors, base, 1), 32);
  assert.equal(detectTotalPages([{ text: "2", href: "/tag/x/page/2/" }, { text: "9", href: "/tag/x/page/9/" }], "https://x.example/tag/x/", 1), 9);
  assert.equal(detectTotalPages([{ text: "Next", href: "/list?cursor=abc" }], base, 1), null);
});
