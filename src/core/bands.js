/*
 * 自适应分档(方法 F7,团队第 6 轮选定,James 确认 3 倍规则):
 *   - 卡片少于 10 张,或不同数值不超过 7 个 → 不分档,按准确数字排(开关隐藏)。
 *   - 相邻数值相差 3 倍以上一定是分界;一档里最大值不到最小值的 3 倍(数值 ≥ 10 时)。
 *   - 跳跃之间用整齐的等宽档(9,000–9,199 …),约 5–7 档,跨度极大时最多约 12 档;
 *     任何一档不超过约 35% 的卡片;特别大的极少数卡片单独一档。
 *   - 相同数值永远在同一档;结果与卡片的读入顺序无关。
 * 输入只是"有数值的卡片"的数值数组;输出是从小到大的分界值 edges:
 *   档 i = [edges[i-1], edges[i]),第 0 档在最下面,最后一档在最上面。
 * 这个文件只做数学,不碰 DOM,方便测试(tests/bands.test.mjs 含 3,000 个随机列表的性质测试)。
 */

const P = (x) => Number(x.toPrecision(12));

export const MAX_BANDS = 7;
export const BAND_CAP = 12;
export const CROWDED_SHARE = 0.35;
export const EXACT_MIN_CARDS = 10;
export const EXACT_MAX_DISTINCT = 7;

export function bandOf(value, edges) {
  let i = 0;
  while (i < edges.length && value >= edges[i]) i += 1;
  return i;
}

export function distinctSorted(values) {
  return [...new Set(values)].sort((x, y) => x - y);
}

const exactEdges = (values) => distinctSorted(values).slice(1);

// 1、2、2.5、5 × 10^k 中不小于 raw 的最小值,且是 minStep 的整数倍
function niceStep(raw, minStep) {
  raw = Math.max(raw, minStep, 1e-9);
  let k = Math.floor(Math.log10(raw)) - 1;
  for (;;) {
    for (const m of [1, 2, 2.5, 5]) {
      const s = P(m * 10 ** k);
      if (s >= raw - 1e-12 && Math.abs(P(s / minStep) - Math.round(s / minStep)) < 1e-9) return s;
    }
    k += 1;
  }
}

// 网站自己的取整单位:整数时为能整除所有数值的最大 10^k;小数时为最小的小数位
export function sitePrecision(values) {
  if (!values.length) return 1;
  if (!values.every(Number.isInteger)) {
    let p = 1;
    while (p > 1e-4 && !values.every((v) => Math.abs(P(v / p) - Math.round(v / p)) < 1e-9)) p /= 10;
    return p;
  }
  let p = 1;
  while (values.every((v) => v % (p * 10) === 0) && p < 1e12) p *= 10;
  return p;
}

const precisionOf = (values) => {
  const nz = values.filter((v) => v !== 0);
  return sitePrecision(nz.length ? nz : [1]);
};

// a < e <= b 之间最"整"的数,尽量靠近 b
function roundestIn(a, b) {
  for (let k = 15; k >= -4; k -= 1) {
    const p = 10 ** k;
    for (const m of [5, 2, 1]) {
      const q = P(m * p);
      const e = P(Math.floor(b / q) * q);
      if (e > a && e <= b) return e;
    }
  }
  return b;
}

const LADDER = [];
for (let e = -2; e <= 12; e += 1) for (const m of [1, 2, 5]) LADDER.push(P(m * 10 ** e));

function splitEven(gd, parts, prec, vs) {
  const lo = gd[0];
  const hi = gd[gd.length - 1];
  if (vs && vs.every(Number.isInteger) && hi - lo <= 20) {
    // 小整数(如点赞 1–10):每个整数都算"整",按卡片数平均分
    const cumulative = [];
    let run = 0;
    for (const v of gd) { run += vs.filter((x) => x === v).length; cumulative.push(run); }
    const out = [];
    for (let j = 1; j < parts; j += 1) {
      const t = (j * vs.length) / parts;
      let b = 1;
      for (let i = 1; i < gd.length; i += 1) if (Math.abs(cumulative[i - 1] - t) < Math.abs(cumulative[b - 1] - t)) b = i;
      out.push(gd[b]);
    }
    return out;
  }
  const s = niceStep((hi - lo) / parts, prec);
  const out = [];
  for (let e = P((Math.floor(lo / s) + 1) * s); e <= hi; e = P(e + s)) out.push(e);
  return gd.length <= out.length + 1 ? gd.slice(1) : out;
}

