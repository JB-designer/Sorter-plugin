import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyCollectedPage,
  describeCollectOutcome,
  MAX_CONSECUTIVE_FAILED_PAGES
} from "../src/core/pagination.js";

const cards = (n) => Array.from({ length: n }, (_, i) => ({ id: i }));

test("fix 3: a page with cards is kept; a copy of another page is a duplicate", () => {
  assert.equal(classifyCollectedPage({ items: cards(20), page: 3 }), "store");
  assert.equal(classifyCollectedPage({ items: cards(20), page: 3, duplicateOf: 2 }), "duplicate");
  assert.equal(classifyCollectedPage({ items: cards(20), page: 3, duplicateOf: 3 }), "store");
});

test("fix 3: a page that opens but has no cards means the list ended", () => {
  assert.equal(classifyCollectedPage({ items: [], page: 4 }), "end");
  assert.equal(classifyCollectedPage({ items: [], page: 4, error: "no cards appeared", noCards: true }), "end");
});

test("fix 3: a page that fails to open is skipped, not fatal", () => {
  assert.equal(classifyCollectedPage({ items: [], page: 4, error: "net::ERR_TIMED_OUT" }), "skip");
  assert.ok(MAX_CONSECUTIVE_FAILED_PAGES >= 2);
});

test("fix 3: the summary says where the list ended and which pages were skipped", () => {
  const ended = describeCollectOutcome({ requested: [2, 3, 4, 5], stored: [1, 2, 3], endedAfter: 3 });
  assert.match(ended, /列表在第 3 页结束/);
  assert.match(ended, /读到的 3 页/);
  assert.doesNotMatch(ended, /错|失败/);

  const dup = describeCollectOutcome({ stored: [1, 2], endedAfter: 2, duplicateOf: 2 });
  assert.match(dup, /第 3 页拿到的是第 2 页的内容/);

  const skipped = describeCollectOutcome({ stored: [1, 2, 4, 5], skipped: [3] });
  assert.match(skipped, /第 3 页打开出错,已跳过/);
  assert.match(skipped, /读了 4 页/);

  const gaveUp = describeCollectOutcome({ stored: [1, 2], gaveUpAt: 3 });
  assert.match(gaveUp, /从第 3 页起连续打不开/);
});

import { slowDownPlan, MAX_RATE_RETRIES } from "../src/core/pagination.js";

test("rate limit: 429/503 wait (Retry-After first) and slow down; other errors do not", () => {
  const a = slowDownPlan({ status: 429, retryAfter: "7", delayMs: 400, attempt: 0 });
  assert.deepEqual(a, { retry: true, waitMs: 7000, nextDelayMs: 1500 });
  const b = slowDownPlan({ status: 503, delayMs: 1500, attempt: 1 });
  assert.equal(b.retry, true);
  assert.equal(b.waitMs, 10000);
  assert.equal(b.nextDelayMs, 3000);
  assert.equal(slowDownPlan({ status: 429, retryAfter: "3600", attempt: 0 }).waitMs, 60000, "never waits more than a minute");
  assert.equal(slowDownPlan({ status: 404, attempt: 0 }).retry, false);
  assert.equal(slowDownPlan({ status: 429, attempt: MAX_RATE_RETRIES }).retry, false, "gives up after 3 tries");
});
