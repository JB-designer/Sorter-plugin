import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// 修复 6:只有日期的值("2024-03-05"、"2024年3月5日")必须按本地的那一天读,
// 在任何时区都不能前后差一天。每个时区开一个子进程跑同一段检查。
const root = fileURLToPath(new URL("..", import.meta.url));
const script = `
  import "./src/shared/alignment-engine.js";
  import { parseDate } from "./src/core/parsers.js";
  import { applyFiltersAndSort } from "./src/core/sort.js";
  const engine = globalThis.CardSorterEngine;
  const day = (iso) => { const d = new Date(iso); return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours()]; };
  const items = ["2026-06-01", "2026-06-30", "2026-07-01", "2026-05-31"].map((text, i) => ({
    title: text, discoveryOrder: i, metrics: { uploadDate: engine.parseDateIso(text) }
  }));
  const kept = applyFiltersAndSort(items, [{ field: "title", direction: "asc" }], { startDate: "2026-06-01", endDate: "2026-06-30" });
  console.log(JSON.stringify({
    core: day(parseDate("2024-03-05")),
    engine: day(engine.parseDateIso("2024-03-05")),
    engineCn: day(engine.parseDateIso("2024年3月5日")),
    engineSlash: day(engine.parseDateIso("2024/03/05")),
    withTime: engine.parseDateIso("2026-07-01T08:00:00Z"),
    kept: kept.map((item) => item.title)
  }));
`;

for (const tz of ["UTC", "Asia/Shanghai", "America/Los_Angeles", "Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
  test(`fix 6: date-only values stay on the same day in ${tz}`, () => {
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: root,
      env: { ...process.env, TZ: tz },
      encoding: "utf8"
    });
    const result = JSON.parse(out.trim().split("\n").pop());
    for (const key of ["core", "engine", "engineCn", "engineSlash"]) {
      assert.deepEqual(result[key], [2024, 3, 5, 0], `${key} in ${tz}`);
    }
    assert.equal(result.withTime, "2026-07-01T08:00:00.000Z", "a value with a time keeps its exact time");
    assert.deepEqual(result.kept, ["2026-06-01", "2026-06-30"], `date range filter in ${tz}`);
  });
}
