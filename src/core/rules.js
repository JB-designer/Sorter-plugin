/*
 * 站点规则存储:用户勾选后的字段配置,按 "origin + 路径骨架" 保存。
 *
 * 路径骨架归一化(已与用户确认):
 *   - 忽略 query 与 hash(/search?q=cat 与 ?q=dog 同一规则)
 *   - 纯数字/分页形态的路径段 → "*"(/videos/page/2 与 /videos/page/3 同一规则)
 *   - 其余路径段原样保留(/videos 与 /channels 是两套规则)
 */

const STORAGE_KEY = "cardSorterSiteRules";
export const RULE_VERSION = 1;

export function normalizePathSkeleton(pathname) {
  const segments = String(pathname || "/")
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      const decoded = safeDecode(segment).toLowerCase();
      if (/^\d+$/.test(decoded)) return "*";
      if (/^(?:page|p|paged)[-_]?\d+$/.test(decoded)) return "*";
      if (/^\d{4}-\d{2}(?:-\d{2})?$/.test(decoded)) return "*";
      return decoded;
    });
  return "/" + segments.join("/");
}

export function makeRuleKey(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin.toLowerCase()}${normalizePathSkeleton(parsed.pathname)}`;
  } catch {
    return "";
  }
}

export function makeRule({ url, cardSignature = "", candidates = [], existing = null }) {
  const now = Date.now();
  return {
    version: RULE_VERSION,
    key: makeRuleKey(url),
    origin: safeOrigin(url),
    pathSkeleton: normalizePathSkeleton(safePathname(url)),
    cardSignature,
    slots: candidates.map((candidate) => ({
      id: candidate.id,
      path: candidate.path,
      textIndex: candidate.textIndex ?? null,
      kind: candidate.kind,
      attr: candidate.attr || "",
      pairLabel: candidate.pairLabel || "",
      altPaths: candidate.altPaths || [],
      type: candidate.type,
      siteLabel: candidate.siteLabel || "",
      label: candidate.label || candidate.siteLabel || "",
      canonicalId: candidate.canonicalId || "",
      source: candidate.source || "",
      excluded: Boolean(candidate.excluded),
      suspect: Boolean(candidate.suspect),
      icon: candidate.icon || null,
      enabled: candidate.enabled != null ? Boolean(candidate.enabled) : Boolean(candidate.preChecked)
    })),
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
}

export async function getRuleForUrl(url) {
  const key = makeRuleKey(url);
  if (!key) return null;
  const rules = await readAllRules();
  return rules[key] || null;
}

export async function saveRule(rule) {
  if (!rule?.key) throw new Error("Rule key missing");
  const rules = await readAllRules();
  rules[rule.key] = rule;
  await writeAllRules(rules);
  return rule;
}

export async function deleteRule(key) {
  const rules = await readAllRules();
  if (rules[key]) {
    delete rules[key];
    await writeAllRules(rules);
  }
}

export async function listRules() {
  const rules = await readAllRules();
  return Object.values(rules).sort((left, right) => right.updatedAt - left.updatedAt);
}

async function readAllRules() {
  const storage = globalThis.chrome?.storage?.local;
  if (!storage) return {};
  const stored = await storage.get(STORAGE_KEY);
  return stored?.[STORAGE_KEY] || {};
}

async function writeAllRules(rules) {
  const storage = globalThis.chrome?.storage?.local;
  if (!storage) return;
  await storage.set({ [STORAGE_KEY]: rules });
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function safeOrigin(url) {
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return "";
  }
}

function safePathname(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return "/";
  }
}
