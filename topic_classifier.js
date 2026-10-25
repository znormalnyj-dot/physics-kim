'use strict';

// Узкие темы, которые используются в конструкторе вариантов.
const NARROW_TOPIC_KEYS = [
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

const PARENT_ORDER = ['mechanics', 'mkt_thermo', 'electrodynamics', 'quantum', 'methods'];

// Линии, в которых ищем узкие тепловые темы по тексту.
const THERMAL_LINES = {
  EGE: [7, 8, 9, 10, 21, 22, 23, 24],
  OGE: [1, 2, 3, 4, 7, 11, 13, 14, 16, 18, 19, 20, 21, 22],
};

// Линии, в которых ищем электромагнитные колебания/волны по тексту.
const EM_LINES = {
  EGE: [11, 12, 13, 14, 15, 21, 23, 25],
  OGE: [1, 2, 3, 4, 8, 9, 12, 13, 14, 18, 19, 20],
};

const MKT_RE = /(?:^|[^а-яё])(?:диффуз|броунов|молекул|атом|кристаллич|агрегатн|смачиван|капилляр)/i;
const VAPORS_RE = /(?:^|[^а-яё])(?:плавлен|кристаллизац|кипен|парообразов|конденсац|влажност|пар(?:а|у|ы|ом|е|ов|ам|ами|ах)?(?![а-яё])|рос(?:а|у|ы|ом|е|ов|ам|ами|ах)?(?![а-яё])|отвердеван|испарен)/i;
const EM_RE = /(?:электромагнитн[а-яё]*\s+волн|радиоволн|длин[а-яё]*\s+волн|частот[а-яё]*\s+колебан|период[а-яё]*\s+колебан|шкал[а-яё]*\s+электромагнит|инфракрасн|ультрафиолет|рентгенов)/i;

function normalizeForMatch(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\u00ad/g, '')
    .replace(/\s+/g, ' ');
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function lineNumber(exam, line) {
  const n = Number(line);
  if (!Number.isInteger(n)) return null;
  if (exam === 'EGE' && n >= 1 && n <= 26) return n;
  if (exam === 'OGE' && n >= 1 && n <= 22) return n;
  return null;
}

function lineDef(matrix, exam, line) {
  const n = lineNumber(exam, line);
  if (!n || !matrix || !matrix.exams || !matrix.exams[exam]) return null;
  return (matrix.exams[exam].lines || []).find((item) => Number(item.line) === n) || null;
}

function subtopicDef(matrix, exam, line, subtopicId) {
  const def = lineDef(matrix, exam, line);
  if (!def || !subtopicId) return null;
  return (def.subtopics || []).find((sub) => String(sub.id) === String(subtopicId)) || null;
}

function contentTopicKeys(exam, line, text) {
  const n = lineNumber(exam, line);
  if (!n) return [];
  const normalized = normalizeForMatch(text);
  const keys = [];
  if ((THERMAL_LINES[exam] || []).includes(n)) {
    if (MKT_RE.test(normalized)) keys.push('mkt');
    if (VAPORS_RE.test(normalized)) keys.push('vapors');
  }
  if ((EM_LINES[exam] || []).includes(n)) {
    if (EM_RE.test(normalized)) keys.push('em_oscillations');
  }
  return keys;
}

/**
 * Собирает корректный список topics для задачи:
 * раздел(ы) + узкие ключи подтемы + ключи, найденные по тексту.
 */
function buildTopicList(options) {
  const {
    exam,
    line,
    subtopicId,
    matrix,
    text = '',
    existingTopics = [],
    extraKeys = [],
    validKeys = null,
  } = options || {};

  const lineInfo = lineDef(matrix, exam, line);
  const subInfo = subtopicDef(matrix, exam, line, subtopicId);
  const valid = validKeys ? new Set([...validKeys].map(String)) : null;

  const narrow = [];
  const subKeys = subInfo && Array.isArray(subInfo.topic_keys) ? subInfo.topic_keys : [];
  const lineKeys = lineInfo && Array.isArray(lineInfo.topic_keys) ? lineInfo.topic_keys : [];

  narrow.push(...(subKeys.length ? subKeys : lineKeys));
  // Старые теги используем только как резерв, когда матрица ничего не дала.
  // Иначе повторная классификация закрепляла бы ошибочные теги.
  if (subKeys.length === 0 && lineKeys.length === 0) {
    for (const key of existingTopics) {
      if (NARROW_TOPIC_KEYS.includes(String(key))) narrow.push(String(key));
    }
  }
  narrow.push(...contentTopicKeys(exam, line, text));
  narrow.push(...extraKeys);

  const filteredNarrow = unique(narrow.filter((key) => NARROW_TOPIC_KEYS.includes(key) && (!valid || valid.has(key))));
  const parents = unique(filteredNarrow.map((key) => PARENT_OF[key]).filter(Boolean));
  const orderedParents = PARENT_ORDER.filter((key) => parents.includes(key));

  // Гарантируем хотя бы одну узкую тему, чтобы задача не выпадала из чипов.
  if (filteredNarrow.length === 0) {
    const fallback = lineKeys.find((key) => NARROW_TOPIC_KEYS.includes(key)) ||
      (exam === 'OGE' ? 'measurements' : 'kinematics');
    filteredNarrow.push(fallback);
    const parent = PARENT_OF[fallback];
    if (parent && !orderedParents.includes(parent)) orderedParents.push(parent);
  }

  return [...orderedParents, ...unique(filteredNarrow)];
}

module.exports = {
  NARROW_TOPIC_KEYS,
  PARENT_OF,
  PARENT_ORDER,
  THERMAL_LINES,
  EM_LINES,
  normalizeForMatch,
  contentTopicKeys,
  lineNumber,
  lineDef,
  subtopicDef,
  buildTopicList,
};
