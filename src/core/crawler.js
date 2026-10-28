import { derivePageUrlFactory } from "./source.js";
import { parseLocalDay, toDateInputValue } from "./parsers.js";

const DEFAULT_RETRIES = 2;
const MIN_DATED_ITEMS_FOR_SEEK = 1;

export async function crawlPages({
  sourceUrl,
  adapter,
  fromPage = 1,
  endPage = null,
  pageLimit = 500,
  startDate = "",
  endDate = "",
  earlyStop = true,
  requestDelayMs = 350,
  knownPagination = null,
  signal,
  onPage = async () => {}
}) {
  let pagination = knownPagination;
  let getPageUrl = pagination ? derivePageUrlFactory(sourceUrl, pagination) : null;
  let totalPages = pagination?.totalPages || null;
  let pagesDone = 0;
  let videosFound = 0;
  let failures = 0;
  let stoppedByDate = false;
  let stoppedReason = "";
  let nextPage = fromPage;
  const maxPage = endPage || Infinity;

  for (let page = fromPage; page < fromPage + pageLimit && page <= maxPage; page += 1) {
    if (signal?.aborted) throw new DOMException("Crawl paused", "AbortError");
    if (totalPages && page > totalPages) break;

    const pageUrl = makePageUrl(sourceUrl, page, getPageUrl);
    let pageError = "";
    let items = [];

    try {
      const result = await fetchAndParsePage({ sourceUrl, page, pageUrl, adapter, signal });
      items = result.items;

      if (result.pagination?.pageLinks?.length || result.pagination?.totalPages) {
        pagination = result.pagination;
        getPageUrl = derivePageUrlFactory(sourceUrl, pagination);
        totalPages = result.pagination.totalPages || totalPages;
      }
    } catch (error) {
      failures += 1;
      pageError = error?.message || "Fetch failed";
    }

    pagesDone += 1;
    videosFound += items.length;
    nextPage = page + 1;
    const pageDateRange = analyzePageTargetRange(items, { startDate, endDate });

    await onPage({
      page,
      pageUrl,
      items,
      pagination,
      totalPages,
      pagesDone,
      videosFound,
      failures,
      pageError,
      nextPage,
      endPage,
      stoppedByDate,
      stoppedReason,
      pageDateRange
    });

    if (earlyStop && !endPage && pageDateRange.relation === "older-than-target") {
      stoppedByDate = true;
      stoppedReason = "older-than-target";
      break;
    }

    if (requestDelayMs > 0 && page < fromPage + pageLimit - 1 && page < maxPage) {
      await delay(requestDelayMs, signal);
    }
  }

  return {
    pagesDone,
    videosFound,
    failures,
    nextPage,
    endPage,
    totalPages,
    pagination,
    stoppedByDate,
    stoppedReason,
    targetRangeComplete: Boolean(endPage && nextPage > endPage),
    limitReached: Boolean(endPage ? nextPage <= endPage : pagesDone >= pageLimit && (!totalPages || nextPage <= totalPages))
  };
}

