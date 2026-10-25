'use strict';

/**
 * Полный PDF-каталог всех задач ЕГЭ или ОГЭ.
 *
 * Запуск:
 *   node build_full_catalog.js --exam=EGE
 *   node build_full_catalog.js --exam=OGE
 *
 * Для отладки можно ограничить выборку:
 *   --lines=1,5,6   --limit=50   --offset=0
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const {
  sanitizeLatex,
  compactFigureLatex,
  escapeLatex,
  escapeAnswerCell
} = require('./latex_sanitizer');

const ROOT = __dirname;
const TASKS_DIR = path.join(ROOT, 'tasks');
const OUT_DIR = path.join(ROOT, 'output');

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...value] = arg.replace(/^--/, '').split('=');
    return [key, value.join('=')];
  })
);

const EXAM = String(args.exam || 'EGE').toUpperCase();
if (EXAM !== 'EGE' && EXAM !== 'OGE') {
  console.error('[ОШИБКА] --exam должен быть EGE или OGE.');
  process.exit(1);
}

const MAX_LINE = EXAM === 'EGE' ? 26 : 22;
const GRADE = EXAM === 'EGE' ? '11' : '9';
const LINE_FILTER = args.lines
  ? new Set(String(args.lines).split(',').map((v) => Number(v.trim())).filter((v) => Number.isInteger(v)))
  : null;
const LIMIT = args.limit !== undefined ? Number(args.limit) : null;
const OFFSET = args.offset !== undefined ? Number(args.offset) : 0;
const PART_SUFFIX = (LINE_FILTER || LIMIT !== null || OFFSET > 0) ? '_PART' : '';
const JOB_NAME = `ALL_${EXAM}_Catalog${PART_SUFFIX}`;
const TEX_PATH = path.join(OUT_DIR, `${JOB_NAME}.tex`);
const PDF_PATH = path.join(OUT_DIR, `${JOB_NAME}.pdf`);
const LOG_PATH = path.join(OUT_DIR, `${JOB_NAME}.log`);
const ERROR_PATH = path.join(OUT_DIR, `catalog_errors_${EXAM}${PART_SUFFIX}.json`);

function taskLine(task) {
  const line = Number(task.kim_line);
  return Number.isInteger(line) && line >= 1 ? line : 9999;
}

function taskId(task) {
  return String(task.id || '');
}

function markerId(task) {
  return taskId(task).replace(/[^A-Za-z0-9-]/g, '-');
}

function renderTask(task, index) {
  const id = taskId(task);
  const marker = markerId(task);
  const line = Number.isInteger(Number(task.kim_line)) ? Number(task.kim_line) : '—';
  const topics = Array.isArray(task.topics) && task.topics.length > 0
    ? task.topics.join(', ')
    : '—';
  const condition = sanitizeLatex(compactFigureLatex(task.latex_condition));
  const solution = sanitizeLatex(compactFigureLatex(task.latex_solution));
  const answer = escapeAnswerCell(task.answer == null ? '' : task.answer);

  return [
    `\\typeout{CATALOG_TASK_BEGIN:${marker}}`,
    `\\par\\noindent\\textbf{№ ${index}. ID:}~\\texttt{${escapeLatex(id)}}` +
      `\\quad\\textbf{Линия:}~${line}\\quad\\textbf{Тема:}~\\texttt{${escapeLatex(topics)}}\\par`,
    '\\smallskip',
    condition,
    '\\par\\smallskip',
    `\\noindent\\textbf{Ответ:}~${answer}`,
    solution ? `\\par\\smallskip\\noindent\\textbf{Решение:}\\par\\footnotesize ${solution}\\normalsize` : '',
    '\\par\\medskip\\hrule\\medskip',
    `\\typeout{CATALOG_TASK_END:${marker}}`,
    ''
  ].filter(Boolean).join('\n');
}

function copyRuntimeFiles() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, 'templates', 'fipi_style.sty'),
    path.join(OUT_DIR, 'fipi_style.sty')
  );

  const imagesSrc = path.join(TASKS_DIR, 'images');
  const imagesDst = path.join(OUT_DIR, 'images');
  if (!fs.existsSync(imagesDst)) fs.mkdirSync(imagesDst, { recursive: true });
  if (fs.existsSync(imagesSrc)) {
    for (const file of fs.readdirSync(imagesSrc)) {
      if (file === '.gitkeep') continue;
      const src = path.join(imagesSrc, file);
      const dst = path.join(imagesDst, file);
      try {
        const srcStat = fs.statSync(src);
        if (!srcStat.isFile()) continue;
        if (!fs.existsSync(dst) || fs.statSync(dst).size !== srcStat.size) {
          fs.copyFileSync(src, dst);
        }
      } catch {
        // Повреждённый/недоступный файл обнаружится при компиляции.
      }
    }
  }
}

function runLatex(texFile) {
  try {
    const stdout = execSync(
      `cmd /c "chcp 65001 >nul && pdflatex -interaction=nonstopmode -file-line-error -jobname=${JOB_NAME} ${texFile}"`,
      { cwd: OUT_DIR, stdio: 'pipe', maxBuffer: 200 * 1024 * 1024 }
    );
    return { ok: true, output: stdout.toString() };
  } catch (error) {
    return {
      ok: false,
      output: String(error.stdout || '') + String(error.stderr || '') + '\n' + String(error.message || '')
    };
  }
}

function parseLog() {
  if (!fs.existsSync(LOG_PATH)) {
    return { errors: [], pages: null, output: '' };
  }
  const log = fs.readFileSync(LOG_PATH, 'utf8');
  const lines = log.split(/\r?\n/);
  const errors = [];
  let currentTask = null;
  let currentTaskIndex = 0;
  let currentTaskLine = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const begin = line.match(/CATALOG_TASK_BEGIN:([A-Za-z0-9-]+)/);
    if (begin) {
      currentTask = begin[1];
      currentTaskIndex = i + 1;
      currentTaskLine = null;
      continue;
    }
    const end = line.match(/CATALOG_TASK_END:([A-Za-z0-9-]+)/);
    if (end) {
      currentTask = null;
      continue;
    }

    const fileLine = line.match(/^(.+?\.tex):(\d+):\s*(?:!\s*)?(.+)$/);
    const plain = line.match(/^!\s*(.+)$/);
    if (fileLine || plain) {
      const message = (fileLine ? fileLine[3] : plain[1]).trim();
      // С -file-line-error предупреждения тоже имеют формат file:line,
      // но фатальными не являются.
      const isWarning = /^(Overfull|Underfull|LaTeX Warning|Package .* Warning|Missing character)/i.test(message);
      if (!isWarning) {
        const context = lines.slice(i, Math.min(lines.length, i + 8)).join('\n');
        errors.push({
          task: currentTask,
          taskIndex: currentTask ? currentTaskIndex : null,
          message,
          logLine: i + 1,
          context
        });
      }
    }
  }

  const pageMatch = log.match(/Output written on .*?\((\d+)\s+pages?/);
  return {
    errors,
    pages: pageMatch ? Number(pageMatch[1]) : null,
    output: log
  };
}

function main() {
  const dbPath = path.join(TASKS_DIR, 'db.json');
  if (!fs.existsSync(dbPath)) {
    console.error(`[ОШИБКА] Не найдена база: ${dbPath}`);
    process.exit(1);
  }

  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  let tasks = db.filter((task) => String(task.exam || '').toUpperCase() === EXAM);

  if (LINE_FILTER) {
    tasks = tasks.filter((task) => LINE_FILTER.has(Number(task.kim_line)));
  }
  tasks.sort((a, b) => {
    const lineDiff = taskLine(a) - taskLine(b);
    if (lineDiff !== 0) return lineDiff;
    return taskId(a).localeCompare(taskId(b), 'ru', { numeric: true });
  });

  if (OFFSET > 0) tasks = tasks.slice(OFFSET);
  if (LIMIT !== null) tasks = tasks.slice(0, Math.max(0, LIMIT));

  if (tasks.length === 0) {
    console.error('[ОШИБКА] Выборка пуста.');
    process.exit(1);
  }

  const selectedLines = [...new Set(tasks.map(taskLine).filter((line) => line !== 9999))].sort((a, b) => a - b);
  const title = `Полный каталог задач ${EXAM}` +
    (PART_SUFFIX ? ` (часть: линии ${selectedLines.join(', ') || '—'})` : '');

  let tex = `\\documentclass[10pt, a4paper]{article}
\\newcommand{\\ExamHeaderTitle}{${title}}
\\newcommand{\\ExamGrade}{${GRADE}}
\\usepackage{fipi_style}
\\maxdeadcycles=2000
\\setlength{\\parindent}{0pt}
\\setlength{\\parskip}{2pt}
\\begin{document}
\\section*{${title}}
\\noindent\\textbf{Всего задач:} ${tasks.length}\\quad
\\textbf{Линии:} ${selectedLines.length ? selectedLines.join(', ') : '—'}\\par
\\bigskip
`;

  tasks.forEach((task, index) => {
    tex += renderTask(task, index + 1) + '\n';
  });
  tex += '\\end{document}\n';

  copyRuntimeFiles();
  fs.writeFileSync(TEX_PATH, tex, 'utf8');
  console.log(`[КАТАЛОГ] ${EXAM}: задач ${tasks.length}, линий ${selectedLines.length}, файл ${TEX_PATH}`);
  console.log(`[КАТАЛОГ] Компиляция ${JOB_NAME} (проход 1)...`);
  const first = runLatex(`${JOB_NAME}.tex`);
  let parsed = parseLog();

  if (parsed.errors.length === 0) {
    console.log('[КАТАЛОГ] Проход 1 без ошибок, компиляция прохода 2...');
    runLatex(`${JOB_NAME}.tex`);
    parsed = parseLog();
  } else {
    console.error(`[КАТАЛОГ] Найдено ошибок LaTeX: ${parsed.errors.length}`);
    parsed.errors.slice(0, 40).forEach((error, index) => {
      console.error(`  ${index + 1}. ${error.task || '(вне задачи)'} — ${error.message}`);
    });
  }

  const pdfExists = fs.existsSync(PDF_PATH) && fs.statSync(PDF_PATH).size > 0;
  const result = {
    generated_at: new Date().toISOString(),
    exam: EXAM,
    job: JOB_NAME,
    tasks: tasks.length,
    lines: selectedLines,
    pages: parsed.pages,
    pdf: pdfExists ? PDF_PATH : null,
    pdf_bytes: pdfExists ? fs.statSync(PDF_PATH).size : 0,
    errors_count: parsed.errors.length,
    errors: parsed.errors,
    first_run_ok: first.ok
  };
  fs.writeFileSync(ERROR_PATH, JSON.stringify(result, null, 2), 'utf8');

  if (!pdfExists || parsed.errors.length > 0) {
    console.error(`[КАТАЛОГ] ОШИБКИ: ${parsed.errors.length}; PDF: ${pdfExists ? 'есть' : 'нет'}.`);
    console.error(`[КАТАЛОГ] Отчёт: ${ERROR_PATH}`);
    process.exit(1);
  }

  console.log(`[КАТАЛОГ] ГОТОВО: ${PDF_PATH}`);
  console.log(`[КАТАЛОГ] Страниц: ${parsed.pages == null ? '?' : parsed.pages}, размер: ${(result.pdf_bytes / 1024 / 1024).toFixed(1)} МБ`);
  console.log(`[КАТАЛОГ] Отчёт: ${ERROR_PATH}`);
}

main();