function bigJumpCuts(d) {
  const cuts = [];
  for (let i = 1; i < d.length; i += 1) {
    const a = d[i - 1];
    const b = d[i];
    if ((a <= 0 && b > 0) || (a > 0 && b / a >= 3)) cuts.push(roundestIn(a, b));
  }
  return cuts;
}

// 受保护的分界:最大的那次跳跃(≥3 倍),以及任何 ≥10 倍的跳跃(极端大值永远单独一档)
function lockedEdges(d) {
  let bigI = -1;
  let bigR = 0;
  for (let i = 1; i < d.length; i += 1) {
    if (d[i - 1] > 0 && d[i] / d[i - 1] > bigR) { bigR = d[i] / d[i - 1]; bigI = i; }
  }
  const keep = new Set();
  for (let i = 1; i < d.length; i += 1) {
    const a = d[i - 1];
    const b = d[i];
    if ((a <= 0 && b > 0) || (a > 0 && (b / a >= 10 || (i === bigI && b / a >= 3)))) keep.add(roundestIn(a, b));
  }
  return keep;
}

// 方法 F:按跳跃切簇,每簇给足档数(不超过 35%),窄簇用整齐等宽档,宽簇用 1-2-5 阶梯,最后合并到 ≤ maxBands
function methodF(vals, maxBands = MAX_BANDS) {
  const n = vals.length;
  const d = distinctSorted(vals);
  if (n < EXACT_MIN_CARDS || d.length <= EXACT_MAX_DISTINCT) return exactEdges(vals);
  const cuts = bigJumpCuts(d);
  const bounds = [-Infinity, ...cuts, Infinity];
  const clusters = [];
  for (let i = 0; i + 1 < bounds.length; i += 1) clusters.push(vals.filter((v) => v >= bounds[i] && v < bounds[i + 1]));
  const distinctCount = clusters.map((c) => distinctSorted(c).length);
  const need = clusters.map((c, i) => Math.min(distinctCount[i], Math.max(1, Math.ceil(c.length / n / CROWDED_SHARE - 1e-9))));
  let left = Math.max(0, Math.min(maxBands, 6) - need.reduce((x, y) => x + y, 0));
  const order = clusters.map((c, i) => i).sort((x, y) => clusters[y].length - clusters[x].length);
  const give = need.slice();
  while (left > 0) {
    let moved = false;
    for (const i of order) {
      if (left > 0 && give[i] < distinctCount[i] && clusters[i].length / give[i] >= 6) { give[i] += 1; left -= 1; moved = true; }
    }
    if (!moved) break;
  }
  const edges = [...cuts];
  clusters.forEach((cl, i) => {
    const cd = distinctSorted(cl);
    const k = give[i];
    if (k <= 1 || cd.length <= 1) return;
    if (cd.length <= k) { edges.push(...cd.slice(1)); return; }
    const lo = cd[0];
    const hi = cd[cd.length - 1];
    const prec = precisionOf(cl);
    if (lo > 0 && hi / lo > 10) {
      for (const ms of [[1, 2, 5], [1, 3], [1]]) {
        const lad = LADDER.filter((e) => e > lo && e <= hi && ms.includes(Number((e / 10 ** Math.floor(Math.log10(e) + 1e-9)).toPrecision(3))));
        const nb = new Set(cl.map((v) => bandOf(v, lad))).size;
        if (nb <= k + 1 || ms.length === 1) { edges.push(...lad); break; }
      }
      const all = [...edges].sort((x, y) => x - y);
      const groups = new Map();
      for (const v of cl) { const b = bandOf(v, all); if (!groups.has(b)) groups.set(b, []); groups.get(b).push(v); }
      for (const [, vs] of groups) {
        const gd = distinctSorted(vs);
        if (vs.length > CROWDED_SHARE * n && gd.length > 1) edges.push(...splitEven(gd, Math.ceil(vs.length / n / 0.3), sitePrecision(vs), vs));
      }
    } else if (cl.every(Number.isInteger) && hi - lo <= 20) {
      const cumulative = [];
      let run = 0;
      for (const v of cd) { run += cl.filter((x) => x === v).length; cumulative.push(run); }
      for (let j = 1; j < k; j += 1) {
        const target = (j * cl.length) / k;
        let best = 1;
        for (let t = 1; t < cd.length; t += 1) if (Math.abs(cumulative[t - 1] - target) < Math.abs(cumulative[best - 1] - target)) best = t;
        edges.push(cd[best]);
      }
    } else {
      let s = niceStep((hi - lo) / k, prec);
      while (Math.floor(hi / s) - Math.floor(lo / s) + 1 > k) s = niceStep(s * 1.01, prec);
      for (let e = P((Math.floor(lo / s) + 1) * s); e <= hi; e = P(e + s)) edges.push(e);
    }
  });
  let result = [...new Set(edges)].sort((x, y) => x - y);
  const keep = lockedEdges(d);
  const counts = () => {
    const c = Array(result.length + 1).fill(0);
    for (const v of vals) c[bandOf(v, result)] += 1;
    return c;
  };
  // 1) 只有 1 张卡片的档(对齐留下的零头)并入邻档,除非它被受保护的分界隔开
  for (let changed = true; changed;) {
    changed = false;
    const c = counts();
    for (let b = 0; b <= result.length; b += 1) {
      if (c[b] !== 1) continue;
      const below = b > 0 && !keep.has(result[b - 1]) ? b - 1 : -1;
      const above = b < result.length && !keep.has(result[b]) ? b : -1;
      const pick = below >= 0 && (above < 0 || c[b - 1] <= c[b + 1]) ? below : above;
      if (pick < 0) continue;
      if ((pick === b - 1 ? c[b - 1] : c[b + 1]) + 1 > CROWDED_SHARE * n) continue;
      result.splice(pick, 1);
      changed = true;
      break;
    }
  }
  // 2) 合并到 ≤ maxBands:卡片最少的相邻两档,不跨受保护分界,合并后不超过 35%
  for (;;) {
    const c = counts();
    if (c.filter((x) => x > 0).length <= maxBands) break;
    let best = -1;
    let bestC = Infinity;
    for (let i = 0; i < result.length; i += 1) {
      if (keep.has(result[i])) continue;
      const t = c[i] + c[i + 1];
      if (t <= CROWDED_SHARE * n && t < bestC) { bestC = t; best = i; }
    }
    if (best < 0) break;
    result.splice(best, 1);
  }
  // 3) 仍超过 35% 且数值不同的档,用整齐的步长再切
  for (let guard = 0; guard < 5; guard += 1) {
    const groups = new Map();
    for (const v of vals) { const b = bandOf(v, result); if (!groups.has(b)) groups.set(b, []); groups.get(b).push(v); }
    let changed = false;
    for (const [, vs] of groups) {
      const gd = distinctSorted(vs);
      if (vs.length > CROWDED_SHARE * n && gd.length > 1) {
        const add = splitEven(gd, Math.max(2, Math.ceil(vs.length / n / 0.3)), precisionOf(vs), vs);
        const fresh = add.filter((e) => !result.includes(e) && e > gd[0] && e <= gd[gd.length - 1]);
        if (!fresh.length) {
          const mid = [...vs].sort((a, b) => a - b)[Math.floor(vs.length / 2)];
          const lowerVals = gd.filter((v) => v < mid);
          if (lowerVals.length) fresh.push(roundestIn(lowerVals[lowerVals.length - 1], mid));
        }
        if (fresh.length) { result = [...new Set([...result, ...fresh])].sort((a, b) => a - b); changed = true; }
      }
    }
    if (!changed) break;
  }
  return result;
}

