// Advanced Card Sort · https://github.com/JB-designer/Sorter-plugin · MIT License
/*
 * 结果页(样稿 v7 F6):纯展示。
 *   - 顶部:"120 张卡片 · 第 1–5 页"、排序说明。
 *   - 第一个排序依据分档时,每档开头一条细线"下载量 40,000–49,999 · 3 张卡片";没有数值的卡片在最后。
 *   - 每张卡片(第 1 张除外)把让它排在上一张下面的那个数字加粗。
 *   - 每张卡片顶部是网站原本的预览图(约 16:9,滚动到才加载);没有图或加载失败时显示带首字的色块。
 * 数据由面板经后台写入 chrome.storage.local(key: cardSorterResults:<rid>),本页监听变化实时刷新。
 */
import { buildResultView, describePageList, formatCardValue, fieldName, appendFieldLabel, appendSentence } from "./src/core/result-view.js";
import { t, isZh } from "./src/core/i18n.js";

// 静态文字(标题、空状态)跟随界面语言
document.documentElement.lang = isZh ? "zh-CN" : "en";
document.title = t("resultsDocTitle");
document.getElementById("emptyState").textContent = t("noResults");
document.getElementById("creditLink").firstChild.nodeValue = t("credit");

const refs = {
  titleLine: document.getElementById("titleLine"),
  sortLine: document.getElementById("sortLine"),
  readNotes: document.getElementById("readNotes"),
  sourceLine: document.getElementById("sourceLine"),
  grid: document.getElementById("grid"),
  emptyState: document.getElementById("emptyState")
};

let data = null;

// 每个结果页由 URL 上的 rid 绑定自己独立的数据(互不覆盖);无 rid 时回退旧的共享 key(兼容旧入口)
const RESULT_KEY = (() => {
  const rid = new URLSearchParams(location.search).get("rid");
  return rid ? "cardSorterResults:" + rid : "cardSorterResults";
})();

initialize();

