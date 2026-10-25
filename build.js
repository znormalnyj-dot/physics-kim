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
  const TOPICS           = args.topics ? args.topics.split(',').map(s => s.trim()).filter(Boolean) : [];
  const SELECTED_TOPICS  = (args['selected-topics'] || args.selectedTopics || '')
    .split(',').map(s => s.trim()).filter(Boolean);
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

  // Строгая спецификация экзамена (как на реальном КИМ).
  // part1Lines — последняя линия части 1; все последующие линии относятся к части 2.
  const EXAM_SPECS = {
    EGE: { maxLine: 26, part1Lines: 20, title: 'ЕГЭ' },
    OGE: { maxLine: 22, part1Lines: 16, title: 'ОГЭ' }
  };
  const EXAM_SPEC = EXAM_SPECS[EXAM] || EXAM_SPECS.EGE;
  const MAX_LINE = EXAM_SPEC.maxLine;

  // Кастомный план линий: --line-plan='{"1":{"count":2,...}}' или --matrix-json=plan.json
  const LINE_PLAN_RAW = args['line-plan'] || args['matrix-json'] || '';

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

  // ── Матричный отбор по линиям КИМ ───────────────────────────────────────────
  // План линий: Map<number, { count: number, subtopics: Set<string> }>.
  // Значение из JSON может быть числом ({"1": 2}) или объектом
  // ({"1": {"count": 2, "subtopics": ["theme_1"]}}).
  function normalizeLinePlan(raw) {
    const plan = new Map();
    const entries = Array.isArray(raw)
      ? raw.map((item) => [item && (item.line ?? item.kim_line), item])
      : Object.entries(raw || {});

    for (const [rawLine, rawValue] of entries) {
      const line = Number(rawLine);
      if (!Number.isInteger(line) || line < 1 || line > MAX_LINE) {
        console.warn(`[ВНИМАНИЕ] План линий: линия «${rawLine}» вне диапазона 1–${MAX_LINE}, пропущена.`);
        continue;
      }

      let count;
      let rawSubtopics;
      if (rawValue === null || rawValue === undefined) {
        count = 1;
        rawSubtopics = [];
      } else if (typeof rawValue === 'number' || typeof rawValue === 'string') {
        count = Number(rawValue);
        rawSubtopics = [];
      } else if (typeof rawValue === 'object') {
        count = rawValue.count === undefined ? 1 : Number(rawValue.count);
        rawSubtopics = rawValue.subtopics ?? rawValue.topics ?? rawValue.subtopic_ids ?? [];
      } else {
        console.warn(`[ВНИМАНИЕ] План линий: некорректное значение для линии ${line}, пропущено.`);
        continue;
      }

      if (!Number.isInteger(count) || count < 0) {
        console.warn(`[ВНИМАНИЕ] План линий: count для линии ${line} должен быть целым неотрицательным числом, пропущено.`);
        continue;
      }
      if (!Array.isArray(rawSubtopics)) {
        console.warn(`[ВНИМАНИЕ] План линий: subtopics для линии ${line} должен быть массивом, пропущено.`);
        continue;
      }

      plan.set(line, {
        count,
        subtopics: new Set(rawSubtopics.map((s) => String(s).trim()).filter(Boolean))
      });
    }

    if (plan.size === 0) {
      console.error('[ОШИБКА] План линий пуст: не удалось прочитать ни одной корректной линии.');
      process.exit(1);
    }
    return plan;
  }

  function readLinePlan(rawValue) {
    const raw = String(rawValue || '').trim();
    let parsed;
    if (raw.startsWith('{') || raw.startsWith('[')) {
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        console.error(`[ОШИБКА] Не удалось разобрать JSON плана линий: ${e.message}`);
        process.exit(1);
      }
    } else {
      const candidates = [
        path.resolve(process.cwd(), raw),
        path.resolve(__dirname, raw)
      ];
      const filePath = candidates.find((p) => fs.existsSync(p));
      if (!filePath) {
        console.error(`[ОШИБКА] Файл плана линий не найден: ${raw}`);
        process.exit(1);
      }
      try {
        parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (e) {
        console.error(`[ОШИБКА] Не удалось прочитать план линий ${filePath}: ${e.message}`);
        process.exit(1);
      }
    }

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.linePlan) {
      parsed = parsed.linePlan;
    }
    return normalizeLinePlan(parsed);
  }

  // Совпадает ли задача с выбранными подтемами плана.
  // Поддерживаем и subtopic_id (theme_*), и ключи разделов/подразделов из topics.
  function matchesPlanSubtopics(task, allowed) {
    if (!allowed || allowed.size === 0) return true;
    if (task.subtopic_id && allowed.has(String(task.subtopic_id))) return true;
    return Array.isArray(task.topics) && task.topics.some((tag) => allowed.has(String(tag)));
  }

  // Узкая тема задачи должна пересекаться с выбранными в конструкторе темами.
  function matchesSelectedTopics(task, selected) {
    if (!selected || selected.size === 0) return true;
    return Array.isArray(task.topics) && task.topics.some((tag) => selected.has(String(tag)));
  }

  // Отбор строго по линиям: для каждой линии по возрастанию номера — count задач.
  // Задачи внутри линии идут подряд; итоговая сортировка по частям выполняется ниже.
  function selectByLinePlan(pool, plan, selectedTopics) {
    const selectedSet = selectedTopics instanceof Set
      ? selectedTopics
      : new Set(selectedTopics || []);
    const byLine = new Map();
    let withoutLine = 0;

    for (const task of pool) {
      const line = Number(task.kim_line);
      if (!Number.isInteger(line) || line < 1) {
        withoutLine += 1;
        continue;
      }
      if (!byLine.has(line)) byLine.set(line, []);
      byLine.get(line).push(task);
    }

    if (withoutLine > 0) {
      console.warn(`[ВНИМАНИЕ] ${withoutLine} задач без корректного kim_line пропущено.`);
    }

    const selected = [];
    const emptyLines = [];
    const shortages = [];

    for (const line of [...plan.keys()].sort((a, b) => a - b)) {
      const spec = plan.get(line);
      if (!spec || spec.count <= 0) continue;

      let candidates = byLine.get(line) || [];

      // Новый фильтр по узким темам — основной. Подтемы линии используются
      // как дополнительное сужение, но не должны «терять» задачи выбранной
      // темы из-за неполного совпадения subtopic_id.
      if (selectedSet.size > 0) {
        candidates = candidates.filter((task) => matchesSelectedTopics(task, selectedSet));
        if (candidates.length > 0 && spec.subtopics.size > 0) {
          const refined = candidates.filter((task) => matchesPlanSubtopics(task, spec.subtopics));
          if (refined.length > 0) {
            candidates = refined;
          } else {
            console.warn(`[ИНФО] Линия ${line}: подтемы не совпали с выбранными темами, использую только фильтр тем.`);
          }
        }
      } else if (spec.subtopics.size > 0) {
        candidates = candidates.filter((task) => matchesPlanSubtopics(task, spec.subtopics));
      }

      if (candidates.length === 0) {
        emptyLines.push(line);
        continue;
      }
      if (candidates.length < spec.count) {
        shortages.push(`${line}: ${candidates.length}/${spec.count}`);
      }

      selected.push(...pickRandom(candidates, spec.count));
      console.log(`[ИНФО] Линия ${line}: выбрано ${Math.min(spec.count, candidates.length)} из ${candidates.length} задач.`);
    }

    if (emptyLines.length > 0) {
      console.warn(`[ВНИМАНИЕ] Нет подходящих задач для линий: ${emptyLines.join(', ')} — линии пропущены.`);
    }
    if (shortages.length > 0) {
      console.warn(`[ВНИМАНИЕ] Недостаточно задач (доступно/запрошено): ${shortages.join('; ')}.`);
    }

    return selected;
  }

  // Строгий порядок варианта: часть 1 (линии 1…part1Lines), затем часть 2.
  // Внутри каждой части — строго по возрастанию kim_line.
  function sortByKimLine(tasks) {
    const partOf = (task) => {
      const line = Number(task.kim_line);
      if (Number.isInteger(line) && line >= 1) return line <= EXAM_SPEC.part1Lines ? 1 : 2;
      return Number(task.part) === 2 ? 2 : 1;
    };
    tasks.sort((a, b) => {
      const partDiff = partOf(a) - partOf(b);
      if (partDiff !== 0) return partDiff;
      const lineDiff = (Number(a.kim_line) || 0) - (Number(b.kim_line) || 0);
      if (lineDiff !== 0) return lineDiff;
      return 0; // стабильная сортировка сохраняет порядок случайного выбора
    });
    return tasks;
  }

  // Экранирование спецсимволов для вывода в LaTeX-тексте
  const escapeLatex = (str) => String(str ?? '').replace(/_/g, '\\_');

  // Ответы попадают в таблицу и текст: символы & % # нельзя выводить как есть.
  const escapeAnswerCell = (str) => sanitizeLatex(str)
    .replace(/(^|[^\\])&/g, '$1\\&')
    .replace(/(^|[^\\])%/g, '$1\\%')
    .replace(/(^|[^\\])#/g, '$1\\#');

  // Невидимые символы, которые ломают pdflatex (в базе встречается U+2060
  // WORD JOINER, например «м/⁠с»). Удаляем их перед генерацией .tex.
  const INVISIBLE_CHARS_RE = /[\u00AD\u200B-\u200F\u2060\uFEFF]/g;

  function stripInvisibleChars(value) {
    return String(value ?? '')
      .normalize('NFC')
      // Ударения и прочая диакритика (U+0300–U+036F) в T2A не поддерживаются.
      .replace(/[\u0300-\u036F]/g, '')
      .replace(INVISIBLE_CHARS_RE, '')
      .replace(/[\u2028\u2029]/g, ' ')
      .replace(/\u00A0/g, ' ');
  }

  // Греческие буквы → LaTeX-макросы. \ensuremath работает и в тексте, и в формулах.
  const GREEK_TO_LATEX = {
    'α': '\\alpha', 'β': '\\beta', 'γ': '\\gamma', 'δ': '\\delta',
    'ε': '\\varepsilon', 'ζ': '\\zeta', 'η': '\\eta', 'θ': '\\theta',
    'ι': '\\iota', 'κ': '\\kappa', 'λ': '\\lambda', 'μ': '\\mu',
    'ν': '\\nu', 'ξ': '\\xi', 'π': '\\pi', 'ρ': '\\rho',
    'ς': '\\varsigma', 'σ': '\\sigma', 'τ': '\\tau', 'υ': '\\upsilon',
    'φ': '\\varphi', 'χ': '\\chi', 'ψ': '\\psi', 'ω': '\\omega',
    'Γ': '\\Gamma', 'Δ': '\\Delta', 'Θ': '\\Theta', 'Λ': '\\Lambda',
    'Ξ': '\\Xi', 'Π': '\\Pi', 'Σ': '\\Sigma', 'Υ': '\\Upsilon',
    'Φ': '\\Phi', 'Ψ': '\\Psi', 'Ω': '\\Omega',
    'µ': '\\mu' // микро-знак U+00B5
  };

  // Исправление типичных опечаток LaTeX, встречающихся в базе задач.
  // Без этого pdflatex падает на \mathcalE, \ChemFormN, \circC и т.п.
  function fixKnownLatexTypos(value) {
    return value
      // Пустые \newline{} после абзаца дают ошибку «There's no line here to end».
      .replace(/(^|\n)[ \t]*\\newline\{\}(?:[ \t]*\\newline\{\})?[ \t]*(?=\n|$)/g, '$1')
      // OCR-разрывы команд: «\le ft|» вместо «\left|».
      // Просто убираем \le ft — оставшиеся |...| и <...> компилируются.
      .replace(/\\le\s+ft(?![A-Za-z])/g, '')
      .replace(/\\equi\s*v(?![A-Za-z])/g, '\\equiv')
      .replace(/\\phantom\s*\^\\circC(?![A-Za-z])/g, '\\phantom{^\\circ\\text{C}}')
      .replace(/\\circC(?![A-Za-z])/g, '\\circ\\text{C}')
      .replace(/\\circR(?![A-Za-z])/g, '\\circ\\text{R}')
      .replace(/\\mathcalE(?![A-Za-z])/g, '\\mathcal{E}')
      .replace(/\\cdor(?![A-Za-z])/g, '\\cdot')
      .replace(/\\overrightarrow([A-Za-z0-9])(?![A-Za-z])/g, '\\overrightarrow{$1}')
      .replace(/_\\sum(?![A-Za-z])/g, '_{\\Sigma}')
      .replace(/\\mx(?![A-Za-z])/g, '_{\\max}')
      .replace(/\\ctg(?![A-Za-z])/g, '\\cot')
      .replace(/\\toX(?![A-Za-z])/g, '\\to X')
      .replace(/\\aplha(?![A-Za-z])/g, '\\alpha')
      .replace(/\\Dela(?![A-Za-z])/g, '\\Delta')
      .replace(/\\epslon(?![A-Za-z])/g, '\\varepsilon')
      .replace(/\\beginmatrix(?![A-Za-z])/g, '\\begin{matrix}')
      .replace(/\\endmatrix(?![A-Za-z])/g, '\\end{matrix}')
      .replace(/\\beginarray([lcr])(?![A-Za-z])/g, '\\begin{array}{$1}')
      .replace(/\\Rightarrowa(?![A-Za-z])/g, '\\Rightarrow a')
      .replace(/\\RightarrowF(?![A-Za-z])/g, '\\Rightarrow F')
      .replace(/\\ri(?![A-Za-z])/g, '\\pi')
      // Операторы без фигурных скобок в индексах: P_\max → P_{\max}
      .replace(/_\\max(?![A-Za-z])/g, '_{\\max}')
      .replace(/_\\min(?![A-Za-z])/g, '_{\\min}')
      .replace(/\^\\max(?![A-Za-z])/g, '^{\\max}')
      .replace(/\^\\min(?![A-Za-z])/g, '^{\\min}')
      // Двойные индексы без скобок: q_m_2 → q_{m_2}, v_0_x → v_{0_x}
      // Сначала закрываем аргумент акцента: \vec_a_1 → \vec{a}_1
      .replace(/\\(vec|bar|hat|tilde|dot|ddot|overline|underline|overrightarrow|overleftarrow)_([A-Za-z0-9])/g, '\\$1{$2}')
      .replace(/_\\text\{([^{}]*)\}_([A-Za-z0-9])/g, '_{\\text{$1}_{$2}}')
      .replace(/_([A-Za-z]+)_([A-Za-z0-9])/g, '_{$1_$2}')
      .replace(/_([0-9])_([A-Za-z0-9])/g, '_{$1_$2}')
      // \ChemFormN, \ChemForm Mg, \ChemForm^{A}_Z X и т.п.
      .replace(/\\ChemForm\s+([A-Z][a-z]?)/g, '\\mathrm{$1}')
      .replace(/\\ChemForm([A-Z][a-z]?)(?![A-Za-z])/g, '\\mathrm{$1}')
      .replace(/\\ChemForm(?![A-Za-z])/g, '');
  }

  function sanitizeLatex(value) {
    return fixKnownLatexTypos(stripInvisibleChars(value))
      .replace(/[α-ωΑ-Ωµ]/g, (ch) => `\\ensuremath{${GREEK_TO_LATEX[ch] || ch}}`)
      .replace(/²/g, '\\ensuremath{{}^{2}}')
      .replace(/³/g, '\\ensuremath{{}^{3}}')
      // Буквоподобные и типографские символы, которых нет в T2A.
      .replace(/ℰ/g, '\\ensuremath{\\mathcal{E}}')
      .replace(/ʋ/g, '\\ensuremath{\\upsilon}')
      .replace(/[óό]/g, 'о')
      .replace(/[º°]/g, '\\ensuremath{^\\circ}')
      .replace(/[′’]/g, "'")
      .replace(/‚/g, ',')
      .replace(/→/g, '\\ensuremath{\\to}')
      .replace(/←/g, '\\ensuremath{\\leftarrow}')
      .replace(/↑/g, '\\ensuremath{\\uparrow}')
      .replace(/↓/g, '\\ensuremath{\\downarrow}')
      .replace(/≈/g, '\\ensuremath{\\approx}')
      .replace(/−/g, '-')
      .replace(/–/g, '-')
      .replace(/·/g, '\\ensuremath{\\cdot}')
      .replace(/±/g, '\\ensuremath{\\pm}');
  }

  // Очистка единиц измерения для отображения в веб-бланке
  function cleanUnitForWeb(unit) {
    if (!unit) return '';
    return stripInvisibleChars(unit)
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
  let buildMode = 'standard';

  if (IDS_FILTER.length > 0) {
    // ── Режим --ids: выбираем задачи строго по указанным ID (--exam и --topics игнорируются)
    buildMode = 'ids';
    console.log(`[ИНФО] Режим --ids: отбор задач по ID: ${IDS_FILTER.join(', ')}`);
    const idSet = new Set(IDS_FILTER);
    selectedTasks = db.filter(t => idSet.has(String(t.id)));
    const foundIds = selectedTasks.map(t => String(t.id));
    const missing  = IDS_FILTER.filter(id => !foundIds.includes(id));
    if (missing.length > 0) {
      console.warn(`[ВНИМАНИЕ] Следующие ID не найдены в базе: ${missing.join(', ')}`);
    }
  } else {
    // ── Общий пул: фильтр по экзамену и (необязательно) темам/разделам
    let pool = db.filter(t => {
      if (String(t.exam || '').toUpperCase() !== EXAM) return false;
      if (TOPICS.length === 0) return true;
      return Array.isArray(t.topics) && t.topics.some(topic => TOPICS.includes(topic));
    });

    if (SELECTED_TOPICS.length > 0) {
      const selectedSet = new Set(SELECTED_TOPICS);
      pool = pool.filter((task) => matchesSelectedTopics(task, selectedSet));
      console.log(`[ИНФО] Узкие темы: ${SELECTED_TOPICS.join(', ')}. Задач в пуле: ${pool.length}.`);
    }

    if (pool.length === 0) {
      console.error(`[ВНИМАНИЕ] Не найдено задач по заданным критериям (экзамен: ${EXAM}, темы: ${TOPICS.join(', ') || 'все'}, узкие темы: ${SELECTED_TOPICS.join(', ') || 'все'})!`);
      process.exit(1);
    }

    if (LINE_PLAN_RAW) {
      // ── Кастомная матрица линий (--line-plan / --matrix-json)
      buildMode = 'line-plan';
      const plan = readLinePlan(LINE_PLAN_RAW);
      const requested = [...plan.values()].reduce((sum, spec) => sum + spec.count, 0);
      console.log(`[ИНФО] Режим матрицы линий: линий ${plan.size}, задач запрошено ${requested}.`);
      selectedTasks = selectByLinePlan(pool, plan, SELECTED_TOPICS);
    } else if (PART1_COUNT !== null || PART2_COUNT !== null || LIMIT_COUNT !== null) {
      // ── Совместимость: ручная выборка по частям / общий лимит
      buildMode = 'legacy-counts';
      if (PART1_COUNT !== null || PART2_COUNT !== null) {
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
      } else {
        // ── Режим --limit=N: случайная выборка из общего пула
        if (pool.length < LIMIT_COUNT) {
          console.warn(`[ВНИМАНИЕ] Запрошено ${LIMIT_COUNT} задач, но в пуле только ${pool.length}. Берём все доступные.`);
        }
        selectedTasks = pickRandom(pool, LIMIT_COUNT);
        console.log(`[ИНФО] --limit: выбрано ${selectedTasks.length} из ${pool.length} задач (запрошено ${LIMIT_COUNT}).`);
      }
    } else {
      // ── Режим по умолчанию: строгая спецификация реального экзамена.
      // ЕГЭ — ровно 1 задача для каждой линии 1…26, ОГЭ — 1 задача для каждой линии 1…22.
      buildMode = 'standard';
      const plan = new Map();
      for (let line = 1; line <= MAX_LINE; line++) {
        plan.set(line, { count: 1, subtopics: new Set() });
      }

      console.log(`[ИНФО] Стандартный вариант ${EXAM_SPEC.title}: строго по 1 задаче для линий 1–${MAX_LINE}${TOPICS.length ? ` (темы: ${TOPICS.join(', ')})` : ''}${SELECTED_TOPICS.length ? ` (узкие темы: ${SELECTED_TOPICS.join(', ')})` : ''}.`);
      selectedTasks = selectByLinePlan(pool, plan, SELECTED_TOPICS);

      const gotLines = new Set(selectedTasks.map(t => Number(t.kim_line)));
      const missingLines = [];
      for (let line = 1; line <= MAX_LINE; line++) {
        if (!gotLines.has(line)) missingLines.push(line);
      }
      if (missingLines.length > 0) {
        console.warn(`[ВНИМАНИЕ] В варианте нет задач для линий: ${missingLines.join(', ')}.`);
      }
    }
  }

  sortByKimLine(selectedTasks);

  if (selectedTasks.length === 0) {
    console.error(`[ОШИБКА] После применения всех фильтров список задач пуст.`);
    process.exit(1);
  }

  // Часть задачи определяем по номеру линии КИМ (надёжнее, чем поле part в базе),
  // чтобы часть 2 всегда начиналась с линии 21 (ЕГЭ) / 17 (ОГЭ).
  const partOfTask = (task) => {
    const line = Number(task.kim_line);
    if (Number.isInteger(line) && line >= 1) return line <= EXAM_SPEC.part1Lines ? 1 : 2;
    return Number(task.part) === 2 ? 2 : 1;
  };
  const part1Tasks = selectedTasks.filter(t => partOfTask(t) === 1);
  const part2Tasks = selectedTasks.filter(t => partOfTask(t) === 2);

  // Компактные рисунки: старые записи с центрированным \includegraphics
  // автоматически переводим на макрос \kimimg из fipi_style.sty.
  function compactFigureLatex(latex) {
    return String(latex || '')
      .replace(
        /\\begin\{center\}\s*\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}\s*\\end\{center\}/g,
        (_m, imgPath) => `\\kimimg{${imgPath}}`
      )
      // \begin{center} внутри ячеек tabular недопустим («Not allowed in LR mode»).
      .replace(/\\begin\{center\}\s*([\s\S]*?)\s*\\end\{center\}/g, '$1');
  }

  for (const t of selectedTasks) {
    t.latex_condition = sanitizeLatex(compactFigureLatex(t.latex_condition));
    t.latex_solution = sanitizeLatex(compactFigureLatex(t.latex_solution));
  }

  function renderTaskStudent(task, index) {
    let answerBlock = '';
    // В некоторых старых задачах таблица для ответа уже включена в условие —
    // не дублируем её автоматическим блоком.
    const hasEmbeddedAnswerTable = /\\begin\{tabular\}/.test(String(task.latex_condition || ''));
    if (partOfTask(task) === 1 && !hasEmbeddedAnswerTable) {
      if (Array.isArray(task.cols) && task.cols.length === 2) {
        answerBlock = `\\ansTwoCols{${sanitizeLatex(task.cols[0])}}{${sanitizeLatex(task.cols[1])}}`;
      } else if (task.grading_rule === 'ordered_sequence') {
        answerBlock = `\\ansAB`;
      } else {
        answerBlock = `\\ansline{${sanitizeLatex(task.unit || '')}}`;
      }
    }
    return `\\kimtask{${index}}{${task.latex_condition}\n${answerBlock}}`;
  }

  const refFileName = EXAM === 'EGE' ? 'ege_ref.tex' : 'oge_ref.tex';
  const grade = EXAM === 'EGE' ? '11' : '9';

  // ── 4. Генерация документа для ученика (КИМ) ────────────────────────────────
  let studentTex = `\\documentclass[11pt, a4paper]{article}
\\newcommand{\\ExamHeaderTitle}{${sanitizeLatex(TITLE)}}
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
        kim_line: Number(t.kim_line) || null,
        rule: t.grading_rule,
        max_points: t.max_points,
        answer: stripInvisibleChars(t.answer),
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
        kim_line: Number(t.kim_line) || null,
        rule: 'manual',
        max_points: t.max_points,
        answer: stripInvisibleChars(t.answer),
        solution: t.latex_solution
      });
      globalIndex++;
    }
  }

  studentTex += `\\end{document}\n`;

  // ── 5. Генерация документа для преподавателя (Ключи и решения) ──────────────
  let teacherTex = `\\documentclass[11pt, a4paper]{article}
\\newcommand{\\ExamHeaderTitle}{${sanitizeLatex(TITLE)} — КЛЮЧИ И РЕШЕНИЯ}
\\newcommand{\\ExamGrade}{${grade}}
\\usepackage{fipi_style}

\\begin{document}
`;

  if (part1Tasks.length > 0) {
    teacherTex += `\\section*{Таблица ответов к Части 1 (Вариант ${EXAM}-${VARIANT_ID})}
\\begin{tabular}{|c|c|c|c|c|c|}
\\hline
\\textbf{№} & \\textbf{Линия КИМ (ФИПИ)} & \\textbf{ID задачи} & \\textbf{Тип проверки} & \\textbf{Макс. балл} & \\textbf{Эталонный ответ} \\\\ \\hline
${keyMap.filter(k => k.part === 1).map(k => `${k.num} & ${k.kim_line ?? '-'} & \\texttt{${escapeLatex(k.id)}} & \\texttt{${escapeLatex(k.rule)}} & ${k.max_points} & \\textbf{${escapeAnswerCell(k.answer)}} \\\\ \\hline`).join('\n')}
\\end{tabular}
\\vspace{12pt}
`;
  }

  teacherTex += `\\section*{Разбор заданий и критерии оценивания}
${keyMap.map(k => `\\kimtask{${k.num}}{\\textbf{ID:} \\texttt{${escapeLatex(k.id)}} (Линия КИМ: ${k.kim_line ?? '—'}, макс. балл: ${k.max_points})\\\\[4pt] ${k.solution}\n\n\\noindent\\textbf{Ответ:} ${escapeAnswerCell(k.answer)}}`).join('\n\n')}
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
    build_mode: buildMode,
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
        kim_line: k.kim_line,
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