const ROUND_M = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 9];

// 不大于 x 的最"整"的数(1–2 位有效数字),且是网站取整单位的整数倍
function niceFloor(x, prec) {
  if (x <= 0) return 0;
  const k = Math.floor(Math.log10(x) + 1e-12);
  for (let kk = k; kk >= k - 1; kk -= 1) {
    for (let i = ROUND_M.length - 1; i >= 0; i -= 1) {
      const e = P(ROUND_M[i] * 10 ** kk);
      if (e <= x + 1e-9 && Math.abs(P(e / prec) - Math.round(e / prec)) < 1e-9) return e;
    }
  }
  return Math.floor(x / prec) * prec;
}

// 3 倍规则:一档里最大值 ≥ 10 且超过最小值的 3 倍 → 违反
export function breaksThreeTimesRule(values) {
  let mn = Infinity;
  let mx = -Infinity;
  for (const v of values) { if (v < mn) mn = v; if (v > mx) mx = v; }
  return mx >= 10 && mx > 3 * mn;
}

function greedy3(vs, prec, lowEdge) {
  const d = distinctSorted(vs);
  const out = [];
  let i = 0;
  let start = Math.max(lowEdge ?? -Infinity, niceFloor(d[0], prec) || d[0]);
  while (i < d.length) {
    let end = niceFloor(3 * Math.max(start, d[i] < 10 ? 0 : start), prec);
    if (start < 10 / 3 && d[d.length - 1] >= 10) end = Math.max(end, 10) > 3 * Math.max(start, 1e-9) ? niceFloor(Math.max(3 * start, 1), 1) : end;
    if (!(end > d[i])) end = P(d[i] + prec);
    while (i < d.length && d[i] < end) i += 1;
    if (i < d.length) {
      const ns = Math.max(end, niceFloor(d[i], prec));
      out.push(ns);
      start = ns;
    }
  }
  return out;
}

