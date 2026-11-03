import test from "node:test";
import assert from "node:assert/strict";
import {
  clampTarget, stepTarget, createCollector, decideAfterStep, resumeRule, secondsLeft,
  CARD_TARGET_MAX, CARD_TARGET_MIN, RESUME_IDLE_MS
} from "../src/core/scroll-reader.js";
import { STRINGS } from "../src/core/i18n.js";

test("card target is clamped to the allowed range", () => {
  assert.equal(clampTarget("100"), 100);
  assert.equal(clampTarget("9999"), CARD_TARGET_MAX);
  assert.equal(clampTarget("3"), CARD_TARGET_MIN);
  assert.equal(clampTarget("abc", 200), 200);
  assert.equal(clampTarget(""), 100);
  assert.equal(stepTarget(100, 50), 150);
  assert.equal(stepTarget(480, 50), CARD_TARGET_MAX);
  assert.equal(stepTarget(30, -50), CARD_TARGET_MIN);
});

test("collector keeps each card once, in first-seen order (sorting never subtracts other cards)", () => {
  const c = createCollector((item) => item.url);
  assert.equal(c.add([{ url: "a" }, { url: "b" }]), 2);
  // the site removed "a" from the page and loaded "c": a stays collected
  assert.equal(c.add([{ url: "b" }, { url: "c" }]), 1);
  assert.equal(c.size, 3);
  assert.deepEqual(c.items().map((i) => i.url), ["a", "b", "c"]);
});

test("stop rules after each scroll step", () => {
  assert.equal(decideAfterStep({ unique: 100, target: 100, added: 5, atBottom: false, stalls: 0 }), "done");
  assert.equal(decideAfterStep({ unique: 40, target: 100, added: 5, atBottom: true, stalls: 0 }), "continue");
  // at the bottom: wait one more round before giving up
  assert.equal(decideAfterStep({ unique: 40, target: 100, added: 0, atBottom: true, stalls: 1 }), "continue");
  assert.equal(decideAfterStep({ unique: 40, target: 100, added: 0, atBottom: true, stalls: 2 }), "bottom");
  // not at the bottom but nothing new for several steps: the site stopped loading
  assert.equal(decideAfterStep({ unique: 40, target: 100, added: 0, atBottom: false, stalls: 2 }), "continue");
  assert.equal(decideAfterStep({ unique: 40, target: 100, added: 0, atBottom: false, stalls: 3 }), "bottom");
  // still scrolling (tall cards) without new cards: keep going, but not forever
  assert.equal(decideAfterStep({ unique: 40, target: 100, added: 0, atBottom: false, stalls: 0, idleSteps: 8 }), "continue");
  assert.equal(decideAfterStep({ unique: 40, target: 100, added: 0, atBottom: false, stalls: 0, idleSteps: 15 }), "bottom");
});

test("pauses resume automatically", () => {
  assert.deepEqual(resumeRule("manual"), { auto: true, afterMs: RESUME_IDLE_MS });
  assert.deepEqual(resumeRule("tab"), { auto: true, whenVisible: true });
  assert.equal(secondsLeft(10000, 7100), 3);
  assert.equal(secondsLeft(10000, 12000), 1);
});

test("every card-mode string exists in both languages", () => {
  const keys = ["tabPages", "tabCards", "scopeNoPaging", "cardsHintScroll", "cardsHintPages", "sortCards", "fixedOnePage",
    "fixedOnePageHint", "sortLoaded", "scrollReading", "scrollResumed", "pausedManual", "pausedTab", "pausedKeptManual",
    "pausedKeptTab", "scrollDoneTarget", "scrollDoneBottom", "scrollDoneMerged", "bottomModalTitle", "bottomModalBody1",
    "bottomModalBody2", "waitingTitle", "waitingAgain", "stopWaiting", "waitTimeout", "stopAndSortN"];
  for (const lang of ["zh", "en"]) {
    for (const key of keys) assert.ok(STRINGS[lang][key] != null, `${lang}.${key}`);
  }
  assert.equal(STRINGS.zh.bottomModalTitle, "页面已滚到底");
  assert.equal(STRINGS.zh.scrollDoneBottom({ n: 60, target: 100 }), "已排序 60 张卡片（页面已滚到底，目标 100 张）");
});
