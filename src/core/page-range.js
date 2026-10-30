// Advanced Card Sort · https://github.com/JB-designer/Sorter-plugin · MIT License
/*
 * 读取范围控件(样稿 F1 方案 A / F2 / F3 / F4)的全部逻辑,纯函数,方便测试。
 *   "从第 S 页读到第 [− E +] 页"  ·  "−10 页 / +10 页"  ·  "只排这一页"  ·  "全部 N 页" 或 "读到列表末尾"
 *   - 默认:从当前页开始读 5 页(E = 当前页 + 4,不超过列表最后一页)。
 *   - E 的范围:[S, min(列表最后一页, S + 99)];一次最多读 100 页。
 *   - − 和 −10 永远不会低于起始页;到了起始页时变灰。
 *   - 自己输入的数字超出范围时立刻改正,并用一句一直显示的话说明改了什么(F4)。
 */

import { t } from "./i18n.js";

export const MAX_PAGES_PER_RUN = 100;
export const DEFAULT_PAGE_COUNT = 5;
export const JUMP = 10;
export const LONG_RUN_PAGES = 20;

export function createPageRange({ current = 1, total = null } = {}) {
  const cur = Math.max(1, Math.floor(Number(current) || 1));
  const tot = Number.isFinite(Number(total)) && Number(total) >= cur ? Math.floor(Number(total)) : null;
  const state = { current: cur, total: tot, start: cur, end: cur, mode: "range", prevEnd: null, typed: null, note: null };
  state.end = clampEnd(state, cur + DEFAULT_PAGE_COUNT - 1);
  return normalize(state);
}

export function maxEnd(state) {
  const cap = state.start + MAX_PAGES_PER_RUN - 1;
  return state.total ? Math.min(state.total, cap) : cap;
}

function clampEnd(state, value) {
  return Math.max(state.start, Math.min(maxEnd(state), value));
}

// 起止都在当前页 = "只排这一页"
function normalize(state) {
  if (state.mode !== "toEnd" && state.mode !== "invalid" && state.mode !== "before") {
    if (state.start === state.current && state.end === state.current) state.mode = "this";
    else if (state.total && state.start === 1 && state.end === state.total && state.total <= MAX_PAGES_PER_RUN) state.mode = "all";
    else state.mode = "range";
  }
  return state;
}

function next(state, patch) {
  return normalize({ ...state, note: null, typed: null, ...patch });
}

export function stepEnd(state, delta) {
  if (state.mode === "toEnd") {
    if (delta < 0) return next(state, { mode: "range", end: clampEnd(state, state.prevEnd ?? state.start + DEFAULT_PAGE_COUNT - 1), prevEnd: null });
    return state;
  }
  if (state.mode === "invalid" || state.mode === "before") {
    const base = state.mode === "before" ? state.start : state.start;
    return next(state, { mode: "range", end: clampEnd(state, base + Math.max(0, delta)) });
  }
  return next(state, { end: clampEnd(state, state.end + delta) });
}

export function chooseThisPage(state) {
  return next(state, { mode: "range", start: state.current, end: state.current, prevEnd: null });
}

export function chooseAll(state) {
  if (!state.total) {
    // 网站没显示总页数:"读到列表末尾",最多 100 页;按 − 回到之前的数字
    return next(state, { mode: "toEnd", prevEnd: state.end, end: state.start + MAX_PAGES_PER_RUN - 1 });
  }
  const end = Math.min(state.total, MAX_PAGES_PER_RUN);
  const capped = state.total > MAX_PAGES_PER_RUN;
  const result = next({ ...state, start: 1 }, { mode: "range", start: 1, end, prevEnd: null });
  if (capped) {
    result.note = {
      tone: "warn",
      title: t("capTitle", MAX_PAGES_PER_RUN),
      body: t("capAllBody", { total: state.total, end })
    };
  }
  return result;
}

export function setStart(state, value) {
  const start = Math.max(1, Math.min(state.total || Infinity, Math.floor(Number(value) || 1)));
  const moved = { ...state, start };
  const keep = state.mode === "toEnd" ? start + MAX_PAGES_PER_RUN - 1 : Math.max(start, state.end);
  return next(moved, { start, end: Math.max(start, Math.min(maxEnd(moved), keep)), mode: state.mode === "toEnd" ? "toEnd" : "range" });
}

