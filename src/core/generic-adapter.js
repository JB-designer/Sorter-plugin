/*
 * 通用规则 adapter:crawler 抓回的 HTML 用对齐引擎 + 站点规则解析。
 * 依赖 globalThis.CardSorterEngine(须先以 <script src> 加载 alignment-engine.js)。
 */

export function makeGenericAdapter(rule) {
  return {
    id: "generic",
    collect(doc, pageUrl, page) {
      const engine = globalThis.CardSorterEngine;
      if (!engine) return { items: [], pagination: null };
      const result = rule
        ? engine.applyRule(doc, rule, { pageUrl, page })
        : engine.discover(doc, { pageUrl, page });
      return {
        items: result.items || [],
        pagination: collectPagination(doc, pageUrl)
      };
    }
  };
}

export function collectPagination(doc, pageUrl) {
  const pageLinks = [];
  let totalPages = null;
  const anchors = doc.querySelectorAll("a[href]");

  for (const anchor of anchors) {
    const text = String(anchor.textContent || "").trim();
    if (!/^\d{1,5}$/.test(text)) continue;
    const page = Number(text);
    if (!page || page > 100000) continue;
    const href = anchor.getAttribute("href") || "";
    if (!href || href.startsWith("#")) continue;
    const identity = `${anchor.getAttribute("class") || ""} ${anchor.parentElement?.getAttribute?.("class") || ""}`;
    const nearPagination = /page|pager|pagin|分页|分頁/i.test(identity) ||
      Boolean(anchor.closest?.("[class*='page' i],[class*='pagin' i],nav"));
    if (!nearPagination) continue;
    try {
      pageLinks.push({ page, url: new URL(href, pageUrl).href });
      totalPages = Math.max(totalPages || 0, page);
    } catch {
      // 忽略坏链接
    }
  }

  if (!pageLinks.length) return null;
  return { pageLinks, totalPages };
}

export function parsePageNumberFromUrl(url) {
  try {
    const parsed = new URL(url);
    for (const key of ["page", "p", "paged"]) {
      const value = Number(parsed.searchParams.get(key));
      if (Number.isInteger(value) && value > 0) return value;
    }
    const segment = parsed.pathname.match(/\/(?:page|p)[-/]?(\d{1,5})(?:\/|$)/i);
    if (segment) return Number(segment[1]);
  } catch {
    // fall through
  }
  return 1;
}
