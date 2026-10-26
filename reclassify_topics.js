#!/usr/bin/env node
'use strict';

/**
 * Глубокая переклассификация задач.
 *
 * Правило: у каждой задачи ровно один узкий тег (плюс один тег раздела).
 * Широкий раздел определяется по тексту условия/решения, узкая тема — по
 * физическому смыслу. Для задач, у которых в старой базе стояла чужая
 * механическая линия, линия и подтема исправляются по матрице КИМ.
 *
 * Запуск:
 *   node reclassify_topics.js            # только отчёт, db.json не меняется
 *   node reclassify_topics.js --write    # записать db.json и отчёт
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const TASKS_DIR = path.join(ROOT, 'tasks');
const DB_PATH = path.join(TASKS_DIR, 'db.json');
const MATRIX_PATH = path.join(TASKS_DIR, 'kim_matrix.json');
const CACHE_PATH = path.join(TASKS_DIR, 'catalog_cache.json');
const TOPICS_PATH = path.join(TASKS_DIR, 'topics.json');
const REPORT_PATH = path.join(TASKS_DIR, 'topic_cleanup_report.json');
const BACKUP_PATH = path.join(TASKS_DIR, 'db.backup-before-topic-cleanup.json');

const WRITE = process.argv.includes('--write');

const NARROW_KEYS = [
  'kinematics', 'dynamics', 'statics', 'conservation_laws', 'oscillations',
  'mkt', 'thermodynamics', 'vapors',
  'electrostatics', 'direct_current', 'magnetism', 'em_oscillations', 'optics',
  'quantum_physics', 'nuclear', 'measurements',
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

const NARROW_TITLES = {
  kinematics: 'Кинематика',
  dynamics: 'Динамика',
  statics: 'Статика и гидростатика',
  conservation_laws: 'Законы сохранения в механике',
  oscillations: 'Механические колебания и волны',
  mkt: 'Молекулярная физика и идеальный газ',
  thermodynamics: 'Термодинамика и тепловые явления',
  vapors: 'Влажность и фазовые переходы',
  electrostatics: 'Электростатика и конденсаторы',
  direct_current: 'Законы постоянного тока',
  magnetism: 'Магнитное поле и электромагнитная индукция',
  em_oscillations: 'Электромагнитные колебания и волны',
  optics: 'Геометрическая и волновая оптика',
  quantum_physics: 'Квантовая физика и фотоэффект',
  nuclear: 'Физика атома и атомного ядра',
  measurements: 'Погрешности и планирование эксперимента',
};

const PREFIX_INFO = {
  KIN: { broad: 'mechanics', narrow: 'kinematics' },
  DYN: { broad: 'mechanics', narrow: 'dynamics' },
  STA: { broad: 'mechanics', narrow: 'statics' },
  CON: { broad: 'mechanics', narrow: 'conservation_laws' },
  OSC: { broad: 'mechanics', narrow: 'oscillations' },
  MCH: { broad: 'mechanics', narrow: null },
  MECH: { broad: 'mechanics', narrow: null },
  MKT: { broad: 'mkt_thermo', narrow: 'mkt' },
  THR: { broad: 'mkt_thermo', narrow: 'thermodynamics' },
  VAP: { broad: 'mkt_thermo', narrow: 'vapors' },
  ELC: { broad: 'electrodynamics', narrow: null },
  ELD: { broad: 'electrodynamics', narrow: null },
  CUR: { broad: 'electrodynamics', narrow: 'direct_current' },
  MAG: { broad: 'electrodynamics', narrow: 'magnetism' },
  EMO: { broad: 'electrodynamics', narrow: 'em_oscillations' },
  OPT: { broad: 'electrodynamics', narrow: 'optics' },
  QUA: { broad: 'quantum', narrow: 'quantum_physics' },
  NUC: { broad: 'quantum', narrow: 'nuclear' },
  MSR: { broad: 'methods', narrow: 'measurements' },
  '2027': { broad: null, narrow: null },
};

function normalize(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\u00ad/g, '')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ');
}

function countMatches(re, text) {
  const m = text.match(re);
  return m ? m.length : 0;
}

function taskText(task) {
  // Важно: старые subtopic_title/answer не участвуют в классификации.
  // Именно они раньше «протаскивали» чужие теги (например, «координаты»
  // в задаче про спектры) и портили широкий раздел.
  return normalize([
    task.latex_condition,
    task.latex_solution,
  ].filter(Boolean).join('\n'));
}

function prefixInfo(task) {
  const parts = String(task.id || '').split('-');
  return PREFIX_INFO[parts[1]] || { broad: null, narrow: null };
}

// ── Маркеры широких разделов ────────────────────────────────────────────────

const QUANTUM_RE = /фотоэффект|фотон|работ[а-я]*\s+выход|красн[а-я]*\s+границ|радиоактивн|полураспад|ядерн[а-я]*\s+реакц|изотоп|нуклон|нейтрон|альфа-?частиц|бета-?распад|постулат[а-я]*\s+бора|уровн[а-я]*\s+энерги|атомн[а-я]*\s+ядр|периодическ[а-я]*\s+систем|спектр[а-я]*\s+(?:излучен|поглощен|испускан)|линейчат[а-я]*\s+спектр|спектральн[а-я]*\s+(?:лини|анализ)/;

// Намеренно не используем одиночные «поток» и «сопротивление»:
// «сопротивление воздуха» — механика, «поток воды» — тоже.
// Также не используем голое «ток», чтобы не поймать «поток».
const EM_RE = /конденсатор|катушк|индуктивност|колебательн[а-я]*\s+контур|вольтметр|амперметр|резистор|электрическ[а-я]*\s+сопротивлен|сопротивлен[а-я]*\s+(?:цеп|тока|провод|резистор)|сил[а-я]*\s+(?:[а-я]+\s+){0,3}тока|электрическ[а-я]*\s+ток|(?:^|[^а-я])ток[а-я]*\s+(?:в|через|на|равен|идет|протекает)|напряжени|электростатич|магнит|заряд|электрическ[а-я]*\s+(?:пол|цеп|ток|сеть|напряжени|заряд)|линз|преломлен|оптич|дифракц|интерференц|световод|электромагнитн|свет|тень|зеркал|стекл|цвет|фильтр|компас|проволок|лампа|ламп[а-я]*|реостат|батаре|аккумулятор|закон[а-я]*\s+кулона|сил[а-я]*\s+кулона|ампер|вольт/;

const THERMO_RE = /идеальн[а-я]*\s+газ|молярн|изотерм|изобар|изохор|адиабат|термодинамик|теплообмен|количеств[а-я]*\s+теплот|удельн[а-я]*\s+теплоемк|плавлен|кипен|парообразов|влажност|водян[а-я]*\s+пар|кпд[а-я]*\s+теплов|цикл[а-я]*\s+карно|внутренн[а-я]*\s+энерги[а-я]*\s+газ|давлени[а-я]*\s+газ|концентрац[а-я]*\s+молекул|теплов[а-я]*\s+машин|нагревател|холодильник|теплоемк|теплот[а-я]*\s+плавлен|теплот[а-я]*\s+парообразов|молекул[а-я]*\s+газ|диффуз|броунов|теплопроводност|конвекц|теплов[а-я]*\s+движени|средн[а-я]*\s+кинетическ[а-я]*\s+энерг[а-я]*\s+молекул|уравнени[а-я]*\s+состояни[а-я]*\s+газ|газ[а-я]*\s+(?:в\s+закрыт|в\s+сосуде|под\s+поршнем|находится)/;

// «Количество теплоты» встречается и в механике (работа силы трения,
// неупругий удар). Если префикс/текст явно механические, а других тепловых
// маркеров нет, оставляем задачу в механике.
const THERMO_CORE_RE = /идеальн[а-я]*\s+газ|молярн|изотерм|изобар|изохор|адиабат|термодинамик|теплообмен|удельн[а-я]*\s+теплоемк|плавлен|кипен|парообразов|влажност|водян[а-я]*\s+пар|кпд[а-я]*\s+теплов|цикл[а-я]*\s+карно|внутренн[а-я]*\s+энерги[а-я]*\s+газ|давлени[а-я]*\s+газ|концентрац[а-я]*\s+молекул|теплов[а-я]*\s+машин|нагревател|холодильник|калориметр|теплопроводност|конвекц|диффуз|броунов|молекул[а-я]*\s+газ|газ[а-я]*\s+(?:в\s+закрыт|в\s+сосуде|под\s+поршнем|находится)/;

const MECHANICS_RE = /маятник|колебан|импульс|сохранени[а-я]*\s+(?:энерг|импульс)|кинетическ[а-я]*\s+энерг|потенциальн[а-я]*\s+энерг|механическ[а-я]*\s+(?:энерг|работ)|архимед|плава|погружен|выталкивающ|гидростатич|момент[а-я]*\s+сил|рычаг|правил[а-я]*\s+момент|равновеси|сил[а-я]*\s+трени|коэффициент[а-я]*\s+трени|сил[а-я]*\s+тяжест|сил[а-я]*\s+упругост|жесткост[а-я]*\s+пружин|закон[а-я]*\s+ньютон|сил[а-я]*\s+натяжен|сил[а-я]*\s+реакци[а-я]*\s+опор|вес[а-я]*\s+тел|всемирн[а-я]*\s+тяготен|перв[а-я]*\s+космическ|инерциальн[а-я]*\s+систем|динамометр|равнодействующ|невесомост|перегрузк|скорост|ускорени|координат|перемещен|равномерн|равноускорен|свободн[а-я]*\s+паден|брос[а-я]*|движени[а-я]*\s+по\s+окружност|углов[а-я]*\s+скорост|центростремительн|звук|длин[а-я]*\s+волн|тележк|трос|блок|уравновеш|поршень/;

// Слова, которых не должно быть у чистой кинематики.
const KIN_FORBIDDEN_RE = /конденсатор|катушк|магнит|амперметр|вольтметр|газ|теплот|архимед|импульс|трени|ньютон/;

// Сильные механические маркеры: позволяют тексту перебить ошибочный
// «неродной» префикс ID (например, QUA/EMO/THR у старой задачи).
const STRONG_MECHANICS_RE = /маятник|колебан|импульс|сохранени[а-я]*\s+(?:энерг|импульс)|кинетическ[а-я]*\s+энерг|потенциальн[а-я]*\s+энерг|механическ[а-я]*\s+(?:энерг|работ)|архимед|плава|погруж|выталкивающ|гидростатич|момент[а-я]*\s+сил|рычаг|правил[а-я]*\s+момент|равновеси|уравновеш|сил[а-я]*\s+(?:трени|тяжест|упругост|натяжен|реакци[а-я]*\s+опор|сопротивлен|архимеда)|коэффициент[а-я]*\s+трени|жесткост[а-я]*\s+пружин|закон[а-я]*\s+ньютон|вес[а-я]*\s+тел|всемирн[а-я]*\s+тяготен|перв[а-я]*\s+космическ|инерциальн[а-я]*\s+систем|динамометр|равнодействующ|невесомост|перегрузк|центростремительн|брос[а-я]*|свободн[а-я]*\s+паден|равноускорен|равномерн|тормозн|движени[а-я]*\s+по\s+окружност|углов[а-я]*\s+скорост|тележк|трос|рычажн|блок|поршень|звук/;

function broadCategory(task, text, prefix) {
  const q = QUANTUM_RE.test(text);
  const em = EM_RE.test(text);
  const th = THERMO_RE.test(text);
  const mech = MECHANICS_RE.test(text);
  const strongMech = STRONG_MECHANICS_RE.test(text);

  // Квантовые и ядерные маркеры самые специфичные.
  if (q) return 'quantum';

  if (em && th) {
    if (prefix.broad === 'mkt_thermo') return 'mkt_thermo';
    if (prefix.broad === 'electrodynamics') return 'electrodynamics';
    // Тепловые задачи часто упоминают «заряд»/«напряжение» лишь косвенно.
    return countMatches(THERMO_RE, text) > countMatches(EM_RE, text)
      ? 'mkt_thermo'
      : 'electrodynamics';
  }
  if (em) return 'electrodynamics';
  if (th) {
    if (prefix.broad === 'mechanics' && strongMech && !THERMO_CORE_RE.test(text)) {
      return 'mechanics';
    }
    return 'mkt_thermo';
  }

  // Если префикс ID говорит «не механика», не позволяем случайному слову
  // «скорость»/«координата» перетащить задачу в механику. Для этого нужен
  // сильный механический маркер.
  if (prefix.broad && prefix.broad !== 'mechanics') {
    return strongMech ? 'mechanics' : prefix.broad;
  }

  if (prefix.broad === 'methods') return 'methods';
  if (mech || prefix.broad === 'mechanics') return 'mechanics';
  if (prefix.broad) return prefix.broad;

  return strongMech ? 'mechanics' : 'methods';
}

// ── Узкие темы ──────────────────────────────────────────────────────────────

const OSC_RE = /маятник|колебан|резонанс|длин[а-я]*\s+волн|звук|волн[а-я]*|гармонич|амплитуд|период[а-я]*\s+колебан|частот[а-я]*\s+колебан/;
const STATICS_RE = /архимед|плава|погруж|выталкивающ|гидростатич|сообщающ[а-я]*\s+сосуд|момент[а-я]*\s+сил|рычаг|правил[а-я]*\s+момент|равновеси|уравновеш|стержн|блок|давлени[а-я]*\s+жидкост|давлени[а-я]*\s+вод|давлени[а-я]*\s+(?:ног|стоп|опор|поверхност)|центр[а-я]*\s+тяжест|плотност[а-я]*\s+жидкост|осадк|гальк|опущен[а-я]*\s+(?:в|на)\s+(?:воду|керосин|жидкост|сосуд)|полость|коромысл|рычажн|поток[а-я]*\s+(?:воздух|жидкост|газ)|продува|между\s+.*лист|жидкост[а-я]*\s+(?:течет|течени)|труб[а-я]*\s+.*(?:жидкост|давлен)|барометр|анероид|атмосферн[а-я]*\s+давлен|боков[а-я]*\s+стенк|отверсти[а-я]*\s+в\s+стенк|вытека[а-я]*\s+вод|пузырьк|налита[а-я]*\s+вод|уровень\s+вод|закон[а-я]*\s+паскал|давлени[а-я]*\s+(?:в\s+)?жидкост/;
const CONSERVATION_RE = /импульс|сохранени[а-я]*\s+(?:энерг|импульс)|кинетическ[а-я]*\s+энерг|потенциальн[а-я]*\s+энерг|механическ[а-я]*\s+(?:энерг|работ)|механическ[а-я]*\s+мощност|абсолютн[а-я]*\s+неупруг|абсолютн[а-я]*\s+упруг|столкновен|соударен|разрыв|разорвал|взрыв|работ[а-я]*\s+сил[а-я]*|удар|застрева|осколк|откат|сталкива|тележк|реактивн[а-я]*\s+(?:двигател|сил)|ракетн[а-я]*\s+двигател|сопло|выхлопн[а-я]*\s+газ|по\s+инерции|конькобеж|пистолет|выстрел/;
const DYNAMICS_RE = /сил[а-я]*\s+трени|коэффициент[а-я]*\s+трени|сил[а-я]*\s+тяжест|сил[а-я]*\s+упругост|жесткост[а-я]*\s+пружин|закон[а-я]*\s+ньютон|сил[а-я]*\s+натяжен|сил[а-я]*\s+реакци[а-я]*\s+опор|сил[а-я]*\s+сопротивлен[а-я]*\s+(?:доск|движени|среды|пул|снаряд|качен)|определ[а-я]*\s+сил[а-я]*\s+сопротивлен|вес[а-я]*\s+тел|всемирн[а-я]*\s+тяготен|перв[а-я]*\s+космическ|инерциальн[а-я]*\s+систем|инерци[а-я]*|динамометр|равнодействующ|невесомост|перегрузк|второй[а-я]*\s+закон|ускорени[а-я]*\s+под\s+действием|под\s+действием\s+сил|коэффициент[а-я]*\s+жесткост|трос|проекци[а-я]*\s+.*сил|действующ[а-я]*\s+сил|поднимают[а-я]*\s+.*ускорен|подвешен[а-я]*\s+.*(?:ускорен|поднима|опуска)/;
const KINEMATICS_RE = /путь|перемещен|координат|скорост|ускорени|график[а-я]*\s+(?:зависимост[а-я]*\s+)?(?:x|v|a|скорост|координат|ускорен)|равномерн|равноускорен|свободн[а-я]*\s+паден|брос[а-я]*|движени[а-я]*\s+по\s+окружност|углов[а-я]*\s+скорост|центростремительн|период[а-я]*\s+обращен|частот[а-я]*\s+обращен|относительн[а-я]*\s+движен|встречн[а-я]*\s+движен|тормозн[а-я]*\s+путь/;

const OPTICS_RE = /линз|зеркал|преломлен|оптич|дифракц|интерференц|световод|фокус|изображени[а-я]*\s+(?:предмет|линз|зеркал)|тень|спектр|дисперс|поляризац|свет|стекл|цвет|фильтр|чернил/;
const EM_OSC_RE = /колебательн[а-я]*\s+контур|контур[а-я]*\s+колебан|катушк[а-я]*.{0,80}конденсатор|конденсатор[а-я]*.{0,80}катушк|электромагнитн[а-я]*\s+(?:волн|излучен|колебан)|радиоволн|инфракрасн|ультрафиолетов|рентгеновск|частот[а-я]*\s+колебан|период[а-я]*\s+колебан|переменн[а-я]*\s+ток/;
const MAGNETISM_RE = /магнит|компас|намагнич|правил[а-я]*\s+ленца|эдс|самоиндукц|индуктивност|соленоид|электромагнит|трансформатор|сил[а-я]*\s+ампера|сил[а-я]*\s+лоренца/;
const CURRENT_RE = /сил[а-я]*\s+тока|сопротивлен|резистор|амперметр|вольтметр|электрическ[а-я]*\s+цеп|закон[а-я]*\s+ома|последовательн[а-я]*\s+соединен|параллельн[а-я]*\s+соединен|мощност[а-я]*\s+тока|работа[а-я]*\s+тока|закон[а-я]*\s+джоул|ламп|источник[а-я]*\s+тока|батаре|ключ|реостат|напряжени|проволок|электрическ[а-я]*\s+сеть|(?:^|[^а-я])ток[а-я]*/;
const ELECTROSTATICS_RE = /заряд|закон[а-я]*\s+кулона|сил[а-я]*\s+кулона|электрическ[а-я]*\s+пол|напряженност|потенциал|конденсатор|электростатич|диэлектрик|электрометр|заряженн/;

