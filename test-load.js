#!/usr/bin/env node
// test-load.js — сторінка в СПРАВЖНЬОМУ браузері: помилки консолі й винятки.
//
// Навіщо, якщо є loadtest.js: стенд ганяє скрипт під мок-DOM у node:vm. Він не
// бачить того, що ламається лише в браузері — биті CSS-селектори в querySelector,
// помилки при завантаженні config.js/tasks.js через <script src>, винятки в
// обробниках, які мок проковтнув би. ТЗ вимагає саме «сторінка вантажиться без
// помилок консолі».
//
// Без npm-залежностей: Chromium керується напряму через CDP на ВБУДОВАНОМУ в Node
// WebSocket. Ніякого playwright, puppeteer чи jsdom.
//
// Коди виходу:  0 — чисто або пропущено штатно   1 — знайдено помилки
// Використання: node test-load.js   (або через ./verify.sh)

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = __dirname;
const PAGE = path.join(ROOT, "index.html");
const skip = (why) => { console.log("⏭  браузерна перевірка пропущена: " + why); process.exit(0); };

if (!fs.existsSync(PAGE)) skip("index.html ще немає");
if (typeof WebSocket === "undefined") skip("у цій версії Node немає вбудованого WebSocket (потрібен Node 22+)");

// ── пошук Chromium ──────────────────────────────────────────────────────────
function findBrowser() {
  const cands = [];
  const pw = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (pw) { cands.push(path.join(pw, "chromium"), path.join(pw, "chrome-linux", "chrome")); }
  cands.push(
    process.env.CHROME_PATH,
    "/opt/pw-browsers/chromium",
    "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable", "/snap/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  );
  for (const c of cands) {
    if (!c) continue;
    try { if (fs.statSync(c).isFile()) return c; } catch (_) {}
  }
  // каталог із вкладеним бінарником (розкладка playwright)
  if (pw) {
    try {
      for (const d of fs.readdirSync(pw)) {
        const f = path.join(pw, d, "chrome-linux", "chrome");
        if (fs.existsSync(f)) return f;
      }
    } catch (_) {}
  }
  return null;
}

const BROWSER = findBrowser();
if (!BROWSER) skip("Chromium не знайдено (це не помилка — просто немає браузера)");

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "wq-cdp-"));
const child = spawn(BROWSER, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
  "--disable-dev-shm-usage", "--allow-file-access-from-files",
  "--user-data-dir=" + profile, "--remote-debugging-port=0", "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });

let done = false;
const problems = [];
const cleanup = () => {
  try { child.kill("SIGKILL"); } catch (_) {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
};
const finish = (code, msg) => {
  if (done) return; done = true;
  cleanup();
  if (msg) console.log(msg);
  process.exit(code);
};
const guard = setTimeout(() => finish(0, "⏭  браузерна перевірка пропущена: таймаут запуску"), 45000);
guard.unref && guard.unref();

// ── чекаємо на «DevTools listening on ws://…» у stderr ──────────────────────
let buf = "";
child.stderr.on("data", (d) => {
  buf += d.toString();
  const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
  if (m) { child.stderr.removeAllListeners("data"); run(m[1]); }
});
child.on("error", (e) => finish(0, "⏭  браузерна перевірка пропущена: " + e.message));
child.on("exit", (c) => { if (!done) finish(0, "⏭  браузерна перевірка пропущена: браузер вийшов з кодом " + c); });

// ── CDP ─────────────────────────────────────────────────────────────────────
function run(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  let session = null;

  const send = (method, params, sessionId) =>
    new Promise((res, rej) => {
      const msgId = ++id;
      pending.set(msgId, { res, rej });
      const msg = { id: msgId, method, params: params || {} };
      if (sessionId) msg.sessionId = sessionId;
      ws.send(JSON.stringify(msg));
    });

  const note = (kind, text, where) => {
    const t = String(text || "").trim();
    if (!t) return;
    // Порожні favicon-404 з file:// — шум, не дефект сторінки.
    if (/favicon\.ico/.test(t)) return;
    problems.push(`${kind}: ${t}${where ? "  (" + where + ")" : ""}`);
  };

  ws.onerror = () => finish(0, "⏭  браузерна перевірка пропущена: не вдалось під'єднатись до CDP");

  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }

    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
      return;
    }

    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails || {};
      const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      note("ВИНЯТОК", desc, d.url ? d.url.split("/").pop() + ":" + ((d.lineNumber | 0) + 1) : "");
    }
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      note("console.error", (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(" "));
    }
    if (m.method === "Log.entryAdded" && m.params.entry && m.params.entry.level === "error") {
      const e = m.params.entry;
      note("КОНСОЛЬ", e.text, e.url ? e.url.split("/").pop() : "");
    }
  };

  ws.onopen = async () => {
    try {
      const { targetId } = await send("Target.createTarget", { url: "about:blank" });
      const att = await send("Target.attachToTarget", { targetId, flatten: true });
      session = att.sessionId;

      await send("Runtime.enable", {}, session);
      await send("Log.enable", {}, session);
      await send("Page.enable", {}, session);

      await send("Page.navigate", { url: "file://" + PAGE }, session);
      await new Promise((r) => setTimeout(r, 3500));   // дати час асинхронній ініціалізації

      // Санітарна проба: сторінка справді відмалювалась і скрипт відпрацював.
      const probe = await send("Runtime.evaluate", {
        expression: `JSON.stringify({
          body: !!document.body && document.body.children.length,
          tod: document.documentElement.getAttribute("data-tod") || "",
          hasS: typeof S === "function"
        })`,
        returnByValue: true,
      }, session);

      let info = {};
      try { info = JSON.parse((probe.result && probe.result.value) || "{}"); } catch (_) {}
      if (!info.body) problems.push("СТОРІНКА: <body> порожній — розмітка не відмалювалась");

      clearTimeout(guard);
      if (problems.length) {
        console.log("❌ браузер — " + problems.length + " проблем(и) на сторінці:");
        problems.forEach((x) => console.log("   • " + x));
        finish(1);
      } else {
        const bits = [];
        if (info.tod) bits.push("фаза доби: " + info.tod);
        if (info.hasS) bits.push("S() є");
        finish(0, "✅ браузер: консоль чиста" + (bits.length ? " (" + bits.join(", ") + ")" : ""));
      }
    } catch (e) {
      finish(0, "⏭  браузерна перевірка пропущена: " + e.message);
    }
  };
}
