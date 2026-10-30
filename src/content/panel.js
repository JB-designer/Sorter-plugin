// Advanced Card Sort · https://github.com/JB-designer/Sorter-plugin · MIT License
/*
 * Advanced Card Sort — 页面内悬浮面板 v0.8(样稿 v7:F1–F8,配色 A「睡莲」)
 *
 * 核心原则(用户定义):这是排序插件,不是过滤插件。
 *   - 读取范围决定去收集哪些页;范围内的所有卡片全部展示,只是顺序变化。
 *   - 不去重:同一内容出现几次就排几张(完全相同的链接+标题才合并,并记账)。
 *   - 收集数、展示数全程可见;绝不静默减少;出错、跳过、列表到头都用一直显示的提示写明。
 */
(function () {
  "use strict";
  if (globalThis.__cardSorterPanel) return;

  var engine = globalThis.CardSorterEngine;
  var picker = globalThis.__cardSorterPicker;

  var core = null;
  var host = null;
  var shadow = null;
  var ui = {};

  var state = {
    rule: null,
    ruleKey: "",
    dirty: false,
    candidates: [],
    cardSignature: "",
    cardCount: 0,
    currentPage: 1,
    totalPages: null,        // 从页面分页条读出的总页数;读不出 = null(界面写"网站没显示总页数")
    pagesData: new Map(),   // 页码 → 该页卡片数组(不跨页去重;重录同一页则整页替换)
    sortRules: [],
    bucketState: null,
    pageRange: null,         // 读取范围控件的状态(src/core/page-range.js)
    editingStart: false,     // "从别的页开始"展开
    dateMode: false,         // 按日期范围读(旧功能,放在面板底部的链接里)
    collecting: false,
    collectCancelled: false,
    collectProgress: "",
    tabBatch: null,          // 后台翻页批次的 promise 挂点
    pageTemplates: [],       // 翻页网址模板候选(逐一验证)
    templateIndex: 0,
    pageDelayMs: 400,        // 两页之间的间隔;网站限速时自动放慢
    slowedDown: false,
    picking: false,
    notes: [],               // 面板顶部一直显示的提示(F8):{ id, tone, title, body, actions }
    summary: null,           // 最近一次排序的结果:{ count, whole, pages, sentence, view, catalog }
    lastCollectNote: null,   // 页码模式最近一次读取的说明(列表在哪页结束、跳过了哪些页)
    lastRequested: null,     // 最近一次要读的页码范围 { from, to, readToEnd }
    flashRuleIndex: -1,      // 下拉框互换规则后,需要短暂高亮的那一行
    menuIndex: -1,           // 打开着数字菜单的规则序号
    lastResultId: null,      // 最近一次排序的结果缓存 id;有值且无任何改动时,前 5 名下面显示「打开完整结果」
    setupFolded: false       // 排好后设置区收成一行摘要,点「修改」展开
  };

  var SORT_PRIORITY = ["downloads", "favorites", "likes", "views", "heat", "comments", "endorsements", "score", "dislikes", "fileSize", "price"];
  var DATE_CRAWL_PAGE_CAP = 100; // 和页码模式一致:一次最多读 100 页

  /* ================= 入口与初始化 ================= */

  async function toggle() {
    if (host) {
      host.style.display = host.style.display === "none" ? "" : "none";
      return;
    }
    await loadCore();
    buildPanel();
    state.ruleKey = core.rules.makeRuleKey(location.href);
    state.rule = normalizeRule(await core.rules.getRuleForUrl(location.href));
    detectCurrentPage();
  }

  async function loadCore() {
    if (core) return;
    var url = function (path) { return chrome.runtime.getURL(path); };
    core = {
      rules: await import(url("src/core/rules.js")),
      sort: await import(url("src/core/sort.js")),
      buckets: await import(url("src/core/buckets.js")),
      fields: await import(url("src/core/fields.js")),
      pagination: await import(url("src/core/pagination.js")),
      pageRange: await import(url("src/core/page-range.js")),
      resultView: await import(url("src/core/result-view.js")),
      crawler: await import(url("src/core/crawler.js")),
      generic: await import(url("src/core/generic-adapter.js")),
      i18n: await import(url("src/core/i18n.js"))
    };
  }

  // 界面文案(英文/中文,见 src/core/i18n.js)
  function t(key, params) {
    return core.i18n.t(key, params);
  }

  // 拼进 innerHTML 的文案先转义
  function esc(text) {
    return String(text).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // 新面板里所有找到的数字都能在菜单里选,所以记住的规则要把每个能排序的数字都读出来
  function normalizeRule(rule) {
    if (!rule || !Array.isArray(rule.slots)) return rule || null;
    rule.slots.forEach(function (slot) { if (!slot.excluded && slot.type !== "text") slot.enabled = true; });
    return rule;
  }

  /* ================= 识别当前页 ================= */

  function detectCurrentPage() {
    var page = currentPageNumber();
    state.currentPage = page;
    state.totalPages = detectTotalPages(page);
    state.pageRange = core.pageRange.createPageRange({ current: page, total: state.totalPages });
    state.editingStart = false;
    invalidateResultCache(); // 重新识别/换页 = 输入变了,旧结果缓存不再对应当前选择
    setScope(t("scanning"));

    if (state.rule) {
      var applied = engine.applyRule(document, state.rule, { pageUrl: location.href, page: page });
      if (applied.ok && applied.healthy && !applied.signatureMismatch) {
        state.cardCount = applied.cardCount;
        state.cardSignature = applied.signature || state.rule.cardSignature;
        state.rule.slots.forEach(function (slot) {
          if (slot.label || slot.siteLabel || slot.icon || slot.excluded) return;
          try { slot.icon = engine.iconForSlot(document, slot); } catch (e) { slot.icon = null; }
        });
        state.candidates = state.rule.slots.map(function (slot) {
          return Object.assign({}, slot, {
            coverage: applied.fieldCoverage[slot.id] || { count: 0, total: applied.cardCount },
            examples: slot.examples || [],
            enabled: true
          });
        });
        state.sortRules = (state.rule.sortRules || []).map(function (r) { return Object.assign({}, r); });
        state.dirty = false;
        storePage(page, applied.items);
        renderAll();
        return;
      }
      state.rule = null;
      addNote({ id: "redesign", tone: "warn", title: t("layoutTitle"), body: t("layoutBody"), actions: [{ id: "dismiss", label: t("gotIt") }] });
    }

    var discovered = engine.discover(document, { pageUrl: location.href, page: page });
    if (!discovered.ok) {
      state.cardCount = 0;
      state.candidates = [];
      renderAll();
      setScope(t("noCards"));
      return;
    }
    state.cardCount = discovered.cardCount;
    state.cardSignature = discovered.signature;
    mergeCandidates(discovered.candidates);
    storePage(page, discovered.items);
    if (!state.sortRules.length) resetDefaultSortRule();
    state.dirty = !state.rule;
    renderAll();
  }

  function detectTotalPages(page) {
    var fromLinks = core.pageRange.detectTotalPages(numberedPageLinks(), location.href, page);
    // 分页条里最后一页常常不是链接("1 2 3 … 20" 里的 20 是灰字)→ 有分页链接时也看分页条里的纯数字
    var pagers = pagerElements();
    var pagerMax = null;
    if (fromLinks != null) {
      pagers.forEach(function (pager) {
        pager.querySelectorAll("*").forEach(function (node) {
          if (node.children.length) return;
          var text = (node.textContent || "").trim();
          if (/^\d{1,5}$/.test(text) && Number(text) > (pagerMax || 0)) pagerMax = Number(text);
        });
      });
    }
    // 没有数字链接、只写着 "Page 1 of 50" / "共 50 页" 的网站
    var texts = [document.title].concat(pagers.map(function (pager) { return (pager.textContent || "").slice(0, 300); }));
    var fromText = core.pageRange.totalFromText(texts);
    var best = Math.max(fromLinks || 0, pagerMax || 0, fromText || 0);
    return best ? Math.max(best, page) : null;
  }

  function numberedPageLinks() {
    var anchors = [];
    document.querySelectorAll("a[href]").forEach(function (a) {
      if (host && host.contains(a)) return;
      var text = (a.textContent || "").trim();
      if (/^\d{1,5}$/.test(text)) anchors.push({ text: text, href: a.href });
    });
    return anchors;
  }

  function pagerElements() {
    var found = [];
    document.querySelectorAll("[class*='pagination' i],[class*='pager' i],[class*='paging' i]").forEach(function (node) {
      if (host && host.contains(node)) return;
      if (found.some(function (outer) { return outer.contains(node); })) return;
      if ((node.textContent || "").length <= 600) found.push(node);
    });
    return found.slice(0, 4);
  }

  // "下一页" 链接:没有 "1 2 3" 数字链接、只有 next 按钮的网站,靠它推出翻页网址
  function nextPageLink() {
    var rel = document.querySelector("a[rel~='next'][href],link[rel~='next'][href]");
    if (rel && !(host && host.contains(rel))) return rel.href;
    var anchors = document.querySelectorAll("a[href]");
    for (var i = 0; i < anchors.length; i += 1) {
      var a = anchors[i];
      if (host && host.contains(a)) continue;
      var text = ((a.textContent || "").trim() || a.getAttribute("aria-label") || "").trim();
      var identity = (a.getAttribute("class") || "") + " " + ((a.parentElement && a.parentElement.getAttribute("class")) || "");
      if (/^(?:next(?: page)?|下一?页|下一?頁|›|»|>|→)$/i.test(text) || /(?:^|[\s_-])next(?:$|[\s_-])/i.test(identity)) {
        if (a.href && a.href.split("#")[0] !== location.href.split("#")[0] && /^https?:/.test(a.href)) return a.href;
      }
    }
    return null;
  }

  // 不做跨页去重;同一页重新收集时整页替换(避免重复累计)
  function storePage(page, items) {
    var stamped = (items || []).map(function (item, index) {
      item.sourcePage = page;
      item.uid = page + ":" + index;
      return item;
    });
    state.pagesData.set(page, stamped);
  }

  function pool() {
    var all = [];
    var pages = Array.from(state.pagesData.keys()).sort(function (a, b) { return a - b; });
    pages.forEach(function (page) {
      state.pagesData.get(page).forEach(function (item) { all.push(item); });
    });
    return all;
  }

  // 展示池:同链接同标题的完全重复只留第一张(跨页置顶/推荐位造成),合并数记账
  function displayPool() {
    var seen = {};
    var merged = [];
    var duplicates = 0;
    pool().forEach(function (item) {
      var key = contentSignature(item) + "|" + (item.title || "");
      if (seen[key]) { duplicates += 1; return; }
      seen[key] = true;
      merged.push(item);
    });
    displayPool.mergedCount = duplicates;
    return merged;
  }

  function mergeCandidates(candidates) {
    var byKey = {};
    state.candidates.forEach(function (c) { byKey[slotKeyOf(c)] = c; });
    var next = (candidates || []).map(function (candidate) {
      return Object.assign({}, candidate, { enabled: true });
    });
    state.candidates.forEach(function (old) {
      if (old.source === "picker" && !next.some(function (c) { return slotKeyOf(c) === slotKeyOf(old); })) {
        next.push(old);
      }
    });
    state.candidates = next;
  }

  function slotKeyOf(c) {
    return c.path + "~" + (c.textIndex == null ? "" : c.textIndex) + "@" + (c.attr || "") + "#" + (c.pairLabel || "");
  }

  function currentPageNumber() {
    try {
      var parsed = new URL(location.href);
      var keys = ["page", "p", "paged", "pg"];
      for (var i = 0; i < keys.length; i += 1) {
        var value = Number(parsed.searchParams.get(keys[i]));
        if (Number.isInteger(value) && value > 0) return value;
      }
      var segment = parsed.pathname.match(/\/(?:page|p)[-/]?(\d{1,5})(?:\.[a-z0-9]{2,5})?(?:\/|$)/i);
      if (segment) return Number(segment[1]);
    } catch (e) { /* ignore */ }
    return 1;
  }

  /* ================= 字段与排序规则 ================= */

  function sortableCandidates() {
    return state.candidates.filter(function (c) { return !c.excluded && c.type !== "text"; });
  }

  function excludedCandidates() {
    return state.candidates.filter(function (c) { return c.excluded || c.type === "text"; });
  }

  function fieldCatalog() {
    var items = displayPool();
    return sortableCandidates().map(function (slot) {
      var count = 0;
      var example = null;
      items.forEach(function (item) {
        if (item.metrics && item.metrics[slot.id] != null) {
          count += 1;
          if (!example) example = item;
        }
      });
      var named = slot.label || slot.siteLabel;
      var field = {
        id: slot.id,
        label: named ? core.resultView.fieldName({ label: named }) : "",
        icon: named ? null : slot.icon || null,
        type: slot.type,
        count: count,
        total: items.length,
        canonicalId: slot.canonicalId || "",
        example: example
      };
      // 没名字的数字靠"图标 / 数字 + 例子"来认:例子取第一张有这个数字的卡片
      var shown = example ? core.resultView.formatCardValue(example, field) : "";
      field.exampleValue = shown && shown !== "—" ? shown : "";
      return field;
    });
  }

  function hasDateField() {
    return sortableCandidates().some(function (slot) { return slot.type === "date"; });
  }

  function resetDefaultSortRule() {
    var catalog = fieldCatalog().filter(function (f) { return f.count > 0; });
    if (!catalog.length) { state.sortRules = []; return; }
    var chosen = null;
    for (var i = 0; i < SORT_PRIORITY.length && !chosen; i += 1) {
      chosen = catalog.find(function (f) { return f.canonicalId === SORT_PRIORITY[i]; }) || null;
    }
    if (!chosen) chosen = catalog.find(function (f) { return f.type === "number"; }) || catalog[0];
    state.sortRules = [makeSortRule(chosen)];
  }

  function makeSortRule(field) {
    var bandable = field && (field.type === "number" || field.type === "duration" || field.type === "date");
    return {
      field: field ? field.id : "",
      direction: "desc",
      mode: bandable ? "bucket" : "exact",
      min: "",
      max: "",
      enabled: true
    };
  }

  /* ================= 范围 ================= */

  function rangeMode() {
    if (state.dateMode) return "date";
    var view = core.pageRange.describePageRange(state.pageRange);
    return view.thisOn ? "current" : "pages";
  }

  function rangeConfig() {
    var mode = rangeMode();
    var range = state.pageRange;
    return {
      sourceUrl: location.href,
      scopeFilters: { date: mode === "date", page: mode !== "date", all: false },
      startDate: mode === "date" ? ui.startDate.value : "",
      endDate: mode === "date" ? ui.endDate.value : "",
      startPage: mode === "current" ? state.currentPage : range.start,
      endPage: mode === "current" ? state.currentPage : range.end,
      fieldCatalog: fieldCatalog(),
      poolSize: pool().length
    };
  }

  // 分档根据所有已读的卡片计算,每读一页、每次排序都重算
  function refreshBands(config) {
    var cfg = config || rangeConfig();
    var scoped = core.sort.applyFiltersAndSort(displayPool(), [], cfg);
    state.bucketState = core.buckets.buildBucketState(scoped, cfg.fieldCatalog, cfg);
    return cfg;
  }

  function sortedItems() {
    var cfg = refreshBands();
    cfg.bucketState = state.bucketState;
    return core.sort.applyFiltersAndSort(displayPool(), state.sortRules, cfg);
  }

  /* ================= 主流程:排序(先收齐,再排,再展示) ================= */

  /* ---------------- 结果缓存与主按钮状态 ---------------- */

  function setResultCache(rid) {
    state.lastResultId = rid || null;
    renderCta();
  }

  // 任何会改变排序输入的动作(范围/规则/重新识别/点选)都让缓存失效
  // 失效后:前 5 名变灰,设置区展开,主按钮恢复「读取并排序」
  function invalidateResultCache() {
    if (!state.lastResultId) return;
    state.lastResultId = null;
    state.setupFolded = false;
    renderNotes();
    renderSetup();
    renderCta();
  }

  function reopenResults() {
    var rid = state.lastResultId;
    chrome.runtime.sendMessage({ type: "card-sorter-reopen-results", rid: rid }, function (response) {
      var failure = chrome.runtime.lastError
        ? chrome.runtime.lastError.message
        : (response && response.ok === false ? response.error : "");
      if (failure) {
        addNote({ id: "open", tone: "warn", title: t("openFailTitle"), body: failure || t("tryAgain"), actions: [{ id: "dismiss", label: t("gotIt") }] });
        invalidateResultCache();
      }
    });
  }

  async function runSort() {
    if (state.collecting) return;
    // 上次排序后没有任何改动 → 直接重开缓存的结果页,不重新收集
    if (state.lastResultId) {
      reopenResults();
      return;
    }
    if (!fieldCatalog().length) {
      addNote({ id: "nofield", tone: "warn", title: t("noFieldTitle"), body: t("noFieldBody"), actions: [{ id: "dismiss", label: t("gotIt") }] });
      return;
    }
    clearRunNotes();
    state.lastCollectNote = null;
    state.lastRequested = null;
    var mode = rangeMode();

    if (mode === "pages") {
      var view = core.pageRange.describePageRange(state.pageRange);
      if (!view.ctaEnabled) return;
      var pages = view.pages;
      var from = pages[0];
      var to = pages[pages.length - 1];
      state.lastRequested = { from: from, to: to, readToEnd: view.readToEnd };
      var missing = pages.filter(function (n) { return !state.pagesData.has(n); });
      if (missing.length) {
        await autoRemember();
        await collectPages(missing, { from: from, to: to, readToEnd: view.readToEnd });
        var readAny = pages.some(function (n) { return state.pagesData.has(n); });
        if (!readAny) return; // 什么都没读到,提示已给出
      }
    } else if (mode === "date") {
      if (!ui.startDate.value && !ui.endDate.value) {
        addNote({ id: "date", tone: "warn", title: t("dateRangeTitle"), body: t("dateRangeBody"), actions: [{ id: "dismiss", label: t("gotIt") }] });
        return;
      }
      if (!hasDateField()) {
        addNote({ id: "date", tone: "warn", title: t("noDateTitle"), body: t("noDateBody"), actions: [{ id: "dismiss", label: t("gotIt") }] });
        return;
      }
      await autoRemember();
      var ok = await collectForDateRange();
      if (!ok) return;
    }

    openResults();
  }

  // 去别的页读卡片前,需要一份"这个网站的卡片和数字在哪"的规则:自动记住(以前要手动点「记住这个网站」)
  async function autoRemember() {
    if (state.rule && !state.dirty) return;
    await rememberSite(true);
  }

  /* ---------------- 翻页模板管理与"同一页"识别 ---------------- */

  function prepareTemplates() {
    var anchors = numberedPageLinks();
    var next = nextPageLink();
    if (next) anchors.push({ text: String((state.currentPage || currentPageNumber()) + 1), href: next });
    state.pageTemplates = core.pagination.makePageUrlTemplates(anchors, location.href);
    state.templateIndex = 0;
  }

  function urlFor(page) {
    return state.pageTemplates[state.templateIndex].make(page);
  }

  // 第 1 页的规范网址(用户可能正停在第 N 页,二分探测必须从第 1 页起算)
  function pageOneUrl() {
    try {
      return urlFor(1);
    } catch (e) {
      return location.href;
    }
  }

  function advanceTemplate() {
    if (state.templateIndex + 1 < state.pageTemplates.length) {
      state.templateIndex += 1;
      return true;
    }
    return false;
  }

  function pageSignatures(items) {
    return (items || []).map(contentSignature);
  }

  // 新收的页和已有某页内容雷同 → 翻页网址没生效,返回撞上的页码
  function looksLikeExistingPage(items) {
    if (!items || !items.length) return null;
    var signatures = pageSignatures(items);
    var pages = Array.from(state.pagesData.keys());
    for (var i = 0; i < pages.length; i += 1) {
      if (core.pagination.pagesLookIdentical(signatures, pageSignatures(state.pagesData.get(pages[i])))) {
        return pages[i];
      }
    }
    return null;
  }

  function paginationFailedText(page, dupPage) {
    return t("cantTurnPages", { tries: state.pageTemplates.length, page: page, dup: dupPage });
  }

  /* ---------------- 收集:指定页码 ---------------- */

  // 页码模式:列表比要读的页数短时不算错 —— 读到头就停、用已读的页排序;
  // 打不开的页跳过并写明页码,其余照常排序。
  async function collectPages(pageNumbers, range) {
    beginCollect();
    prepareTemplates();
    var result = await collectPagesInner(pageNumbers, { tolerant: true, range: range });
    state.lastCollectNote = result.note || null;
    endCollect(result.message);
    // 什么都没读到:用不会自动消失的提示写明(跳过、到头等说明在排好之后一起显示,见 addRunNotes)
    if (!result.ok && !state.collectCancelled) {
      addNote({ id: "error", tone: "warn", title: t("noCardsReadTitle"), body: result.message, actions: [{ id: "dismiss", label: t("gotIt") }] });
    }
    return result.ok;
  }

  // 内核:收集指定页码(不管理 begin/end,供页码模式与日期模式共用)。返回 { ok, message, note }。
  // opts.tolerant(只有页码模式用):列表到头 → 停下但不算失败;出错的页 → 跳过并记下。
  // 日期模式不传 tolerant,行为和以前一样(任何一页收不到就停下报错)。
  async function collectPagesInner(pageNumbers, opts) {
    var tolerant = Boolean(opts && opts.tolerant);
    var range = (opts && opts.range) || null;
    var remaining = pageNumbers.slice();
    var suspicious = false;
    var note = { endedAfter: null, duplicateOf: null, skipped: [], gaveUpAt: null };
    var consecutiveFails = 0;
    var rateAttempts = 0;
    var templateProven = false; // 当前翻页写法是否已经成功读到过一页
    var total = pageNumbers.length;
    var progress = function (page) {
      var done = total - remaining.length;
      setCollectProgress(t("progress", { page: page, done: done, total: total, slowed: state.slowedDown }));
    };

    function finishTolerant() {
      // 算"读到的页"时包括这次之前就收过的页(比如当前页)
      var stored = Array.from(state.pagesData.keys()).filter(function (n) {
        return range ? n >= range.from && n <= range.to : pageNumbers.indexOf(n) >= 0;
      }).sort(function (a, b) { return a - b; });
      var message = core.pagination.describeCollectOutcome({
        requested: pageNumbers,
        stored: stored,
        endedAfter: note.endedAfter,
        duplicateOf: note.duplicateOf,
        skipped: note.skipped,
        gaveUpAt: note.gaveUpAt
      });
      var lowNote = lowCountText(stored);
      if (lowNote && note.endedAfter == null) message += " " + lowNote;
      if (!stored.length) {
        return {
          ok: false,
          note: note,
          message: t("noCardsReadBody", note.endedAfter)
        };
      }
      return { ok: true, message: message, note: note };
    }

    // 列表到头:剩下的页都不用再读了
    function endListAt(page, duplicateOf) {
      note.endedAfter = page - 1;
      note.duplicateOf = duplicateOf == null ? null : duplicateOf;
      remaining = [];
    }

    // 快速模式:同源 fetch(带登录态)
    while (remaining.length && !state.collectCancelled && !suspicious) {
      var page = remaining[0];
      progress(page);
      var outcome = await fetchAndExtract(urlFor(page), page);
      // 这种翻页写法还没成功读到过一页,网站却说"没有这个网址"(404/410):多半是写法猜错了,
      // 先用其余写法试同一页;都不行就退回原来的写法,照以前的流程走
      if (!templateProven && isMissingPage(outcome)) {
        var originalTemplate = state.templateIndex;
        var switched = false;
        while (advanceTemplate()) {
          setCollectProgress(t("missingRetry", page));
          var trial = await fetchAndExtract(urlFor(page), page);
          if (!isMissingPage(trial)) { outcome = trial; switched = true; break; }
        }
        if (!switched) state.templateIndex = originalTemplate;
      }
      // 网站限速(429 / 503):按网站的要求等一会儿、放慢后重读这一页,并在结束后说明
      var plan = core.pagination.slowDownPlan({ status: outcome.status, retryAfter: outcome.retryAfter, delayMs: state.pageDelayMs, attempt: rateAttempts });
      if (plan.retry) {
        state.slowedDown = true;
        state.pageDelayMs = plan.nextDelayMs;
        rateAttempts += 1;
        setCollectProgress(t("rateWait", { s: Math.round(plan.waitMs / 1000), page: page }));
        await sleep(plan.waitMs);
        continue;
      }
      rateAttempts = 0;
      if (outcome.error || isSuspicious(outcome)) {
        suspicious = true;
        break;
      }
      var dupPage = looksLikeExistingPage(outcome.items);
      if (dupPage != null && dupPage !== page) {
        if (advanceTemplate()) {
          setCollectProgress(t("dupRetry", { page: page, dup: dupPage }));
          await sleep(300);
          continue; // 换模板重收同一页
        }
        if (tolerant) { endListAt(page, dupPage); break; }
        return { ok: false, message: paginationFailedText(page, dupPage) };
      }
      storePage(page, outcome.items);
      templateProven = true;
      remaining.shift();
      await sleep(state.pageDelayMs);
    }

    // 真实翻页模式:后台标签页(逐页,同样验证翻页是否生效)
    // 原则:空页/出错的页绝不静默入库 —— 重试一次;仍失败时,日期模式停下报错,
    // 页码模式按"列表到头"或"跳过这一页"处理并写明
    if (remaining.length && !state.collectCancelled) {
      setCollectProgress(t("backgroundTab"));
      while (remaining.length && !state.collectCancelled) {
        var tabPage = remaining[0];
        var tabItems = [];
        var tabError = "";
        var tabNoCards = false;
        for (var attempt = 0; attempt < 2 && !state.collectCancelled; attempt += 1) {
          if (attempt) {
            // 第一次没打开:先等一会儿再试(网站可能在限速)
            setCollectProgress(t("pageRetry", tabPage));
            await sleep(Math.max(3000, state.pageDelayMs));
            if (state.collectCancelled) break;
          }
          progress(tabPage);
          var results = await crawlViaTabs([{ page: tabPage, url: urlFor(tabPage) }]);
          var got = results[tabPage] || { items: [], error: "" };
          tabItems = got.items || [];
          tabError = got.error || "";
          tabNoCards = Boolean(got.noCards);
          if (tabItems.length) break;
        }
        if (state.collectCancelled) break;
        var tabDup = tabItems.length ? looksLikeExistingPage(tabItems) : null;
        var verdict = core.pagination.classifyCollectedPage({ items: tabItems, error: tabError, noCards: tabNoCards, duplicateOf: tabDup, page: tabPage });
        if (!tolerant && (verdict === "end" || verdict === "skip")) {
          return {
            ok: false,
            message: t("pageNoCardsAfterRetry", tabPage)
          };
        }
        if (verdict === "end") { endListAt(tabPage, null); break; }
        if (verdict === "skip") {
          note.skipped.push(tabPage);
          consecutiveFails += 1;
          remaining.shift();
          if (consecutiveFails >= core.pagination.MAX_CONSECUTIVE_FAILED_PAGES) {
            note.gaveUpAt = note.skipped[note.skipped.length - consecutiveFails];
            note.skipped = note.skipped.slice(0, note.skipped.length - consecutiveFails);
            remaining = [];
          }
          continue;
        }
        if (verdict === "duplicate") {
          if (advanceTemplate()) {
            setCollectProgress(t("dupRetry", { page: tabPage, dup: tabDup }));
            continue;
          }
          if (tolerant) { endListAt(tabPage, tabDup); break; }
          return { ok: false, message: paginationFailedText(tabPage, tabDup) };
        }
        consecutiveFails = 0;
        storePage(tabPage, tabItems);
        templateProven = true;
        remaining.shift();
      }
      // 后台读页用的那个临时标签页整次只开一个,读完马上关
      chrome.runtime.sendMessage({ type: "card-sorter-crawl-finish" });
    }

    var cancelled = state.collectCancelled;
    if (cancelled) return { ok: false, message: t("stoppedKept"), note: note };
    if (tolerant) return finishTolerant();
    return { ok: true, message: collectSummaryText(pageNumbers) };
  }

  function lowCountText(pageNumbers) {
    var counts = pageNumbers.map(function (n) {
      return { page: n, count: (state.pagesData.get(n) || []).length };
    });
    var max = 0;
    counts.forEach(function (c) { if (c.count > max) max = c.count; });
    var low = counts.filter(function (c) { return max >= 5 && c.count < max * 0.5; });
    if (!low.length) return "";
    return t("lowCount", { parts: low, max: max });
  }

  // 收齐后的诚实校验:某页数量和其他页差太多 → 明说,不静默
  function collectSummaryText(pageNumbers) {
    var low = lowCountText(pageNumbers);
    return low || t("allRead");
  }

  /* ---------------- 收集:日期范围(从第1页往回翻,翻过头就停) ---------------- */

  async function collectForDateRange() {
    beginCollect();
    prepareTemplates();
    var result;
    try {
      result = await collectDateRangeInner();
    } catch (error) {
      result = {
        ok: false,
        message: state.collectCancelled
          ? t("stoppedKept")
          : t("dateFailBody")
      };
    }
    endCollect(result.message);
    if (!result.ok && !state.collectCancelled) {
      addNote({ id: "error", tone: "warn", title: t("dateFailTitle"), body: result.message, actions: [{ id: "dismiss", label: t("gotIt") }] });
    }
    return result.ok;
  }

  // 日期模式内核:优先二分定位目标页区间(几千页的网站也只需十几次探测);
  // 网站读不出总页数或列表不按时间排序时,回退为"从第 1 页线性往回收"(原有行为)。
  async function collectDateRangeInner() {
    var seek = null;
    try {
      setCollectProgress(t("dateLocating"));
      seek = await core.crawler.seekDateRangePages({
        sourceUrl: pageOneUrl(),
        adapter: core.generic.makeGenericAdapter(state.rule),
        startDate: ui.startDate.value,
        endDate: ui.endDate.value,
        requestDelayMs: 400,
        onSeek: async function (progress) {
          if (state.collectCancelled) throw new DOMException("已停止", "AbortError");
          if (progress.phase === "probe") {
            setCollectProgress(t("dateProbing", progress.requests));
          } else if (progress.phase === "locating") {
            setCollectProgress(t("dateLocating"));
          }
        }
      });
    } catch (error) {
      if (state.collectCancelled) return { ok: false, message: t("stoppedKept") };
      seek = null; // 探测过程出错 → 回退线性(下方会提示)
    }

    if (seek && seek.ok && !seek.targetFound) {
      return {
        ok: false,
        message: t("dateNone", { total: seek.totalPages || "?", range: core.i18n.formatDayRange(ui.startDate.value, ui.endDate.value) })
      };
    }

    if (seek && seek.ok && seek.targetFound) {
      var from = seek.targetStartPage;
      var to = seek.targetEndPage;
      var span = to - from + 1;
      if (span > DATE_CRAWL_PAGE_CAP) {
        return {
          ok: false,
          message: t("dateTooMany", { from: from, to: to, span: span, max: DATE_CRAWL_PAGE_CAP })
        };
      }
      setCollectProgress(t("dateFound", { from: from, to: to, span: span }));
      var missing = [];
      for (var n = from; n <= to; n += 1) {
        if (!state.pagesData.has(n)) missing.push(n);
      }
      if (missing.length) {
        var inner = await collectPagesInner(missing);
        if (!inner.ok) return inner;
      }

      // 复核:定位收到的页里必须真的有范围内的卡片;为 0 就自动校正,不再直接放弃
      var startTime = ui.startDate.value ? new Date(ui.startDate.value + "T00:00:00").getTime() : -Infinity;
      var endTime = ui.endDate.value ? new Date(ui.endDate.value + "T23:59:59.999").getTime() : Infinity;
      var hits = 0;
      for (var p = from; p <= to; p += 1) hits += pageInRangeCount(p, startTime, endTime);
      if (hits > 0) {
        return { ok: true, message: t("allRead") };
      }
      setCollectProgress(t("dateAdjust", Math.round((from + to) / 2)));
      return refineDateLocate(Math.round((from + to) / 2), startTime, endTime, seek.totalPages || null);
    }

    setCollectProgress(t("dateLinear", DATE_CRAWL_PAGE_CAP));
    return collectLinearDateInner();
  }

  /* ---------------- 定位自愈(二分初判偏差时的校正) ---------------- */

  // 本地日期 YYYY-MM-DD(toISOString 是 UTC,会让东八区等时区显示成前一天)
  function isoDay(t) {
    var d = new Date(t);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function pageTimestamps(page) {
    return (state.pagesData.get(page) || [])
      .map(function (item) { return Date.parse(item.metrics && item.metrics.uploadDate); })
      .filter(function (t) { return isFinite(t); });
  }

  function pageInRangeCount(page, startTime, endTime) {
    return pageTimestamps(page).filter(function (t) { return t >= startTime && t <= endTime; }).length;
  }

  // 深层页面常混有"几分钟前"的推荐位,会把二分搜索带偏。
  // 校正:读当前页的实际日期,与目标日期的偏差 ÷ 该页覆盖的时间密度 → 估算跳几页;最多 8 跳。
  async function refineDateLocate(startProbe, startTime, endTime, totalPages) {
    var maxPage = totalPages || Math.max(startProbe + 500, 1000);
    var targetT;
    if (isFinite(startTime) && isFinite(endTime)) targetT = (startTime + endTime) / 2;
    else if (isFinite(startTime)) targetT = startTime + 15 * 86400000;
    else targetT = endTime - 15 * 86400000;

    var probe = Math.max(1, Math.min(maxPage, startProbe));
    var visited = {};
    var lastSpan = null;

    for (var jump = 0; jump < 8 && !state.collectCancelled; jump += 1) {
      if (!state.pagesData.has(probe)) {
        var got = await collectPagesInner([probe]);
        if (!got.ok) return got;
      }
      visited[probe] = true;
      var ts = pageTimestamps(probe);
      if (!ts.length) {
        return { ok: false, message: t("datePageNoDates", probe) };
      }
      var newest = Math.max.apply(null, ts);
      var oldest = Math.min.apply(null, ts);
      lastSpan = { page: probe, newest: newest, oldest: oldest };

      if (pageInRangeCount(probe, startTime, endTime) > 0) {
        return expandAroundHit(probe, startTime, endTime, maxPage);
      }

      var pageT = (newest + oldest) / 2;
      var perPageMs = Math.max(newest - oldest, 3600000); // 每页至少按 1 小时的跨度算,防止除零
      var delta = Math.round((pageT - targetT) / perPageMs); // 页面日期比目标新 → 往更深(页码更大)跳
      if (!delta) delta = pageT > targetT ? 1 : -1;
      var next = Math.max(1, Math.min(maxPage, probe + delta));
      while (visited[next]) {
        next += delta > 0 ? 1 : -1;
        if (next < 1 || next > maxPage) return refineFailure(lastSpan);
      }
      probe = next;
      setCollectProgress(t("dateAdjust", probe));
    }
    if (state.collectCancelled) return { ok: false, message: t("stoppedKept") };
    return refineFailure(lastSpan);
  }

  function refineFailure(lastSpan) {
    return {
      ok: false,
      message: t("dateNotFound", lastSpan ? { page: lastSpan.page, span: core.i18n.formatDayRange(isoDay(lastSpan.oldest), isoDay(lastSpan.newest)) } : {})
    };
  }

  // 命中范围内的页后,向两侧扩展收齐所有仍在范围内的相邻页(两侧合计不超过 DATE_CRAWL_PAGE_CAP 页)
  async function expandAroundHit(hitPage, startTime, endTime, maxPage) {
    var collected = [hitPage];
    for (var dir = -1; dir <= 1; dir += 2) {
      var page = hitPage + dir;
      while (page >= 1 && page <= maxPage && collected.length < DATE_CRAWL_PAGE_CAP && !state.collectCancelled) {
        if (!state.pagesData.has(page)) {
          var got = await collectPagesInner([page]);
          if (!got.ok) break; // 扩展途中失败不致命:收到哪算哪,已收的页保留
        }
        if (pageInRangeCount(page, startTime, endTime) === 0) break;
        collected.push(page);
        page += dir;
      }
    }
    if (state.collectCancelled) return { ok: false, message: t("stoppedKept") };
    collected.sort(function (a, b) { return a - b; });
    return {
      ok: true,
      message: t("allRead")
    };
  }

  // 线性回收内核(回退路径,即原有行为):从第 1 页收到"翻过起始日期"为止,并明确说出停止原因
  async function collectLinearDateInner() {
    var startTime = ui.startDate.value ? new Date(ui.startDate.value + "T00:00:00").getTime() : -Infinity;
    var suspicious = false;
    var page = 1;
    var collectedAny = false;
    var stopMessage = "";

    while (page <= DATE_CRAWL_PAGE_CAP && !state.collectCancelled) {
      var items;
      if (state.pagesData.has(page)) {
        items = state.pagesData.get(page);
      } else {
        setCollectProgress(t("progressSimple", page));
        if (!suspicious) {
          var outcome = await fetchAndExtract(urlFor(page), page);
          if (outcome.error || isSuspicious(outcome)) {
            suspicious = true;
            setCollectProgress(t("backgroundTab"));
            continue; // 同一页用后台方式重收
          }
          items = outcome.items;
        } else {
          items = null;
          for (var attempt = 0; attempt < 2 && !state.collectCancelled; attempt += 1) {
            if (attempt) setCollectProgress(t("pageRetry", page));
            var results = await crawlViaTabs([{ page: page, url: urlFor(page) }]);
            var got = results[page] || { items: [], error: "" };
            items = got.items || [];
            if (items.length) break;
          }
          if (state.collectCancelled) break;
          if (!items.length) {
            return {
              ok: collectedAny,
              message: t("dateStoppedAt", page)
            };
          }
        }
        var dupPage = looksLikeExistingPage(items);
        if (dupPage != null && dupPage !== page) {
          if (advanceTemplate()) {
            setCollectProgress(t("dupRetry", { page: page, dup: dupPage }));
            await sleep(300);
            continue; // 换模板重收同一页
          }
          return { ok: false, message: paginationFailedText(page, dupPage) };
        }
        storePage(page, items);
        if (!suspicious) await sleep(400);
      }
      collectedAny = true;

      // 早停:这一页的日期全部老于起始日期,再往后只会更老
      var timestamps = items
        .map(function (item) { return Date.parse(item.metrics && item.metrics.uploadDate); })
        .filter(function (value) { return isFinite(value); });
      if (timestamps.length && Math.max.apply(null, timestamps) < startTime) {
        stopMessage = t("allRead");
        break;
      }
      if (!timestamps.length && page > 3) {
        stopMessage = t("dateStoppedAt", page);
        break;
      }
      page += 1;
    }

    if (state.collectCancelled) return { ok: false, message: t("stoppedKept") };
    if (!stopMessage && page > DATE_CRAWL_PAGE_CAP) {
      stopMessage = t("dateCap", { max: DATE_CRAWL_PAGE_CAP, date: core.i18n.formatDay(ui.startDate.value) });
    }
    return { ok: collectedAny, message: stopMessage || t("allRead") };
  }

  /* ---------------- 收集底层 ---------------- */

  // 读取中关闭或刷新标签页会丢掉所有已读的页:浏览器弹"离开此网站?"确认。
  // 只在正在读取时拦截(处理函数每次都看 state.collecting,读完或出错后自动不再拦)。
  function warnBeforeLeaving(event) {
    if (!state.collecting) return undefined;
    event.preventDefault();
    event.returnValue = ""; // 旧版 Chrome 需要设置 returnValue 才会弹框
    return "";
  }

  function beginCollect() {
    if (!beginCollect._guarded) {
      window.addEventListener("beforeunload", warnBeforeLeaving);
      beginCollect._guarded = true;
    }
    state.collecting = true;
    state.collectCancelled = false;
    state.collectProgress = t("getReady");
    renderNotes();
    renderCta();
  }

  function endCollect() {
    state.collecting = false;
    state.collectProgress = "";
    renderNotes();
    renderCta();
  }

  function cancelCollect() {
    state.collectCancelled = true;
    if (state.tabBatch) {
      chrome.runtime.sendMessage({ type: "card-sorter-crawl-cancel" });
    }
  }

  async function fetchAndExtract(url, page) {
    try {
      var response = await fetch(url, { credentials: "include", cache: "no-store" });
      if (!response.ok) {
        return { error: "HTTP " + response.status, status: response.status, retryAfter: response.headers.get("Retry-After"), items: [] };
      }
      var html = await response.text();
      var doc = new DOMParser().parseFromString(html, "text/html");
      var result = engine.applyRule(doc, state.rule, { pageUrl: url, page: page });
      return { items: result.items || [], cardCount: result.cardCount || 0 };
    } catch (error) {
      return { error: String(error && error.message || error), items: [] };
    }
  }

  function isMissingPage(outcome) {
    return outcome.status === 404 || outcome.status === 410;
  }

  // 掺假/失效判定:单页数量骤降,或同一页内内容签名大量重复(正常列表页极少页内重复)
  function isSuspicious(outcome) {
    var items = outcome.items || [];
    if (items.length < Math.max(3, state.cardCount * 0.4)) return true;
    var signatures = {};
    var duplicated = 0;
    items.forEach(function (item) {
      var signature = contentSignature(item);
      if (signatures[signature]) duplicated += 1;
      signatures[signature] = true;
    });
    return duplicated / items.length > 0.3;
  }

  function contentSignature(item) {
    // 读不到卡片链接时不能拿空网址去比(会变成当前页地址,所有卡片都"一样")→ 用标题 + 预览图
    if (!item.videoUrl) return "~" + (item.title || "") + "|" + (item.thumbnailUrl || "");
    try {
      var url = new URL(item.videoUrl || "", location.href);
      var idParams = ["id", "vid", "video_id", "v"];
      for (var i = 0; i < idParams.length; i += 1) {
        if (url.searchParams.has(idParams[i])) return url.pathname + "?" + idParams[i] + "=" + url.searchParams.get(idParams[i]);
      }
      return url.pathname;
    } catch (e) {
      return (item.title || "") + "|" + (item.thumbnailUrl || "");
    }
  }

  function crawlViaTabs(entries) {
    return new Promise(function (resolve) {
      var got = {};
      state.tabBatch = {
        onPage: function (message) {
          got[message.page] = { items: message.items || [], error: message.error || "", noCards: Boolean(message.noCards) };
        },
        onDone: function () {
          state.tabBatch = null;
          resolve(got);
        }
      };
      chrome.runtime.sendMessage({ type: "card-sorter-crawl-tabs", urls: entries, rule: state.rule });
    });
  }

  function pageUrlTemplate() {
    var anchors = document.querySelectorAll("a[href]");
    for (var i = 0; i < anchors.length; i += 1) {
      var text = (anchors[i].textContent || "").trim();
      if (!/^\d{1,5}$/.test(text)) continue;
      var pageNumber = Number(text);
      var href = anchors[i].getAttribute("href") || "";
      if (!href || href.charAt(0) === "#") continue;
      try {
        var absolute = new URL(href, location.href);
        var keys = Array.from(absolute.searchParams.keys());
        for (var k = 0; k < keys.length; k += 1) {
          if (absolute.searchParams.get(keys[k]) === String(pageNumber) && /page|^p$|paged/i.test(keys[k])) {
            var paramKey = keys[k];
            var base = absolute.href;
            return function (n) {
              var next = new URL(base);
              next.searchParams.set(paramKey, String(n));
              return next.href;
            };
          }
        }
      } catch (e) { /* ignore */ }
    }
    return function (n) {
      var next = new URL(location.href);
      next.searchParams.set("page", String(n));
      return next.href;
    };
  }

  /* ================= 记住网站 / 点选 ================= */

  // silent = 读别的页之前自动记住(不打扰用户)
  async function rememberSite(silent) {
    if (!state.candidates.length) return;
    var rule = core.rules.makeRule({
      url: location.href,
      cardSignature: state.cardSignature,
      candidates: state.candidates.map(function (c) { return Object.assign({}, c, { enabled: !c.excluded && c.type !== "text" }); }),
      existing: state.rule
    });
    rule.slots.forEach(function (slot) {
      var candidate = state.candidates.find(function (c) { return c.id === slot.id; });
      slot.examples = candidate && candidate.examples ? candidate.examples.slice(0, 3) : [];
    });
    rule.sortRules = state.sortRules;
    await core.rules.saveRule(rule);
    state.rule = rule;
    state.dirty = false;
    if (!silent) renderAll();
  }

  async function forgetSite() {
    await core.rules.deleteRule(state.ruleKey);
    state.rule = null;
    state.dirty = true;
    state.sortRules = [];
    state.notes = [];
    addNote({ id: "forgot", tone: "info", title: t("resetTitle"), body: t("resetBody"), actions: [{ id: "dismiss", label: t("gotIt") }] });
    detectCurrentPage();
  }

  var NEW_RULE = -2; // startPicking 的特殊值:点到的数字加成新的一行

  // forRule = 打开菜单的那条规则;点到的新数字直接用在这条规则上
  function startPicking(forRule) {
    if (state.picking || !picker) return;
    state.picking = forRule === NEW_RULE ? NEW_RULE : true;
    state.menuIndex = -1;
    renderPickBar();
    ui.panel.scrollTop = 0;
    renderRules();
    picker.start({
      onPicked: function (result) {
        state.picking = false;
        invalidateResultCache();
        var firstId = null;
        (result.candidates || []).forEach(function (candidate) {
          var key = slotKeyOf(candidate);
          var existing = state.candidates.find(function (c) { return slotKeyOf(c) === key; }) || sameAttribute(candidate);
          if (existing) { existing.enabled = true; existing.excluded = false; if (!firstId) firstId = existing.id; }
          else { state.candidates.unshift(Object.assign({}, candidate, { enabled: true })); if (!firstId) firstId = candidate.id; }
        });
        state.dirty = true;
        if (firstId && forRule === NEW_RULE) addPickedRule(firstId);
        else if (firstId && forRule >= 0 && state.sortRules[forRule]) chooseField(forRule, firstId);
        else if (firstId && !state.sortRules.length) resetDefaultSortRule();
        renderAll();
      },
      onCancel: function () {
        state.picking = false;
        renderPickBar();
      }
    });
  }

  // 用户点的是已经有的属性(比如又点了下载量)→ 用已有的那一个,不新建
  function sameAttribute(candidate) {
    var label = core.resultView.fieldName({ label: candidate.label || candidate.siteLabel || "" });
    return sortableCandidates().find(function (c) {
      if (c.type !== candidate.type) return false;
      if (candidate.canonicalId && c.canonicalId === candidate.canonicalId) return true;
      if (c.path === candidate.path && c.textIndex === candidate.textIndex && (c.pairLabel || "") === (candidate.pairLabel || "")) return true;
      return Boolean(label) && core.resultView.fieldName({ label: c.label || c.siteLabel || "" }) === label;
    }) || null;
  }

  function addPickedRule(fieldId) {
    var used = state.sortRules.findIndex(function (r) { return r.field === fieldId; });
    if (used >= 0) {
      // 点到的是已经在用的数字 → 不重复加,闪一下那一行
      state.flashRuleIndex = used;
      return;
    }
    var field = fieldCatalog().find(function (f) { return f.id === fieldId; });
    if (field) state.sortRules.push(makeSortRule(field));
  }

  function stopPicking() {
    if (picker) picker.stop();
    state.picking = false;
    renderPickBar();
  }

  /* ================= 打开结果 ================= */

  // 收集池的日期覆盖范围(诊断用):null 表示一张都没读出日期
  function poolDateCoverage() {
    var min = Infinity;
    var max = -Infinity;
    pool().forEach(function (item) {
      var t = Date.parse(item.metrics && item.metrics.uploadDate);
      if (isFinite(t)) {
        if (t < min) min = t;
        if (t > max) max = t;
      }
    });
    if (!isFinite(min)) return null;
    return { min: isoDay(min), max: isoDay(max) };
  }

  function sortedPages(sorted) {
    var seen = {};
    sorted.forEach(function (item) { if (item.sourcePage != null) seen[item.sourcePage] = true; });
    return Object.keys(seen).map(Number).sort(function (a, b) { return a - b; });
  }

  function buildPayload(sorted) {
    var raw = pool().length;
    var unique = displayPool().length;
    return {
      generatedAt: Date.now(),
      sourceUrl: location.href,
      sourceTitle: document.title || location.href,
      ruleKey: state.ruleKey,
      sortRules: state.sortRules,
      fieldCatalog: fieldCatalog().map(function (f) { return { id: f.id, label: f.label, icon: f.icon, exampleValue: f.exampleValue, type: f.type, count: f.count, total: f.total, canonicalId: f.canonicalId }; }),
      bucketState: state.bucketState,
      stats: {
        collected: raw,
        unique: unique,
        merged: raw - unique,
        shown: sorted.length,
        pages: sortedPages(sorted),
        requested: state.lastRequested,
        // 页码模式的读取说明:列表在第几页结束、哪些页打开出错被跳过
        listEndedAfter: state.lastCollectNote ? state.lastCollectNote.endedAfter : null,
        stoppedAtPage: state.lastCollectNote ? state.lastCollectNote.gaveUpAt : null,
        skippedPages: state.lastCollectNote ? state.lastCollectNote.skipped.slice() : [],
        slowedDown: state.slowedDown
      },
      items: sorted.map(function (item) {
        return {
          id: item.uid || item.id,
          title: item.title,
          videoUrl: item.videoUrl,
          thumbnailUrl: item.thumbnailUrl,
          sourcePage: item.sourcePage,
          metrics: item.metrics,
          metricRaw: item.metricRaw || {}
        };
      })
    };
  }

  function openResults(updateRid) {
    var sorted = sortedItems();
    var raw = pool().length;
    if (!sorted.length) {
      var body;
      if (!raw) {
        body = t("emptyNoCards");
      } else if (rangeMode() === "date") {
        var coverage = poolDateCoverage();
        body = coverage
          ? t("emptyDates", { n: raw, range: core.i18n.formatDayRange(ui.startDate.value, ui.endDate.value), span: core.i18n.formatDayRange(coverage.min, coverage.max) })
          : t("emptyNoDates", raw);
      } else {
        body = t("emptyPages", raw);
      }
      addNote({ id: "empty", tone: "warn", title: t("emptyTitle"), body: body, actions: [{ id: "dismiss", label: t("gotIt") }] });
      return;
    }
    var payload = buildPayload(sorted);
    var view = core.resultView.buildResultView({
      items: sorted,
      sortRules: state.sortRules,
      fieldCatalog: payload.fieldCatalog,
      bucketState: state.bucketState,
      limit: 5
    });
    state.summary = {
      count: sorted.length,
      whole: payload.stats.listEndedAfter != null && payload.stats.pages[0] === 1 && !payload.stats.skippedPages.length,
      pages: payload.stats.pages,
      sentence: view.sortSentence,
      view: view,
      catalog: payload.fieldCatalog
    };
    addRunNotes(payload.stats, sorted.length);
    var message = updateRid
      ? { type: "card-sorter-update-results", rid: updateRid, payload: payload }
      : { type: "card-sorter-save-results", payload: payload };
    chrome.runtime.sendMessage(message, function (response) {
      var failure = chrome.runtime.lastError
        ? chrome.runtime.lastError.message
        : (response && response.ok === false ? response.error : "");
      if (failure) {
        addNote({ id: "open", tone: "warn", title: t("openFailTitle"), body: failure || t("tryAgain"), actions: [{ id: "dismiss", label: t("gotIt") }] });
      } else if (response && response.rid) {
        // 排序成功:先在面板里显示前 5 名,不自动打开新标签页;设置区收成一行
        state.setupFolded = true;
        setResultCache(response.rid);
      }
      renderAll();
    });
    renderAll();
  }

  /* ---------------- 一直显示的提示(F8) ---------------- */

  function addNote(note) {
    state.notes = state.notes.filter(function (n) { return n.id !== note.id; });
    state.notes.push(note);
    renderNotes();
  }

  function removeNote(id) {
    state.notes = state.notes.filter(function (n) { return n.id !== id; });
    renderNotes();
  }

  // 新的一次排序开始:上一次读取留下的提示(跳过、到头、成功、出错)清掉
  function clearRunNotes() {
    state.notes = state.notes.filter(function (n) { return n.id === "redesign"; });
    state.summary = null;
    state.slowedDown = false;
    state.pageDelayMs = 400;
    renderNotes();
  }

  function addRunNotes(stats, count) {
    var pagesText = core.resultView.describePageList(stats.pages);
    var requested = stats.requested;
    var pageCount = stats.pages.length;
    if (stats.skippedPages && stats.skippedPages.length) {
      var skipped = stats.skippedPages;
      addNote({
        id: "skipped",
        tone: "warn",
        title: t("skippedTitle", skipped),
        body: t("skippedBody", { pages: skipped, others: pageCount, count: count }),
        actions: [{ id: "retry", label: t("retryPages", skipped), pages: skipped.slice() }]
      });
    } else {
      removeNote("skipped");
    }
    if (stats.stoppedAtPage != null) {
      addNote({
        id: "stopped",
        tone: "warn",
        title: t("stoppedAtTitle", stats.stoppedAtPage),
        body: t("stoppedAtBody", { page: stats.stoppedAtPage, read: pageCount, count: count }),
        actions: [{ id: "retry", label: t("retryPages", [stats.stoppedAtPage]), pages: [stats.stoppedAtPage] }]
      });
    }
    if (stats.listEndedAfter != null) {
      var whole = stats.pages[0] === 1;
      addNote({
        id: "ended",
        tone: "info",
        title: requested && requested.readToEnd ? t("listEndsTitle", stats.listEndedAfter) : t("listOnlyHasTitle", stats.listEndedAfter),
        body: t("allSortedBody", { read: pageCount, count: count }),
        actions: [{ id: "dismiss", label: t("gotIt") }],
        whole: whole
      });
    }
    if (stats.slowedDown) {
      addNote({
        id: "slow",
        tone: "warn",
        title: t("slowTitle"),
        body: t("slowBody"),
        actions: [{ id: "dismiss", label: t("gotIt") }]
      });
    }
    addNote({ id: "done", tone: "ok", title: t("sortedTitle", count) });
  }

  // "下载量 › 点赞数"
  function summarySentence() {
    return core.resultView.describeSortSentence(core.sort.normalizeRules(state.sortRules), fieldCatalog());
  }

  async function retryPages(pages) {
    if (state.collecting || !pages || !pages.length) return;
    await autoRemember();
    var keepRequested = state.lastRequested;
    var previous = state.lastCollectNote;
    await collectPages(pages, null);
    var stillSkipped = (state.lastCollectNote && state.lastCollectNote.skipped) || [];
    var gaveUp = state.lastCollectNote && state.lastCollectNote.gaveUpAt;
    // 重试成功的页从"跳过"里去掉,其余说明保留
    var remainingSkipped = ((previous && previous.skipped) || []).filter(function (p) { return !state.pagesData.has(p); });
    state.lastCollectNote = {
      endedAfter: previous ? previous.endedAfter : null,
      duplicateOf: previous ? previous.duplicateOf : null,
      skipped: remainingSkipped.concat(stillSkipped.filter(function (p) { return remainingSkipped.indexOf(p) < 0; })),
      gaveUpAt: gaveUp ? gaveUp : (previous && previous.gaveUpAt && !state.pagesData.has(previous.gaveUpAt) ? previous.gaveUpAt : null)
    };
    state.lastRequested = keepRequested;
    removeNote("skipped");
    removeNote("stopped");
    openResults(state.lastResultId || null);
  }

  /* ================= UI(样稿 v7,配色 A「睡莲」) ================= */

  var STYLE = [
    ":host{all:initial}",
    ".panel,.bubble{--surface:#FAFAF7;--subtle:#F0F2EE;--border:#DCE0DA;--text:#1F2A2E;--text2:#485659;--text3:#5F6B6D;",
    "--accent:#3B6577;--accentSoft:#E6EEF0;--button:#3B6577;--buttonHover:#2C4F5E;--success:#3D6B4B;--successSoft:#EAF1EA;",
    "--warning:#875414;--warningSoft:#F7EFDF;--danger:#9E3A3A;--dangerSoft:#F7E9E7;--focus:#4A5BA6;--link:#3B5C8F;--field:#FFFFFF;--onAccent:#FFFFFF;color-scheme:light}",
    // Dark palette: every colour comes from these tokens, so text and controls stay readable when the browser or a dark-mode extension darkens the page.
    "@media (prefers-color-scheme:dark){.panel,.bubble{--surface:#1E2427;--subtle:#262E31;--border:#3A4448;--text:#E6ECEE;--text2:#B4C0C3;--text3:#93A1A4;",
    "--accent:#8FBCCD;--accentSoft:#24363E;--button:#4C7E92;--buttonHover:#5B8EA2;--success:#8FC7A0;--successSoft:#1D2C22;",
    "--warning:#E3C07A;--warningSoft:#33291A;--danger:#E59A92;--dangerSoft:#3A2422;--focus:#9AA8E6;--link:#9DBBE6;--field:#262E31;--onAccent:#FFFFFF;color-scheme:dark}}",
    "*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Noto Sans SC','Microsoft YaHei',sans-serif}",
    ".panel{position:fixed;top:16px;right:16px;width:360px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);overflow:auto;z-index:2147483646;",
    "background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:12px;box-shadow:0 6px 24px rgba(31,42,46,.14);font-size:13px;line-height:1.45;text-align:left}",
    ".bubble{position:fixed;top:16px;right:16px;z-index:2147483646;background:var(--button);color:var(--onAccent);border:none;border-radius:20px;padding:8px 16px;font-size:13px;cursor:pointer;box-shadow:0 4px 14px rgba(31,42,46,.25)}",
    "button{font:inherit;color:inherit}",
    ":focus-visible{outline:2px solid var(--focus);outline-offset:1px}",
    ".ph{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--surface);z-index:3}",
    ".ph .logo{width:18px;height:18px;border-radius:5px;background:var(--accent);flex:none}",
    ".ph .t{font-weight:600;flex:1}",
    ".ph .x{all:unset;cursor:pointer;color:var(--text3);font-size:14px;padding:0 4px;line-height:20px}",
    ".ph .x:hover{color:var(--text)}",
    ".scope{padding:7px 12px;background:var(--subtle);font-size:12px;color:var(--text2);border-bottom:1px solid var(--border)}",
    ".pb{padding:12px}",
    ".lbl{font-size:12px;font-weight:600;color:var(--text2);margin:0 0 6px}",
    ".lbl .en{font-weight:400;color:var(--text3)}",
    ".box{border:1px solid var(--border);border-radius:10px;padding:10px;background:var(--field)}",
    ".line{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
    ".step{display:inline-flex;align-items:stretch;border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--field)}",
    ".step button{all:unset;width:30px;text-align:center;font-size:16px;color:var(--accent);background:var(--subtle);cursor:pointer;line-height:30px}",
    ".step button[disabled]{opacity:.4;cursor:default}",
    ".step input{all:unset;width:46px;text-align:center;font-weight:600;font-size:15px;line-height:30px;border-left:1px solid var(--border);border-right:1px solid var(--border);font-variant-numeric:tabular-nums;color:var(--text);background:var(--field)}",
    ".step input:focus{outline:2px solid var(--focus);outline-offset:-2px}",
    ".step input.warnv{color:var(--warning)}",
    ".start{all:unset;width:40px;text-align:center;font-weight:600;border:1px solid var(--border);border-radius:6px;line-height:24px;background:var(--field)}",
    ".jump{display:flex;gap:6px;margin:8px 0 0}",
    ".chip{all:unset;display:inline-block;border:1px solid var(--border);border-radius:999px;padding:4px 10px;font-size:12px;color:var(--text2);background:var(--field);white-space:nowrap;cursor:pointer}",
    ".chip:hover{border-color:var(--accent)}",
    ".chip.on{background:var(--accentSoft);border-color:var(--accent);color:var(--accent);font-weight:600}",
    ".chip.sm{padding:3px 9px}",
    ".chip[disabled]{opacity:.4;cursor:default}.chip[disabled]:hover{border-color:var(--border)}",
    ".hint{font-size:12px;color:var(--text3);margin-top:6px}",
    ".real{font-size:12px;color:var(--text);margin-top:8px}",
    ".real b{font-variant-numeric:tabular-nums}",
    ".choices{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}",
    ".cta{all:unset;box-sizing:border-box;display:block;width:100%;margin-top:12px;background:var(--button);color:var(--onAccent);text-align:center;border-radius:9px;padding:9px 12px;font-weight:600;cursor:pointer}",
    ".cta:hover{background:var(--buttonHover)}",
    ".cta[disabled]{opacity:.45;cursor:default}.cta[disabled]:hover{background:var(--button)}",
    ".link{all:unset;color:var(--link);font-size:12px;cursor:pointer}",
    ".link:hover{text-decoration:underline}",
    ".note{border-radius:9px;padding:9px 10px 9px 12px;margin-top:8px;font-size:12px;border-left:3px solid}",
    ".note:first-child{margin-top:0}",
    ".note .h{font-weight:600;margin-bottom:2px}",
    ".note.warn{background:var(--warningSoft);border-color:var(--warning);color:var(--warning)}",
    ".note.info{background:var(--accentSoft);border-color:var(--accent);color:var(--accent)}",
    ".note.ok{background:var(--successSoft);border-color:var(--success);color:var(--success)}",
    ".note .b{color:var(--text)}",
    ".note .acts{margin-top:6px;display:flex;gap:8px;flex-wrap:wrap}",
    ".btn2{all:unset;display:inline-block;border:1px solid currentColor;border-radius:7px;padding:3px 9px;font-size:12px;font-weight:600;background:var(--field);cursor:pointer}",
    ".note.info .btn2{color:var(--accent)}",
    ".notes{margin-bottom:12px}.notes:empty{display:none}",
    ".progress{display:flex;align-items:center;gap:8px}",
    ".progress .bar{flex:1}",
    ".rule{border:1px solid var(--border);border-radius:10px;background:var(--field);padding:9px 10px;margin-bottom:8px;position:relative}",
    ".rule.swapped{animation:rule-swap 1.2s ease-out}",
    "@keyframes rule-swap{0%{background:var(--accentSoft);box-shadow:0 0 0 3px var(--accentSoft)}100%{background:var(--field);box-shadow:0 0 0 3px transparent}}",
    ".rule .top{display:flex;align-items:center;gap:8px}",
    ".badge{width:20px;height:20px;border-radius:50%;background:var(--accentSoft);color:var(--accent);font-weight:700;font-size:12px;display:inline-flex;align-items:center;justify-content:center;flex:none}",
    ".sel{all:unset;box-sizing:border-box;flex:1;min-width:0;border:1px solid var(--border);border-radius:7px;padding:4px 8px;display:flex;justify-content:space-between;gap:6px;cursor:pointer;background:var(--field)}",
    ".sel .n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".sel .caret{color:var(--text3)}",
    ".dir{all:unset;font-size:12px;color:var(--text2);border:1px solid var(--border);border-radius:7px;padding:4px 7px;white-space:nowrap;cursor:pointer;min-width:58px;text-align:center}",
    ".dir:hover,.sel:hover{border-color:var(--accent)}",
    ".mv{display:inline-flex;gap:0}",
    ".mv button{all:unset;color:var(--text3);font-size:12px;cursor:pointer;padding:0 2px}",
    ".mv button[disabled]{opacity:.35;cursor:default}",
    ".seg{display:flex;border:1px solid var(--border);border-radius:8px;overflow:hidden}",
    ".seg button{all:unset;flex:1;text-align:center;padding:5px 6px;font-size:12px;color:var(--text2);background:var(--field);cursor:pointer}",
    ".seg button.on{background:var(--accent);color:var(--onAccent);font-weight:600}",
    ".seg button+button{border-left:1px solid var(--border)}",
    ".menu{border:1px solid var(--border);border-radius:10px;background:var(--field);box-shadow:0 4px 14px rgba(31,42,46,.12);overflow:hidden;margin:4px 0 8px}",
    ".mh{padding:7px 10px 4px;font-size:11px;font-weight:700;color:var(--text3);letter-spacing:.3px}",
    ".mi{all:unset;box-sizing:border-box;display:flex;justify-content:space-between;gap:8px;padding:6px 10px;font-size:13px;width:100%;cursor:pointer}",
    ".mi:hover,.mi:focus-visible{background:var(--subtle);outline:none}",
    ".mi .s{color:var(--text3);font-size:12px}",
    ".fi{display:inline-block;width:1.05em;height:1.05em;vertical-align:-.17em;object-fit:contain;margin:0 .15em;color:var(--text)}",
    ".sel .s{color:var(--text3);font-size:12px}",
    ".mi .n{min-width:0}",
    ".mi.cur{background:var(--accentSoft)}",
    ".mi.off{color:var(--text3);cursor:default}.mi.off:hover{background:none}",
    ".mi .r{white-space:nowrap}",
    ".cov{font-size:11px;color:var(--warning);background:var(--warningSoft);border-radius:4px;padding:0 5px;white-space:nowrap}",
    ".msep{border-top:1px solid var(--border);margin:4px 0}",
    ".add{margin:0 0 12px}",
    ".datebox input{border:1px solid var(--border);border-radius:6px;padding:3px 6px;font:inherit;color:var(--text);background:var(--field)}",
    ".top5{margin-top:8px;border:1px solid var(--border);border-radius:10px;background:var(--field);padding:2px 10px 8px}",
    ".div{display:flex;align-items:center;gap:8px;margin:8px 0 4px;font-size:12px;color:var(--text3)}",
    ".div::after{content:'';flex:1;border-top:1px solid var(--border)}",
    ".div b{color:var(--text2);font-weight:600}",
    ".tc{display:flex;gap:8px;padding:4px 6px;margin:0 -6px;align-items:center;border-radius:7px;color:var(--text);text-decoration:none}",
    "a.tc{cursor:pointer}a.tc:hover{background:var(--subtle)}a.tc:hover .n{color:var(--link);text-decoration:underline}",
    ".tn{width:40px;height:40px;border-radius:6px;object-fit:cover;flex:none;background:var(--subtle)}",
    ".tt{min-width:0;flex:1}",
    ".top5 .full{display:inline-block;margin-top:8px;font-weight:600}",
    ".top5.stale .tc,.top5.stale .div{opacity:.45}",
    ".stalehint{font-size:12px;color:var(--text2);margin:8px 0 2px}",
    ".fold{display:flex;align-items:center;gap:8px;border:1px solid var(--border);border-radius:9px;padding:7px 10px;font-size:12px;color:var(--text2);background:var(--subtle)}",
    ".fold .s{flex:1;min-width:0}",
    ".rk{font-size:11px;font-weight:700;color:var(--accent);background:var(--accentSoft);border-radius:5px;padding:1px 5px;line-height:16px;flex:none}",
    ".tc .n{font-weight:600;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".tc .m{font-size:12px;color:var(--text2);font-variant-numeric:tabular-nums}",
    ".tc .m .d{color:var(--accent);font-weight:700}",
    ".tc .m .na{color:var(--text3)}",
    ".foot{display:flex;gap:12px;flex-wrap:wrap;padding:8px 12px 10px;border-top:1px solid var(--border);font-size:12px}",
    ".foot .link{color:var(--text3)}",
    ".pickbar{display:flex;align-items:center;gap:8px;background:var(--button);color:var(--onAccent);border-radius:9px;padding:10px 12px;margin-bottom:10px;font-size:13px;font-weight:600;position:relative;z-index:6;box-shadow:0 4px 16px rgba(0,0,0,.25)}",
    ".pickbar .btn2{color:var(--accent);border-color:var(--field)}",
    ".dim{display:none;position:absolute;left:0;top:0;right:0;min-height:100%;background:rgba(20,24,26,.55);z-index:5}",
    ".panel.picking .dim{display:block}",
    ".panel.picking .ph{position:static}",
    ".del{all:unset;width:20px;height:20px;line-height:18px;text-align:center;border-radius:50%;color:var(--text3);font-size:15px;cursor:pointer;position:relative;flex:none}",
    ".del:hover{color:var(--danger);background:var(--dangerSoft)}",
    ".del[data-tip]:hover::after{content:attr(data-tip);position:absolute;right:0;top:24px;white-space:nowrap;background:var(--text);color:var(--surface);font-size:11px;font-weight:400;line-height:1.4;padding:3px 7px;border-radius:5px;z-index:4;pointer-events:none}",
    ".sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}"
  ].join("\n");

  function buildPanel() {
    host = document.createElement("div");
    host.id = "card-sorter-host";
    // closed:网页和深色插件改不到面板里的颜色
    shadow = host.attachShadow({ mode: "closed" });
    document.documentElement.appendChild(host);

    var style = document.createElement("style");
    style.textContent = STYLE;
    shadow.appendChild(style);

    var panel = document.createElement("div");
    panel.className = "panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", t("name"));
    panel.innerHTML =
      '<div class="ph"><span class="logo"></span><span class="t">' + esc(t("name")) + '</span>' +
      '  <button class="x" data-act="minimize" title="' + esc(t("minimize")) + '" aria-label="' + esc(t("minimize")) + '">—</button></div>' +
      '<div class="scope" data-el="scope">' + esc(t("preparing")) + '</div>' +
      '<div class="pb">' +
      '  <div class="notes" data-el="notes" aria-live="polite"></div>' +
      '  <div class="pickbar" data-el="pickbar" style="display:none"><span style="flex:1" data-el="pickText">' + esc(t("pickNumber")) + '</span>' +
      '    <button class="btn2" data-act="pickCancel">' + esc(t("pickCancel")) + '</button></div>' +
      '  <div class="fold" data-el="fold" style="display:none"><span class="s" data-el="foldText"></span>' +
      '    <button class="link" data-act="unfold">' + esc(t("edit")) + '</button></div>' +
      '  <div data-el="setup">' +
      '    <div class="lbl">' + esc(t("sortRules")) + '</div>' +
      '    <div data-el="rules"></div>' +
      '    <div class="add"><button class="link" data-act="addRule" data-el="addRule">' + esc(t("addRule")) + '</button></div>' +
      '    <div class="lbl">' + esc(t("pagesToRead")) + '</div>' +
      '    <div class="box" data-el="rangeBox"></div>' +
      '  </div>' +
      '  <button class="cta" data-act="sort" data-el="sortButton">' + esc(t("sortGeneric")) + '</button>' +
      '</div>' +
      '<div class="foot">' +
      '  <button class="link" data-act="redetect">' + esc(t("rescan")) + '</button>' +
      '  <button class="link" data-act="dateMode" data-el="dateLink">' + esc(t("readByDate")) + '</button>' +
      '  <button class="link" data-act="forget">' + esc(t("resetSite")) + '</button>' +
      '</div>';
    shadow.appendChild(panel);

    var bubble = document.createElement("button");
    bubble.className = "bubble";
    bubble.textContent = "▲ " + t("name");
    bubble.style.display = "none";
    bubble.addEventListener("click", function () {
      panel.style.display = "";
      bubble.style.display = "none";
    });
    shadow.appendChild(bubble);

    // 选属性时盖住整个面板的半透明暗层,只有提示块在它上面
    var dim = document.createElement("div");
    dim.className = "dim";
    panel.appendChild(dim);
    ui.dim = dim;

    panel.querySelectorAll("[data-el]").forEach(function (el) { ui[el.getAttribute("data-el")] = el; });
    ui.panel = panel;
    ui.bubble = bubble;

    panel.addEventListener("click", function (event) {
      var target = event.target.closest("[data-act]");
      if (!target || target.disabled) return;
      handleAction(target.getAttribute("data-act"), target, event);
    });
    // 下拉菜单打开时,点菜单以外的任何地方(面板里或网页上)都收回
    function closeMenuOnOutsideClick(event) {
      if (state.menuIndex < 0) return;
      var path = event.composedPath ? event.composedPath() : [];
      var inside = path.some(function (node) { return node.classList && (node.classList.contains("menu") || node.classList.contains("sel")); });
      if (inside) return;
      state.menuIndex = -1;
      renderRules();
    }
    shadow.addEventListener("click", closeMenuOnOutsideClick, true);
    document.addEventListener("click", function (event) { if (event.target !== host) closeMenuOnOutsideClick(event); }, true);
    panel.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && state.menuIndex >= 0) { state.menuIndex = -1; renderRules(); }
    });

    chrome.runtime.onMessage.addListener(function (message) {
      if (!message) return;
      if (message.type === "card-sorter-crawl-page" && state.tabBatch) state.tabBatch.onPage(message);
      else if (message.type === "card-sorter-crawl-done" && state.tabBatch) state.tabBatch.onDone(message);
    });
  }

  function handleAction(act, target) {
    if (act === "minimize") { ui.panel.style.display = "none"; ui.bubble.style.display = ""; }
    else if (act === "redetect") { state.notes = []; detectCurrentPage(); }
    else if (act === "pickCancel") stopPicking();
    else if (act === "forget") forgetSite();
    else if (act === "addRule") addRule();
    else if (act === "unfold") { state.setupFolded = false; renderSetup(); }
    else if (act === "openFull") reopenResults();
    else if (act === "sort") {
      if (state.collecting) { cancelCollect(); return; }
      // 任何一步出错都必须发声,绝不静默
      runSort().catch(function (error) {
        var message = (error && error.message) || String(error);
        if (state.collecting) endCollect("");
        addNote({ id: "error", tone: "warn", title: t("sortFailTitle"), body: t("tryAgain"), actions: [{ id: "dismiss", label: t("gotIt") }] });
      });
    }
    else if (act === "dateMode") {
      state.dateMode = !state.dateMode;
      invalidateResultCache();
      renderRange();
      renderCta();
    }
    else if (act === "note") {
      var noteId = target.getAttribute("data-note");
      var actionId = target.getAttribute("data-action");
      var note = state.notes.find(function (n) { return n.id === noteId; });
      if (!note) return;
      if (actionId === "dismiss") { removeNote(noteId); return; }
      if (actionId === "retry") {
        var action = (note.actions || []).find(function (a) { return a.id === "retry"; });
        retryPages(action && action.pages).catch(function (error) {
          addNote({ id: "error", tone: "warn", title: t("retryFailTitle"), body: t("tryAgain"), actions: [{ id: "dismiss", label: t("gotIt") }] });
        });
      }
    }
    else if (act === "range") rangeAction(target.getAttribute("data-op"), target);
  }

  /* ---------------- 渲染 ---------------- */

  function renderAll() {
    if (!ui.panel) return;
    renderScope();
    renderNotes();
    renderRules();
    renderRange();
    renderSetup();
    renderCta();
    renderPickBar();
  }

  // 排好后设置区收成一行:"先按下载量，再按点赞数 · 第 1–5 页 · 修改"
  function renderSetup() {
    if (!ui.setup || !ui.fold) return;
    var folded = Boolean(state.setupFolded && state.lastResultId && state.summary);
    ui.setup.style.display = folded ? "none" : "";
    ui.fold.style.display = folded ? "" : "none";
    if (folded) {
      var pagesText = core.resultView.describePageList(state.summary.pages);
      ui.foldText.textContent = "";
      core.resultView.appendSentence(document, ui.foldText, [summarySentence(), pagesText + (state.summary.whole ? t("wholeList") : "")].filter(Boolean).join(" · "), fieldCatalog(), { glyphOk: true });
    }
  }

  function setScope(text) {
    if (ui.scope) ui.scope.textContent = text;
  }

  function renderScope() {
    if (!state.cardCount) return;
    setScope(core.pageRange.describeScope({ current: state.currentPage, cardCount: state.cardCount, total: state.totalPages }));
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function renderNotes() {
    if (!ui.notes) return;
    ui.notes.innerHTML = "";
    var order = { warn: 0, info: 1, ok: 2 };
    var notes = state.notes.slice().sort(function (a, b) { return (order[a.tone] || 0) - (order[b.tone] || 0); });
    notes.forEach(function (note) {
      var box = el("div", "note " + (note.tone || "info"));
      box.setAttribute("role", note.tone === "warn" ? "alert" : "status");
      box.appendChild(el("div", "h", note.title));
      if (note.body) box.appendChild(el("div", "b", note.body));
      if (note.actions && note.actions.length) {
        var acts = el("div", "acts");
        note.actions.forEach(function (action) {
          var button = el("button", "btn2", action.label);
          button.setAttribute("data-act", "note");
          button.setAttribute("data-note", note.id);
          button.setAttribute("data-action", action.id);
          if (state.collecting && action.id === "retry") button.disabled = true;
          acts.appendChild(button);
        });
        box.appendChild(acts);
      }
      ui.notes.appendChild(box);
      if (note.id === "done" && state.summary) ui.notes.appendChild(renderTopList(state.summary));
    });
    if (state.collecting) {
      var progress = el("div", "note info");
      progress.setAttribute("role", "status");
      progress.appendChild(el("div", "h", t("readingTitle")));
      progress.appendChild(el("div", "b", state.collectProgress || ""));
      if (state.lastRequested && state.lastRequested.to - state.lastRequested.from >= 9) {
        progress.appendChild(el("div", "b", t("keepTabOpen")));
      }
      ui.notes.insertBefore(progress, ui.notes.firstChild);
    }
  }

  // 面板里的"前 5 张":和结果页同样的分隔线与粗体;每一张都能点,在新标签页打开那张卡片。
  // 第 5 张下面是「打开完整结果（N 张）↗」。设置改了以后整块变灰,提示重新排序。
  function renderTopList(summary) {
    var fresh = Boolean(state.lastResultId);
    var wrap = el("div", "top5" + (fresh ? "" : " stale"));
    var view = summary.view;
    var catalog = summary.catalog;
    var ruleFields = view.rules.map(function (rule) {
      return catalog.find(function (f) { return f.id === rule.field; }) || { id: rule.field, label: "", type: "number" };
    });
    if (!fresh && !state.collecting) wrap.appendChild(el("div", "stalehint", t("stale")));
    view.sections.forEach(function (section) {
      if (!section.entries.length) return;
      if (section.kind !== "plain") {
        var divider = el("div", "div");
        divider.appendChild(el("b", "", section.label));
        divider.appendChild(document.createTextNode(" · " + t("cardsCount", section.count)));
        if (view.groupHint && section.kind === "band") divider.title = view.groupHint;
        wrap.appendChild(divider);
      }
      section.entries.forEach(function (entry) {
        var item = entry.item;
        var row = el(item.videoUrl ? "a" : "div", "tc");
        if (item.videoUrl) {
          row.href = item.videoUrl;
          row.target = "_blank";
          row.rel = "noopener";
          row.title = item.title || "";
        }
        row.appendChild(el("span", "rk", String(entry.index + 1)));
        if (item.thumbnailUrl) {
          var img = document.createElement("img");
          img.className = "tn";
          img.alt = "";
          img.decoding = "async";
          img.addEventListener("error", function () { img.remove(); });
          img.addEventListener("load", function () {
            if (img.naturalWidth < 48 || img.naturalHeight < 48) img.remove();
          });
          img.src = item.thumbnailUrl;
          row.appendChild(img);
        }
        var text = el("div", "tt");
        text.appendChild(el("div", "n", item.title || t("untitled")));
        var metrics = el("div", "m");
        ruleFields.forEach(function (field, i) {
          if (i) metrics.appendChild(document.createTextNode(" · "));
          core.resultView.appendFieldLabel(document, metrics, field, { glyphOk: true });
          metrics.appendChild(document.createTextNode(" "));
          var value = core.resultView.formatCardValue(item, field);
          metrics.appendChild(el("span", value === "—" ? "na" : entry.bold === field.id ? "d" : "", value));
        });
        text.appendChild(metrics);
        row.appendChild(text);
        wrap.appendChild(row);
      });
    });
    if (fresh) {
      var open = el("button", "link full", t("openAll", summary.count));
      open.setAttribute("data-act", "openFull");
      wrap.appendChild(open);
    }
    return wrap;
  }

  function directionText(rule, type) {
    if (type === "date") return t(rule.direction === "asc" ? "oldNew" : "newOld");
    return t(rule.direction === "asc" ? "lowHigh" : "highLow");
  }

  function renderRules() {
    if (!ui.rules) return;
    var catalog = fieldCatalog();
    ui.rules.innerHTML = "";
    if (!catalog.length) {
      var empty = el("div", "rule");
      empty.appendChild(el("div", "hint", t("noFieldsHint")));
      var pickButton = el("button", "link", t("manualSelect"));
      pickButton.addEventListener("click", function () { startPicking(-1); });
      empty.appendChild(pickButton);
      ui.rules.appendChild(empty);
      return;
    }
    if (!state.sortRules.length) resetDefaultSortRule();
    refreshBands();
    if (ui.addRule) {
      ui.addRule.textContent = core.sort.firstUnusedField(catalog, state.sortRules)
        ? t("addRule")
        : t("addRuleManual");
    }

    var flashIndex = state.flashRuleIndex;
    state.flashRuleIndex = -1;
    state.sortRules.forEach(function (rule, index) {
      if (!catalog.some(function (f) { return f.id === rule.field; })) {
        rule.field = core.sort.firstUnusedField(catalog, state.sortRules) || catalog[0].id;
      }
      var field = catalog.find(function (f) { return f.id === rule.field; });
      // 不让用户选"相近时怎么排":后面还有依据就自动分段,只剩最后一个时自动按准确数字排
      rule.mode = field.type === "number" || field.type === "duration" || field.type === "date" ? "bucket" : "exact";
      var box = el("div", "rule" + (index === flashIndex ? " swapped" : ""));
      var top = el("div", "top");
      top.appendChild(el("span", "badge", String(index + 1)));

      var sel = el("button", "sel");
      sel.setAttribute("aria-haspopup", "listbox");
      sel.setAttribute("aria-expanded", state.menuIndex === index ? "true" : "false");
      var selName = el("span", "n");
      core.resultView.appendFieldLabel(document, selName, field, { glyphOk: true });
      var selEg = exampleText(field);
      if (selEg) selName.appendChild(el("span", "s", " " + selEg));
      sel.appendChild(selName);
      sel.appendChild(el("span", "caret", state.menuIndex === index ? "▴" : "▾"));
      sel.addEventListener("click", function () {
        state.menuIndex = state.menuIndex === index ? -1 : index;
        renderRules();
        var first = ui.rules.querySelector(".menu .mi.cur");
        if (first) first.focus();
      });
      top.appendChild(sel);

      var dir = el("button", "dir", directionText(rule, field.type));
      dir.title = t("reverse");
      dir.addEventListener("click", function () {
        rule.direction = rule.direction === "asc" ? "desc" : "asc";
        invalidateResultCache();
        renderRules();
      });
      top.appendChild(dir);

      var mv = el("span", "mv");
      mv.title = t("moveUpDown");
      var up = el("button", "", "↑");
      up.setAttribute("aria-label", t("moveUp"));
      up.title = t("moveUp");
      up.disabled = index === 0;
      up.addEventListener("click", function () { moveRule(index, -1); });
      var down = el("button", "", "↓");
      down.setAttribute("aria-label", t("moveDown"));
      down.title = t("moveDown");
      down.disabled = index === state.sortRules.length - 1;
      down.addEventListener("click", function () { moveRule(index, 1); });
      mv.append(up, down);
      top.appendChild(mv);
      // 第 2 个起可以移除;第 1 个不能
      if (index > 0) {
        var del = el("button", "del", "−");
        del.setAttribute("aria-label", t("removeRule"));
        del.setAttribute("data-tip", t("removeRule"));
        del.addEventListener("click", function () { removeRule(index); });
        top.appendChild(del);
      }
      box.appendChild(top);

      ui.rules.appendChild(box);
      if (state.menuIndex === index) ui.rules.appendChild(renderMenu(rule, index, catalog));
    });
  }

  function coverageText(field) {
    if (!field.total) return "";
    if (field.count >= field.total) return "";
    return t("coverage", { count: field.count, total: field.total });
  }

  function exampleText(field) {
    if (!field.example) return "";
    var value = core.resultView.formatCardValue(field.example, field);
    return value && value !== "—" ? t("eg", value) : "";
  }

  // 不能用来排序的原因 + 例子(F7)
  var EXCLUDED_WHY = {
    hidden: "whyHidden",
    code: "whyCode",
    position: "whyPosition",
    fragment: "whyFragment"
  };

  function excludedReason(candidate) {
    var sample = String((candidate.examples || [])[0] || "").replace(/\s+/g, " ").trim();
    if (sample.length > 24) sample = sample.slice(0, 23) + "…";
    var tail = sample ? t("egTail", sample) : "";
    var why = EXCLUDED_WHY[candidate.excludedWhy];
    // "position" 有两种:1、2、3… 这样的序号,或每张卡片都一样的数
    if (why === "whyPosition" && sameOnEveryCard(candidate)) why = "whySame";
    if (why) return t(why) + tail;
    if (/^\D*\d+\.\d+\.\d+/.test(sample)) return t("whyNotComparable") + tail;
    return t("textItem") + tail;
  }

  function sameOnEveryCard(candidate) {
    var values = Object.keys(candidate._values || {}).map(function (key) { return candidate._values[key]; });
    if (values.length < 2) {
      var examples = (candidate.examples || []).map(function (x) { return String(x || "").trim(); });
      return examples.length > 1 && examples.every(function (x) { return x === examples[0]; });
    }
    return values.every(function (v) { return v === values[0]; });
  }

  // 不能排序的那几行叫什么:网站给的名字太短(如 "v")就不用;能认出来的叫"标题"/"版本号",其余叫"一段文字"
  function excludedName(candidate) {
    var label = String(candidate.label || candidate.siteLabel || "").trim();
    var letters = label.replace(/[^A-Za-z\u4e00-\u9fa5]/g, "");
    if (/[\u4e00-\u9fa5]/.test(letters) || letters.length >= 2) return core.resultView.fieldName({ label: label });
    var examples = (candidate.examples || []).map(function (x) { return String(x || "").trim(); }).filter(Boolean);
    if (examples.length) {
      var titles = {};
      pool().forEach(function (item) { if (item.title) titles[String(item.title).trim()] = true; });
      if (examples.every(function (x) { return titles[x]; })) return t("titleItem");
      if (examples.every(function (x) { return /^v?\d+(?:\.\d+){1,3}[a-z]?$/i.test(x); })) return t("versionItem");
    }
    return t("textItem");
  }

  function renderMenu(rule, index, catalog) {
    var menu = el("div", "menu");
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", t("menuAria"));
    menu.appendChild(el("div", "mh", t("menuSortable")));
    catalog.forEach(function (field) {
      var item = el("button", "mi" + (field.id === rule.field ? " cur" : ""));
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", field.id === rule.field ? "true" : "false");
      var name = el("span", "n");
      core.resultView.appendFieldLabel(document, name, field, { glyphOk: true });
      name.appendChild(document.createTextNode(" "));
      var eg = exampleText(field);
      if (eg) name.appendChild(el("span", "s", eg));
      item.appendChild(name);
      var cov = coverageText(field);
      var low = field.total && field.count / field.total < 0.75;
      item.appendChild(el("span", low ? "cov r" : "s r", cov));
      item.addEventListener("click", function () { chooseField(index, field.id, catalog); });
      menu.appendChild(item);
    });
    var pick = el("button", "mi");
    pick.appendChild(el("span", "n link", t("manualSelect")));
    pick.addEventListener("click", function () { startPicking(index); });
    menu.appendChild(pick);
    var excluded = excludedCandidates();
    if (excluded.length) {
      menu.appendChild(el("div", "msep"));
      menu.appendChild(el("div", "mh", t("menuNotSortable")));
      excluded.forEach(function (candidate) {
        var off = el("div", "mi off");
        off.setAttribute("role", "option");
        off.setAttribute("aria-disabled", "true");
        off.appendChild(el("span", "n", excludedName(candidate)));
        off.appendChild(el("span", "s", excludedReason(candidate)));
        menu.appendChild(off);
      });
    }
    return menu;
  }

  function chooseField(index, fieldId, catalog) {
    // 选了另一条规则正在用的数字 → 两条规则互换位置,并短暂高亮被换走的那一行
    var assigned = core.sort.assignRuleField(state.sortRules, index, fieldId);
    state.sortRules = assigned.rules;
    if (assigned.swappedWith === -1) {
      var changed = state.sortRules[index];
      var type = ((catalog || fieldCatalog()).find(function (f) { return f.id === changed.field; }) || {}).type;
      changed.mode = type === "number" || type === "duration" || type === "date" ? "bucket" : "exact";
    }
    state.flashRuleIndex = assigned.swappedWith;
    state.menuIndex = -1;
    invalidateResultCache();
    renderRules();
  }

  function moveRule(index, delta) {
    var target = index + delta;
    if (target < 0 || target >= state.sortRules.length) return;
    var rules = state.sortRules.slice();
    var moved = rules[index];
    rules[index] = rules[target];
    rules[target] = moved;
    state.sortRules = rules;
    state.flashRuleIndex = target;
    state.menuIndex = -1;
    invalidateResultCache();
    renderRules();
  }

  function removeRule(index) {
    if (index <= 0 || index >= state.sortRules.length) return;
    state.sortRules.splice(index, 1);
    state.menuIndex = -1;
    invalidateResultCache();
    renderRules();
  }

  function addRule() {
    // 新规则默认用一个还没用上的数字;全都用上了就提示,不加重复的
    var catalog = fieldCatalog();
    var unusedId = core.sort.firstUnusedField(catalog, state.sortRules);
    if (!unusedId) {
      // 找到的数字都用上了 → 直接手动点一个新数字,作为新的一行加进来,已有各行不动
      startPicking(NEW_RULE);
      return;
    }
    invalidateResultCache();
    state.sortRules.push(makeSortRule(catalog.find(function (f) { return f.id === unusedId; })));
    renderRules();
  }

  /* ---------------- 读取范围(F1–F4) ---------------- */

  function rangeAction(op, target) {
    var pr = core.pageRange;
    var s = state.pageRange;
    if (op === "minus") s = pr.stepEnd(s, -1);
    else if (op === "plus") s = pr.stepEnd(s, 1);
    else if (op === "jumpMinus") s = pr.stepEnd(s, -pr.JUMP);
    else if (op === "jumpPlus") s = pr.stepEnd(s, pr.JUMP);
    else if (op === "this") s = pr.chooseThisPage(s);
    else if (op === "all") s = pr.chooseAll(s);
    else if (op === "fix") s = pr.resolveBefore(s, target.getAttribute("data-fix"));
    else if (op === "editStart") { state.editingStart = !state.editingStart; renderRange(); return; }
    state.pageRange = s;
    invalidateResultCache();
    renderRange();
    renderCta();
  }

  function rangeButton(className, op, text, disabled, label) {
    var button = el("button", className, text);
    button.setAttribute("data-act", "range");
    button.setAttribute("data-op", op);
    if (label) button.setAttribute("aria-label", label);
    button.disabled = Boolean(disabled);
    if (disabled) button.setAttribute("aria-disabled", "true");
    return button;
  }

  function renderRange() {
    var box = ui.rangeBox;
    if (!box || !state.pageRange) return;
    box.innerHTML = "";
    if (ui.dateLink) ui.dateLink.textContent = t(state.dateMode ? "readByPage" : "readByDate");
    if (state.dateMode) {
      box.className = "box datebox";
      var dateLine = el("div", "line");
      dateLine.appendChild(document.createTextNode(t("dateLead")));
      var start = document.createElement("input");
      start.type = "date";
      start.value = state.startDateValue || "";
      var end = document.createElement("input");
      end.type = "date";
      end.value = state.endDateValue || "";
      [start, end].forEach(function (input) {
        input.addEventListener("change", function () {
          state.startDateValue = start.value;
          state.endDateValue = end.value;
          invalidateResultCache();
        });
      });
      dateLine.append(start, document.createTextNode(t("dateMid")), end);
      box.appendChild(dateLine);
      box.appendChild(el("div", "hint", t("dateHint")));
      ui.startDate = start;
      ui.endDate = end;
      return;
    }
    box.className = "box";
    var view = core.pageRange.describePageRange(state.pageRange);
    var line = el("div", "line");
    if (state.editingStart) {
      line.appendChild(document.createTextNode(t("rangeLead")));
      var startInput = document.createElement("input");
      startInput.className = "start";
      startInput.inputMode = "numeric";
      startInput.value = String(state.pageRange.start);
      startInput.setAttribute("aria-label", t("firstPage"));
      startInput.addEventListener("change", function () {
        state.pageRange = core.pageRange.setStart(state.pageRange, startInput.value);
        invalidateResultCache();
        renderRange();
        renderCta();
      });
      line.appendChild(startInput);
      line.appendChild(document.createTextNode(t("rangeMid")));
    } else {
      line.appendChild(document.createTextNode(t("rangeLead") + " " + view.startPage + " " + t("rangeMid")));
    }
    var stepper = el("span", "step");
    stepper.appendChild(rangeButton("", "minus", "−", view.minusDisabled, t("pageFewer")));
    var input = document.createElement("input");
    input.value = view.endText;
    input.inputMode = "numeric";
    input.setAttribute("aria-label", t("lastPage"));
    if (view.endWarning) input.className = "warnv";
    input.addEventListener("input", function () {
      var digits = input.value.replace(/\D/g, "");
      if (digits !== input.value) input.value = digits;
    });
    input.addEventListener("change", function () { applyTypedEnd(input.value); });
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter") { event.preventDefault(); applyTypedEnd(input.value); }
      else if (event.key === "PageUp") { event.preventDefault(); rangeAction("jumpPlus"); }
      else if (event.key === "PageDown") { event.preventDefault(); rangeAction("jumpMinus"); }
      else if (event.key === "ArrowUp") { event.preventDefault(); rangeAction("plus"); }
      else if (event.key === "ArrowDown") { event.preventDefault(); rangeAction("minus"); }
    });
    stepper.appendChild(input);
    stepper.appendChild(rangeButton("", "plus", "+", view.plusDisabled, t("pageMore")));
    line.appendChild(stepper);
    if (t("rangeTail")) line.appendChild(document.createTextNode(t("rangeTail")));
    box.appendChild(line);

    var jump = el("div", "jump");
    jump.appendChild(rangeButton("chip sm", "jumpMinus", t("jumpMinus"), view.jumpMinusDisabled));
    jump.appendChild(rangeButton("chip sm", "jumpPlus", t("jumpPlus"), view.jumpPlusDisabled));
    box.appendChild(jump);

    if (view.lineParts.length) {
      var real = el("div", "real");
      view.lineParts.forEach(function (part) {
        if (typeof part === "string") real.appendChild(document.createTextNode(part));
        else real.appendChild(el("b", "", part.b));
      });
      box.appendChild(real);
    }
    if (view.note) {
      var note = el("div", "note " + (view.note.tone === "info" ? "info" : "warn"));
      note.setAttribute("role", "status");
      note.appendChild(el("div", "h", view.note.title));
      note.appendChild(el("div", "b", view.note.body));
      if (view.note.actions) {
        var acts = el("div", "acts");
        view.note.actions.forEach(function (action) {
          var fix = rangeButton("btn2", "fix", action.label, false);
          fix.setAttribute("data-fix", action.id);
          acts.appendChild(fix);
        });
        note.appendChild(acts);
      }
      box.appendChild(note);
    }
    var choices = el("div", "choices");
    choices.appendChild(rangeButton("chip" + (view.thisOn ? " on" : ""), "this", t("thisPage"), false));
    choices.appendChild(rangeButton("chip" + (view.allOn ? " on" : ""), "all", view.allLabel, false));
    box.appendChild(choices);
    if (view.hint) box.appendChild(el("div", "hint", view.hint));
    if (state.currentPage > 1 || state.editingStart || state.pageRange.start !== state.currentPage) {
      var other = el("div", "hint");
      var link = rangeButton("link", "editStart", state.editingStart ? t("startHere") : t("setStart"), false);
      if (state.editingStart) {
        link.addEventListener("click", function () {
          state.pageRange = core.pageRange.setStart(state.pageRange, state.currentPage);
        });
      }
      other.appendChild(link);
      box.appendChild(other);
    }
  }

  function applyTypedEnd(text) {
    state.pageRange = core.pageRange.typeEnd(state.pageRange, text);
    invalidateResultCache();
    renderRange();
    renderCta();
  }

  function renderCta() {
    var button = ui.sortButton;
    if (!button || !state.pageRange) return;
    button.disabled = false;
    // 刚排好且没有改动:前 5 名下面有「打开完整结果」,主按钮先藏起来;改了设置后再出现
    button.style.display = state.lastResultId && state.summary && !state.collecting ? "none" : "";
    if (state.collecting) {
      button.textContent = t("stopAndSort");
      return;
    }
    if (state.dateMode) {
      button.textContent = t("sortDates");
      return;
    }
    var view = core.pageRange.describePageRange(state.pageRange);
    button.textContent = view.ctaLabel;
    button.disabled = !view.ctaEnabled || !state.cardCount;
  }

  function renderPickBar() {
    if (!ui.pickbar) return;
    ui.pickbar.style.display = state.picking ? "" : "none";
    if (ui.pickText) {
      ui.pickText.textContent = state.picking === NEW_RULE
        ? t("pickNewRule", state.sortRules.length + 1)
        : t("pickNumber");
    }
    ui.panel.classList.toggle("picking", Boolean(state.picking));
    if (state.picking) ui.dim.style.height = ui.panel.scrollHeight + "px";
  }

  function setCollectProgress(text) {
    state.collectProgress = text || "";
    renderNotes();
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  globalThis.__cardSorterPanel = { toggle: toggle };
})();
