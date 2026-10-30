// Advanced Card Sort · https://github.com/JB-designer/Sorter-plugin · MIT License
/*
 * 背景服务:
 * 1. 点击工具栏图标 → 向当前页注入悬浮面板并开关
 * 2. 打开/刷新结果标签页(结果数据经 storage.local 传递,保留最近 10 份)
 * 3. 后台标签页翻页抓取(对抗需要真实浏览器环境的站点)
 */

// 界面语言:跟随 Chrome(测试包可固定为 "en" / "zh");文案和 src/core/i18n.js 同一套
const FORCED_LANG = null;
const IS_ZH = (FORCED_LANG || (/^zh/i.test(chrome.i18n?.getUILanguage?.() || "zh") ? "zh" : "en")) === "zh";

const CONTENT_FILES = [
  "src/shared/alignment-engine.js",
  "src/content/extractor.js",
  "src/content/picker.js",
  "src/content/panel.js"
];

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id || !/^https?:\/\//i.test(tab.url || "")) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => globalThis.__cardSorterPanel?.toggle()
    });
  } catch (error) {
    console.error("panel injection failed", error);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "card-sorter-save-results") {
    // 只保存,不自动打开结果页(面板先显示前 5 名,用户点「打开完整结果」才打开)。
    // 出错必须把原因传回面板显示,绝不静默;成功时把 rid 传回,供「打开完整结果」重开
    saveResults(message.payload)
      .then((rid) => sendResponse({ ok: true, rid }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === "card-sorter-update-results") {
    // 重试成功后更新已经打开的结果页(结果页监听自己那份数据的变化,自动刷新)
    updateResults(message.rid, message.payload)
      .then((rid) => sendResponse({ ok: true, rid }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === "card-sorter-reopen-results") {
    reopenResults(message.rid)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === "card-sorter-crawl-tabs") {
    startTabCrawl(message, sender.tab?.id);
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "card-sorter-crawl-cancel") {
    cancelFlags.set(sender.tab?.id, true);
    closeWorkerTab(sender.tab?.id);
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "card-sorter-crawl-finish") {
    closeWorkerTab(sender.tab?.id);
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// 每次排序保存一份独立的结果(不复用不覆盖);数据按 rid 隔离存储,只保留最近 10 份。
// 存在 chrome.storage.local(manifest 里有 unlimitedStorage,没有 10 MB 上限,100 页的结果也放得下;
// 浏览器重启后「打开结果」仍然可用)。先删旧结果再写新结果;万一写入仍报空间不够,
// 删掉全部旧结果再试一次,还不够就如实告诉用户结果太大。
const RESULT_PREFIX = "cardSorterResults:";
const RESULT_STORE = chrome.storage.local;
const KEEP_RESULTS = 10;

async function saveResults(payload) {
  const resultId = "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const key = RESULT_PREFIX + resultId;
  await pruneOldResults(KEEP_RESULTS - 1);
  try {
    await RESULT_STORE.set({ [key]: payload });
  } catch (error) {
    if (!isQuotaError(error)) throw error;
    await pruneOldResults(0);
    try {
      await RESULT_STORE.set({ [key]: payload });
    } catch (retryError) {
      if (!isQuotaError(retryError)) throw retryError;
      throw new Error(tooLargeMessage(payload));
    }
  }
  return resultId;
}

async function updateResults(rid, payload) {
  if (!rid) return saveResults(payload);
  const key = RESULT_PREFIX + rid;
  const stored = await RESULT_STORE.get(key);
  if (!stored?.[key]) return saveResults(payload);
  await RESULT_STORE.set({ [key]: payload });
  return rid;
}

function isQuotaError(error) {
  return /quota/i.test(error?.message || String(error));
}

function tooLargeMessage(payload) {
  let megabytes = "";
  try {
    megabytes = (JSON.stringify(payload).length / 1048576).toFixed(1);
  } catch {
    // 估不出大小就不写数字
  }
  const count = Array.isArray(payload?.items) ? payload.items.length : 0;
  const size = megabytes ? (IS_ZH ? "约 " + megabytes + " MB" : "~" + megabytes + " MB") : "";
  const cards = count ? (IS_ZH ? count.toLocaleString("en-US") + " 张卡片" : count.toLocaleString("en-US") + " cards") : "";
  const detail = [size, cards].filter(Boolean).join(IS_ZH ? "，" : ", ");
  return IS_ZH
    ? "结果过大，无法保存" + (detail ? "（" + detail + "）" : "") + "。请减少页数。"
    : "Results too large to save" + (detail ? " (" + detail + ")" : "") + ". Sort fewer pages.";
}

// 「打开完整结果」:按 rid 打开已缓存的结果页;缓存被清理时如实报错
async function reopenResults(rid) {
  if (!rid) throw new Error(IS_ZH ? "该结果已过期，请重新排序。" : "Results expired. Sort again.");
  const key = RESULT_PREFIX + rid;
  const stored = await RESULT_STORE.get(key);
  if (!stored?.[key]) throw new Error(IS_ZH ? "该结果已过期（仅保留最近 10 次）。请重新排序。" : "Results expired (last 10 kept). Sort again.");
  await chrome.tabs.create({ url: chrome.runtime.getURL("results.html") + "?rid=" + rid });
}

// 只留最近 keep 份结果(按 rid 里的时间先后),其余删除
async function pruneOldResults(keep) {
  try {
    const all = await RESULT_STORE.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith(RESULT_PREFIX)).sort();
    if (keys.length <= keep) return;
    await RESULT_STORE.remove(keys.slice(0, keys.length - keep));
  } catch {
    // 清理失败不影响主流程(真不够空间时,写入那一步会如实报错)
  }
}

/* ---------------- 后台标签页翻页抓取 ---------------- */

const cancelFlags = new Map(); // requesterTabId → bool

// 一次排序里逐页读取会多次调用 startTabCrawl:共用同一个后台标签页,不再每页开一个、关一个。
// 面板读完会发 card-sorter-crawl-finish 让它马上关;万一没收到(页面被关、出错提前结束),
// 闲置 WORKER_IDLE_MS 后自动关。
const workerTabs = new Map(); // requesterTabId → { tabId, idleTimer }
const WORKER_IDLE_MS = 15000;

async function getWorkerTab(requesterTabId) {
  const existing = workerTabs.get(requesterTabId);
  if (existing) {
    clearTimeout(existing.idleTimer);
    existing.idleTimer = null;
    try {
      await chrome.tabs.get(existing.tabId);
      return existing.tabId;
    } catch {
      workerTabs.delete(requesterTabId); // 用户手动关掉了,重新开一个
    }
  }
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  workerTabs.set(requesterTabId, { tabId: tab.id, idleTimer: null });
  return tab.id;
}

function releaseWorkerTab(requesterTabId) {
  const entry = workerTabs.get(requesterTabId);
  if (!entry) return;
  clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => closeWorkerTab(requesterTabId), WORKER_IDLE_MS);
}

function closeWorkerTab(requesterTabId) {
  const entry = workerTabs.get(requesterTabId);
  if (!entry) return;
  clearTimeout(entry.idleTimer);
  workerTabs.delete(requesterTabId);
  chrome.tabs.remove(entry.tabId).catch(() => {});
}

// 发起排序的那个页面被关掉 → 它的后台标签页也关掉
chrome.tabs.onRemoved.addListener((tabId) => closeWorkerTab(tabId));

async function startTabCrawl({ urls, rule }, requesterTabId) {
  if (!requesterTabId || !Array.isArray(urls) || !urls.length) return;
  cancelFlags.set(requesterTabId, false);

  let workerTab = null;
  try {
    workerTab = { id: await getWorkerTab(requesterTabId) };

    for (const entry of urls) {
      if (cancelFlags.get(requesterTabId)) break;

      let items = [];
      let error = "";
      let noCards = false; // 页面正常打开,但一直没有出现卡片(多半是列表到头了)
      try {
        await navigateAndWait(workerTab.id, entry.url, 25000);
        await chrome.scripting.executeScript({
          target: { tabId: workerTab.id },
          files: ["src/shared/alignment-engine.js", "src/content/extractor.js"]
        });
        // SPA 站点在 load 事件后才用 JS 渲染卡片:
        // 轮询等卡片数量稳定(连续两次相同且 ≥3),而不是固定等 600ms 就读
        const rendered = await waitForCardsToRender(workerTab.id, 20000);
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: workerTab.id },
          func: (ruleArg, pageArg) => globalThis.__cardSorter?.applyRule(ruleArg, { page: pageArg }),
          args: [rule, entry.page]
        });
        items = result?.result?.items || [];
        if (!items.length && !rendered) {
          noCards = true;
          error = "等了 20 秒页面上也没出现卡片(可能这一页不存在,或网站加载太慢)";
        }
      } catch (crawlError) {
        error = crawlError?.message || String(crawlError);
      }

      await sendToTab(requesterTabId, {
        type: "card-sorter-crawl-page",
        page: entry.page,
        items,
        error,
        noCards
      });
      await delay(500);
    }
  } finally {
    if (workerTab?.id != null) releaseWorkerTab(requesterTabId);
    await sendToTab(requesterTabId, {
      type: "card-sorter-crawl-done",
      cancelled: Boolean(cancelFlags.get(requesterTabId))
    });
    cancelFlags.delete(requesterTabId);
  }
}

// 每 500ms 数一次页面上的卡片,连续两次数量相同且 ≥3 → 渲染稳定;最多等 timeoutMs。
// 返回最终卡片数(0 表示等到超时也没有卡片)。
async function waitForCardsToRender(tabId, timeoutMs) {
  const started = Date.now();
  let previous = -1;
  let count = 0;
  while (Date.now() - started < timeoutMs) {
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          try {
            return globalThis.CardSorterEngine.findCards(document).roots.length;
          } catch (e) {
            return 0;
          }
        }
      });
      count = result?.result || 0;
    } catch {
      count = 0;
    }
    if (count >= 3 && count === previous) return count;
    previous = count;
    await delay(500);
  }
  return count;
}

function navigateAndWait(tabId, url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("页面加载超时"));
    }, timeoutMs);

    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url }).catch((error) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      reject(error);
    });
  });
}

async function sendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // 面板可能已关闭
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
