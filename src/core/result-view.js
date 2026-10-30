// Advanced Card Sort · https://github.com/JB-designer/Sorter-plugin · MIT License
/*
 * 结果的展示结构(结果页和面板里的"前几张"共用;纯函数,方便测试):
 *   - 第一个排序依据分档时,每档开头一条细线:"下载量 40,000–49,999 · 3 张卡片";
 *     没有数值的卡片放最后:"没有下载量 · 4 张卡片"。屏幕上不出现"档/分组"这类词。
 *   - 每张卡片(第 1 张除外)把"让它排在上一张下面的那个数字"标成粗体。
 */
import { normalizeRules, localDayKey } from "./sort.js";
import { getBucketRank, getBand } from "./buckets.js";
import { formatMetricValue, isMissingMetricValue } from "./fields.js";
import { t, isZh } from "./i18n.js";

function fieldOf(catalog, id) {
  return (catalog || []).find((field) => field.id === id) || { id, label: "", type: "number" };
}

// 文字场合(句子、分段线)用的名字。网站没给名字、也猜不出来的数字叫"数字",
// 带上一个真实例子区分:"数字（例如 773）"。永远不显示内部编号。
export function fieldName(field) {
  // 旧的内置名称带英文("收藏/喜欢 Favorites / Likes"):界面只用中文部分
  const label = String(field?.label || "").trim();
  if (!label) return field?.exampleValue ? t("numberEg", field.exampleValue) : t("number");
  if (!/[\u4e00-\u9fa5]/.test(label)) return shorten(label);
  if (!isZh) {
    // 英文界面:取最后一段中文后面的英文名("下载量 Downloads" → "Downloads");只有中文名时照网站原样
    const en = label.replace(/^.*[\u4e00-\u9fa5]/, "").split("/")[0].replace(/^[\s·]+/, "").trim();
    if (en) return shorten(en.charAt(0).toUpperCase() + en.slice(1));
  }
  const zh = label.split(/\s+[A-Za-z]/)[0].split("/")[0].trim();
  return shorten(zh || label);
}

// 网站藏在提示里的长名字("Number of parameters in the model")在菜单里截短,鼠标停上去看全名
const MAX_NAME = 22;
function shorten(name) {
  return name.length > MAX_NAME ? name.slice(0, MAX_NAME - 1).trimEnd() + "…" : name;
}

/* ---------------- 卡片里的图标(没名字的数字用它来认) ---------------- */

const SVG_NS = "http://www.w3.org/2000/svg";
const SAFE_SVG_TAGS = new Set(["svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon"]);

// 图标数据来自网站:显示前再检查一遍,只放行画图用的标签,任何脚本、链接、事件都丢掉
function safeSvg(doc, markup) {
  let parsed;
  try {
    parsed = new DOMParser().parseFromString(String(markup || ""), "image/svg+xml");
  } catch {
    return null;
  }
  const root = parsed?.documentElement;
  if (!root || root.localName !== "svg" || parsed.getElementsByTagName("parsererror").length) return null;
  const clean = (node) => {
    if (!SAFE_SVG_TAGS.has(node.localName)) return null;
    const copy = doc.createElementNS(SVG_NS, node.localName);
    for (const attr of Array.from(node.attributes)) {
      if (/^(?:on|(?:xlink:)?href$|style$|class$|id$)/i.test(attr.name)) continue;
      copy.setAttribute(attr.name, attr.value);
    }
    for (const child of Array.from(node.children)) {
      const cleanChild = clean(child);
      if (cleanChild) copy.appendChild(cleanChild);
    }
    return copy;
  };
  return clean(root);
}

