import test from "node:test";
import assert from "node:assert/strict";
import { assignRuleField, firstUnusedField } from "../src/core/sort.js";

const catalog = [{ id: "downloads" }, { id: "likes" }, { id: "views" }];
const rule = (field, direction = "desc") => ({ field, direction, mode: "bucket", min: "", max: "", enabled: true });

test("dropdown: picking a field another rule uses swaps the two rules", () => {
  const rules = [rule("downloads"), rule("likes", "asc")];
  const { rules: next, swappedWith } = assignRuleField(rules, 0, "likes");
  assert.deepEqual(next.map((r) => r.field), ["likes", "downloads"]);
  assert.equal(next[0].direction, "asc", "each field keeps its own direction");
  assert.equal(swappedWith, 1);
  assert.deepEqual(rules.map((r) => r.field), ["downloads", "likes"], "input not mutated");
});

test("dropdown: picking an unused field just changes that rule", () => {
  const { rules: next, swappedWith } = assignRuleField([rule("downloads"), rule("likes")], 1, "views");
  assert.deepEqual(next.map((r) => r.field), ["downloads", "views"]);
  assert.equal(swappedWith, -1);
});

test("dropdown: add rule defaults to a field not used yet", () => {
  assert.equal(firstUnusedField(catalog, [rule("downloads")]), "likes");
  assert.equal(firstUnusedField(catalog, [rule("likes"), rule("downloads")]), "views");
  assert.equal(firstUnusedField(catalog, catalog.map((f) => rule(f.id))), null);
});
