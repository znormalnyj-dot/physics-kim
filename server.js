'use strict';

/**
 * server.js — локальный сервер панели преподавателя и электронного бланка.
 *
 * Запуск:
 *   node server.js            → http://localhost:3000/admin
 *   PORT=8080 node server.js  → другой порт
 *   HOST=0.0.0.0 node server.js → доступ из локальной сети
 *
 * Зависимостей нет: только встроенные модули Node.js.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { URL } = require('url');

const ROOT = __dirname;
const WEB_DIR = path.join(ROOT, 'web');
const OUTPUT_DIR = path.join(ROOT, 'output');
const BUILD_SCRIPT = path.join(ROOT, 'build.js');
const LOCAL_TASKS_DIR = path.join(ROOT, 'tasks');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const BUILD_TIMEOUT_MS = Number(process.env.BUILD_TIMEOUT_MS) || 10 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_LOG_CHARS = 400 * 1000;

const EXAMS = ['EGE', 'OGE'];
const EXAM_LABELS = {
  EGE: 'ЕГЭ (11 класс)',
  OGE: 'ОГЭ (9 класс)'
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.tex': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.aux': 'text/plain; charset=utf-8',
  '.out': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8'
};

// ─── Состояние (база кэшируется в памяти при старте) ──────────────────────────

const state = {
  tasksDir: null,
  dbPath: null,
  topicsPath: null,
  db: [],
  topicsRaw: {},
  allowedTopicKeys: new Set(),
  topicStats: null,
  loadedAt: null,
  dbMtime: null
};

let buildInProgress = false;

// ─── Утилиты ─────────────────────────────────────────────────────────────────

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return -1;
  }
}

function isInsideDir(baseDir, targetPath) {
  const rel = path.relative(path.resolve(baseDir), path.resolve(targetPath));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

function displayPath(filePath) {
  const rel = path.relative(ROOT, filePath);
  if (rel && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)) {
    return rel;
  }
  return filePath;
}

function zeroCounts() {
  return { part1: 0, part2: 0, total: 0 };
}

function copyCounts(counts) {
  const c = counts || zeroCounts();
  return { part1: c.part1 || 0, part2: c.part2 || 0, total: c.total || 0 };
}

function increment(counts, part) {
  if (part === 2) counts.part2 += 1;
  else counts.part1 += 1;
  counts.total += 1;
}

function isoOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ─── Конфигурация (config.json / .env) ───────────────────────────────────────

const CONFIG_PATH = path.join(ROOT, 'config.json');
const ENV_PATH = path.join(ROOT, '.env');

function readConfigJson() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readEnvFile() {
  const result = {};
  try {
    const lines = fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!key) continue;
      result[key] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    // .env необязателен
  }
  return result;
}

// Публичный адрес бланка: config.json имеет приоритет, затем .env.
function getWebBaseUrlSetting() {
  const config = readConfigJson();
  const fromConfig = String(config.WEB_BASE_URL || '').trim();
  if (fromConfig) return { value: fromConfig, source: 'config.json' };

  const env = readEnvFile();
  const fromEnv = String(env.WEB_BASE_URL || '').trim();
  if (fromEnv) return { value: fromEnv, source: '.env' };

  return { value: '', source: 'default' };
}

function normalizePublicUrl(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return { ok: true, value: '' };

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: 'Некорректный URL. Пример: https://example.github.io/physics-kim/' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'URL должен начинаться с http:// или https://.' };
  }
  if (!parsed.hostname) {
    return { ok: false, error: 'В URL не указан домен.' };
  }
  return { ok: true, value: raw };
}

function writeFileAtomic(filePath, content) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function saveWebBaseUrl(value) {
  const config = readConfigJson();
  if (value) config.WEB_BASE_URL = value;
  else delete config.WEB_BASE_URL;
  writeFileAtomic(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');

  // Если ключ уже есть в .env — синхронизируем и его, чтобы CLI-сборка
  // и сервер использовали одно и то же значение.
  let envText = '';
  try {
    envText = fs.readFileSync(ENV_PATH, 'utf8');
  } catch {
    envText = '';
  }
  if (envText) {
    const lines = envText.split(/\r?\n/);
    let found = false;
    const updated = lines.map((line) => {
      if (/^\s*WEB_BASE_URL\s*=/.test(line)) {
        found = true;
        return value ? `WEB_BASE_URL=${value}` : 'WEB_BASE_URL=';
      }
      return line;
    });
    if (found) {
      writeFileAtomic(ENV_PATH, updated.join('\n'));
    }
  }
}

// ─── Выбор каталога с базой задач ────────────────────────────────────────────
// В проекте может быть как полная база (../tasks), так и локальная копия.
// Берём самую большую валидную базу; TASKS_DIR позволяет задать путь явно.

function resolveTasksDir() {
  const valid = (dir) =>
    fs.existsSync(path.join(dir, 'db.json')) && fs.existsSync(path.join(dir, 'topics.json'));

  if (process.env.TASKS_DIR) {
    const dir = path.resolve(ROOT, process.env.TASKS_DIR);
    if (!valid(dir)) {
      throw new Error(`В каталоге TASKS_DIR нет db.json и topics.json: ${dir}`);
    }
    return dir;
  }

  const candidates = [LOCAL_TASKS_DIR, path.resolve(ROOT, '..', 'tasks')].filter(valid);
  if (candidates.length === 0) {
    throw new Error(
      `Не найдена база задач. Ожидался файл ${path.join(LOCAL_TASKS_DIR, 'db.json')} ` +
      `или ${path.resolve(ROOT, '..', 'tasks', 'db.json')}.`
    );
  }

  candidates.sort((a, b) => fileSize(path.join(b, 'db.json')) - fileSize(path.join(a, 'db.json')));
  return candidates[0];
}

function collectAllowedTopicKeys(topicsRaw) {
  const keys = new Set();
  for (const [sectionKey, section] of Object.entries(topicsRaw || {})) {
    keys.add(sectionKey);
    for (const subKey of Object.keys(section.subtopics || {})) {
      keys.add(subKey);
    }
  }
  return keys;
}

function loadData() {
  const tasksDir = resolveTasksDir();
  const dbPath = path.join(tasksDir, 'db.json');
  const topicsPath = path.join(tasksDir, 'topics.json');

  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  if (!Array.isArray(db)) {
    throw new Error(`Файл ${dbPath} должен содержать массив задач.`);
  }

  const topicsRaw = JSON.parse(fs.readFileSync(topicsPath, 'utf8'));
  if (!topicsRaw || typeof topicsRaw !== 'object' || Array.isArray(topicsRaw)) {
    throw new Error(`Файл ${topicsPath} должен содержать объект разделов.`);
  }

  state.tasksDir = tasksDir;
  state.dbPath = dbPath;
  state.topicsPath = topicsPath;
  state.db = db;
  state.topicsRaw = topicsRaw;
  state.allowedTopicKeys = collectAllowedTopicKeys(topicsRaw);
  state.loadedAt = new Date().toISOString();
  state.dbMtime = isoOrNull(fs.statSync(dbPath).mtime);
  state.topicStats = buildTopicStats();

  console.log(`[БАЗА] ${dbPath}`);
  console.log(`[БАЗА] Задач: ${db.length}. Разделов: ${Object.keys(topicsRaw).length}.`);
  if (path.resolve(tasksDir) !== path.resolve(LOCAL_TASKS_DIR)) {
    console.log(`[БАЗА] Используется внешняя база. Чтобы зафиксировать её, задайте TASKS_DIR.`);
  }
}

// ─── Статистика по темам ─────────────────────────────────────────────────────

function buildTopicStats() {
  const totals = { EGE: zeroCounts(), OGE: zeroCounts() };
  const subtopicCounts = new Map(); // "EXAM|subtopic" → counts
  const sectionCounts = new Map();  // "EXAM|section"  → counts
  const sectionSets = new Map();    // section → Set(section + subtopics)

  for (const [sectionKey, section] of Object.entries(state.topicsRaw)) {
    const keys = new Set([sectionKey, ...Object.keys(section.subtopics || {})]);
    sectionSets.set(sectionKey, keys);
    for (const exam of EXAMS) {
      sectionCounts.set(`${exam}|${sectionKey}`, zeroCounts());
      for (const subKey of Object.keys(section.subtopics || {})) {
        subtopicCounts.set(`${exam}|${subKey}`, zeroCounts());
      }
    }
  }

  for (const task of state.db) {
    const exam = String(task.exam || '').toUpperCase();
    if (!totals[exam]) continue;

    const part = Number(task.part) === 2 ? 2 : 1;
    increment(totals[exam], part);

    const tags = Array.isArray(task.topics) ? task.topics.map(String) : [];

    for (const tag of tags) {
      const counts = subtopicCounts.get(`${exam}|${tag}`);
      if (counts) increment(counts, part);
    }

    for (const [sectionKey, keys] of sectionSets) {
      if (tags.some((tag) => keys.has(tag))) {
        increment(sectionCounts.get(`${exam}|${sectionKey}`), part);
      }
    }
  }

  const sections = Object.entries(state.topicsRaw).map(([sectionKey, section]) => {
    const subtopics = Object.entries(section.subtopics || {}).map(([subKey, title]) => ({
      key: subKey,
      title: String(title),
      counts: {
        EGE: copyCounts(subtopicCounts.get(`EGE|${subKey}`)),
        OGE: copyCounts(subtopicCounts.get(`OGE|${subKey}`))
      }
    }));

    return {
      key: sectionKey,
      title: String(section.title || sectionKey),
      counts: {
        EGE: copyCounts(sectionCounts.get(`EGE|${sectionKey}`)),
        OGE: copyCounts(sectionCounts.get(`OGE|${sectionKey}`))
      },
      subtopics
    };
  });

  return {
    exams: {
      EGE: { label: EXAM_LABELS.EGE, ...copyCounts(totals.EGE) },
      OGE: { label: EXAM_LABELS.OGE, ...copyCounts(totals.OGE) }
    },
    sections
  };
}

// ─── Готовые варианты в output/ ──────────────────────────────────────────────

function scanVariants() {
  let entries = [];
  try {
    entries = fs.readdirSync(OUTPUT_DIR);
  } catch {
    return [];
  }

  const variants = new Map();

  const ensure = (exam, variant) => {
    const id = `${exam}|${variant}`;
    if (!variants.has(id)) {
      variants.set(id, {
        exam,
        variant,
        code: `${exam}-${variant}`,
        title: '',
        createdAt: null,
        createdAtMs: 0,
        tasksCount: null,
        hasStudentPdf: false,
        hasTeacherPdf: false,
        hasKey: false
      });
    }
    return variants.get(id);
  };

  const touch = (item, filePath) => {
    try {
      const st = fs.statSync(filePath);
      if (st.mtimeMs > item.createdAtMs) {
        item.createdAtMs = st.mtimeMs;
        item.createdAt = st.mtime.toISOString();
      }
    } catch {
      // ignore
    }
  };

  for (const file of entries) {
    let match = file.match(/^KIM_(EGE|OGE)_([A-Za-z0-9_-]+)_(Student|Teacher)\.pdf$/);
    if (match) {
      const item = ensure(match[1], match[2]);
      if (match[3] === 'Student') item.hasStudentPdf = true;
      else item.hasTeacherPdf = true;
      touch(item, path.join(OUTPUT_DIR, file));
      continue;
    }

    match = file.match(/^KIM_(EGE|OGE)_([A-Za-z0-9_-]+)_Key\.json$/);
    if (match) {
      const item = ensure(match[1], match[2]);
      item.hasKey = true;
      touch(item, path.join(OUTPUT_DIR, file));
      try {
        const key = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, file), 'utf8'));
        if (key && typeof key.title === 'string' && key.title.trim()) {
          item.title = key.title.trim();
        }
        if (key && Array.isArray(key.tasks)) {
          item.tasksCount = key.tasks.length;
        }
        const created = isoOrNull(key && key.created_at);
        if (created) {
          item.createdAt = created;
          item.createdAtMs = new Date(created).getTime();
        }
      } catch {
        // повреждённый ключ не должен ломать архив
      }
    }
  }

  const result = [];
  for (const item of variants.values()) {
    if (!item.createdAt) {
      item.createdAt = new Date(item.createdAtMs || Date.now()).toISOString();
    }
    if (!item.title) {
      item.title = `Тренировочный вариант №${item.variant}`;
    }

    const baseName = `KIM_${item.exam}_${item.variant}`;
    item.studentPdfUrl = `/output/${baseName}_Student.pdf`;
    item.teacherPdfUrl = `/output/${baseName}_Teacher.pdf`;
    item.studentPdfDownloadUrl = `${item.studentPdfUrl}?download=1`;
    item.teacherPdfDownloadUrl = `${item.teacherPdfUrl}?download=1`;
    item.blankUrl = `/?v=${encodeURIComponent(item.code)}`;

    result.push(item);
  }

  result.sort((a, b) => (b.createdAtMs - a.createdAtMs) || b.variant.localeCompare(a.variant, 'ru', { numeric: true }));
  return result;
}

function nextVariantMap(variants) {
  const result = { EGE: 101, OGE: 201 };

  for (const exam of EXAMS) {
    const numbers = variants
      .filter((v) => v.exam === exam && /^\d+$/.test(v.variant))
      .map((v) => Number(v.variant))
      .filter((n) => Number.isFinite(n));

    const base = exam === 'EGE' ? 100 : 200;
    const max = numbers.reduce((acc, n) => Math.max(acc, n), base);
    result[exam] = max + 1;
  }

  return result;
}

function buildStatsPayload() {
  const variants = scanVariants();
  const nextVariant = nextVariantMap(variants);
  const stats = state.topicStats;

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    source: {
      tasksDir: displayPath(state.tasksDir),
      tasksDirAbsolute: state.tasksDir,
      dbPath: displayPath(state.dbPath),
      topicsPath: displayPath(state.topicsPath),
      loadedAt: state.loadedAt,
      dbMtime: state.dbMtime
    },
    totalTasks: state.db.length,
    exams: stats.exams,
    topics: stats.sections,
    variants,
    nextVariant
  };
}

// ─── HTTP-ответы и статика ───────────────────────────────────────────────────

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  const body = String(text);
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function send404(req, res) {
  const html = `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><title>404 — не найдено</title>
<style>body{font-family:system-ui,Segoe UI,sans-serif;background:#f4f6fb;color:#1e293b;display:grid;place-items:center;min-height:100vh;margin:0}
.box{background:#fff;border-radius:16px;padding:32px 40px;box-shadow:0 12px 40px rgba(15,23,42,.08);text-align:center}
a{color:#2563eb}</style></head>
<body><div class="box"><h1>404</h1><p>Страница или файл не найдены.</p>
<p><a href="/admin">Вернуться в панель преподавателя</a> · <a href="/">Открыть бланк ученика</a></p></div></body></html>`;
  sendText(res, 404, html, MIME_TYPES['.html']);
}

function sendFile(req, res, filePath, options = {}) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const ext = path.extname(filePath).toLowerCase();
  const fileName = path.basename(filePath);
  const headers = {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Last-Modified': stat.mtime.toUTCString()
  };

  if (options.download) {
    headers['Content-Disposition'] = `attachment; filename="${fileName.replace(/"/g, '')}"`;
  } else if (ext === '.pdf') {
    headers['Content-Disposition'] = `inline; filename="${fileName.replace(/"/g, '')}"`;
  }

  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }

  const stream = fs.createReadStream(filePath);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
  return true;
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

// ─── API ─────────────────────────────────────────────────────────────────────

function readJsonBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (tooLarge) {
        const err = new Error('Слишком большой запрос.');
        err.statusCode = 413;
        reject(err);
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('JSON должен быть объектом.');
        }
        resolve(parsed);
      } catch (e) {
        const err = new Error(`Некорректный JSON: ${e.message}`);
        err.statusCode = 400;
        reject(err);
      }
    });

    req.on('error', reject);
  });
}

function requestBaseUrl(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = forwarded === 'https' ? 'https' : 'http';
  const host = String(req.headers.host || `localhost:${PORT}`).trim();
  if (!/^[A-Za-z0-9.\-:\[\]]+$/.test(host)) {
    return `http://localhost:${PORT}`;
  }
  return `${proto}://${host}`;
}

// Ссылка на электронный бланк с параметром ?v=<КОД>.
// Работает и для базового URL с уже добавленными query-параметрами.
function joinBlankUrl(baseUrl, code) {
  const base = String(baseUrl || '').trim();
  const query = `v=${encodeURIComponent(code)}`;
  if (!base) return `/?${query}`;

  try {
    const parsed = new URL(base);
    parsed.searchParams.set('v', code);
    return parsed.toString();
  } catch {
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}${query}`;
  }
}

function sanitizeTitle(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function normalizeVariant(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/^(EGE|OGE)[-_]?/i, '');
}

function parseCount(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 200) return null;
  return n;
}

function runBuild(exam, topics, variant, title, part1, part2, skipGas, webBaseUrl) {
  return new Promise((resolve, reject) => {
    const args = [
      BUILD_SCRIPT,
      `--exam=${exam}`,
      `--topics=${topics.join(',')}`,
      `--variant=${variant}`,
      `--part1=${part1}`,
      `--part2=${part2}`,
      `--web-url=${webBaseUrl}`
    ];

    if (title) args.push(`--title=${title}`);
    if (skipGas) args.push('--skip-gas');

    if (path.resolve(state.tasksDir) !== path.resolve(LOCAL_TASKS_DIR)) {
      args.push(`--tasks-dir=${state.tasksDir}`);
    }

    const startedAt = Date.now();
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, FORCE_COLOR: '0' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const append = (current, chunk) => {
      const next = current + chunk.toString('utf8');
      return next.length > MAX_LOG_CHARS ? next.slice(-MAX_LOG_CHARS) : next;
    };

    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, BUILD_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      const error = new Error(`Не удалось запустить build.js: ${err.message}`);
      error.log = (stdout + '\n' + stderr).trim();
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const log = [stdout.trim(), stderr.trim() ? `[stderr]\n${stderr.trim()}` : '']
        .filter(Boolean)
        .join('\n')
        .slice(-MAX_LOG_CHARS);

      if (timedOut) {
        const error = new Error(`Сборка превысила лимит времени (${Math.round(BUILD_TIMEOUT_MS / 60000)} мин).`);
        error.log = log;
        reject(error);
        return;
      }

      if (code !== 0) {
        const important = log
          .split('\n')
          .filter((line) => line.startsWith('!') || /Ошибка|ошибка|Fatal|not found|Undefined control sequence/i.test(line))
          .slice(0, 12)
          .join('\n');
        const error = new Error(important || `Сборка завершилась с кодом ${code}.`);
        error.log = log;
        reject(error);
        return;
      }

      const baseName = `KIM_${exam}_${variant}`;
      const studentPdfPath = path.join(OUTPUT_DIR, `${baseName}_Student.pdf`);
      const teacherPdfPath = path.join(OUTPUT_DIR, `${baseName}_Teacher.pdf`);
      const keyPath = path.join(OUTPUT_DIR, `${baseName}_Key.json`);

      if (!fs.existsSync(studentPdfPath) || !fs.existsSync(teacherPdfPath)) {
        const error = new Error('Сборка завершилась, но PDF-файлы не найдены в output/.');
        error.log = log;
        reject(error);
        return;
      }

      let tasksCount = null;
      let finalTitle = title;
      try {
        const key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
        if (Array.isArray(key.tasks)) tasksCount = key.tasks.length;
        if (key.title) finalTitle = key.title;
      } catch {
        // ключ не критичен для ответа
      }

      const variants = scanVariants();
      const nextVariant = nextVariantMap(variants);

      resolve({
        ok: true,
        exam,
        variant,
        code: `${exam}-${variant}`,
        title: finalTitle || `Тренировочный вариант №${variant}`,
        tasksCount,
        requestedCount: part1 + part2,
        studentPdfUrl: `/output/${baseName}_Student.pdf`,
        teacherPdfUrl: `/output/${baseName}_Teacher.pdf`,
        blankUrl: `/?v=${encodeURIComponent(`${exam}-${variant}`)}`,
        publicBlankUrl: joinBlankUrl(webBaseUrl, `${exam}-${variant}`),
        webBaseUrl,
        nextVariant: nextVariant[exam],
        durationMs: Date.now() - startedAt,
        log
      });
    });
  });
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Allow': 'GET, POST, OPTIONS',
      'Cache-Control': 'no-store'
    });
    res.end();
    return;
  }

  if (pathname === '/api/config') {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const setting = getWebBaseUrlSetting();
      const payload = {
        ok: true,
        webBaseUrl: setting.value,
        source: setting.source,
        configPath: displayPath(CONFIG_PATH),
        defaultLocalUrl: requestBaseUrl(req) + '/'
      };
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      sendJson(res, 200, payload);
      return;
    }

    if (req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req, MAX_BODY_BYTES);
      } catch (e) {
        sendJson(res, e.statusCode || 400, { ok: false, error: e.message });
        return;
      }

      const parsed = normalizePublicUrl(body.webBaseUrl);
      if (!parsed.ok) {
        sendJson(res, 400, { ok: false, error: parsed.error });
        return;
      }

      try {
        saveWebBaseUrl(parsed.value);
      } catch (e) {
        sendJson(res, 500, { ok: false, error: `Не удалось сохранить config.json: ${e.message}` });
        return;
      }

      console.log(`[КОНФИГ] Публичный URL бланка: ${parsed.value || '(локальный адрес)'}`);
      sendJson(res, 200, {
        ok: true,
        webBaseUrl: parsed.value,
        source: parsed.value ? 'config.json' : 'default'
      });
      return;
    }

    sendJson(res, 405, { ok: false, error: 'Метод не поддерживается. Используйте GET или POST.' });
    return;
  }

  if (pathname === '/api/stats') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'Метод не поддерживается. Используйте GET.' });
      return;
    }
    const payload = buildStatsPayload();
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    sendJson(res, 200, payload);
    return;
  }

  if (pathname === '/api/build') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'Метод не поддерживается. Используйте POST.' });
      return;
    }

    if (buildInProgress) {
      sendJson(res, 409, { ok: false, error: 'Сборка уже выполняется. Дождитесь её завершения.' });
      return;
    }

    let body;
    try {
      body = await readJsonBody(req, MAX_BODY_BYTES);
    } catch (e) {
      sendJson(res, e.statusCode || 400, { ok: false, error: e.message });
      return;
    }

    const exam = String(body.exam || 'EGE').toUpperCase();
    if (!EXAMS.includes(exam)) {
      sendJson(res, 400, { ok: false, error: 'Экзамен должен быть EGE или OGE.' });
      return;
    }

    const rawTopics = Array.isArray(body.topics) ? body.topics : [];
    const topics = [...new Set(rawTopics.map((v) => String(v).trim()).filter((key) => state.allowedTopicKeys.has(key)))];
    if (topics.length === 0) {
      sendJson(res, 400, { ok: false, error: 'Выберите хотя бы одну тему (раздел или подтему).' });
      return;
    }

    const part1 = parseCount(body.part1, exam === 'OGE' ? 16 : 20);
    const part2 = parseCount(body.part2, 6);
    if (part1 === null || part2 === null) {
      sendJson(res, 400, { ok: false, error: 'Количество задач должно быть целым числом от 0 до 200.' });
      return;
    }
    if (part1 + part2 === 0) {
      sendJson(res, 400, { ok: false, error: 'Нужно запросить хотя бы одну задачу.' });
      return;
    }

    const variants = scanVariants();
    const nextVariant = nextVariantMap(variants);

    let variant = normalizeVariant(body.variant);
    if (!variant) variant = String(nextVariant[exam]);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/.test(variant)) {
      sendJson(res, 400, {
        ok: false,
        error: 'Код варианта может содержать только латинские буквы, цифры, дефис и подчёркивание (до 20 символов).'
      });
      return;
    }

    const title = sanitizeTitle(body.title);
    if (/[\\{}%#$&^~]/.test(title)) {
      sendJson(res, 400, {
        ok: false,
        error: 'В заголовке нельзя использовать символы \\ { } % # $ & ^ ~.'
      });
      return;
    }

    const skipGas = body.skipGas === true || body.skipGas === 'true' || body.skipGas === 1;

    // Публичный URL бланка: значение из формы → config.json/.env → локальный адрес.
    const requestedWebBaseUrl = normalizePublicUrl(body.webBaseUrl);
    if (!requestedWebBaseUrl.ok) {
      sendJson(res, 400, { ok: false, error: requestedWebBaseUrl.error });
      return;
    }
    const webBaseUrl = requestedWebBaseUrl.value ||
      getWebBaseUrlSetting().value ||
      requestBaseUrl(req);

    // Повторная проверка: пока читали тело запроса, могла начаться другая сборка.
    if (buildInProgress) {
      sendJson(res, 409, { ok: false, error: 'Сборка уже выполняется. Дождитесь её завершения.' });
      return;
    }

    buildInProgress = true;
    console.log(`[СБОРКА] ${exam}-${variant} · ${part1}+${part2} задач · тем: ${topics.length}`);

    try {
      const result = await runBuild(exam, topics, variant, title, part1, part2, skipGas, webBaseUrl);
      console.log(`[СБОРКА] Готово за ${Math.round(result.durationMs / 1000)} с: ${result.code}, задач: ${result.tasksCount}.`);
      sendJson(res, 200, result);
    } catch (e) {
      console.error(`[СБОРКА] Ошибка: ${e.message}`);
      sendJson(res, 500, {
        ok: false,
        error: e.message,
        log: e.log || '',
        exam,
        variant,
        nextVariant: nextVariant[exam]
      });
    } finally {
      buildInProgress = false;
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: 'API-маршрут не найден.' });
}

// ─── Маршрутизация ───────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  let url;
  let pathname;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendText(res, 400, 'Некорректный URL.');
    return;
  }

  if (pathname.startsWith('/api/')) {
    await handleApi(req, res, url);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Allow': 'GET, HEAD, OPTIONS', 'Cache-Control': 'no-store' });
    res.end('Method Not Allowed');
    return;
  }

  if (pathname === '/admin' || pathname === '/admin/') {
    if (sendFile(req, res, path.join(WEB_DIR, 'admin.html'))) return;
    send404(req, res);
    return;
  }

  if (pathname === '/output' || pathname === '/output/') {
    redirect(res, '/admin');
    return;
  }

  if (pathname.startsWith('/output/')) {
    const rel = pathname.slice('/output/'.length);
    const filePath = path.resolve(OUTPUT_DIR, rel);
    if (!isInsideDir(OUTPUT_DIR, filePath)) {
      send404(req, res);
      return;
    }
    const download = ['1', 'true', 'yes'].includes(String(url.searchParams.get('download') || '').toLowerCase());
    if (sendFile(req, res, filePath, { download })) return;
    send404(req, res);
    return;
  }

  if (pathname === '/favicon.ico') {
    if (sendFile(req, res, path.join(WEB_DIR, 'favicon.ico'))) return;
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    res.end();
    return;
  }

  let rel = pathname.replace(/^\/+/, '');
  if (!rel) rel = 'index.html';

  const filePath = path.resolve(WEB_DIR, rel);
  if (isInsideDir(WEB_DIR, filePath) && sendFile(req, res, filePath)) return;

  send404(req, res);
}

// ─── Старт ───────────────────────────────────────────────────────────────────

function start() {
  try {
    loadData();
  } catch (e) {
    console.error(`[ОШИБКА] Не удалось загрузить базу задач: ${e.message}`);
    process.exit(1);
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((e) => {
      console.error('[ОШИБКА]', e);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, 500, { ok: false, error: 'Внутренняя ошибка сервера.' });
    });
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`[ОШИБКА] Порт ${PORT} уже занят. Остановите другой сервер или задайте PORT=3001.`);
    } else {
      console.error('[ОШИБКА] Сервер:', e.message);
    }
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    console.log('');
    console.log('  Панель преподавателя:  http://localhost:' + PORT + '/admin');
    console.log('  Бланк ученика:         http://localhost:' + PORT + '/?v=EGE-101');
    console.log('  PDF из output/:        http://localhost:' + PORT + '/output/');
    if (HOST === '0.0.0.0') {
      console.log('  Доступ в локальной сети включён (HOST=0.0.0.0).');
    }
    console.log('');
  });
}

start();
