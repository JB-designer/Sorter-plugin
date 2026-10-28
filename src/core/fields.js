import {
  normalizeText,
  parseDate,
  parseDuration,
  parseNumber
} from "./parsers.js";

export const CORE_FIELD_DEFINITIONS = {
  title: { id: "title", label: "标题 Title", type: "text", category: "core", priority: 900 },
  uploadDate: { id: "uploadDate", label: "日期 Date", type: "date", category: "core", priority: 1000 },
  durationSeconds: { id: "durationSeconds", label: "时长 Duration", type: "duration", category: "metric", priority: 510 },
  views: { id: "views", label: "浏览量 Views", type: "number", category: "metric", priority: 820 },
  heat: { id: "heat", label: "热度 Popularity", type: "number", category: "metric", priority: 810 },
  favorites: { id: "favorites", label: "收藏数 Favorites", type: "number", category: "metric", priority: 800 },
  likes: { id: "likes", label: "点赞数 Likes", type: "number", category: "metric", priority: 790 },
  dislikes: { id: "dislikes", label: "点踩数 Dislikes", type: "number", category: "metric", priority: 785 },
  comments: { id: "comments", label: "评论数 Comments", type: "number", category: "metric", priority: 780 },
  score: { id: "score", label: "评分 Rating", type: "number", category: "metric", priority: 700 },
  price: { id: "price", label: "价格 Price", type: "number", category: "metric", priority: 690 }
};

const STABLE_SORTABLE_FIELD_IDS = new Set([
  "endorsements",
  "downloads",
  "file-size",
  "filesize"
]);

const LAYOUT_OR_CSS_FIELD_RE = /^(?:absolute|relative|fixed|sticky|static|flex|grid|block|inline|hidden|visible|rounded|rounded-full|rounded-full|full|container|wrapper|row|col|column|left|right|top|bottom|center|middle|shadow|border|background|bg|text|font|bold|normal|small|large|primary|secondary|dark|light|hover|focus|active|disabled)$/i;

export const LEGACY_FIELD_ALIASES = {
  favorite: "favorites",
  favs: "favorites",
  "收藏": "favorites",
  "喜欢": "favorites",
  "喜歡": "favorites",
  view: "views",
  plays: "views",
  play: "views",
  "观看": "views",
  "觀看": "views",
  "浏览": "views",
  "瀏覽": "views",
  comment: "comments",
  "留言": "comments",
  "评论": "comments",
  "評論": "comments",
  "热度": "heat",
  "熱度": "heat",
  rating: "score",
  "积分": "score",
  "積分": "score",
  "评分": "score",
  "評分": "score",
  dislike: "dislikes",
  "点踩": "dislikes",
  "點踩": "dislikes"
};

const FALLBACK_FIELD = {
  type: "number",
  category: "metric",
  priority: 100
};

export function buildFieldCatalog(items = []) {
  const catalog = new Map();

  for (const item of items) {
    if (normalizeText(item.title)) {
      mergeField(catalog, CORE_FIELD_DEFINITIONS.title, { present: true });
    }

    for (const [rawFieldId, value] of Object.entries(item.metrics || {})) {
      if (isMissingMetricValue(value)) continue;
      const fieldId = normalizeFieldId(rawFieldId);
      const detail = item.metricDetails?.[rawFieldId] || item.metricDetails?.[fieldId] || {};
      const definition = makeFieldDefinition(fieldId, detail, value);
      mergeField(catalog, definition, {
        present: true,
        example: detail.rawValue || formatMetricValue(value, definition.type)
      });
    }
  }

  if (!catalog.size) {
    mergeField(catalog, CORE_FIELD_DEFINITIONS.title, { present: false });
  }

  return [...catalog.values()]
    .filter((field) => field.id === "title" || field.count > 0)
    .sort(compareFieldDefinitions);
}

export function makeFieldDefinition(fieldId, detail = {}, sampleValue = null) {
  const normalizedId = normalizeFieldId(fieldId);
  const base = CORE_FIELD_DEFINITIONS[normalizedId] || {};
  const type = detail.type || base.type || inferTypeFromValue(sampleValue) || FALLBACK_FIELD.type;

  return {
    id: normalizedId,
    label: base.label || detail.label || makeFallbackLabel(normalizedId, type),
    type,
    category: detail.category || base.category || FALLBACK_FIELD.category,
    source: detail.source || "",
    confidence: detail.confidence ?? (base.id ? 1 : 0.55),
    priority: detail.priority ?? base.priority ?? FALLBACK_FIELD.priority,
    count: 0,
    examples: []
  };
}

