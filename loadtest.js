#!/usr/bin/env node
// loadtest.js — прогін ГОЛОВНОГО inline-скрипта index.html під мок-DOM.
//
// Навіщо: перевірка синтаксису (`new Function`) НЕ виконує код, тож не бачить
// TDZ / ReferenceError. В еталонному проєкті саме так поклали прод при чистому
// синтаксисі. Цей стенд реально ВИКОНУЄ скрипт (з config.js і tasks.js перед ним)
// на заглушках DOM / localStorage / WebAudio і падає з ненульовим кодом на
// будь-якому винятку верхнього рівня.
//
// Понад еталон: probe-хвіст додатково викликає S() і refresh() — тобто
// покривається не лише ініціалізація, а й обчислювач статистики та рендери.
//
// Використання: node loadtest.js   (або через ./verify.sh)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = __dirname;
const p = (f) => path.join(ROOT, f);

if (!fs.existsSync(p("index.html"))) {
  console.log("⏳ стенд завантаження — index.html ще немає");
  process.exit(0);
}

const HTML = fs.readFileSync(p("index.html"), "utf8");

// ── мок-DOM: елемент, який терпить будь-яке звернення ────────────────────────
const elCache = new Map();
function makeEl(id) {
  return {
    id: id || "",
    tagName: "DIV",
    className: "",
    innerHTML: "",
    outerHTML: "",
    textContent: "",
    value: "",
    checked: false,
    disabled: false,
    scrollTop: 0,
    scrollHeight: 0,
    offsetTop: 0,
    offsetWidth: 0,
    offsetHeight: 0,
    clientHeight: 0,
    clientWidth: 0,
    dataset: {},
    style: new Proxy({}, {
      get: (t, k) => (k === "setProperty" || k === "removeProperty" ? () => {} : (t[k] || "")),
      set: (t, k, v) => { t[k] = v; return true; },
    }),
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, f) { const on = f === undefined ? !this._s.has(c) : !!f; on ? this._s.add(c) : this._s.delete(c); return on; },
      contains(c) { return this._s.has(c); },
    },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    appendChild(c) { return c; }, removeChild(c) { return c; }, insertBefore(c) { return c; },
    append() {}, prepend() {}, replaceChildren() {}, insertAdjacentHTML() {},
    setAttribute() {}, removeAttribute() {}, getAttribute() { return null; }, hasAttribute() { return false; },
    focus() {}, blur() {}, click() {}, scrollIntoView() {}, remove() {}, select() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 100, height: 100 }),
    querySelector: (s) => makeEl(s),
    querySelectorAll: () => [],
    closest: () => null,
    matches: () => false,
    contains: () => false,
    children: [], childNodes: [],
    firstChild: null, lastChild: null,
    firstElementChild: null, lastElementChild: null,
    parentNode: null, parentElement: null,
    nextElementSibling: null, previousElementSibling: null,
  };
}
const el = (id) => {
  if (!elCache.has(id)) elCache.set(id, makeEl(id));
  return elCache.get(id);
};

// ── localStorage на Map ──────────────────────────────────────────────────────
const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear(),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

const documentMock = {
  readyState: "complete",
  documentElement: Object.assign(makeEl("html"), { dataset: {} }),
  body: makeEl("body"),
  head: makeEl("head"),
  title: "",
  cookie: "",
  getElementById: (id) => el(id),
  querySelector: (s) => el(s),
  querySelectorAll: () => [],
  getElementsByClassName: () => [],
  getElementsByTagName: () => [],
  createElement: (t) => Object.assign(makeEl(""), { tagName: String(t).toUpperCase() }),
  createTextNode: (t) => ({ textContent: t }),
  createDocumentFragment: () => makeEl(""),
  addEventListener() {}, removeEventListener() {},
  execCommand() {},
  activeElement: null, hidden: false, visibilityState: "visible",
};

