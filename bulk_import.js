#!/usr/bin/env node
/**
 * bulk_import.js — автоматический парсер задач ЕГЭ/ОГЭ по физике
 *
 * Источники: phys-ege.sdamgia.ru / phys-oge.sdamgia.ru
 *
 * Режимы запуска:
 *   node bulk_import.js --preset=ege_full --per-topic=50
 *   node bulk_import.js --preset=oge_full --per-topic=50
 *   node bulk_import.js --exam=EGE --topic=kinematics --line=1 --limit=5
 *   node bulk_import.js --exam=OGE --category=54 --limit=10
 *   node bulk_import.js --exam=EGE --ids=106,107,108
 *   node bulk_import.js --exam=EGE --url=https://phys-ege.sdamgia.ru/test?theme=204&print=true
 *
 * Служебные режимы (эталонная матрица линий и покрытие базы):
 *   node bulk_import.js --build-matrix                 # tasks/kim_matrix.json
 *   node bulk_import.js --exam=EGE --index-catalog     # кэш каталога: source_id → подтема
 *   node bulk_import.js --backfill-subtopics           # заполнить subtopic_id/subtopic_title
 *   node bulk_import.js --exam=ALL --ensure-coverage --min-per-line=25
 *   node bulk_import.js --coverage-report              # сводная таблица по линиям
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
  NARROW_TOPIC_KEYS,
  buildTopicList,
} = require('./topic_classifier');

let cheerio, sharp;
try {
  cheerio = require('cheerio');
} catch (e) {
  console.error('❌ Пакет cheerio не установлен. Запустите: npm install cheerio sharp');
  process.exit(1);
}
try {
  sharp = require('sharp');
} catch (e) {
  console.error('❌ Пакет sharp не установлен. Запустите: npm install cheerio sharp');
  process.exit(1);
}

const ROOT = __dirname;
const DB_PATH = path.join(ROOT, 'tasks', 'db.json');
const IMAGES_DIR = path.join(ROOT, 'tasks', 'images');

const DELAY_MS = 400;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const DOMAINS = {
  EGE: 'https://phys-ege.sdamgia.ru',
  OGE: 'https://phys-oge.sdamgia.ru',
};

const CHECKPOINT_EVERY = 10;

// Полный обход тем для пакетных пресетов. Порядок совпадает с tasks/topics.json.
const PRESET_TOPICS = [
  'kinematics',
  'dynamics',
  'statics',
  'conservation_laws',
  'oscillations',
  'mkt',
  'thermodynamics',
  'vapors',
  'electrostatics',
  'direct_current',
  'magnetism',
  'em_oscillations',
  'optics',
  'quantum_physics',
  'nuclear',
  'measurements',
];

const PRESETS = {
  ege_full: 'EGE',
  oge_full: 'OGE',
};

const MAX_LINE = { EGE: 26, OGE: 22 };

// ───────────────────────────────────────────────────────────────────────────
// Эталонная матрица линий КИМ (tasks/kim_matrix.json).
// Номера линий, названия, формат ответа и баллы соответствуют спецификации
// ФИПИ для ЕГЭ (26 линий) и ОГЭ (22 линии) по физике.
// Подтемы каждой линии подтягиваются из каталога заданий (/prob_catalog,
// данные — /newapi/catalog/types) и сохраняются вместе с матрицей.
// ───────────────────────────────────────────────────────────────────────────
const MATRIX_PATH = path.join(ROOT, 'tasks', 'kim_matrix.json');
const CATALOG_CACHE_PATH = path.join(ROOT, 'tasks', 'catalog_cache.json');
const TOPICS_PATH = path.join(ROOT, 'tasks', 'topics.json');

const SECTION_TITLES = {
  mechanics: 'Механика',
  mkt_thermo: 'Молекулярная физика и термодинамика',
  electrodynamics: 'Электродинамика',
  quantum: 'Квантовая физика и элементы астрофизики',
  methods: 'Методы научного познания',
  mixed: 'Комплексное задание (несколько разделов)',
};

const EGE_LINE_SPECS = [
  { line: 1, title: 'Кинематика', grading_rule: 'numeric', max_points: 1, section: 'mechanics' },
  { line: 2, title: 'Динамика', grading_rule: 'numeric', max_points: 1, section: 'mechanics' },
  { line: 3, title: 'Законы сохранения в механике', grading_rule: 'numeric', max_points: 1, section: 'mechanics' },
  { line: 4, title: 'Статика. Механические колебания и волны', grading_rule: 'numeric', max_points: 1, section: 'mechanics' },
  { line: 5, title: 'Механика. Анализ физических процессов', grading_rule: 'unordered_set', max_points: 2, section: 'mechanics' },
  { line: 6, title: 'Механика. Изменение физических величин и соответствие', grading_rule: 'ordered_sequence', max_points: 2, section: 'mechanics' },
  { line: 7, title: 'Молекулярная физика', grading_rule: 'numeric', max_points: 1, section: 'mkt_thermo' },
  { line: 8, title: 'МКТ и термодинамика', grading_rule: 'numeric', max_points: 1, section: 'mkt_thermo' },
  { line: 9, title: 'Молекулярная физика и термодинамика. Анализ процессов', grading_rule: 'unordered_set', max_points: 2, section: 'mkt_thermo' },
  { line: 10, title: 'Молекулярная физика и термодинамика. Изменение величин', grading_rule: 'ordered_sequence', max_points: 2, section: 'mkt_thermo' },
  { line: 11, title: 'Электрическое поле. Законы постоянного тока', grading_rule: 'numeric', max_points: 1, section: 'electrodynamics' },
  { line: 12, title: 'Магнитное поле. Электромагнитная индукция', grading_rule: 'numeric', max_points: 1, section: 'electrodynamics' },
  { line: 13, title: 'Электромагнитные колебания и волны. Оптика', grading_rule: 'numeric', max_points: 1, section: 'electrodynamics' },
  { line: 14, title: 'Электродинамика. Анализ физических процессов', grading_rule: 'unordered_set', max_points: 2, section: 'electrodynamics' },
  { line: 15, title: 'Электродинамика. Изменение величин и соответствие', grading_rule: 'ordered_sequence', max_points: 2, section: 'electrodynamics' },
  { line: 16, title: 'Ядерная физика', grading_rule: 'numeric', max_points: 1, section: 'quantum' },
  { line: 17, title: 'Квантовая физика. Изменение величин и соответствие', grading_rule: 'ordered_sequence', max_points: 2, section: 'quantum' },
  { line: 18, title: 'Физический смысл величин, законов и закономерностей', grading_rule: 'unordered_set', max_points: 2, section: 'methods' },
  { line: 19, title: 'Показания измерительных приборов с погрешностью', grading_rule: 'measurement', max_points: 1, section: 'methods' },
  { line: 20, title: 'Планирование эксперимента', grading_rule: 'unordered_set', max_points: 1, section: 'methods' },
  { line: 21, title: 'Качественная задача (МКТ, термодинамика, электродинамика)', grading_rule: 'manual', max_points: 3, section: 'mixed' },
  { line: 22, title: 'Расчетная задача. Механика', grading_rule: 'manual', max_points: 2, section: 'mechanics' },
  { line: 23, title: 'Расчетная задача. МКТ и электродинамика', grading_rule: 'manual', max_points: 2, section: 'mixed' },
  { line: 24, title: 'Расчетная задача высокого уровня. МКТ и термодинамика', grading_rule: 'manual', max_points: 3, section: 'mkt_thermo' },
  { line: 25, title: 'Расчетная задача высокого уровня. Электродинамика', grading_rule: 'manual', max_points: 3, section: 'electrodynamics' },
  { line: 26, title: 'Расчетная задача высокого уровня с обоснованием. Механика', grading_rule: 'manual', max_points: 4, section: 'mechanics' },
];

const OGE_LINE_SPECS = [
  { line: 1, title: 'Физические понятия, величины и приборы', grading_rule: 'ordered_sequence', max_points: 2 },
  { line: 2, title: 'Принцип действия приборов и формулы', grading_rule: 'ordered_sequence', max_points: 2 },
  { line: 3, title: 'Распознавание физических явлений', grading_rule: 'numeric', max_points: 1 },
  { line: 4, title: 'Описание свойств физических явлений (текст с пропусками)', grading_rule: 'ordered_sequence', max_points: 2 },
  { line: 5, title: 'Вычислительные задачи. Механические явления', grading_rule: 'numeric', max_points: 1, section: 'mechanics' },
  { line: 6, title: 'Вычислительные задачи. Механические явления', grading_rule: 'numeric', max_points: 1, section: 'mechanics' },
  { line: 7, title: 'Вычислительные задачи. Тепловые явления', grading_rule: 'numeric', max_points: 1, section: 'mkt_thermo' },
  { line: 8, title: 'Вычислительные задачи. Электромагнитные явления', grading_rule: 'numeric', max_points: 1, section: 'electrodynamics' },
  { line: 9, title: 'Вычислительные задачи. Оптика и электромагнитные явления', grading_rule: 'numeric', max_points: 1, section: 'electrodynamics' },
  { line: 10, title: 'Вычислительные задачи. Квантовая и ядерная физика', grading_rule: 'numeric', max_points: 1, section: 'quantum' },
  { line: 11, title: 'Описание изменения физических величин (Механика / Тепловые явления)', grading_rule: 'ordered_sequence', max_points: 2 },
  { line: 12, title: 'Описание изменения физических величин (Электродинамика / Кванты)', grading_rule: 'ordered_sequence', max_points: 2 },
  { line: 13, title: 'Анализ графиков, таблиц и схем', grading_rule: 'unordered_set', max_points: 2 },
  { line: 14, title: 'Верные утверждения на основе текста/схем', grading_rule: 'unordered_set', max_points: 2 },
  { line: 15, title: 'Прямые измерения физических величин', grading_rule: 'numeric', max_points: 1, section: 'methods' },
  { line: 16, title: 'Интерпретация результатов опытов', grading_rule: 'unordered_set', max_points: 2, section: 'methods' },
  { line: 17, title: 'Экспериментальные задания', grading_rule: 'manual', max_points: 3 },
  { line: 18, title: 'Установление соответствия / текст физического содержания', grading_rule: 'manual', max_points: 2 },
  { line: 19, title: 'Качественная задача (по тексту и явлениям)', grading_rule: 'manual', max_points: 2 },
  { line: 20, title: 'Качественная задача', grading_rule: 'manual', max_points: 2 },
  { line: 21, title: 'Расчетная задача высокого уровня', grading_rule: 'manual', max_points: 3 },
  { line: 22, title: 'Комбинированная расчетная задача', grading_rule: 'manual', max_points: 3 },
];

const LINE_SPECS = { EGE: EGE_LINE_SPECS, OGE: OGE_LINE_SPECS };

function defaultPart(exam, line) {
  return exam === 'EGE' ? (Number(line) <= 20 ? 1 : 2) : (Number(line) <= 16 ? 1 : 2);
}

function lineSpec(exam, line) {
  const specs = LINE_SPECS[exam] || [];
  return specs.find(s => Number(s.line) === Number(line)) || null;
}

// Соответствие «линия КИМ ОГЭ → группы каталога».
// В каталоге ОГЭ осталась устаревшая линия 5 «Объяснение физических явлений»,
// которой нет в актуальной матрице, поэтому нумерация начиная с 5-й линии
// сдвинута. Категории линии 14 (анализ) разделены между линиями 13 и 14,
// а категории линии 19 (качественные задачи) — между линиями 19 и 20,
// чтобы у каждой линии была своя подтема и не было дублей задач.
const OGE_CATALOG_LINES = {
  1: { groups: [1] },
  2: { groups: [2] },
  3: { groups: [3] },
  4: { groups: [4] },
  5: { groups: [6] },
  6: { groups: [7] },
  7: { groups: [8] },
  8: { groups: [9] },
  9: { groups: [10] },
  10: { groups: [11] },
  11: { groups: [12] },
  12: { groups: [13] },
  13: { groups: [14], subtopics: [65, 66, 64] },
  14: { groups: [14], subtopics: [63, 42] },
  15: { groups: [15] },
  16: { groups: [16] },
  17: { groups: [17] },
  18: { groups: [18] },
  19: { groups: [19], subtopics: [47, 83] },
  20: { groups: [19], subtopics: [82] },
  21: { groups: [21] },
  22: { groups: [22] },
};


// Встроенная карта: тема -> основные линии КИМ (Часть 1 и Часть 2).
// Для каждой пары «тема + линия» импортируется не больше --per-topic задач.
const TOPIC_LINES = {
  kinematics: [1, 5, 6, 22, 26],
  dynamics: [2, 5, 6, 22, 26],
  statics: [4, 5, 6, 22, 26],
  conservation_laws: [3, 5, 6, 22, 26],
  oscillations: [4, 5, 6, 22, 26],
  mkt: [7, 8, 9, 10, 21, 22, 23, 24],
  thermodynamics: [8, 9, 10, 21, 22, 23, 24],
  vapors: [8, 9, 10, 21, 24],
  electrostatics: [11, 14, 15, 21, 23, 25],
  direct_current: [11, 14, 15, 21, 23, 25],
  magnetism: [12, 14, 15, 21, 25],
  em_oscillations: [13, 14, 15, 21, 23, 25],
  optics: [13, 14, 15, 21, 23, 25],
  quantum_physics: [17, 19, 20, 21, 23, 25],
  nuclear: [16, 17, 21, 23, 25],
  measurements: [18, 19, 20, 21, 22, 23],
};

// У ОГЭ другая структура линий: категории часто называются «Механические явления»,
// «Тепловые явления» и т.п. Поэтому для ОГЭ используем отдельную карту и
// предметный fallback (см. resolveCategoriesForPresetLine).
const OGE_TOPIC_LINES = {
  kinematics: [6, 7, 20, 21, 22],
  dynamics: [6, 7, 20, 21, 22],
  statics: [6, 7, 20, 21, 22],
  conservation_laws: [6, 7, 20, 21, 22],
  oscillations: [6, 7, 20, 21, 22],
  mkt: [8, 19, 20, 21, 22],
  thermodynamics: [8, 19, 20, 21, 22],
  vapors: [8, 19, 20, 21, 22],
  electrostatics: [9, 10, 15, 20, 21, 22],
  direct_current: [9, 10, 15, 20, 21, 22],
  magnetism: [9, 10, 13, 14, 19, 20, 21, 22],
  em_oscillations: [9, 10, 13, 14, 19, 20, 21, 22],
  optics: [9, 10, 13, 14, 15, 19, 20, 21, 22],
  quantum_physics: [5, 11, 13, 14, 18, 19],
  nuclear: [5, 11, 13, 14, 18, 19],
  measurements: [1, 2, 15, 17],
};

const PARENT_TOPICS = new Set(['mechanics', 'mkt_thermo', 'electrodynamics', 'quantum', 'methods']);
const PARENT_OF = {
  kinematics: 'mechanics',
  dynamics: 'mechanics',
  statics: 'mechanics',
  conservation_laws: 'mechanics',
  oscillations: 'mechanics',
  mkt: 'mkt_thermo',
  thermodynamics: 'mkt_thermo',
  vapors: 'mkt_thermo',
  electrostatics: 'electrodynamics',
  direct_current: 'electrodynamics',
  magnetism: 'electrodynamics',
  em_oscillations: 'electrodynamics',
  optics: 'electrodynamics',
  quantum_physics: 'quantum',
  nuclear: 'quantum',
  measurements: 'methods',
};

const SHORT_TOPICS = {
  kinematics: 'KIN',
  dynamics: 'DYN',
  statics: 'STA',
  conservation_laws: 'CON',
  oscillations: 'OSC',
  mkt: 'MKT',
  thermodynamics: 'THR',
  vapors: 'VAP',
  electrostatics: 'ELC',
  direct_current: 'CUR',
  magnetism: 'MAG',
  em_oscillations: 'EMO',
  optics: 'OPT',
  quantum_physics: 'QUA',
  nuclear: 'NUC',
  measurements: 'MSR',
  mechanics: 'MCH',
  mkt_thermo: 'MKT',
  electrodynamics: 'ELD',
  quantum: 'QNT',
  methods: 'MTH',
};

const TOPIC_PATTERNS = {
  kinematics: /кинематик|равномерн|равноускор|ускорени|координат|движени/i,
  dynamics: /(?<!термо)(?<!электро)динамик|ньютон|равнодейств|сила|сил[ыа]|трени|упругост|тяготен|невесомост/i,
  statics: /(?<!электро)статик|гидростатик|архимед|паскал|равновеси|момент[а-я]* сил|давлени/i,
  conservation_laws: /сохранени|энерги|импульс|работ|мощност/i,
  oscillations: /колебан|волн|маятник|резонанс/i,
  mkt: /мкт|молекулярн|идеальн[а-я]* газ|уравнени[ея] клапейрон|изопроцесс|основное уравнение/i,
  thermodynamics: /термодинамик|теплот|теплов|внутренн[а-я]* энерг|кпд|цикл|фазов|плавлен|парообраз|влажност/i,
  vapors: /влажност|фазов|парообраз|плавлен|тепло[её]мк|насыщенн/i,
  electrostatics: /электростатик|закон кулона|заряд|конденсатор|электрическ[а-я]* поле|напряж[её]нност/i,
  direct_current: /постоянн[а-я]* ток|сила тока|закон ома|сопротивлен|электрическ[а-я]* схем|работ[а-я]* электрическ|джоул|мощност[а-я]* ток/i,
  magnetism: /магнитн[а-я]* поле|магнетизм|индукц|ампера|лоренца|самоиндукц/i,
  em_oscillations: /электромагнитн[а-я]* колебан|колебательн[а-я]* контур|электромагнитн[а-я]* волн|волнов[а-я]* оптика/i,
  optics: /оптик|свет|зеркал|линз|преломлен|тень|дифракц|интерференц|поляризац/i,
  quantum_physics: /квантов|фотон|фотоэффект|энерги[яи] фотон|атомн[а-я]* уровн/i,
  nuclear: /ядерн|радиоактив|менделеев|атомн[а-я]* ядр|изотоп|распад/i,
  measurements: /измерительн|прибор|погрешност|эксперимент|измерени|планирование/i,
  mechanics: /механик|кинематик|(?<!термо)(?<!электро)динамик|(?<!электро)статик|сохранени|колебан|волн|движени|сил[а-я]*|энерги|импульс|равновеси|архимед|давлени|график/i,
  mkt_thermo: /мкт|молекулярн|термодинамик|теплот|теплов|влажност|фазов|плавлен|парообраз|кпд|цикл|изопроцесс|клапейрон/i,
  electrodynamics: /электродинамик|электрическ|магнитн|электростатик|ток|заряд|конденсатор|оптик|свет|линз|зеркал|колебательн[а-я]* контур|электромагнитн|индукц|ампера|лоренца/i,
  quantum: /квантов|ядерн|радиоактив|фотон|фотоэффект|атомн|менделеев|изотоп|распад/i,
  methods: /метод|погрешност|измерени|эксперимент|прибор|планирование/i,
};

// Предметный fallback для ОГЭ: категории там часто называются по разделу,
// а не по узкой теме. Для electric/magnetism/optics используем более узкие
// шаблоны, чтобы не подмешивать, например, оптику в электродинамику.
const OGE_FALLBACK_PATTERNS = {
  kinematics: TOPIC_PATTERNS.mechanics,
  dynamics: TOPIC_PATTERNS.mechanics,
  statics: TOPIC_PATTERNS.mechanics,
  conservation_laws: TOPIC_PATTERNS.mechanics,
  oscillations: TOPIC_PATTERNS.mechanics,
  mkt: TOPIC_PATTERNS.mkt_thermo,
  thermodynamics: TOPIC_PATTERNS.mkt_thermo,
  vapors: TOPIC_PATTERNS.mkt_thermo,
  electrostatics: /электрическ|электромагнитн|заряд|конденсатор|ток|сопротивлен|напряж|мощност|джоул/i,
  direct_current: /электрическ|электромагнитн|заряд|конденсатор|ток|сопротивлен|напряж|мощност|джоул/i,
  magnetism: /магнитн|магнетизм|индукц|ампера|лоренца|самоиндукц|электромагнитн/i,
  em_oscillations: /электромагнитн|колебательн|контур|волн/i,
  optics: /оптик|свет|зеркал|линз|преломлен|тень|дифракц|интерференц|поляризац/i,
  quantum_physics: TOPIC_PATTERNS.quantum,
  nuclear: TOPIC_PATTERNS.quantum,
  measurements: TOPIC_PATTERNS.methods,
};

function lineToMeta(exam, line) {
  const spec = lineSpec(exam, line);
  if (spec) {
    return {
      part: defaultPart(exam, spec.line),
      grading_rule: spec.grading_rule,
      max_points: spec.max_points,
    };
  }
  return { part: 1, grading_rule: 'numeric', max_points: 1 };
}

function egeLineToMeta(line) {
  return lineToMeta('EGE', line);
}

function ogeLineToMeta(line) {
  return lineToMeta('OGE', line);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let lastRequestAt = 0;

async function request(url, opts = {}) {
  const { binary = false, method = 'GET', body, headers = {}, timeout = 20000, retries = 1 } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const wait = Math.max(0, DELAY_MS - (Date.now() - lastRequestAt));
    if (wait) await sleep(wait);
    lastRequestAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        method,
        body,
        headers: {
          'User-Agent': USER_AGENT,
          'Accept-Language': 'ru-RU,ru;q=0.9',
          ...headers,
        },
        signal: controller.signal,
        redirect: 'follow',
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} для ${url}`);
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          lastErr = err;
          await sleep(1000);
          continue;
        }
        throw err;
      }
      if (binary) return Buffer.from(await res.arrayBuffer());
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        await sleep(1000);
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
      lastRequestAt = Date.now();
    }
  }
  throw lastErr;
}

function fetchHtml(url) {
  return request(url, { timeout: 60000, retries: 2 });
}

function fetchBuffer(url) {
  let referer = '';
  try {
    referer = new URL(url).origin + '/';
  } catch { /* ignore */ }
  return request(url, {
    binary: true,
    timeout: 90000,
    retries: 2,
    headers: {
      Accept: 'image/avif,image/webp,image/svg+xml,image/*,*/*;q=0.8',
      ...(referer ? { Referer: referer } : {}),
    },
  });
}