// 用户在框里打字(只接受数字)
export function typeEnd(state, text) {
  const digits = String(text ?? "").replace(/\D/g, "");
  if (!digits || Number(digits) === 0) {
    return { ...state, mode: "invalid", typed: digits, note: null };
  }
  const value = Number(digits);
  const base = { ...state, mode: "range", prevEnd: null, typed: null };
  if (value < state.start) {
    return {
      ...base,
      mode: "before",
      typed: value,
      note: {
        tone: "warn",
        title: t("beforeTitle", { value, start: state.start }),
        body: t("beforeBody", value),
        actions: [
          { id: "asCount", label: t("useRange", { from: state.start, to: clampEnd(base, state.start + value - 1) }) },
          { id: "fromOne", label: t("startAtOne") }
        ]
      }
    };
  }
  if (state.total && value > state.total) {
    const end = clampEnd(base, state.total);
    const result = normalize({ ...base, end });
    result.note = end === state.total
      ? { tone: "info", title: t("listOnlyTitle", state.total), body: t("listOnlyBody", state.total) }
      : capNote(state.start, end, value);
    return result;
  }
  if (value > maxEnd(base)) {
    const end = maxEnd(base);
    const result = normalize({ ...base, end });
    result.note = capNote(state.start, end, value);
    return result;
  }
  return normalize({ ...base, end: value, note: null });
}

function capNote(start, end, typed) {
  return {
    tone: "warn",
    title: t("capTitle", MAX_PAGES_PER_RUN),
    body: t("capTypedBody", { start, end, typed })
  };
}

// F4c 的两个修正按钮
export function resolveBefore(state, actionId) {
  if (state.mode !== "before") return state;
  const typed = Number(state.typed) || 1;
  if (actionId === "fromOne") {
    const moved = { ...state, start: 1 };
    return next(moved, { mode: "range", start: 1, end: Math.max(1, Math.min(maxEnd(moved), typed)) });
  }
  return next(state, { mode: "range", end: clampEnd(state, state.start + typed - 1) });
}

export function pagesToRead(state) {
  if (state.mode === "invalid" || state.mode === "before") return [];
  const pages = [];
  for (let p = state.start; p <= state.end; p += 1) pages.push(p);
  return pages;
}

// 界面上要显示的一切(文字和按钮状态)
export function describePageRange(state) {
  const count = state.end - state.start + 1;
  const atStart = state.end <= state.start;
  const atMax = state.end >= maxEnd(state);
  const view = {
    startPage: state.start,
    endText: state.mode === "toEnd" ? t("endInputToEnd") : state.mode === "invalid" ? String(state.typed || "") : state.mode === "before" ? String(state.typed) : String(state.end),
    endWarning: state.mode === "before",
    minusDisabled: state.mode === "invalid" ? true : state.mode === "toEnd" ? false : atStart,
    plusDisabled: state.mode === "toEnd" || (state.mode !== "invalid" && state.mode !== "before" && atMax),
    jumpMinusDisabled: state.mode === "toEnd" ? false : state.mode === "invalid" || atStart,
    jumpPlusDisabled: state.mode === "toEnd" || (state.mode !== "invalid" && state.mode !== "before" && atMax),
    thisOn: state.mode === "this",
    allOn: state.mode === "all" || state.mode === "toEnd",
    allLabel: state.total ? t("allPages", state.total) : t("toEnd"),
    lineParts: [],
    hint: "",
    ctaLabel: "",
    ctaEnabled: true,
    note: state.note || null,
    pages: pagesToRead(state),
    readToEnd: state.mode === "toEnd"
  };
  if (state.mode === "this") {
    view.lineParts = t("sumThis", state.current);
    view.ctaLabel = t("sortThis");
  } else if (state.mode === "toEnd") {
    view.lineParts = t("sumToEnd", { from: state.start, to: state.end, max: MAX_PAGES_PER_RUN });
    view.hint = t("longRun");
    view.ctaLabel = t("sortToEnd");
  } else if (state.mode === "all") {
    view.lineParts = t("sumAll", { to: state.end });
    view.ctaLabel = t("sortPages", { from: 1, to: state.end });
  } else if (state.mode === "invalid") {
    view.hint = t("noLastPage");
    view.ctaLabel = t("sortGeneric");
    view.ctaEnabled = false;
  } else if (state.mode === "before") {
    view.ctaLabel = t("sortGeneric");
    view.ctaEnabled = false;
  } else {
    const span = { from: state.start, to: state.end, count };
    view.lineParts = state.total ? t("sumRange", span) : t("sumRangeOpen", span);
    view.ctaLabel = t("sortPages", span);
  }
  if (state.mode === "range" && count > LONG_RUN_PAGES) {
    view.hint = t("longRun");
  }
  return view;
}

