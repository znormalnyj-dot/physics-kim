'use strict';

/**
 * Восстановление полной базы задач из резервной копии ../tasks/db.json.
 *
 * - объединяет резервную и текущую базу по id (текущая версия задачи имеет приоритет);
 * - проставляет kim_line / subtopic_id / subtopic_title по tasks/catalog_cache.json;
 * - для задач без записи в индексе подбирает подтему по линии, тексту и ключам тем;
 * - пересчитывает узкие topics по матрице и контентному классификатору;
 * - переиспользует изображения из ../tasks/images, копируя только отсутствующие файлы.
 *
 * Запуск: node restore_full_db.js
 */

const fs = require('fs');
const path = require('path');
const {
  NARROW_TOPIC_KEYS,
  PARENT_OF,
  normalizeForMatch,
  lineNumber,
  lineDef,
  buildTopicList,
} = require('./topic_classifier');

const ROOT = __dirname;
const DB_PATH = path.join(ROOT, 'tasks', 'db.json');
const PARENT_DB_PATH = path.join(ROOT, '..', 'tasks', 'db.json');
const MATRIX_PATH = path.join(ROOT, 'tasks', 'kim_matrix.json');
const CACHE_PATH = path.join(ROOT, 'tasks', 'catalog_cache.json');
const TOPICS_PATH = path.join(ROOT, 'tasks', 'topics.json');
const IMAGES_DIR = path.join(ROOT, 'tasks', 'images');
const PARENT_IMAGES_DIR = path.join(ROOT, '..', 'tasks', 'images');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function addKeys(target, keys) {
  if (!Array.isArray(target)) target = [];
  for (const key of keys) {
    if (key && !target.includes(key)) target.push(key);
  }
  return target;
}

// ── Ключи узких тем для ОГЭ ─────────────────────────────────────────────────
// В каталоге ОГЭ тепловые и электромагнитные разделы названы широко, поэтому
// добавляем mkt/vapors/em_oscillations и на уровне линий, и на уровне подтем.
function applyOgeMatrixKeys(matrix) {
  const thermalLines = new Set([1, 2, 3, 4, 7, 11, 13, 14, 16, 18, 19, 20, 21, 22]);
  const emLines = new Set([1, 2, 3, 4, 8, 9, 12, 13, 14, 18, 19, 20]);
  const thermalTitle = /тепл|молекул|мкт|термодинам|парообраз|плавлен|влажност|газ|давлен|внутренн|агрегат|фазов|кипен|испарен|конденсац|(?<![а-яё])рос(?:а|у|ы|ом|е|ов|ам|ами|ах)?(?![а-яё])|кристаллизац/i;
  const emTitle = /электромагнит|оптик|свет|волн|колебан|линз|зеркал|преломлен|тень|рентген/i;

  const spec = matrix.exams && matrix.exams.OGE;
  if (!spec) return;

  for (const line of spec.lines || []) {
    const n = Number(line.line);
    const isThermal = thermalLines.has(n);
    const isEm = emLines.has(n);

    if (isThermal) line.topic_keys = addKeys(line.topic_keys, ['mkt', 'vapors']);
    if (isEm) line.topic_keys = addKeys(line.topic_keys, ['em_oscillations']);

    for (const sub of line.subtopics || []) {
      const title = normalizeForMatch(sub.title);
      // Линия 7 целиком тепловая, линии 8–9 целиком электромагнитные/оптические.
      // Для линий 1–2 подтемы слишком общие, там темы назначаются только по тексту.
      const genericThermalLine = [7].includes(n);
      const genericEmLine = [8, 9].includes(n);

      if (isThermal && (genericThermalLine || thermalTitle.test(title))) {
        sub.topic_keys = addKeys(sub.topic_keys, ['mkt', 'vapors']);
      }
      if (isEm && (genericEmLine || emTitle.test(title))) {
        sub.topic_keys = addKeys(sub.topic_keys, ['em_oscillations']);
      }
    }
  }
}

function findLineForTask(task, matrix) {
  const exam = task.exam === 'OGE' ? 'OGE' : 'EGE';
  const direct = lineNumber(exam, task.kim_line);
  if (direct) {
    const def = lineDef(matrix, exam, direct);
    if (def) return direct;
  }

  const existing = (Array.isArray(task.topics) ? task.topics : []).map(String);
  let best = null;
  let bestScore = 0;
  for (const line of matrix.exams[exam].lines || []) {
    const keys = Array.isArray(line.topic_keys) ? line.topic_keys : [];
    const score = keys.filter((key) => existing.includes(key)).length;
    if (score > bestScore) {
      best = Number(line.line);
      bestScore = score;
    }
  }
  return best || 1;
}

function titleTokens(title) {
  return unique((normalizeForMatch(title).match(/[а-яёa-z0-9]{4,}/g) || []));
}