const VAPORS_RE = /влажност|водян[а-я]*\s+пар|пар[а-я]*\s+(?:насыщен|водян)|парообразов|кипен|плавлен|кристаллизац|конденсац|испарен|теплот[а-я]*\s+плавлен|теплот[а-я]*\s+парообразов|отвердеван/;
const MKT_RE = /идеальн[а-я]*\s+газ|молекул|молярн|изотерм|изобар|изохор|адиабат|уравнени[а-я]*\s+клапейрон|менделеев|концентрац[а-я]*\s+молекул|средн[а-я]*\s+кинетическ[а-я]*\s+энерг|броунов|диффуз|давлени[а-я]*\s+газ|газ[а-я]*\s+(?:давлен|объем|температур|в\s+закрыт|в\s+сосуде)|охлаждени[а-я]*\s+газ|нагревани[а-я]*\s+газ|теплов[а-я]*\s+движени/;
const THERMODYNAMICS_RE = /термодинамик|теплообмен|количеств[а-я]*\s+теплот|внутренн[а-я]*\s+энерг|работ[а-я]*\s+газ|кпд|теплов[а-я]*\s+машин|цикл|нагревател|холодильник|теплоемк|адиабат|первое[а-я]*\s+начало|теплов[а-я]*\s+равновеси|теплопроводност|конвекц/;

