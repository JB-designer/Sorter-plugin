// Advanced Card Sort · https://github.com/JB-designer/Sorter-plugin · MIT License
/*
 * 分档状态(给排序和结果页用)。数学在 bands.js(方法 F7 + 3 倍规则)。
 *   - 用"所有已读的卡片"计算,每读一页、每次排序都重算(不再只看前 60 张)。
 *   - 下面这些情况不分档,按准确数字排(exact = true,界面上的开关隐藏):
 *       卡片少于 10 张或不同数值不超过 7 个;星级评分;时长(暂时精确)。
 *   - 档的序号 rank:1 = 数值最小的一档,越大越靠上;没有数值 → null(排最后)。
 *   - 日期不在这里分档:日期的"相近"= 本地的同一天(见 sort.js)。
 */
import { computeBandEdges, describeBands, distinctSorted, bandOf, looksLikeStarRating } from "./bands.js";

export const BUCKET_STATE_VERSION = 4;

export function makeBucketScopeKey(config = {}) {
  const scopeFilters = config.scopeFilters || {};
  return JSON.stringify({
    sourceUrl: config.sourceUrl || "",
    date: Boolean(scopeFilters.date),
    page: Boolean(scopeFilters.page),
    all: Boolean(scopeFilters.all),
    startDate: scopeFilters.date ? config.startDate || "" : "",
    endDate: scopeFilters.date ? config.endDate || "" : "",
    startPage: scopeFilters.page ? Number(config.startPage || 1) : null,
    endPage: scopeFilters.page ? Number(config.endPage || 0) || null : null,
    poolSize: Number(config.poolSize || 0)
  });
}

export function buildBucketState(items = [], fieldCatalog = [], config = {}) {
  const fields = {};
  for (const field of fieldCatalog) {
    if (field.type !== "number" && field.type !== "duration") continue;
    const values = collectNumericValues(items, field.id);
    fields[field.id] = buildFieldBands(field, values);
  }
  return {
    version: BUCKET_STATE_VERSION,
    createdAt: Date.now(),
    scopeKey: makeBucketScopeKey(config),
    sampleSize: items.length,
    fields
  };
}

export function buildFieldBands(field, values) {
  const distinct = distinctSorted(values);
  let exactReason = "";
  if (field.type === "duration") exactReason = "duration";
  else if (looksLikeStarRating(values, `${field.label || ""} ${field.canonicalId || ""}`)) exactReason = "rating";
  else if (values.length < 10 || distinct.length <= 7) exactReason = "few";
  const edges = exactReason ? distinct.slice(1) : computeBandEdges(values);
  const bands = describeBands(values, edges);
  return {
    fieldId: field.id,
    label: field.label,
    type: field.type,
    count: values.length,
    min: distinct.length ? distinct[0] : null,
    max: distinct.length ? distinct[distinct.length - 1] : null,
    exact: Boolean(exactReason),
    exactReason,
    edges,
    bands,
    // 兼容旧调用方(sidepanel.js):rank 从 1 开始,越大越靠上
    buckets: bands.map((band) => ({ rank: band.index + 1, count: band.count, empty: false, label: band.label })),
    thresholds: edges
  };
}

export function getBucketRank(value, bucketField) {
  if (!bucketField || value == null || value === "" || Number.isNaN(value)) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return bandOf(numeric, bucketField.edges || bucketField.thresholds || []) + 1;
}

export function getBand(value, bucketField) {
  const rank = getBucketRank(value, bucketField);
  if (rank == null) return null;
  return (bucketField.bands || []).find((band) => band.index === rank - 1) || null;
}

export function formatBucketSummary(bucketField) {
  if (!bucketField?.bands?.length) return "";
  return bucketField.bands.map((band) => band.label).join(" · ");
}

export function formatBucketValue(value, bucketField) {
  const band = getBand(value, bucketField);
  return band ? band.label : "";
}

function collectNumericValues(items, fieldId) {
  const values = [];
  for (const item of items) {
    const raw = item.metrics?.[fieldId];
    if (raw == null || raw === "") continue;
    const value = Number(raw);
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}
