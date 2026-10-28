/*
 * 翻页模板推导:从页面上的数字分页链接反推 "第 n 页的网址长什么样"。
 * 支持两大形态,并按可信度排序返回多个候选,调用方逐一验证:
 *   - 参数式: /list?page=2 、 /list?p=2 、 /v.php?next=watch&page=2
 *   - 路径式: /tag/3d/page/2/ 、 /videos/2 、 /list/p-2
 * v0.7 只支持参数式导致 WordPress 类站点(/page/2/)翻页失效、同一页被重复收集 —— 本模块修复该退化。
 */

export function makePageUrlTemplates(numericAnchors, baseUrl) {
  const templates = [];
  const seen = new Set();

  const push = (name, make) => {
    let sample;
    try {
      sample = make(2);
    } catch {
      return;
    }
    if (!sample || seen.has(sample)) return;
    seen.add(sample);
    templates.push({ name, make });
  };

  for (const anchor of numericAnchors || []) {
    const pageNumber = Number(anchor.text);
    if (!Number.isInteger(pageNumber) || pageNumber < 1) continue;
    let linked;
    try {
      linked = new URL(anchor.href, baseUrl);
    } catch {
      continue;
    }

    // 1) 参数式:?page=N / ?p=N(键名含 page 优先)
    for (const [key, value] of linked.searchParams.entries()) {
      if (value !== String(pageNumber)) continue;
      const confident = /page|^p$|paged/i.test(key);
      push((confident ? "query:" : "query-any:") + key, (n) => {
        const next = new URL(linked.href);
        next.searchParams.set(key, String(n));
        return next.href;
      });
    }

    // 2) 路径式:某个路径段正好等于页码(/page/2/、/videos/2)
    const segments = linked.pathname.split("/");
    const exactIndex = segments.findIndex((segment) => segment === String(pageNumber));
    if (exactIndex >= 0) {
      push("path:segment", (n) => {
        const next = new URL(linked.href);
        const parts = next.pathname.split("/");
        parts[exactIndex] = String(n);
        next.pathname = parts.join("/");
        return next.href;
      });
    }

    // 3) 路径式变体:/p-2、/page2、/page-2.html
    const embeddedRe = new RegExp("^((?:page|p)[-_]?)" + pageNumber + "(\\.[a-z0-9]{2,5})?$", "i");
    const embeddedIndex = segments.findIndex((segment) => embeddedRe.test(segment));
    if (embeddedIndex >= 0) {
      const [, prefix, suffix = ""] = embeddedRe.exec(segments[embeddedIndex]);
      push("path:embedded", (n) => {
        const next = new URL(linked.href);
        const parts = next.pathname.split("/");
        parts[embeddedIndex] = prefix + n + suffix;
        next.pathname = parts.join("/");
        return next.href;
      });
    }
  }

  // 4) 规律式:网址里的数字不等于页码,但和页码成固定比例(从至少两个页码链接里学出来)
  //    从 0 开始数:「2」→ ?p=1、「3」→ ?p=2;按条数翻:「2」→ ?start=25、「3」→ ?start=50。
  //    排在上面几种之后,以前能认出的网站仍然先用原来的写法。
  for (const learned of learnLinearParams(numericAnchors, baseUrl)) {
    push("linear:" + learned.key, (n) => {
      const next = new URL(learned.href);
      next.searchParams.set(learned.key, String(learned.a * n + learned.b));
      return next.href;
    });
  }

  // 兜底候选(没有分页链接可参考时也要能试)
  push("fallback:path-page", (n) => {
    const next = new URL(baseUrl);
    const path = next.pathname.replace(/\/page\/\d+\/?$/i, "").replace(/\/$/, "");
    next.pathname = path + "/page/" + n + "/";
    return next.href;
  });
  push("fallback:query-page", (n) => {
    const next = new URL(baseUrl);
    next.searchParams.set("page", String(n));
    return next.href;
  });
  push("fallback:query-p", (n) => {
    const next = new URL(baseUrl);
    next.searchParams.set("p", String(n));
    return next.href;
  });

  return templates;
}