export async function seekDateRangePages({
  sourceUrl,
  adapter,
  startDate = "",
  endDate = "",
  knownPagination = null,
  pageBoundsCache = {},
  requestDelayMs = 350,
  signal,
  onSeek = async () => {}
}) {
  let pagination = knownPagination;
  let getPageUrl = pagination ? derivePageUrlFactory(sourceUrl, pagination) : null;
  const boundsCache = { ...(pageBoundsCache || {}) };
  let requests = 0;

  async function readBounds(page) {
    if (boundsCache[page]) return boundsCache[page];

    if (signal?.aborted) throw new DOMException("Seek paused", "AbortError");

    const pageUrl = makePageUrl(sourceUrl, page, getPageUrl);
    const result = await fetchAndParsePage({ sourceUrl, page, pageUrl, adapter, signal });
    requests += 1;

    if (result.pagination?.pageLinks?.length || result.pagination?.totalPages) {
      pagination = result.pagination;
      getPageUrl = derivePageUrlFactory(sourceUrl, pagination);
    }

    const bounds = makePageDateBounds(result.items, page, { startDate, endDate });
    boundsCache[page] = bounds;

    await onSeek({
      phase: "probe",
      page,
      bounds,
      pagination,
      totalPages: pagination?.totalPages || null,
      requests
    });

    if (requestDelayMs > 0) await delay(requestDelayMs, signal);
    return bounds;
  }

  await onSeek({ phase: "start", requests });
  const firstBounds = await readBounds(1);
  const totalPages = pagination?.totalPages || 1;

  if (!totalPages || totalPages < 1) {
    return makeSeekResult({
      ok: false,
      reason: "no-total-pages",
      pagination,
      boundsCache,
      requests
    });
  }

  const middlePage = Math.max(1, Math.floor((1 + totalPages) / 2));
  const middleBounds = middlePage === 1 ? firstBounds : await readBounds(middlePage);
  const lastBounds = totalPages === 1 ? firstBounds : await readBounds(totalPages);
  const sampledBounds = [firstBounds, middleBounds, lastBounds];
  const enoughDateCoverage = hasEnoughDateCoverage(sampledBounds);
  const chronoVerified = enoughDateCoverage && verifyDescendingChronology(sampledBounds);

  if (!enoughDateCoverage) {
    return makeSeekResult({
      ok: false,
      reason: "insufficient-dates",
      pagination,
      totalPages,
      chronoVerified: false,
      boundsCache,
      requests
    });
  }

  if (!chronoVerified) {
    return makeSeekResult({
      ok: false,
      reason: "not-chronological",
      pagination,
      totalPages,
      chronoVerified,
      boundsCache,
      requests
    });
  }

  await onSeek({ phase: "locating", totalPages, requests });
  const located = await locateDateRangePages({
    totalPages,
    startDate,
    endDate,
    getBounds: readBounds
  });

  return makeSeekResult({
    ok: true,
    reason: located.targetFound ? "target-found" : "target-not-found",
    pagination,
    totalPages,
    chronoVerified,
    targetFound: located.targetFound,
    targetStartPage: located.targetStartPage,
    targetEndPage: located.targetEndPage,
    boundsCache,
    requests
  });
}

export async function locateDateRangePages({ totalPages, startDate = "", endDate = "", getBounds }) {
  const startTime = startDate ? startOfDay(startDate) : -Infinity;
  const endTime = endDate ? endOfDay(endDate) : Infinity;

  const targetStartPage = endDate
    ? await binarySearchFirst(1, totalPages, async (page) => {
        const bounds = await getBounds(page);
        ensureSeekableBounds(bounds);
        return bounds.oldestTime <= endTime;
      })
    : 1;

  if (!targetStartPage) {
    return {
      targetFound: false,
      targetStartPage: null,
      targetEndPage: null
    };
  }

  const firstOlderPage = startDate
    ? await binarySearchFirst(targetStartPage, totalPages, async (page) => {
        const bounds = await getBounds(page);
        ensureSeekableBounds(bounds);
        return bounds.newestTime < startTime;
      })
    : null;
  const targetEndPage = firstOlderPage ? firstOlderPage - 1 : totalPages;

  return {
    targetFound: targetEndPage >= targetStartPage,
    targetStartPage,
    targetEndPage: targetEndPage >= targetStartPage ? targetEndPage : null
  };
}

export async function fetchPageHtml(url, signal, retries = DEFAULT_RETRIES) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        cache: "no-store",
        credentials: "include",
        signal
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.text();
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      lastError = error;
      if (attempt < retries) {
        await delay(400 * (attempt + 1), signal);
      }
    }
  }

  throw lastError || new Error("Fetch failed");
}

export function analyzePageTargetRange(items, { startDate = "", endDate = "" } = {}) {
  const bounds = makePageDateBounds(items, 0, { startDate, endDate });
  return {
    relation: bounds.relation,
    knownDates: bounds.knownDates,
    matchedDates: bounds.matchedDates,
    oldest: bounds.oldest,
    newest: bounds.newest
  };
}

