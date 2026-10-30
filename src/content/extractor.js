// Advanced Card Sort · https://github.com/JB-designer/Sorter-plugin · MIT License
/*
 * 页面提取入口(content script,须与 alignment-engine.js 一同注入)。
 * side panel 通过 chrome.scripting.executeScript 调用 globalThis.__cardSorter.*
 */
(function () {
  "use strict";
  if (globalThis.__cardSorter) return;

  var engine = globalThis.CardSorterEngine;

  globalThis.__cardSorter = {
    discover: function (options) {
      try {
        var result = engine.discover(document, {
          pageUrl: location.href,
          page: options && options.page ? options.page : 1
        });
        result.url = location.href;
        result.title = document.title || location.href;
        return result;
      } catch (error) {
        return { ok: false, reason: "error", message: String(error && error.message || error) };
      }
    },

    applyRule: function (rule, options) {
      try {
        var result = engine.applyRule(document, rule, {
          pageUrl: location.href,
          page: options && options.page ? options.page : 1
        });
        result.url = location.href;
        result.title = document.title || location.href;
        return result;
      } catch (error) {
        return { ok: false, reason: "error", message: String(error && error.message || error) };
      }
    }
  };
})();
