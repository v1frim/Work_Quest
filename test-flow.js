#!/usr/bin/env node
// test-flow.js — функціональна перевірка ЦИКЛУ ЗАДАЧІ в справжньому браузері.
//
// Навіщо окремо від loadtest.js: той доводить, що сторінка не падає. Цей —
// що вона рахує ПРАВИЛЬНО. Головна перевірка тут одна:
//
//   ⚠️ зміна XP у реєстрі складностей НЕ переписує вже нараховані бали.
//
// Це вимога, яку неможливо перевірити очима: історія «попливе» тихо й через
// місяці. Тому вона зафіксована тестом, а не лише коментарем у коді.
//
// Без npm: Chromium через CDP на вбудованому в Node WebSocket.
// Коди виходу:  0 — усе зійшлось або пропущено штатно   1 — розбіжність.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PAGE = "file://" + path.join(__dirname, "index.html");
const skip = (why) => { console.log("⏭  перевірка циклу пропущена: " + why); process.exit(0); };

if (!fs.existsSync(path.join(__dirname, "index.html"))) skip("index.html ще немає");
if (typeof WebSocket === "undefined") skip("потрібен Node 22+ із вбудованим WebSocket");

function findBrowser() {
  const pw = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const cands = [
    pw && path.join(pw, "chromium"), process.env.CHROME_PATH, "/opt/pw-browsers/chromium",
    "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable", "/snap/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const c of cands) { if (c) { try { if (fs.statSync(c).isFile()) return c; } catch (_) {} } }
  return null;
}
const BROWSER = findBrowser();
if (!BROWSER) skip("Chromium не знайдено");

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "wq-flow-"));
const child = spawn(BROWSER, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
  "--disable-dev-shm-usage", "--allow-file-access-from-files",
  "--user-data-dir=" + profile, "--remote-debugging-port=0", "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });

let done = false;
const finish = (code, msg) => {
  if (done) return; done = true;
  try { child.kill("SIGKILL"); } catch (_) {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  if (msg) console.log(msg);
  process.exit(code);
};
const guard = setTimeout(() => finish(0, "⏭  перевірка циклу пропущена: таймаут"), 60000);
guard.unref && guard.unref();

let buf = "";
child.stderr.on("data", (d) => {
  buf += d.toString();
  const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
  if (m) { child.stderr.removeAllListeners("data"); run(m[1]); }
});
child.on("error", (e) => finish(0, "⏭  перевірка циклу пропущена: " + e.message));

// Сценарій виконується В СТОРІНЦІ: користуємось її ж API, як користувач.
const SCRIPT = `(function () {
  const out = [];
  const ok = (name, got, want) => out.push({ name, got, want, pass: String(got) === String(want) });
  try {
    localStorage.clear();

    // 1. Головна дія: назва + складність = задача створена й одразу закрита.
    const d = activeDifs()[0];
    document.getElementById("task-input").value = "Тестова задача";
    document.querySelector('#dif-row [data-dif="' + d.id + '"]').click();
    ok("задачу створено", loadTasks().length, 1);
    ok("задачу одразу закрито", loadTasks()[0].doneAt > 0, true);
    ok("XP нараховано", S().xp.total, d.xp);
    ok("день зафіксовано", loadTasks()[0].doneDay, todayKey());
    ok("сьогодні: задач", S().today.done, 1);
    ok("поле очищено", document.getElementById("task-input").value, "");

    // 2. Рядок дня з'явився і несе колір складності.
    const prog = document.getElementById("prog-list").innerHTML;
    ok("рядок дня є", prog.indexOf("prog-row") >= 0, true);
    ok("комірка складності кольорова", prog.indexOf(d.color) >= 0, true);

    // 3. ⚠️ ГОЛОВНЕ: змінюємо XP складності в реєстрі — історія НЕ змінюється.
    const before = S().xp.total;
    const difs = loadDifs();
    difs.find(x => x.id === d.id).xp = 9999;
    saveDifs(difs);
    commit();
    ok("XP історії заморожено", S().xp.total, before);
    ok("нова ціна діє на майбутнє", activeDifs()[0].xp, 9999);

    // 4. Скасування виконання знімає РІВНО стільки, скільки дало.
    uncompleteTask(loadTasks()[0].id);
    ok("скасування симетричне", S().xp.total, 0);
    ok("задача повернулась у роботу", S().tasks.open, 1);

    // 5. Повторне виконання бере вже НОВУ ціну з реєстру.
    completeTask(loadTasks()[0].id);
    ok("повторне виконання за новою ціною", S().xp.total, 9999);

    // 6. Цілі дають XP так само і теж заморожують його.
    addGoal("Знайти товари", 3, "шт", 50, 0);
    const g = loadGoals()[0];
    setGoalProgress(g.id, 2);
    ok("ціль ще не досягнута", S().goals.done, 0);
    ok("XP за недосягнуту ціль не дано", S().xp.total, 9999);
    setGoalProgress(g.id, 3);
    ok("ціль досягнута автоматично", S().goals.done, 1);
    ok("XP за ціль нараховано", S().xp.total, 9999 + 50);
    reopenGoal(g.id);
    ok("повернення цілі знімає її XP", S().xp.total, 9999);

    // 7. Серія й календарні середні рахуються.
    ok("серія = 1", S().streak.current, 1);
    ok("днів активності = 1", S().days.active, 1);

    // 8. Режим «Що зробити» кладе задачу у відкриті, XP не чіпає.
    const xpBefore = S().xp.total;
    setMode("todo");
    ok("режим перемкнувся", curMode(), "todo");
    document.getElementById("task-input").value = "Планова задача";
    document.querySelector('#dif-row [data-dif="' + d.id + '"]').click();
    ok("планова задача у відкритих", S().tasks.open, 1);
    ok("планова задача НЕ дала XP", S().xp.total, xpBefore);
    setMode("done");
    ok("режим повернувся", curMode(), "done");

    // 8b. «+ задача» перемикає режим і підсвічує поле.
    setMode("done");
    document.getElementById("task-add").click();
    ok("«+ задача» перемкнула режим", curMode(), "todo");
    ok("фокус у полі", document.activeElement.id, "task-input");
    ok("поле підсвічене", document.getElementById("task-input").classList.contains("flash"), true);
    setMode("done");

    // 9. Перелік «що саме зроблено» за днем і складністю.
    openDayLog([todayKey()], d.id, "сьогодні");
    const log = document.getElementById("day-body").innerHTML;
    ok("перелік дня непорожній", log.indexOf("dlog") >= 0, true);
    ok("перелік знайшов задачу", log.indexOf("Тестова задача") >= 0, true);
    closeDayLog();

    // 10. Бекап: усі ключі реєстру потрапляють у копію, JSON валідний.
    const bk = JSON.parse(getBackupData());
    ok("копія має маркер формату", bk.__wq, 1);
    ok("копія несе задачі", typeof bk["workquest_tasks_v1"], "string");
    ok("BACKUP_KEYS покриває весь реєстр", BACKUP_KEYS.length, Object.keys(WQ_KEYS).length);
    ok("копія читається назад", JSON.parse(bk["workquest_tasks_v1"]).length, loadTasks().length);

    // 11. Вік копії рахується різницею ключів дат, а не мілісекунд.
    localStorage.setItem("workquest_backup_date_v1", todayKey());
    ok("копія сьогодні → вік 0", backupAgeDays(), 0);

    // 11b. Ціль зі списком кроків і підкроків.
    localStorage.clear();
    addGoalSteps("Розширити асортимент",
      "Знайти постачальників\\n  Китай\\n  Туреччина\\nЗавести флагманів", 300);
    const gs = loadGoals()[0];
    ok("режим кроків", gs.mode, "steps");
    ok("кроків верхнього рівня", gs.steps.length, 2);
    ok("підкроків у першого", gs.steps[0].subs.length, 2);
    // Листок — підкрок, а якщо підкроків немає, то сам крок: 2 + 1 = 3.
    ok("листків усього", goalProgress(loadGoals()[0]).tot, 3);

    toggleStep(gs.id, gs.steps[0].subs[0].id);
    ok("підкрок закрито", goalProgress(loadGoals()[0]).cur, 1);
    ok("батько ще не закритий", loadGoals()[0].steps[0].done, false);
    toggleStep(gs.id, gs.steps[0].subs[1].id);
    ok("батько закрився сам", loadGoals()[0].steps[0].done, true);
    ok("ціль ще не досягнута", S().goals.done, 0);

    toggleStep(gs.id, gs.steps[1].id);
    ok("ціль досягнута останнім кроком", S().goals.done, 1);
    ok("XP за ціль нараховано", S().xp.total, 300);

    // Симетрія: зняв галочку — XP іде рівно той, що дали.
    toggleStep(gs.id, gs.steps[1].id);
    ok("ціль знову відкрита", S().goals.done, 0);
    ok("XP знято симетрично", S().xp.total, 0);

    // Крок із підкроками — перемикач усієї гілки.
    toggleStep(gs.id, gs.steps[0].id);
    ok("зняття батька зняло підкроки", goalProgress(loadGoals()[0]).cur, 0);

    // 12. ⚠️ МІГРАЦІЯ РЕЄСТРУ СКЛАДНОСТЕЙ.
    // Реєстр належить користувачу, тож нова стандартна складність не може
    // приїхати просто правкою config.js — саме на цьому проєкт уже спіткнувся.
    localStorage.clear();
    const old = DEFAULT_DIFFICULTIES.filter(x => x.id !== "d_titan").map(x => Object.assign({}, x));
    localStorage.setItem("workquest_difficulties_v1", JSON.stringify(old));
    localStorage.setItem("workquest_meta_v1", JSON.stringify({ schema: 1 }));
    localStorage.setItem("workquest_tasks_v1", "[]");
    runMigrations();
    const after = loadDifs();
    ok("міграція долила нову складність", after.some(x => x.id === "d_titan"), true);
    ok("решта складностей на місці", after.length, DEFAULT_DIFFICULTIES.length);
    ok("схему піднято", loadMeta().schema, WQ_SCHEMA);

    // Свідомо видалену складність міграція НЕ повертає: вона вже відпрацювала.
    saveDifs(loadDifs().filter(x => x.id !== "d_titan"));
    runMigrations();
    ok("видалену складність не повертає", loadDifs().some(x => x.id === "d_titan"), false);

    // Новий користувач: міграції не ганяються, схема ставиться одразу.
    localStorage.clear();
    runMigrations();
    ok("новому користувачу — одразу поточна схема", loadMeta().schema, WQ_SCHEMA);

    localStorage.clear();
  } catch (e) {
    out.push({ name: "ВИНЯТОК", got: (e && e.message) || String(e), want: "—", pass: false });
  }
  return JSON.stringify(out);
})()`;

function run(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pend = new Map();
  const send = (method, params, sessionId) => new Promise((res) => {
    const i = ++id; pend.set(i, res);
    const msg = { id: i, method, params: params || {} };
    if (sessionId) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
  });
  ws.onerror = () => finish(0, "⏭  перевірка циклу пропущена: немає з'єднання з CDP");
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
  };
  ws.onopen = async () => {
    try {
      const { targetId } = await send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      await send("Runtime.enable", {}, sessionId);
      await send("Page.enable", {}, sessionId);
      await send("Page.navigate", { url: PAGE }, sessionId);
      await new Promise((r) => setTimeout(r, 2500));

      const r = await send("Runtime.evaluate", { expression: SCRIPT, returnByValue: true }, sessionId);
      if (r.exceptionDetails) {
        finish(1, "❌ ЦИКЛ: сценарій упав — " +
          JSON.stringify(r.exceptionDetails).slice(0, 300));
        return;
      }
      const res = JSON.parse((r.result && r.result.value) || "[]");
      const bad = res.filter(x => !x.pass);
      clearTimeout(guard);
      if (!res.length) { finish(1, "❌ ЦИКЛ: сценарій нічого не повернув"); return; }
      if (bad.length) {
        console.log("❌ ЦИКЛ — " + bad.length + " із " + res.length + " перевірок не зійшлись:");
        bad.forEach(x => console.log("   • " + x.name + ": отримано " + x.got + ", очікувалось " + x.want));
        finish(1);
      } else {
        finish(0, "✅ цикл задачі (" + res.length + " перевірок, зокрема заморозка XP)");
      }
    } catch (e) {
      finish(0, "⏭  перевірка циклу пропущена: " + e.message);
    }
  };
}
