const NUMBER_UNITS = [
  { suffix: "亿", multiplier: 100000000 },
  { suffix: "億", multiplier: 100000000 },
  { suffix: "b", multiplier: 1000000000 },
  { suffix: "billion", multiplier: 1000000000 },
  { suffix: "万", multiplier: 10000 },
  { suffix: "萬", multiplier: 10000 },
  { suffix: "千", multiplier: 1000 },
  { suffix: "m", multiplier: 1000000 },
  { suffix: "million", multiplier: 1000000 },
  { suffix: "k", multiplier: 1000 },
  { suffix: "thousand", multiplier: 1000 }
];

export function normalizeText(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// 数字写法(通用,与 alignment-engine.js 的 readNumberToken 同一规则):
//   "1,234" / "1.234" / "1 234" = 1234(三位一组的千分位);"1,2K" / "2,5" = 小数逗号;
//   "1.234,5" / "1,234.5" = 最后一个符号是小数点;"1.234K" 这类带单位的点号按小数读。
const NUM_TOKEN_SRC = "(?:\\d{1,3}(?:[ '’]\\d{3})+(?!\\d)(?:[.,]\\d+)?|\\d+(?:[.,]\\d+)*)";
const UNIT_SRC = "亿|億|万|萬|千|billion|million|thousand|[kmb]";
const LEGACY_NUM_RE = /^\d+(?:,\d{3})*(?:\.\d+)?/;

export function readNumberToken(token, hasUnit = false) {
  const tok = String(token);
  if (/[ '’]/.test(tok)) {
    const spaced = tok.match(/^([\d '’]+?)(?:[.,](\d+))?$/);
    if (!spaced) return null;
    return Number(spaced[1].replace(/[ '’]/g, "") + (spaced[2] ? `.${spaced[2]}` : ""));
  }
  const seps = tok.match(/[.,]/g) || [];
  if (!seps.length) return Number(tok);
  const groups = tok.split(/[.,]/);
  if (seps.length === 1) {
    const [intPart, frac] = groups;
    const thousandsLike = frac.length === 3 && intPart !== "0" && intPart.length <= 3;
    if (thousandsLike && (seps[0] === "," || !hasUnit)) return Number(intPart + frac);
    return Number(`${intPart}.${frac}`);
  }
  const last = seps[seps.length - 1];
  const grouping = seps.slice(0, -1);
  const mixed = grouping.every((c) => c !== last) && new Set(grouping).size === 1;
  const middleOk = groups.slice(1, mixed ? -1 : groups.length).every((g) => g.length === 3) && groups[0].length <= 3;
  if (mixed && middleOk) return Number(`${groups.slice(0, -1).join("")}.${groups[groups.length - 1]}`);
  if (new Set(seps).size === 1 && middleOk) return Number(groups.join(""));
  // 不像千分位(如版本号 1.2.3):按旧规则只读开头
  const legacy = tok.match(LEGACY_NUM_RE);
  return legacy ? Number(legacy[0].replace(/,/g, "")) : null;
}

export function parseNumber(value) {
  const text = normalizeText(value).toLowerCase();
  if (!text) return null;

  const match = text.match(new RegExp(`([-+]?)(${NUM_TOKEN_SRC})(?:\\s*(${UNIT_SRC}))?`, "i"));
  if (!match) return null;

  const suffix = normalizeText(match[3]).toLowerCase();
  const unit = NUMBER_UNITS.find((candidate) => candidate.suffix === suffix);
  let numeric = readNumberToken(match[2], Boolean(unit));
  if (numeric == null || !Number.isFinite(numeric)) return null;
  if (match[1] === "-") numeric = -numeric;
  return unit ? Math.round(numeric * unit.multiplier) : numeric;
}

export function parseDuration(value) {
  const text = normalizeText(value);
  if (!text) return null;

  const clock = text.match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/);
  if (clock) {
    const first = Number(clock[1]);
    const second = Number(clock[2]);
    const third = clock[3] == null ? null : Number(clock[3]);
    if (third == null) return first * 60 + second;
    return first * 3600 + second * 60 + third;
  }

  const hours = text.match(/(\d+(?:\.\d+)?)\s*(?:小时|小時|hours?|hrs?|h)(?=\s|$)/i);
  const minutes = text.match(/(\d+(?:\.\d+)?)\s*(?:分钟|分鐘|minutes?|mins?|m)(?=\s|$)/i);
  const seconds = text.match(/(\d+(?:\.\d+)?)\s*(?:秒|seconds?|secs?|s)(?=\s|$)/i);

  if (!hours && !minutes && !seconds) return null;

  return Math.round(
    (hours ? Number(hours[1]) * 3600 : 0) +
      (minutes ? Number(minutes[1]) * 60 : 0) +
      (seconds ? Number(seconds[1]) : 0)
  );
}

export function parseDate(value, now = new Date()) {
  const text = normalizeText(value).replace(/^添加时间[:：]?\s*/i, "");
  if (!text) return null;

  const relative = parseRelativeDate(text, now);
  if (relative) return relative;

  if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}[T\s]\d{1,2}/.test(text)) {
    const parsedDateTime = new Date(text);
    if (!Number.isNaN(parsedDateTime.getTime())) return parsedDateTime.toISOString();
  }

  const isoLike = text.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (isoLike) {
    return makeDate(Number(isoLike[1]), Number(isoLike[2]), Number(isoLike[3]));
  }

  const usLike = text.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (usLike) {
    return makeDate(Number(usLike[3]), Number(usLike[1]), Number(usLike[2]));
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseRelativeDate(text, now) {
  const normalized = normalizeText(text).toLowerCase();
  if (/刚刚|剛剛|just now/.test(normalized)) return now.toISOString();

  const match = normalized.match(/(\d+(?:\.\d+)?)\s*(秒|分钟|分鐘|小时|小時|天|日|周|星期|个月|個月|月|年|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s*(?:前|ago)?/i);
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;

  const unit = match[2];
  const milliseconds = unitToMilliseconds(unit, amount);
  if (milliseconds == null) return null;

  return new Date(now.getTime() - milliseconds).toISOString();
}

function unitToMilliseconds(unit, amount) {
  if (/秒|sec|second/.test(unit)) return amount * 1000;
  if (/分钟|分鐘|min|minute/.test(unit)) return amount * 60 * 1000;
  if (/小时|小時|hr|hour/.test(unit)) return amount * 60 * 60 * 1000;
  if (/天|日|day/.test(unit)) return amount * 24 * 60 * 60 * 1000;
  if (/周|星期|week/.test(unit)) return amount * 7 * 24 * 60 * 60 * 1000;
  if (/个月|個月|月|month/.test(unit)) return amount * 30 * 24 * 60 * 60 * 1000;
  if (/年|year/.test(unit)) return amount * 365 * 24 * 60 * 60 * 1000;
  return null;
}

// 只有日期的值按本地的那一天(本地零点)存,避免时区让日期前后差一天
function makeDate(year, month, day) {
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function parseLabeledNumber(text, labels) {
  const source = normalizeText(text);
  for (const label of labels) {
    const pattern = new RegExp(`${escapeRegExp(label)}\\s*[:：]?\\s*([-+]?${NUM_TOKEN_SRC}\\s*(?:万|萬|亿|億|千|k|K|m|M|b|B)?)`, "g");
    let match;
    while ((match = pattern.exec(source))) {
      if (isNumberSuffixLabel(source.slice(0, match.index))) continue;
      return parseNumber(match[1]);
    }
  }
  return null;
}

export function parseLabeledText(text, labels) {
  const source = normalizeText(text);
  for (const label of labels) {
    const pattern = new RegExp(`${escapeRegExp(label)}\\s*[:：]?\\s*(.+?)(?=\\s+(?:添加时间|添加時間|作者|热度|熱度|播放|收藏|留言|评论|評論|积分|積分|评分|評分)\\s*[:：]|$)`);
    const match = source.match(pattern);
    if (match) return normalizeText(match[1]);
  }
  return "";
}

// "2024-03-05" 这种纯日期按本地日解析(new Date("2024-03-05") 会当成 UTC 零点)
export function parseLocalDay(value) {
  const text = normalizeText(value);
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(value);
}

export function toDateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseRangeValue(field, value) {
  const text = normalizeText(value);
  if (!text) return null;
  if (field === "uploadDate") return parseDate(text);
  if (field === "durationSeconds") return parseDuration(text);
  if (field === "title") return text.toLowerCase();
  return parseNumber(text);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNumberSuffixLabel(prefix) {
  const match = /(?:^|\s)([-+]?\d+(?:,\d{3})*(?:\.\d+)?\s*(?:万|萬|亿|億|千|k|K|m|M|b|B)?\s*(?:次|則|则|条|條|個|个)?)\s*$/.exec(prefix);
  if (!match) return false;
  const beforeNumber = prefix.slice(0, match.index).trimEnd();
  if (/[:：]$/.test(beforeNumber)) return false;
  return /(?:万|萬|亿|億|千|k|K|m|M|b|B|次|則|则|条|條|個|个)/.test(match[1]);
}