// glyphOk:字体图标要靠网站自己的字体,只有在原网站页面上(面板)才显示得出来
export function renderFieldIcon(doc, icon, { glyphOk = false } = {}) {
  if (!icon || !doc) return null;
  let node = null;
  if (icon.kind === "svg") {
    node = safeSvg(doc, icon.markup);
  } else if (icon.kind === "img" && /^(https?:|data:image\/)/i.test(String(icon.src || ""))) {
    node = doc.createElement("img");
    node.alt = "";
    node.src = icon.src;
  } else if (icon.kind === "glyph" && glyphOk && icon.text) {
    node = doc.createElement("span");
    node.textContent = icon.text;
    node.style.fontFamily = String(icon.font || "").replace(/[;{}]/g, "");
  }
  if (!node) return null;
  node.setAttribute("class", "fi");
  node.setAttribute("aria-hidden", "true");
  return node;
}

// 富文本场合(菜单、规则、卡片上的数字):有名字写名字;没名字有图标就放图标;都没有写"数字"
export function appendFieldLabel(doc, container, field, options = {}) {
  const label = String(field?.label || "").trim();
  const icon = label ? null : renderFieldIcon(doc, field?.icon, options);
  if (icon) container.appendChild(icon);
  else container.appendChild(doc.createTextNode(label ? fieldName(field) : t("number")));
  if (label && fieldName(field).endsWith("…") && container.setAttribute) container.setAttribute("title", label);
  return Boolean(icon);
}

// 句子里没名字的数字("数字（例如 773）")换成它的图标
export function appendSentence(doc, container, text, fields, options = {}) {
  let parts = [String(text || "")];
  for (const field of fields || []) {
    if (String(field?.label || "").trim() || !field?.icon) continue;
    const name = fieldName(field);
    parts = parts.flatMap((part) => {
      if (typeof part !== "string" || !part.includes(name)) return [part];
      const pieces = part.split(name);
      const out = [];
      pieces.forEach((piece, index) => {
        if (index) out.push(field);
        if (piece) out.push(piece);
      });
      return out;
    });
  }
  for (const part of parts) {
    if (typeof part === "string") { container.appendChild(doc.createTextNode(part)); continue; }
    const icon = renderFieldIcon(doc, part.icon, options);
    container.appendChild(icon || doc.createTextNode(fieldName(part)));
  }
}

// 规则在实际排序里怎么比较(和 sort.js compareValues 同一套)
function compareKey(item, rule, field, bucketState) {
  const value = item.metrics?.[rule.field];
  if (isMissingMetricValue(value)) return null;
  if (rule.mode === "bucket" && field.type === "date") return localDayKey(value);
  const bucketField = bucketState?.fields?.[rule.field];
  if (rule.mode === "bucket" && bucketField && !bucketField.exact && (field.type === "number" || field.type === "duration")) {
    return getBucketRank(value, bucketField);
  }
  return field.type === "date" ? Date.parse(value) : field.type === "text" ? String(value) : Number(value);
}

// 让 cur 排在 prev 下面的那个字段 id(没有区别 = 采集顺序决定 → null)
export function decidingField(prev, cur, rules, catalog, bucketState) {
  for (let i = 0; i < rules.length; i += 1) {
    const rule = rules[i];
    const field = fieldOf(catalog, rule.field);
    const a = compareKey(prev, rule, field, bucketState);
    const b = compareKey(cur, rule, field, bucketState);
    if (a === b) continue;
    // 这张卡片没有这个数字:真正决定它在"没有数值"那一段里位置的是下一个依据
    if (b == null) return rules[i + 1] ? rules[i + 1].field : null;
    return rule.field;
  }
  return null;
}

export function primaryRule(sortRules) {
  return normalizeRules(sortRules)[0] || null;
}

export function isBanded(rule, catalog, bucketState) {
  if (!rule || rule.mode !== "bucket") return false;
  const field = fieldOf(catalog, rule.field);
  if (field.type === "date") return true;
  const bucketField = bucketState?.fields?.[rule.field];
  return Boolean(bucketField && !bucketField.exact && (field.type === "number" || field.type === "duration"));
}

