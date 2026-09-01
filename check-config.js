#!/usr/bin/env node
// check-config.js — вартовий цілісності реєстрів, контракту метрик і небезпечних патернів.
//
// Ловить те, що не ловлять ні синтаксис, ні стенд завантаження:
//   • одруківку в ACHIEVEMENTS[].metric — досягнення мовчки показувало б 0 назавжди;
//   • ключ localStorage, не оголошений у WQ_KEYS — він не потрапив би в бекап;
//   • toISOString() як джерело дати — UTC-зсув ламає день і місяць уночі;
//   • display: в ID-селекторі без парного #id.hidden — .hidden перестає ховати;
//   • innerHTML з полем задачі без esc() — XSS через назву, яку вводить користувач;
//   • '+'-конкатенацію HTML із коментарем у кінці рядка — з'їдає '+', панель тихо зникає.
//
// Використання: node check-config.js   (або через ./verify.sh)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = __dirname;
const p = (f) => path.join(ROOT, f);
const errors = [];
const notes = [];
const err = (m) => errors.push(m);

// ─────────────────────────────────────────────────────────────────────────────
// 1. РЕЄСТРИ З config.js
// ─────────────────────────────────────────────────────────────────────────────
let CFG = null;
if (fs.existsSync(p("config.js"))) {
  const sandbox = { console, Math, JSON, Date, Object, Array, String, Number, RegExp };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  const probe = `
;globalThis.__cfg = {
  DEFAULT_DIFFICULTIES: typeof DEFAULT_DIFFICULTIES !== "undefined" ? DEFAULT_DIFFICULTIES : null,
  LEVELS:       typeof LEVELS       !== "undefined" ? LEVELS       : null,
  LEAGUES:      typeof LEAGUES      !== "undefined" ? LEAGUES      : null,
  METRICS:      typeof METRICS      !== "undefined" ? METRICS      : null,
  ACHIEVEMENTS: typeof ACHIEVEMENTS !== "undefined" ? ACHIEVEMENTS : null,
  RECORD_KEYS:  typeof RECORD_KEYS  !== "undefined" ? RECORD_KEYS  : null,
  PERIODS:      typeof PERIODS      !== "undefined" ? PERIODS      : null
};`;
  try {
    vm.runInContext(fs.readFileSync(p("config.js"), "utf8") + probe, ctx, { filename: "config.js" });
    CFG = sandbox.__cfg;
  } catch (e) {
    err("config.js не виконується: " + e.message);
  }
}

