import test from "node:test";
import assert from "node:assert/strict";
import { defaultAnchor, anchorFromRect, styleFromAnchor, clampTopLeft } from "../src/core/panel-position.js";

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });

test("default is top-right, 16px in", () => {
  assert.deepEqual(defaultAnchor(), { h: "right", dx: 16, v: "top", dy: 16 });
  const css = styleFromAnchor(null, 120, 34, 1280, 800);
  assert.equal(css.right, "16px");
  assert.equal(css.top, "16px");
  assert.equal(css.left, "auto");
});

test("dropped in the lower-left: anchored to left + bottom edges (panel grows upward)", () => {
  const a = anchorFromRect(rect(40, 700, 120, 34), 1280, 800);
  assert.deepEqual(a, { h: "left", dx: 40, v: "bottom", dy: 66 });
  const css = styleFromAnchor(a, 360, 900, 1280, 800);
  assert.equal(css.bottom, "66px");
  assert.equal(css.top, "auto");
  // tall panel: capped so its top (the handle) stays 16px inside the window
  assert.equal(css.maxHeight, 800 - 66 - 16 + "px");
});

test("dropped in the upper-right: anchored to right + top edges", () => {
  const a = anchorFromRect(rect(1000, 100, 120, 34), 1280, 800);
  assert.deepEqual(a, { h: "right", dx: 160, v: "top", dy: 100 });
});

test("smaller window later: shown inside, saved anchor untouched", () => {
  const a = { h: "left", dx: 1200, v: "top", dy: 900 };
  const css = styleFromAnchor(a, 120, 34, 800, 600);
  assert.equal(css.left, 800 - 120 + "px");
  assert.equal(css.top, 600 - 34 + "px");
  assert.equal(a.dx, 1200);
});

test("dragging never leaves the window", () => {
  assert.deepEqual(clampTopLeft(-50, -20, 120, 34, 1280, 800), { left: 0, top: 0 });
  assert.deepEqual(clampTopLeft(5000, 5000, 120, 34, 1280, 800), { left: 1160, top: 766 });
});