const NUCLEAR_RE = /радиоактивн|полураспад|ядерн[а-я]*\s+реакц|изотоп|нуклон|протон|нейтрон|альфа|бета|ядр|периодическ[а-я]*\s+систем|химическ[а-я]*\s+элемент/;
const QUANTUM_RE_NARROW = /фотоэффект|фотон|работ[а-я]*\s+выход|красн[а-я]*\s+границ|уровн[а-я]*\s+энерги|постулат[а-я]*\s+бора|спектр|квант|атом/;

function chooseByScore(scores, order) {
  let best = null;
  let bestScore = 0;
  for (const key of order) {
    const score = scores[key] || 0;
    if (score > bestScore) {
      best = key;
      bestScore = score;
    }
  }
  return best;
}

function narrowMechanics(text, prefix, existing, lineInfo) {
  const conditionText = normalize(lineInfo && lineInfo.conditionText);
  // Условие важнее решения: если по условию это чистая кинематика,
  // решение не должно перетаскивать задачу в законы сохранения только
  // потому, что там упомянута энергия.
  if (conditionText && !KIN_FORBIDDEN_RE.test(text)) {
    const condKinematics = countMatches(KINEMATICS_RE, conditionText);
    const condOther = countMatches(OSC_RE, conditionText) +
      countMatches(STATICS_RE, conditionText) +
      countMatches(CONSERVATION_RE, conditionText) +
      countMatches(DYNAMICS_RE, conditionText);
    // Чистая кинематика по условию: бросок/траектория/дальность.
    // Решение может дополнительно использовать энергию, но сюжет задачи
    // остаётся кинематическим.
    const projectilePlot = /кида[а-я]*|брос[а-я]*|переброс|перелет|траектор|дальност|под\s+углом|горизонт/.test(conditionText);
    if (condKinematics > 0 && condOther === 0 &&
        (prefix.narrow === 'kinematics' || projectilePlot)) {
      return 'kinematics';
    }
  }

  // Явные физические сюжеты весят больше, чем префикс ID: старый префикс
  // KIN часто стоит у задач на силы, Архимеда, импульс и энергию.
  const scores = {
    oscillations: countMatches(OSC_RE, text) * 2,
    statics: countMatches(STATICS_RE, text) * 2,
    conservation_laws: countMatches(CONSERVATION_RE, text) * 2,
    dynamics: countMatches(DYNAMICS_RE, text) * 2,
    kinematics: countMatches(KINEMATICS_RE, text),
  };
  if (prefix.narrow && scores[prefix.narrow] !== undefined) scores[prefix.narrow] += 0.5;

  // Явные приоритеты: энергия/импульс важнее общего слова «скорость»,
  // статика и колебания — важнее общих «сил».
  const primary = chooseByScore(scores, [
    'oscillations', 'statics', 'conservation_laws', 'dynamics', 'kinematics',
  ]);
  if (primary) return primary;

  if (prefix.narrow) return prefix.narrow;
  if (existing.length === 1) return existing[0];

  const title = normalize(lineInfo && lineInfo.title);
  if (/кинематик|координат|скорост|движен/.test(title)) return 'kinematics';
  if (/динамик|сил/.test(title)) return 'dynamics';
  if (/сохранен|энерг|импульс/.test(title)) return 'conservation_laws';
  if (/статик|гидростат|колебан|волн/.test(title)) return 'statics';
  return 'kinematics';
}

