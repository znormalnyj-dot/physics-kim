'use strict';

/**
 * Точечные и общие исправления LaTeX в tasks/db.json по результатам
 * реальной компиляции полного каталога.
 *
 *   node repair_latex_db.js            # только показать, что изменится
 *   node repair_latex_db.js --write    # записать db.json и отчёт
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DB_PATH = path.join(ROOT, 'tasks', 'db.json');
const BACKUP_PATH = path.join(ROOT, 'tasks', 'db.backup-before-latex-repair.json');
const REPORT_PATH = path.join(ROOT, 'tasks', 'latex_repair_report.json');
const WRITE = process.argv.includes('--write');

const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
const byId = new Map(db.map((task) => [String(task.id), task]));

// Общие замены, безопасные для всех задач.
const GLOBAL_REPAIRS = [
  { from: /՛/g, to: "'", note: 'U+055B → апостроф' },
  { from: /∙/g, to: '\\ensuremath{\\cdot}', note: 'U+2219 → \\cdot' },
  { from: /\\beginalign(?![A-Za-z])/g, to: '\\begin{aligned}', note: '\\beginalign → aligned' },
  { from: /\\endalign(?![A-Za-z])/g, to: '\\end{aligned}', note: '\\endalign → aligned' },
  { from: /\\rh(?![A-Za-z])/g, to: '\\rho', note: '\\rh → \\rho' }
];

// Исправления конкретных задач, найденные по логу pdflatex.
const TASK_REPAIRS = [
  {
    id: 'EGE-MKT-0115',
    field: 'latex_solution',
    replacements: [
      ['\\frac{p_He}{p_O_2}=\\frac{m_HeM_O_2}{m_O_2M_He}',
       '\\frac{p_{He}}{p_{O_2}}=\\frac{m_{He}M_{O_2}}{m_{O_2}M_{He}}'],
      ['p_HeV=\\frac{m_He}{M_He} RT;', 'p_{He}V=\\frac{m_{He}}{M_{He}} RT;'],
      ['p_O_2V=\\frac{m_O_2}{M_O_2} RT', 'p_{O_2}V=\\frac{m_{O_2}}{M_{O_2}} RT']
    ]
  },
  {
    id: 'EGE-MKT-0208',
    field: 'latex_condition',
    replacements: [['плотность газа $\\rh$o', 'плотность газа $\\rho$']]
  },
  {
    id: 'EGE-OPT-0103',
    field: 'latex_condition',
    replacements: [['W_2 \\mx', 'W_{2\\max}'], ['W_1 \\mx', 'W_{1\\max}']]
  },
  {
    id: 'EGE-OPT-0103',
    field: 'latex_solution',
    replacements: [['W_2 \\mx', 'W_{2\\max}'], ['W_1 \\mx', 'W_{1\\max}']]
  },
  {
    id: 'EGE-QUA-0056',
    field: 'latex_solution',
    replacements: [['$E_k=h v-A_$', '$E_k=h v-A$']]
  },
  {
    id: 'EGE-CON-0187',
    field: 'latex_solution',
    replacements: [['\\dfracgt^{2} 2', '\\dfrac{gt^{2}}{2}']]
  },
  {
    id: 'EGE-DYN-0175',
    field: 'latex_solution',
    replacements: [['\\left|', '|']]
  },
  {
    id: 'EGE-STA-0145',
    field: 'latex_solution',
    replacements: [['\\left|', '|']]
  }
];

const changes = [];
let changedTasks = 0;

// В двух задачах психрометрическая таблица была продублирована: внутри
// внешнего tabular оказался ещё один tabular с \hline без \\, а ниже шла
// нормальная копия таблицы. Оставляем одну корректную таблицу и рисунок.
const DUPLICATE_TABLE_IDS = new Set(['OGE-MSR-0220', 'OGE-MSR-0221']);

function buildPsychrometricTable(condition) {
  const beginToken = '\\begin{tabular}{|c|c|c|c|c|c|}';
  const endToken = '\\end{tabular}';
  const rowRe = /(\d+[.,]\d+)\s*&\s*\\textbf\{(\d+)\}\s*&\s*(\d+)\s*&\s*(\d+)\s*&\s*(\d+)\s*&\s*(\d+)/g;
  const dataRows = [];
  let match;
  while ((match = rowRe.exec(condition)) !== null) {
    const row = `${match[1]} & \\textbf{${match[2]}} & ${match[3]} & ${match[4]} & ${match[5]} & ${match[6]} \\\\`;
    if (!dataRows.includes(row)) dataRows.push(row);
  }
  if (dataRows.length < 10) return null;

  return [
    beginToken,
    '\\hline',
    'Плотность насыщенных паров воды, г/м$^{3}$ & ' +
      'Температура сухого термометра, $^\\circ$С & ' +
      '\\multicolumn{4}{c|}{Разность показаний сухого и влажного термометров, $^\\circ$С} \\\\',
    '\\hline',
    ' & & 3 & 4 & 5 & 6 \\\\',
    '\\hline',
    dataRows.join('\n\\hline\n'),
    '\\hline',
    endToken
  ].join('\n');
}

function repairDuplicatePsychrometricTable(task) {
  if (!DUPLICATE_TABLE_IDS.has(task.id)) return false;
  const condition = String(task.latex_condition || '');
  const firstTable = condition.indexOf('\\begin{tabular}');
  const endToken = '\\end{tabular}';
  const lastEnd = condition.lastIndexOf(endToken);
  if (firstTable < 0 || lastEnd < firstTable) return false;

  const normalizedTable = buildPsychrometricTable(condition);
  if (!normalizedTable) return false;

  const prefix = condition.slice(0, firstTable);
  const suffix = condition.slice(lastEnd + endToken.length);
  const image = condition.match(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/);
  const hasImage = /\\includegraphics/.test(prefix);
  const imageBlock = (!hasImage && image)
    ? `\\includegraphics[width=0.4\\linewidth]{${image[1]}}\n\n`
    : '';
  const nextCondition = `${prefix}${imageBlock}${normalizedTable}${suffix}`;

  if (nextCondition === condition) return false;
  task.latex_condition = nextCondition;
  changes.push({
    id: task.id,
    field: 'latex_condition',
    kind: 'task',
    note: 'психрометрическая таблица перестроена без вложенных \\hline'
  });
  return true;
}

function applyTaskRepairs(task) {
  let changed = repairDuplicatePsychrometricTable(task);
  for (const field of ['latex_condition', 'latex_solution']) {
    let value = String(task[field] == null ? '' : task[field]);
    const before = value;

    for (const rule of GLOBAL_REPAIRS) {
      const next = value.replace(rule.from, rule.to);
      if (next !== value) {
        changes.push({ id: task.id, field, kind: 'global', note: rule.note });
        value = next;
      }
    }

    for (const rule of TASK_REPAIRS) {
      if (rule.id !== task.id || rule.field !== field) continue;
      for (const [from, to] of rule.replacements) {
        if (value.includes(from)) {
          value = value.split(from).join(to);
          changes.push({ id: task.id, field, kind: 'task', note: `${from} → ${to}` });
        }
      }
    }

    if (value !== before) {
      task[field] = value;
      changed = true;
    }
  }

  if (changed) changedTasks += 1;
}

for (const task of db) applyTaskRepairs(task);

const report = {
  generated_at: new Date().toISOString(),
  write: WRITE,
  changed_tasks: changedTasks,
  changes
};

console.log(JSON.stringify(report, null, 2));

if (!WRITE) {
  console.log('\n[DRY-RUN] Для записи запустите: node repair_latex_db.js --write');
  process.exit(0);
}

if (changes.length > 0) {
  if (!fs.existsSync(BACKUP_PATH)) {
    fs.copyFileSync(DB_PATH, BACKUP_PATH);
    console.log(`Резервная копия: ${BACKUP_PATH}`);
  }
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\nЗаписан ${DB_PATH}`);
  console.log(`Отчёт: ${REPORT_PATH}`);
} else {
  console.log(`\nИзменений нет; ${DB_PATH} не изменён, отчёт сохранён.`);
}