// "当前在第 7 页 · 这一页有 24 张卡片 · 列表共 32 页"
export function describeScope({ current, cardCount, total }) {
  return t("scope", { current, cards: cardCount, total });
}

/*
 * 从页面上的分页链接读出总页数(通用,不按网站硬编码):
 * 只算"像页码"的链接 —— 链接文字是数字,且网址里的页码参数(page / p / paged)或某个路径段正好等于这个数字。
 * 读不出就返回 null(界面显示"网站没显示总页数",绝不猜)。
 */
export function detectTotalPages(anchors = [], baseUrl = "", currentPage = 1) {
  // 把每个数字链接的网址里"等于这个数字"的位置换成 {n},得到它的翻页模板;
  // 同一个模板下有多个不同数字、并且包含当前页附近的页码,才算分页条
  const groups = new Map();
  for (const anchor of anchors) {
    const text = String(anchor?.text || "").trim();
    if (!/^\d{1,5}$/.test(text)) continue;
    const n = Number(text);
    if (n < 1) continue;
    let url;
    try { url = new URL(anchor.href, baseUrl); } catch { continue; }
    const templates = [];
    for (const [key, value] of url.searchParams.entries()) {
      if (value !== text) continue;
      const copy = new URL(url.href);
      copy.searchParams.set(key, "{n}");
      // 其他参数里也带着同一个页码(如 ref=sr_pg_2)→ 一起换掉,不然每个页码链接各成一组
      for (const [otherKey, otherValue] of url.searchParams.entries()) {
        if (otherKey === key) continue;
        const swapped = otherValue.replace(new RegExp(`(^|\\D)${text}(?!\\d)`, "g"), "$1{n}");
        if (swapped !== otherValue) copy.searchParams.set(otherKey, swapped);
      }
      templates.push({ key: "q:" + copy.href, strong: /page|^p$|paged|^pg$/i.test(key) });
    }
    const segments = url.pathname.split("/");
    segments.forEach((segment, index) => {
      const embedded = new RegExp(`^((?:page|p)[-_]?)${n}(\\.[a-z0-9]{2,5})?$`, "i").exec(segment);
      if (segment !== text && !embedded) return;
      const parts = segments.slice();
      parts[index] = embedded ? embedded[1] + "{n}" + (embedded[2] || "") : "{n}";
      const strong = Boolean(embedded) || /^(?:page|p)$/i.test(segments[index - 1] || "");
      templates.push({ key: "p:" + url.origin + parts.join("/") + url.search, strong });
    });
    for (const t of templates) {
      if (!groups.has(t.key)) groups.set(t.key, { strong: false, pages: new Set() });
      const g = groups.get(t.key);
      g.strong = g.strong || t.strong;
      g.pages.add(n);
    }
  }
  let best = null;
  for (const g of groups.values()) {
    const pages = [...g.pages];
    const near = pages.some((p) => Math.abs(p - currentPage) <= 2);
    if (!near || (!g.strong && pages.length < 2)) continue;
    const score = (g.strong ? 1000 : 0) + pages.length;
    if (!best || score > best.score) best = { score, max: Math.max(...pages) };
  }
  if (!best) return null;
  return Math.max(best.max, currentPage);
}

// 网站用文字写出总页数时读出来:"Page 1 of 50"、"共 50 页"、"第 2 頁，總計 105 頁"。
// 只读分页条和网页标题里的文字(调用方负责挑),避免正文里的句子被误读。
export function totalFromText(texts = []) {
  const patterns = [
    /\bpage\s+\d{1,5}\s+(?:of|\/)\s+(\d{1,5})\b/i,
    /共\s*(\d{1,5})\s*[页頁]/,
    /[总總][计計共]?\s*(\d{1,5})\s*[页頁]/,
    /第\s*\d{1,5}\s*[/／]\s*(\d{1,5})\s*[页頁]/
  ];
  let best = null;
  for (const text of texts) {
    const value = String(text || "");
    for (const re of patterns) {
      const match = re.exec(value);
      if (match) {
        const total = Number(match[1]);
        if (total >= 1 && (!best || total > best)) best = total;
      }
    }
  }
  return best;
}