function narrowThermo(text, prefix, existing) {
  const scores = {
    vapors: countMatches(VAPORS_RE, text) * 2,
    mkt: countMatches(MKT_RE, text) * 2,
    thermodynamics: countMatches(THERMODYNAMICS_RE, text) * 2,
  };
  if (prefix.narrow && scores[prefix.narrow] !== undefined) scores[prefix.narrow] += 0.5;
  const primary = chooseByScore(scores, ['vapors', 'mkt', 'thermodynamics']);
  if (primary) return primary;
  if (prefix.narrow) return prefix.narrow;
  if (existing.length === 1) return existing[0];
  return 'thermodynamics';
}

function narrowElectrodynamics(text, prefix, existing) {
  // Сначала — однозначные физические сюжеты.
  if (EM_OSC_RE.test(text)) return 'em_oscillations';
  if (OPTICS_RE.test(text)) return 'optics';

  const scores = {
    magnetism: countMatches(MAGNETISM_RE, text) * 2,
    direct_current: countMatches(CURRENT_RE, text) * 2,
    electrostatics: countMatches(ELECTROSTATICS_RE, text) * 2,
    em_oscillations: countMatches(EM_OSC_RE, text) * 2,
    optics: countMatches(OPTICS_RE, text) * 2,
  };
  if (prefix.narrow && scores[prefix.narrow] !== undefined) scores[prefix.narrow] += 0.5;

  const primary = chooseByScore(scores, [
    'em_oscillations', 'magnetism', 'direct_current', 'electrostatics', 'optics',
  ]);
  if (primary) return primary;
  if (prefix.narrow) return prefix.narrow;
  if (existing.length === 1) return existing[0];
  return 'electrostatics';
}