function fetchJson(url, body) {
  return request(url, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    timeout: 60000,
    retries: 2,
  });
}

function readDB() {
  if (!fs.existsSync(DB_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) {
    console.error(`❌ Не удалось прочитать db.json: ${e.message}`);
    process.exit(1);
  }
}

function writeDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

// Сохраняем базу не после каждой задачи, а пачками по CHECKPOINT_EVERY.
// force=true используется в конце работы и при SIGINT, чтобы не потерять хвост.
function checkpoint(state, force = false) {
  if (!state || state.dryRun || !state.dirty) return;
  const every = Number(state.checkpointEvery) > 0 ? Number(state.checkpointEvery) : CHECKPOINT_EVERY;
  if (!force && (state.pending || 0) < every) return;
  writeDB(state.db);
  console.log(`  💾 Чекпоинт: ${state.db.length} задач сохранено в tasks/db.json`);
  state.pending = 0;
  state.dirty = false;
}

function ensureImagesDir() {
  if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
}

function normalizeText(value) {
  return String(value == null ? '' : value)
    .replace(/\u00ad/g, '')
    .replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

function escapeLatexText(text) {
  const map = {
    '\\': '\\textbackslash{}', '&': '\\&', '%': '\\%', '$': '\\$',
    '#': '\\#', '_': '\\_', '{': '\\{', '}': '\\}', '~': '\\textasciitilde{}',
    '^': '\\textasciicircum{}',
  };
  let s = normalizeText(text).replace(/([\\&%$#_{}~^])/g, ch => map[ch]);
  return s
    .replace(/\u2212/g, '-')
    .replace(/\u00d7/g, '$\\times$')
    .replace(/\u00b7/g, '$\\cdot$')
    .replace(/\u00b0/g, '$^\\circ$')
    .replace(/\u2026/g, '\\ldots{}')
    .replace(/\u00b1/g, '$\\pm$')
    .replace(/\u2014/g, '---')
    .replace(/\u2013/g, '--')
    .replace(/\u2012/g, '--');
}

function mapOutsideText(s, fn) {
  let out = '';
  let pos = 0;
  const re = /\\text\{[^{}]*\}/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    out += fn(s.slice(pos, m.index));
    out += m[0];
    pos = m.index + m[0].length;
  }
  out += fn(s.slice(pos));
  return out;
}

function stripTextBlocks(s) {
  let out = '';
  let pos = 0;
  const re = /\\text\{[^{}]*\}/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    out += s.slice(pos, m.index);
    pos = m.index + m[0].length;
  }
  out += s.slice(pos);
  return out;
}

function hasUnsupportedCyrillic(latex) {
  const outside = stripTextBlocks(latex).replace(/\\[A-Za-z]+/g, '');
  return /[А-Яа-яЁё]/.test(outside);
}

function balancedBraces(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

function fixLatexCommands(s) {
  return s
    .replace(/\\(bar|vec|hat|tilde|dot|ddot|overline|underline)([A-Za-z])/g, '\\$1{$2}')
    .replace(/\\(alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|iota|kappa|lambda|mu|nu|xi|pi|rho|sigma|tau|upsilon|phi|varphi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega)([A-Za-z])/g, '\\$1 $2')
    .replace(/\\(sin|cos|tan|cot|log|ln|exp|arcsin|arccos|arctan)([A-Za-z])/g, '\\$1 $2');
}

function cleanLatex(raw) {
  if (!raw) return '';
  let s = normalizeText(raw).replace(/\s+/g, ' ').trim();
  s = s.replace(/^\$+|\$+$/g, '');
  s = s
    .replace(/\\leqslant/g, '\\le')
    .replace(/\\geqslant/g, '\\ge')
    .replace(/\\noindent\s*/g, '')
    .replace(/\\medspace/g, '\\,')
    .replace(/\\thinspace/g, '\\,')
    .replace(/\\!/g, '')
    .replace(/°/g, '^\\circ')
    .replace(/\\lt\b/g, '<')
    .replace(/\\gt\b/g, '>')
    .replace(/\\cdot\s*\\cdot/g, '\\cdot');
  s = fixLatexCommands(s);
  return s.replace(/[.\s]+$/g, '').trim();
}

const PHRASES = [
  ['левая круглая скобка', '('],
  ['правая круглая скобка', ')'],
  ['левая квадратная скобка', '['],
  ['правая квадратная скобка', ']'],
  ['левая фигурная скобка', '\\{'],
  ['правая фигурная скобка', '\\}'],
  ['умножить на', '\\cdot '],
  ['разделить на', ' / '],
  ['делить на', ' / '],
  ['больше или равно', '\\ge '],
  ['меньше или равно', '\\le '],
  ['не равно', '\\ne '],
  ['приблизительно равно', '\\approx '],
  ['приблизительно', '\\approx '],
  ['в квадрате', '^{2}'],
  ['в кубе', '^{3}'],
  ['в четвертой степени', '^{4}'],
  ['в пятой степени', '^{5}'],
  ['градусов цельсия', '^\\circ\\text{C}'],
  ['градусов с', '^\\circ\\text{C}'],
  ['градусовс', '^\\circ\\text{C}'],
  ['градусов', '^\\circ'],
  ['градуса', '^\\circ'],
  ['градус', '^\\circ'],
  ['процентов', '\\%'],
  ['процент', '\\%'],
  ['плюс', '+'],
  ['минус', '-'],
  ['равно', '='],
  ['больше', '>'],
  ['меньше', '<'],
  ['арктангенс', '\\arctan '],
  ['тангенс', '\\tan '],
  ['арксинус', '\\arcsin '],
  ['синус', '\\sin '],
  ['косинус', '\\cos '],
  ['котангенс', '\\cot '],
  ['натуральный логарифм', '\\ln '],
  ['логарифм', '\\log '],
];

const GREEK = {
  'альфа': '\\alpha ', 'бета': '\\beta ', 'гамма': '\\gamma ', 'дельта': '\\delta ',
  'эпсилон': '\\varepsilon ', 'лямбда': '\\lambda ', 'мю': '\\mu ', 'ню': '\\nu ',
  'пи': '\\pi ', 'ро': '\\rho ', 'сигма': '\\sigma ', 'тау': '\\tau ',
  'фи': '\\varphi ', 'омега': '\\omega ', 'эта': '\\eta ', 'кси': '\\xi ',
  'пси': '\\psi ', 'тета': '\\theta ', 'каппа': '\\kappa ',
};

function replacePhrases(s) {
  for (const [from, to] of PHRASES) {
    const re = new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    s = s.replace(re, to);
  }
  for (const [from, to] of Object.entries(GREEK)) {
    const re = new RegExp('(^|[^А-Яа-яЁё])' + from + '(?![А-Яа-яЁё])', 'gi');
    s = s.replace(re, (m, p) => p + to);
  }
  s = s.replace(/вектор\s*([A-Za-zА-Яа-я])/gi, (m, p) => `\\vec{${p}}`);
  s = s.replace(/в\s+степени\s*(?:левая\s+круглая\s+скобка\s*)?(минус\s*)?([A-Za-zА-Яа-я0-9.,]+)\s*(?:правая\s+круглая\s+скобка)?/gi,
    (m, sign, exp) => `^{${sign ? '-' : ''}${exp}}`);
  s = s.replace(/в\s+минус\s+первой\s+степени/gi, '^{-1}');
  s = s.replace(/в\s+первой\s+степени/gi, '^{1}');
  s = s.replace(/в\s+нулевой\s+степени/gi, '^{0}');
  return s;
}

function parseFraction(s, start) {
  const re = /(дробь\s*:|конец\s+дроби|,\s*знаменатель\s*:)/gi;
  re.lastIndex = start;
  let depth = 0;
  let split = -1;
  let m;
  while ((m = re.exec(s)) !== null) {
    const tok = m[0].toLowerCase().replace(/\s+/g, ' ');
    if (tok.startsWith('дробь')) depth++;
    else if (tok.startsWith('конец')) {
      if (depth === 0) {
        if (split < 0) return null;
        const splitText = s.slice(split).match(/^,\s*знаменатель\s*:/i);
        if (!splitText) return null;
        return {
          numerator: s.slice(start, split),
          denominator: s.slice(split + splitText[0].length, m.index),
          end: m.index + m[0].length,
        };
      }
      depth--;
    } else if (tok.startsWith(',') && depth === 0 && split < 0) {
      split = m.index;
    }
  }
  return null;
}

function parseRoot(s, start) {
  const re = /(начало\s+аргумента\s*:|конец\s+аргумента\s*:)/gi;
  re.lastIndex = start;
  let depth = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const tok = m[0].toLowerCase().replace(/\s+/g, ' ');
    if (tok.startsWith('начало')) depth++;
    else {
      if (depth === 0) {
        return { arg: s.slice(start, m.index).replace(/^\s*:\s*/, ''), end: m.index + m[0].length };
      }
      depth--;
    }
  }
  return null;
}

function convertSpoken(input) {
  let s = normalizeText(input).replace(/\s+/g, ' ').trim();
  s = replacePhrases(s);
  s = s.replace(/[.\s]+$/g, '');
  let out = '';
  let pos = 0;
  while (pos < s.length) {
    const rest = s.slice(pos);
    const fracM = /дробь\s*:\s*числитель\s*:\s*/i.exec(rest);
    const rootM = /(?:квадратный\s+)?корень\s+из\s*:?\s*/i.exec(rest);
    const startFrac = fracM ? pos + fracM.index : -1;
    const startRoot = rootM ? pos + rootM.index : -1;
    let start = -1;
    let kind = null;
    let match = null;
    if (startFrac >= 0 && (startRoot < 0 || startFrac <= startRoot)) {
      start = startFrac; kind = 'frac'; match = fracM;
    } else if (startRoot >= 0) {
      start = startRoot; kind = 'root'; match = rootM;
    }
    if (start < 0) { out += s.slice(pos); break; }
    out += s.slice(pos, start);
    if (kind === 'frac') {
      const afterNum = start + match[0].length;
      const f = parseFraction(s, afterNum);
      if (!f) { out += s.slice(start); break; }
      out += `\\frac{${convertSpoken(f.numerator)}}{${convertSpoken(f.denominator)}}`;
      pos = f.end;
    } else {
      const after = start + match[0].length;
      const r = parseRoot(s, after);
      if (!r) {
        const m2 = /^\s*(левая\s+круглая\s+скобка\s*)?([A-Za-zА-Яа-я0-9.,]+)\s*(правая\s+круглая\s+скобка)?/i.exec(s.slice(after));
        if (!m2) { out += s.slice(start); break; }
        out += `\\sqrt{${convertSpoken(m2[2])}}`;
        pos = after + m2[0].length;
      } else {
        out += `\\sqrt{${convertSpoken(r.arg)}}`;
        pos = r.end;
      }
    }
  }
  return out;
}

function wrapUnits(s) {
  return mapOutsideText(s, seg => {
    seg = seg.replace(/((?:к|м|мк|н|М|Г|Т)?(?:м\/с|м|см|мм|км|кг|г|мг|с|Н|Дж|Вт|Па|В|А|Ом|Кл|Тл|Вб|Гц|К|моль|л|мл|гПа|кПа|МПа|кОм|мН|мА|мВ|кВ|кВт|кДж))(?:2|²)/g,
      (m, u) => `\\text{ ${u}}^{2}`);
    seg = seg.replace(/((?:к|м|мк|н|М|Г|Т)?(?:м|см|мм|км|кг|г|мг|Н|Дж|Вт|Па|В|А|Ом|Кл|Тл|Вб|Гц|К|моль|л|мл))(?:\^?3|³)/g,
      (m, u) => `\\text{ ${u}}^{3}`);
    const unit = '(?:к|м|мк|н|М|Г|Т)?(?:м\\/с|м|см|мм|км|кг|г|мг|с|Н|Дж|Вт|Па|В|А|Ом|Кл|Тл|Вб|Гц|К|моль|рад\\/с|рад|л|мл|гПа|кПа|МПа|кОм|мН|мА|мВ|кВ|кВт|кДж)';
    seg = seg.replace(new RegExp('(?<![А-Яа-яЁё\\\\])(' + unit + ')(?![А-Яа-яЁё])', 'g'), m => `\\text{ ${m}}`);
    return seg;
  });
}

function cleanSpoken(s) {
  return s
    .replace(/\s+/g, ' ')
    .replace(/\s*\\cdot\s*/g, '\\cdot ')
    .replace(/\s*([=+\-<>])\s*/g, '$1')
    .replace(/\s*\\approx\s*/g, '\\approx ')
    .replace(/\s*\\ge\s*/g, '\\ge ')
    .replace(/\s*\\le\s*/g, '\\le ')
    .replace(/\s*\\ne\s*/g, '\\ne ')
    .replace(/\s*\\%/g, '\\%')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s+([_^])/g, '$1')
    .replace(/\{\s+/g, '{')
    .replace(/\s+\}/g, '}')
    .replace(/\s+/g, ' ')
    .trim();
}

function spokenToLatex(alt) {
  let s = cleanSpoken(wrapUnits(convertSpoken(alt)));
  s = fixLatexCommands(s);
  return s.trim();
}

function replaceCyrillicHomoglyphs(s) {
  return mapOutsideText(s, seg => seg.replace(/[хХ]/g, m => (m === 'х' ? 'x' : 'X')));
}

function altToLatex(rawAlt) {
  const alt = normalizeText(rawAlt).trim();
  if (!alt) return { latex: '', fallback: true, alt: '' };
  const hasCyr = /[А-Яа-яЁё]/.test(alt);
  const spoken = /(дробь|числитель|знаменатель|умножить|плюс|минус|скобка|степени|корень|градус|синус|косинус|тангенс|арктангенс|конец\s+дроби|начало\s+аргумента|равно|процент|вектор)/i.test(alt);
  let latex = (hasCyr && spoken) ? spokenToLatex(alt) : cleanLatex(alt);
  latex = wrapUnits(latex);
  latex = replaceCyrillicHomoglyphs(latex);
  latex = latex.replace(/[.\s]+$/g, '').trim();
  const bad = !latex || hasUnsupportedCyrillic(latex) || !balancedBraces(latex) || latex.includes('$') ||
    /^\s*(\\cdot|\\times)/.test(latex) || latex.length > 1500;
  return bad ? { latex: '', fallback: true, alt } : { latex, fallback: false, alt };
}

function tableToLatex($, tableEl, placeholders) {
  const rows = [];
  $(tableEl).find('tr').each((_, tr) => {
    const cells = [];
    $(tr).children('th, td').each((_, td) => {
      let cell = convertHtmlToLatex($, td, placeholders, { inTable: true });
      cell = cell.replace(/\s+/g, ' ').replace(/\\\\/g, ' ').trim();
      cells.push(cell);
    });
    if (cells.length) rows.push(cells);
  });
  if (!rows.length) return '';
  const colCount = Math.max(...rows.map(r => r.length));
  const colSpec = Array(colCount).fill('c').join('|');
  const lines = rows.map(cells => {
    while (cells.length < colCount) cells.push('');
    return cells.join(' & ') + ' \\\\';
  });
  return `\\begin{tabular}{|${colSpec}|}\\hline\n${lines.join('\n\\hline\n')}\n\\hline\\end{tabular}`;
}

function convertHtmlToLatex($, el, placeholders = [], options = {}) {
  let result = '';
  $(el).contents().each((_, node) => {
    if (node.type === 'text') {
      result += escapeLatexText(node.data || '');
      return;
    }
    if (node.type !== 'tag') return;
    const tag = (node.name || '').toLowerCase();
    if (['style', 'script', 'noscript', 'svg', 'input', 'wbr'].includes(tag)) return;

    if (tag === 'img') {
      const cls = $(node).attr('class') || '';
      const alt = $(node).attr('alt') || '';
      const src = $(node).attr('src') || '';
      if (cls.split(/\s+/).includes('tex')) {
        const conv = altToLatex(alt);
        if (!conv.fallback && conv.latex) {
          result += `$${conv.latex}$`;
        } else if (src) {
          const ph = `@@IMG${placeholders.length}@@`;
          placeholders.push({ url: src, placeholder: ph, kind: 'formula', alt, inTable: !!options.inTable });
          result += ph;
        }
      } else if (src && isContentImage(src)) {
        const ph = `@@IMG${placeholders.length}@@`;
        placeholders.push({ url: src, placeholder: ph, kind: 'figure', alt, inTable: !!options.inTable });
        result += ph;
      }
      return;
    }
    if (tag === 'table') {
      result += '\n\\par\\noindent\n' + tableToLatex($, node, placeholders) + '\n\\par\n';
      return;
    }
    if (tag === 'br') {
      result += options.inTable ? ' ' : '\\newline{}';
      return;
    }
    if (tag === 'p' || tag === 'div') {
      const inner = convertHtmlToLatex($, node, placeholders, options);
      result += options.inTable ? inner + ' ' : inner + '\n\n';
      return;
    }
    if (tag === 'b' || tag === 'strong') {
      result += `\\textbf{${convertHtmlToLatex($, node, placeholders, options)}}`;
      return;
    }
    if (tag === 'i' || tag === 'em') {
      result += `\\textit{${convertHtmlToLatex($, node, placeholders, options)}}`;
      return;
    }
    if (tag === 'u') {
      result += `\\underline{${convertHtmlToLatex($, node, placeholders, options)}}`;
      return;
    }
    if (tag === 'sup' || tag === 'sub') {
      let inner = convertHtmlToLatex($, node, placeholders, { ...options, inTable: true });
      inner = inner.replace(/\$/g, '').replace(/\s+/g, ' ').trim();
      result += tag === 'sup' ? `$^{${inner}}$` : `$_{${inner}}$`;
      return;
    }
    if (tag === 'ul' || tag === 'ol') {
      const env = tag === 'ul' ? 'itemize' : 'enumerate';
      result += `\n\\begin{${env}}\n`;
      $(node).children('li').each((_, li) => {
        let item = convertHtmlToLatex($, li, placeholders, { ...options, inTable: true });
        result += `  \\item ${item.replace(/\s+/g, ' ').trim()}\n`;
      });
      result += `\\end{${env}}\n`;
      return;
    }
    if (tag === 'center') {
      result += '\n\\begin{center}\n' + convertHtmlToLatex($, node, placeholders, { ...options, inTable: false }) + '\n\\end{center}\n';
      return;
    }
    if (tag === 'blockquote') {
      result += '\n\\begin{quote}\n' + convertHtmlToLatex($, node, placeholders, options) + '\n\\end{quote}\n';
      return;
    }
    if (tag === 'hr') {
      result += '\n\\par\\noindent\\rule{\\linewidth}{0.4pt}\\par\n';
      return;
    }
    if (tag === 'code' || tag === 'tt') {
      result += `\\texttt{${convertHtmlToLatex($, node, placeholders, options)}}`;
      return;
    }
    result += convertHtmlToLatex($, node, placeholders, options);
  });
  return result;
}

function normalizeLatex(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/@@IMG\d+@@/g, '')
    .trim();
}

// В исходном решении на сайте часто уже есть строка "Ответ: ...".
// Генератор вариантов добавляет ответ отдельно, поэтому убираем дубль в конце.
function stripSolutionAnswer(latex) {
  let s = String(latex || '').replace(/\s+$/g, '');
  s = s.replace(/(?:\s|\n)*Ответ\s*:\s*[^\n]{0,200}$/i, '').replace(/\s+$/g, '');
  return s;
}

// Генератор вариантов добавляет "\\ \textbf{Ответ:}" сразу после решения.
// Если решение заканчивается средой (center/quote/...), "\\" попадает в
// вертикальный режим и pdflatex выдаёт "There's no line here to end".
function ensureSolutionEnd(latex) {
  const s = String(latex || '').replace(/\s+$/g, '');
  if (/\\end\{(?:center|quote|itemize|enumerate|tabular)\}$/.test(s)) {
    return s + '\n\\leavevmode';
  }
  return s;
}

const imageUrlCache = new Map();

function resolveUrl(src, baseUrl) {
  if (!src) return null;
  const s = String(src).trim();
  if (!s || /^(data:|blob:|javascript:|#)/i.test(s)) return null;
  try {
    return new URL(s, baseUrl).href;
  } catch {
    return null;
  }
}

function isContentImage(src) {
  const s = String(src || '');
  if (/^(data:|blob:|javascript:|#)/i.test(s)) return false;
  return !/(logo|banner|icon|sprite|avatar|metrika|counter|pixel|briefcase|ads?\/)/i.test(s);
}

async function downloadImage(url, taskId, idx, baseUrl, opts = {}) {
  const fullUrl = resolveUrl(url, baseUrl);
  if (!fullUrl) return null;
  const kind = opts.kind || 'figure';
  const filename = `${taskId}_${idx}.png`;
  const outPath = path.join(IMAGES_DIR, filename);
  if (fs.existsSync(outPath)) return filename;

  const cacheKey = `${kind}:${fullUrl}`;
  const cached = imageUrlCache.get(cacheKey);
  if (cached && fs.existsSync(cached) && path.resolve(cached) !== path.resolve(outPath)) {
    try {
      fs.copyFileSync(cached, outPath);
      return filename;
    } catch { /* ignore */ }
  }

  let buf;
  try {
    buf = await fetchBuffer(fullUrl);
  } catch (e) {
    console.warn(`    ⚠️  Не удалось скачать ${fullUrl}: ${e.message}`);
    return null;
  }

  const maxWidth = kind === 'formula' ? 1200 : 1600;
  try {
    await sharp(buf, { density: 300 })
      .resize({ width: maxWidth, withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .png({ compressionLevel: 9 })
      .toFile(outPath);
    imageUrlCache.set(cacheKey, outPath);
    console.log(`    🖼  ${filename}`);
    return filename;
  } catch (e) {
    try {
      await sharp(buf).flatten({ background: '#ffffff' }).png().toFile(outPath);
      imageUrlCache.set(cacheKey, outPath);
      console.log(`    🖼  ${filename} (упрощённая конвертация)`);
      return filename;
    } catch (e2) {
      console.warn(`    ⚠️  Не удалось конвертировать ${fullUrl}: ${e2.message}`);
      return null;
    }
  }
}

async function processPlaceholders(rawLatex, placeholders, taskId, baseUrl) {
  let latex = rawLatex;
  let idx = 1;
  for (const ph of placeholders) {
    const filename = await downloadImage(ph.url, taskId, idx, baseUrl, { kind: ph.kind, alt: ph.alt });
    if (filename) {
      const imgPath = `images/${filename}`.replace(/_/g, '\\_');
      let macro;
      if (ph.kind === 'formula') {
        const h = /дробь|корень|степени|начало аргумента/i.test(ph.alt || '') ? '2.2em' : '1.4em';
        macro = `\\includegraphics[height=${h}]{${imgPath}}`;
      } else if (ph.inTable) {
        macro = `\\includegraphics[width=0.4\\linewidth]{${imgPath}}`;
      } else {
        macro = `\n\\kimimg{${imgPath}}\n`;
      }
      latex = latex.split(ph.placeholder).join(macro);
    } else {
      const fallback = ph.kind === 'formula' ? '\\textit{[формула]}' : '\\textit{[рисунок]}';
      latex = latex.split(ph.placeholder).join(fallback);
    }
    idx++;
  }
  return normalizeLatex(latex);
}

const UNIT_MAP = [
  [/метрах в секунду в квадрате/i, '$\\text{м/с}^2$'],
  [/метрах в секунду/i, '$\\text{м/с}$'],
  [/сантиметрах в секунду/i, '$\\text{см/с}$'],
  [/километрах в час/i, '$\\text{км/ч}$'],
  [/километрах/i, '$\\text{км}$'],
  [/сантиметрах/i, '$\\text{см}$'],
  [/миллиметрах/i, '$\\text{мм}$'],
  [/метрах/i, '$\\text{м}$'],
  [/миллисекундах/i, '$\\text{мс}$'],
  [/секундах/i, '$\\text{с}$'],
  [/минутах/i, '$\\text{мин}$'],
  [/часах/i, '$\\text{ч}$'],
  [/килограммах/i, '$\\text{кг}$'],
  [/граммах/i, '$\\text{г}$'],
  [/килоньютонах/i, '$\\text{кН}$'],
  [/ньютонах/i, '$\\text{Н}$'],
  [/килоджоулях/i, '$\\text{кДж}$'],
  [/джоулях/i, '$\\text{Дж}$'],
  [/киловаттах/i, '$\\text{кВт}$'],
  [/ваттах/i, '$\\text{Вт}$'],
  [/килопаскалях/i, '$\\text{кПа}$'],
  [/паскалях/i, '$\\text{Па}$'],
  [/киловольтах/i, '$\\text{кВ}$'],
  [/вольтах/i, '$\\text{В}$'],
  [/миллиамперах/i, '$\\text{мА}$'],
  [/амперах/i, '$\\text{А}$'],
  [/килоомах/i, '$\\text{кОм}$'],
  [/омах/i, '$\\text{Ом}$'],
  [/кулонах/i, '$\\text{Кл}$'],
  [/теслах/i, '$\\text{Тл}$'],
  [/веберах/i, '$\\text{Вб}$'],
  [/герцах/i, '$\\text{Гц}$'],
  [/кельвинах/i, '$\\text{К}$'],
  [/градусах цельсия/i, '$^\\circ\\text{C}$'],
  [/молях/i, '$\\text{моль}$'],
  [/литрах/i, '$\\text{л}$'],
  [/процентах/i, '$\\%$'],
  [/м\/с/i, '$\\text{м/с}$'],
];

function extractUnit(text) {
  const t = normalizeText(text);
  const m = t.match(/(?:Ответ\s+дайте|Ответ\s+укажите|Ответ\s+запишите)\s+в\s+([^.)]+)/i);
  if (!m) return '';
  const scope = m[1];
  for (const [re, latex] of UNIT_MAP) {
    if (re.test(scope)) return latex;
  }
  return '';
}

function findCondition($, root) {
  let el = $(root).find('.pbody[id^="body"]').first();
  if (!el.length) el = $(root).find('.pbody').not('.solution').first();
  return el;
}

function extractTaskHeader($, root, fallbackId) {
  const numsEl = $(root).find('.prob_nums').first();
  const numsText = normalizeText(numsEl.text());
  let sourceId = fallbackId ? String(fallbackId) : '';
  let idLink = numsEl.find('a[href*="problem?id="]').first();
  if (!idLink.length) idLink = $(root).find('a[href*="problem?id="]').first();
  if (idLink.length) {
    const m = (idLink.attr('href') || '').match(/[?&]id=(\d+)/);
    if (m) sourceId = m[1];
  }
  let kimLine = null;
  const mLine = numsText.match(/Тип\s+(\d+)\b/i);
  if (mLine) kimLine = parseInt(mLine[1], 10);
  return { sourceId, kimLine, numsText };
}

function parseTaskContent($, root, sourceId, lineHint) {
  const condEl = findCondition($, root);
  if (!condEl.length) return null;
  const solEl = $(root).find('.solution').first();
  const ansEl = $(root).find('.answer').first();

  const condPlaceholders = [];
  const condLatex = convertHtmlToLatex($, condEl, condPlaceholders);
  const solPlaceholders = [];
  let solLatex = solEl.length ? convertHtmlToLatex($, solEl, solPlaceholders) : '';
  solLatex = solLatex
    .replace(/^\s*\\textbf\{\s*Решение[^}]*\}\s*/i, '')
    .replace(/^\s*Решение[.:]?\s*/i, '');

  let answer = '';
  if (ansEl.length) {
    answer = normalizeText(ansEl.text()).replace(/^[Оо]твет[:\s]*/i, '').trim();
  }
  if (!answer) {
    const bodyText = normalizeText($(root).text());
    const m = bodyText.match(/Ответ[:\s]+([^\n]{1,120})/i);
    if (m) answer = m[1].trim();
  }
  if (!answer) answer = '—';

  const header = extractTaskHeader($, root, sourceId);
  const kimLine = header.kimLine || lineHint || null;
  return {
    sourceId: header.sourceId || sourceId,
    kimLine,
    condLatex,
    solLatex,
    condPlaceholders,
    solPlaceholders,
    answer,
    unit: extractUnit(normalizeText(condEl.text())),
    rawConditionText: normalizeText(condEl.text()),
  };
}

function parseTaskFromRoot($, root, fallbackId, lineHint) {
  const header = extractTaskHeader($, root, fallbackId);
  if (!header.sourceId) return null;
  const content = parseTaskContent($, root, header.sourceId, lineHint);
  if (!content) return null;
  return content;
}

const catalogCache = new Map();
let catalogDocCache = null;

function emptyCatalogDoc() {
  return { version: 1, updated_at: null, exams: {}, problem_index: {} };
}

// Кэш каталога /prob_catalog (JSON /newapi/catalog/types + индекс задач).
// В индексе хранится точное соответствие source_id → линия/подтема, чтобы
// размечать уже скачанные задачи без повторных запросов к сайту.
function catalogDoc() {
  if (catalogDocCache) return catalogDocCache;
  if (fs.existsSync(CATALOG_CACHE_PATH)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(CATALOG_CACHE_PATH, 'utf8'));
      catalogDocCache = {
        version: parsed.version || 1,
        updated_at: parsed.updated_at || null,
        exams: parsed.exams || {},
        problem_index: parsed.problem_index || {},
      };
      return catalogDocCache;
    } catch (e) {
      console.warn(`  ⚠️  Не удалось прочитать кэш каталога: ${e.message}`);
    }
  }
  catalogDocCache = emptyCatalogDoc();
  return catalogDocCache;
}

function saveCatalogDoc() {
  if (!catalogDocCache) return;
  catalogDocCache.updated_at = new Date().toISOString();
  try {
    fs.writeFileSync(CATALOG_CACHE_PATH, JSON.stringify(catalogDocCache, null, 1), 'utf8');
  } catch (e) {
    console.warn(`  ⚠️  Не удалось сохранить кэш каталога: ${e.message}`);
  }
}

async function fetchCatalog(exam, options = {}) {
  if (!options.refresh && catalogCache.has(exam)) return catalogCache.get(exam);
  if (!options.refresh) {
    const cached = catalogDoc().exams[exam];
    if (cached && Array.isArray(cached.groups) && cached.groups.length) {
      catalogCache.set(exam, cached.groups);
      return cached.groups;
    }
  }
  const base = DOMAINS[exam];
  const raw = await fetchJson(`${base}/newapi/catalog/types`, '{}');
  const data = JSON.parse(raw);
  const types = data.types || [];
  const type = types.find(t => t.name === 'sgia') || types[0];
  if (!type || !Array.isArray(type.catalogs) || !type.catalogs.length) {
    throw new Error('Не удалось прочитать структуру каталога сайта');
  }
  const themes = type.catalogs[0].themes || [];
  if (!themes.length) throw new Error('Каталог сайта пуст');
  catalogDoc().exams[exam] = {
    catalog_url: `${base}/prob_catalog`,
    api_url: `${base}/newapi/catalog/types`,
    fetched_at: new Date().toISOString(),
    groups: themes,
  };
  saveCatalogDoc();
  catalogCache.set(exam, themes);
  return themes;
}

function lookupProblem(exam, sourceId) {
  if (!sourceId) return null;
  const index = catalogDoc().problem_index[exam] || {};
  return index[String(sourceId)] || null;
}

function indexProblem(exam, sourceId, cat) {
  if (!sourceId || !cat) return false;
  const doc = catalogDoc();
  if (!doc.problem_index[exam]) doc.problem_index[exam] = {};
  const map = doc.problem_index[exam];
  const key = String(sourceId);
  const next = {
    line: Number(cat.line) || null,
    group: cat.groupTitle || '',
    subtopic_id: `theme_${cat.id}`,
    subtopic_title: cat.topicTitle || '',
  };
  const prev = map[key];
  if (prev && prev.subtopic_id === next.subtopic_id && prev.line === next.line) return false;
  map[key] = next;
  return true;
}

function groupNumber(group) {
  const m = String(group.title || '').match(/^\s*(\d+)\./);
  return m ? parseInt(m[1], 10) : null;
}

function groupCategoriesDetailed(group, lineHint) {
  const line = groupNumber(group) || lineHint || null;
  const children = Array.isArray(group.children) ? group.children : [];
  if (children.length) {
    return children
      .filter(ch => ch && ch.id != null)
      .map(ch => ({
        id: Number(ch.id),
        line,
        groupTitle: group.title || '',
        topicTitle: ch.title || '',
        count: Number(ch.count) || 0,
        subtopic_id: `theme_${Number(ch.id)}`,
      }));
  }
  if (group.id != null) {
    return [{
      id: Number(group.id),
      line,
      groupTitle: group.title || '',
      topicTitle: group.title || '',
      count: Number(group.count) || 0,
      subtopic_id: `theme_${Number(group.id)}`,
    }];
  }
  return [];
}

function filterCategoriesByTopic(categories, topic) {
  if (!topic) return categories;
  const pattern = TOPIC_PATTERNS[topic];
  if (!pattern) return categories;
  const matched = categories.filter(c => pattern.test(c.topicTitle || '') || pattern.test(c.groupTitle || ''));
  return matched.length ? matched : categories;
}

async function resolveCategoriesForLine(exam, line, topic) {
  const themes = await fetchCatalog(exam);
  const group = themes.find(g => groupNumber(g) === Number(line));
  if (!group) {
    const available = themes.map(g => g.title).filter(Boolean).slice(0, 30).join('; ');
    throw new Error(`Линия ${line} не найдена в каталоге ${exam}. Доступно: ${available}`);
  }
  return filterCategoriesByTopic(groupCategoriesDetailed(group, line), topic);
}

async function resolveCategoriesForTopic(exam, topic) {
  const themes = await fetchCatalog(exam);
  const pattern = TOPIC_PATTERNS[topic];
  if (!pattern) {
    throw new Error(`Неизвестный topic "${topic}". Доступно: ${Object.keys(TOPIC_PATTERNS).join(', ')}`);
  }
  const maxLine = exam === 'EGE' ? 26 : 22;
  const parent = PARENT_TOPICS.has(topic);
  const result = [];
  const seen = new Set();
  for (const group of themes) {
    const line = groupNumber(group);
    if (!line || line > maxLine) continue;
    const children = Array.isArray(group.children) ? group.children : [];
    const groupMatches = pattern.test(group.title || '');
    const matchingChildren = children.filter(ch => pattern.test(ch.title || ''));
    let selected = [];
    if (parent && groupMatches) selected = children;
    else if (matchingChildren.length) selected = matchingChildren;
    else if (groupMatches) selected = children;
    if (!selected.length && groupMatches && group.id != null) {
      selected = [{ id: group.id, title: group.title }];
    }
    for (const ch of selected) {
      if (!ch || ch.id == null) continue;
      const id = Number(ch.id);
      if (seen.has(id)) continue;
      seen.add(id);
      result.push({ id, line, groupTitle: group.title || '', topicTitle: ch.title || '' });
    }
  }
  if (!result.length) {
    throw new Error(`Для topic "${topic}" не найдено категорий в каталоге ${exam}`);
  }
  return result;
}

// Строгий поиск категорий для пары «тема + линия»:
// совпадение проверяется по названию конкретной категории, без fallback
// «взять все категории линии», чтобы preset не затягивал чужие разделы.
async function resolveCategoriesForTopicLine(exam, topic, line) {
  const pattern = TOPIC_PATTERNS[topic];
  if (!pattern) return [];
  const themes = await fetchCatalog(exam);
  const group = themes.find(g => groupNumber(g) === Number(line));
  if (!group) return [];
  return groupCategoriesDetailed(group, line)
    .filter(cat => pattern.test(cat.topicTitle || ''));
}

// Для ЕГЭ названия категорий достаточно конкретные — работает строгий фильтр.
// Для ОГЭ категории часто называются по разделу («Механические явления»,
// «Тепловые явления»), поэтому сначала пробуем точное совпадение, затем
// parent-раздел, затем название всей группы линий.
async function resolveCategoriesForPresetLine(exam, topic, line) {
  const pattern = TOPIC_PATTERNS[topic];
  if (!pattern) return [];
  const themes = await fetchCatalog(exam);
  const group = themes.find(g => groupNumber(g) === Number(line));
  if (!group) return [];

  const cats = groupCategoriesDetailed(group, line);
  const strict = cats.filter(cat => pattern.test(cat.topicTitle || ''));
  if (strict.length || exam === 'EGE') return strict;

  const parent = PARENT_OF[topic];
  const fallbackPattern = OGE_FALLBACK_PATTERNS[topic] || (parent ? TOPIC_PATTERNS[parent] : null);
  if (fallbackPattern) {
    const byFallback = cats.filter(cat => fallbackPattern.test(cat.topicTitle || ''));
    if (byFallback.length) return byFallback;
  }

  const groupTitle = group.title || '';
  if (pattern.test(groupTitle) || (fallbackPattern && fallbackPattern.test(groupTitle))) {
    return cats;
  }
  return [];
}

// Номер линии КИМ для категории каталога. Для ЕГЭ совпадает с номером группы,
// для ОГЭ используется явная карта OGE_CATALOG_LINES (см. выше).
function examLineForCatalogCategory(exam, groupLine, categoryId) {
  const groupNo = Number(groupLine);
  if (exam !== 'OGE') return groupNo || null;
  for (const [line, map] of Object.entries(OGE_CATALOG_LINES)) {
    if (!map.groups.includes(groupNo)) continue;
    if (map.subtopics && !map.subtopics.includes(Number(categoryId))) continue;
    return Number(line);
  }
  return groupNo || null;
}

// Все категории каталога, закреплённые за линией КИМ. Именно эта функция
// используется для матрицы, индексации каталога и докачки линий.
async function resolveCategoriesForExamLine(exam, line) {
  const themes = await fetchCatalog(exam);
  const lineNo = Number(line);
  const groups = [];
  if (exam === 'OGE') {
    const map = OGE_CATALOG_LINES[lineNo];
    if (!map) return [];
    for (const groupNo of map.groups) {
      const group = themes.find(g => groupNumber(g) === groupNo);
      if (group) groups.push({ group, filter: map.subtopics || null });
    }
  } else {
    const group = themes.find(g => groupNumber(g) === lineNo);
    if (group) groups.push({ group, filter: null });
  }
  const result = [];
  for (const { group, filter } of groups) {
    let cats = groupCategoriesDetailed(group, lineNo);
    if (filter) cats = cats.filter(cat => filter.includes(cat.id));
    for (const cat of cats) {
      result.push({ ...cat, line: lineNo, exam_line: lineNo });
    }
  }
  return result;
}

async function resolveCategoryArg(exam, categoryId, lineHint) {
  try {
    const themes = await fetchCatalog(exam);
    for (const group of themes) {
      const children = Array.isArray(group.children) ? group.children : [];
      const child = children.find(ch => Number(ch.id) === Number(categoryId));
      if (child) {
        const line = examLineForCatalogCategory(exam, groupNumber(group), categoryId) || lineHint || null;
        return [{
          id: Number(categoryId),
          line,
          groupTitle: group.title || '',
          topicTitle: child.title || '',
          count: Number(child.count) || 0,
          subtopic_id: `theme_${Number(categoryId)}`,
        }];
      }
    }
    const group = themes.find(g => groupNumber(g) === Number(categoryId));
    if (group) return groupCategoriesDetailed(group, lineHint);
  } catch { /* работаем с указанным ID напрямую */ }
  return [{ id: Number(categoryId), line: lineHint || null, groupTitle: '', topicTitle: '' }];
}

function lineToTopics(exam, line, topicArg) {
  if (topicArg) {
    const parent = PARENT_OF[topicArg];
    return parent ? [parent, topicArg] : [topicArg];
  }
  const n = Number(line);
  if (exam === 'EGE') {
    if (n === 1) return ['mechanics', 'kinematics'];
    if (n === 2) return ['mechanics', 'dynamics'];
    if (n === 3) return ['mechanics', 'conservation_laws'];
    if (n === 4) return ['mechanics', 'statics'];
    if (n === 5 || n === 6) return ['mechanics'];
    if (n === 7 || n === 8) return ['mkt_thermo', 'mkt'];
    if (n === 9 || n === 10) return ['mkt_thermo', 'thermodynamics'];
    if (n === 11) return ['electrodynamics'];
    if (n === 12) return ['electrodynamics', 'magnetism'];
    if (n === 13) return ['electrodynamics', 'optics'];
    if (n === 14 || n === 15) return ['electrodynamics'];
    if (n === 16) return ['quantum', 'nuclear'];
    if (n === 17) return ['quantum', 'quantum_physics'];
    if (n === 18) return ['methods', 'measurements'];
    if (n === 19 || n === 20) return ['methods', 'measurements'];
    if (n === 21 || n === 23) return ['mkt_thermo', 'electrodynamics'];
    if (n === 24) return ['mkt_thermo', 'thermodynamics'];
    if (n === 25) return ['electrodynamics'];
    if (n === 26) return ['mechanics'];
    return ['mechanics'];
  }
  if (n === 1 || n === 2) return ['methods', 'measurements'];
  if (n >= 3 && n <= 7) return ['mechanics'];
  if (n === 8) return ['mkt_thermo', 'thermodynamics'];
  if (n === 9 || n === 10) return ['electrodynamics'];
  if (n === 11) return ['quantum', 'nuclear'];
  if (n === 12) return ['mechanics', 'mkt_thermo'];
  if (n === 13) return ['electrodynamics', 'optics'];
  if (n === 14) return ['mechanics'];
  if (n >= 15 && n <= 17) return ['methods', 'measurements'];
  return ['mechanics'];
}

function primaryTopic(topics, topicArg) {
  if (topicArg && topics.includes(topicArg)) return topicArg;
  return topics.find(t => !PARENT_TOPICS.has(t)) || topics[0] || 'GEN';
}

let validTopicKeysCache = null;

function validTopicKeys() {
  if (validTopicKeysCache) return validTopicKeysCache;
  try {
    const raw = JSON.parse(fs.readFileSync(TOPICS_PATH, 'utf8'));
    const keys = new Set();
    for (const [sectionKey, section] of Object.entries(raw)) {
      keys.add(sectionKey);
      for (const subKey of Object.keys(section.subtopics || {})) keys.add(subKey);
    }
    validTopicKeysCache = keys;
  } catch {
    validTopicKeysCache = new Set([...PRESET_TOPICS, ...PARENT_TOPICS,
      'mechanics', 'mkt_thermo', 'electrodynamics', 'quantum', 'methods']);
  }
  return validTopicKeysCache;
}

// Узкие темы новой задачи: матрица подтемы + контентный классификатор
// (mkt/vapors/em_oscillations в широких разделах ОГЭ и ЕГЭ).
function topicsForImportedTask(exam, kimLine, subtopicId, text, topicArg) {
  const matrix = readMatrix();
  const extraKeys = topicArg && NARROW_TOPIC_KEYS.includes(topicArg) ? [topicArg] : [];
  return buildTopicList({
    exam,
    line: kimLine,
    subtopicId,
    matrix,
    text: String(text || ''),
    existingTopics: lineToTopics(exam, kimLine, topicArg),
    extraKeys,
    validKeys: validTopicKeys(),
  });
}

function generateId(db, exam, topic) {
  const examPart = (exam || 'TASK').toUpperCase();
  const topicPart = SHORT_TOPICS[topic] || String(topic || 'GEN').toUpperCase().slice(0, 3);
  const prefix = `${examPart}-${topicPart}-`;
  const existing = new Set(
    db.filter(t => t.id && t.id.startsWith(prefix))
      .map(t => parseInt(t.id.slice(prefix.length), 10))
      .filter(n => !isNaN(n))
  );
  for (let i = 1; i <= 99999; i++) {
    if (!existing.has(i)) return `${prefix}${String(i).padStart(4, '0')}`;
  }
  return `${prefix}${Date.now()}`;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq >= 0) {
      args[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args[key] = next; i++; }
      else args[key] = true;
    }
  }
  return args;
}

async function importOneRoot($, root, fallbackId, lineHint, state) {
  if (state.limit && state.imported >= state.limit) return 'stop';
  const header = extractTaskHeader($, root, fallbackId);
  const sourceId = header.sourceId || (fallbackId ? String(fallbackId) : '');
  if (!sourceId) return 'skip';
  const cat = state.currentCategory || null;
  const indexed = lookupProblem(state.exam, sourceId);
  const seenKey = `${state.exam}:${sourceId}`;
  if (state.seen.has(seenKey)) {
    console.log(`⏭️  Пропуск [${sourceId}] — уже в базе.`);
    state.skipped++;
    return 'skip';
  }

  const content = parseTaskContent($, root, sourceId, lineHint);
  if (!content) {
    console.warn(`  ⚠️  Задача ${sourceId}: не найден текст условия`);
    state.failed++;
    return 'fail';
  }

  // Линия и подтема берутся из категории каталога (/prob_catalog) — это
  // точная привязка к КИМ, в отличие от «Тип N» на странице задачи.
  const kimLine = (cat && cat.line) || header.kimLine || content.kimLine || (indexed && indexed.line) ||
    state.lineArg || lineHint || 1;
  const subtopicId = cat ? `theme_${cat.id}` : ((indexed && indexed.subtopic_id) || '');
  const subtopicTitle = cat ? (cat.topicTitle || '') : ((indexed && indexed.subtopic_title) || '');
  const topics = topicsForImportedTask(
    state.exam,
    kimLine,
    subtopicId,
    `${content.condLatex || ''}\n${content.solLatex || ''}`,
    state.topicArg
  );
  const meta = lineToMeta(state.exam, kimLine);
  const newId = generateId(state.db, state.exam, primaryTopic(topics, state.topicArg));

  let condLatex;
  let solLatex;
  if (state.dryRun) {
    condLatex = normalizeLatex(content.condLatex.replace(/@@IMG\d+@@/g, '\\textit{[рисунок]}'));
    solLatex = content.solLatex
      ? normalizeLatex(content.solLatex.replace(/@@IMG\d+@@/g, '\\textit{[рисунок]}'))
      : 'Решение не приводится.';
  } else {
    console.log(`\n▶ Задача ${sourceId} → ${newId}`);
    condLatex = await processPlaceholders(content.condLatex, content.condPlaceholders, newId, DOMAINS[state.exam]);
    solLatex = content.solLatex
      ? await processPlaceholders(content.solLatex, content.solPlaceholders, newId, DOMAINS[state.exam])
      : '';
  }
  solLatex = stripSolutionAnswer(solLatex);
  if (!solLatex.trim()) solLatex = 'Решение не приводится.';
  solLatex = ensureSolutionEnd(solLatex);
  if (!condLatex.trim()) {
    console.warn(`  ⚠️  Задача ${sourceId}: пустое условие`);
    state.failed++;
    return 'fail';
  }

  const task = {
    id: newId,
    source_id: sourceId,
    exam: state.exam,
    part: meta.part,
    kim_line: kimLine,
    subtopic_id: subtopicId,
    subtopic_title: subtopicTitle,
    topics,
    grading_rule: meta.grading_rule,
    max_points: meta.max_points,
    answer: content.answer || '—',
    unit: content.unit || '',
    latex_condition: condLatex,
    latex_solution: solLatex,
  };

  if (!state.dryRun) {
    state.db.push(task);
    state.dirty = true;
    state.pending = (state.pending || 0) + 1;
    checkpoint(state);
  }
  state.seen.add(seenKey);
  state.imported++;
  console.log(`  ✅ ${newId} | линия ${kimLine} | ${meta.grading_rule} | ${content.answer}`);
  if (state.progress) {
    const done = state.imported - state.progress.start;
    console.log(`[Тема: ${state.progress.topic} | Линия ${state.progress.line}] Скачано ${done}/${state.progress.target}...`);
  }
  return 'ok';
}

// Индексируем все задачи страницы каталога: source_id → линия/подтема.
// Это позволяет потом размечать уже скачанные задачи без повторных запросов.
function indexPageRoots($, roots, cat, exam) {
  if (!cat) return 0;
  let added = 0;
  roots.each((_, el) => {
    const header = extractTaskHeader($, $(el), null);
    if (header.sourceId && indexProblem(exam, header.sourceId, cat)) added++;
  });
  if (added) saveCatalogDoc();
  return added;
}

async function processPageHtml(html, pageInfo, state, maxNew = null) {
  const $ = cheerio.load(html);
  let roots = $('.prob_maindiv');
  if (!roots.length && pageInfo.fallbackId) roots = $('body');
  if (!roots.length) return 'empty';
  state.currentCategory = pageInfo.category || null;
  indexPageRoots($, roots, pageInfo.category, state.exam);
  const startedAt = state.imported;
  for (let i = 0; i < roots.length; i++) {
    if (maxNew != null && state.imported - startedAt >= maxNew) return 'limit';
    const result = await importOneRoot($, roots.eq(i), pageInfo.fallbackId, pageInfo.line || null, state);
    if (result === 'stop') return 'stop';
  }
  if (maxNew != null && state.imported - startedAt >= maxNew) return 'limit';
  return 'ok';
}

async function fetchIndividualTask(taskId, state) {
  const url = `${DOMAINS[state.exam]}/problem?id=${encodeURIComponent(taskId)}&print=true`;
  const html = await fetchHtml(url);
  return processPageHtml(html, { fallbackId: String(taskId), line: state.lineArg }, state);
}

function extractProblemIds($) {
  const ids = [];
  const seen = new Set();
  $('a[href*="problem?id="]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(/[?&]id=(\d+)/);
    if (m && !seen.has(m[1])) { seen.add(m[1]); ids.push(m[1]); }
  });
  return ids;
}

