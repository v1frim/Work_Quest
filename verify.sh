#!/bin/sh
# verify.sh — передкомітна перевірка Work_Quest.
#
# ⚠️ КЛИКАТИ ГОЛИМ РЯДКОМ: `./verify.sh; echo $?`
#    НІКОЛИ не через `| tail` — пайп повертає код виходу tail'а, а не перевірки,
#    і коміт пройде зі зламаним сайтом. В еталонному проєкті ця граблина двічі
#    пропустила дефект у прод (сесії 41 і 48).
#
# ⚠️ Шлях обчислюється від самого скрипта, не хардкодиться: в еталоні verify.sh
#    посилався на абсолютний шлях мертвої сесії і мовчки не працював.

cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)" || exit 1

TMP="${TMPDIR:-/tmp}/_wq_verify.$$"
trap 'rm -f "$TMP"' EXIT

# ── 1. Цілісність реєстрів і контракту метрик ────────────────────────────────
if [ -f check-config.js ]; then
  if ! node check-config.js > "$TMP" 2>&1; then
    echo "❌ CONFIG:"
    cat "$TMP"
    exit 1
  fi
  cat "$TMP"
fi

# ── 2. Синтаксис: inline-скрипти index.html + config.js + tasks.js ───────────
node -e '
const fs = require("fs");
let checked = [];

for (const f of ["config.js", "tasks.js"]) {
  if (!fs.existsSync(f)) continue;
  try { new Function(fs.readFileSync(f, "utf8")); checked.push(f); }
  catch (e) { console.log("❌ СИНТАКСИС " + f + ": " + e.message); process.exit(1); }
}

if (fs.existsSync("index.html")) {
  const html = fs.readFileSync("index.html", "utf8");
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m, n = 0;
  while ((m = re.exec(html))) {
    n++;
    try { new Function(m[1]); }
    catch (e) { console.log("❌ СИНТАКСИС index.html (скрипт #" + n + "): " + e.message); process.exit(1); }
  }
  checked.push("index.html (" + n + " inline-скрипт(ів))");
}

if (!checked.length) { console.log("⏳ синтаксис — ще нема чого перевіряти"); process.exit(0); }
console.log("✅ синтаксис: " + checked.join(", "));
' || exit 1

# ── 3. Стенд завантаження: реальне виконання скрипта під мок-DOM ─────────────
# `new Function` НЕ виконує код, тож не бачить TDZ / ReferenceError. Цей стенд бачить.
if [ -f loadtest.js ]; then
  node loadtest.js || exit 1
fi

# ── 4. Сторінка в справжньому браузері: помилки консолі й pageerror ──────────
# Немає Chromium → код 2 = «пропущено», це не помилка.
if [ -f test-load.js ]; then
  node test-load.js
  rc=$?
  [ "$rc" = "1" ] && exit 1
fi

# ── 5. Цикл задачі: рахунок, а не лише «не падає» ────────────────────────────
# Ловить головне, чого не видно очима: зміну XP складності заднім числом.
if [ -f test-flow.js ]; then
  node test-flow.js
  rc=$?
  [ "$rc" = "1" ] && exit 1
fi

echo "✅ усе чисто — можна комітити"
