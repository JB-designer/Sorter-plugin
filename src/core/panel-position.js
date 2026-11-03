// Advanced Card Sort · https://github.com/JB-designer/Sorter-plugin · MIT License
/*
 * 悬浮面板 / 收起胶囊的位置(可拖动)。
 *
 * 位置用"靠哪条边 + 离那条边多远"记:
 *   h: "left" | "right",dx = 元素离那条竖边的距离
 *   v: "top"  | "bottom",dy = 元素离那条横边的距离
 * 胶囊和展开的面板共用这一个位置:靠右就右边对齐,靠下就底边对齐(面板往上长)。
 * 每次显示都把位置夹回窗口内,但只在用户松手时才保存,窗口变小不会改掉存的位置。
 * 按"网址去掉页码"(和本站排序规则同一个 key)分别记;新页面用默认的右上角。
 */

export const STORAGE_KEY = "cardSorterPanelPositions";
export const MARGIN = 16;
export const MAX_SAVED = 300;

export function defaultAnchor() {
  return { h: "right", dx: MARGIN, v: "top", dy: MARGIN };
}

export function isAnchor(a) {
  return Boolean(a) && (a.h === "left" || a.h === "right") && (a.v === "top" || a.v === "bottom") &&
    Number.isFinite(a.dx) && Number.isFinite(a.dy);
}

function clamp(n, min, max) {
  if (max < min) return min;
  return Math.min(Math.max(n, min), max);
}

// 拖动中:元素左上角跟着鼠标,但整个元素不出窗口
export function clampTopLeft(left, top, width, height, viewW, viewH) {
  return {
    left: clamp(left, 0, viewW - width),
    top: clamp(top, 0, viewH - height)
  };
}

// 松手时:按元素在窗口哪一半决定靠哪条边。竖直方向看把手(元素最上面 ~20px)在上半还是下半。
export function anchorFromRect(rect, viewW, viewH) {
  var centerX = rect.left + rect.width / 2;
  var handleY = rect.top + Math.min(20, rect.height / 2);
  var h = centerX > viewW / 2 ? "right" : "left";
  var v = handleY > viewH / 2 ? "bottom" : "top";
  return {
    h: h,
    dx: Math.max(0, Math.round(h === "right" ? viewW - rect.right : rect.left)),
    v: v,
    dy: Math.max(0, Math.round(v === "bottom" ? viewH - rect.bottom : rect.top))
  };
}

// 显示时:把位置换成 CSS(left/right/top/bottom),并夹回窗口内。
// height 用把手高度(最多 40px)来夹,这样高面板也至少把把手留在窗口里;
// maxHeight 让面板不超出窗口:靠顶边时往下长,靠底边时往上长,顶边(把手)始终在窗口内。
export function styleFromAnchor(anchor, width, height, viewW, viewH) {
  var a = isAnchor(anchor) ? anchor : defaultAnchor();
  var dx = clamp(a.dx, 0, viewW - width);
  var dy = clamp(a.dy, 0, viewH - Math.min(height, 40));
  var maxHeight = Math.max(40, viewH - dy - MARGIN);
  return {
    left: a.h === "left" ? dx + "px" : "auto",
    right: a.h === "right" ? dx + "px" : "auto",
    top: a.v === "top" ? dy + "px" : "auto",
    bottom: a.v === "bottom" ? dy + "px" : "auto",
    maxHeight: maxHeight + "px"
  };
}

export async function loadAnchor(key) {
  if (!key) return null;
  try {
    var all = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || {};
    var entry = all[key];
    return entry && isAnchor(entry.anchor) ? entry.anchor : null;
  } catch {
    return null;
  }
}

export async function saveAnchor(key, anchor) {
  if (!key || !isAnchor(anchor)) return;
  try {
    var all = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || {};
    all[key] = { anchor: anchor, at: Date.now() };
    var keys = Object.keys(all);
    if (keys.length > MAX_SAVED) {
      keys.sort(function (a, b) { return (all[a].at || 0) - (all[b].at || 0); })
        .slice(0, keys.length - MAX_SAVED)
        .forEach(function (k) { delete all[k]; });
    }
    await chrome.storage.local.set({ [STORAGE_KEY]: all });
  } catch {
    // 存不了位置不影响排序;下次从右上角开始
  }
}