export function buildResultView({ items = [], sortRules = [], fieldCatalog = [], bucketState = null, limit = Infinity } = {}) {
  const rules = normalizeRules(sortRules);
  const primary = rules[0] || null;
  const primaryField = primary ? fieldOf(fieldCatalog, primary.field) : null;
  const banded = isBanded(primary, fieldCatalog, bucketState);
  const sections = [];
  let current = null;
  let hasBold = false;

  const sectionKeyOf = (item) => {
    if (!primary) return { key: "all", kind: "plain" };
    const value = item.metrics?.[primary.field];
    if (isMissingMetricValue(value)) return { key: "missing", kind: "missing" };
    if (!banded) return { key: "all", kind: "plain" };
    if (primaryField.type === "date") return { key: "d:" + localDayKey(value), kind: "band", band: { label: localDayKey(value) } };
    const band = getBand(value, bucketState.fields[primary.field]);
    return { key: "b:" + (band ? band.index : "?"), kind: "band", band };
  };

  items.forEach((item, index) => {
    const info = sectionKeyOf(item);
    if (!current || current.key !== info.key) {
      current = { key: info.key, kind: info.kind, label: "", count: 0, startIndex: index, entries: [] };
      if (info.kind === "band") current.label = `${fieldName(primaryField)} ${info.band ? info.band.label : ""}`.trim();
      else if (info.kind === "missing") current.label = t("missingField", fieldName(primaryField));
      sections.push(current);
    }
    current.count += 1;
    if (index >= limit) return;
    const bold = index > 0 ? decidingField(items[index - 1], item, rules, fieldCatalog, bucketState) : null;
    if (bold) hasBold = true;
    current.entries.push({ item, index, bold });
  });

  return {
    rules,
    primary,
    banded,
    sections,
    total: items.length,
    hasBold,
    sortSentence: describeSortSentence(rules, fieldCatalog),
    groupHint: withinGroupHint(rules, fieldCatalog)
  };
}

// "下载量 › 点赞数" / "Downloads › Likes";反方向的写在名字后面:"价格（低 → 高）"
export function describeSortSentence(rules, fieldCatalog) {
  if (!rules.length) return "";
  return rules.map((rule) => {
    const field = fieldOf(fieldCatalog, rule.field);
    const low = rule.direction === "asc";
    const dir = low ? t(field.type === "date" ? "oldNewSuffix" : "lowHighSuffix") : "";
    return fieldName(field) + dir;
  }).join(t("ruleJoin"));
}

// 分段线上的提示:这一段里的卡片按哪一个排("组内按点赞数排序")
export function withinGroupHint(rules, fieldCatalog) {
  const next = rules?.[1];
  return next ? t("withinGroup", fieldName(fieldOf(fieldCatalog, next.field))) : "";
}

export function formatCardValue(item, field) {
  const value = item.metrics?.[field.id];
  if (isMissingMetricValue(value)) return "—";
  const raw = item.metricRaw?.[field.id];
  if (field.type === "number" && Number.isFinite(Number(value))) {
    // 网站自己写成 "41.2K" / "3.2万" / "12 MB" 时照网站的写法显示,否则显示完整数字
    const short = String(raw || "").trim();
    return /^[-+]?[\d.,\s'’]*\d\s*(?:k|m|b|万|萬|亿|億|千|[kmgt]i?b|bytes?)$/i.test(short)
      ? short
      : Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  if (field.type === "date") {
    const day = localDayKey(value);
    return day || String(value);
  }
  return raw ? String(raw).trim() : formatMetricValue(value, field.type);
}

// "第 1–3、5 页" / "pages 1–3, 5"
export function describePageList(pages) {
  const list = [...new Set((pages || []).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  if (!list.length) return "";
  const parts = [];
  let start = list[0];
  let prev = list[0];
  for (let i = 1; i <= list.length; i += 1) {
    if (i < list.length && list[i] === prev + 1) { prev = list[i]; continue; }
    parts.push(start === prev ? `${start}` : `${start}–${prev}`);
    if (i < list.length) { start = list[i]; prev = list[i]; }
  }
  return t("pagesList", parts.join(isZh ? "、" : ", "));
}
