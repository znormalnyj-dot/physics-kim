#!/usr/bin/env node
/**
 * import_task.js — утилита пополнения и валидации базы tasks/db.json
 *
 * Режимы:
 *   node import_task.js --validate   — валидация + статистика базы
 *   node import_task.js              — ИИ-импорт из папки inbox/
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Пути ────────────────────────────────────────────────────────────────────

const ROOT        = __dirname;
const DB_PATH     = path.join(ROOT, 'tasks', 'db.json');
const TOPICS_PATH = path.join(ROOT, 'tasks', 'topics.json');
const INBOX_DIR   = path.join(ROOT, 'inbox');
const PROCESSED   = path.join(INBOX_DIR, 'processed');
const ENV_PATH    = path.join(ROOT, '.env');
const CFG_PATH    = path.join(ROOT, 'config.json');

// ─── Подготовка директорий ────────────────────────────────────────────────────

function ensureDirs () {
  [INBOX_DIR, PROCESSED].forEach(d => {
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true });
      console.log(`📁 Создана папка: ${path.relative(ROOT, d)}`);
    }
  });
}

// ─── Чтение JSON без краша ────────────────────────────────────────────────────

function readJSON (filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.error(`❌ Не удалось прочитать ${filePath}: ${e.message}`);
    process.exit(1);
  }
}

// ─── Вспомогательные функции LaTeX-проверки ──────────────────────────────────

/**
 * Проверяет, что знаки $ идут парами (чётное количество).
 * Учитывает двойной $$ как два знака, что тоже даёт чётность.
 */
function checkDollarParity (text) {
  // Считаем одиночные $ (не двойные $$)
  // Простая эвристика: заменяем $$ на пустую строку, считаем оставшиеся $
  const stripped = text.replace(/\$\$/g, '');
  const count    = (stripped.match(/\$/g) || []).length;
  return count % 2 === 0;
}

/**
 * Ищет неэкранированные _ и % вне математических блоков $...$.
 * Возвращает массив найденных проблем.
 */
function findBadCharsOutsideMath (text) {
  const issues = [];
  // Разбиваем по знакам $, нечётные индексы — внутри math
  const parts = text.split('$');
  parts.forEach((chunk, idx) => {
    const inMath = idx % 2 !== 0;
    if (!inMath) {
      // Ищем % вне math (не через \\%)
      const badPercent = chunk.match(/(?<!\\)%/g);
      if (badPercent) {
        issues.push(`неэкранированный '%' вне math-блока`);
      }
      // Ищем _ вне math (не через \\_)
      const badUnderscore = chunk.match(/(?<!\\)_/g);
      if (badUnderscore) {
        issues.push(`неэкранированный '_' вне math-блока`);
      }
    }
  });
  return issues;
}

// ─── Коллекция всех допустимых тегов topics ──────────────────────────────────

function collectValidTags (topicsJson) {
  const tags = new Set();
  for (const [sectionKey, section] of Object.entries(topicsJson)) {
    tags.add(sectionKey);
    if (section.subtopics) {
      for (const subKey of Object.keys(section.subtopics)) {
        tags.add(subKey);
      }
    }
  }
  return tags;
}

// ─── РЕЖИМ ВАЛИДАЦИИ ─────────────────────────────────────────────────────────

const REQUIRED_FIELDS = [
  'id', 'exam', 'part', 'kim_line',
  'topics', 'grading_rule', 'max_points',
  'answer', 'latex_condition', 'latex_solution',
];