export function normalizeMetricValue(rawValue, type = "number") {
  if (rawValue == null || rawValue === "") return null;
  if (type === "text") return normalizeText(rawValue).toLowerCase();
  if (type === "date") return parseDate(rawValue);
  if (type === "duration") return parseDuration(rawValue);
  return parseNumber(rawValue);
}

export function normalizeFieldId(fieldId) {
  const raw = normalizeText(fieldId).replace(/^metric:/, "");
  if (CORE_FIELD_DEFINITIONS[raw]) return raw;
  const canonicalAlias = canonicalSortableFieldAlias(raw);
  if (canonicalAlias) return canonicalAlias;
  const compactRaw = raw.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "");
  if (compactRaw === "uploaddate") return "uploadDate";
  if (compactRaw === "durationseconds") return "durationSeconds";
  const aliased = LEGACY_FIELD_ALIASES[raw] || raw;
  return aliased
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "") || "metric";
}

function canonicalSortableFieldAlias(rawFieldId) {
  const readable = normalizeText(rawFieldId)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
  if (!readable) return "";
  if (/^(?:views?|view|video views?|videos views?|play count|plays?)$|观看|觀看|浏览|瀏覽|播放/.test(readable)) return "views";
  if (/^(?:comments?|replies)$|留言|评论|評論/.test(readable)) return "comments";
  if (/^(?:favorites?|favs?)$|收藏/.test(readable)) return "favorites";
  if (/^likes?$|\blikes?\s*$|点赞|點讚/.test(readable)) return "likes";
  if (/^dislikes?$|\bdislikes?\s*$|点踩|倒赞|倒讚/.test(readable)) return "dislikes";
  if (/^(?:score|rating)$|积分|積分|评分|評分/.test(readable)) return "score";
  if (/^heat$|热度|熱度/.test(readable)) return "heat";
  if (/\bduration\s*seconds?\b|\bduration\b|时长|時長/.test(readable)) return "durationSeconds";
  if (/\bupload\s*date\b|\bdate\b|上传日期|添加时间|日期/.test(readable)) return "uploadDate";
  return "";
}

export function getFieldType(fieldId, fieldCatalog = []) {
  // 先按原始 id 精确匹配(新架构的 slot id 不能被规范化改写)
  const exact = fieldCatalog.find((field) => field.id === fieldId);
  if (exact) return exact.type || "number";
  const normalizedId = normalizeFieldId(fieldId);
  const known = fieldCatalog.find((field) => field.id === normalizedId) || CORE_FIELD_DEFINITIONS[normalizedId];
  return known?.type || "number";
}

export function getDefaultRulesForCatalog(fieldCatalog = []) {
  const sortableCatalog = fieldCatalog.filter(isSortableField);
  const ids = sortableCatalog.map((field) => field.id);
  const primary =
    ["favorites", "likes", "dislikes", "views", "heat", "comments", "score", "price"]
      .find((field) => ids.includes(field)) ||
    sortableCatalog.find((field) => field.type === "number")?.id ||
    ids[0] ||
    "";
  if (!primary) return [];
  const primaryDefinition = sortableCatalog.find((field) => field.id === primary) || CORE_FIELD_DEFINITIONS[primary];
  return [
    {
      field: primary,
      direction: primaryDefinition?.type === "text" ? "asc" : "desc",
      mode: primaryDefinition?.type === "number" ? "bucket" : "exact",
      min: "",
      max: "",
      enabled: true
    }
  ];
}

export function isSortableField(field) {
  if (!field) return false;
  if (field.type === "date" || field.type === "duration") return true;
  if (field.type !== "number") return false;
  const id = normalizeFieldId(field.id);
  if (CORE_FIELD_DEFINITIONS[id]?.type === "number") return true;
  if (STABLE_SORTABLE_FIELD_IDS.has(id)) return true;
  return isStableCustomMetricField(field);
}