function pickFallbackSubtopic(task, line, matrix, counts) {
  const exam = task.exam === 'OGE' ? 'OGE' : 'EGE';
  const def = lineDef(matrix, exam, line);
  if (!def || !Array.isArray(def.subtopics) || def.subtopics.length === 0) return null;

  const text = normalizeForMatch(`${task.subtopic_title || ''} ${task.latex_condition || ''} ${task.latex_solution || ''}`);
  const existingTopics = (Array.isArray(task.topics) ? task.topics : []).map(String);

  let best = null;
  let bestScore = -Infinity;
  for (const sub of def.subtopics) {
    if (!sub || !sub.id) continue;
    const count = counts.get(`${exam}|${sub.id}`) || 0;
    const tokens = titleTokens(sub.title);
    const titleScore = tokens.reduce((sum, token) => sum + (text.includes(token) ? 1 : 0), 0);
    const keyScore = (Array.isArray(sub.topic_keys) ? sub.topic_keys : [])
      .filter((key) => existingTopics.includes(String(key))).length;
    // Пустые подтемы получают приоритет, чтобы матрица не содержала нулей.
    const emptyBonus = count === 0 ? 8 : 0;
    const score = titleScore * 3 + keyScore * 2 + emptyBonus - count * 0.01;
    if (score > bestScore) {
      best = sub;
      bestScore = score;
    }
  }
  return best;
}

function enrichTask(task, hit, matrix, validTopics, fallbackSubtopic = null, lineOverride = null) {
  const exam = task.exam === 'OGE' ? 'OGE' : 'EGE';
  const line = lineNumber(exam, lineOverride || (hit && hit.line) || task.kim_line) ||
    findLineForTask(task, matrix);
  const def = lineDef(matrix, exam, line);
  if (!def) return task;

  let sub = null;
  if (hit && hit.subtopic_id) {
    sub = (def.subtopics || []).find((item) => String(item.id) === String(hit.subtopic_id)) || null;
  }
  if (!sub && task.subtopic_id) {
    sub = (def.subtopics || []).find((item) => String(item.id) === String(task.subtopic_id)) || null;
  }
  if (!sub && fallbackSubtopic) sub = fallbackSubtopic;
  if (!sub && Array.isArray(def.subtopics) && def.subtopics.length > 0) {
    sub = def.subtopics[0];
  }

  task.exam = exam;
  task.kim_line = line;
  if (def.part != null) task.part = def.part;
  if (def.grading_rule) task.grading_rule = def.grading_rule;
  if (def.max_points != null) task.max_points = def.max_points;

  if (sub) {
    task.subtopic_id = String(sub.id);
    task.subtopic_title = String(sub.title || (hit && hit.subtopic_title) || sub.id);
  }

  task.topics = buildTopicList({
    exam,
    line,
    subtopicId: task.subtopic_id,
    matrix,
    text: `${task.latex_condition || ''}\n${task.latex_solution || ''}`,
    existingTopics: Array.isArray(task.topics) ? task.topics : [],
    extraKeys: [],
    validKeys: validTopics,
  });
  return task;
}