function runValidate () {
  console.log('\n══════════════════════════════════════════');
  console.log('  ВАЛИДАЦИЯ БАЗЫ tasks/db.json');
  console.log('══════════════════════════════════════════\n');

  const db     = readJSON(DB_PATH);
  const topics = readJSON(TOPICS_PATH);
  const valid  = collectValidTags(topics);

  let errorCount   = 0;
  let warningCount = 0;

  const stats = {
    total : db.length,
    exams : {},   // EGE / OGE
    parts : {},   // 1 / 2
    sections: {}, // разделы (ключи первого уровня topics.json)
  };

  // ── Инициализация счётчиков разделов ──
  for (const key of Object.keys(topics)) {
    stats.sections[key] = 0;
  }

  db.forEach((task, i) => {
    const label  = task.id || `#${i + 1}`;
    const errors = [];

    // 1. Обязательные поля
    for (const field of REQUIRED_FIELDS) {
      if (task[field] === undefined || task[field] === null || task[field] === '') {
        errors.push(`отсутствует поле «${field}»`);
      }
    }

    // 2. Теги topics
    if (Array.isArray(task.topics)) {
      for (const tag of task.topics) {
        if (!valid.has(tag)) {
          errors.push(`неизвестный тег topics: «${tag}»`);
        }
      }
    }

    // 3. LaTeX-проверки
    for (const field of ['latex_condition', 'latex_solution']) {
      const txt = task[field];
      if (typeof txt !== 'string') continue;

      if (!checkDollarParity(txt)) {
        errors.push(`непарные знаки $ в «${field}»`);
      }
      const badChars = findBadCharsOutsideMath(txt);
      badChars.forEach(msg => errors.push(`${msg} в «${field}»`));
    }

    // ── Вывод ──
    if (errors.length) {
      console.log(`⚠️  [${label}]`);
      errors.forEach(e => console.log(`     • ${e}`));
      errorCount += errors.length;
      warningCount++;
    }

    // ── Статистика ──
    const exam = task.exam || 'unknown';
    stats.exams[exam] = (stats.exams[exam] || 0) + 1;

    const part = task.part != null ? String(task.part) : 'unknown';
    stats.parts[part] = (stats.parts[part] || 0) + 1;

    if (Array.isArray(task.topics)) {
      for (const tag of task.topics) {
        if (stats.sections[tag] !== undefined) {
          stats.sections[tag]++;
        }
      }
    }
  });

  // ── Итог валидации ──
  console.log('\n──────────────────────────────────────────');
  if (warningCount === 0) {
    console.log('✅  Все задачи прошли валидацию без ошибок.');
  } else {
    console.log(`❌  Задач с ошибками: ${warningCount} (всего нарушений: ${errorCount})`);
  }

  // ── Сводная статистика ──
  console.log('\n══════════════════════════════════════════');
  console.log('  СТАТИСТИКА БАЗЫ');
  console.log('══════════════════════════════════════════\n');

  console.log(`📦  Всего задач: ${stats.total}\n`);

  console.log('📊  По экзаменам:');
  for (const [k, v] of Object.entries(stats.exams)) {
    console.log(`     ${k.padEnd(6)} — ${v} задач`);
  }

  console.log('\n📊  По частям КИМ:');
  for (const [k, v] of Object.entries(stats.parts)) {
    console.log(`     Часть ${k.padEnd(3)} — ${v} задач`);
  }

  console.log('\n📊  По разделам тем (topics.json):');
  for (const [key, count] of Object.entries(stats.sections)) {
    const title = topics[key]?.title || key;
    const bar   = '█'.repeat(Math.min(count, 20));
    console.log(`     ${title.padEnd(45)} ${bar} ${count}`);
  }
  console.log('\n══════════════════════════════════════════\n');
}

// ─── РЕЖИМ ИИ-ИМПОРТА ────────────────────────────────────────────────────────

/** Читает GEMINI_API_KEY из .env или config.json */
function getApiKey () {
  // 1. .env
  if (fs.existsSync(ENV_PATH)) {
    const lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
    for (const line of lines) {
      const m = line.match(/^\s*GEMINI_API_KEY\s*=\s*(.+)\s*$/);
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    }
  }
  // 2. config.json
  if (fs.existsSync(CFG_PATH)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
      if (cfg.GEMINI_API_KEY) return cfg.GEMINI_API_KEY;
    } catch (_) {}
  }
  // 3. Переменная окружения
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  return null;
}

/** Сканирует inbox/ на поддерживаемые файлы */
function findInboxFiles () {
  if (!fs.existsSync(INBOX_DIR)) return [];
  const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg']);
  const TEXT_EXT  = new Set(['.txt', '.md']);
  return fs.readdirSync(INBOX_DIR).filter(name => {
    const ext  = path.extname(name).toLowerCase();
    const full = path.join(INBOX_DIR, name);
    return fs.statSync(full).isFile() && (IMAGE_EXT.has(ext) || TEXT_EXT.has(ext));
  });
}

/** Генерирует уникальный ID в формате EXAM-TOPIC-XXXX */
function generateId (db, exam, topics) {
  const examPart  = (exam || 'TASK').toUpperCase();
  const topicPart = (topics && topics[0] ? topics[0] : 'GEN').toUpperCase();
  const existingIds = new Set((db || []).map(t => t.id));
  for (let i = 1; i <= 9999; i++) {
    const candidate = `${examPart}-${topicPart}-${String(i).padStart(4, '0')}`;
    if (!existingIds.has(candidate)) return candidate;
  }
  return `${examPart}-${topicPart}-${Date.now()}`;
}