function groupCategoriesByLine(categories) {
  const byLine = new Map();
  for (const cat of categories) {
    const line = Number(cat.line);
    if (!line) continue;
    if (!byLine.has(line)) byLine.set(line, []);
    byLine.get(line).push(cat);
  }
  return Array.from(byLine.entries()).sort((a, b) => a[0] - b[0]);
}

// ───────────────────────────────────────────────────────────────────────────
// Эталонная матрица линий КИМ: tasks/kim_matrix.json
// ───────────────────────────────────────────────────────────────────────────
function readMatrix() {
  try {
    return JSON.parse(fs.readFileSync(MATRIX_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function matrixSubtopics(matrix, exam, line) {
  const spec = matrix && matrix.exams && matrix.exams[exam];
  if (!spec || !Array.isArray(spec.lines)) return null;
  const row = spec.lines.find(item => Number(item.line) === Number(line));
  return row && Array.isArray(row.subtopics) ? row.subtopics : null;
}

async function buildMatrixFile(exams = ['EGE', 'OGE']) {
  const matrix = {
    version: 1,
    generated_at: new Date().toISOString(),
    description: 'Эталонная матрица линий КИМ ЕГЭ (1–26) и ОГЭ (1–22) по физике. ' +
      'Названия линий, формат ответа и баллы — по спецификации ФИПИ; ' +
      'подтемы — категории каталога заданий (/prob_catalog).',
    source: {
      catalog_ege: 'https://phys-ege.sdamgia.ru/prob_catalog',
      catalog_oge: 'https://phys-oge.sdamgia.ru/prob_catalog',
      catalog_api: 'https://phys-ege.sdamgia.ru/newapi/catalog/types',
    },
    exams: {},
  };

  for (const exam of exams) {
    const specs = LINE_SPECS[exam] || [];
    const lines = [];
    console.log(`\n📐 Матрица ${exam}: ${specs.length} линий`);
    for (const spec of specs) {
      let cats = [];
      try {
        cats = await resolveCategoriesForExamLine(exam, spec.line);
      } catch (e) {
        console.warn(`  ⚠️  ${exam} линия ${spec.line}: каталог недоступен (${e.message})`);
      }
      const catalogGroups = exam === 'OGE'
        ? ((OGE_CATALOG_LINES[spec.line] || {}).groups || [])
        : [spec.line];
      lines.push({
        line: spec.line,
        part: defaultPart(exam, spec.line),
        title: spec.title,
        grading_rule: spec.grading_rule,
        max_points: spec.max_points,
        section: spec.section || null,
        section_title: spec.section ? SECTION_TITLES[spec.section] : null,
        catalog_groups: catalogGroups,
        subtopics: cats.map(cat => ({
          id: `theme_${cat.id}`,
          catalog_id: cat.id,
          title: cat.topicTitle,
          catalog_count: cat.count || 0,
        })),
      });
      console.log(`  ${String(spec.line).padStart(2)}. ${spec.title} — подтем: ${cats.length}`);
    }
    matrix.exams[exam] = {
      title: exam === 'EGE' ? 'ЕГЭ по физике' : 'ОГЭ по физике',
      max_line: MAX_LINE[exam],
      parts: exam === 'EGE'
        ? [
          { part: 1, title: 'Часть 1. Задания с кратким ответом', lines: [1, 20] },
          { part: 2, title: 'Часть 2. Задания с развёрнутым ответом', lines: [21, 26] },
        ]
        : [
          { part: 1, title: 'Часть 1. Задания с кратким ответом', lines: [1, 16] },
          { part: 2, title: 'Часть 2. Задания с развёрнутым ответом', lines: [17, 22] },
        ],
      sections: SECTION_TITLES,
      lines,
    };
  }

  fs.writeFileSync(MATRIX_PATH, JSON.stringify(matrix, null, 2), 'utf8');
  console.log(`\n✅ Матрица сохранена: ${MATRIX_PATH}`);
  return matrix;
}

// ───────────────────────────────────────────────────────────────────────────
// Индексация каталога: source_id → линия КИМ + точная подтема
// ───────────────────────────────────────────────────────────────────────────
async function indexCatalog(exam) {
  const maxLine = MAX_LINE[exam] || 26;
  let pages = 0;
  let problems = 0;
  console.log(`\n🗂  Индексация каталога ${exam} (${maxLine} линий)...`);
  for (let line = 1; line <= maxLine; line++) {
    let cats = [];
    try {
      cats = await resolveCategoriesForExamLine(exam, line);
    } catch (e) {
      console.warn(`  ⚠️  ${exam} линия ${line}: ${e.message}`);
      continue;
    }
    console.log(`\n── Линия ${line}: категорий ${cats.length}`);
    for (const cat of cats) {
      if (!cat.count) {
        console.log(`   ⏭  theme_${cat.id} | ${cat.topicTitle} — 0 задач`);
        continue;
      }
      try {
        const html = await fetchHtml(`${DOMAINS[exam]}/test?theme=${cat.id}&print=true`);
        const $ = cheerio.load(html);
        const roots = $('.prob_maindiv');
        const added = indexPageRoots($, roots, cat, exam);
        pages++;
        problems += roots.length;
        console.log(`   ✔ theme_${cat.id} | ${cat.topicTitle}: ${roots.length} задач (+${added} в индекс)`);
      } catch (e) {
        console.warn(`   ⚠️  theme_${cat.id}: ${e.message}`);
      }
    }
  }
  saveCatalogDoc();
  const index = catalogDoc().problem_index[exam] || {};
  console.log(`\n✅ Индекс ${exam}: страниц ${pages}, задач ${problems}, записей в кэше ${Object.keys(index).length}`);
  return Object.keys(index).length;
}

// ───────────────────────────────────────────────────────────────────────────
// Докачка линий: гарантируем не меньше minPerLine задач на каждую линию КИМ
// ───────────────────────────────────────────────────────────────────────────
function countLineTasks(db, exam, line) {
  return db.filter(t => t.exam === exam && Number(t.kim_line) === Number(line)).length;
}

async function runCoverage(state, exam, minPerLine, linesFilter = null) {
  const maxLine = MAX_LINE[exam] || 26;
  const startedAt = Date.now();
  const importedAtStart = state.imported;
  const stats = [];

  console.log(`\n🚀 Покрытие ${exam}: минимум ${minPerLine} задач на линию (1–${maxLine})`);

  for (let line = 1; line <= maxLine; line++) {
    if (linesFilter && !linesFilter.includes(line)) continue;
    let count = countLineTasks(state.db, exam, line);
    if (count >= minPerLine) {
      console.log(`✓ Линия ${line}: ${count} задач — достаточно`);
      stats.push({ line, before: count, after: count, target: minPerLine, ok: true });
      continue;
    }

    console.log(`\n━━━ Линия ${line}: ${count}/${minPerLine} — докачиваем ━━━`);
    const before = count;
    let cats = [];
    try {
      cats = await resolveCategoriesForExamLine(exam, line);
    } catch (e) {
      console.warn(`  ⚠️  Линия ${line}: каталог недоступен (${e.message})`);
    }

    for (const cat of cats) {
      count = countLineTasks(state.db, exam, line);
      if (count >= minPerLine) break;
      if (!cat.count) continue;
      const remaining = minPerLine - count;
      console.log(`  📥 theme_${cat.id} | ${cat.topicTitle} (нужно ещё ${remaining})`);
      try {
        const html = await fetchHtml(`${DOMAINS[exam]}/test?theme=${cat.id}&print=true`);
        await processPageHtml(html, { line, category: cat }, state, remaining);
      } catch (e) {
        console.error(`  ❌ theme_${cat.id}: ${e.message}`);
        state.failed++;
      }
    }

    count = countLineTasks(state.db, exam, line);
    if (count < minPerLine) {
      console.warn(`⚠️  Линия ${line}: ${count} задач (каталог исчерпан, цель ${minPerLine})`);
    } else {
      console.log(`✅ Линия ${line}: ${count} задач`);
    }
    stats.push({ line, before, after: count, target: minPerLine, ok: count >= minPerLine });
  }

  const seconds = Math.round((Date.now() - startedAt) / 1000);
  const short = stats.filter(s => !s.ok);
  console.log(`\n🏁 Покрытие ${exam} завершено: импортировано ${state.imported - importedAtStart}, ` +
    `линий ниже цели ${short.length}${short.length ? ' (' + short.map(s => s.line + ': ' + s.after).join(', ') + ')' : ''}, ${seconds} с.`);
  return stats;
}

// ───────────────────────────────────────────────────────────────────────────
// Гарантированное покрытие подтем: минимум N задач на каждый subtopic_id
// ───────────────────────────────────────────────────────────────────────────
function countSubtopicTasks(db, exam, subtopicId) {
  const id = String(subtopicId);
  return db.filter(t => t.exam === exam && String(t.subtopic_id || '') === id).length;
}

async function runEnsureSubtopics(state, exam, minPerSubtopic, linesFilter = null) {
  const matrix = readMatrix();
  const spec = matrix && matrix.exams && matrix.exams[exam];
  if (!spec || !Array.isArray(spec.lines)) {
    throw new Error(`Нет матрицы для ${exam}: проверьте tasks/kim_matrix.json`);
  }

  const startedAt = Date.now();
  const importedAtStart = state.imported;
  const stats = [];
  const maxPages = 12;

  console.log(`\n🚀 Покрытие подтем ${exam}: минимум ${minPerSubtopic} задач на каждый subtopic_id`);

  for (const line of spec.lines) {
    const lineNo = Number(line.line);
    if (linesFilter && !linesFilter.includes(lineNo)) continue;

    let cats = [];
    try {
      cats = await resolveCategoriesForExamLine(exam, lineNo);
    } catch (e) {
      console.warn(`  ⚠️  ${exam} линия ${lineNo}: каталог недоступен (${e.message})`);
    }
    const catById = new Map(cats.map(cat => [String(cat.id), cat]));

    for (const sub of line.subtopics || []) {
      const subtopicId = String(sub.id);
      const before = countSubtopicTasks(state.db, exam, subtopicId);
      if (before >= minPerSubtopic) {
        console.log(`✓ ${exam} ${lineNo} | ${subtopicId} ${sub.title}: ${before} задач — достаточно`);
        stats.push({ exam, line: lineNo, subtopicId, title: sub.title, before, after: before, target: minPerSubtopic, ok: true });
        continue;
      }

      const catalogId = sub.catalog_id != null
        ? Number(sub.catalog_id)
        : Number(subtopicId.replace(/^theme_/, ''));
      const cat = catById.get(String(catalogId)) || {
        id: catalogId,
        line: lineNo,
        topicTitle: sub.title || subtopicId,
        count: Number(sub.catalog_count) || 0,
      };

      console.log(`\n━━━ ${exam} ${lineNo} | ${subtopicId} ${sub.title}: ${before}/${minPerSubtopic} — докачиваем ━━━`);
      state.currentCategory = { ...cat, line: lineNo };
      state.progress = {
        topic: `${exam} ${lineNo}: ${cat.topicTitle || sub.title}`,
        line: lineNo,
        start: state.imported,
        target: Math.max(1, minPerSubtopic - before),
      };

      let page = 1;
      let failed = false;
      while (countSubtopicTasks(state.db, exam, subtopicId) < minPerSubtopic && page <= maxPages) {
        const countBeforePage = countSubtopicTasks(state.db, exam, subtopicId);
        const importedBeforePage = state.imported;
        try {
          const url = `${DOMAINS[exam]}/test?theme=${catalogId}&print=true&page=${page}`;
          const html = await fetchHtml(url);
          const result = await processPageHtml(
            html,
            { line: lineNo, category: state.currentCategory, page },
            state,
            minPerSubtopic - countBeforePage
          );
          const countAfterPage = countSubtopicTasks(state.db, exam, subtopicId);
          const added = state.imported - importedBeforePage;
          console.log(`  📄 page ${page}: ${countBeforePage} → ${countAfterPage} задач (новых ${added})`);
          if (result === 'stop' || result === 'empty') break;
          if (countAfterPage >= minPerSubtopic) break;
          // Сайт отдаёт всю категорию одной страницей, поэтому повторная
          // страница без новых задач означает, что каталог исчерпан.
          if (added === 0) break;
          page++;
        } catch (e) {
          failed = true;
          console.error(`  ❌ ${subtopicId} page ${page}: ${e.message}`);
          state.failed++;
          break;
        }
      }

      state.progress = null;
      const after = countSubtopicTasks(state.db, exam, subtopicId);
      if (after < minPerSubtopic) {
        const reason = failed ? 'ошибка каталога' : 'каталог исчерпан';
        console.warn(`⚠️  ${subtopicId}: ${after} задач (${reason}, цель ${minPerSubtopic})`);
      } else {
        console.log(`✅ ${subtopicId}: ${after} задач`);
      }
      stats.push({
        exam,
        line: lineNo,
        subtopicId,
        title: sub.title,
        before,
        after,
        target: minPerSubtopic,
        ok: after >= minPerSubtopic,
      });
      checkpoint(state, true);
    }
  }

  const seconds = Math.round((Date.now() - startedAt) / 1000);
  const short = stats.filter(row => !row.ok);
  console.log(`\n🏁 Покрытие подтем ${exam} завершено: импортировано ${state.imported - importedAtStart}, ` +
    `подтем ниже цели ${short.length}${short.length ? ' (' + short.map(row => `${row.subtopicId}:${row.after}`).join(', ') + ')' : ''}, ${seconds} с.`);
  return stats;
}

// ───────────────────────────────────────────────────────────────────────────
// Заполнение subtopic_id/subtopic_title у уже скачанных задач
// ───────────────────────────────────────────────────────────────────────────
function pickSubtopic(topics, subtopics) {
  if (!subtopics || !subtopics.length) return null;
  const keys = (topics || []).filter(t => !PARENT_TOPICS.has(t))
    .concat((topics || []).filter(t => PARENT_TOPICS.has(t)));
  for (const key of keys) {
    const pattern = TOPIC_PATTERNS[key];
    if (!pattern) continue;
    const hit = subtopics.find(sub => pattern.test(sub.title || ''));
    if (hit) return hit;
  }
  return subtopics[0];
}

async function backfillSubtopics(db, exam) {
  const matrix = readMatrix();
  const index = catalogDoc().problem_index[exam] || {};
  const subsCache = new Map();
  let changed = 0;
  let byIndex = 0;
  let byTopic = 0;

  const subtopicsForLine = async (line) => {
    const key = String(line);
    if (subsCache.has(key)) return subsCache.get(key);
    let subs = matrixSubtopics(matrix, exam, line);
    if (!subs) {
      try {
        const cats = await resolveCategoriesForExamLine(exam, line);
        subs = cats.map(cat => ({ id: `theme_${cat.id}`, title: cat.topicTitle }));
      } catch {
        subs = [];
      }
    }
    subsCache.set(key, subs);
    return subs;
  };

  for (const task of db) {
    if (task.exam !== exam) continue;
    if (task.subtopic_id && task.subtopic_title) continue;

    const hit = task.source_id ? index[String(task.source_id)] : null;
    if (hit && hit.subtopic_id && hit.subtopic_title) {
      task.subtopic_id = hit.subtopic_id;
      task.subtopic_title = hit.subtopic_title;
      changed++;
      byIndex++;
      continue;
    }

    const subs = await subtopicsForLine(task.kim_line);
    let pick = null;
    if (task.subtopic_title) {
      pick = subs.find(sub => sub.title === task.subtopic_title) ||
        subs.find(sub => (sub.id || '') === (task.subtopic_id || ''));
    }
    if (!pick) pick = pickSubtopic(task.topics, subs);
    if (pick) {
      task.subtopic_id = task.subtopic_id || pick.id;
      task.subtopic_title = pick.title;
      changed++;
      byTopic++;
    }
  }

  if (changed) writeDB(db);
  console.log(`🧩 ${exam}: размечено задач ${changed} (по индексу каталога ${byIndex}, по теме ${byTopic})`);
  return { changed, byIndex, byTopic };
}

async function backfillAll(db, exams) {
  for (const exam of exams) await backfillSubtopics(db, exam);
}

// ───────────────────────────────────────────────────────────────────────────
// Сводный отчёт по покрытию линий КИМ
// ───────────────────────────────────────────────────────────────────────────
function buildCoverageReport(db, options = {}) {
  const matrix = readMatrix();
  const generatedAt = new Date().toLocaleString('ru-RU');
  const lines = [];

  for (const exam of ['EGE', 'OGE']) {
    const specs = LINE_SPECS[exam] || [];
    const rows = specs.map(spec => {
      const tasks = db.filter(t => t.exam === exam && Number(t.kim_line) === Number(spec.line));
      const subsById = new Map();
      const titlesById = new Map();
      for (const task of tasks) {
        const id = String(task.subtopic_id || '');
        if (!id) continue;
        subsById.set(id, (subsById.get(id) || 0) + 1);
        if (task.subtopic_title) titlesById.set(id, task.subtopic_title);
      }
      const matrixSubs = matrixSubtopics(matrix, exam, spec.line) ||
        (spec.subtopics || []);
      const matrixIds = new Set(matrixSubs.map(sub => String(sub.id || '')).filter(Boolean));
      const filled = matrixIds.size
        ? [...matrixIds].filter(id => (subsById.get(id) || 0) > 0).length
        : subsById.size;
      return {
        line: spec.line,
        part: defaultPart(exam, spec.line),
        title: spec.title,
        count: tasks.length,
        subtopics: filled,
        subtopicsMatrix: matrixSubs.length,
        matrixSubtopics: matrixSubs,
        subtopicList: [...subsById.entries()].map(([id, n]) => [id, n, titlesById.get(id) || id]),
      };
    });
    lines.push({ exam, rows });
  }

  const md = [];
  md.push('# Покрытие базы задач по линиям КИМ');
  md.push('');
  md.push(`Сформировано: ${generatedAt}. Матрица: \`tasks/kim_matrix.json\`, база: \`tasks/db.json\`.`);
  md.push('');
  for (const { exam, rows } of lines) {
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    md.push(`## ${exam === 'EGE' ? 'ЕГЭ' : 'ОГЭ'} — линии 1–${rows.length}`);
    md.push('');
    md.push(`Всего задач: **${total}**.`);
    md.push('');
    md.push('| Линия | Часть | Название | Задач | Подтем (матрица / база) |');
    md.push('|---:|:---:|---|---:|---:|');
    for (const row of rows) {
      md.push(`| ${row.line} | ${row.part} | ${row.title.replace(/\|/g, '\\|')} | ${row.count} | ${row.subtopicsMatrix} / ${row.subtopics} |`);
    }
    md.push('');
  }

  md.push('## Подтемы по линиям');
  md.push('');
  md.push('В скобках — количество задач в базе по подтеме; `—` означает, что подтема есть в матрице, но задач по ней пока нет.');
  md.push('');
  for (const { exam, rows } of lines) {
    md.push(`### ${exam}`);
    md.push('');
    for (const row of rows) {
      const used = new Map(row.subtopicList.map(([id, n, title]) => [String(id), { n, title }]));
      const parts = row.matrixSubtopics.map(sub => {
        const id = String(sub.id || '');
        const hit = used.get(id);
        const n = hit ? hit.n : 0;
        used.delete(id);
        return `${sub.title} (${n})`;
      });
      for (const [, { n, title }] of used) parts.push(`${title} (${n}, вне матрицы)`);
      md.push(`- **${row.line}. ${row.title}** — задач ${row.count}, подтем ${row.subtopics}/${row.subtopicsMatrix}: ${parts.join('; ')}`);
    }
    md.push('');
  }

  md.push('## Узкие темы (16)');
  md.push('');
  md.push('| Тема | ЕГЭ | ОГЭ |');
  md.push('|---|---:|---:|');
  for (const key of NARROW_TOPIC_KEYS) {
    const ege = db.filter(t => t.exam === 'EGE' && Array.isArray(t.topics) && t.topics.includes(key)).length;
    const oge = db.filter(t => t.exam === 'OGE' && Array.isArray(t.topics) && t.topics.includes(key)).length;
    md.push(`| ${key} | ${ege} | ${oge} |`);
  }
  md.push('');

  const text = md.join('\n');
  if (options.write !== false) {
    const reportPath = path.join(ROOT, 'tasks', 'kim_coverage_report.md');
    fs.writeFileSync(reportPath, text, 'utf8');
    console.log(`\n📄 Отчёт сохранён: ${reportPath}`);
  }

  // Консольная таблица (то, что попадает в итоговый отчёт задачи).
  for (const { exam, rows } of lines) {
    console.log(`\n${exam === 'EGE' ? 'ЕГЭ' : 'ОГЭ'}: линия | название | задач | подтем (матрица/база)`);
    for (const row of rows) {
      console.log(`  ${String(row.line).padStart(2)} | ${row.title} | ${row.count} | ${row.subtopicsMatrix}/${row.subtopics}`);
    }
  }

  console.log('\nУзкие темы (16):');
  for (const exam of ['EGE', 'OGE']) {
    const parts = NARROW_TOPIC_KEYS.map(key => {
      const n = db.filter(t => t.exam === exam && Array.isArray(t.topics) && t.topics.includes(key)).length;
      return `${key}=${n}`;
    });
    console.log(`  ${exam}: ${parts.join(', ')}`);
  }
  return { lines, text };
}

async function runPreset(state, preset, perTopic) {
  const exam = PRESETS[preset];
  const startedAt = Date.now();
  let combos = 0;
  let emptyCombos = 0;

  console.log(`\n🚀 Пресет ${preset}: ${exam}, лимит ${perTopic} задач на связку «тема + линия»`);
  console.log(`   Тем в обходе: ${PRESET_TOPICS.length}`);

  const maxLine = MAX_LINE[exam] || 26;
  const lineMap = exam === 'OGE' ? OGE_TOPIC_LINES : TOPIC_LINES;

  for (let topicIndex = 0; topicIndex < PRESET_TOPICS.length; topicIndex++) {
    const topic = PRESET_TOPICS[topicIndex];
    state.topicArg = topic;
    const lines = (lineMap[topic] || []).filter(line => line <= maxLine);
    console.log(`\n━━━ [${topicIndex + 1}/${PRESET_TOPICS.length}] Тема: ${topic} | линий: ${lines.length} ━━━`);

    for (const line of lines) {
      let cats;
      try {
        cats = await resolveCategoriesForPresetLine(exam, topic, line);
      } catch (e) {
        console.warn(`  ⚠️  [Тема: ${topic} | Линия ${line}] пропуск: ${e.message}`);
        continue;
      }
      if (!cats.length) continue;

      combos++;
      const comboStart = state.imported;
      state.progress = { topic, line, target: perTopic, start: comboStart };
      console.log(`\n[Тема: ${topic} | Линия ${line}] Старт: ${cats.length} кат., цель ${perTopic}`);

      for (const cat of cats) {
        const remaining = perTopic - (state.imported - comboStart);
        if (remaining <= 0) break;
        console.log(`  📥 Категория ${cat.id}${cat.topicTitle ? ' | ' + cat.topicTitle : ''}`);
        try {
          const html = await fetchHtml(`${DOMAINS[exam]}/test?theme=${cat.id}&print=true`);
          const res = await processPageHtml(html, { line, category: cat }, state, remaining);
          if (res === 'empty') console.warn('  ⚠️  На странице не найдено задач');
        } catch (e) {
          console.error(`  ❌ Категория ${cat.id}: ${e.message}`);
          state.failed++;
        }
      }

      const done = state.imported - comboStart;
      if (done === 0) emptyCombos++;
      console.log(`[Тема: ${topic} | Линия ${line}] Скачано ${done}/${perTopic}${done < perTopic ? ' (новых задач больше нет)' : '...'}`);
      state.progress = null;
    }
  }

  const seconds = Math.round((Date.now() - startedAt) / 1000);
  console.log(`\n🏁 Пресет ${preset} завершён: связок ${combos}, без новых задач ${emptyCombos}, импортировано ${state.imported}, пропущено ${state.skipped}, ошибок ${state.failed}, ${seconds} с.`);
}

async function main() {
  const args = parseArgs();
  const preset = args.preset ? String(args.preset).toLowerCase() : null;
  if (preset && !PRESETS[preset]) {
    console.error(`❌ Неизвестный preset: ${preset}. Доступно: ${Object.keys(PRESETS).join(', ')}`);
    process.exit(1);
  }

  const examArg = preset ? PRESETS[preset] : String(args.exam || 'EGE').toUpperCase();
  const exams = examArg === 'ALL' ? ['EGE', 'OGE'] : [examArg];
  const exam = exams[0];
  const topicArg = args.topic || args.topics || null;
  const lineArg = args.line != null ? Number(args.line) : null;
  const perTopic = preset
    ? (args['per-topic'] != null ? Number(args['per-topic']) : 50)
    : null;
  const limit = preset
    ? null
    : (args.limit != null ? Number(args.limit) : null);
  const idsArg = args.ids ? String(args.ids).split(',').map(s => s.trim()).filter(Boolean) : null;
  const catArg = args.category != null ? Number(args.category) : null;
  const urlArg = args.url || null;
  const dryRun = !!(args['dry-run'] || args.dryRun);

  const buildMatrixMode = !!(args['build-matrix'] || args.buildMatrix || args.matrix);
  const indexMode = !!(args['index-catalog'] || args.indexCatalog);
  const backfillMode = !!(args['backfill-subtopics'] || args.backfillSubtopics);
  const coverageMode = !!(args['ensure-coverage'] || args.ensureCoverage || args.coverage);
  const ensureSubtopicsMode = !!(args['ensure-subtopics'] || args.ensureSubtopics);
  const reportMode = !!(args['coverage-report'] || args.coverageReport);
  const hasServiceMode = buildMatrixMode || indexMode || backfillMode || coverageMode || ensureSubtopicsMode || reportMode;
  const minPerLine = args['min-per-line'] != null ? Number(args['min-per-line']) : 25;
  const minPerSubtopic = args['min-per-subtopic'] != null ? Number(args['min-per-subtopic']) : 35;
  const linesFilter = args.lines
    ? String(args.lines).split(',').map(Number).filter(n => Number.isInteger(n) && n > 0)
    : null;

  if (preset && (!Number.isInteger(perTopic) || perTopic < 1)) {
    console.error('❌ --per-topic должен быть целым положительным числом, например --per-topic=50');
    process.exit(1);
  }
  if (!DOMAINS[exam]) {
    console.error(`❌ Неизвестный экзамен: ${examArg}. Используйте --exam=EGE, --exam=OGE или --exam=ALL`);
    process.exit(1);
  }
  if (hasServiceMode && (!Number.isInteger(minPerLine) || minPerLine < 1)) {
    console.error('❌ --min-per-line должен быть целым положительным числом, например --min-per-line=25');
    process.exit(1);
  }
  if (ensureSubtopicsMode && (!Number.isInteger(minPerSubtopic) || minPerSubtopic < 1)) {
    console.error('❌ --min-per-subtopic должен быть целым положительным числом, например --min-per-subtopic=35');
    process.exit(1);
  }
  if (!preset && !hasServiceMode && !idsArg && !catArg && !topicArg && !lineArg && !urlArg) {
    console.error('❌ Укажите один из аргументов: --preset, --ids, --topic, --category, --line, --url');
    console.error('   Служебные режимы: --build-matrix, --index-catalog, --backfill-subtopics,');
    console.error('   --ensure-coverage --min-per-line=25, --ensure-subtopics --min-per-subtopic=35, --coverage-report');
    console.error('   Пример: node bulk_import.js --preset=ege_full --per-topic=50');
    process.exit(1);
  }

  console.log('\n══════════════════════════════════════════════════');
  console.log(`  BULK IMPORT — ${examArg} | ${new Date().toLocaleString('ru-RU')}${preset ? ` | preset ${preset} (${perTopic}/тема-линия)` : ''}${dryRun ? ' | DRY RUN' : ''}`);
  console.log('══════════════════════════════════════════════════\n');

  ensureImagesDir();
  const db = readDB();
  const state = {
    exam, topicArg, lineArg, limit, dryRun, db,
    seen: new Set(db.filter(t => t.source_id).map(t => `${t.exam}:${t.source_id}`)),
    imported: 0, skipped: 0, failed: 0,
    pending: 0, dirty: false, progress: null, currentCategory: null,
    checkpointEvery: ensureSubtopicsMode ? 20 : CHECKPOINT_EVERY,
  };

  const onSigint = () => {
    console.warn('\n⏹️  Получен SIGINT, сохраняю базу...');
    checkpoint(state, true);
    saveCatalogDoc();
    process.exit(130);
  };
  process.once('SIGINT', onSigint);

  try {
    if (hasServiceMode) {
      if (buildMatrixMode) await buildMatrixFile(exams);
      if (indexMode) {
        for (const ex of exams) await indexCatalog(ex);
      }
      if (backfillMode) await backfillAll(state.db, exams);
      if (coverageMode) {
        for (const ex of exams) {
          state.exam = ex;
          await runCoverage(state, ex, minPerLine, linesFilter);
        }
        // после докачки размечаем подтемы у всех новых задач
        await backfillAll(state.db, exams);
      }
      if (ensureSubtopicsMode) {
        for (const ex of exams) {
          state.exam = ex;
          await runEnsureSubtopics(state, ex, minPerSubtopic, linesFilter);
        }
        await backfillAll(state.db, exams);
      }
      if (reportMode || coverageMode || backfillMode || ensureSubtopicsMode) buildCoverageReport(state.db);
      checkpoint(state, true);
      saveCatalogDoc();
    } else if (preset) {
      await runPreset(state, preset, perTopic);
    } else if (idsArg && idsArg.length) {
      console.log(`📋 Режим --ids: ${idsArg.length}`);
      for (const id of idsArg) {
        if (limit && state.imported >= limit) break;
        if (state.seen.has(`${state.exam}:${id}`)) {
          console.log(`⏭️  Пропуск [${id}] — уже в базе.`);
          state.skipped++;
          continue;
        }
        try {
          await fetchIndividualTask(id, state);
        } catch (e) {
          console.error(`  ❌ Задача ${id}: ${e.message}`);
          state.failed++;
        }
      }
    } else if (urlArg) {
      const idMatch = urlArg.match(/[?&]id=(\d+)/);
      const catMatch = urlArg.match(/[?&](?:theme|category_id)=(\d+)/);
      if (idMatch) {
        console.log(`🔗 URL задачи: ${idMatch[1]}`);
        await fetchIndividualTask(idMatch[1], state);
      } else if (catMatch) {
        const categories = await resolveCategoryArg(exam, Number(catMatch[1]), lineArg);
        for (const cat of categories) {
          if (limit && state.imported >= limit) break;
          console.log(`📚 Категория ${cat.id}${cat.groupTitle ? ' | ' + cat.groupTitle : ''}`);
          const html = await fetchHtml(`${DOMAINS[exam]}/test?theme=${cat.id}&print=true`);
          const res = await processPageHtml(html, { line: lineArg || cat.line, category: cat }, state);
          if (res === 'empty') console.warn('  ⚠️  На странице не найдено задач');
        }
      } else {
        console.log(`🔗 URL: ${urlArg}`);
        const html = await fetchHtml(urlArg);
        const $ = cheerio.load(html);
        if ($('.prob_maindiv').length) {
          const res = await processPageHtml(html, { line: lineArg }, state);
          if (res === 'empty') console.warn('  ⚠️  Задачи не найдены');
        } else {
          const ids = extractProblemIds($);
          console.log(`   Найдено ссылок на задачи: ${ids.length}`);
          for (const id of ids) {
            if (limit && state.imported >= limit) break;
            if (state.seen.has(`${state.exam}:${id}`)) { state.skipped++; continue; }
            try { await fetchIndividualTask(id, state); }
            catch (e) { console.error(`  ❌ Задача ${id}: ${e.message}`); state.failed++; }
          }
        }
      }
    } else {
      let categories;
      if (catArg != null) {
        if (topicArg) {
          const pattern = TOPIC_PATTERNS[topicArg];
          if (pattern) {
            // topic используется только для разметки; категория задана явно
          }
        }
        categories = await resolveCategoryArg(exam, catArg, lineArg);
        console.log(`📚 Категория ${catArg}`);
      } else if (lineArg != null) {
        categories = await resolveCategoriesForLine(exam, lineArg, topicArg);
        console.log(`📚 Линия ${lineArg}${topicArg ? ' | topic ' + topicArg : ''}: категорий ${categories.length}`);
      } else {
        categories = await resolveCategoriesForTopic(exam, topicArg);
        console.log(`📚 Topic ${topicArg}: категорий ${categories.length}`);
      }
      for (const cat of categories) {
        if (limit && state.imported >= limit) break;
        console.log(`\n📥 Категория ${cat.id}${cat.topicTitle ? ' | ' + cat.topicTitle : ''}${cat.line ? ' | линия ' + cat.line : ''}`);
        const html = await fetchHtml(`${DOMAINS[exam]}/test?theme=${cat.id}&print=true`);
        const res = await processPageHtml(html, { line: lineArg || cat.line, category: cat }, state);
        if (res === 'empty') console.warn('  ⚠️  На странице не найдено задач');
      }
    }
  } catch (e) {
    console.error(`\n💥 Ошибка: ${e.message}`);
    if (process.env.DEBUG) console.error(e.stack);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', onSigint);
    checkpoint(state, true);
  }

  console.log('\n══════════════════════════════════════════════════');
  console.log(`✨ Готово! Импортировано: ${state.imported} | Пропущено: ${state.skipped} | Ошибок: ${state.failed}`);
  console.log('══════════════════════════════════════════════════\n');
}

if (require.main === module) {
  main().catch(e => {
    console.error(`\n💥 Фатальная ошибка: ${e.message}`);
    if (process.env.DEBUG) console.error(e.stack);
    process.exit(1);
  });
}

module.exports = {
  altToLatex,
  spokenToLatex,
  cleanLatex,
  convertHtmlToLatex,
  parseArgs,
  lineToTopics,
  egeLineToMeta,
  ogeLineToMeta,
  generateId,
  parseTaskContent,
  extractTaskHeader,
  fetchCatalog,
  groupNumber,
  resolveCategoriesForTopic,
  resolveCategoriesForLine,
  PRESET_TOPICS,
  PRESETS,
  TOPIC_LINES,
  OGE_TOPIC_LINES,
  MAX_LINE,
  groupCategoriesByLine,
  resolveCategoriesForTopicLine,
  resolveCategoriesForPresetLine,
  runPreset,
  // матрица КИМ, кэш каталога и покрытие линий
  EGE_LINE_SPECS,
  OGE_LINE_SPECS,
  OGE_CATALOG_LINES,
  SECTION_TITLES,
  lineSpec,
  lineToMeta,
  resolveCategoriesForExamLine,
  examLineForCatalogCategory,
  buildMatrixFile,
  indexCatalog,
  backfillSubtopics,
  runCoverage,
  runEnsureSubtopics,
  buildCoverageReport,
  catalogDoc,
  saveCatalogDoc,
  lookupProblem,
};