const audioNode = () => ({
  connect: () => audioNode(), disconnect() {}, start() {}, stop() {},
  frequency: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} },
  gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} },
  type: "sine",
});
class AudioContextMock {
  constructor() { this.currentTime = 0; this.destination = audioNode(); this.state = "running"; }
  createOscillator() { return audioNode(); }
  createGain() { return audioNode(); }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

const windowMock = {
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  location: { href: "http://localhost/", search: "", hash: "", pathname: "/", reload() {} },
  history: { replaceState() {}, pushState() {} },
  innerWidth: 1880, innerHeight: 980, devicePixelRatio: 1,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  // ⚠️ rAF синхронний і ПРОБРАСУЄ виняток — інакше помилка в рендері загубилась би
  requestAnimationFrame: (fn) => { fn(0); return 1; },
  cancelAnimationFrame() {},
  setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
  localStorage,
  AudioContext: AudioContextMock, webkitAudioContext: AudioContextMock,
  navigator: { userAgent: "node", language: "uk", clipboard: { writeText: () => Promise.resolve() } },
  open: () => null, alert() {}, confirm: () => true, prompt: () => null,
  scrollTo() {}, getComputedStyle: () => new Proxy({}, { get: () => "" }),
  indexedDB: { open: () => ({ addEventListener() {}, set onsuccess(v) {}, set onerror(v) {}, set onupgradeneeded(v) {} }) },
  document: documentMock, console,
};
windowMock.window = windowMock;
windowMock.self = windowMock;

const sandbox = Object.assign(Object.create(null), windowMock, {
  document: documentMock,
  localStorage,
  console,
  Math, JSON, Date, Object, Array, String, Number, Boolean, RegExp,
  Error, TypeError, RangeError, SyntaxError,
  Map, Set, WeakMap, WeakSet, Promise, Symbol, Proxy, Reflect, Intl,
  parseInt, parseFloat, isNaN, isFinite,
  encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
  Blob: function () {},
  File: function () {},
  FileReader: function () { return { readAsText() {}, addEventListener() {} }; },
  URL: { createObjectURL: () => "", revokeObjectURL() {} },
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve("") }),
});
sandbox.globalThis = sandbox;

const ctx = vm.createContext(sandbox);

// ── дані-конфіг перед головним скриптом ─────────────────────────────────────
for (const f of ["config.js", "tasks.js"]) {
  if (!fs.existsSync(p(f))) continue;
  try { vm.runInContext(fs.readFileSync(p(f), "utf8"), ctx, { filename: f }); }
  catch (e) { console.log("❌ СТЕНД (" + f + "): " + e.message); process.exit(1); }
}

// ── головний inline-скрипт = найдовший без src ──────────────────────────────
const scripts = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (!scripts.length) {
  console.log("⏳ стенд завантаження — inline-скриптів ще немає");
  process.exit(0);
}
const main = scripts.reduce((a, b) => (b.length > a.length ? b : a));

// ⚠️ top-level const/let у vm НЕ стають властивостями контексту — тож дані
// знімаємо probe-хвостом, дописаним до самого скрипта. Він же ВИКЛИКАЄ S() і
// refresh(): без цього стенд перевіряв би лише ініціалізацію, а не обчислювач.
const probe = `
;globalThis.__probe = (function(){
  var r = { keys: 0, metrics: 0, stats: false, render: false, err: null };
  try {
    if (typeof BACKUP_KEYS !== "undefined") r.keys = BACKUP_KEYS.length;
    if (typeof METRICS !== "undefined") r.metrics = Object.keys(METRICS).length;
    if (typeof S === "function") { var s = S(); r.stats = !!s; }
    if (typeof refresh === "function") { refresh(); r.render = true; }
  } catch (e) { r.err = (e && e.stack) ? e.stack : String(e); }
  return r;
})();`;

try {
  vm.runInContext(main + probe, ctx, { filename: "index.html:main" });
} catch (e) {
  const s = e && e.stack ? e.stack.split("\n").slice(0, 5).join("\n") : String(e);
  console.log("❌ СТЕНД: " + s);
  process.exit(1);
}

const r = sandbox.__probe || {};
if (r.err) {
  console.log("❌ СТЕНД (S()/refresh()): " + r.err.split("\n").slice(0, 5).join("\n"));
  process.exit(1);
}

const parts = [];
if (r.keys) parts.push(r.keys + " ключів");
if (r.metrics) parts.push(r.metrics + " метрик");
if (r.stats) parts.push("S() ок");
if (r.render) parts.push("refresh() ок");
console.log("✅ стенд завантаження" + (parts.length ? " (" + parts.join(", ") + ")" : ""));