function isStableCustomMetricField(field) {
  const label = normalizeText(field.label || field.id);
  const id = normalizeFieldId(field.id);
  const words = label.split(/\s+/).filter(Boolean);
  if (LAYOUT_OR_CSS_FIELD_RE.test(id) || LAYOUT_OR_CSS_FIELD_RE.test(label.replace(/\s+/g, "-"))) return false;
  if ((field.count || 0) < 3) return false;
  if (!label || label.length > 30 || words.length > 2) return false;
  if (/^\d/.test(label)) return false;
  if (/most|viewed|viewer|choice|profile|playlist|album|video|videos|model|channel|title|name|menu|search|category/i.test(label)) return false;
  if (/favorited|private|premium|verified|official/i.test(label)) return false;
  if (STABLE_SORTABLE_FIELD_IDS.has(id)) return true;
  return /^[a-z][a-z0-9\s_-]*$/i.test(label);
}

export function coerceMetrics(metrics = {}, metricDetails = {}) {
  const nextMetrics = {};
  const nextDetails = {};

  for (const [rawFieldId, rawValue] of Object.entries(metrics)) {
    const fieldId = normalizeFieldId(rawFieldId);
    const detail = metricDetails[rawFieldId] || metricDetails[fieldId] || {};
    const definition = makeFieldDefinition(fieldId, detail, rawValue);
    const value = definition.type === "text" ? normalizeText(rawValue) : rawValue;
    if (isMissingMetricValue(value)) continue;
    nextMetrics[fieldId] = value;
    nextDetails[fieldId] = {
      ...definition,
      rawValue: detail.rawValue ?? rawValue,
      source: detail.source || definition.source || "listing"
    };
  }

  return { metrics: nextMetrics, metricDetails: nextDetails };
}

export function isMissingMetricValue(value) {
  return value == null || value === "" || Number.isNaN(value);
}

export function formatMetricValue(value, type = "number") {
  if (isMissingMetricValue(value)) return "-";
  if (type === "date") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
  }
  if (type === "duration") {
    const total = Number(value);
    if (!Number.isFinite(total)) return "-";
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = Math.floor(total % 60);
    return hours
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
      : `${minutes}:${String(seconds).padStart(2, "0")}`;
  }
  if (type === "text") return normalizeText(value);
  return Number(value).toLocaleString();
}

function mergeField(catalog, definition, { present = false, example = "" } = {}) {
  const field = catalog.get(definition.id) || {
    ...definition,
    count: 0,
    examples: []
  };

  field.label = definition.label || field.label;
  field.type = definition.type || field.type;
  field.source = mergeSourceLabels(field.source, definition.source);
  field.confidence = Math.max(field.confidence || 0, definition.confidence || 0);
  field.priority = Math.max(field.priority || 0, definition.priority || 0);
  if (present) field.count += 1;
  if (example && field.examples.length < 3 && !field.examples.includes(example)) {
    field.examples.push(example);
  }

  catalog.set(field.id, field);
}

function mergeSourceLabels(left = "", right = "") {
  const values = new Set(
    [left, right]
      .flatMap((value) => normalizeText(value).split(/\s*\+\s*|\s*,\s*/))
      .map((value) => normalizeText(value))
      .filter(Boolean)
  );
  return [...values].slice(0, 3).join("+");
}

function compareFieldDefinitions(left, right) {
  if (right.priority !== left.priority) return right.priority - left.priority;
  if (right.count !== left.count) return right.count - left.count;
  return left.label.localeCompare(right.label, "zh-Hans-CN");
}

function inferTypeFromValue(value) {
  if (typeof value === "number") return "number";
  if (typeof value !== "string") return null;
  if (parseDuration(value) != null) return "duration";
  if (parseDate(value) != null) return "date";
  if (parseNumber(value) != null) return "number";
  return null;
}

function makeFallbackLabel(fieldId, type) {
  if (/^icon-metric-\d+$/.test(fieldId)) {
    const number = fieldId.match(/\d+$/)?.[0] || "";
    return `图标指标 Icon Metric #${number}`;
  }
  if (/^numeric-metric-\d+$/.test(fieldId)) {
    const number = fieldId.match(/\d+$/)?.[0] || "";
    return `数字指标 Numeric Metric #${number}`;
  }
  const readable = fieldId
    .replace(/-/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
  if (type === "date") return `${readable} Date`;
  if (type === "duration") return `${readable} Duration`;
  return readable || "Metric";
}