function groupsOf(vals, edges) {
  const g = new Map();
  for (const v of vals) {
    const b = bandOf(v, edges);
    if (!g.has(b)) g.set(b, []);
    g.get(b).push(v);
  }
  return g;
}

/**
 * F7:F + 3 倍规则(优先级:不重叠 > 3 倍规则 > 35% > 档数)。返回从小到大的分界值。
 */
export function computeBandEdges(values, maxBands = MAX_BANDS) {
  const vals = (values || []).filter((v) => Number.isFinite(v));
  const n = vals.length;
  const d = distinctSorted(vals);
  if (d.length <= 1) return [];
  if (n < EXACT_MIN_CARDS || d.length <= EXACT_MAX_DISTINCT) return exactEdges(vals);
  let edges = methodF(vals, maxBands);
  const prec = precisionOf(vals);
  const keep = lockedEdges(d);
  // a) 违反 3 倍规则的档,用约 3 倍的整齐步长切开
  for (const [b, vs] of groupsOf(vals, edges)) {
    if (!breaksThreeTimesRule(vs)) continue;
    let mn = Infinity;
    let mx = -Infinity;
    for (const v of vs) { if (v < mn) mn = v; if (v > mx) mx = v; }
    edges.push(...greedy3(vs, prec, b > 0 ? edges[b - 1] : undefined).filter((e) => e > mn && e <= mx));
  }
  edges = [...new Set(edges)].sort((x, y) => x - y);
  // b) 占 ≥20% 卡片的簇至少分 2 档
  const cuts = bigJumpCuts(d);
  const cb = [-Infinity, ...cuts, Infinity];
  for (let i = 0; i + 1 < cb.length; i += 1) {
    const cl = vals.filter((v) => v >= cb[i] && v < cb[i + 1]);
    const cd = distinctSorted(cl);
    if (cl.length >= 0.2 * n && cd.length > 1 && new Set(cl.map((v) => bandOf(v, edges))).size === 1) {
      edges = [...new Set([...edges, ...splitEven(cd, 2, precisionOf(cl), cl)])].sort((x, y) => x - y);
    }
  }
  // c) 35% 保护(只加分界,不会破坏 3 倍规则)
  for (let guard = 0; guard < 5; guard += 1) {
    let changed = false;
    for (const [, vs] of groupsOf(vals, edges)) {
      const gd = distinctSorted(vs);
      if (vs.length > CROWDED_SHARE * n && gd.length > 1) {
        const add = splitEven(gd, Math.max(2, Math.ceil(vs.length / n / 0.3)), precisionOf(vs), vs)
          .filter((e) => !edges.includes(e) && e > gd[0] && e <= gd[gd.length - 1]);
        if (add.length) { edges = [...new Set([...edges, ...add])].sort((x, y) => x - y); changed = true; }
      }
    }
    if (!changed) break;
  }
  // d) 档数:超过 maxBands 时合并卡片最少的相邻两档,前提是不破坏 3 倍规则、35% 和受保护分界
  for (;;) {
    const g = groupsOf(vals, edges);
    if (g.size <= maxBands) break;
    let best = -1;
    let bestC = Infinity;
    for (let i = 0; i < edges.length; i += 1) {
      if (keep.has(edges[i])) continue;
      const merged = [...(g.get(i) || []), ...(g.get(i + 1) || [])];
      if (!merged.length || merged.length > CROWDED_SHARE * n || breaksThreeTimesRule(merged)) continue;
      if (merged.length < bestC) { bestC = merged.length; best = i; }
    }
    if (best < 0) break;
    edges.splice(best, 1);
  }
  // e) 只有 1 张卡片的档并入邻档(同样不破坏上述规则)
  for (let changed = true; changed;) {
    changed = false;
    const g = groupsOf(vals, edges);
    for (const [b, vs] of g) {
      if (vs.length !== 1) continue;
      for (const nb of [b - 1, b + 1]) {
        const edgeI = nb < b ? b - 1 : b;
        if (edgeI < 0 || edgeI >= edges.length || keep.has(edges[edgeI]) || !g.get(nb)) continue;
        const merged = [...vs, ...g.get(nb)];
        if (merged.length > CROWDED_SHARE * n || breaksThreeTimesRule(merged)) continue;
        edges.splice(edgeI, 1);
        changed = true;
        break;
      }
      if (changed) break;
    }
  }
  return edges;
}