// 对每个网址参数收集 (页码, 参数值),用最小和最大的两个页码算出 值 = a × 页码 + b,
// 再要求所有链接都符合。至少两个不同页码、a 为正整数;a=1 且 b=0 就是普通写法,上面已经处理。
function learnLinearParams(numericAnchors, baseUrl) {
  const byKey = new Map();
  for (const anchor of numericAnchors || []) {
    const pageNumber = Number(anchor.text);
    if (!Number.isInteger(pageNumber) || pageNumber < 1) continue;
    let linked;
    try {
      linked = new URL(anchor.href, baseUrl);
    } catch {
      continue;
    }
    for (const [key, value] of linked.searchParams.entries()) {
      if (!/^\d{1,7}$/.test(value)) continue;
      if (!byKey.has(key)) byKey.set(key, { href: linked.href, points: new Map() });
      const entry = byKey.get(key);
      const seenValue = entry.points.get(pageNumber);
      if (seenValue != null && seenValue !== Number(value)) entry.conflict = true;
      entry.points.set(pageNumber, Number(value));
    }
  }

  const learned = [];
  for (const [key, entry] of byKey) {
    if (entry.conflict || entry.points.size < 2) continue;
    const pages = [...entry.points.keys()].sort((x, y) => x - y);
    const first = pages[0];
    const last = pages[pages.length - 1];
    const a = (entry.points.get(last) - entry.points.get(first)) / (last - first);
    if (!Number.isInteger(a) || a < 1) continue;
    const b = entry.points.get(first) - a * first;
    if (a === 1 && b === 0) continue;
    if (a + b < 0) continue; // 第 1 页会算出负数:不是页码
    if (!pages.every((page) => entry.points.get(page) === a * page + b)) continue;
    learned.push({ key, href: entry.href, a, b });
  }
  return learned;
}

// 两页内容是否"基本是同一页"(签名重合度 ≥ threshold)——用于识别翻页失败
export function pagesLookIdentical(signaturesA, signaturesB, threshold = 0.8) {
  if (!signaturesA?.length || !signaturesB?.length) return false;
  const setB = new Set(signaturesB);
  let overlap = 0;
  for (const signature of signaturesA) {
    if (setB.has(signature)) overlap += 1;
  }
  return overlap / Math.min(signaturesA.length, signaturesB.length) >= threshold;
}

// 逐页收集时,一页拿回来之后该怎么办(纯函数,便于测试):
//   "store"     有卡片且不和已收的页重复 → 收下
//   "duplicate" 和已收的某页一样 → 先换翻页方式;方式都试过了 → 当作列表到头
//   "end"       页面正常打开但一张卡片都没有(noCards)→ 列表到头了
//   "skip"      打开出错(超时、网络、服务器错误)→ 跳过这一页、记下页码、继续读后面的
export function classifyCollectedPage({ items, error, noCards = false, duplicateOf, page } = {}) {
  const count = Array.isArray(items) ? items.length : 0;
  if (count && duplicateOf != null && duplicateOf !== page) return "duplicate";
  if (count) return "store";
  return error && !noCards ? "skip" : "end";
}

// 连续这么多页都打开出错 → 不再一页页重试,按"列表大概到头了"停下
export const MAX_CONSECUTIVE_FAILED_PAGES = 2;

// 收集结束后的一句话说明。endedAfter = 列表最后一页的页码(没到头为 null);
// skipped = 打开出错被跳过的页码。
export function describeCollectOutcome({ requested = [], stored = [], endedAfter = null, skipped = [], duplicateOf = null, gaveUpAt = null } = {}) {
  const parts = [];
  const storedCount = stored.length;
  if (gaveUpAt != null) {
    parts.push(`从第 ${gaveUpAt} 页起连续打不开,后面的页没有再读(可能列表在第 ${gaveUpAt - 1} 页就结束了),已排序读到的 ${storedCount} 页。`);
  } else if (endedAfter != null) {
    const reason = duplicateOf != null
      ? `第 ${endedAfter + 1} 页拿到的是第 ${duplicateOf} 页的内容`
      : `第 ${endedAfter + 1} 页没有卡片`;
    parts.push(`列表在第 ${endedAfter} 页结束(${reason}),已排序读到的 ${storedCount} 页。`);
  } else {
    parts.push(`收齐了 ✓ 读了 ${storedCount} 页。`);
  }
  if (skipped.length) {
    parts.push(`第 ${skipped.join("、")} 页打开出错,已跳过,其余照常排序;想补上就再点一次下面的排序按钮重试。`);
  }
  return parts.join(" ");
}

// 网站限速时怎么放慢(纯函数):429 / 503 → 等一会儿再读同一页(最多 3 次),之后每页之间多等一些。
// retryAfter = 网站给的 Retry-After(秒数或日期);最多等 60 秒;页间隔最长 10 秒。
export const MAX_RATE_RETRIES = 3;

export function slowDownPlan({ status, retryAfter = null, delayMs = 400, attempt = 0, now = Date.now() } = {}) {
  const limited = status === 429 || status === 503;
  if (!limited || attempt >= MAX_RATE_RETRIES) return { retry: false, waitMs: 0, nextDelayMs: delayMs };
  let waitMs = 0;
  if (retryAfter != null && retryAfter !== "") {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) waitMs = seconds * 1000;
    else {
      const when = Date.parse(retryAfter);
      if (Number.isFinite(when)) waitMs = when - now;
    }
  }
  if (!(waitMs > 0)) waitMs = 5000 * 2 ** attempt;
  return {
    retry: true,
    waitMs: Math.min(60000, Math.max(1000, waitMs)),
    nextDelayMs: Math.min(10000, Math.max(1500, delayMs * 2))
  };
}