function narrowQuantum(text, prefix, existing) {
  if (NUCLEAR_RE.test(text)) return 'nuclear';
  if (QUANTUM_RE_NARROW.test(text)) return 'quantum_physics';
  if (prefix.narrow) return prefix.narrow;
  if (existing.length === 1) return existing[0];
  return 'quantum_physics';
}

function chooseNarrow(task, broad, prefix, text, existing, lineInfo) {
  if (broad === 'mechanics') return narrowMechanics(text, prefix, existing, lineInfo);
  if (broad === 'mkt_thermo') return narrowThermo(text, prefix, existing);
  if (broad === 'electrodynamics') return narrowElectrodynamics(text, prefix, existing);
  if (broad === 'quantum') return narrowQuantum(text, prefix, existing);
  return 'measurements';
}

// ── Линии и подтемы ────────────────────────────────────────────────────────

const EGE_VALID_LINES = {
  mechanics: [1, 2, 3, 4, 5, 6, 21, 22, 26],
  mkt_thermo: [7, 8, 9, 10, 21, 22, 23, 24],
  electrodynamics: [11, 12, 13, 14, 15, 21, 23, 25],
  quantum: [16, 17],
  methods: [18, 19, 20],
};

const OGE_FIXED_LINES = {
  mechanics: [5, 6],
  mkt_thermo: [7],
  electrodynamics: [8, 9],
  quantum: [10],
  methods: [15],
};

// Линии 18–20 ЕГЭ — это методы научного познания. В их текстах
// встречаются слова из всех разделов физики, поэтому автоматическая
// классификация по тексту не должна менять этим задачам линию и подтему.
const PROTECTED_EGE_LINES = new Set([18, 19, 20]);

