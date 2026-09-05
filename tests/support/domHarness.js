// A DOM small enough to run the check-in page's own JavaScript in Node, and
// real enough that a bug in that JavaScript actually shows up. Not a browser —
// it only implements what checkin.js touches — but it exercises the code path a
// scanner drives, which no other test here does.

class El {
  constructor(tag, attrs = {}) {
    this.tagName = (tag || 'DIV').toUpperCase();
    this.dataset = {};
    this.children = [];
    this.listeners = {};
    this.className = '';
    this.value = '';
    this.textContent = '';
    this.disabled = false;
    this.title = '';
    this.parent = null;
    this.attrs = {};
    Object.assign(this, attrs);
  }

  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }

  dispatch(type, event = {}) {
    const e = Object.assign({
      type,
      target: this,
      preventDefault() { e.defaultPrevented = true; },
      defaultPrevented: false,
      closest: () => null,
    }, event);
    (this.listeners[type] || []).forEach((fn) => fn(e));
    return e;
  }

  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(c)); }
  replaceChildren(...cs) { this.children = []; cs.forEach((c) => this.appendChild(c)); }
  focus() { global.document.activeElement = this; }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  querySelector(sel) { return this.find(sel); }
  querySelectorAll(sel) { return this.findAll(sel); }

  matches(sel) {
    if (sel.startsWith('[') && sel.endsWith(']')) {
      const inner = sel.slice(1, -1);
      if (inner.includes('=')) {
        const [k, raw] = inner.split('=');
        const want = raw.replace(/^"|"$/g, '');
        if (k === 'name') return this.name === want;
        return this.dataset[camel(k.replace(/^data-/, ''))] === want;
      }
      return camel(inner.replace(/^data-/, '')) in this.dataset;
    }
    if (sel.startsWith('#')) return this.id === sel.slice(1);
    if (sel.startsWith('.')) return String(this.className).split(/\s+/).includes(sel.slice(1));
    return this.tagName === sel.toUpperCase();
  }

  find(sel) {
    for (const c of this.children) {
      if (c.matches(sel)) return c;
      const deep = c.find(sel);
      if (deep) return deep;
    }
    return null;
  }

  findAll(sel, acc = []) {
    this.children.forEach((c) => {
      if (c.matches(sel)) acc.push(c);
      c.findAll(sel, acc);
    });
    return acc;
  }

  // Rough but enough to assert on what the operator would be reading.
  get text() {
    if (this.children.length === 0) return this.textContent;
    return this.children.map((c) => c.text).filter(Boolean).join(' | ');
  }
}

function camel(s) {
  return s.replace(/-([a-z])/g, (m, c) => c.toUpperCase());
}

function buildDocument(root) {
  const doc = {
    activeElement: null,
    listeners: {},
    body: new El('body'),
    addEventListener(type, fn) { (doc.listeners[type] = doc.listeners[type] || []).push(fn); },
    dispatch(type, event = {}) {
      const e = Object.assign({ type, preventDefault() {}, closest: () => null }, event);
      (doc.listeners[type] || []).forEach((fn) => fn(e));
    },
    querySelector: (sel) => (root.matches(sel) ? root : root.find(sel)),
    querySelectorAll: (sel) => root.findAll(sel),
    createElement: (tag) => new El(tag),
  };
  return doc;
}

module.exports = { El, buildDocument };
