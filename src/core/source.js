export function makeSourceKey(adapterId, url) {
  const parsed = new URL(url);
  parsed.hash = "";

  for (const key of [...parsed.searchParams.keys()]) {
    if (/^(page|p|paged|from|start)$/i.test(key)) {
      parsed.searchParams.delete(key);
    }
  }

  return `${adapterId}|${parsed.origin}${parsed.pathname}${parsed.search}`;
}

export function absoluteUrl(value, baseUrl) {
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return "";
  }
}

export function derivePageUrlFactory(baseUrl, pagination) {
  const numericLinks = [...(pagination?.pageLinks || [])].filter((link) => link.page > 0 && link.url);
  const templates = numericLinks
    .map((link) => makeTemplate(baseUrl, link.url, link.page))
    .filter(Boolean);

  return (pageNumber) => {
    const direct = numericLinks.find((link) => link.page === pageNumber);
    if (direct) return direct.url;

    for (const template of templates) {
      const url = template(pageNumber);
      if (url) return url;
    }

    const fallback = new URL(baseUrl);
    fallback.searchParams.set("page", String(pageNumber));
    return fallback.href;
  };
}

function makeTemplate(baseUrl, linkUrl, pageNumber) {
  const base = new URL(baseUrl);
  const linked = new URL(linkUrl, baseUrl);

  const pageParam = [...linked.searchParams.entries()].find(([key, value]) => {
    return value === String(pageNumber) && /page|paged|p/i.test(key);
  });
  if (pageParam) {
    return (targetPage) => {
      const next = new URL(linked.href);
      linked.searchParams.forEach((value, key) => next.searchParams.set(key, value));
      next.searchParams.set(pageParam[0], String(targetPage));
      return next.href;
    };
  }

  const exactParam = [...linked.searchParams.entries()].find(([, value]) => value === String(pageNumber));
  if (exactParam) {
    return (targetPage) => {
      const next = new URL(linked.href);
      linked.searchParams.forEach((value, key) => next.searchParams.set(key, value));
      next.searchParams.set(exactParam[0], String(targetPage));
      return next.href;
    };
  }

  const segments = linked.pathname.split("/");
  const pageSegmentIndex = segments.findIndex((segment) => segment === String(pageNumber));
  if (pageSegmentIndex >= 0) {
    return (targetPage) => {
      const next = new URL(linked.href);
      const nextSegments = next.pathname.split("/");
      nextSegments[pageSegmentIndex] = String(targetPage);
      next.pathname = nextSegments.join("/");
      return next.href;
    };
  }

  return null;
}