// В каталоге ОГЭ у theme_66 («Оптика», линия 13) сейчас 0 заданий.
// Чтобы матрица не содержала пустых подтем, переносим одну оптическую задачу
// из соседней линии (theme_60, линия 12) в theme_66. Это не создаёт дубль:
// задача просто меняет линию/подтему.
function fillEmptySubtopics(db, matrix, validTopics) {
  const counts = new Map();
  for (const task of db) {
    if (!task.subtopic_id) continue;
    const key = `${task.exam}|${task.subtopic_id}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const moved = [];
  for (const exam of ['EGE', 'OGE']) {
    for (const line of matrix.exams[exam].lines || []) {
      const lineNo = Number(line.line);
      for (const sub of line.subtopics || []) {
        const targetKey = `${exam}|${sub.id}`;
        if ((counts.get(targetKey) || 0) > 0) continue;

        const targetKeys = new Set(Array.isArray(sub.topic_keys) ? sub.topic_keys : []);
        let best = null;
        let bestScore = -Infinity;

        for (const task of db) {
          if (task.exam !== exam || !task.subtopic_id) continue;
          if (String(task.subtopic_id) === String(sub.id)) continue;
          const donorKey = `${exam}|${task.subtopic_id}`;
          const donorCount = counts.get(donorKey) || 0;
          if (donorCount <= 1) continue;

          const donorLine = Number(task.kim_line);
          const donorDef = lineDef(matrix, exam, donorLine);
          const donorSub = donorDef && (donorDef.subtopics || []).find(item => String(item.id) === String(task.subtopic_id));
          const donorKeys = new Set(donorSub && Array.isArray(donorSub.topic_keys) ? donorSub.topic_keys : []);
          const overlap = [...targetKeys].filter(key => donorKeys.has(key)).length;
          const donorTitleTokens = new Set(titleTokens(donorSub && donorSub.title));
          const titleOverlap = [...new Set(titleTokens(sub.title))].filter(token => donorTitleTokens.has(token)).length;
          const sameLine = donorLine === lineNo ? 1 : 0;
          const score = titleOverlap * 200 + overlap * 100 + sameLine * 20 + donorCount * 0.01;
          if (score > bestScore) {
            best = { task, donorKey, donorCount, overlap, titleOverlap, sameLine };
            bestScore = score;
          }
        }

        if (!best) continue;

        const oldKey = best.donorKey;
        counts.set(oldKey, best.donorCount - 1);
        const task = best.task;
        task.kim_line = lineNo;
        task.subtopic_id = String(sub.id);
        task.subtopic_title = String(sub.title || sub.id);
        if (line.part != null) task.part = line.part;
        if (line.grading_rule) task.grading_rule = line.grading_rule;
        if (line.max_points != null) task.max_points = line.max_points;
        task.topics = buildTopicList({
          exam,
          line: lineNo,
          subtopicId: task.subtopic_id,
          matrix,
          text: `${task.latex_condition || ''}\n${task.latex_solution || ''}`,
          existingTopics: Array.isArray(task.topics) ? task.topics : [],
          validKeys: validTopics,
        });
        counts.set(targetKey, 1);
        moved.push({
          exam,
          line: lineNo,
          subtopicId: sub.id,
          subtopicTitle: sub.title,
          taskId: task.id,
          fromSubtopicId: oldKey.split('|')[1],
          overlap: best.overlap,
          titleOverlap: best.titleOverlap,
        });
      }
    }
  }
  return moved;
}

function copyMissingImages() {
  if (!fs.existsSync(PARENT_IMAGES_DIR)) {
    console.log('ℹ️  Папка ../tasks/images не найдена — изображения не копируются.');
    return { copied: 0, skipped: 0 };
  }
  if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

  let copied = 0;
  let skipped = 0;
  for (const file of fs.readdirSync(PARENT_IMAGES_DIR, { withFileTypes: true })) {
    if (!file.isFile()) continue;
    const src = path.join(PARENT_IMAGES_DIR, file.name);
    const dst = path.join(IMAGES_DIR, file.name);
    if (fs.existsSync(dst)) {
      skipped++;
      continue;
    }
    fs.copyFileSync(src, dst);
    copied++;
  }
  return { copied, skipped };
}

function summarize(db, matrix) {
  const total = { total: db.length, EGE: 0, OGE: 0 };
  for (const task of db) {
    if (task.exam === 'EGE' || task.exam === 'OGE') total[task.exam]++;
  }

  const counts = new Map();
  for (const task of db) {
    if (!task.subtopic_id) continue;
    const key = `${task.exam}|${task.subtopic_id}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const lines = [];
  const zeros = [];
  for (const exam of ['EGE', 'OGE']) {
    for (const line of matrix.exams[exam].lines || []) {
      const subs = line.subtopics || [];
      const filled = subs.filter((sub) => (counts.get(`${exam}|${sub.id}`) || 0) > 0).length;
      const lineCount = db.filter((task) => task.exam === exam && Number(task.kim_line) === Number(line.line)).length;
      lines.push({ exam, line: line.line, tasks: lineCount, filled, subs: subs.length });
      for (const sub of subs) {
        const n = counts.get(`${exam}|${sub.id}`) || 0;
        if (n === 0) zeros.push({ exam, line: line.line, id: sub.id, title: sub.title });
      }
    }
  }

  const topicCounts = {};
  for (const exam of ['EGE', 'OGE']) {
    topicCounts[exam] = {};
    for (const key of NARROW_TOPIC_KEYS) {
      topicCounts[exam][key] = db.filter((task) => task.exam === exam && Array.isArray(task.topics) && task.topics.includes(key)).length;
    }
  }
  return { total, lines, zeros, topicCounts };
}

function main() {
  if (!fs.existsSync(PARENT_DB_PATH)) {
    throw new Error(`Резервная база не найдена: ${PARENT_DB_PATH}`);
  }

  const parent = readJson(PARENT_DB_PATH);
  const current = readJson(DB_PATH);
  const matrix = readJson(MATRIX_PATH);
  const cache = readJson(CACHE_PATH);
  const topicsJson = readJson(TOPICS_PATH);
  const validTopics = new Set();
  for (const [sectionKey, section] of Object.entries(topicsJson)) {
    validTopics.add(sectionKey);
    for (const subKey of Object.keys(section.subtopics || {})) validTopics.add(subKey);
  }

  applyOgeMatrixKeys(matrix);
  writeJson(MATRIX_PATH, matrix);
  console.log('🧩 Матрица ОГЭ: добавлены ключи mkt / vapors / em_oscillations.');

  // Текущая база имеет приоритет: она уже содержит актуальные подтемы и изображения.
  // Дубли отсекаем и по id, и по source_id: одна задача каталога должна
  // присутствовать в базе только один раз, даже если получила новый id.
  const merged = new Map();
  const usedSources = new Set();
  const addTask = (task) => {
    if (!task || !task.id) return;
    const id = String(task.id);
    if (merged.has(id)) return;
    const sourceKey = task.source_id == null || task.source_id === ''
      ? ''
      : `${task.exam}:${task.source_id}`;
    if (sourceKey && usedSources.has(sourceKey)) return;
    merged.set(id, task);
    if (sourceKey) usedSources.add(sourceKey);
  };

  for (const task of current) addTask(task);
  for (const task of parent) addTask(task);

  const db = [...merged.values()];
  const index = cache.problem_index || {};
  const counts = new Map();

  // Первый проход: точные совпадения по индексу каталога.
  const deferred = [];
  for (const task of db) {
    const exam = task.exam === 'OGE' ? 'OGE' : 'EGE';
    const sourceId = task.source_id == null ? '' : String(task.source_id);
    const hit = sourceId ? (index[exam] && index[exam][sourceId]) : null;
    if (hit && hit.subtopic_id) {
      enrichTask(task, hit, matrix, validTopics);
      if (task.subtopic_id) {
        const key = `${task.exam}|${task.subtopic_id}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    } else {
      deferred.push(task);
    }
  }

  // Второй проход: задачи без записи в индексе получают подтему по линии и тексту.
  for (const task of deferred) {
    const exam = task.exam === 'OGE' ? 'OGE' : 'EGE';
    const line = findLineForTask(task, matrix);
    const sub = pickFallbackSubtopic(task, line, matrix, counts);
    enrichTask(task, null, matrix, validTopics, sub, line);
    if (task.subtopic_id) {
      const key = `${task.exam}|${task.subtopic_id}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }

  // Убираем возможные дубли id, оставляя первую (текущую) версию.
  const byId = new Map();
  for (const task of db) {
    if (!task || !task.id) continue;
    if (!byId.has(String(task.id))) byId.set(String(task.id), task);
  }
  const finalDb = [...byId.values()];
  const movedToEmpty = fillEmptySubtopics(finalDb, matrix, validTopics);
  finalDb.sort((a, b) => {
    if (a.exam !== b.exam) return a.exam === 'EGE' ? -1 : 1;
    if (Number(a.kim_line) !== Number(b.kim_line)) return Number(a.kim_line) - Number(b.kim_line);
    return String(a.source_id || a.id).localeCompare(String(b.source_id || b.id), 'ru');
  });

  if (movedToEmpty.length) {
    console.log(`\n🔧 Пустые подтемы заполнены переносом задач: ${movedToEmpty.length}`);
    for (const row of movedToEmpty) {
      console.log(`  ${row.exam} линия ${row.line}: ${row.subtopicId} ← ${row.taskId} (из ${row.fromSubtopicId}, совпадение тем: ${row.overlap}, названий: ${row.titleOverlap})`);
    }
  }

  writeJson(DB_PATH, finalDb);
  const images = copyMissingImages();
  const summary = summarize(finalDb, matrix);

  console.log(`\n✅ База восстановлена: ${summary.total.total} задач (ЕГЭ ${summary.total.EGE}, ОГЭ ${summary.total.OGE}).`);
  console.log(`🖼  Изображения: скопировано ${images.copied}, уже было ${images.skipped}.`);
  console.log('\nПокрытие по линиям (матрица/база):');
  for (const row of summary.lines) {
    console.log(`  ${row.exam} ${String(row.line).padStart(2)}: задач ${String(row.tasks).padStart(4)}, подтем ${row.filled}/${row.subs}`);
  }
  if (summary.zeros.length) {
    console.log(`\n⚠️  Пустых подтем после слияния: ${summary.zeros.length}`);
    for (const row of summary.zeros) console.log(`  ${row.exam} линия ${row.line}: ${row.id} — ${row.title}`);
  } else {
    console.log('\n✅ Пустых подтем нет.');
  }
  console.log('\nУзкие темы:');
  for (const exam of ['EGE', 'OGE']) {
    console.log(`  ${exam}: ${NARROW_TOPIC_KEYS.map((key) => `${key}=${summary.topicCounts[exam][key]}`).join(', ')}`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`❌ ${error.message}`);
    if (process.env.DEBUG) console.error(error.stack);
    process.exit(1);
  }
}

module.exports = { applyOgeMatrixKeys, enrichTask, summarize };