async function initialize() {
  const stored = await chrome.storage.local.get(RESULT_KEY);
  data = stored?.[RESULT_KEY] || null;
  render();

  chrome.storage.local.onChanged.addListener((changes) => {
    // 只响应真实的新数据;key 被清理(超过保留份数)时保持当前内容,不清空页面
    if (changes[RESULT_KEY] && changes[RESULT_KEY].newValue) {
      data = changes[RESULT_KEY].newValue;
      render();
    }
  });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function render() {
  const hasItems = Boolean(data?.items?.length);
  refs.emptyState.classList.toggle("hidden", hasItems);
  refs.grid.textContent = "";
  refs.readNotes.textContent = "";
  if (!hasItems) {
    refs.titleLine.textContent = t("resultsTitle");
    refs.sortLine.textContent = "";
    return;
  }
  const stats = data.stats || {};
  const catalog = data.fieldCatalog || [];
  const view = buildResultView({
    items: data.items,
    sortRules: data.sortRules,
    fieldCatalog: catalog,
    bucketState: data.bucketState
  });
  const pagesText = describePageList(stats.pages);
  const whole = stats.listEndedAfter != null && stats.pages?.[0] === 1 && !(stats.skippedPages || []).length;
  refs.titleLine.textContent = t("resultsHeading", { n: data.items.length, pages: pagesText, whole });
  refs.sortLine.textContent = "";
  appendSentence(document, refs.sortLine, view.sortSentence, catalog);
  document.title = t("resultsTabTitle", { n: data.items.length, source: data.sourceTitle || t("resultsTitle") });

  // 读取说明:列表比要读的页数短、有页被跳过、网站限速 —— 写明,不静默
  const notes = [];
  if (stats.listEndedAfter != null) notes.push(["info", t("noteListEnds", stats.listEndedAfter)]);
  if (stats.stoppedAtPage != null) notes.push(["warn", t("noteStoppedAt", stats.stoppedAtPage)]);
  if (stats.skippedPages?.length) notes.push(["warn", t("noteSkipped", stats.skippedPages)]);
  if (stats.slowedDown) notes.push(["warn", t("noteSlow")]);
  if (stats.merged) notes.push(["info", t("noteMerged", stats.merged)]);
  for (const [tone, text] of notes) refs.readNotes.appendChild(el("div", `note ${tone}`, text));

  refs.sourceLine.textContent = "";
  if (data.sourceUrl) {
    refs.sourceLine.appendChild(document.createTextNode(t("from")));
    const link = el("a", "", data.sourceTitle || data.sourceUrl);
    link.href = data.sourceUrl;
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    refs.sourceLine.appendChild(link);
  }

  const ruleFields = view.rules.map((rule) => {
    const field = catalog.find((f) => f.id === rule.field) || { id: rule.field, label: "", type: "number" };
    return { ...field, label: field.label ? fieldName(field) : "" };
  });

  const fragment = document.createDocumentFragment();
  view.sections.forEach((section, index) => {
    if (section.kind !== "plain") {
      const divider = el("div", "div");
      divider.appendChild(el("b", "", section.label));
      divider.appendChild(document.createTextNode(` · ${t("cardsCount", section.count)}`));
      if (view.groupHint && section.kind === "band") divider.title = view.groupHint;
      fragment.appendChild(divider);
    }
    const cards = el("div", "cards" + (index === 0 && section.kind === "plain" ? " first" : ""));
    for (const entry of section.entries) cards.appendChild(renderCard(entry, ruleFields));
    fragment.appendChild(cards);
  });
  refs.grid.appendChild(fragment);
}

function renderCard(entry, ruleFields) {
  const { item, index, bold } = entry;
  const card = el("div", "card");
  card.appendChild(renderThumb(item));
  const body = el("div", "cb");
  body.appendChild(el("span", "rk", String(index + 1)));
  const text = el("div", "tx");
  const title = el(item.videoUrl ? "a" : "div", "n", item.title || t("untitled"));
  title.title = item.title || "";
  if (item.videoUrl) {
    title.href = item.videoUrl;
    title.target = "_blank";
    title.rel = "noreferrer noopener";
  }
  text.appendChild(title);
  const metrics = el("div", "m");
  ruleFields.forEach((field, i) => {
    if (i) metrics.appendChild(document.createTextNode(" · "));
    // 每个"名字 数值"不在中间折行,只在两个数字之间折行
    const seg = el("span", "seg");
    appendFieldLabel(document, seg, field);
    seg.appendChild(document.createTextNode(" "));
    const value = formatCardValue(item, field);
    seg.appendChild(el("span", value === "—" ? "na" : bold === field.id ? "d" : "", value));
    metrics.appendChild(seg);
  });
  text.appendChild(metrics);
  body.appendChild(text);
  card.appendChild(body);
  return card;
}

// 网站原本的卡片预览图;没有图或加载失败 → 同样大小的色块加标题首字,不出现破图标志
function renderThumb(item) {
  const frame = el(item.videoUrl ? "a" : "div", "th");
  if (item.videoUrl) {
    frame.href = item.videoUrl;
    frame.target = "_blank";
    frame.rel = "noreferrer noopener";
    frame.tabIndex = -1;
  }
  const letter = el("span", "ph", firstLetter(item.title));
  frame.appendChild(letter);
  if (item.thumbnailUrl) {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    // 占位图、小图标也会"加载成功",太小的图一律当作没有图,保留首字色块
    img.addEventListener("load", () => {
      if (img.naturalWidth < 48 || img.naturalHeight < 48) img.remove();
      else letter.remove();
    });
    img.addEventListener("error", () => { img.remove(); });
    img.src = item.thumbnailUrl;
    frame.appendChild(img);
  }
  return frame;
}

function firstLetter(title) {
  const text = String(title || "").trim();
  return text ? Array.from(text)[0].toUpperCase() : "·";
}