function isProtectedEgeLine(exam, line) {
  return String(exam || '').toUpperCase() === 'EGE' &&
    PROTECTED_EGE_LINES.has(Number(line));
}

function lineInfoOf(matrix, exam, line) {
  const examData = matrix.exams && matrix.exams[exam];
  if (!examData) return null;
  return (examData.lines || []).find((item) => Number(item.line) === Number(line)) || null;
}

function canonicalEgeLine(broad, narrow, originalLine) {
  const original = Number(originalLine);
  if (broad === 'mechanics') {
    if ([5, 6, 21, 22, 26].includes(original)) return original;
    if (original >= 21) return 22;
    if (narrow === 'kinematics') return 1;
    if (narrow === 'dynamics') return 2;
    if (narrow === 'conservation_laws') return 3;
    return 4;
  }
  if (broad === 'mkt_thermo') {
    if ([7, 8, 9, 10, 21, 22, 23, 24].includes(original)) return original;
    if (original >= 21) return narrow === 'mkt' ? 23 : 24;
    return narrow === 'mkt' ? 7 : 8;
  }
  if (broad === 'electrodynamics') {
    if ([11, 12, 13, 14, 15, 21, 23, 25].includes(original)) return original;
    if (original >= 21) return 25;
    if (narrow === 'magnetism') return 12;
    if (narrow === 'optics' || narrow === 'em_oscillations') return 13;
    return 11;
  }
  if (broad === 'quantum') {
    if ([16, 17].includes(original)) return original;
    return narrow === 'nuclear' ? 16 : 17;
  }
  if (broad === 'methods') {
    if ([18, 19, 20].includes(original)) return original;
    return 18;
  }
  return original || 1;
}

function canonicalOgeLine(broad, narrow, originalLine) {
  const original = Number(originalLine);
  if (original >= 11 && original <= 14) return original;
  if (original >= 15 && original <= 22) return original;
  if (original >= 1 && original <= 4) return original;
  // Механические/тепловые/электромагнитные/квантовые вычислительные линии.
  if (broad === 'mechanics') return 5;
  if (broad === 'mkt_thermo') return 7;
  if (broad === 'electrodynamics') return narrow === 'optics' ? 9 : 8;
  if (broad === 'quantum') return 10;
  return 15;
}

function chooseLine(task, broad, narrow, matrix) {
  const exam = String(task.exam || '').toUpperCase();
  const original = Number(task.kim_line);
  if (isProtectedEgeLine(exam, original)) {
    return { line: original, part: 1, info: lineInfoOf(matrix, exam, original) };
  }
  let line;
  if (exam === 'OGE') {
    if (original >= 5 && original <= 10) {
      const fixed = OGE_FIXED_LINES[broad] || [];
      line = fixed.includes(original) ? original : canonicalOgeLine(broad, narrow, original);
    } else {
      line = original >= 1 && original <= 22
        ? original
        : canonicalOgeLine(broad, narrow, original);
    }
  } else if (broad === 'mechanics' && narrow === 'kinematics') {
    // Чистая кинематика в ЕГЭ живёт на линиях 1, 5, 6, 22 и 26.
    // Линии 2–4 — динамика/статика/сохранение, 21 — качественная
    // часть 2, поэтому кинематику оттуда переводим в её собственные линии.
    if ([5, 6, 22, 26].includes(original)) {
      line = original;
    } else if (original === 21) {
      // 21 — смешанная качественная линия. Расчётные задачи уходят
      // в 22, качественные с обоснованием — в 26.
      const condition = normalize(task.latex_condition || '');
      line = /постройте|найдите|определите|рассчитайте|вычислите/.test(condition)
        ? 22
        : 26;
    } else {
      line = original > 21 ? 22 : 1;
    }
  } else {
    const valid = EGE_VALID_LINES[broad] || [];
    line = valid.includes(original)
      ? original
      : canonicalEgeLine(broad, narrow, original);
  }
  const part = exam === 'OGE'
    ? (line <= 16 ? 1 : 2)
    : (line <= 20 ? 1 : 2);
  return { line, part, info: lineInfoOf(matrix, exam, line) };
}

function chooseSubtopic(task, narrow, line, info, catalogEntry) {
  const catLine = catalogEntry ? Number(catalogEntry.line) : null;
  const catId = catalogEntry ? String(catalogEntry.subtopic_id || '') : '';
  const lineSubs = info && Array.isArray(info.subtopics) ? info.subtopics : [];
  const exam = String(task.exam || '').toUpperCase();

  // Для линий 18–20 сохраняем уже назначенную подтему, если она входит
  // в матрицу этой линии. Иначе берём подтему из каталога/матрицы.
  if (isProtectedEgeLine(exam, task.kim_line)) {
    const existingId = String(task.subtopic_id || '');
    const existingSub = lineSubs.find((sub) => String(sub.id) === existingId);
    if (existingSub) {
      return { id: existingId, title: String(existingSub.title || task.subtopic_title || existingId) };
    }
    const catSub = catLine === line
      ? lineSubs.find((sub) => String(sub.id) === catId)
      : null;
    if (catSub) {
      return { id: String(catSub.id), title: String(catSub.title || catSub.id) };
    }
    if (lineSubs.length > 0) {
      return { id: String(lineSubs[0].id), title: String(lineSubs[0].title || lineSubs[0].id) };
    }
    return { id: `auto_${narrow}`, title: NARROW_TITLES[narrow] || narrow };
  }

  if (catLine === line && catId) {
    const catSub = lineSubs.find((sub) => String(sub.id) === catId);
    if (catSub) {
      return { id: catId, title: String(catSub.title || catalogEntry.subtopic_title || catId) };
    }
    return { id: catId, title: String(catalogEntry.subtopic_title || catId) };
  }

  const matching = lineSubs.filter((sub) =>
    Array.isArray(sub.topic_keys) && sub.topic_keys.map(String).includes(narrow));
  if (matching.length > 0) {
    return { id: String(matching[0].id), title: String(matching[0].title || matching[0].id) };
  }

  if (lineSubs.length > 0) {
    return { id: String(lineSubs[0].id), title: String(lineSubs[0].title || lineSubs[0].id) };
  }

  return { id: `auto_${narrow}`, title: NARROW_TITLES[narrow] || narrow };
}