/** Вызывает Gemini REST API и возвращает распознанный объект задачи */
async function callGemini (apiKey, fileObj) {
  const topicsRaw  = fs.readFileSync(TOPICS_PATH, 'utf8');
  const topicsJson = JSON.parse(topicsRaw);
  const validTags  = JSON.stringify(collectValidTags(topicsJson), null, 2).replace(
    /\[object Set\]/g, ''
  );
  // Список тегов для промпта
  const tagList = [...collectValidTags(topicsJson)].join(', ');

  const SYSTEM_PROMPT = `Ты помощник-физик для создания задач в базе данных КИМ ЕГЭ/ОГЭ по физике.
На вход получаешь изображение или текст с задачей физики.
Твоя задача — распознать условие и решение, оформить все математические формулы в LaTeX ($...$).

Верни СТРОГО один JSON-объект (без markdown-обёртки \`\`\`json, без пояснений):
{
  "exam": "EGE" | "OGE",
  "part": 1 | 2,
  "kim_line": <номер линии КИМ, число>,
  "topics": [<теги из списка: ${tagList}>],
  "grading_rule": "numeric" | "unordered_set" | "ordered_sequence" | "manual",
  "max_points": <число>,
  "answer": "<эталонный ответ строкой>",
  "unit": "<единица измерения в LaTeX или пустая строка>",
  "latex_condition": "<условие задачи с LaTeX-формулами>",
  "latex_solution": "<решение задачи с LaTeX-формулами>"
}

Правила:
- Все формулы оборачивай в $...$, не используй \\[ \\] или \\( \\).
- Не используй _ и % вне математических блоков.
- topics должны быть из списка: ${tagList}.
- Возвращай ТОЛЬКО JSON, без лишнего текста.`;

  const ext     = path.extname(fileObj.name).toLowerCase();
  const isImage = ['.png', '.jpg', '.jpeg'].includes(ext);

  let parts;
  if (isImage) {
    const imageData = fs.readFileSync(fileObj.path);
    const base64    = imageData.toString('base64');
    const mimeMap  = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
    parts = [
      {
        inline_data: {
          mime_type: mimeMap[ext] || 'image/jpeg',
          data: base64,
        },
      },
      { text: 'Распознай задачу с изображения и верни JSON.' },
    ];
  } else {
    const textContent = fs.readFileSync(fileObj.path, 'utf8');
    parts = [{ text: `Вот текст задачи:\n\n${textContent}\n\nВерни JSON.` }];
  }

  const requestBody = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts }],
    generation_config: {
      response_mime_type: 'application/json',
      temperature: 0.2,
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`;

  console.log(`🤖 Отправляю запрос к Gemini API (gemini-3.8-flash)…`);

  const response = await fetch(url, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API вернул ошибку ${response.status}: ${errText}`);
  }

  const data   = await response.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error('Gemini вернул пустой ответ');

  // Снимаем markdown-обёртку на случай непослушной модели
  const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(cleaned);
}

async function runImport () {
  console.log('\n══════════════════════════════════════════');
  console.log('  ИИ-ИМПОРТ ЗАДАЧ (inbox → tasks/db.json)');
  console.log('══════════════════════════════════════════\n');

  const apiKey = getApiKey();
  if (!apiKey) {
    console.log('⚠️  Ключ GEMINI_API_KEY не найден.');
    console.log('\nКак задать ключ:');
    console.log('  1. Создайте файл .env в корне проекта:');
    console.log('       GEMINI_API_KEY=ваш_ключ_здесь');
    console.log('  2. Или добавьте в config.json:');
    console.log('       { "GEMINI_API_KEY": "ваш_ключ_здесь" }');
    console.log('  3. Или задайте переменную окружения перед запуском:');
    console.log('       set GEMINI_API_KEY=ваш_ключ_здесь && node import_task.js');
    return;
  }

  const files = findInboxFiles();
  if (files.length === 0) {
    console.log('📭 Папка inbox/ пуста. Поместите в неё файлы задач:');
    console.log('   • Изображения: .png, .jpg, .jpeg');
    console.log('   • Текстовые файлы: .txt, .md');
    console.log(`   Путь: ${INBOX_DIR}`);
    return;
  }

  console.log(`📂 Найдено файлов в inbox/: ${files.length}`);

  const db     = readJSON(DB_PATH);
  let imported = 0;

  for (const name of files) {
    const filePath = path.join(INBOX_DIR, name);
    console.log(`\n▶ Обрабатываю: ${name}`);

    try {
      const parsed  = await callGemini(apiKey, { name, path: filePath });
      const newId   = generateId(db, parsed.exam, parsed.topics);
      const newTask = { id: newId, ...parsed };

      db.push(newTask);
      fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');

      // Переносим в processed/
      const dest = path.join(PROCESSED, name);
      fs.renameSync(filePath, dest);

      console.log(`✅ Задача добавлена: ${newId}`);
      console.log(`   Экзамен: ${parsed.exam}, Часть: ${parsed.part}, Линия КИМ: ${parsed.kim_line}`);
      console.log(`   Темы: ${(parsed.topics || []).join(', ')}`);
      console.log(`   Файл перемещён → inbox/processed/${name}`);
      imported++;
    } catch (e) {
      console.error(`❌ Ошибка при обработке «${name}»: ${e.message}`);
    }
  }

  console.log(`\n══════════════════════════════════════════`);
  console.log(`✨ Импорт завершён. Добавлено задач: ${imported} из ${files.length}`);
  console.log('══════════════════════════════════════════\n');
}

// ─── ТОЧКА ВХОДА ──────────────────────────────────────────────────────────────

(async () => {
  ensureDirs();

  const args = process.argv.slice(2);
  if (args.includes('--validate')) {
    runValidate();
  } else {
    await runImport();
  }
})();