export function makePageDateBounds(items, page, { startDate = "", endDate = "" } = {}) {
  const timestamps = items
    .map((item) => Date.parse(item.metrics?.uploadDate))
    .filter((value) => Number.isFinite(value));

  if (!timestamps.length) {
    return {
      page,
      relation: "unknown",
      knownDates: 0,
      matchedDates: 0,
      oldest: "",
      newest: "",
      oldestTime: null,
      newestTime: null
    };
  }

  const startTime = startDate ? startOfDay(startDate) : -Infinity;
  const endTime = endDate ? endOfDay(endDate) : Infinity;
  const oldestTime = Math.min(...timestamps);
  const newestTime = Math.max(...timestamps);
  const matchedDates = timestamps.filter((value) => value >= startTime && value <= endTime).length;

  let relation = "unknown";
  if (newestTime < startTime) {
    relation = "older-than-target";
  } else if (oldestTime > endTime) {
    relation = "newer-than-target";
  } else if (matchedDates > 0) {
    relation = "intersects-target";
  }

  return {
    page,
    relation,
    knownDates: timestamps.length,
    matchedDates,
    oldest: toShortDate(oldestTime),
    newest: toShortDate(newestTime),
    oldestTime,
    newestTime
  };
}

async function fetchAndParsePage({ pageUrl, page, adapter, signal }) {
  const html = await fetchPageHtml(pageUrl, signal);
  const document = new DOMParser().parseFromString(html, "text/html");
  const result = adapter.collect(document, pageUrl, page);
  return {
    items: result.items || [],
    pagination: result.pagination || null
  };
}

async function binarySearchFirst(low, high, predicate) {
  let answer = null;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (await predicate(middle)) {
      answer = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }

  return answer;
}

export function verifyDescendingChronology(boundsList) {
  const dated = boundsList.filter((bounds) => bounds && bounds.knownDates >= MIN_DATED_ITEMS_FOR_SEEK);
  if (dated.length < Math.min(2, boundsList.length)) return false;

  for (let index = 1; index < dated.length; index += 1) {
    const previous = dated[index - 1];
    const current = dated[index];
    if (previous.page === current.page) continue;
    if (previous.newestTime < current.newestTime || previous.oldestTime < current.oldestTime) {
      return false;
    }
  }

  return true;
}

export function hasEnoughDateCoverage(boundsList) {
  const dated = boundsList.filter((bounds) => bounds && bounds.knownDates >= MIN_DATED_ITEMS_FOR_SEEK);
  return dated.length >= Math.min(2, boundsList.length);
}

function ensureSeekableBounds(bounds) {
  if (!bounds || bounds.knownDates < MIN_DATED_ITEMS_FOR_SEEK) {
    throw new Error("This page does not expose enough dates for binary date seek.");
  }
}

function makeSeekResult({
  ok,
  reason,
  pagination = null,
  totalPages = null,
  chronoVerified = false,
  targetFound = false,
  targetStartPage = null,
  targetEndPage = null,
  boundsCache = {},
  requests = 0
}) {
  return {
    ok,
    reason,
    pagination,
    totalPages,
    chronoVerified,
    targetFound,
    targetStartPage,
    targetEndPage,
    boundsCache,
    requests
  };
}

function makePageUrl(sourceUrl, page, getPageUrl) {
  return page === 1 ? sourceUrl : getPageUrl ? getPageUrl(page) : makeFallbackPageUrl(sourceUrl, page);
}

function makeFallbackPageUrl(sourceUrl, page) {
  const url = new URL(sourceUrl);
  url.searchParams.set("page", String(page));
  return url.href;
}

function startOfDay(value) {
  const date = parseLocalDay(value);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function endOfDay(value) {
  const date = parseLocalDay(value);
  date.setHours(23, 59, 59, 999);
  return date.getTime();
}

function toShortDate(value) {
  return toDateInputValue(new Date(value));
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Crawl paused", "AbortError"));
      return;
    }

    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Crawl paused", "AbortError"));
      },
      { once: true }
    );
  });
}
