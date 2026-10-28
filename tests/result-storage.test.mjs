import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// 修复 4:在假的 chrome 环境里跑 background.js,检查"先删旧结果再写新结果"和空间不够时的提示。
const source = readFileSync(new URL("../background.js", import.meta.url), "utf8");

function loadBackground({ quotaBytes = Infinity } = {}) {
  const store = new Map();
  const log = [];
  let onMessage = null;
  const size = () => [...store.values()].reduce((sum, value) => sum + JSON.stringify(value).length, 0);
  const chrome = {
    action: { onClicked: { addListener() {} } },
    runtime: { onMessage: { addListener(fn) { onMessage = fn; } }, getURL: (path) => `chrome-extension://x/${path}` },
    tabs: { create: async (opts) => { log.push(["tab", opts.url]); return { id: 1 }; }, onUpdated: { addListener() {}, removeListener() {} }, onRemoved: { addListener() {} } },
    scripting: { executeScript: async () => [] },
    storage: {
      local: {
        async get(key) {
          if (key == null) return Object.fromEntries(store);
          return store.has(key) ? { [key]: store.get(key) } : {};
        },
        async set(entries) {
          const [[key, value]] = Object.entries(entries);
          const next = size() + JSON.stringify(value).length;
          if (next > quotaBytes) throw new Error("QUOTA_BYTES quota exceeded");
          log.push(["set", key]);
          store.set(key, value);
        },
        async remove(keys) {
          for (const key of [].concat(keys)) store.delete(key);
          log.push(["remove", [].concat(keys).length]);
        }
      }
    }
  };
  vm.runInNewContext(source, { chrome, console, setTimeout, clearTimeout, URL });
  const send = (message) => new Promise((resolve) => onMessage(message, { tab: { id: 9 } }, resolve));
  return { store, log, send };
}

const payload = (n, pad = 0) => ({ items: Array.from({ length: n }, (_, i) => ({ id: i, title: "x".repeat(pad) })) });

test("fix 4: old results are deleted before the new one is written; at most 10 kept", async () => {
  const bg = loadBackground();
  for (let i = 0; i < 10; i += 1) bg.store.set(`cardSorterResults:r0${i}`, payload(1));
  const response = await bg.send({ type: "card-sorter-save-results", payload: payload(2) });
  assert.equal(response.ok, true);
  const keys = [...bg.store.keys()].filter((key) => key.startsWith("cardSorterResults:"));
  assert.equal(keys.length, 10);
  assert.ok(!bg.store.has("cardSorterResults:r00"), "oldest result removed");
  const removeAt = bg.log.findIndex((entry) => entry[0] === "remove");
  const setAt = bg.log.findIndex((entry) => entry[0] === "set");
  assert.ok(removeAt >= 0 && removeAt < setAt, "delete happens before the write");
});

test("fix 4: when space runs out, all old results are cleared and the write is retried", async () => {
  const bg = loadBackground({ quotaBytes: 6000 });
  for (let i = 0; i < 3; i += 1) bg.store.set(`cardSorterResults:r0${i}`, payload(1, 1500));
  const response = await bg.send({ type: "card-sorter-save-results", payload: payload(1, 3000) });
  assert.equal(response.ok, true, response.error);
  assert.equal([...bg.store.keys()].length, 1);
});

test("fix 4: a result too big even for empty storage gives an honest message", async () => {
  const bg = loadBackground({ quotaBytes: 1000 });
  const response = await bg.send({ type: "card-sorter-save-results", payload: payload(3, 1000) });
  assert.equal(response.ok, false);
  assert.match(response.error, /结果过大/);
  assert.match(response.error, /减少页数/);
  assert.ok(!bg.log.some((entry) => entry[0] === "tab"), "no empty results tab is opened");
});

test("saving a result opens no tab; opening it is a separate step", async () => {
  const bg = loadBackground();
  const saved = await bg.send({ type: "card-sorter-save-results", payload: payload(2) });
  assert.equal(saved.ok, true);
  assert.ok(!bg.log.some((entry) => entry[0] === "tab"), "saving alone opens nothing");
  const opened = await bg.send({ type: "card-sorter-reopen-results", rid: saved.rid });
  assert.equal(opened.ok, true);
  assert.deepEqual(bg.log.filter((entry) => entry[0] === "tab").map((entry) => entry[1]), [`chrome-extension://x/results.html?rid=${saved.rid}`]);
});
