import { normalizeText, parseDate, parseDuration, parseLocalDay, parseNumber } from "./parsers.js";
import { CORE_FIELD_DEFINITIONS, getFieldType } from "./fields.js";
import { getBucketRank } from "./buckets.js";

export const FIELD_DEFINITIONS = Object.values(CORE_FIELD_DEFINITIONS);

export const DEFAULT_RULES = [
  { field: "title", direction: "asc", mode: "exact", min: "", max: "", enabled: true }
];

export function applyFiltersAndSort(items, rules, globalFilters = {}) {
  const activeRules = normalizeRules(rules);
  const fieldCatalog = globalFilters.fieldCatalog || [];
  const bucketState = globalFilters.bucketState || null;
  const filtered = items.filter((item) => {
    if (!passesScopeFilter(item, globalFilters)) return false;
    if (!passesSearchFilter(item, globalFilters)) return false;
    return activeRules.every((rule) => passesRuleRange(item, rule, fieldCatalog));
  });

  return filtered
    .map((item, index) => ({ item, index }))
    .sort((left, right) => compareItems(left, right, activeRules, fieldCatalog, bucketState))
    .map(({ item }) => item);
}

export function passesSearchFilter(item, filters = {}) {
  const query = normalizeText(filters.query).toLowerCase();
  if (!query) return true;

  const terms = query.split(/\s+/).filter(Boolean);
  if (!terms.length) return true;

  const haystack = getSearchText(item);
  return terms.every((term) => haystack.includes(term));
}

export function getSearchText(item) {
  return normalizeText(
    item.searchText ||
      [
        item.title,
        item.author,
        item.rawText,
        item.videoUrl
      ].filter(Boolean).join(" ")
  ).toLowerCase();
}

// 最后一条(含只有一条)规则永远按精确数值排:分档只用于把"相近"交给下一条规则决定,
// 最后一条之后没有规则可交,分档只会让同档卡片退回到采集顺序,数字不再从大到小。
export function normalizeRules(rules) {
  const active = (rules || []).filter((rule) => rule?.enabled !== false && rule?.field);
  return active.map((rule, index) => ({
    field: rule.field,
    direction: rule.direction === "asc" ? "asc" : "desc",
    mode: rule.mode === "bucket" && index < active.length - 1 ? "bucket" : "exact",
    min: normalizeText(rule.min),
    max: normalizeText(rule.max),
    enabled: true
  }));
}

function passesScopeFilter(item, filters) {
  const scopeFilters = normalizeScopeFilters(filters);
  if (scopeFilters.all) return true;
  if (scopeFilters.date && !passesGlobalDateFilter(item, filters)) return false;
  if (scopeFilters.page && !passesPageScopeFilter(item, filters)) return false;
  return true;
}

function normalizeScopeFilters(filters) {
  if (filters.scopeFilters) {
    return {
      date: Boolean(filters.scopeFilters.date),
      page: Boolean(filters.scopeFilters.page),
      all: Boolean(filters.scopeFilters.all)
    };
  }
  const scopeMode = filters.scopeMode || "date";
  if (scopeMode === "all") return { date: false, page: false, all: true };
  if (scopeMode === "page") return { date: false, page: true, all: false };
  return { date: true, page: false, all: false };
}

function passesGlobalDateFilter(item, filters) {
  const uploadDate = item.metrics?.uploadDate;
  if (!filters.startDate && !filters.endDate) return true;
  if (!uploadDate) return false;

  const value = Date.parse(uploadDate);
  if (!Number.isFinite(value)) return false;

  if (filters.startDate && value < startOfDay(filters.startDate)) return false;
  if (filters.endDate && value > endOfDay(filters.endDate)) return false;

  return true;
}

function passesPageScopeFilter(item, filters) {
  const page = Number(item.sourcePage);
  if (!Number.isFinite(page)) return false;
  const startPage = Number(filters.startPage || 1);
  const endPage = Number(filters.endPage || Infinity);
  if (Number.isFinite(startPage) && page < startPage) return false;
  if (Number.isFinite(endPage) && page > endPage) return false;
  return true;
}

function passesRuleRange(item, rule, fieldCatalog) {
  if (!rule.min && !rule.max) return true;

  const value = getComparableValue(item, rule.field);
  if (isMissing(value)) return false;

  const fieldType = getFieldType(rule.field, fieldCatalog);
  const min = parseRangeValueByType(fieldType, rule.min);
  const max = parseRangeValueByType(fieldType, rule.max);

  if (min != null && compareRaw(value, min, fieldType) < 0) return false;
  if (max != null && compareRaw(value, max, fieldType) > 0) return false;
  return true;
}

