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
    addGoalSteps("Розширити асортимент", [
      { title: "Знайти постачальників", subs: ["Китай", "Туреччина"] },
      { title: "Завести флагманів", subs: [] }
    ], 300);
    const gs = loadGoals()[0];
    ok("режим кроків", gs.mode, "steps");
    ok("кроків верхнього рівня", gs.steps.length, 2);
    ok("підкроків у першого", gs.steps[0].subs.length, 2);
    // Листок — підкрок, а якщо підкроків немає, то сам крок: 2 + 1 = 3.
    ok("листків усього", goalProgress(loadGoals()[0]).tot, 3);

    toggleStep("goal", gs.id, gs.steps[0].subs[0].id);
    ok("підкрок закрито", goalProgress(loadGoals()[0]).cur, 1);
    ok("батько ще не закритий", loadGoals()[0].steps[0].done, false);
    toggleStep("goal", gs.id, gs.steps[0].subs[1].id);
    ok("батько закрився сам", loadGoals()[0].steps[0].done, true);
    ok("ціль ще не досягнута", S().goals.done, 0);

    toggleStep("goal", gs.id, gs.steps[1].id);
    ok("ціль досягнута останнім кроком", S().goals.done, 1);
    ok("XP за ціль нараховано", S().xp.total, 300);

    // Симетрія: зняв галочку — XP іде рівно той, що дали.
    toggleStep("goal", gs.id, gs.steps[1].id);
    ok("ціль знову відкрита", S().goals.done, 0);
    ok("XP знято симетрично", S().xp.total, 0);

    // Крок із підкроками — перемикач усієї гілки.
    toggleStep("goal", gs.id, gs.steps[0].id);
    ok("зняття батька зняло підкроки", goalProgress(loadGoals()[0]).cur, 0);

    // 11c. Редактор кроків у модалці: рядки → структура.
    localStorage.clear();
    openGoalModal();
    setGoalKind("steps");
    document.getElementById("g-title").value = "Ціль з редактора";
    seReset();
    const ed = document.getElementById("g-step-editor");
    ed.querySelector(".se-t").value = "Перший крок";
    ed.querySelector('[data-se="sub"]').click();               // + підкрок
    ed.querySelector('.se-sub .se-t').value = "Вкладений";
    document.getElementById("g-add-step").click();             // + другий крок
    ed.querySelectorAll('.sedit-row[data-lvl="0"] .se-t')[1].value = "Другий крок";
    document.getElementById("g-save").click();
    const ge = loadGoals()[0];
    ok("редактор: ціль створено", !!ge, true);
    ok("редактор: кроків", ge.steps.length, 2);
    ok("редактор: підкрок на місці", ge.steps[0].subs[0].title, "Вкладений");
    ok("редактор: порядок збережено", ge.steps[1].title, "Другий крок");

    // 11d. Інлайн-чернетка в панелі замість prompt().
    openStepDraft("goal", ge.id, null);
    document.getElementById("step-draft-input").value = "Крок із панелі";
    commitStepDraft();
    ok("чернетка: крок додано", loadGoals()[0].steps.length, 3);
    ok("чернетка лишилась відкритою", !!document.getElementById("step-draft-input"), true);
    openStepDraft("goal", ge.id, loadGoals()[0].steps[2].id);
    document.getElementById("step-draft-input").value = "Підкрок із панелі";
    commitStepDraft();
    ok("чернетка: підкрок додано", loadGoals()[0].steps[2].subs[0].title, "Підкрок із панелі");
    closeStepDraft();
    closeGoalModal();

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

    // 12b. Міграція 3: товарний план засівається рівно один раз.
    localStorage.clear();
    localStorage.setItem("workquest_meta_v1", JSON.stringify({ schema: 2 }));
    localStorage.setItem("workquest_tasks_v1", "[]");
    runMigrations();
    ok("товарні цілі засіяно", loadGoals().length, 3);
    ok("конвеєр товару — кроками", loadGoals()[0].mode, "steps");
    ok("стартові задачі у роботі", loadTasks().filter(t => !tDone(t)).length, 3);
    // Відновили стару копію (схема знову 2) → міграція йде вдруге, але seedTag не дає дубля.
    localStorage.setItem("workquest_meta_v1", JSON.stringify({ schema: 2 }));
    runMigrations();
    ok("повторний сід не дублює", loadGoals().length, 3);

    // 13. Норма дня (план мінімум/норма): 4 задачі при плані 4 = норма.
    localStorage.clear();
    for (let i = 0; i < 4; i++) addDone("Норма " + i, d.id);
    ok("норму виконано", S().today.done, 4);
    ok("серія норми = 1", S().streak.norma, 1);
    ok("найкраща серія норми = 1", S().streak.normaBest, 1);

    // Пільга на сьогодні: вчора норма є, сьогодні ще в процесі — серія жива.
    localStorage.clear();
    const yk = keyFromNum(dayNum(todayKey()) - 1);
    const TY = [];
    for (let i = 0; i < 4; i++) TY.push({ id: "ty" + i, title: "вчора", note: "",
      difficultyId: d.id, tags: [], createdAt: 1, doneAt: 2, doneDay: yk, xpAwarded: 5, difSnap: null });
    localStorage.setItem("workquest_tasks_v1", JSON.stringify(TY));
    bumpStats();
    ok("пільга: серія норми жива зранку", S().streak.norma, 1);
    ok("мінімум-серія сьогодні ще 0", S().streak.current, 0);

    // 14. Редагування на місці.
    localStorage.clear();
    setMode("todo");
    document.getElementById("task-input").value = "Стара назва";
    document.querySelector('#dif-row [data-dif="' + d.id + '"]').click();
    setMode("done");
    const et = loadTasks()[0];
    // кнопка ✎ відкриває форму, збереження міняє назву
    document.querySelector('[data-task="' + et.id + '"] [data-tact="edit"]').click();
    const inp = document.querySelector(".task.edit .te-title");
    ok("форма редагування задачі відкрилась", !!inp, true);
    inp.value = "Нова назва";
    document.querySelector('.task.edit [data-tact="esave"]').click();
    ok("назву задачі змінено", loadTasks()[0].title, "Нова назва");

    addGoal("Стара ціль", 10, "шт", 100, 9);
    const eg = loadGoals()[0];
    document.querySelector('[data-goal="' + eg.id + '"] [data-gact="edit"]').click();
    ok("форма редагування цілі відкрилась", !!document.querySelector(".goal.edit .ge-title"), true);
    document.querySelector(".goal.edit .ge-title").value = "Нова ціль";
    document.querySelector(".goal.edit .ge-target").value = "8";
    document.querySelector(".goal.edit .ge-xp").value = "250";
    document.querySelector('.goal.edit [data-gact="esave"]').click();
    const eg2 = loadGoals()[0];
    ok("назву цілі змінено", eg2.title, "Нова ціль");
    ok("мету змінено", eg2.target, 8);
    // прогрес 9 > нова мета 8 → ціль чесно закрилась тим самим шляхом
    ok("зниження мети закрило ціль", S().goals.done, 1);
    ok("XP за неї — за новою ціною", eg2.xpAwarded, 250);
    // ⚠️ заморозка: зміна XP у ДОСЯГНУТОЇ цілі не чіпає нарахованого
    document.querySelector('[data-goal="' + eg.id + '"] [data-gact="edit"]').click();
    document.querySelector(".goal.edit .ge-xp").value = "999";
    document.querySelector('.goal.edit [data-gact="esave"]').click();
    ok("xpAwarded досягнутої цілі заморожено", loadGoals()[0].xpAwarded, 250);
    ok("нова ціна записана на майбутнє", loadGoals()[0].xp, 999);

    // 15. Порядок цілей і вага за XP.
    localStorage.clear();
    addGoal("A", 1, "", 100, 0);
    addGoal("B", 1, "", 2000, 0);
    addGoal("C", 1, "", 50000, 0);
    const ord = () => loadGoals().slice().sort((a,b)=>(a.order|0)-(b.order|0)).map(x=>x.title).join("");
    ok("початковий порядок", ord(), "ABC");
    const ids = {};
    loadGoals().forEach(x => { ids[x.title] = x.id; });
    reorderGoals(ids.C, ids.A);            // C на місце A
    ok("перенесення вгору", ord(), "CAB");
    reorderGoals(ids.C, ids.B);            // C у кінець
    ok("перенесення вниз", ord(), "ABC");
    ok("сам на себе — без змін", reorderGoals(ids.A, ids.A), false);

    // Вага береться за першим порогом, який ціль перевищила.
    const byTitle = t => loadGoals().find(x => x.title === t);
    ok("100 XP → дрібна", goalTier(byTitle("A")).name, "дрібна");
    ok("2000 XP → велика", goalTier(byTitle("B")).name, "велика");
    ok("50000 XP → легендарна", goalTier(byTitle("C")).name, "легендарна");
    // Колір ваги реально доїжджає в розмітку.
    ok("колір ваги в рядку", document.getElementById("goal-list").innerHTML.indexOf(goalTier(byTitle("C")).color) >= 0, true);
    ok("ручка перетягування є", document.querySelectorAll("#goal-list .grip").length, 3);

    // 16. Кроки доступні БУДЬ-ЯКІЙ цілі й будь-якій задачі, не лише кроковій.
    localStorage.clear();
    addGoal("Числова ціль", 40, "тов.", 800, 0);
    const gn = loadGoals()[0];
    addStep("goal", gn.id, "Етап один", null);
    addStep("goal", gn.id, "Етап два", null);
    addStep("goal", gn.id, "Дрібниця", loadGoals()[0].steps[0].id);
    const gn2 = loadGoals()[0];
    ok("крок додано числовій цілі", gn2.steps.length, 2);
    ok("підкрок додано числовій цілі", gn2.steps[0].subs.length, 1);
    ok("режим цілі не змінився", gn2.mode, "number");
    // ⚠️ Головне: план НЕ підмінює числовий прогрес і не нараховує XP сам.
    toggleStep("goal", gn.id, gn2.steps[1].id);
    toggleStep("goal", gn.id, gn2.steps[0].subs[0].id);
    ok("усі кроки закриті", goalLeaves(loadGoals()[0]).every(x => x.done), true);
    ok("числова ціль НЕ закрилась кроками", loadGoals()[0].doneAt, null);
    ok("XP за план не нарахований", S().xp.total, 0);
    ok("прогрес лишився числовим", goalProgress(loadGoals()[0]).tot, 40);
    ok("кнопка + крок є в числової цілі",
       document.querySelector('[data-goal="' + gn.id + '"] [data-gact="addstep"]') !== null, true);
    document.querySelector('[data-goal="' + gn.id + '"] [data-gact="exp"]').click();
    ok("числова ціль розгортається", document.querySelectorAll("#goal-list .step").length, 3);

    // Кроки в задачі: план, який не чіпає ані XP, ані момент закриття.
    localStorage.clear();
    addOpen("Задача з підзадачами", activeDifs()[0].id);
    const tid = loadTasks()[0].id;
    addStep("task", tid, "Підзадача 1", null);
    addStep("task", tid, "Підзадача 2", null);
    addStep("task", tid, "Дрібниця", loadTasks()[0].steps[0].id);
    ok("кроки додано задачі", loadTasks()[0].steps.length, 2);
    ok("підкрок додано задачі", loadTasks()[0].steps[0].subs.length, 1);
    toggleStep("task", tid, loadTasks()[0].steps[1].id);
    toggleStep("task", tid, loadTasks()[0].steps[0].subs[0].id);
    ok("усі підзадачі закриті", goalLeaves(loadTasks()[0]).every(x => x.done), true);
    ok("задача НЕ закрилась сама", loadTasks()[0].doneAt, null);
    ok("XP за підзадачі не нарахований", S().xp.total, 0);
    document.querySelector('[data-task="' + tid + '"] [data-tact="exp"]').click();
    ok("задача розгортається", document.querySelectorAll("#open-list .step").length, 3);
    delStep("task", tid, loadTasks()[0].steps[1].id);
    ok("підзадача видаляється", loadTasks()[0].steps.length, 1);
    completeTask(tid);
    ok("задача закривається кнопкою", loadTasks()[0].doneAt > 0, true);
    ok("XP дає складність, не кроки", S().xp.total, activeDifs()[0].xp);
    ok("кроки пережили закриття задачі", loadTasks()[0].steps.length, 1);

    // 17. ⚠️ Розкладка НЕ стрибає при розгортанні цілі.
    // Це саме та регресія, яку не видно в жодному числі, крім координат:
    // до фіксу висота сітки росла й вертикальне центрування зсувало все вгору.
    localStorage.clear();
    addGoalSteps("Довга ціль", [
      { title: "Крок 1", subs: ["a", "b", "c"] },
      { title: "Крок 2", subs: ["d", "e", "f"] },
      { title: "Крок 3", subs: ["g", "h", "i"] }
    ], 500);
    const gid = loadGoals()[0].id;
    const layout = document.querySelector(".layout");
    const card = document.querySelector(".card");
    const beforeH = Math.round(layout.getBoundingClientRect().height);
    const beforeTop = Math.round(card.getBoundingClientRect().top);
    document.querySelector('[data-goal="' + gid + '"] [data-gact="exp"]').click();
    ok("ціль розгорнулась", document.querySelectorAll("#goal-list .step").length > 0, true);
    ok("висота сітки не змінилась", Math.round(layout.getBoundingClientRect().height), beforeH);
    ok("картка не зсунулась", Math.round(card.getBoundingClientRect().top), beforeTop);
    // Зростання поглинає внутрішній скрол панелі, а не сторінка.
    // Панель не має права вирости вище за сітку: усе зростання йде у .scroll.
    const panelH = Math.round(document.getElementById("open-panel").getBoundingClientRect().height);
    ok("панель не вища за сітку", panelH <= Math.round(layout.getBoundingClientRect().height), true);
    const sc = document.querySelector("#open-panel .scroll");
    ok("вміст панелі скролиться, а не розпирає її", sc.scrollHeight <= sc.clientHeight || getComputedStyle(sc).overflowY !== "visible", true);
    ok("сторінка не прокручується", document.documentElement.scrollHeight <= innerHeight + 1, true);

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
      // ⚠️ Розмір вікна задаємо ЯВНО. Безголовий Chromium стартує з крихітним
      // viewport, три колонки згортаються через flex-wrap, і будь-яка перевірка
      // геометрії міряє не ту розкладку, яку бачить користувач на ПК.
      await send("Emulation.setDeviceMetricsOverride",
        { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
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