function findCoverageViolations(tasks, matrix) {
  const violations = [];
  for (const exam of ['EGE', 'OGE']) {
    const examData = matrix.exams && matrix.exams[exam];
    if (!examData) continue;
    const lineCounts = {};
    const subCounts = {};
    for (const task of tasks) {
      if (String(task.exam || '').toUpperCase() !== exam) continue;
      const line = Number(task.kim_line);
      lineCounts[line] = (lineCounts[line] || 0) + 1;
      const subId = String(task.subtopic_id || '');
      subCounts[subId] = (subCounts[subId] || 0) + 1;
    }
    for (let line = 1; line <= examData.max_line; line++) {
      if (!lineCounts[line]) {
        violations.push({ kind: 'empty_line', exam, line });
      }
    }
    for (const line of examData.lines || []) {
      for (const sub of line.subtopics || []) {
        if (!subCounts[String(sub.id)]) {
          violations.push({
            kind: 'empty_subtopic',
            exam,
            line: line.line,
            subtopic_id: sub.id,
            subtopic_title: sub.title,
          });
        }
      }
    }
  }
  return violations;
}

// ── Основной проход ────────────────────────────────────────────────────────

function main() {
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  const matrix = JSON.parse(fs.readFileSync(MATRIX_PATH, 'utf8'));
  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  const topicsTree = JSON.parse(fs.readFileSync(TOPICS_PATH, 'utf8'));

  const validNarrow = new Set(NARROW_KEYS);
  const catalogByExam = {
    EGE: (cache.problem_index && cache.problem_index.EGE) || {},
    OGE: (cache.problem_index && cache.problem_index.OGE) || {},
  };

  const cleaned = [];
  const stats = {
    total: db.length,
    broad: {},
    narrow: {},
    byExam: {},
    movedLines: 0,
    missingCatalog: 0,
    changedTopics: 0,
  };

  const samples = [];
  const movedSamples = [];
  const protectionViolations = [];

  for (const sourceTask of db) {
    const task = { ...sourceTask };
    const exam = String(task.exam || '').toUpperCase();
    const originalLine = Number(task.kim_line);
    const protectedLine = isProtectedEgeLine(exam, originalLine);
    const text = taskText(task);
    const prefix = prefixInfo(task);
    const existing = (task.topics || []).map(String).filter((key) => validNarrow.has(key));
    const catalogEntry = catalogByExam[exam] && catalogByExam[exam][String(task.source_id)];
    if (!catalogEntry) stats.missingCatalog += 1;

    const broad = protectedLine ? 'methods' : broadCategory(task, text, prefix);
    const narrow = protectedLine ? 'measurements' : chooseNarrow(task, broad, prefix, text, existing, {
      title: task.subtopic_title,
      conditionText: task.latex_condition,
    });
    const parent = PARENT_OF[narrow] || broad;

    const lineData = chooseLine(task, broad, narrow, matrix);
    const sub = chooseSubtopic(task, narrow, lineData.line, lineData.info, catalogEntry);

    task.topics = protectedLine ? ['methods', 'measurements'] : [parent, narrow];
    task.kim_line = lineData.line;
    task.part = lineData.part;
    task.subtopic_id = sub.id;
    task.subtopic_title = sub.title;

    if (protectedLine && lineData.info) {
      task.grading_rule = lineData.info.grading_rule;
      task.max_points = lineData.info.max_points;
    }

    if (protectedLine && Number(task.kim_line) !== originalLine) {
      protectionViolations.push({
        id: task.id,
        kind: 'protected_line_moved',
        from: originalLine,
        to: task.kim_line,
      });
    }
    if (protectedLine) {
      const lineSubs = lineData.info && Array.isArray(lineData.info.subtopics)
        ? lineData.info.subtopics
        : [];
      if (!lineSubs.some((item) => String(item.id) === String(task.subtopic_id))) {
        protectionViolations.push({
          id: task.id,
          kind: 'protected_subtopic_invalid',
          line: task.kim_line,
          subtopic_id: task.subtopic_id,
        });
      }
    }

    if (String(sourceTask.kim_line) !== String(lineData.line)) {
      stats.movedLines += 1;
      if (movedSamples.length < 25) {
        movedSamples.push({
          id: task.id,
          exam,
          from: Number(sourceTask.kim_line),
          to: lineData.line,
          broad,
          narrow,
          prefix: String(task.id).split('-')[1] || '',
        });
      }
    }
    if (JSON.stringify((sourceTask.topics || []).slice().sort()) !== JSON.stringify(task.topics.slice().sort())) {
      stats.changedTopics += 1;
    }

    stats.broad[parent] = (stats.broad[parent] || 0) + 1;
    stats.narrow[narrow] = (stats.narrow[narrow] || 0) + 1;
    const examStats = stats.byExam[exam] || { total: 0, broad: {}, narrow: {} };
    examStats.total += 1;
    examStats.broad[parent] = (examStats.broad[parent] || 0) + 1;
    examStats.narrow[narrow] = (examStats.narrow[narrow] || 0) + 1;
    stats.byExam[exam] = examStats;

    if (samples.length < 30) {
      samples.push({
        id: task.id,
        exam,
        line: task.kim_line,
        topics: task.topics,
        broad,
        narrow,
        prefix: String(task.id).split('-')[1] || '',
        subtopic: task.subtopic_title,
        text: String(task.latex_condition || '').slice(0, 90).replace(/\s+/g, ' '),
      });
    }

    cleaned.push(task);
  }

  // Проверки.
  const violations = [...protectionViolations];
  for (const task of cleaned) {
    const narrow = (task.topics || []).filter((key) => validNarrow.has(String(key)));
    if (narrow.length !== 1) {
      violations.push({ id: task.id, kind: 'narrow_count', topics: task.topics });
    }
    const parent = (task.topics || []).find((key) => topicsTree[key]);
    if (!parent || PARENT_OF[narrow[0]] !== parent) {
      violations.push({ id: task.id, kind: 'parent_mismatch', topics: task.topics });
    }
  }

  const kinematicsViolations = cleaned
    .filter((task) => (task.topics || []).includes('kinematics'))
    .filter((task) => KIN_FORBIDDEN_RE.test(taskText(task)))
    .map((task) => ({
      id: task.id,
      exam: task.exam,
      line: task.kim_line,
      topics: task.topics,
      text: String(task.latex_condition || '').slice(0, 140).replace(/\s+/g, ' '),
    }));

  const kinByExamLine = {};
  for (const task of cleaned) {
    if (!(task.topics || []).includes('kinematics')) continue;
    const key = `${task.exam}|${task.kim_line}`;
    kinByExamLine[key] = (kinByExamLine[key] || 0) + 1;
  }

  const mechanicsTasks = cleaned.filter((task) => (task.topics || []).includes('mechanics'));
  const mechanicsNarrowSum = mechanicsTasks.reduce((sum, task) => {
    return sum + (task.topics || []).filter((key) => PARENT_OF[key] === 'mechanics').length;
  }, 0);
  const coverageViolations = findCoverageViolations(cleaned, matrix);

  const report = {
    generated_at: new Date().toISOString(),
    write: WRITE,
    stats,
    checks: {
      violations: violations.length,
      protectedLineViolations: protectionViolations.length,
      coverageViolations: coverageViolations.length,
      kinematicsViolations: kinematicsViolations.length,
      mechanicsTasks: mechanicsTasks.length,
      mechanicsNarrowSum,
    },
    kinematicsByExamLine: kinByExamLine,
    kinematicsViolations,
    coverageViolations,
    movedSamples,
    samples,
  };

  const summary = {
    write: WRITE,
    stats: report.stats,
    checks: report.checks,
    kinematicsByExamLine: report.kinematicsByExamLine,
    kinematicsViolations: report.kinematicsViolations.slice(0, 40),
    coverageViolations: report.coverageViolations.slice(0, 40),
    movedSamples: report.movedSamples.slice(0, 15),
  };
  console.log(JSON.stringify(summary, null, 2));
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\nОтчёт: ${REPORT_PATH}`);

  if (violations.length > 0 || kinematicsViolations.length > 0 || coverageViolations.length > 0) {
    console.error('Проверка не пройдена: есть нарушения классификации или пустые линии/подтемы.');
    process.exitCode = 2;
    return;
  }

  if (WRITE) {
    // Не перезаписываем исходную резервную копию при повторных запусках:
    // иначе «до очистки» превращается в «до последней очистки».
    if (!fs.existsSync(BACKUP_PATH)) {
      fs.copyFileSync(DB_PATH, BACKUP_PATH);
      console.log(`Резервная копия: ${BACKUP_PATH}`);
    } else {
      console.log(`Резервная копия уже существует и не изменена: ${BACKUP_PATH}`);
    }
    fs.writeFileSync(DB_PATH, JSON.stringify(cleaned, null, 2), 'utf8');
    console.log(`Записан ${DB_PATH}`);
  } else {
    console.log('Режим отчёта: db.json не изменён. Для записи добавьте --write.');
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  normalize,
  taskText,
  prefixInfo,
  broadCategory,
  chooseNarrow,
  chooseLine,
  chooseSubtopic,
  QUANTUM_RE,
  EM_RE,
  THERMO_RE,
  MECHANICS_RE,
  STRONG_MECHANICS_RE,
  OSC_RE,
  STATICS_RE,
  CONSERVATION_RE,
  DYNAMICS_RE,
  KINEMATICS_RE,
  OPTICS_RE,
  EM_OSC_RE,
  MAGNETISM_RE,
  CURRENT_RE,
  ELECTROSTATICS_RE,
  VAPORS_RE,
  MKT_RE,
  THERMODYNAMICS_RE,
  NUCLEAR_RE,
  QUANTUM_RE_NARROW,
};
