const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

(async () => {
  // ── 1. Конфигурация (.env / config.json) ──────────────────────────────────────
  let config = {};
  const configPath = path.join(__dirname, 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      console.warn('[ВНИМАНИЕ] Не удалось разобрать config.json:', e.message);
    }
  }

  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    try {
      const envLines = fs.readFileSync(envPath, 'utf8').split('\n');
      for (const line of envLines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const [k, ...v] = trimmed.split('=');
        if (k && !config[k.trim()]) {
          config[k.trim()] = v.join('=').trim().replace(/^["']|["']$/g, '');
        }
      }
    } catch (e) {
      console.warn('[ВНИМАНИЕ] Ошибка при чтении .env:', e.message);
    }
  }

  // ── 2. Разбор аргументов командной строки ───────────────────────────────────
  // Пример: node build.js --exam=EGE --topics=mechanics --variant=101 --title="Тематический пробник: Механика"
  // Новые флаги: --ids=ID1,ID2 | --part1=N | --part2=M | --limit=N
  const args = Object.fromEntries(
    process.argv.slice(2).map(arg => {
      const [k, ...v] = arg.replace(/^--/, '').split('=');
      return [k, v.join('=')];
    })
  );

  const EXAM             = (args.exam || 'EGE').toUpperCase();
  const TOPICS           = args.topics ? args.topics.split(',').map(s => s.trim()) : [];
  const VARIANT_ID       = args.variant || '101';
  const TITLE            = args.title || `Тренировочный вариант №${VARIANT_ID}`;
  const defaultDuration  = EXAM === 'EGE' ? 235 : 180;
  const DURATION_MINUTES = Number(args.duration) || defaultDuration;

  const WEB_BASE_URL     = String(args['web-url'] || config.WEB_BASE_URL || '').trim();
  const WEB_FORM_URL     = args.url || buildWebFormUrl(WEB_BASE_URL, EXAM, VARIANT_ID);

  // Собирает ссылку для QR-кода: базовый публичный URL + ?v=<КОД>.
  // Если базовый URL уже содержит query-параметры, добавляет &v=<КОД>.
  function buildWebFormUrl(baseUrl, exam, variantId) {
    const code = `${exam}-${variantId}`;
    const raw = String(baseUrl || '').trim();
    const fallbackBase = 'https://your-domain.ru/blank';

    if (!raw) {
      return `${fallbackBase}?v=${encodeURIComponent(code)}`;
    }

    try {
      const parsed = new URL(raw);
      parsed.searchParams.set('v', code);
      return parsed.toString();
    } catch (e) {
      const sep = raw.includes('?') ? '&' : '?';
      return `${raw.replace(/\/+$/, '')}${sep}v=${encodeURIComponent(code)}`;
    }
  }
  const SKIP_PDF         = 'skip-pdf' in args || args['skip-pdf'] === 'true';
  const SKIP_GAS         = 'skip-gas' in args || args['skip-gas'] === 'true';
  const GAS_WEBHOOK_URL  = SKIP_GAS ? '' : (process.env.GAS_WEBHOOK_URL || config.GAS_WEBHOOK_URL || '');

  // Новые флаги выборки
  const IDS_FILTER   = args.ids   ? args.ids.split(',').map(s => s.trim()).filter(Boolean) : [];
  const PART1_COUNT  = args.part1 !== undefined ? Number(args.part1) : null;
  const PART2_COUNT  = args.part2 !== undefined ? Number(args.part2) : null;
  const LIMIT_COUNT  = args.limit !== undefined ? Number(args.limit) : null;

  // Каталог с базой задач и изображениями (по умолчанию — tasks/ рядом с build.js).
  // Необязательный --tasks-dir позволяет собрать вариант из внешней/полной базы,
  // не меняя поведение обычного запуска `node build.js`.
  const TASKS_DIR = args['tasks-dir']
    ? path.resolve(args['tasks-dir'])
    : path.join(__dirname, 'tasks');

  // Fisher-Yates shuffle (возвращает новый перемешанный массив)
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Случайный выбор не более n элементов из массива
  function pickRandom(arr, n) {
    const shuffled = shuffle(arr);
    return shuffled.slice(0, n);
  }

  // Экранирование спецсимволов для вывода в LaTeX-тексте
  const escapeLatex = (str) => String(str ?? '').replace(/_/g, '\\_');

  // Очистка единиц измерения для отображения в веб-бланке
  function cleanUnitForWeb(unit) {
    if (!unit) return '';
    return unit
      .replace(/\\text\{([^}]+)\}/g, '$1')
      .replace(/[$]/g, '')
      .replace(/\^2/g, '²')
      .replace(/\^3/g, '³')
      .trim();
  }

  // ── 3. Загрузка и фильтрация базы задач ─────────────────────────────────────
  const dbPath = path.join(TASKS_DIR, 'db.json');
  if (!fs.existsSync(dbPath)) {
    console.error(`[ОШИБКА] База данных не найдена: ${dbPath}`);
    process.exit(1);
  }

  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

  let selectedTasks;

  if (IDS_FILTER.length > 0) {
    // ── Режим --ids: выбираем задачи строго по указанным ID (--exam и --topics игнорируются)
    console.log(`[ИНФО] Режим --ids: отбор задач по ID: ${IDS_FILTER.join(', ')}`);
    const idSet = new Set(IDS_FILTER);
    selectedTasks = db.filter(t => idSet.has(String(t.id)));
    const foundIds = selectedTasks.map(t => String(t.id));
    const missing  = IDS_FILTER.filter(id => !foundIds.includes(id));
    if (missing.length > 0) {
      console.warn(`[ВНИМАНИЕ] Следующие ID не найдены в базе: ${missing.join(', ')}`);
    }
    // Сортировка: сначала часть 1, затем часть 2, внутри — по kim_line
    selectedTasks.sort((a, b) => (a.part - b.part) || (a.kim_line - b.kim_line));
  } else {
    // ── Стандартный режим: фильтр по экзамену и темам
    let pool = db.filter(t => {
      if (t.exam !== EXAM) return false;
      if (TOPICS.length === 0) return true;
      return Array.isArray(t.topics) && t.topics.some(topic => TOPICS.includes(topic));
    });

    if (pool.length === 0) {
      console.error(`[ВНИМАНИЕ] Не найдено задач по заданным критериям (экзамен: ${EXAM}, темы: ${TOPICS.join(', ') || 'все'})!`);
      process.exit(1);
    }

    if (PART1_COUNT !== null || PART2_COUNT !== null) {
      // ── Режим --part1=N / --part2=M: случайная выборка по частям
      const pool1 = pool.filter(t => t.part === 1);
      const pool2 = pool.filter(t => t.part === 2);

      let picked1 = [];
      let picked2 = [];

      if (PART1_COUNT !== null) {
        if (pool1.length < PART1_COUNT) {
          console.warn(`[ВНИМАНИЕ] Запрошено ${PART1_COUNT} задач части 1, но в пуле только ${pool1.length}. Берём все доступные.`);
        }
        picked1 = pickRandom(pool1, PART1_COUNT);
        console.log(`[ИНФО] Часть 1: выбрано ${picked1.length} из ${pool1.length} задач (запрошено ${PART1_COUNT}).`);
      } else {
        picked1 = pool1;
      }

      if (PART2_COUNT !== null) {
        if (pool2.length < PART2_COUNT) {
          console.warn(`[ВНИМАНИЕ] Запрошено ${PART2_COUNT} задач части 2, но в пуле только ${pool2.length}. Берём все доступные.`);
        }
        picked2 = pickRandom(pool2, PART2_COUNT);
        console.log(`[ИНФО] Часть 2: выбрано ${picked2.length} из ${pool2.length} задач (запрошено ${PART2_COUNT}).`);
      } else {
        picked2 = pool2;
      }

      selectedTasks = [...picked1, ...picked2];
    } else if (LIMIT_COUNT !== null) {
      // ── Режим --limit=N: случайная выборка из общего пула
      if (pool.length < LIMIT_COUNT) {
        console.warn(`[ВНИМАНИЕ] Запрошено ${LIMIT_COUNT} задач, но в пуле только ${pool.length}. Берём все доступные.`);
      }
      selectedTasks = pickRandom(pool, LIMIT_COUNT);
      console.log(`[ИНФО] --limit: выбрано ${selectedTasks.length} из ${pool.length} задач (запрошено ${LIMIT_COUNT}).`);
    } else {
      // ── Без флагов выборки: берём весь пул (исходное поведение)
      selectedTasks = pool;
    }

    // Финальная сортировка: часть 1 → часть 2, внутри — по kim_line
    selectedTasks.sort((a, b) => (a.part - b.part) || (a.kim_line - b.kim_line));
  }

  if (selectedTasks.length === 0) {
    console.error(`[ОШИБКА] После применения всех фильтров список задач пуст.`);
    process.exit(1);
  }

  const part1Tasks = selectedTasks.filter(t => t.part === 1);
  const part2Tasks = selectedTasks.filter(t => t.part === 2);

  // Компактные рисунки: старые записи с центрированным \includegraphics
  // автоматически переводим на макрос \kimimg из fipi_style.sty.
  function compactFigureLatex(latex) {
    return String(latex || '').replace(
      /\\begin\{center\}\s*\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}\s*\\end\{center\}/g,
      (_m, imgPath) => `\\kimimg{${imgPath}}`
    );
  }

  for (const t of selectedTasks) {
    t.latex_condition = compactFigureLatex(t.latex_condition);
    t.latex_solution = compactFigureLatex(t.latex_solution);
  }

  function renderTaskStudent(task, index) {
    let answerBlock = '';
    if (task.part === 1) {
      if (Array.isArray(task.cols) && task.cols.length === 2) {
        answerBlock = `\\ansTwoCols{${task.cols[0]}}{${task.cols[1]}}`;
      } else if (task.grading_rule === 'ordered_sequence') {
        answerBlock = `\\ansAB`;
      } else {
        answerBlock = `\\ansline{${task.unit || ''}}`;
      }
    }
    return `\\kimtask{${index}}{${task.latex_condition}\n${answerBlock}}`;
  }

  const refFileName = EXAM === 'EGE' ? 'ege_ref.tex' : 'oge_ref.tex';
  const grade = EXAM === 'EGE' ? '11' : '9';

  // ── 4. Генерация документа для ученика (КИМ) ────────────────────────────────
  let studentTex = `\\documentclass[11pt, a4paper]{article}
\\newcommand{\\ExamHeaderTitle}{${TITLE}}
\\newcommand{\\ExamGrade}{${grade}}
\\usepackage{fipi_style}

\\begin{document}
\\webblankbox{${EXAM}-${VARIANT_ID}}{${WEB_FORM_URL}}
\\input{${refFileName}}
`;

  let globalIndex = 1;
  const keyMap = [];

  if (part1Tasks.length > 0) {
    studentTex += `\\kimpart{Часть 1}{Ответами к заданиям части 1 являются число или последовательность цифр. Запишите ответ в поле ответа в тексте работы, а затем перенесите в электронный бланк ответов № 1 без пробелов и единиц измерения.}\n`;
    for (const t of part1Tasks) {
      studentTex += renderTaskStudent(t, globalIndex) + '\n';
      keyMap.push({
        num: globalIndex,
        id: t.id,
        part: 1,
        rule: t.grading_rule,
        max_points: t.max_points,
        answer: t.answer,
        unit: cleanUnitForWeb(t.unit),
        cols: Array.isArray(t.cols) ? t.cols : undefined,
        solution: t.latex_solution
      });
      globalIndex++;
    }
  }

  if (part2Tasks.length > 0) {
    studentTex += `\\newpage\n\\kimpart{Часть 2}{Для записи ответов на задания части 2 используйте чистые листы. Запишите сначала номер задания, а затем полное решение. Фотографии решений прикрепите в электронном бланке по QR-коду.}\n`;
    for (const t of part2Tasks) {
      studentTex += renderTaskStudent(t, globalIndex) + '\n';
      keyMap.push({
        num: globalIndex,
        id: t.id,
        part: 2,
        rule: 'manual',
        max_points: t.max_points,
        answer: t.answer,
        solution: t.latex_solution
      });
      globalIndex++;
    }
  }

  studentTex += `\\end{document}\n`;

  // ── 5. Генерация документа для преподавателя (Ключи и решения) ──────────────
  let teacherTex = `\\documentclass[11pt, a4paper]{article}
\\newcommand{\\ExamHeaderTitle}{${TITLE} — КЛЮЧИ И РЕШЕНИЯ}
\\newcommand{\\ExamGrade}{${grade}}
\\usepackage{fipi_style}

\\begin{document}
`;

  if (part1Tasks.length > 0) {
    teacherTex += `\\section*{Таблица ответов к Части 1 (Вариант ${EXAM}-${VARIANT_ID})}
\\begin{tabular}{|c|c|c|c|c|}
\\hline
\\textbf{№} & \\textbf{ID задачи} & \\textbf{Тип проверки} & \\textbf{Макс. балл} & \\textbf{Эталонный ответ} \\\\ \\hline
${keyMap.filter(k => k.part === 1).map(k => `${k.num} & \\texttt{${escapeLatex(k.id)}} & \\texttt{${escapeLatex(k.rule)}} & ${k.max_points} & \\textbf{${k.answer}} \\\\ \\hline`).join('\n')}
\\end{tabular}
\\vspace{12pt}
`;
  }

  teacherTex += `\\section*{Разбор заданий и критерии оценивания}
${keyMap.map(k => `\\kimtask{${k.num}}{\\textbf{ID:} \\texttt{${escapeLatex(k.id)}} (Макс. балл: ${k.max_points})\\\\[4pt] ${k.solution}\\\\ \\textbf{Ответ:} ${k.answer}}`).join('\n\n')}
\\end{document}\n`;

  // ── 6. Сохранение полных ключей и публичного манифеста ───────────────────────
  const outDir = path.join(__dirname, 'output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const webVariantsDir = path.join(__dirname, 'web', 'variants');
  if (!fs.existsSync(webVariantsDir)) fs.mkdirSync(webVariantsDir, { recursive: true });

  const baseName       = `KIM_${EXAM}_${VARIANT_ID}`;
  const studentTexPath = path.join(outDir, `${baseName}_Student.tex`);
  const teacherTexPath = path.join(outDir, `${baseName}_Teacher.tex`);
  const jsonKeyPath    = path.join(outDir, `${baseName}_Key.json`);

  // Полный файл ключей (для учителя / базы)
  fs.writeFileSync(studentTexPath, studentTex, 'utf8');
  fs.writeFileSync(teacherTexPath, teacherTex, 'utf8');
  fs.writeFileSync(jsonKeyPath, JSON.stringify({
    variant_id: `${EXAM}-${VARIANT_ID}`,
    exam: EXAM,
    title: TITLE,
    duration_minutes: DURATION_MINUTES,
    created_at: new Date().toISOString(),
    tasks: keyMap
  }, null, 2), 'utf8');

  // Публичный манифест для веб-бланка (БЕЗ ответов и решений!)
  const publicManifest = {
    variant_id: `${EXAM}-${VARIANT_ID}`,
    exam: EXAM,
    title: TITLE,
    duration_minutes: DURATION_MINUTES,
    tasks: keyMap.map(k => {
      const item = {
        num: k.num,
        part: k.part,
        rule: k.rule,
        max_points: k.max_points
      };
      if (k.unit) item.unit = k.unit;
      if (Array.isArray(k.cols) && k.cols.length === 2) item.cols = k.cols;
      return item;
    })
  };

  const publicManifestPath = path.join(webVariantsDir, `${EXAM}-${VARIANT_ID}.json`);
  fs.writeFileSync(publicManifestPath, JSON.stringify(publicManifest, null, 2), 'utf8');

  console.log(`[OK] Сгенерированы файлы:
 - ${studentTexPath}
 - ${teacherTexPath}
 - Полный ключ: ${jsonKeyPath}
 - Публичный манифест: ${publicManifestPath}
 - QR-ссылка на бланк: ${WEB_FORM_URL}`);

  // ── 7. Автоматическая регистрация ключей на Google Apps Script ──────────────
  if (GAS_WEBHOOK_URL) {
    process.stdout.write(`  → Регистрация ключа в Google Таблице (${GAS_WEBHOOK_URL})... `);
    try {
      const payload = {
        action: 'register_key',
        variant_id: `${EXAM}-${VARIANT_ID}`,
        exam: EXAM,
        title: TITLE,
        tasks: keyMap
      };
      const res = await fetch(GAS_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload)
      });
      const rawText = await res.text();
      let data;
      try {
        data = JSON.parse(rawText);
      } catch (jsonErr) {
        if (rawText.includes('doPost') || rawText.includes('Не удалось найти функцию')) {
          console.log(`\n  [!] Google Apps Script вернул ошибку: в активном развертывании не найдена функция doPost.`);
          console.log(`      Решение: Откройте Apps Script -> «Развернуть» -> «Управление развертываниями» -> нажмите ✏️ -> Версия: «Новая версия» -> «Развернуть».`);
          data = null;
        } else {
          throw new Error(`Ответ сервера не в формате JSON (${rawText.slice(0, 100)}...)`);
        }
      }

      if (data && data.ok) {
        console.log(`УСПЕШНО (${data.status})`);
      } else if (data) {
        console.log(`ОШИБКА: ${data.error || 'неизвестная ошибка'}`);
      }
    } catch (err) {
      console.log(`СБОЙ: ${err.message}`);
    }
  } else {
    console.log('[ИНФО] GAS_WEBHOOK_URL не задан в config.json — авторегистрация ключей пропущена.');
  }

  if (SKIP_PDF) {
    console.log('[ИНФО] Флаг --skip-pdf включён, автокомпиляция PDF пропущена.');
    process.exit(0);
  }

  // ── 8. Автокомпиляция PDF через pdflatex ─────────────────────────────────────
  try {
    console.log('Подготовка к компиляции: копирование шаблонов и изображений...');
    fs.copyFileSync(
      path.join(__dirname, 'templates', 'fipi_style.sty'),
      path.join(outDir, 'fipi_style.sty')
    );
    fs.copyFileSync(
      path.join(__dirname, 'templates', refFileName),
      path.join(outDir, refFileName)
    );

    const imagesSrcDir = path.join(TASKS_DIR, 'images');
    const imagesDstDir = path.join(outDir, 'images');
    if (!fs.existsSync(imagesDstDir)) fs.mkdirSync(imagesDstDir, { recursive: true });
    if (fs.existsSync(imagesSrcDir)) {
      for (const file of fs.readdirSync(imagesSrcDir)) {
        if (file !== '.gitkeep') {
          fs.copyFileSync(path.join(imagesSrcDir, file), path.join(imagesDstDir, file));
        }
      }
    }

    console.log('Компиляция PDF через pdflatex...');
    const studentJob = `${baseName}_Student`;
    const teacherJob = `${baseName}_Teacher`;

    const runLatex = (jobname, texFileName) => {
      try {
        execSync(
          `cmd /c "chcp 65001 >nul && pdflatex -interaction=nonstopmode -jobname=${jobname} ${texFileName}"`,
          { stdio: 'pipe' }
        );
      } catch (err) {
        const out = err.stdout ? err.stdout.toString() : '';
        const errLines = out.split('\n').filter(l => l.startsWith('!') || l.includes('Fatal'));
        throw new Error(`Ошибка при сборке ${jobname}:\n` + (errLines.slice(0, 10).join('\n') || out.slice(-1000) || err.message));
      }
    };

    const originalCwd = process.cwd();
    process.chdir(outDir);
    try {
      process.stdout.write('  → Сборка варианта для ученика (проход 1)... ');
      runLatex(studentJob, `${studentJob}.tex`);
      console.log('OK');

      process.stdout.write('  → Сборка варианта для ученика (проход 2, нумерация страниц)... ');
      runLatex(studentJob, `${studentJob}.tex`);
      console.log('OK');

      process.stdout.write('  → Сборка ключей и решений для учителя (проход 1)... ');
      runLatex(teacherJob, `${teacherJob}.tex`);
      console.log('OK');

      process.stdout.write('  → Сборка ключей и решений для учителя (проход 2)... ');
      runLatex(teacherJob, `${teacherJob}.tex`);
      console.log('OK');
    } finally {
      process.chdir(originalCwd);
    }

    const studentPdf = path.join(outDir, `${studentJob}.pdf`);
    const teacherPdf = path.join(outDir, `${teacherJob}.pdf`);

    console.log(`\n[ГОТОВО] Все PDF успешно собраны!`);
    console.log(`  - Ученик:        ${studentPdf}`);
    console.log(`  - Преподаватель: ${teacherPdf}`);
  } catch (e) {
    console.error(`\n[!] Ошибка при компиляции pdflatex:\n${e.message}`);
    process.exit(1);
  }
})();
