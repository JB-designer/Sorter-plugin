import test from "node:test";
import assert from "node:assert/strict";
import "../src/shared/alignment-engine.js";
import { parseNumber, parseLabeledNumber } from "../src/core/parsers.js";

const engine = globalThis.CardSorterEngine;
const parsers = [
  ["engine", (v) => engine.parseNumber(v)],
  ["core", (v) => parseNumber(v)]
];

const cases = [
  // 修复 5:以前读错的写法
  ["1.234", 1234], ["1 234", 1234], ["1 234", 1234], ["12 345 views", 12345],
  ["1,2K", 1200], ["2,5k", 2500], ["12,5", 12.5], ["1.234,5", 1234.5], ["1.234.567", 1234567],
  ["1'234", 1234],
  // 不能被改坏的写法
  ["1,234", 1234], ["1,234,567", 1234567], ["1,234.5", 1234.5], ["1.5K", 1500], ["1.234K", 1234],
  ["1.2万", 12000], ["2,500", 2500], ["0.123", 0.123], ["12.99", 12.99], ["3.5K", 3500],
  ["comments 3", 3], ["-12", -12], ["2024", 2024]
];

for (const [name, parse] of parsers) {
  test(`fix 5 (${name}): number formats are read generically`, () => {
    for (const [input, expected] of cases) {
      assert.equal(parse(input), expected, `${name} parseNumber(${JSON.stringify(input)})`);
    }
  });
}

test("fix 5 (engine): percent and byte values still parse", () => {
  assert.equal(engine.parseNumber("97%"), 97);
  assert.equal(engine.parseNumber("12,5 %"), 12.5);
  assert.equal(engine.parseNumber("1.5 GB"), Math.round(1.5 * 1073741824));
  assert.equal(engine.parseNumber("2 KB"), 2048);
});

test("fix 5: version-like text falls back to reading the leading number", () => {
  assert.equal(parseNumber("v1.2.3"), 1.2);
  assert.equal(engine.parseNumber("1.2.3"), 1.2);
});

test("fix 5: labeled numbers accept the new formats", () => {
  assert.equal(parseLabeledNumber("播放: 1.234 收藏: 5", ["播放"]), 1234);
  assert.equal(parseLabeledNumber("Views 1,2K", ["Views"]), 1200);
});
