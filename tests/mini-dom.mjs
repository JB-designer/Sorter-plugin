/*
 * 迷你 DOM 测试替身:实现 alignment-engine 用到的 DOM 子集。
 * 选择器只需支持 "复合选择器逗号列表"(引擎不用后代组合器):
 *   tag、[attr]、[attr='v']、[attr*='v' i] 及其组合,如 img[src*='icon' i]
 */

class MiniNode {
  constructor() {
    this.parentNode = null;
  }
  get parentElement() {
    return this.parentNode instanceof MiniElement ? this.parentNode : null;
  }
  get nextSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  get previousSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) - 1] || null;
  }
}

export class MiniText extends MiniNode {
  constructor(text) {
    super();
    this.nodeType = 3;
    this.textContent = String(text);
  }
}

export class MiniElement extends MiniNode {
  constructor(tag, attrs = {}) {
    super();
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.attrs = new Map(Object.entries(attrs).map(([k, v]) => [k.toLowerCase(), String(v)]));
    this.childNodes = [];
  }

  append(...nodes) {
    for (const node of nodes) {
      const child = typeof node === "string" ? new MiniText(node) : node;
      child.parentNode = this;
      this.childNodes.push(child);
    }
    return this;
  }

  get id() { return this.attrs.get("id") || ""; }
  get className() { return this.attrs.get("class") || ""; }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { const c = this.children; return c[c.length - 1] || null; }
  get nextElementSibling() {
    if (!this.parentElement) return null;
    const siblings = this.parentElement.children;
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  get previousElementSibling() {
    if (!this.parentElement) return null;
    const siblings = this.parentElement.children;
    return siblings[siblings.indexOf(this) - 1] || null;
  }

  get textContent() {
    let text = "";
    for (const node of this.childNodes) {
      text += node.nodeType === 3 ? node.textContent : node.textContent;
      text += " ";
    }
    return text;
  }

  getAttribute(name) {
    return this.attrs.has(String(name).toLowerCase()) ? this.attrs.get(String(name).toLowerCase()) : null;
  }

  get attributes() {
    return [...this.attrs.entries()].map(([name, value]) => ({ name, value }));
  }

  contains(other) {
    let node = other;
    while (node) {
      if (node === this) return true;
      node = node.parentNode;
    }
    return false;
  }

  matches(selector) {
    return parseSelectorList(selector).some((compound) => matchesCompound(this, compound));
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.nodeType === 1 && node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  *descendants() {
    for (const child of this.children) {
      yield child;
      yield* child.descendants();
    }
  }

  querySelectorAll(selector) {
    const compounds = parseSelectorList(selector);
    const matches = [];
    for (const element of this.descendants()) {
      if (compounds.some((compound) => matchesCompound(element, compound))) matches.push(element);
    }
    return matches;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  compareDocumentPosition(other) {
    let root = this;
    while (root.parentNode) root = root.parentNode;
    const order = [root, ...root.descendants()];
    const mine = order.indexOf(this);
    const theirs = order.indexOf(other);
    if (theirs > mine) return 4;  // DOCUMENT_POSITION_FOLLOWING
    if (theirs < mine) return 2;  // DOCUMENT_POSITION_PRECEDING
    return 0;
  }
}

export function el(tag, attrs = {}, children = []) {
  const element = new MiniElement(tag, attrs);
  element.append(...children);
  return element;
}

export function makeDocument(rootElement, url = "https://example.test/list") {
  return {
    location: { href: url },
    body: rootElement,
    querySelectorAll: (selector) => rootElement.querySelectorAll(selector),
    querySelector: (selector) => rootElement.querySelector(selector)
  };
}

/* ------------------------- 选择器解析 ------------------------- */

function parseSelectorList(selector) {
  return String(selector).split(",").map(parseCompound).filter(Boolean);
}

function parseCompound(part) {
  const text = part.trim();
  if (!text) return null;
  if (text === "*") return { tag: "", attrs: [] };
  const compound = { tag: "", attrs: [] };
  const tagMatch = text.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
  if (tagMatch) compound.tag = tagMatch[0].toLowerCase();
  const attrRe = /\[([^\]=~*|^$]+?)(?:([*^$|~]?=)\s*(['"])(.*?)\3)?(\s+i)?\]/g;
  let match;
  while ((match = attrRe.exec(text))) {
    compound.attrs.push({
      name: match[1].trim().toLowerCase(),
      op: match[2] || "",
      value: match[4] ?? null,
      insensitive: Boolean(match[5])
    });
  }
  return compound;
}

function matchesCompound(element, compound) {
  if (compound.tag && element.tagName.toLowerCase() !== compound.tag) return false;
  for (const attr of compound.attrs) {
    const actual = element.getAttribute(attr.name);
    if (actual == null) return false;
    if (!attr.op) continue;
    const left = attr.insensitive ? actual.toLowerCase() : actual;
    const right = attr.insensitive ? String(attr.value).toLowerCase() : String(attr.value);
    if (attr.op === "=" && left !== right) return false;
    if (attr.op === "*=" && !left.includes(right)) return false;
    if (attr.op === "^=" && !left.startsWith(right)) return false;
    if (attr.op === "$=" && !left.endsWith(right)) return false;
  }
  return true;
}