/* ---------------- 档的名字(设计师 v6-30 §6.3 + v7 样稿) ---------------- */

// 档的名字写区间,不写某张卡片的数值;结束值 = 下一个分界减去网站的最小单位;
// 只有一个数值的档只写这个数值;最上面一档写到最大值上方的整数(样稿:40,000–49,999)。
export function formatBandNumber(value, prec = 1) {
  const decimals = prec >= 1 ? 0 : Math.min(4, Math.round(-Math.log10(prec)));
  return Number(value).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function roundFloorLabel(x, prec) {
  if (x <= 0) return x;
  const k = Math.floor(Math.log10(x) + 1e-12);
  for (let kk = k; kk >= k - 1; kk -= 1) {
    for (const m of [9, 8, 7, 6, 5, 4, 3, 2.5, 2, 1.5, 1]) {
      const e = P(m * 10 ** kk);
      if (e <= x && Math.abs(P(e / prec) - Math.round(e / prec)) < 1e-9) return e;
    }
  }
  return x;
}

export function describeBands(values, edges) {
  const present = (values || []).filter((v) => Number.isFinite(v));
  const prec = precisionOf(present);
  const groups = groupsOf(present, edges);
  return [...groups.entries()]
    .sort((x, y) => y[0] - x[0])
    .map(([index, vs]) => {
      let mn = Infinity;
      let mx = -Infinity;
      for (const v of vs) { if (v < mn) mn = v; if (v > mx) mx = v; }
      let low = mn;
      let high = mx;
      if (mn !== mx) {
        low = index > 0 ? edges[index - 1] : roundFloorLabel(mn, prec);
        if (low < roundFloorLabel(mn, prec) && low <= mn / 2) low = roundFloorLabel(mn, prec);
        const w = 10 ** Math.floor(Math.log10(Math.max(Math.abs(mx), 1)) + 1e-12);
        const up = roundFloorLabel(mx, prec) === mx ? mx : P(Math.ceil(mx / w - 1e-9) * w - prec);
        if (index === edges.length) {
          high = up >= mx ? up : mx;
        } else {
          high = P(edges[index] - prec);
          if (edges[index] > 2 * mx && up < high && up >= mx) high = up;
        }
      }
      const label = mn === mx ? formatBandNumber(mn, prec) : `${formatBandNumber(low, prec)}–${formatBandNumber(high, prec)}`;
      return { index, min: mn, max: mx, low, high, count: vs.length, label };
    });
}

// 星级评分永远按准确数字排:数值都在 0–10 之内,且带小数或名字像评分
export function looksLikeStarRating(values, label = "") {
  if (!values.length) return false;
  let mx = -Infinity;
  let mn = Infinity;
  for (const v of values) { if (v > mx) mx = v; if (v < mn) mn = v; }
  if (mn < 0 || mx > 10) return false;
  return values.some((v) => !Number.isInteger(v)) || /rating|stars?|评分|評分|星/i.test(String(label));
}
