import assert from "node:assert/strict";
import test from "node:test";

import "../src/shared/alignment-engine.js";
import { el, makeDocument } from "./mini-dom.mjs";

const engine = globalThis.CardSorterEngine;
const PLACEHOLDERS = ["New", "--", "—"];

// 12 张卡里 5 张的下载量显示占位符(超过四分之一)
function makeDocWithPlaceholders() {
  const cards = [];
  for (let i = 0; i < 12; i += 1) {
    const downloads = i % 5 === 0 || i % 7 === 3 ? PLACEHOLDERS[i % 3] : String((i + 1) * 1111);
    cards.push(el("li", { class: "mod-card" }, [
      el("h3", { class: "title" }, [el("a", { href: `/mods/${i}` }, [`Mod title number ${i} deluxe`])]),
      el("span", { class: "dl" }, [downloads]),
      el("span", { class: "author" }, [`maker${i}`])
    ]));
  }
  return makeDocument(el("body", {}, [el("ul", { class: "list" }, cards)]), "https://example.test/mods");
}

test("fix 7: placeholders count as no value, not as text", () => {
  for (const text of ["New", "new", "--", "—", "-", "N/A", "暂无"]) {
    assert.equal(engine.isPlaceholderValue(text), true, text);
  }
  for (const text of ["0", "12", "New York", "1.2K"]) {
    assert.equal(engine.isPlaceholderValue(text), false, text);
  }
  assert.equal(engine.detectSlotType(["1,111", "New", "--", "4,444", "—", "6,666", "7,777"]).type, "number");
  assert.equal(engine.detectSlotType(["New", "--", "—"]).type, "text");
});

test("fix 7: a downloads column with New/--/— stays sortable; those cards have no value", () => {
  const doc = makeDocWithPlaceholders();
  const result = engine.discover(doc, { pageUrl: doc.location.href });
  const downloads = result.candidates.find((c) => c.type === "number" && (c.examples || []).some((e) => /1,?111|2,?222|4,?444/.test(String(e))));
  assert.ok(downloads, "downloads column should be found");
  assert.equal(downloads.excluded, false, "downloads column must be sortable");
  assert.equal(result.items[1].metrics[downloads.id], 2222);
  assert.equal(result.items[0].metrics[downloads.id] ?? null, null, "a 'New' card has no value");
});
