/*
 * CardSorterEngine — 跨卡片结构对齐引擎 (wrapper induction)
 *
 * 设计原则:
 *   1. 不依赖关键词词表定位字段。列表页所有 card 共享同一模板,
 *      因此按 "slot 路径" 跨卡片对齐:同一路径在多数卡片上出现、
 *      且值可解析为 number/date/duration 的 slot 即为候选字段。
 *   2. label 靠跨卡片 diff:同一 slot 中恒定的 token 是 label,
 *      变化的部分是 value。词表只用来 "猜名字/预勾选",不用来定位。
 *   3. 文字类 slot 一律 excluded(不可排序),但保留呈现给用户确认。
 *
 * 本文件是自包含的全局脚本(无 import/export/chrome API):
 *   - content script 经 chrome.scripting.executeScript 注入
 *   - side panel / results 页经 <script src> 加载(解析抓取到的 DOMParser 文档)
 *   - Node 测试经 import 副作用加载,读取 globalThis.CardSorterEngine
 */
(function () {
  "use strict";

  var ENGINE_VERSION = 2;
  var MAX_SEEDS = 4000;
  var MAX_CARDS = 400;
  var MAX_ELEMENTS_PER_CARD = 600;
  var MIN_CLUSTER_SIZE = 3;
  var COVERAGE_KEEP = 0.3;   // 低于此覆盖率的 slot 视为噪音,直接丢弃
  var COVERAGE_TRUST = 0.6;  // 达到此覆盖率且类型可靠才允许预勾选
  var TYPE_RATIO = 0.75;     // slot 内值可按同一类型解析的最低比例

  /* ---------------------------------------------------------------- *
   * 文本与数值解析
   * ---------------------------------------------------------------- */

  function normalizeText(value) {
    return String(value == null ? "" : value).replace(/ /g, " ").replace(/\s+/g, " ").trim();
  }

  var DURATION_RE = /(?:^|[^\d:])(\d{1,3}:\d{2}(?::\d{2})?)(?:$|[^\d:])/;
  var DATE_TIME_RE = /\d{4}-\d{2}-\d{2}[T\s]\d{1,2}:\d{2}/;
  var ABS_DATE_RE = /\b(?:19|20)\d{2}[-/.年]\s?\d{1,2}[-/.月]\s?\d{1,2}日?\b|\b\d{1,2}[-/.]\d{1,2}[-/.](?:19|20)\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+(?:19|20)\d{2}\b|\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(?:19|20)\d{2}\b/i;
  var REL_DATE_RE = /(\d+(?:\.\d+)?)\s*(秒|分钟|分鐘|小时|小時|天|日|周|週|星期|个月|個月|月|年|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s*(前|ago)/i;
  var JUST_NOW_RE = /刚刚|剛剛|just now|today|昨天|yesterday/i;
  var COMPACT_REL_RE = /^(\d+(?:\.\d+)?)\s*(d|days?|h|hrs?|hours?|min|mins|minutes?|w|wks?|weeks?|mo|mos|months?|y|yrs?|years?)$/i;
  // 数字写法(通用,不按网站硬编码):
  //   "1,234" / "1.234" / "1 234" / "1'234" = 一千二百三十四(三位一组的千分位);
  //   "1,2K" / "2,5" = 小数逗号;"1.234.567,89" / "1,234,567.89" = 最后一个符号是小数点。
  //   "1.234K" 这类带单位的点号仍按小数读;"0.123" 永远是小数。
  var NUM_TOKEN_SRC = "(?:\\d{1,3}(?:[ '’]\\d{3})+(?!\\d)(?:[.,]\\d+)?|\\d+(?:[.,]\\d+)*)";
  var NUMBER_RE = new RegExp("[-+]?" + NUM_TOKEN_SRC + "\\s*(?:万|萬|亿|億|k|m|b|thousand|million|billion)?\\b", "i");
  var BYTE_RE = new RegExp("(" + NUM_TOKEN_SRC + ")\\s*(bytes?|kb|mb|gb|tb)\\b", "i");
  var PERCENT_RE = new RegExp("(" + NUM_TOKEN_SRC + ")\\s*%");
  var LEGACY_NUM_RE = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/;

  // 把一个数字片段读成数值;hasUnit = 后面紧跟 k/万 等单位
  function readNumberToken(token, hasUnit) {
    var tok = String(token);
    if (/[ '’]/.test(tok)) {
      var spaced = tok.match(/^([\d '’]+?)(?:[.,](\d+))?$/);
      if (!spaced) return null;
      return Number(spaced[1].replace(/[ '’]/g, "") + (spaced[2] ? "." + spaced[2] : ""));
    }
    var seps = tok.match(/[.,]/g) || [];
    if (!seps.length) return Number(tok);
    var groups = tok.split(/[.,]/);
    if (seps.length === 1) {
      var intPart = groups[0], frac = groups[1];
      var thousandsLike = frac.length === 3 && intPart !== "0" && intPart.length <= 3;
      if (thousandsLike && (seps[0] === "," || !hasUnit)) return Number(intPart + frac);
      return Number(intPart + "." + frac);
    }
    var last = seps[seps.length - 1];
    var grouping = seps.slice(0, -1);
    var mixed = grouping.every(function (c) { return c !== last; }) && new Set(grouping).size === 1;
    var middleOk = groups.slice(1, mixed ? -1 : groups.length).every(function (g) { return g.length === 3; }) && groups[0].length <= 3;
    if (mixed && middleOk) return Number(groups.slice(0, -1).join("") + "." + groups[groups.length - 1]);
    if (new Set(seps).size === 1 && middleOk) return Number(groups.join(""));
    // 不像千分位(如版本号 1.2.3):按旧规则只读开头
    var legacy = tok.match(LEGACY_NUM_RE);
    return legacy ? Number(legacy[0].replace(/,/g, "")) : null;
  }

  function parseNumber(value) {
    var text = normalizeText(value).toLowerCase();
    if (!text) return null;
    var bytes = text.match(BYTE_RE);
    if (bytes) {
      var base = readNumberToken(bytes[1], false);
      if (base == null || !isFinite(base)) return null;
      var mult = { b: 1, byte: 1, bytes: 1, kb: 1024, mb: 1048576, gb: 1073741824, tb: 1099511627776 };
      return Math.round(base * (mult[bytes[2].toLowerCase()] || 1));
    }
    var pct = text.match(PERCENT_RE);
    if (pct) return readNumberToken(pct[1], false);
    // 注意:\b 对中文单位(万/亿)无效,用负向前瞻判定后缀边界
    var match = text.match(new RegExp("([-+]?)(" + NUM_TOKEN_SRC + ")\\s*(万|萬|亿|億|k|m|b|thousand|million|billion)?(?![a-zA-Z0-9])", "i"));
    if (!match) return null;
    var suffix = (match[3] || "").toLowerCase();
    var num = readNumberToken(match[2], Boolean(suffix));
    if (num == null || !isFinite(num)) return null;
    if (match[1] === "-") num = -num;
    var multipliers = {
      k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, billion: 1e9,
      "万": 1e4, "萬": 1e4, "亿": 1e8, "億": 1e8
    };
    var result = num * (multipliers[suffix] || 1);
    return suffix ? Math.round(result) : result;
  }

  function parseDurationSeconds(value) {
    var text = normalizeText(value);
    var colon = text.match(/(\d{1,3}):(\d{2})(?::(\d{2}))?/);
    if (colon) {
      var a = Number(colon[1]);
      var b = Number(colon[2]);
      var c = colon[3] == null ? null : Number(colon[3]);
      return c == null ? a * 60 + b : a * 3600 + b * 60 + c;
    }
    var units = text.toLowerCase().match(/(\d+(?:\.\d+)?)\s*(小时|小時|hours?|hrs?|h)\b/);
    var mins = text.toLowerCase().match(/(\d+(?:\.\d+)?)\s*(分钟|分鐘|minutes?|mins?|min)\b/);
    var secs = text.toLowerCase().match(/(\d+(?:\.\d+)?)\s*(秒|seconds?|secs?)\b/);
    if (units || mins || secs) {
      return Math.round(
        (units ? Number(units[1]) * 3600 : 0) +
        (mins ? Number(mins[1]) * 60 : 0) +
        (secs ? Number(secs[1]) : 0)
      );
    }
    return null;
  }

  function parseDateIso(value, now) {
    var text = normalizeText(value);
    if (!text) return null;
    var current = now instanceof Date ? now.getTime() : Date.now();

    var rel = text.match(REL_DATE_RE);
    if (rel) {
      var amount = Number(rel[1]);
      var unit = rel[2];
      var days = null;
      if (/秒|sec/i.test(unit)) days = amount / 86400;
      else if (/分钟|分鐘|min/i.test(unit)) days = amount / 1440;
      else if (/小时|小時|hour|hr/i.test(unit)) days = amount / 24;
      else if (/天|日|day/i.test(unit)) days = amount;
      else if (/周|週|星期|week/i.test(unit)) days = amount * 7;
      else if (/个月|個月|月|month/i.test(unit)) days = amount * 30;
      else if (/年|year/i.test(unit)) days = amount * 365;
      if (days != null && isFinite(days)) return new Date(current - days * 86400000).toISOString();
    }
    if (JUST_NOW_RE.test(text)) {
      var offset = /昨天|yesterday/i.test(text) ? 86400000 : 0;
      return new Date(current - offset).toISOString();
    }

    // 英文紧凑相对日期(整值匹配才算,避免与普通数字混淆):"15 d"、"3h"、"2 mo"
    var compact = text.match(COMPACT_REL_RE);
    if (compact) {
      var compactAmount = Number(compact[1]);
      var compactUnit = compact[2].toLowerCase();
      var compactDays = null;
      if (/^(?:d|days?)$/.test(compactUnit)) compactDays = compactAmount;
      else if (/^(?:h|hrs?|hours?)$/.test(compactUnit)) compactDays = compactAmount / 24;
      else if (/^(?:min|mins|minutes?)$/.test(compactUnit)) compactDays = compactAmount / 1440;
      else if (/^(?:w|wks?|weeks?)$/.test(compactUnit)) compactDays = compactAmount * 7;
      else if (/^(?:mo|mos|months?)$/.test(compactUnit)) compactDays = compactAmount * 30;
      else if (/^(?:y|yrs?|years?)$/.test(compactUnit)) compactDays = compactAmount * 365;
      if (compactDays != null && isFinite(compactDays)) {
        return new Date(current - compactDays * 86400000).toISOString();
      }
    }

    var abs = DATE_TIME_RE.test(text) ? null : text.match(ABS_DATE_RE);
    if (abs) {
      var cleaned = abs[0].replace(/[年月]/g, "-").replace(/日/g, "").replace(/\s+/g, " ");
      // 只有日期没有时间的值按"本地的那一天"读;new Date("2024-03-05") 会当成 UTC,
      // 在中国/美国时区会差一天
      var ymd = cleaned.match(/^(\d{4})[-/.]\s?(\d{1,2})[-/.]\s?(\d{1,2})$/);
      var parsed = ymd ? new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])) : new Date(cleaned);
      if (!isNaN(parsed.getTime())) return parsed.toISOString();
    }

    // ISO / RFC 字符串(常见于 datetime 属性)
    if (/\d{4}-\d{2}-\d{2}/.test(text) || /\d{9,13}/.test(text)) {
      var direct = new Date(/^\d{9,13}$/.test(text) ? Number(text.length === 10 ? text * 1000 : text) : text);
      if (!isNaN(direct.getTime()) && direct.getFullYear() > 1990 && direct.getFullYear() < 2100) {
        return direct.toISOString();
      }
    }
    return null;
  }

  function looksLikeDuration(text) {
    return DURATION_RE.test(" " + normalizeText(text) + " ");
  }

  function looksLikeDate(text) {
    var t = normalizeText(text);
    // \b 对 "2026-01-15T…" 的 ISO 形态失效,显式补 ISO 判定
    return ABS_DATE_RE.test(t) || /\d{4}-\d{2}-\d{2}/.test(t) || REL_DATE_RE.test(t) || JUST_NOW_RE.test(t) || COMPACT_REL_RE.test(t);
  }

  function looksLikeNumber(text) {
    var t = stripDateAndDuration(normalizeText(text));
    return NUMBER_RE.test(t);
  }

  function stripDateAndDuration(text) {
    return text
      .replace(new RegExp(ABS_DATE_RE.source, "gi"), " ")
      .replace(new RegExp(REL_DATE_RE.source, "gi"), " ")
      .replace(/\d{1,3}:\d{2}(?::\d{2})?/g, " ");
  }

  function parseByType(text, type, now) {
    if (type === "duration") return parseDurationSeconds(text);
    if (type === "date") return parseDateIso(text, now);
    if (type === "number") return parseNumber(stripDateAndDuration(normalizeText(text)));
    return null;
  }

  /* ---------------------------------------------------------------- *
   * 词表:只负责 "猜名字 / 预勾选",不负责定位
   * ---------------------------------------------------------------- */

  var CANONICAL_VOCAB = [
    { id: "views", zh: "浏览量", en: "Views", re: /^(?:views?|plays?|watch(?:es|ed)?|reads?|播放|观看|觀看|浏览|瀏覽|阅读|閱讀|阅览|閱覽|人气|人氣)$|次(?:观看|觀看|浏览|瀏覽|播放)/i },
    { id: "likes", zh: "点赞数", en: "Likes", re: /^(?:likes?|upvotes?|appreciations?|thumbs?\s*up|赞|讚|点赞|點贊|點讚|好评|好評)$/i },
    { id: "dislikes", zh: "点踩数", en: "Dislikes", re: /^(?:dislikes?|downvotes?|thumbs?\s*down|点踩|點踩|倒赞|倒讚|差评|差評)$/i },
    { id: "favorites", zh: "收藏数", en: "Favorites", re: /^(?:favou?rites?|favs?|bookmarks?|collects?|stars?|收藏|喜欢|喜歡)$/i },
    { id: "comments", zh: "评论数", en: "Comments", re: /^(?:comments?|replies|reply|讨论|討論|留言|评论|評論|回复|回覆)$|[则則条條]留言|[则則条條]评论/i },
    { id: "score", zh: "评分", en: "Rating", re: /^(?:score|rating|rate|points?|积分|積分|评分|評分|分)$|^out of\b.*\b(?:stars?|rating)\b/i },
    { id: "heat", zh: "热度", en: "Popularity", re: /^(?:heat|hot|popularity|trending|热度|熱度|热门|熱門)$/i },
    { id: "downloads", zh: "下载量", en: "Downloads", re: /^(?:downloads?|dls?|下载|下載|下载量|下載量)$/i },
    { id: "endorsements", zh: "认可", en: "Endorsements", re: /^(?:endorsements?)$/i },
    { id: "fileSize", zh: "文件大小", en: "File size", re: /^(?:file\s*size|filesize|size|大小|体积|體積)$/i },
    { id: "price", zh: "价格", en: "Price", re: /^(?:price|cost|价格|價格|售价|售價)$/i },
    { id: "parameters", zh: "参数量", en: "Parameters", re: /^(?:param(?:eter)?s?|(?:number of )?parameters(?: in the model)?|model size|参数量|參數量|参数|參數)$/i },
    { id: "durationSeconds", zh: "时长", en: "Duration", re: /^(?:duration|length|runtime|时长|時長|片长|片長)$/i },
    { id: "makes", zh: "制作数", en: "Makes", re: /^(?:makes?|制作|做过|做過)$/i },
    { id: "remixes", zh: "改编数", en: "Remixes", re: /^(?:remix(?:es)?|改编|改編)$/i },
    { id: "shares", zh: "分享数", en: "Shares", re: /^(?:shares?|reposts?|retweets?|分享|转发|轉發)$/i },
    { id: "followers", zh: "粉丝数", en: "Followers", re: /^(?:followers?|subscribers?|fans|粉丝|粉絲|关注|關注|订阅|訂閱)$/i },
    { id: "reviews", zh: "评价数", en: "Reviews", re: /^(?:reviews?|评价|評價|点评|點評)$/i },
    { id: "sales", zh: "销量", en: "Sales", re: /^(?:sales|sold|orders?|销量|銷量|已售|成交)$/i },
    { id: "danmaku", zh: "弹幕", en: "Danmaku", re: /^(?:danmaku|弹幕|彈幕)$/i },
    { id: "coins", zh: "投币", en: "Coins", re: /^(?:coins?|投币|投幣)$/i },
    { id: "forks", zh: "分叉数", en: "Forks", re: /^(?:forks?)$/i },
    { id: "answers", zh: "回答数", en: "Answers", re: /^(?:answers?|回答)$/i },
    { id: "votes", zh: "票数", en: "Votes", re: /^(?:votes?|投票|票数|票數)$/i },
    { id: "members", zh: "成员数", en: "Members", re: /^(?:members?|成员|成員)$/i },
    { id: "uploadDate", zh: "日期", en: "Date", re: /^(?:date|added|published|posted|updated|uploaded?|upload\s*date|时间|時間|日期|添加时间|添加時間|上传时间|上傳時間|发布时间|發佈時間|更新时间|更新時間)$/i }
  ];

  function matchCanonical(label) {
    var text = normalizeText(label).replace(/[:：]+$/, "");
    if (!text) return null;
    for (var i = 0; i < CANONICAL_VOCAB.length; i += 1) {
      if (CANONICAL_VOCAB[i].re.test(text)) return CANONICAL_VOCAB[i];
    }
    // "£"、"US$"、"List: $"、"From $":数字前后的货币符号 = 价格
    if (CURRENCY_RE.test(text) && text.length <= 30) return vocabById("price");
    return null;
  }

  var CURRENCY_RE = /[$£€¥￥₩₹₽₺₫฿₱₪]|\b(?:usd|eur|gbp|rmb|cny|jpy|zł|kr)\b|元/i;

  function vocabById(id) {
    for (var i = 0; i < CANONICAL_VOCAB.length; i += 1) {
      if (CANONICAL_VOCAB[i].id === id) return CANONICAL_VOCAB[i];
    }
    return null;
  }

  var ICON_HINTS = [
    // dislikes 必须在 likes 之前:"dislike.png" 也含 "like"
    { id: "dislikes", re: /thumbs?-down|dislike|downvote|点踩|點踩/i },
    { id: "views", re: /eye|view|visibility|watch|play-circle|播放|观看|觀看|浏览|瀏覽/i },
    { id: "likes", re: /thumbs?-up|like(?!ly)|upvote|appreciat|heart-up|点赞|點讚/i },
    { id: "favorites", re: /heart|favou?rite|bookmark|star(?!t)|collect|收藏/i },
    { id: "comments", re: /comment|message|chat|speech|reply|留言|评论|評論/i },
    { id: "downloads", re: /download|下载|下載/i },
    { id: "fileSize", re: /file-?size|filesize|文件大小/i },
    { id: "endorsements", re: /endorse/i },
    { id: "durationSeconds", re: /clock|duration|time-circle|时长|時長/i },
    { id: "makes", re: /\bmakes?\b|做过|做過/i },
    { id: "remixes", re: /remix/i },
    { id: "shares", re: /share|repost|retweet|转发|轉發|分享/i },
    { id: "followers", re: /follower|subscriber|粉丝|粉絲|订阅|訂閱/i },
    { id: "reviews", re: /review|评价|評價/i },
    { id: "sales", re: /\bsales\b|\bsold\b|销量|銷量|已售/i },
    { id: "danmaku", re: /danmaku|弹幕|彈幕/i },
    { id: "coins", re: /\bcoins?\b|投币|投幣/i },
    { id: "forks", re: /\bforks?\b/i },
    { id: "answers", re: /answer|回答/i },
    { id: "votes", re: /\bvotes?\b|投票/i },
    { id: "members", re: /\bmembers?\b|成员|成員/i },
    { id: "uploadDate", re: /calendar|date|added|posted|publish|upload|时间|時間|日期|添加|上传|上傳|发布|發佈/i }
  ];

  // 意思相近、网站常混用的一组(心形图标既当"点赞"也当"收藏"):同时出现不算冲突,按先认出的算
  var SAME_MEANING = [["likes", "favorites"]];
  function sameMeaning(a, b) {
    for (var i = 0; i < SAME_MEANING.length; i += 1) {
      if (SAME_MEANING[i].indexOf(a) >= 0 && SAME_MEANING[i].indexOf(b) >= 0) return true;
    }
    return false;
  }

  // 线索里出现两个以上不同意思的词(如 "stats download likes")→ 不猜,返回 null;
  // 起错名字比没有名字更糟(用户会按错的东西排序)。没名字时面板改用卡片里的图标。
  function matchIconHint(context) {
    var text = normalizeText(context).toLowerCase();
    if (!text) return null;
    var found = null;
    for (var i = 0; i < ICON_HINTS.length; i += 1) {
      if (!ICON_HINTS[i].re.test(text)) continue;
      if (ICON_HINTS[i].id === "dislikes" && found === null) {
        found = "dislikes";
        text = text.replace(/thumbs?-down|dislike|downvote/g, " "); // "dislike" 里的 like 不算第二个意思
        continue;
      }
      if (found && found !== ICON_HINTS[i].id && !sameMeaning(found, ICON_HINTS[i].id)) return null;
      found = found || ICON_HINTS[i].id;
    }
    if (!found) return null;
    for (var j = 0; j < CANONICAL_VOCAB.length; j += 1) {
      if (CANONICAL_VOCAB[j].id === found) return CANONICAL_VOCAB[j];
    }
    return null;
  }

  /* ---------------------------------------------------------------- *
   * 结构签名与 slot 路径
   * ---------------------------------------------------------------- */

  var CLASS_TOKEN_SKIP_RE = /^(?:js-|is-|has-|was-|active|hover|focus|selected|open|closed|show|hide|hidden|visible|loaded|loading|lazy|first|last|odd|even|left|right|top|bottom|clearfix|fade|in|out|on|off)$|\d{3,}|^-|^_$/i;

  function classTokensOf(element) {
    var raw = element.getAttribute ? (element.getAttribute("class") || "") : "";
    var tokens = normalizeText(raw).split(" ");
    var rating = RATING_IDENTITY_RE.test(raw);
    var kept = [];
    for (var i = 0; i < tokens.length && kept.length < 3; i += 1) {
      var token = tokens[i];
      if (!token || token.length > 28) continue;
      // 评分元素 class 里的分数("star-rating Three"、"rating-4")每张卡不同,不能算进位置
      if (rating && (NUMBER_WORDS[token.toLowerCase()] != null || RATING_TOKEN_RE.test(token))) continue;
      if (CLASS_TOKEN_SKIP_RE.test(token)) continue;
      if (/\d/.test(token) && /[a-f0-9]{5,}/i.test(token)) continue; // css-module hash
      kept.push(token.toLowerCase());
    }
    kept.sort();
    return kept;
  }

  function sigOf(element) {
    var tag = (element.tagName || "").toLowerCase();
    var tokens = classTokensOf(element);
    return tokens.length ? tag + "." + tokens.join(".") : tag;
  }

  function indexAmongSameSig(element) {
    var sig = sigOf(element);
    var index = 0;
    var node = element;
    while ((node = node.previousElementSibling)) {
      if (sigOf(node) === sig) index += 1;
    }
    return index;
  }

  function slotPathFor(element, cardRoot) {
    var segments = [];
    var node = element;
    while (node && node !== cardRoot) {
      segments.unshift(sigOf(node) + ":" + indexAmongSameSig(node));
      node = node.parentElement;
    }
    if (node !== cardRoot) return null; // element 不在 card 内
    return segments.join(">");
  }

  function resolvePath(cardRoot, path) {
    if (!path) return cardRoot;
    var segments = path.split(">");
    var node = cardRoot;
    for (var i = 0; i < segments.length; i += 1) {
      var parts = segments[i].split(":");
      var sig = parts.slice(0, -1).join(":");
      var wanted = Number(parts[parts.length - 1]) || 0;
      var found = null;
      var seen = 0;
      var child = node.firstElementChild;
      while (child) {
        if (sigOf(child) === sig) {
          if (seen === wanted) { found = child; break; }
          seen += 1;
        }
        child = child.nextElementSibling;
      }
      if (!found) return null;
      node = found;
    }
    return node;
  }

  /* ---------------------------------------------------------------- *
   * Card 识别:候选 → 评分 → 去重叠 → 结构聚类取主簇
   * ---------------------------------------------------------------- */

  var BLOCKED_IDENTITY_RE = /\b(nav|navbar|menu|header|footer|sidebar|side-bar|widget|pagination|pager|breadcrumb|popup|modal|overlay|cookie|login|signup|register|search-form|filter|dropdown|language|advert|ads?|banner|notice|toast|tooltip|suggest)\b/i;
  var BLOCKED_ANCESTOR_SELECTOR = "nav,header,footer,aside,[role='navigation'],[role='banner'],[role='contentinfo']";

  function findCards(doc) {
    var seeds = collectSeeds(doc);
    var scored = [];
    for (var i = 0; i < seeds.length; i += 1) {
      var candidate = scoreCandidate(seeds[i]);
      if (candidate) scored.push(candidate);
    }
    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.textLength - b.textLength;
    });

    var selected = [];
    for (var s = 0; s < scored.length && selected.length < MAX_CARDS * 2; s += 1) {
      insertNonOverlapping(selected, scored[s]);
    }

    var clusters = clusterBySignature(selected);
    var main = pickMainCluster(clusters);
    if (!main) return { roots: [], signature: "", clusterSizes: summarizeClusters(clusters) };

    var roots = main.candidates.map(function (c) { return c.element; });
    roots.sort(compareDomOrder);
    return {
      roots: roots.slice(0, MAX_CARDS),
      signature: main.signature,
      clusterSizes: summarizeClusters(clusters)
    };
  }

  function collectSeeds(doc) {
    var seeds = [];
    var seen = typeof Set === "undefined" ? null : new Set();
    function add(element) {
      if (!element || element.nodeType !== 1) return;
      if (seen) {
        if (seen.has(element)) return;
        seen.add(element);
      }
      if (seeds.length < MAX_SEEDS) seeds.push(element);
    }

    var structural = doc.querySelectorAll("article,li,[class*='card' i],[class*='item' i],[class*='post' i],[class*='thumb' i],[class*='cell' i],[class*='tile' i],[class*='entry' i],[class*='mod-' i],[class*='video' i],[class*='result' i]");
    for (var i = 0; i < structural.length; i += 1) add(structural[i]);

    // 从图片/链接向上爬,兜住无语义 class 的网站
    var media = doc.querySelectorAll("img,picture,video");
    for (var m = 0; m < media.length; m += 1) {
      var node = media[m].parentElement;
      for (var depth = 0; node && depth < 6; depth += 1) {
        add(node);
        node = node.parentElement;
      }
    }
    // 图片包得很深(按钮、轮播里套了七八层)时,从链接往上也爬几层:
    // 整张卡片常是"一个盖住全卡的空链接 + 旁边的图片和文字"
    var anchors = doc.querySelectorAll("a[href]");
    for (var l = 0; l < anchors.length && seeds.length < MAX_SEEDS; l += 1) {
      var up = anchors[l].parentElement;
      for (var level = 0; up && level < 3; level += 1) {
        add(up);
        up = up.parentElement;
      }
    }
    return seeds;
  }

  function scoreCandidate(element) {
    var tag = (element.tagName || "").toLowerCase();
    if (/^(html|body|main|section|table|thead|tbody|form|nav|header|footer|aside|script|style|template|svg)$/.test(tag)) return null;
    var identity = normalizeText((element.id || "") + " " + (element.getAttribute("class") || "") + " " + (element.getAttribute("role") || ""));
    if (BLOCKED_IDENTITY_RE.test(identity)) return null;
    if (element.closest && element.closest(BLOCKED_ANCESTOR_SELECTOR)) return null;

    var text = normalizeText(element.textContent);
    if (text.length < 6 || text.length > 3200) return null;

    var links = element.querySelectorAll("a[href]");
    var mediaCount = element.querySelectorAll("img,picture,video").length;
    if (links.length > 30 || mediaCount > 12) return null;
    if (!links.length && !mediaCount) return null;

    var hasTitleish = Boolean(element.querySelector("h1,h2,h3,h4,h5,[class*='title' i],[class*='name' i]"));
    var numberish = countNumberish(text);

    var score = 0;
    if (mediaCount) score += 3;
    if (links.length) score += 2;
    if (hasTitleish) score += 3;
    if (numberish) score += Math.min(6, numberish * 2);
    if (looksLikeDuration(text) || looksLikeDate(text)) score += 2;
    if (/^(article|li)$/.test(tag) || /card|item|post|thumb|cell|tile|entry/i.test(identity)) score += 2;
    if (!hasTitleish && !numberish) score -= 4;
    if (score < 5) return null;

    return { element: element, score: score, textLength: text.length };
  }

  function countNumberish(text) {
    var stripped = stripDateAndDuration(text);
    var matches = stripped.match(new RegExp(NUM_TOKEN_SRC + "\\s*(?:万|萬|亿|億|k|m|b|kb|mb|gb)?", "gi"));
    return matches ? Math.min(matches.length, 8) : 0;
  }

  function insertNonOverlapping(selected, candidate) {
    for (var i = 0; i < selected.length; i += 1) {
      var chosen = selected[i];
      var overlaps = chosen.element === candidate.element ||
        (chosen.element.contains && chosen.element.contains(candidate.element)) ||
        (candidate.element.contains && candidate.element.contains(chosen.element));
      if (overlaps) {
        if (candidate.score > chosen.score) selected[i] = candidate;
        return;
      }
    }
    selected.push(candidate);
  }

  function clusterBySignature(candidates) {
    var map = {};
    for (var i = 0; i < candidates.length; i += 1) {
      var signature = sigOf(candidates[i].element);
      if (!map[signature]) map[signature] = { signature: signature, candidates: [] };
      map[signature].candidates.push(candidates[i]);
    }
    var clusters = [];
    for (var key in map) clusters.push(map[key]);
    clusters.sort(function (a, b) { return b.candidates.length - a.candidates.length; });
    return clusters;
  }

  function pickMainCluster(clusters) {
    for (var i = 0; i < clusters.length; i += 1) {
      if (clusters[i].candidates.length >= MIN_CLUSTER_SIZE) return clusters[i];
    }
    return null;
  }

  function summarizeClusters(clusters) {
    return clusters.slice(0, 5).map(function (cluster) {
      return { signature: cluster.signature, count: cluster.candidates.length };
    });
  }

  function compareDomOrder(left, right) {
    if (!left.compareDocumentPosition) return 0;
    var position = left.compareDocumentPosition(right);
    if (position & 4) return -1; // FOLLOWING
    if (position & 2) return 1;  // PRECEDING
    return 0;
  }

  /* ---------------------------------------------------------------- *
   * Slot 收集:每张卡片 → { path → occurrence }
   * ---------------------------------------------------------------- */

  var VALUE_ATTRS = ["aria-label", "title", "alt", "datetime", "content"];

  function collectCardSlots(cardRoot) {
    var slots = {}; // slotKey → occurrence
    var stack = [{ node: cardRoot, path: "" }];
    var walked = 0;

    while (stack.length && walked < MAX_ELEMENTS_PER_CARD) {
      var frame = stack.pop();
      var element = frame.node;
      walked += 1;

      // 文本节点级收集(含 cardRoot 自身的直属文本)。
      // 有的站点把 "热度: 382 收藏: 4" 这类指标作为 <br> 分隔的纯文本
      // 直接挂在卡片容器下,元素级收集会整块漏掉。
      collectTextNodeSlots(element, frame.path, slots);
      if (element !== cardRoot) {
        collectAttrSlots(element, frame.path, slots);
      }

      var child = element.lastElementChild;
      var childIndexes = {};
      var ordered = [];
      var forward = element.firstElementChild;
      while (forward) {
        var sig = sigOf(forward);
        var idx = childIndexes[sig] || 0;
        childIndexes[sig] = idx + 1;
        ordered.push({ node: forward, seg: sig + ":" + idx });
        forward = forward.nextElementSibling;
      }
      for (var i = ordered.length - 1; i >= 0; i -= 1) {
        var tag = (ordered[i].node.tagName || "").toLowerCase();
        if (/^(script|style|template|svg|noscript|iframe)$/.test(tag)) {
          if (tag === "svg") collectAttrSlots(ordered[i].node, joinPath(frame.path, ordered[i].seg), slots);
          continue;
        }
        stack.push({ node: ordered[i].node, path: joinPath(frame.path, ordered[i].seg) });
      }
      void child;
    }
    return slots;
  }

  function joinPath(parent, segment) {
    return parent ? parent + ">" + segment : segment;
  }

  function collectTextNodeSlots(element, path, slots) {
    var textIndex = 0;
    var node = element.firstChild;
    while (node) {
      if (node.nodeType === 3) {
        var text = normalizeText(node.textContent);
        if (text) {
          if (text.length <= 200) {
            slots[path + "~" + textIndex] = makeTextNodeOccurrence(element, node, text, textIndex);
          }
          textIndex += 1;
        }
      }
      node = node.nextSibling;
    }
  }

  function makeTextNodeOccurrence(element, textNode, text, textIndex) {
    return {
      text: text,
      attr: "",
      textIndex: textIndex,
      titleLike: isTitleLike(element),
      context: gatherTextNodeContext(element, textNode)
    };
  }

  // 文本节点的语义上下文:父元素属性 + 紧邻的元素兄弟(尤其 <img src="like.png"> 这类图标)。
  // 前置图标与后置图标分开存:"👍 182 👎 15" 里 182 的归属必须以前面的图标为准。
  // 数字独居在自己的小元素里时(如有的站点用 <span data-e2eid="mod-tile-endorsements">4.6k</span>),
  // 文本节点没有兄弟 → 名字线索在父元素的兄弟上(svg 图标、sr-only 隐藏文字),向上爬一层去找。
  function gatherTextNodeContext(element, textNode) {
    var parentParts = [];
    if (element.getAttribute) {
      parentParts.push(
        element.getAttribute("class") || "",
        element.getAttribute("aria-label") || "",
        element.getAttribute("title") || "",
        element.id || ""
      );
      pushDataAttrHints(element, parentParts);
    }
    var prevParts = [];
    var nextParts = [];
    var prevSiblingText = "";
    var iconBefore = null; // 数字旁边的图标元素(只记指针,需要时才复制,见 iconForEntries)
    var iconAfter = null;
    for (var dir = 0; dir < 2; dir += 1) {
      var sibling = dir === 0 ? textNode.previousSibling : textNode.nextSibling;
      var steps = 0;
      var foundElementSibling = false;
      while (sibling && steps < 3) {
        if (sibling.nodeType === 1) {
          foundElementSibling = true;
          var bucket = dir === 0 ? prevParts : nextParts;
          pushElementHints(sibling, bucket);
          if (dir === 0) iconBefore = iconBefore || iconElementOf(sibling);
          else iconAfter = iconAfter || iconElementOf(sibling);
          if (dir === 0 && !prevSiblingText) {
            prevSiblingText = normalizeText(sibling.textContent).slice(0, 40);
          }
          break; // 只看最近的一个元素兄弟
        }
        sibling = dir === 0 ? sibling.previousSibling : sibling.nextSibling;
        steps += 1;
      }
      // 文本节点独居 → 向上一层,看父元素的相邻兄弟。
      // 邻居本身是数字/日期/时长(另一个指标)时立即停,避免把别的指标的名字安到这个数字头上。
      if (!foundElementSibling) {
        var cousin = dir === 0 ? element.previousElementSibling : element.nextElementSibling;
        var hops = 0;
        while (cousin && hops < 2) {
          var cousinText = normalizeText(cousin.textContent);
          if (looksLikeNumber(cousinText) || looksLikeDate(cousinText) || looksLikeDuration(cousinText)) break;
          var cousinBucket = dir === 0 ? prevParts : nextParts;
          pushElementHints(cousin, cousinBucket);
          if (dir === 0) iconBefore = iconBefore || iconElementOf(cousin);
          else iconAfter = iconAfter || iconElementOf(cousin);
          if (dir === 0 && !prevSiblingText && cousinText) {
            prevSiblingText = cousinText.slice(0, 40);
          }
          cousin = dir === 0 ? cousin.previousElementSibling : cousin.nextElementSibling;
          hops += 1;
        }
      }
    }
    return {
      attrHints: normalizeText(parentParts.concat(prevParts).filter(Boolean).join(" ")).slice(0, 400),
      attrHintsNext: normalizeText(nextParts.filter(Boolean).join(" ")).slice(0, 200),
      prevSiblingText: prevSiblingText,
      iconEl: iconBefore || iconAfter
    };
  }

  function pushElementHints(node, bucket) {
    bucket.push(
      iconNameFromSrc(node.getAttribute && node.getAttribute("src")),
      (node.getAttribute && node.getAttribute("class")) || "",
      (node.getAttribute && node.getAttribute("alt")) || "",
      (node.getAttribute && node.getAttribute("aria-label")) || "",
      (node.getAttribute && node.getAttribute("title")) || ""
    );
    pushDataAttrHints(node, bucket);
  }

  // data-* 属性值常带语义(如 data-e2eid="mod-tile-endorsements");跳过资源类/URL/超长值
  function pushDataAttrHints(node, bucket) {
    var attrs = (node && node.attributes) || [];
    for (var i = 0; i < attrs.length && i < 20; i += 1) {
      var name = attrs[i].name;
      if (!/^data-/i.test(name)) continue;
      if (/^data-(src|srcset|href|url|lazy|thumb|poster|bg|image|id$|index)/i.test(name)) continue;
      var value = normalizeText(attrs[i].value);
      if (!value || value.length > 60) continue;
      if (/https?:|\//.test(value)) continue;
      bucket.push(value);
    }
  }

  function iconNameFromSrc(src) {
    var text = normalizeText(src);
    if (!text) return "";
    var match = text.match(/([a-z0-9_-]+)\.(?:png|svg|gif|jpe?g|webp)(?:$|\?)/i);
    return match ? match[1] : "";
  }

  /* ---------------------------------------------------------------- *
   * 卡片里的图标:没名字的数字用卡片里的图标来认(复制图标本身,不截图)
   * ---------------------------------------------------------------- */

  var ICON_MAX_PX = 40;
  var SVG_TAGS = /^(svg|g|path|circle|ellipse|rect|line|polyline|polygon)$/;
  var SVG_ATTRS = /^(viewbox|d|cx|cy|r|rx|ry|x|y|x1|y1|x2|y2|points|transform|fill-rule|clip-rule|stroke-width|stroke-linecap|stroke-linejoin|opacity|fill-opacity|stroke-opacity)$/;
  var ICON_MARKUP_MAX = 4000;

  // 数字旁边的元素是不是一个图标:<svg>、小图片、或空的 <i>/<span>(字体图标);
  // 外面包了一层没有文字的元素时往里找唯一的那个
  function iconElementOf(node) {
    if (!node || node.nodeType !== 1) return null;
    var tag = (node.tagName || "").toLowerCase();
    if (tag === "svg") {
      var box = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
      return box && (box.width > ICON_MAX_PX || box.height > ICON_MAX_PX) ? null : node;
    }
    if (tag === "img") return smallImage(node) ? node : null;
    if (normalizeText(node.textContent)) return null;
    if (!node.firstElementChild) return /^(i|span|em)$/.test(tag) ? node : null;
    var inner = node.querySelectorAll ? node.querySelectorAll("svg,img") : [];
    return inner.length === 1 ? iconElementOf(inner[0]) : null;
  }

  function smallImage(img) {
    var rect = img.getBoundingClientRect ? img.getBoundingClientRect() : null;
    if (rect && rect.width && rect.height) return rect.width <= ICON_MAX_PX && rect.height <= ICON_MAX_PX;
    var width = Number(img.getAttribute && img.getAttribute("width"));
    var height = Number(img.getAttribute && img.getAttribute("height"));
    if (width && height) return width <= ICON_MAX_PX && height <= ICON_MAX_PX;
    return /icon|\.svg(?:$|\?)/i.test((img.getAttribute && img.getAttribute("src")) || "");
  }

  // 把图标复制成可以安全存储、在面板和结果页里显示的数据:
  //   { kind: "svg", markup } 只留画图用的标签和属性,颜色统一跟随文字颜色;
  //   { kind: "img", src }    只留 http(s) 或图片 data: 地址;
  //   { kind: "glyph", text, font } 字体图标:只在原网站的页面上能显示(结果页用文字代替)。
  function serializeIcon(element) {
    if (!element) return null;
    var tag = (element.tagName || "").toLowerCase();
    if (tag === "svg") {
      var markup = svgMarkup(element, element.ownerDocument, 0);
      return markup && markup.length <= ICON_MARKUP_MAX && /<(path|circle|ellipse|rect|line|polyline|polygon)\b/.test(markup)
        ? { kind: "svg", markup: markup }
        : null;
    }
    if (tag === "img") {
      var src = element.currentSrc || element.src || element.getAttribute("src") || "";
      if (/^https?:\/\//i.test(src) || (/^data:image\/(png|gif|webp|svg\+xml)[;,]/i.test(src) && src.length <= ICON_MARKUP_MAX)) {
        return { kind: "img", src: src };
      }
      return null;
    }
    var view = element.ownerDocument && element.ownerDocument.defaultView;
    if (!view || !view.getComputedStyle) return null;
    var before = view.getComputedStyle(element, "::before");
    var content = before && before.content;
    var match = /^["'](.{1,2})["']$/.exec(content || "");
    if (!match) return null;
    var font = String(before.fontFamily || "").replace(/[^\w\s,\-"']/g, "").slice(0, 120);
    return { kind: "glyph", text: match[1], font: font };
  }

  function svgMarkup(element, doc, depth) {
    if (depth > 12) return "";
    var tag = (element.tagName || "").toLowerCase();
    if (tag === "use") return useMarkup(element, doc, depth);
    if (tag === "symbol") tag = "g";
    if (!SVG_TAGS.test(tag)) return "";
    var attrs = [];
    var list = element.attributes || [];
    for (var i = 0; i < list.length; i += 1) {
      var name = String(list[i].name).toLowerCase();
      var value = String(list[i].value);
      if (tag === "svg" && (name === "x" || name === "y")) continue;
      if (name === "fill" || name === "stroke") {
        attrs.push(name + '="' + (/^none$/i.test(value) ? "none" : "currentColor") + '"');
      } else if (SVG_ATTRS.test(name) && /^[\w\s.,#%()\-]*$/.test(value)) {
        attrs.push((name === "viewbox" ? "viewBox" : name) + '="' + value + '"');
      }
    }
    if (tag === "svg" && !/viewBox=/.test(attrs.join(" "))) {
      var w = Number(element.getAttribute("width"));
      var h = Number(element.getAttribute("height"));
      if (w && h) attrs.push('viewBox="0 0 ' + w + " " + h + '"');
    }
    var inner = "";
    var child = element.firstElementChild;
    while (child) {
      inner += svgMarkup(child, doc, depth + 1);
      child = child.nextElementSibling;
    }
    if (tag === "svg") return '<svg xmlns="http://www.w3.org/2000/svg"' + (attrs.length ? " " + attrs.join(" ") : "") + ">" + inner + "</svg>";
    return "<" + tag + (attrs.length ? " " + attrs.join(" ") : "") + ">" + inner + "</" + tag + ">";
  }

  // <use href="#icon-download"> 引用页面里的图标合集:把被引用的那个图形抄过来
  function useMarkup(element, doc, depth) {
    var ref = element.getAttribute("href") || element.getAttribute("xlink:href") || "";
    if (!/^#[\w\-:.]+$/.test(ref) || !doc || !doc.getElementById) return "";
    var target = doc.getElementById(ref.slice(1));
    if (!target) return "";
    var markup = svgMarkup(target, doc, depth + 1);
    var box = target.getAttribute && target.getAttribute("viewBox");
    return box && (target.tagName || "").toLowerCase() === "symbol"
      ? '<svg viewBox="' + box.replace(/[^\d\s.,\-]/g, "") + '">' + markup + "</svg>"
      : markup;
  }

  function iconKey(icon) {
    if (!icon) return "";
    return icon.kind + ":" + (icon.markup || icon.src || icon.text + "|" + icon.font);
  }

  // 一列数字共用哪个图标:看前几张卡片,六成以上是同一个图标才算
  function iconForEntries(entries) {
    var counts = {};
    var icons = {};
    var sampled = 0;
    for (var i = 0; i < entries.length && sampled < 8; i += 1) {
      var context = entries[i].occurrence.context || {};
      sampled += 1;
      var icon = null;
      try { icon = serializeIcon(context.iconEl); } catch (e) { icon = null; }
      var key = iconKey(icon);
      if (!key) continue;
      counts[key] = (counts[key] || 0) + 1;
      icons[key] = icon;
    }
    for (var k in counts) {
      if (counts[k] / sampled >= 0.6) return icons[k];
    }
    return null;
  }

  function nthTextOf(element, textIndex) {
    var node = nthTextNodeOf(element, textIndex);
    return node ? normalizeText(node.textContent) : "";
  }

  function nthTextNodeOf(element, textIndex) {
    var index = 0;
    var node = element.firstChild;
    while (node) {
      if (node.nodeType === 3) {
        var text = normalizeText(node.textContent);
        if (text) {
          if (index === textIndex) return node;
          index += 1;
        }
      }
      node = node.nextSibling;
    }
    return null;
  }

  function ownTextOf(element) {
    var text = "";
    var node = element.firstChild;
    while (node) {
      if (node.nodeType === 3) text += node.textContent + " ";
      node = node.nextSibling;
    }
    return normalizeText(text);
  }

  function collectAttrSlots(element, path, slots) {
    for (var i = 0; i < VALUE_ATTRS.length; i += 1) {
      readAttrSlot(element, path, VALUE_ATTRS[i], slots);
    }
    var rating = ratingFromElement(element);
    if (rating != null) slots[path + "@" + RATING_ATTR] = makeOccurrence(element, String(rating), RATING_ATTR);
    var attrs = element.attributes || [];
    for (var a = 0; a < attrs.length; a += 1) {
      var name = attrs[a].name;
      if (/^data-/i.test(name) && !/^data-(src|href|url|id|index|testid|lazy)/i.test(name)) {
        readAttrSlot(element, path, name, slots);
      }
    }
  }

  function readAttrSlot(element, path, attr, slots) {
    var raw = element.getAttribute ? element.getAttribute(attr) : null;
    var value = normalizeText(raw);
    if (!value || value.length > 160) return;
    if (!looksLikeNumber(value) && !looksLikeDate(value) && !looksLikeDuration(value)) return;
    var key = path + "@" + attr.toLowerCase();
    slots[key] = makeOccurrence(element, value, attr);
  }

  /* 星级只画在图标里、页面上没有数字时,从代码里读出分数。只认代码明确说"这是评分"的元素
   * (class 里有 star / rating / rate / score),读三种常见写法:
   *   1) class 里的词或数字:"star-rating Three"、"rating-4"、"stars-4-5"
   *   2) 填充条宽度:style="width: 80%" → 5 分里的 4 分
   *   3) 数实心星星:4 个 full + 1 个 empty → 4 */
  var RATING_ATTR = "rating";
  var RATING_IDENTITY_RE = /(?:^|[\s_-])(?:stars?|ratings?|rate|rated|score)(?:$|[\s_-])|star-?rating|rating-?stars?/i;
  var RATING_TOKEN_RE = /^(?:stars?|rating|rated|rate|score)[-_]?(\d{1,2})(?:[-_.](\d))?$/i;
  var NUMBER_WORDS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

  function ratingFromElement(element) {
    var cls = element.getAttribute ? element.getAttribute("class") || "" : "";
    if (!cls || !RATING_IDENTITY_RE.test(cls)) return null;
    // 自己(或里面)已经写着数字的,交给普通的文字读法
    if (/\d/.test(normalizeText(element.textContent))) return null;
    var tokens = cls.split(/\s+/);
    for (var i = 0; i < tokens.length; i += 1) {
      var word = NUMBER_WORDS[tokens[i].toLowerCase()];
      if (word != null) return word;
      var coded = RATING_TOKEN_RE.exec(tokens[i]);
      if (coded) {
        var value = coded[2] != null ? Number(coded[1] + "." + coded[2]) : Number(coded[1]);
        if (!coded[2] && value > 10 && value <= 50) value = value / 10; // stars-45 = 4.5
        if (value >= 0 && value <= 10) return value;
      }
    }
    var icons = element.children ? Array.prototype.slice.call(element.children) : [];
    var width = widthPercentOf(element);
    for (var w = 0; width == null && w < icons.length; w += 1) width = widthPercentOf(icons[w]);
    if (width != null) return Math.round(width / 100 * (icons.length >= 3 && icons.length <= 10 ? icons.length : 5) * 10) / 10;
    if (icons.length >= 3 && icons.length <= 10) {
      var filled = 0;
      var told = false;
      for (var k = 0; k < icons.length; k += 1) {
        var iconClass = (icons[k].getAttribute && icons[k].getAttribute("class")) || "";
        if (/empty|outline|\boff\b|inactive|-o\b/i.test(iconClass)) { told = true; continue; }
        if (/half/i.test(iconClass)) { filled += 0.5; told = true; continue; }
        if (/full|fill|\bon\b|active|checked|selected/i.test(iconClass)) { filled += 1; told = true; }
      }
      if (told) return filled;
    }
    return null;
  }

  function widthPercentOf(element) {
    var style = element.getAttribute ? element.getAttribute("style") || "" : "";
    var match = /(?:^|;)\s*width\s*:\s*(\d{1,3}(?:\.\d+)?)%/i.exec(style);
    if (!match) return null;
    var value = Number(match[1]);
    return value >= 0 && value <= 100 ? value : null;
  }

  function makeOccurrence(element, text, attr) {
    return {
      text: text,
      attr: attr || "",
      titleLike: isTitleLike(element),
      context: gatherContext(element)
    };
  }

  // 标题/名称元素内的数字(如 "Part 2")不是指标,防止随机句子混入排序
  function isTitleLike(element) {
    var node = element;
    for (var depth = 0; node && depth < 3; depth += 1, node = node.parentElement) {
      var tag = (node.tagName || "").toLowerCase();
      if (/^h[1-6]$/.test(tag)) return true;
      var identity = ((node.getAttribute && node.getAttribute("class")) || "") + " " + (node.id || "");
      if (/title|headline|heading|\bname\b/i.test(identity)) return true;
    }
    return false;
  }

  function gatherContext(element) {
    var parts = [];
    var nodes = [element, element.previousElementSibling, element.parentElement];
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      if (!node || !node.getAttribute) continue;
      parts.push(
        node.getAttribute("class") || "",
        node.getAttribute("aria-label") || "",
        node.getAttribute("title") || "",
        node.getAttribute("alt") || "",
        node.getAttribute("data-icon") || "",
        node.getAttribute("name") || ""
      );
    }
    var icon = element.querySelector && element.querySelector("svg,i,use,[class*='icon' i],img[src*='icon' i]");
    if (!icon && element.previousElementSibling && element.previousElementSibling.querySelector) {
      icon = element.previousElementSibling.matches && element.previousElementSibling.matches("svg,i,use,[class*='icon' i]")
        ? element.previousElementSibling
        : element.previousElementSibling.querySelector("svg,i,use,[class*='icon' i]");
    }
    if (icon && icon.getAttribute) {
      parts.push(icon.getAttribute("class") || "", icon.getAttribute("aria-label") || "", icon.getAttribute("href") || "", icon.getAttribute("xlink:href") || "", icon.getAttribute("data-icon") || "");
    }
    var prevText = element.previousElementSibling ? normalizeText(element.previousElementSibling.textContent).slice(0, 40) : "";
    return {
      attrHints: normalizeText(parts.join(" ")).slice(0, 400),
      prevSiblingText: prevText
    };
  }

  /* ---------------------------------------------------------------- *
   * 对齐:slot 分组 → 类型判定 → label diff → 候选字段
   * ---------------------------------------------------------------- */

  function alignSlots(cardSlotList) {
    var total = cardSlotList.length;
    var groups = {}; // path → [{cardIndex, occurrence}]
    for (var c = 0; c < total; c += 1) {
      for (var path in cardSlotList[c]) {
        if (!groups[path]) groups[path] = [];
        groups[path].push({ cardIndex: c, occurrence: cardSlotList[c][path] });
      }
    }

    expandCompositeGroups(groups);

    var candidates = [];
    var counter = { n: 0 };
    for (var groupPath in groups) {
      var candidate = buildCandidate(groupPath, groups[groupPath], total, counter);
      if (candidate) candidates.push(candidate);
    }

    candidates = mergeSameValues(candidates);
    dedupeAttrEcho(candidates);
    dropDuplicateGuessedNames(candidates);
    hideNonMeasures(candidates);
    candidates.forEach(function (candidate) { delete candidate._values; delete candidate._texts; });
    candidates.sort(compareCandidates);
    return candidates;
  }

  // 同一个数字在卡片里写了好几遍(看得见的 "763B" + 隐藏提示 "Number of parameters: 763B" +
  // 代码里的 datetime)→ 菜单里只留一个:留看得见的那个,名字缺了就借另一个的名字。
  // 只在每张卡的值都一样、并且至少有 3 种不同的值时才合并,避免把碰巧都是 0 的两个指标并掉。
  function mergeSameValues(candidates) {
    var kept = [];
    for (var i = 0; i < candidates.length; i += 1) {
      var candidate = candidates[i];
      if (candidate.excluded || !candidate._values) { kept.push(candidate); continue; }
      var twin = null;
      for (var k = 0; k < kept.length && !twin; k += 1) {
        if (sameValues(kept[k], candidate)) twin = kept[k];
      }
      if (!twin) { kept.push(candidate); continue; }
      var winner = mergeRank(candidate) > mergeRank(twin) ? candidate : twin;
      var loser = winner === candidate ? twin : candidate;
      if ((!winner.canonicalId && loser.canonicalId) || (!winner.label && loser.label)) {
        winner.label = loser.label;
        winner.siteLabel = loser.siteLabel;
        winner.canonicalId = loser.canonicalId;
        winner.source = loser.source;
        winner.preChecked = winner.preChecked || loser.preChecked;
        winner.suspect = winner.suspect && loser.suspect;
        if (winner.canonicalId && winner.source !== "icon") winner.icon = null;
      }
      if (winner === candidate) kept[kept.indexOf(twin)] = candidate;
    }
    return kept;
  }

  /* 不值得排的数字挪到"这些不能排"(excluded),不删:用户手动点选时还能拿回来。四条规则(James 2026-10-27 确认):
   *   hidden   卡片上看不到、只在代码里,而且叫不出名字(asin、uid、test key)
   *   code     长得像编号:8 位以上连着的数字,或数字夹着字母和横线(1793082377961-qc9pvbf)
   *   position 像序号:每张卡就是 1、2、3…;或者几乎每张卡都一样(没认出名字时)
   *   fragment 是别的数字的一部分($9.42 里拆出的 9、42),或写在句子/标题里(Book 14 of 15: Dog Man) */
  function hideNonMeasures(candidates) {
    candidates.forEach(function (candidate) {
      if (candidate.excluded || !candidate._values || candidate.type !== "number") return;
      var why = nonMeasureReason(candidate, candidates);
      if (!why) return;
      candidate.excluded = true;
      candidate.excludedWhy = why;
      candidate.preChecked = false;
    });
  }

  function nonMeasureReason(candidate, all) {
    var named = Boolean(candidate.canonicalId);
    var texts = (candidate._texts || []).map(normalizeText);
    if (!texts.length) return "";
    var share = function (test) { return texts.filter(test).length / texts.length; };
    if (candidate.kind === "attr" && candidate.attr !== RATING_ATTR && !named) return "hidden";
    if (share(function (t) { return /\d{8,}/.test(t.replace(/[\s,.'’]/g, "") === t ? t : "") || /^[^\s]*\d[^\s]*[-_][^\s]*[a-z\u4e00-\u9fa5][^\s]*$/i.test(t); }) >= 0.6) return "code";
    if (!named && positionLike(candidate)) return "position";
    if (fragmentOf(candidate, all)) return "fragment";
    if (!named && (share(function (t) { return countNumbers(t) >= 2; }) >= 0.6 || varyingWords(texts))) return "fragment";
    return "";
  }

  function positionLike(candidate) {
    var keys = Object.keys(candidate._values);
    if (keys.length < 3) return false;
    var inOrder = 0;
    var counts = {};
    var top = 0;
    keys.forEach(function (key) {
      var value = candidate._values[key];
      if (value === Number(key) + 1 || value === Number(key)) inOrder += 1;
      counts[value] = (counts[value] || 0) + 1;
      if (counts[value] > top) top = counts[value];
    });
    return inOrder / keys.length >= 0.8 || top / keys.length >= 0.8;
  }

  // 每张卡上这个数都等于另一个带小数的数的整数部分或小数部分
  function fragmentOf(candidate, all) {
    for (var i = 0; i < all.length; i += 1) {
      var other = all[i];
      if (other === candidate || !other._values || other.type !== "number") continue;
      var shared = 0;
      var hits = 0;
      var decimals = 0;
      for (var key in candidate._values) {
        if (!(key in other._values)) continue;
        var part = candidate._values[key];
        var whole = other._values[key];
        if (typeof whole !== "number" || whole === part) continue;
        shared += 1;
        if (whole % 1) decimals += 1;
        var fraction = Math.round((Math.abs(whole) % 1) * 100);
        if (part === Math.trunc(whole) || (whole % 1 && part === fraction)) hits += 1;
      }
      if (shared >= 3 && decimals >= 1 && hits / shared >= 0.8) return true;
    }
    return false;
  }

  function countNumbers(text) {
    var matches = stripDateAndDuration(text).match(/\d+(?:[.,]\d+)*/g);
    return matches ? matches.length : 0;
  }

  // 去掉数字后剩下的字每张卡都不一样 → 这个数字写在一句话/标题里
  function varyingWords(texts) {
    var counts = {};
    var top = 0;
    texts.forEach(function (text) {
      var rest = text.replace(/[\d.,:：%+\-–()（）$£€¥\s|·]/g, "").toLowerCase();
      counts[rest] = (counts[rest] || 0) + 1;
      if (counts[rest] > top) top = counts[rest];
    });
    return top / texts.length < 0.6;
  }

  function mergeRank(candidate) {
    var visible = candidate.kind === "text" ? 4 : candidate.kind === "pair" ? 2 : 0;
    return visible + (candidate.canonicalId ? 1 : 0) + candidate.coverage.count / 1000;
  }

  function sameValues(a, b) {
    if (a.excluded || !a._values || !b._values || a.type !== b.type) return false;
    // 日期:"10 days ago" 和精确时间差几个小时;数字:"5.3K" 和 5,322 是同一个数四舍五入
    var tolerance = a.type === "date" ? 48 * 3600 * 1000 : 0;
    var relative = a.type === "number" ? 0.05 : 1e-9;
    if (a.attr === RATING_ATTR || b.attr === RATING_ATTR) tolerance = 0.5;
    var shared = 0;
    var distinct = {};
    for (var key in a._values) {
      if (!(key in b._values)) continue;
      var left = typeof a._values[key] === "string" ? Date.parse(a._values[key]) : a._values[key];
      var right = typeof b._values[key] === "string" ? Date.parse(b._values[key]) : b._values[key];
      if (typeof left !== "number" || typeof right !== "number" || isNaN(left) || isNaN(right)) return false;
      var limit = Math.max(tolerance, Math.max(Math.abs(left), Math.abs(right)) * relative);
      // "about 1 month ago" 这类说法很粗:按离现在多久放宽 15%
      if (a.type === "date") limit = Math.max(limit, Math.abs(Date.now() - Math.min(left, right)) * 0.15);
      if (Math.abs(left - right) > limit) return false;
      shared += 1;
      distinct[left] = true;
    }
    var smaller = Math.min(Object.keys(a._values).length, Object.keys(b._values).length);
    return shared >= 3 && shared >= smaller * 0.8 && Object.keys(distinct).length >= 3;
  }

  // 两个不同的数字从图标线索猜出了同一个名字(菜单里会出现两个"下载量")→ 两个都不用这个名字,
  // 改用各自卡片里的图标来区分
  function dropDuplicateGuessedNames(candidates) {
    var byLabel = {};
    candidates.forEach(function (candidate) {
      if (candidate.excluded || candidate.source !== "icon" || !candidate.label) return;
      (byLabel[candidate.label] = byLabel[candidate.label] || []).push(candidate);
    });
    Object.keys(byLabel).forEach(function (label) {
      if (byLabel[label].length < 2) return;
      byLabel[label].forEach(function (candidate) {
        candidate.label = "";
        candidate.siteLabel = "";
        candidate.canonicalId = "";
        candidate.source = "unnamed";
        candidate.preChecked = false;
      });
    });
  }

  // "热度: 157 收藏: 3 留言: 0" 这类多指标同文本节点:
  // 按 "label: 数值" 对拆成虚拟 slot(path#label),每个 label 一个候选字段。
  // 值捕获包含时间/容量单位与"前/ago",这样 "Added: 15 d"、"添加时间: 1 小时 前" 能整体作为值
  var PAIR_RE = /([一-龥A-Za-z][一-龥A-Za-z ]{0,13}?)\s*[:：]\s*((?:(?:19|20)\d{2}[-/.]\d{1,2}[-/.]\d{1,2}(?![\d])|\d{1,3}(?:[ '’]\d{3})+(?!\d)(?:[.,]\d+)?|\d+(?:[.,]\d+)*)\s*(?:万|萬|亿|億|bytes?\b|[kmgt]b\b|[kKmMbB]\b|days?\b|d\b|hours?\b|hrs?\b|h\b|minutes?\b|mins?\b|weeks?\b|wks?\b|w\b|months?\b|mos?\b|years?\b|yrs?\b|y\b|秒|分钟|分鐘|小时|小時|天|日|周|週|星期|个月|個月|月|年)?\s*(?:前|ago\b)?)/gi;

  function extractLabeledPairs(text) {
    var pairs = [];
    var normalized = normalizeText(text);
    var match;
    PAIR_RE.lastIndex = 0;
    while ((match = PAIR_RE.exec(normalized))) {
      pairs.push({ label: normalizeText(match[1]), value: normalizeText(match[2]) });
    }
    return pairs;
  }

  function findPairValue(text, label) {
    var pairs = extractLabeledPairs(text);
    for (var i = 0; i < pairs.length; i += 1) {
      if (pairs[i].label === label) return pairs[i].value;
    }
    return "";
  }

  function expandCompositeGroups(groups) {
    var paths = Object.keys(groups);
    for (var p = 0; p < paths.length; p += 1) {
      var path = paths[p];
      if (path.indexOf("@") >= 0 || path.indexOf("#") >= 0) continue;
      var entries = groups[path];

      var labelCounts = {};
      for (var e = 0; e < entries.length; e += 1) {
        var pairs = extractLabeledPairs(entries[e].occurrence.text);
        var seen = {};
        for (var i = 0; i < pairs.length; i += 1) {
          if (seen[pairs[i].label]) continue;
          seen[pairs[i].label] = true;
          labelCounts[pairs[i].label] = (labelCounts[pairs[i].label] || 0) + 1;
        }
      }

      var stableLabels = [];
      for (var label in labelCounts) {
        if (labelCounts[label] / entries.length >= 0.6) stableLabels.push(label);
      }
      // 只要有稳定的 "label: 值" 对就拆:既处理 "热度: x 收藏: y" 复合,
      // 也处理 "Added: 15 d From: 用户名" 这种指标+杂讯混排(杂讯部分被自然丢弃)
      if (stableLabels.length < 1) continue;

      for (var s = 0; s < stableLabels.length; s += 1) {
        var virtualPath = path + "#" + stableLabels[s];
        groups[virtualPath] = [];
        for (var e2 = 0; e2 < entries.length; e2 += 1) {
          var value = findPairValue(entries[e2].occurrence.text, stableLabels[s]);
          if (!value) continue;
          groups[virtualPath].push({
            cardIndex: entries[e2].cardIndex,
            occurrence: {
              text: value,
              attr: "",
              titleLike: entries[e2].occurrence.titleLike,
              context: entries[e2].occurrence.context
            }
          });
        }
      }
      delete groups[path]; // 复合原文不再单独成为候选
    }
  }

  function buildCandidate(path, entries, totalCards, counter) {
    var coverage = entries.length / totalCards;
    if (coverage < COVERAGE_KEEP) return null;

    // slot key 形态:elementPath | elementPath~textIndex | elementPath@attr | elementPath~i#pairLabel
    var pairIndex = path.indexOf("#");
    var pairLabel = pairIndex >= 0 ? path.slice(pairIndex + 1) : "";
    var basePath = pairIndex >= 0 ? path.slice(0, pairIndex) : path;
    var attr = "";
    var textIndex = null;
    var elementPath = basePath;
    var atIndex = basePath.indexOf("@");
    var tildeIndex = basePath.lastIndexOf("~");
    if (atIndex >= 0) {
      attr = basePath.slice(atIndex + 1);
      elementPath = basePath.slice(0, atIndex);
    } else if (tildeIndex >= 0) {
      textIndex = Number(basePath.slice(tildeIndex + 1));
      elementPath = basePath.slice(0, tildeIndex);
    }

    var texts = entries.map(function (entry) { return entry.occurrence.text; });
    var distinct = {};
    for (var i = 0; i < texts.length; i += 1) distinct[texts[i]] = true;
    var distinctCount = Object.keys(distinct).length;

    // 恒定 slot:所有卡片同值 → 是静态文案/label 本身,不是指标
    if (distinctCount <= 1 && entries.length >= Math.max(3, totalCards * 0.5)) return null;

    var typing = detectSlotType(texts);

    // 多数出现位置是标题/名称元素 → 一律按文字处理
    var titleLikeCount = 0;
    for (var t = 0; t < entries.length; t += 1) {
      if (entries[t].occurrence.titleLike) titleLikeCount += 1;
    }
    // 但整段只是一个数字(如 "605"、"5.3K")时不算标题:标题不会只写一个数字,
    // 有的网站把点赞/浏览放在 class 名带 title 的容器里
    if (titleLikeCount / entries.length >= 0.6 && pureNumberRatio(texts) < 0.6) typing = { type: "text", ratio: 0 };

    var labelInfo;
    if (pairLabel) {
      labelInfo = finishLabel(pairLabel, matchCanonical(pairLabel), "text-pair");
    } else {
      var split = splitLabelAndValue(texts, typing.type);
      labelInfo = inferLabel(split.constantLabel, entries, path);
    }

    // 从旁边图标猜的名字和值的类型对不上(日期被猜成"文件大小")→ 不用这个名字
    if (labelInfo.source === "icon" && labelInfo.canonical && typing.type !== "text" &&
        (labelInfo.canonical.id === "uploadDate") !== (typing.type === "date")) {
      labelInfo = { siteLabel: "", display: "", canonical: null, source: "unnamed" };
    }

    // 无名 slot 的类型语义兜底:日期→Date、时长→Duration、字节单位→File size
    if (!labelInfo.canonical) {
      if (typing.type === "date") labelInfo = defaultCanonicalLabel(labelInfo, "uploadDate");
      else if (typing.type === "duration") labelInfo = defaultCanonicalLabel(labelInfo, "durationSeconds");
      else if (typing.type === "number" && byteRatio(texts) >= 0.6) labelInfo = defaultCanonicalLabel(labelInfo, "fileSize");
    }

    var isSortable = typing.type !== "text" && typing.ratio >= TYPE_RATIO;

    // "用户0"、"Part2" 这类文字紧贴数字(无空格/冒号分隔)且 label 不在词表 → 按文字处理
    if (isSortable && !pairLabel && !labelInfo.canonical && countSeparatedValues(texts) / texts.length < 0.6) {
      isSortable = false;
    }

    var suspect = isSortable && !labelInfo.canonical && !labelInfo.siteLabel;
    var kind = pairLabel ? "pair" : attr ? "attr" : "text";

    if (!isSortable && kind === "attr") return null; // 不可解析的属性没有展示价值
    if (!isSortable && kind === "pair") return null;

    var id = makeCandidateId(labelInfo, typing.type, path, counter);
    var values = null;
    if (isSortable) {
      values = {};
      for (var vi = 0; vi < entries.length; vi += 1) {
        if (entries[vi].cardIndex == null) continue;
        var parsed = parseByType(entries[vi].occurrence.text, typing.type);
        if (parsed != null && !(typeof parsed === "number" && isNaN(parsed))) values[entries[vi].cardIndex] = parsed;
      }
    }
    return {
      _values: values,
      _texts: texts,
      id: id,
      path: elementPath,
      textIndex: textIndex,
      kind: kind,
      attr: attr,
      pairLabel: pairLabel,
      type: isSortable ? typing.type : "text",
      siteLabel: labelInfo.siteLabel,
      label: labelInfo.display,
      canonicalId: labelInfo.canonical ? labelInfo.canonical.id : "",
      coverage: { count: entries.length, total: totalCards },
      parseRatio: Math.round(typing.ratio * 100) / 100,
      examples: texts.slice(0, 3),
      source: labelInfo.source,
      excluded: !isSortable,
      excludedWhy: "",
      suspect: suspect,
      preChecked: isSortable && !suspect && coverage >= COVERAGE_TRUST && Boolean(labelInfo.canonical),
      // 没名字(或名字是从图标线索猜的,可能因重名被撤掉)→ 记下卡片里的图标,面板用它来显示
      icon: isSortable && kind === "text" && (!labelInfo.display || labelInfo.source === "icon") ? iconForEntries(entries) : null
    };
  }

  function defaultCanonicalLabel(labelInfo, canonicalId) {
    for (var i = 0; i < CANONICAL_VOCAB.length; i += 1) {
      if (CANONICAL_VOCAB[i].id === canonicalId) {
        return finishLabel(
          labelInfo.siteLabel || "",
          CANONICAL_VOCAB[i],
          labelInfo.source === "unnamed" ? "type-default" : labelInfo.source
        );
      }
    }
    return labelInfo;
  }

  function byteRatio(texts) {
    var count = 0;
    for (var i = 0; i < texts.length; i += 1) {
      if (BYTE_RE.test(normalizeText(texts[i]))) count += 1;
    }
    return count / texts.length;
  }

  // 值 token 是否与前面的文字有明确分隔(行首/空白/冒号/括号)
  function pureNumberRatio(texts) {
    var count = 0;
    for (var i = 0; i < texts.length; i += 1) {
      if (/^[-+]?\d[\d.,\s]*(?:万|萬|亿|億|千|[kmb])?\+?$/i.test(normalizeText(texts[i]))) count += 1;
    }
    return texts.length ? count / texts.length : 0;
  }

  function countSeparatedValues(texts) {
    var count = 0;
    for (var i = 0; i < texts.length; i += 1) {
      if (/(?:^|[\s:：([【])[-+]?\d/.test(normalizeText(texts[i]))) count += 1;
    }
    return count;
  }

  // 表示"没有数值"的占位写法:New、--、—、N/A、暂无 等。它们不算"不是数字",
  // 只算这张卡没有值(排在最后),这样一列下载量里混着 "New" 也还能排序。
  var PLACEHOLDER_RE = /^(?:new|n\/?a|none|null|tbd|[-‐-―−~?.…·]+|暂无|無|无|暫無|未知|待定)$/i;

  function isPlaceholderValue(text) {
    return PLACEHOLDER_RE.test(normalizeText(text));
  }

  function detectSlotType(texts) {
    var counts = { duration: 0, date: 0, number: 0 };
    var real = 0;
    for (var i = 0; i < texts.length; i += 1) {
      var text = texts[i];
      if (isPlaceholderValue(text)) continue;
      real += 1;
      if (looksLikeDate(text) && parseDateIso(text) != null) counts.date += 1;
      else if (looksLikeDuration(text) && parseDurationSeconds(text) != null) counts.duration += 1;
      else if (looksLikeNumber(text) && parseNumber(stripDateAndDuration(text)) != null) counts.number += 1;
    }
    var order = ["date", "duration", "number"];
    var best = "text";
    var bestRatio = 0;
    if (real < Math.max(2, texts.length * 0.25)) return { type: "text", ratio: 0 };
    for (var o = 0; o < order.length; o += 1) {
      var ratio = counts[order[o]] / real;
      if (ratio > bestRatio) { bestRatio = ratio; best = order[o]; }
    }
    if (bestRatio < TYPE_RATIO) return { type: "text", ratio: bestRatio };
    return { type: best, ratio: bestRatio };
  }

  // 跨卡片 diff:值 token 去掉后剩下的恒定文本即 label
  function splitLabelAndValue(texts, type) {
    if (type === "text") return { constantLabel: "" };
    var labelCounts = {};
    for (var i = 0; i < texts.length; i += 1) {
      var label = extractLabelPart(texts[i], type);
      if (label) labelCounts[label] = (labelCounts[label] || 0) + 1;
    }
    var best = "";
    var bestCount = 0;
    for (var key in labelCounts) {
      if (labelCounts[key] > bestCount) { bestCount = labelCounts[key]; best = key; }
    }
    if (best && bestCount / texts.length >= 0.6) return { constantLabel: best };
    return { constantLabel: "" };
  }

  function extractLabelPart(text, type) {
    var normalized = normalizeText(text);
    var remainder = normalized;
    if (type === "date") {
      remainder = remainder
        .replace(new RegExp(ABS_DATE_RE.source, "gi"), " ")
        .replace(new RegExp(REL_DATE_RE.source, "gi"), " ")
        .replace(JUST_NOW_RE, " ");
    } else if (type === "duration") {
      remainder = remainder.replace(/\d{1,3}:\d{2}(?::\d{2})?/g, " ")
        .replace(/\d+(?:\.\d+)?\s*(?:小时|小時|hours?|hrs?|h|分钟|分鐘|minutes?|mins?|min|秒|seconds?|secs?)\b/gi, " ");
    } else {
      remainder = stripDateAndDuration(remainder)
        .replace(new RegExp(BYTE_RE.source, "gi"), " ")
        .replace(new RegExp("[-+]?" + NUM_TOKEN_SRC + "\\s*(?:万|萬|亿|億|k|m|b|thousand|million|billion|%)?", "gi"), " ");
    }
    return normalizeText(remainder.replace(/[|·•,;，；()（）\[\]]+/g, " ").replace(/[:：]+/g, " "))
      .slice(0, 40);
  }

  function inferLabel(constantLabel, entries, path) {
    // 1) slot 内恒定文本
    if (constantLabel) {
      var canonical = matchCanonical(constantLabel);
      return finishLabel(constantLabel, canonical, "text-diff");
    }

    // 2) 相邻恒定文本(前一个兄弟节点跨卡片同值)
    var prevCounts = {};
    for (var i = 0; i < entries.length; i += 1) {
      var prev = entries[i].occurrence.context.prevSiblingText;
      if (prev && prev.length <= 30 && !looksLikeNumber(prev) && !looksLikeDate(prev)) {
        prevCounts[prev] = (prevCounts[prev] || 0) + 1;
      }
    }
    for (var key in prevCounts) {
      if (prevCounts[key] / entries.length >= 0.6) {
        return finishLabel(key, matchCanonical(key), "sibling-label");
      }
    }

    // 3) 属性名本身 (data-favorites="45" → favorites)
    var atIndex = path.indexOf("@");
    if (atIndex >= 0) {
      var rawAttr = path.slice(atIndex + 1);
      var attrName = rawAttr.replace(/^data-/, "").replace(/[-_]+/g, " ");
      var attrCanonical = matchCanonical(attrName);
      // title / aria-label / alt 只是"提示文字"这个位置的名字,不是数字的名字
      var generic = VALUE_ATTRS.indexOf(rawAttr) >= 0;
      if (attrCanonical || (!generic && /^[a-z][a-z ]{1,28}$/i.test(attrName))) {
        return finishLabel(attrName, attrCanonical, "attr-name");
      }
    }

    // 4) icon / attr 语义:先用前置图标(👍 182 中 182 属于前面的 👍),没有再看后置
    for (var pass = 0; pass < 2; pass += 1) {
      var hintCounts = {};
      for (var e = 0; e < entries.length; e += 1) {
        var context = entries[e].occurrence.context;
        var haystack = pass === 0 ? context.attrHints : context.attrHintsNext;
        var hint = matchIconHint(haystack);
        if (hint) hintCounts[hint.id] = (hintCounts[hint.id] || 0) + 1;
      }
      for (var hintId in hintCounts) {
        if (hintCounts[hintId] / entries.length >= 0.6) {
          for (var v = 0; v < CANONICAL_VOCAB.length; v += 1) {
            if (CANONICAL_VOCAB[v].id === hintId) {
              return finishLabel("", CANONICAL_VOCAB[v], "icon");
            }
          }
        }
      }
    }

    return { siteLabel: "", display: "", canonical: null, source: "unnamed" };
  }

  function finishLabel(siteLabel, canonical, source) {
    var clean = normalizeText(siteLabel).replace(/[:：]+$/, "");
    if (canonical && canonical.id === "price") clean = normalizeText(clean.replace(new RegExp(CURRENCY_RE.source, "gi"), " ")).replace(/[:：]+$/, "");
    var display;
    if (canonical && clean && !canonical.re.test(clean)) display = clean + " · " + canonical.zh + " " + canonical.en;
    else if (canonical && clean) display = /[一-龥]/.test(clean) ? clean + " " + canonical.en : canonical.zh + " " + clean;
    else if (canonical) display = canonical.zh + " " + canonical.en;
    else display = clean;
    return { siteLabel: clean, display: display, canonical: canonical, source: source };
  }

  function makeCandidateId(labelInfo, type, path, counter) {
    var base = labelInfo.canonical ? labelInfo.canonical.id
      : labelInfo.siteLabel ? slugify(labelInfo.siteLabel)
      : type === "text" ? "text" : "metric";
    if (base === "metric" || base === "text") {
      counter.n += 1;
      base = base + "-" + counter.n;
    }
    return base + "-" + hashOf(path);
  }

  function slugify(value) {
    return normalizeText(value).toLowerCase()
      .replace(/[^a-z0-9一-龥]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "metric";
  }

  function hashOf(value) {
    var hash = 5381;
    for (var i = 0; i < value.length; i += 1) {
      hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
    }
    return hash.toString(36).slice(0, 5);
  }

  // 同一元素的文本 slot 与属性 slot 往往是同一个指标(如 title="9861 views"),
  // canonicalId 相同时保留覆盖率更高的那个。
  function dedupeAttrEcho(candidates) {
    for (var i = 0; i < candidates.length; i += 1) {
      var left = candidates[i];
      if (!left || left.excluded || !left.canonicalId) continue;
      for (var j = i + 1; j < candidates.length; j += 1) {
        var right = candidates[j];
        if (!right || right.excluded || right.canonicalId !== left.canonicalId) continue;
        if (right.type !== left.type) continue;
        var loser = left.coverage.count >= right.coverage.count ? right : left;
        loser.shadowed = true;
      }
    }
    for (var k = candidates.length - 1; k >= 0; k -= 1) {
      if (candidates[k].shadowed) {
        candidates[k].suspect = true;
        candidates[k].preChecked = false;
        delete candidates[k].shadowed;
      }
    }
  }

  function compareCandidates(a, b) {
    var rank = function (c) {
      if (c.excluded) return 3;
      if (c.suspect) return 2;
      return c.preChecked ? 0 : 1;
    };
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return b.coverage.count - a.coverage.count;
  }

  /* ---------------------------------------------------------------- *
   * Item 提取(标题/链接/缩略图 + slot 值)
   * ---------------------------------------------------------------- */

  function extractItems(doc, cardRoots, slotDefs, options) {
    var opts = options || {};
    var pageUrl = opts.pageUrl || (doc.location ? doc.location.href : "") || "";
    var now = opts.now || new Date();
    var items = [];

    for (var i = 0; i < cardRoots.length; i += 1) {
      var card = cardRoots[i];
      var metrics = {};
      var metricRaw = {};

      for (var s = 0; s < slotDefs.length; s += 1) {
        var def = slotDefs[s];
        if (def.excluded || def.enabled === false) continue;
        var element = resolvePath(card, def.path);
        if (!element) continue;
        var raw;
        if (def.kind === "attr" && def.attr === RATING_ATTR) {
          var rated = ratingFromElement(element);
          raw = rated == null ? "" : String(rated);
        } else if (def.kind === "attr") {
          raw = normalizeText(element.getAttribute && element.getAttribute(def.attr));
        } else if (def.textIndex != null) {
          raw = nthTextOf(element, def.textIndex);
        } else {
          raw = ownTextOf(element); // v1 规则兼容:元素级 slot
        }
        if (raw && def.kind === "pair" && def.pairLabel) {
          raw = findPairValue(raw, def.pairLabel);
        }
        if (!raw) continue;
        var value = parseByType(raw, def.type, now);
        if (value == null || (typeof value === "number" && isNaN(value))) continue;
        metrics[def.id] = value;
        metricRaw[def.id] = raw;
        // 规范别名:日期范围过滤/时长依赖固定键,取第一个启用的日期/时长 slot
        if (def.type === "date" && metrics.uploadDate == null) metrics.uploadDate = value;
        if (def.type === "duration" && metrics.durationSeconds == null) metrics.durationSeconds = value;
      }

      var identity = extractIdentity(card, pageUrl);
      items.push({
        id: identity.url || pageUrl + "#card-" + i,
        title: identity.title,
        videoUrl: identity.url,
        thumbnailUrl: identity.thumbnail,
        sourceUrl: pageUrl,
        sourcePage: opts.page || 1,
        discoveryOrder: i,
        rawText: normalizeText(card.textContent).slice(0, 400),
        metrics: metrics,
        metricRaw: metricRaw
      });
    }
    return items;
  }

  function extractIdentity(card, pageUrl) {
    var title = "";
    var url = "";
    var thumbnail = "";

    var titleEl = card.querySelector("h1,h2,h3,h4,h5,[class*='title' i],[class*='name' i],[itemprop='name']");
    if (titleEl) title = normalizeText(titleEl.textContent);

    var anchors = card.querySelectorAll("a[href]");
    var bestAnchor = null;
    var bestScore = -1;
    for (var i = 0; i < anchors.length; i += 1) {
      var href = anchors[i].getAttribute("href") || "";
      if (!href || href.charAt(0) === "#" || /^javascript:/i.test(href)) continue;
      var text = normalizeText(anchors[i].textContent || anchors[i].getAttribute("title") || "");
      var score = 0;
      if (anchors[i].querySelector("img,picture,video")) score += 2;
      if (text.length >= 6 && text.length <= 240) score += 3;
      if (titleEl && (anchors[i].contains(titleEl) || titleEl.contains(anchors[i]))) score += 4;
      if (score > bestScore) { bestScore = score; bestAnchor = anchors[i]; }
    }
    if (bestAnchor) {
      url = absoluteUrl(bestAnchor.getAttribute("href"), pageUrl);
      if (!title) title = normalizeText(bestAnchor.textContent || bestAnchor.getAttribute("title") || "");
    }
    if (!title) {
      var img = card.querySelector("img[alt]");
      if (img) title = normalizeText(img.getAttribute("alt"));
    }
    if (!title) title = normalizeText(card.textContent).slice(0, 80);

    var image = card.querySelector("img,source");
    if (image) {
      var src = image.getAttribute("src") || image.getAttribute("data-src") ||
        image.getAttribute("data-original") || image.getAttribute("data-lazy-src") ||
        image.getAttribute("data-thumb") ||
        (normalizeText(image.getAttribute("srcset") || image.getAttribute("data-srcset")).split(",")[0] || "").split(" ")[0];
      thumbnail = absoluteUrl(src, pageUrl);
    }
    return { title: title, url: url, thumbnail: thumbnail };
  }

  function absoluteUrl(value, baseUrl) {
    var text = normalizeText(value);
    if (!text) return "";
    try {
      return new URL(text, baseUrl || undefined).href;
    } catch (e) {
      return "";
    }
  }

  /* ---------------------------------------------------------------- *
   * 顶层 API
   * ---------------------------------------------------------------- */

  // 发现模式:找 card → 对齐 → 候选字段 + 全量提取(含所有候选,便于 UI 展示示例)
  function discover(doc, options) {
    var opts = options || {};
    var found = findCards(doc);
    if (!found.roots.length) {
      return { ok: false, reason: "no-cards", cardCount: 0, candidates: [], items: [], signature: "", clusterSizes: found.clusterSizes };
    }

    var cardSlotList = [];
    for (var i = 0; i < found.roots.length; i += 1) {
      cardSlotList.push(collectCardSlots(found.roots[i]));
    }
    var candidates = alignSlots(cardSlotList);
    var sortable = candidates.filter(function (c) { return !c.excluded; });
    var items = extractItems(doc, found.roots, sortable, opts);

    return {
      ok: true,
      engineVersion: ENGINE_VERSION,
      cardCount: found.roots.length,
      signature: found.signature,
      clusterSizes: found.clusterSizes,
      candidates: candidates,
      items: items
    };
  }

  // 套用模式:按保存的规则提取;返回覆盖率报告用于失效检测
  function applyRule(doc, rule, options) {
    var opts = options || {};
    var found = findCards(doc);
    var roots = found.roots;
    if (rule && rule.cardSignature && found.signature && found.signature !== rule.cardSignature) {
      // 主簇签名与规则不符 → 规则可能失效,仍尝试提取但降置信
      opts.signatureMismatch = true;
    }
    if (!roots.length) {
      return { ok: false, reason: "no-cards", cardCount: 0, items: [], fieldCoverage: {}, signatureMismatch: false };
    }

    var slots = (rule && rule.slots ? rule.slots : []).filter(function (slot) { return slot.enabled !== false && !slot.excluded; });
    var items = extractItems(doc, roots, slots, opts);

    var fieldCoverage = {};
    for (var s = 0; s < slots.length; s += 1) {
      var id = slots[s].id;
      var count = 0;
      for (var i = 0; i < items.length; i += 1) {
        if (items[i].metrics[id] != null) count += 1;
      }
      fieldCoverage[id] = { count: count, total: items.length };
    }

    var healthy = slots.length === 0 || slots.some(function (slot) {
      var cov = fieldCoverage[slot.id];
      return cov && cov.total > 0 && cov.count / cov.total >= COVERAGE_KEEP;
    });

    return {
      ok: true,
      engineVersion: ENGINE_VERSION,
      cardCount: roots.length,
      signature: found.signature,
      items: items,
      fieldCoverage: fieldCoverage,
      signatureMismatch: Boolean(opts.signatureMismatch),
      healthy: healthy
    };
  }

  // 用户点选:反算 slot 并全簇泛化。textIndex 为 null 时取元素合并文本(兼容旧行为)。
  // 复合文本("热度: 382 收藏: 4 …")会一次拆出多个候选。
  function generalizeFromTextNode(doc, element, textIndex) {
    var found = findCards(doc);
    if (!found.roots.length) return { ok: false, reason: "no-cards" };

    var cardRoot = null;
    for (var i = 0; i < found.roots.length; i += 1) {
      if (found.roots[i] === element || found.roots[i].contains(element)) {
        cardRoot = found.roots[i];
        break;
      }
    }
    if (!cardRoot) return { ok: false, reason: "outside-card" };

    var path = slotPathFor(element, cardRoot);
    if (path == null) return { ok: false, reason: "path-failed" };

    // 同时收集每张卡片上该位置的真实上下文(图标/隐藏文字/属性),
    // 这样点选路径也能用与自动识别相同的线索来命名(修复:此前传空数组导致点选永远无名)
    var texts = [];
    var entries = [];
    for (var r = 0; r < found.roots.length; r += 1) {
      var resolved = resolvePath(found.roots[r], path);
      if (!resolved) continue;
      var value = "";
      var occurrence = null;
      if (textIndex != null) {
        var valueNode = nthTextNodeOf(resolved, textIndex);
        if (valueNode) {
          value = normalizeText(valueNode.textContent);
          if (value) occurrence = makeTextNodeOccurrence(resolved, valueNode, value, textIndex);
        }
      } else {
        value = ownTextOf(resolved);
        if (value) occurrence = makeOccurrence(resolved, value, "");
      }
      if (value && occurrence) {
        texts.push(value);
        entries.push({ cardIndex: r, occurrence: occurrence });
      }
    }
    if (!texts.length) return { ok: false, reason: "no-matches" };
    var total = found.roots.length;
    var slotKey = textIndex != null ? path + "~" + textIndex : path;

    // 复合文本 → 逐 label 拆候选
    var labelCounts = {};
    for (var e = 0; e < texts.length; e += 1) {
      var pairs = extractLabeledPairs(texts[e]);
      var seen = {};
      for (var p = 0; p < pairs.length; p += 1) {
        if (seen[pairs[p].label]) continue;
        seen[pairs[p].label] = true;
        labelCounts[pairs[p].label] = (labelCounts[pairs[p].label] || 0) + 1;
      }
    }
    var candidates = [];
    for (var label in labelCounts) {
      if (labelCounts[label] / texts.length < 0.6) continue;
      var values = [];
      for (var v = 0; v < texts.length; v += 1) {
        var pairValue = findPairValue(texts[v], label);
        if (pairValue) values.push(pairValue);
      }
      var pairTyping = detectSlotType(values);
      if (pairTyping.type === "text") continue;
      candidates.push(makePickedCandidate({
        key: slotKey + "#" + label,
        elementPath: path,
        textIndex: textIndex,
        kind: "pair",
        pairLabel: label,
        typing: pairTyping,
        labelInfo: finishLabel(label, matchCanonical(label), "picker"),
        values: values,
        total: total
      }));
    }
    if (candidates.length) return { ok: true, candidates: candidates };

    // 单值
    var typing = detectSlotType(texts);
    if (typing.type === "text") {
      return { ok: false, reason: "not-sortable-type", sample: texts.slice(0, 3) };
    }
    var split = splitLabelAndValue(texts, typing.type);
    var labelInfo = inferLabel(split.constantLabel, entries, path);
    if (!labelInfo.canonical) {
      if (typing.type === "date") labelInfo = defaultCanonicalLabel(labelInfo, "uploadDate");
      else if (typing.type === "duration") labelInfo = defaultCanonicalLabel(labelInfo, "durationSeconds");
      else if (typing.type === "number" && byteRatio(texts) >= 0.6) labelInfo = defaultCanonicalLabel(labelInfo, "fileSize");
    }
    if (typing.type === "number" && !labelInfo.canonical && countSeparatedValues(texts) / texts.length < 0.6) {
      return { ok: false, reason: "not-sortable-type", sample: texts.slice(0, 3) };
    }

    return {
      ok: true,
      candidates: [makePickedCandidate({
        key: slotKey,
        elementPath: path,
        textIndex: textIndex,
        kind: "text",
        pairLabel: "",
        typing: typing,
        labelInfo: labelInfo,
        values: texts,
        total: total,
        icon: !labelInfo.display || labelInfo.source === "icon" ? iconForEntries(entries) : null
      })]
    };
  }

  function makePickedCandidate(spec) {
    var idInfo = (spec.labelInfo.siteLabel || spec.labelInfo.canonical)
      ? spec.labelInfo
      : { canonical: null, siteLabel: "picked" };
    return {
      id: makeCandidateId(idInfo, spec.typing.type, spec.key, { n: 0 }),
      path: spec.elementPath,
      textIndex: spec.textIndex,
      kind: spec.kind,
      attr: "",
      pairLabel: spec.pairLabel,
      type: spec.typing.type,
      siteLabel: spec.labelInfo.siteLabel || "",
      label: spec.labelInfo.display || spec.labelInfo.siteLabel || "",
      canonicalId: spec.labelInfo.canonical ? spec.labelInfo.canonical.id : "",
      coverage: { count: spec.values.length, total: spec.total },
      parseRatio: Math.round(spec.typing.ratio * 100) / 100,
      examples: spec.values.slice(0, 3),
      source: "picker",
      excluded: false,
      suspect: false,
      preChecked: true,
      enabled: true,
      icon: spec.icon || null
    };
  }

  // 兼容入口:从元素出发(拿不到精确文本节点时的降级路径)
  function generalizeFromElement(doc, targetElement) {
    var element = targetElement;
    var text = ownTextOf(element);
    if (!text || (!looksLikeNumber(text) && !looksLikeDate(text) && !looksLikeDuration(text))) {
      var descendants = element.querySelectorAll ? element.querySelectorAll("*") : [];
      for (var d = 0; d < descendants.length; d += 1) {
        var candidateText = ownTextOf(descendants[d]);
        if (candidateText && (looksLikeNumber(candidateText) || looksLikeDate(candidateText) || looksLikeDuration(candidateText))) {
          element = descendants[d];
          text = candidateText;
          break;
        }
      }
    }
    if (!text) return { ok: false, reason: "no-value-text" };
    return generalizeFromTextNode(doc, element, null);
  }

  // 以前保存的网站设置里没有图标:回到这个网站时,从这一页的卡片里把图标补上
  function iconForSlot(doc, slot) {
    if (!slot || slot.kind !== "text" || slot.textIndex == null) return null;
    var found = findCards(doc);
    var entries = [];
    for (var i = 0; i < found.roots.length && entries.length < 8; i += 1) {
      var resolved = resolvePath(found.roots[i], slot.path);
      var node = resolved && nthTextNodeOf(resolved, slot.textIndex);
      if (!node) continue;
      entries.push({ occurrence: { context: gatherTextNodeContext(resolved, node) } });
    }
    return entries.length ? iconForEntries(entries) : null;
  }

  globalThis.CardSorterEngine = {
    version: ENGINE_VERSION,
    discover: discover,
    applyRule: applyRule,
    generalizeFromElement: generalizeFromElement,
    generalizeFromTextNode: generalizeFromTextNode,
    findCards: findCards,
    iconForSlot: iconForSlot,
    slotPathFor: slotPathFor,
    resolvePath: resolvePath,
    // 供测试与调用方复用的纯函数
    normalizeText: normalizeText,
    parseNumber: parseNumber,
    parseDurationSeconds: parseDurationSeconds,
    parseDateIso: parseDateIso,
    parseByType: parseByType,
    detectSlotType: detectSlotType,
    isPlaceholderValue: isPlaceholderValue,
    extractLabelPart: extractLabelPart,
    matchCanonical: matchCanonical,
    sigOf: sigOf
  };
})();