if (CFG) {
  const { DEFAULT_DIFFICULTIES, LEVELS, LEAGUES, METRICS, ACHIEVEMENTS, RECORD_KEYS } = CFG;

  // — складності —
  if (Array.isArray(DEFAULT_DIFFICULTIES)) {
    const seen = new Set();
    DEFAULT_DIFFICULTIES.forEach((d, i) => {
      if (!d || typeof d.id !== "string" || !d.id) err(`DEFAULT_DIFFICULTIES[${i}]: порожній або нерядковий id`);
      else if (seen.has(d.id)) err(`DEFAULT_DIFFICULTIES: дубль id "${d.id}"`);
      else seen.add(d.id);
      if (d && typeof d.xp !== "number") err(`DEFAULT_DIFFICULTIES[${i}] (${d && d.id}): xp має бути числом`);
      if (d && !/^#[0-9a-fA-F]{6}$/.test(String(d.color || ""))) err(`DEFAULT_DIFFICULTIES[${i}] (${d && d.id}): color має бути #rrggbb`);
      if (d && typeof d.order !== "number") err(`DEFAULT_DIFFICULTIES[${i}] (${d && d.id}): order має бути числом`);
    });
    notes.push(`складностей: ${DEFAULT_DIFFICULTIES.length}`);
  }

  // — рівні: масив порогів, строго зростає, починається з 0 —
  if (Array.isArray(LEVELS)) {
    if (LEVELS[0] !== 0) err("LEVELS[0] має дорівнювати 0 (перший рівень починається з нуля XP)");
    for (let i = 1; i < LEVELS.length; i++) {
      if (typeof LEVELS[i] !== "number") { err(`LEVELS[${i}]: не число`); break; }
      if (LEVELS[i] <= LEVELS[i - 1]) { err(`LEVELS[${i}] = ${LEVELS[i]} не більший за LEVELS[${i - 1}] = ${LEVELS[i - 1]}`); break; }
    }
    notes.push(`рівнів: ${LEVELS.length} (макс ${LEVELS[LEVELS.length - 1]} XP)`);
    if (Array.isArray(LEAGUES) && LEAGUES.length && LEVELS.length % LEAGUES.length !== 0)
      notes.push(`⚠ рівнів (${LEVELS.length}) не ділиться націло на ліги (${LEAGUES.length})`);
  }

  // — контракт метрик: ключ досягнення мусить існувати —
  if (METRICS && ACHIEVEMENTS) {
    const known = Object.keys(METRICS);
    const matches = (k) => known.some((m) => (m.endsWith(".*") ? k.startsWith(m.slice(0, -1)) : m === k));
    const seen = new Set();
    ACHIEVEMENTS.forEach((a, i) => {
      if (!a || typeof a.id !== "string" || !a.id) err(`ACHIEVEMENTS[${i}]: порожній id`);
      else if (seen.has(a.id)) err(`ACHIEVEMENTS: дубль id "${a.id}"`);
      else seen.add(a.id);
      if (!a) return;
      if (typeof a.metric !== "string" || !matches(a.metric))
        err(`ACHIEVEMENTS "${a.id}": metric "${a.metric}" не оголошено в METRICS`);
      if (!Array.isArray(a.tiers) || !a.tiers.length) err(`ACHIEVEMENTS "${a.id}": tiers має бути непорожнім масивом`);
      else for (let j = 1; j < a.tiers.length; j++)
        if (!(a.tiers[j] > a.tiers[j - 1])) { err(`ACHIEVEMENTS "${a.id}": tiers не зростають на позиції ${j}`); break; }
      for (const f of ["icon", "title", "desc"]) if (!a[f]) err(`ACHIEVEMENTS "${a.id}": немає поля ${f}`);
    });
    notes.push(`метрик: ${known.length}, досягнень: ${ACHIEVEMENTS.length}`);
  }

  if (Array.isArray(RECORD_KEYS) && METRICS) {
    const known = Object.keys(METRICS);
    RECORD_KEYS.forEach((k) => { if (!known.includes(k)) err(`RECORD_KEYS: "${k}" не оголошено в METRICS`); });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. КЛЮЧІ localStorage: усе, що згадується, мусить бути в WQ_KEYS
// ─────────────────────────────────────────────────────────────────────────────
let HTML = "";
if (fs.existsSync(p("index.html"))) {
  HTML = fs.readFileSync(p("index.html"), "utf8");

  const block = HTML.match(/const\s+WQ_KEYS\s*=\s*\{[\s\S]*?\n\s*\};/);
  const used = new Set([...HTML.matchAll(/["'`](workquest_[a-z0-9_]+)["'`]/gi)].map((m) => m[1]));
  if (block) {
    const declared = new Set([...block[0].matchAll(/["'`](workquest_[a-z0-9_]+)["'`]/gi)].map((m) => m[1]));
    for (const k of used) if (!declared.has(k)) err(`ключ "${k}" використовується, але не оголошений у WQ_KEYS (не потрапить у BACKUP_KEYS)`);
    for (const k of declared) if (!/_v\d+$/.test(k)) err(`ключ "${k}" без версійного суфікса _vN`);
    notes.push(`ключів localStorage: ${declared.size}`);
  } else if (used.size) {
    err("ключі workquest_* уживаються, але реєстру WQ_KEYS не знайдено");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. ГРЕП-ЗАБОРОНИ
// ─────────────────────────────────────────────────────────────────────────────
const lines = HTML ? HTML.split("\n") : [];
const at = (i) => `index.html:${i + 1}`;

lines.forEach((ln, i) => {
  const code = ln.trim();
  if (code.startsWith("//") || code.startsWith("*")) return;

  // ⚠️ toISOString() = UTC. Для Києва з 00:00 до 03:00 день і МІСЯЦЬ «попередні».
  // Дозволено лише для мітки часу бекапу (__ts) — вона не дата доби.
  if (/\.toISOString\s*\(/.test(ln) && !/__ts/.test(ln))
    err(`${at(i)}: toISOString() поза __ts бекапу — джерело дати тільки todayKey()/dayKeyOf()`);

  // ⚠️ new Date("2026-08-31") = UTC-північ. Потрібен parseKey() із "T00:00:00".
  if (/new\s+Date\s*\(\s*["'`]\d{4}-\d{2}-\d{2}["'`]\s*\)/.test(ln))
    err(`${at(i)}: new Date("YYYY-MM-DD") парситься як UTC — використовуй parseKey()`);

  // ⚠️ Коментар після '+' у конкатенації з'їдає '+' і половина панелі тихо зникає.
  if (/["'`]\s*\+\s*\/\//.test(ln))
    err(`${at(i)}: коментар одразу після '+' у конкатенації — збирай HTML масивом і .join("")`);

  // ⚠️ Порожній catch маскує TDZ як «дані зникли».
  if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(ln))
    err(`${at(i)}: порожній catch — логуй помилку, інакше баг стане невидимим`);
});

// ⚠️ .hidden не спрацює, якщо display заданий ID-селектором сильнішої специфічності.
if (HTML) {
  const style = (HTML.match(/<style[^>]*>([\s\S]*?)<\/style>/) || [])[1] || "";
  const withDisplay = new Set();
  for (const m of style.matchAll(/#([a-zA-Z0-9_-]+)\s*\{[^}]*display\s*:/g)) withDisplay.add(m[1]);
  const paired = new Set();
  for (const m of style.matchAll(/#([a-zA-Z0-9_-]+)\.hidden\b/g)) paired.add(m[1]);
  for (const id of withDisplay)
    if (!paired.has(id)) err(`CSS: #${id} задає display в ID-селекторі без парного #${id}.hidden{display:none} — .hidden не спрацює`);
}

// ⚠️ XSS: назву й нотатку задачі вводить користувач.
if (HTML) {
  for (const m of HTML.matchAll(/innerHTML\s*=\s*([^\n;]+)/g)) {
    const rhs = m[1];
    if (/\b(t|task)\.(title|note)\b/.test(rhs) && !/\besc(Attr)?\s*\(/.test(rhs))
      err(`innerHTML з полем задачі без esc(): ${rhs.trim().slice(0, 80)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ПІДСУМОК
// ─────────────────────────────────────────────────────────────────────────────
if (errors.length) {
  console.log("❌ вартовий конфігурації — " + errors.length + " проблем(и):");
  errors.forEach((e) => console.log("   • " + e));
  process.exit(1);
}
if (!CFG && !HTML) { console.log("⏳ вартовий конфігурації — файлів ще немає"); process.exit(0); }
console.log("✅ вартовий конфігурації" + (notes.length ? " (" + notes.join(", ") + ")" : ""));
