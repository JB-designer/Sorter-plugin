/*
 * 页面取点器:用户直接点击页面上想用来排序的数字/日期。
 * - caretRangeFromPoint 精确定位到点击的那个文本节点(不再猜元素)
 * - 复合文本(热度: 382 收藏: 4 …)一次拆出全部指标
 * - 取消通道:Esc / 面板按钮(stop())
 * 与悬浮面板同处 content-script 隔离世界,直接回调,无需消息传递。
 */
(function () {
  "use strict";
  if (globalThis.__cardSorterPicker) return;

  var engine = globalThis.CardSorterEngine;
  var active = false;
  var callbacks = null;
  var hoverBox = null;
  var tipBox = null;
  var cardBoxes = [];

  // 文案跟随 Chrome 语言(和 src/core/i18n.js 同一套;测试包可固定 FORCED_LANG)
  var FORCED_LANG = null;
  var IS_ZH = (FORCED_LANG || (/^zh/i.test((chrome.i18n && chrome.i18n.getUILanguage()) || "zh") ? "zh" : "en")) === "zh";
  var TEXT = IS_ZH ? {
    tip: "点击要排序的数字或日期，按 Esc 退出。",
    text: "这是文字。请点击数字本身，如“点赞：4”中的 4。",
    outside: "不在卡片内。请点击卡片里的数字。",
    noNumber: "这里没有数字，请直接点击数字。",
    missed: "未点中，请重试。"
  } : {
    tip: "Click a number or date to sort by. Esc to exit.",
    text: "That's text. Click the number itself, like 4 in \"Likes: 4\".",
    outside: "Outside the cards. Click a number in a card.",
    noNumber: "No number here. Click right on the digits.",
    missed: "Missed. Try again."
  };
  var TIP_DEFAULT = TEXT.tip;

  function start(handlers) {
    if (active) return;
    active = true;
    callbacks = handlers || {};
    buildOverlay();
    highlightCards();
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
  }

  function stop(reason) {
    if (!active) return;
    active = false;
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    if (hoverBox) hoverBox.remove();
    if (tipBox) tipBox.remove();
    cardBoxes.forEach(function (box) { box.remove(); });
    hoverBox = null;
    tipBox = null;
    cardBoxes = [];
    if (reason === "cancel" && callbacks && callbacks.onCancel) callbacks.onCancel();
    callbacks = null;
  }

  function buildOverlay() {
    hoverBox = document.createElement("div");
    hoverBox.style.cssText = "position:fixed;z-index:2147483644;pointer-events:none;border:2px solid #e0762a;background:rgba(224,118,42,.14);border-radius:3px;display:none;";
    document.documentElement.appendChild(hoverBox);

    tipBox = document.createElement("div");
    tipBox.style.cssText = "position:fixed;z-index:2147483645;pointer-events:none;background:#1f2430;color:#fff;font:13px/1.5 system-ui,sans-serif;padding:8px 12px;border-radius:8px;max-width:360px;box-shadow:0 4px 14px rgba(0,0,0,.35);";
    tipBox.textContent = TIP_DEFAULT;
    tipBox.style.display = "none";
    tipBox.style.left = "16px";
    tipBox.style.top = "16px";
    document.documentElement.appendChild(tipBox);
  }

  function highlightCards() {
    try {
      var found = engine.findCards(document);
      found.roots.slice(0, 80).forEach(function (root) {
        var rect = root.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        var box = document.createElement("div");
        box.style.cssText = "position:absolute;z-index:2147483643;pointer-events:none;border:1px dashed rgba(74,144,226,.55);border-radius:4px;" +
          "left:" + (rect.left + scrollX) + "px;top:" + (rect.top + scrollY) + "px;width:" + rect.width + "px;height:" + rect.height + "px;";
        document.documentElement.appendChild(box);
        cardBoxes.push(box);
      });
    } catch (error) { /* 高亮失败不阻塞取点 */ }
  }

  // 面板(#card-sorter-host)里的点击和移动不拦:要让「取消」能点
  function onPanel(event) {
    var target = event.target;
    return Boolean(target && target.closest && target.closest("#card-sorter-host"));
  }

  function onMove(event) {
    if (!hoverBox) return;
    if (onPanel(event)) { hoverBox.style.display = "none"; return; }
    var rect = event.target.getBoundingClientRect();
    hoverBox.style.display = "block";
    hoverBox.style.left = rect.left + "px";
    hoverBox.style.top = rect.top + "px";
    hoverBox.style.width = rect.width + "px";
    hoverBox.style.height = rect.height + "px";
  }

  // 精确取到鼠标下的文本节点及其在父元素内的序号
  function textNodeAtPoint(x, y) {
    var range = null;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(x, y);
    } else if (document.caretPositionFromPoint) {
      var position = document.caretPositionFromPoint(x, y);
      if (position) range = { startContainer: position.offsetNode };
    }
    var node = range && range.startContainer;
    if (!node || node.nodeType !== 3) return null;
    var parent = node.parentElement;
    if (!parent) return null;

    var index = 0;
    var sibling = parent.firstChild;
    while (sibling && sibling !== node) {
      if (sibling.nodeType === 3 && String(sibling.textContent).trim()) index += 1;
      sibling = sibling.nextSibling;
    }
    if (!String(node.textContent).trim()) return null;
    return { element: parent, textIndex: index };
  }

  function onClick(event) {
    if (!active || onPanel(event)) return;
    event.preventDefault();
    event.stopPropagation();

    var result;
    try {
      var hit = textNodeAtPoint(event.clientX, event.clientY);
      result = hit
        ? engine.generalizeFromTextNode(document, hit.element, hit.textIndex)
        : engine.generalizeFromElement(document, event.target);
    } catch (error) {
      result = { ok: false, reason: "error", message: String(error && error.message || error) };
    }

    if (result && result.ok) {
      var done = callbacks && callbacks.onPicked ? callbacks.onPicked(result) : true;
      if (done !== false) stop("picked");
    } else {
      flashTip(pickErrorText(result));
      if (callbacks && callbacks.onMiss) callbacks.onMiss(result);
    }
  }

  function onKey(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      stop("cancel");
    }
  }

  function pickErrorText(result) {
    var reason = result && result.reason;
    if (reason === "not-sortable-text" || reason === "not-sortable-type") {
      return TEXT.text;
    }
    if (reason === "outside-card") return TEXT.outside;
    if (reason === "no-value-text" || reason === "no-matches") return TEXT.noNumber;
    return TEXT.missed;
  }

  function flashTip(text) {
    if (!tipBox) return;
    tipBox.textContent = text;
    tipBox.style.display = "block";
    tipBox.style.background = "#8c2f2f";
    setTimeout(function () {
      if (!tipBox) return;
      tipBox.textContent = TIP_DEFAULT;
      tipBox.style.display = "none";
      tipBox.style.background = "#1f2430";
    }, 2600);
  }

  globalThis.__cardSorterPicker = { start: start, stop: function () { stop("cancel"); } };
})();