function compareItems(left, right, rules, fieldCatalog, bucketState) {
  for (const rule of rules) {
    const leftValue = getComparableValue(left.item, rule.field);
    const rightValue = getComparableValue(right.item, rule.field);
    const comparison = compareValues(leftValue, rightValue, rule, fieldCatalog, bucketState);
    if (comparison !== 0) return comparison;
  }

  // 全部规则都相同时保持采集顺序:先比来源页,再比页内位置,最后比入池顺序。
  // (discoveryOrder 是"页内"序号,单独比较会把多页的同值卡片交错打乱)
  const pageDiff = pageOf(left.item) - pageOf(right.item);
  if (pageDiff !== 0) return pageDiff;
  const leftOrder = left.item.discoveryOrder ?? left.item.originalIndex ?? left.index;
  const rightOrder = right.item.discoveryOrder ?? right.item.originalIndex ?? right.index;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return left.index - right.index;
}

function pageOf(item) {
  const page = Number(item.sourcePage);
  return Number.isFinite(page) ? page : 0;
}

function compareValues(leftValue, rightValue, rule, fieldCatalog, bucketState) {
  const leftMissing = isMissing(leftValue);
  const rightMissing = isMissing(rightValue);
  if (leftMissing && rightMissing) return 0;
  if (leftMissing) return 1;
  if (rightMissing) return -1;

  const fieldType = getFieldType(rule.field, fieldCatalog);
  // 日期"相近" = 本地的同一天
  if (rule.mode === "bucket" && fieldType === "date") {
    const comparison = localDayKey(leftValue).localeCompare(localDayKey(rightValue));
    return rule.direction === "asc" ? comparison : -comparison;
  }
  const bucketField = bucketState?.fields?.[rule.field];
  // 分档不适用(数值太少、星级评分、时长)或还没算出档 → 按准确数字比较
  if (rule.mode === "bucket" && (fieldType === "number" || fieldType === "duration") && bucketField && !bucketField.exact) {
    const leftRank = getBucketRank(leftValue, bucketField);
    const rightRank = getBucketRank(rightValue, bucketField);
    const leftRankMissing = leftRank == null;
    const rightRankMissing = rightRank == null;
    if (leftRankMissing && rightRankMissing) return 0;
    if (leftRankMissing) return 1;
    if (rightRankMissing) return -1;
    if (leftRank !== rightRank) {
      const comparison = leftRank - rightRank;
      return rule.direction === "asc" ? comparison : -comparison;
    }
    return 0;
  }

  const comparison = compareRaw(leftValue, rightValue, fieldType);
  return rule.direction === "asc" ? comparison : -comparison;
}

function compareRaw(leftValue, rightValue, fieldType) {
  if (fieldType === "date") {
    return Date.parse(leftValue) - Date.parse(rightValue);
  }

  if (fieldType === "text") {
    return String(leftValue).localeCompare(String(rightValue), "zh-Hans-CN", {
      numeric: true,
      sensitivity: "base"
    });
  }

  return Number(leftValue) - Number(rightValue);
}

function getComparableValue(item, field) {
  if (field === "title") return normalizeText(item.title).toLowerCase();
  return item.metrics?.[field] ?? null;
}

function parseRangeValueByType(fieldType, value) {
  const text = normalizeText(value);
  if (!text) return null;
  if (fieldType === "date") return parseDate(text);
  if (fieldType === "duration") return parseDuration(text);
  if (fieldType === "text") return text.toLowerCase();
  return parseNumber(text);
}

function isMissing(value) {
  return value == null || value === "" || Number.isNaN(value);
}

export function localDayKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
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

// ---- 排序规则下拉框(面板用) ----

// "加一条规则"默认用一个还没被任何规则用上的字段;全部用上了返回 null
export function firstUnusedField(catalog = [], rules = []) {
  const used = new Set(rules.map((rule) => rule?.field).filter(Boolean));
  const field = catalog.find((candidate) => !used.has(candidate.id));
  return field ? field.id : null;
}

// 在第 index 条规则里选了 fieldId:如果另一条规则已经在用它,两条规则互换位置
// (方向、档位设置跟着各自的字段走);否则只改这一条的字段。
// 返回 { rules, swappedWith }(swappedWith = 被换走的那一行的新位置,没换为 -1)。
export function assignRuleField(rules = [], index, fieldId) {
  const next = rules.map((rule) => ({ ...rule }));
  if (!next[index]) return { rules: next, swappedWith: -1 };
  const other = next.findIndex((rule, i) => i !== index && rule.field === fieldId);
  if (other === -1) {
    next[index].field = fieldId;
    return { rules: next, swappedWith: -1 };
  }
  const moved = next[other];
  next[other] = next[index];
  next[index] = moved;
  return { rules: next, swappedWith: other };
}
