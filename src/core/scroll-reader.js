// Advanced Card Sort · https://github.com/JB-designer/Sorter-plugin · MIT License
/*
 * 「按卡片数」读取的规则(不碰页面,方便离线测试)。
 *
 * 原则(James 2026-11-03 定):
 *   - 插件不判断网站是不是"无限滚动",只看有没有页码:没有页码就默认按卡片数读。
 *   - 插件只滚动页面,绝不点击页面上的任何按钮,也不跳转。
 *   - 边滚边记:有的网站会把滚过去的卡片从页面上删掉,所以每一步都把新出现的卡片收下来。
 *   - 滚到底还不够数:如实告诉用户,由用户自己决定要不要在页面上加载更多;
 *     新卡片出现后插件自动接着读,不需要再按按钮。
 */

export const CARD_TARGET_DEFAULT = 100;
export const CARD_TARGET_MAX = 500;
export const CARD_TARGET_MIN = 10;
export const CARD_TARGET_STEP = 50;
export const CARD_PRESETS = [100, 200, 500];

export const RESUME_IDLE_MS = 3000;   // 用户停止手动滚动多久后自动继续
export const WAIT_TIMEOUT_MS = 120000; // 滚到底后等待新卡片的时长(每出现新卡片重新计时)
export const STALL_LIMIT = 3;          // 连续几次滚不动、也没有新卡片 → 当作滚到底
export const IDLE_STEP_LIMIT = 15;     // 一直在滚却连续这么多次没有新卡片 → 网站不再加载,停下

// 卡片数:只取整数,夹在 [MIN, MAX] 之间;读不出数字时退回原值
export function clampTarget(value, fallback = CARD_TARGET_DEFAULT) {
  const n = Math.round(Number(String(value ?? "").replace(/[^\d.]/g, "")));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(CARD_TARGET_MAX, Math.max(CARD_TARGET_MIN, n));
}

export function stepTarget(value, delta) {
  const next = clampTarget(value) + delta;
  return Math.min(CARD_TARGET_MAX, Math.max(CARD_TARGET_MIN, next));
}

// 收卡片:同一张卡片(keyOf 相同)只收一次,按第一次出现的顺序保存
export function createCollector(keyOf) {
  const byKey = new Map();
  return {
    add(items) {
      let added = 0;
      for (const item of items || []) {
        const key = keyOf(item);
        if (byKey.has(key)) continue;
        byKey.set(key, item);
        added += 1;
      }
      return added;
    },
    has(item) {
      return byKey.has(keyOf(item));
    },
    get size() {
      return byKey.size;
    },
    items() {
      return Array.from(byKey.values());
    }
  };
}

// 每滚一步之后决定下一步:
//   "done"     已读满目标张数
//   "bottom"   滚到底(或页面再也滚不动、也没有新卡片),停下来等用户
//   "continue" 接着滚
// stalls:   没有新卡片、并且页面没能再往下滚(或已经在底部)的连续次数
// idleSteps: 没有新卡片的连续次数(页面还在往下滚也算;卡片很高时要滚好几下才出现新卡片)
export function decideAfterStep({ unique, target, added, atBottom, stalls, idleSteps = 0 }) {
  if (unique >= target) return "done";
  if (added > 0) return "continue";
  if (atBottom && stalls >= 2) return "bottom"; // 到底后多等一轮,给网站加载的时间
  if (stalls >= STALL_LIMIT) return "bottom";
  if (idleSteps >= IDLE_STEP_LIMIT) return "bottom";
  return "continue";
}

// 暂停原因 → 自动继续的方式
//   manual: 用户停手 RESUME_IDLE_MS 后自动继续
//   tab:    回到这个标签页后自动继续
export function resumeRule(cause) {
  if (cause === "manual") return { auto: true, afterMs: RESUME_IDLE_MS };
  if (cause === "tab") return { auto: true, whenVisible: true };
  return { auto: false };
}

// 剩余秒数(倒计时显示用,至少 1)
export function secondsLeft(untilMs, nowMs) {
  return Math.max(1, Math.ceil((untilMs - nowMs) / 1000));
}
