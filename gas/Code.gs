/**
 * Google Apps Script Бэкенд для Physics_KIM_Generator
 * Инструкция по установке:
 * 1. Создайте новую Google Таблицу на своем Google Диске.
 * 2. Откройте Расширения -> Apps Script, вставьте этот код и нажмите "Сохранить".
 * 3. Нажмите "Начать развертывание" -> "Новое развертывание" -> Тип: "Веб-приложение".
 * 4. Выполнять как: "От моего имени", У кого есть доступ: "Все".
 * 5. Скопируйте полученный URL веб-приложения в config.json вашего проекта.
 */

const FOLDER_NAME = "Physics_KIM_Работы_Учеников";
const RESULTS_HEADERS = [
  "Дата и время",
  "Вариант",
  "Ученик",
  "Класс",
  "Время (мин)",
  "Балл Ч.1",
  "Макс Ч.1",
  "Ссылка на фото Ч.2",
  "Детализация Ч.1 (№: ответ [балл])",
  "Attempt_ID",
  "Part2_Scores_JSON",
  "Score_Part2",
  "Total_Primary",
  "Test_Score_100_Or_Grade",
  "Status",
  "Photos_JSON",
  "Teacher_Comment"
];

function doGet(e) {
  const params = (e && e.parameter) || {};
  const action = String(params.action || "").trim();

  try {
    // Публичный манифест варианта для веб-бланка на внешнем хостинге
    // (GitHub Pages / Vercel / Netlify). Ответ не содержит ответов и решений.
    if (action === "get_manifest") {
      return jsonResponse(getPublicManifest(params.v));
    }

    if (action === "list_attempts") {
      return jsonResponse(listAttempts());
    }

    if (action === "get_photo") {
      return jsonResponse(getPhoto({ fileId: params.fileId }));
    }

    if (action === "grade_part2") {
      return jsonResponse(gradePart2({
        attempt_id: params.attempt_id,
        row_index: params.row_index,
        part2_scores: parseJsonSafe(params.part2_scores, {}),
        score_part2: params.score_part2,
        total_primary: params.total_primary,
        secondary_score: params.secondary_score,
        teacher_comment: params.teacher_comment
      }));
    }
  } catch (err) {
    return jsonResponse({ ok: false, error: err.toString() });
  }

  return jsonResponse({
    ok: true,
    message: "Google Apps Script бэкенд для Physics_KIM_Generator активен и готов к приёму данных!",
    time: new Date().toISOString()
  });
}

/**
 * Возвращает публичную структуру варианта из листа Keys.
 * В каждом задании остаются только поля: num, part, rule, max_points, unit, cols.
 * Поля answer и solution никогда не попадают в ответ.
 */
function getPublicManifest(variantId) {
  const requested = String(variantId || "").trim();
  if (!requested) {
    return { ok: false, error: "Не передан параметр v (код варианта), например: ?action=get_manifest&v=EGE-106" };
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const keySheet = ss.getSheetByName("Keys");
  if (!keySheet) {
    return { ok: false, error: "Лист Keys не найден. Сначала зарегистрируйте вариант." };
  }

  const rows = keySheet.getDataRange().getValues();

  for (let i = 1; i < rows.length; i++) {
    const rowVariantId = String(rows[i][0] || "").trim();
    if (rowVariantId.toUpperCase() !== requested.toUpperCase()) continue;

    const exam = String(rows[i][1] || rowVariantId.split("-")[0] || "").trim().toUpperCase();
    const normalizedExam = exam === "OGE" ? "OGE" : "EGE";
    const variantNumber = rowVariantId.split(/[-_]/).slice(1).join("-") || rowVariantId;
    const title = String(rows[i][2] || "").trim() || ("Тренировочный вариант №" + variantNumber);

    let tasksKey = [];
    try {
      tasksKey = JSON.parse(rows[i][4] || "[]");
    } catch (parseErr) {
      return { ok: false, error: "Повреждён ключ варианта " + rowVariantId + ": " + parseErr.toString() };
    }
    if (!Array.isArray(tasksKey)) tasksKey = [];

    const publicTasks = tasksKey
      .map(toPublicTask)
      .filter(function (task) { return task !== null; });

    return {
      ok: true,
      variant_id: rowVariantId,
      exam: normalizedExam,
      title: title,
      duration_minutes: normalizedExam === "OGE" ? 180 : 235,
      tasks: publicTasks
    };
  }

  return { ok: false, error: "Вариант " + requested + " не найден в листе Keys." };
}

/**
 * Белый список полей публичного задания: answer и solution отбрасываются.
 */
function toPublicTask(task) {
  if (!task || typeof task !== "object") return null;

  const num = Number(task.num);
  if (!isFinite(num)) return null;

  const item = {
    num: num,
    part: Number(task.part) === 2 ? 2 : 1,
    rule: String(task.rule || ""),
    max_points: Number(task.max_points) || 1
  };

  if (task.unit) item.unit = String(task.unit);
  if (Array.isArray(task.cols) && task.cols.length === 2) {
    item.cols = [String(task.cols[0]), String(task.cols[1])];
  }

  return item;
}

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const action = payload.action;

    if (action === "register_key") {
      return jsonResponse(registerVariantKey(payload));
    } else if (action === "submit_attempt") {
      return jsonResponse(processStudentAttempt(payload));
    } else if (action === "list_attempts") {
      return jsonResponse(listAttempts());
    } else if (action === "get_photo") {
      return jsonResponse(getPhoto(payload));
    } else if (action === "grade_part2") {
      return jsonResponse(gradePart2(payload));
    } else {
      return jsonResponse({ ok: false, error: "Неизвестное действие (action)" });
    }
  } catch (err) {
    return jsonResponse({ ok: false, error: err.toString() });
  }
}

// 1. Автоматическая регистрация ключей варианта из build.js
function registerVariantKey(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let keySheet = ss.getSheetByName("Keys");
  if (!keySheet) {
    keySheet = ss.insertSheet("Keys");
    keySheet.appendRow(["Variant_ID", "Exam", "Title", "Created_At", "Tasks_JSON"]);
    keySheet.getRange("A1:E1").setFontWeight("bold");
  }

  const rows = keySheet.getDataRange().getValues();
  let updated = false;
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(data.variant_id)) {
      keySheet.getRange(i + 1, 2, 1, 4).setValues([[
        data.exam || "",
        data.title || "",
        new Date().toISOString(),
        JSON.stringify(data.tasks)
      ]]);
      updated = true;
      break;
    }
  }

  if (!updated) {
    keySheet.appendRow([
      data.variant_id,
      data.exam || "",
      data.title || "",
      new Date().toISOString(),
      JSON.stringify(data.tasks)
    ]);
  }

  return { ok: true, variant_id: data.variant_id, status: updated ? "updated" : "created" };
}

// 2. Проверка работы ученика и сохранение фото на Google Диск
function processStudentAttempt(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const keySheet = ss.getSheetByName("Keys");
  if (!keySheet) {
    return { ok: false, error: "Лист Keys не найден. Сначала зарегистрируйте вариант." };
  }

  // Поиск ключей варианта
  const keyRows = keySheet.getDataRange().getValues();
  let tasksKey = null;
  for (let i = 1; i < keyRows.length; i++) {
    if (String(keyRows[i][0]) === String(data.variant_id)) {
      tasksKey = JSON.parse(keyRows[i][4]);
      break;
    }
  }

  if (!tasksKey) {
    return { ok: false, error: `Ключи для варианта ${data.variant_id} не найдены в таблице.` };
  }

  const studentAnswers = data.answers || {};
  let totalPointsPart1 = 0;
  let maxPointsPart1 = 0;
  const detailedResults = [];

  // Проверка заданий Части 1
  for (const task of tasksKey) {
    if (Number(task.part) !== 1) continue;
    const maxPts = Number(task.max_points) || 1;
    maxPointsPart1 += maxPts;

    const rawStudentAns = String(studentAnswers[task.num] || "").trim();
    const pts = gradePhysicsTask(rawStudentAns, String(task.answer), task.rule, maxPts);
    totalPointsPart1 += pts;

    detailedResults.push({
      num: task.num,
      student_answer: rawStudentAns,
      points: pts,
      max_points: maxPts
    });
  }

  const attemptId = generateAttemptId();
  const part2Tasks = tasksKey.filter(function (task) { return Number(task.part) === 2; });
  const photos = [];

  // Сохранение фотографий Части 2 на Google Диск
  let folderUrl = "Без фото 2-й части";
  let folderId = "";
  if (data.photos && data.photos.length > 0) {
    const rootFolder = getOrCreateRootFolder();
    const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd_HH-mm");
    const safeName = (data.student_name || "Ученик").replace(/[^\wа-яА-ЯёЁ\s-]/g, "");
    const studentFolder = rootFolder.createFolder(`${data.variant_id}_${safeName}_${timestamp}`);

    data.photos.forEach(function (photoObj, idx) {
      if (!photoObj || !photoObj.dataUrl) return;
      const parts = String(photoObj.dataUrl).split(",");
      const mimeMatch = String(photoObj.dataUrl).match(/data:(.*);base64/);
      if (parts.length < 2) return;
      const mimeType = (mimeMatch && mimeMatch[1]) || "image/jpeg";
      const blob = Utilities.newBlob(Utilities.base64Decode(parts[1]), mimeType, `Part2_Page_${idx + 1}.jpg`);
      const file = studentFolder.createFile(blob);

      try {
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      } catch (shareErr) {
        // Домен может запрещать публикацию по ссылке — работу всё равно сохраняем.
      }

      const id = file.getId();
      photos.push({
        name: file.getName(),
        fileId: id,
        viewUrl: "https://drive.google.com/file/d/" + id + "/view",
        thumbUrl: "https://drive.google.com/thumbnail?id=" + id + "&sz=w1600"
      });
    });

    folderUrl = studentFolder.getUrl();
    folderId = studentFolder.getId();
  }

  // Запись результата в лист Results
  const resSheet = getOrCreateResultsSheet(ss);
  const breakdownStr = detailedResults
    .map(r => `№${r.num}: "${r.student_answer}" [${r.points}/${r.max_points}]`)
    .join(" | ");

  const photosPayload = {
    photos: photos,
    answers_json: studentAnswers,
    folder_url: folderUrl,
    folder_id: folderId
  };

  const status = part2Tasks.length > 0 ? "На проверке Ч.2" : "Проверено";
  resSheet.appendRow([
    new Date(),
    data.variant_id,
    data.student_name || "Не указано",
    data.student_grade || "",
    data.time_spent_minutes || "",
    totalPointsPart1,
    maxPointsPart1,
    folderUrl,
    breakdownStr,
    attemptId,
    "{}",
    0,
    totalPointsPart1,
    "",
    status,
    JSON.stringify(photosPayload),
    ""
  ]);

  return {
    ok: true,
    attempt_id: attemptId,
    variant_id: data.variant_id,
    score_part1: totalPointsPart1,
    max_part1: maxPointsPart1,
    status: status,
    photos: photos,
    folder_url: folderUrl,
    results: detailedResults
  };
}

/**
 * Возвращает все сданные работы, включая старые строки, где заполнены только A–I.
 * Новые работы идут первыми.
 */
function listAttempts() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Results");
  if (!sheet) return { ok: true, attempts: [], count: 0 };

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: true, attempts: [], count: 0 };

  const lastCol = Math.max(17, sheet.getLastColumn());
  const rows = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const attempts = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowIndex = i + 2;
    let photosPayload = parseJsonSafe(row[15], {});
    if (Array.isArray(photosPayload)) photosPayload = { photos: photosPayload };
    if (!photosPayload || typeof photosPayload !== "object") photosPayload = {};

    const part2Scores = parseJsonSafe(row[10], {});
    let photos = Array.isArray(photosPayload.photos) ? photosPayload.photos : [];
    let folderUrl = String(row[7] || "").trim() || photosPayload.folder_url || "";
    let folderId = String(photosPayload.folder_id || "").trim();

    // Старые строки (до появления колонки P) хранят только ссылку на папку
    // в колонке H. Один раз читаем папку через DriveApp и кэшируем список
    // файлов в P, чтобы следующие запросы не обращались к Google Диску.
    if (photos.length === 0 && folderUrl && !photosPayload.photos_synced_at) {
      const scanned = loadDrivePhotos(folderUrl);
      if (scanned.ok) {
        photos = scanned.photos;
        folderId = scanned.folderId || folderId;
        photosPayload = Object.assign({}, photosPayload, {
          photos: photos,
          folder_url: folderUrl,
          folder_id: folderId,
          photos_synced_at: new Date().toISOString()
        });
        try {
          sheet.getRange(rowIndex, 16).setValue(JSON.stringify(photosPayload));
        } catch (cacheErr) {
          // Недоступная для записи ячейка не должна ломать журнал.
        }
      }
    }

    const answersJson = photosPayload.answers_json && typeof photosPayload.answers_json === "object"
      ? photosPayload.answers_json
      : {};

    let status = String(row[14] || "").trim();
    if (!status) {
      const hasPart2Result = String(row[11] || "").trim() !== "" ||
        String(row[12] || "").trim() !== "" ||
        String(row[13] || "").trim() !== "";
      status = hasPart2Result ? "Проверено" : "На проверке Ч.2";
    }

    attempts.push({
      row_index: rowIndex,
      attempt_id: String(row[9] || "").trim() || ("ROW_" + rowIndex),
      date: toIsoDate(row[0]),
      variant_id: String(row[1] || "").trim(),
      student_name: String(row[2] || "").trim(),
      student_grade: String(row[3] || "").trim(),
      time_spent_minutes: row[4],
      score_part1: Number(row[5]) || 0,
      max_part1: Number(row[6]) || 0,
      folder_url: folderUrl,
      breakdown: String(row[8] || "").trim(),
      part2_scores: part2Scores,
      score_part2: String(row[11] || "").trim() === "" ? 0 : Number(row[11]) || 0,
      total_primary: String(row[12] || "").trim() === "" ? null : Number(row[12]),
      secondary_score: String(row[13] || "").trim() === "" ? null : row[13],
      status: status,
      photos: photos,
      answers_json: answersJson,
      teacher_comment: String(row[16] || "").trim()
    });
  }

  attempts.sort(function (a, b) {
    const da = Date.parse(a.date) || 0;
    const db = Date.parse(b.date) || 0;
    return (db - da) || (b.row_index - a.row_index);
  });

  return { ok: true, attempts: attempts, count: attempts.length, sheet_url: ss.getUrl() };
}

function extractDriveRef(value) {
  const text = String(value || "").trim();
  if (!text) return null;

  let match = text.match(/\/folders\/([A-Za-z0-9_-]{10,})/);
  if (match) return { id: match[1], kind: "folder" };

  match = text.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/);
  if (match) return { id: match[1], kind: "file" };

  match = text.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  if (match) return { id: match[1], kind: "unknown" };

  return null;
}

function drivePhotoFromFile(file) {
  const id = file.getId();
  return {
    name: file.getName(),
    fileId: id,
    mimeType: file.getMimeType() || "image/jpeg",
    viewUrl: "https://drive.google.com/file/d/" + id + "/view",
    thumbUrl: "https://drive.google.com/thumbnail?id=" + id + "&sz=w1600"
  };
}

function loadDrivePhotos(folderUrl) {
  const ref = extractDriveRef(folderUrl);
  if (!ref) return { ok: false, error: "В ссылке не найден ID папки Google Диска." };

  if (ref.kind === "file") {
    try {
      return { ok: true, folderId: "", photos: [drivePhotoFromFile(DriveApp.getFileById(ref.id))] };
    } catch (err) {
      return { ok: false, error: err.toString() };
    }
  }

  try {
    const folder = DriveApp.getFolderById(ref.id);
    const iterator = folder.getFiles();
    const photos = [];
    while (iterator.hasNext()) {
      const file = iterator.next();
      const mimeType = String(file.getMimeType() || "").toLowerCase();
      if (mimeType.indexOf("image/") !== 0) continue;
      photos.push(drivePhotoFromFile(file));
    }
    photos.sort(function (a, b) {
      return String(a.name).localeCompare(String(b.name), "ru", { numeric: true });
    });
    return { ok: true, folderId: ref.id, photos: photos };
  } catch (folderErr) {
    if (ref.kind === "unknown") {
      try {
        return { ok: true, folderId: "", photos: [drivePhotoFromFile(DriveApp.getFileById(ref.id))] };
      } catch (fileErr) {
        return { ok: false, error: folderErr.toString() };
      }
    }
    return { ok: false, error: folderErr.toString() };
  }
}

/**
 * Возвращает содержимое файла с Google Диска в виде data URL.
 * Используется прокси-сервером админки: файлы могут быть приватными,
 * поэтому прямой thumbUrl в браузере не всегда открывается.
 */
function getPhoto(data) {
  const fileId = String((data && data.fileId) || "").trim();
  if (!fileId) return { ok: false, error: "Не передан параметр fileId." };

  try {
    const file = DriveApp.getFileById(fileId);
    const blob = file.getBlob();
    const mimeType = blob.getContentType() || file.getMimeType() || "application/octet-stream";
    const base64 = Utilities.base64Encode(blob.getBytes());
    return {
      ok: true,
      fileId: fileId,
      name: file.getName(),
      mimeType: mimeType,
      dataUrl: "data:" + mimeType + ";base64," + base64
    };
  } catch (err) {
    return { ok: false, error: "Не удалось прочитать файл Google Диска: " + err.toString() };
  }
}

/**
 * Сохраняет баллы Части 2, итоговые баллы и комментарий преподавателя.
 * Работа ищется по attempt_id (колонка J) или по row_index.
 */
function gradePart2(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Results");
  if (!sheet) return { ok: false, error: "Лист Results не найден." };

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: false, error: "В листе Results нет сданных работ." };

  const rowIndex = findAttemptRow(sheet, data.attempt_id, data.row_index, lastRow);
  if (!rowIndex) {
    return { ok: false, error: "Работа не найдена. Передайте attempt_id или row_index." };
  }

  const row = sheet.getRange(rowIndex, 1, 1, 17).getValues()[0];
  const part2Scores = normalizeScores(data.part2_scores);
  let scorePart2 = Number(data.score_part2);
  if (!isFinite(scorePart2)) {
    scorePart2 = Object.keys(part2Scores).reduce(function (sum, key) {
      return sum + (Number(part2Scores[key]) || 0);
    }, 0);
  }

  const part1 = Number(row[5]) || 0;
  let totalPrimary = Number(data.total_primary);
  if (!isFinite(totalPrimary)) totalPrimary = part1 + scorePart2;

  const secondaryScore = (data.secondary_score === undefined || data.secondary_score === null ||
    String(data.secondary_score).trim() === "") ? row[13] : data.secondary_score;
  const teacherComment = (data.teacher_comment === undefined || data.teacher_comment === null)
    ? String(row[16] || "")
    : String(data.teacher_comment);
  const attemptId = String(row[9] || "").trim() || String(data.attempt_id || "").trim() || ("ROW_" + rowIndex);

  sheet.getRange(rowIndex, 10, 1, 8).setValues([[
    attemptId,
    JSON.stringify(part2Scores),
    scorePart2,
    totalPrimary,
    secondaryScore,
    "Проверено",
    row[15],
    teacherComment
  ]]);

  return {
    ok: true,
    row_index: rowIndex,
    attempt_id: attemptId,
    part2_scores: part2Scores,
    score_part2: scorePart2,
    total_primary: totalPrimary,
    secondary_score: secondaryScore,
    status: "Проверено",
    teacher_comment: teacherComment
  };
}

function findAttemptRow(sheet, attemptId, rawRowIndex, lastRow) {
  const rowIndex = Number(rawRowIndex);
  if (Number.isInteger(rowIndex) && rowIndex >= 2 && rowIndex <= lastRow) return rowIndex;

  const id = String(attemptId || "").trim();
  if (!id) return 0;

  const rowMatch = id.match(/^ROW_(\d+)$/);
  if (rowMatch) {
    const parsed = Number(rowMatch[1]);
    if (parsed >= 2 && parsed <= lastRow) return parsed;
  }

  const ids = sheet.getRange(2, 10, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0] || "").trim() === id) return i + 2;
  }
  return 0;
}

function getOrCreateResultsSheet(ss) {
  let sheet = ss.getSheetByName("Results");
  if (!sheet) {
    sheet = ss.insertSheet("Results");
    sheet.appendRow(RESULTS_HEADERS);
    sheet.getRange(1, 1, 1, RESULTS_HEADERS.length).setFontWeight("bold");
    return sheet;
  }

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(RESULTS_HEADERS);
    sheet.getRange(1, 1, 1, RESULTS_HEADERS.length).setFontWeight("bold");
    return sheet;
  }

  const first = sheet.getRange(1, 1, 1, RESULTS_HEADERS.length).getValues()[0];
  if (!String(first[0] || "").trim()) {
    sheet.getRange(1, 1, 1, 9).setValues([RESULTS_HEADERS.slice(0, 9)]);
    sheet.getRange(1, 1, 1, 9).setFontWeight("bold");
  }

  const extra = first.slice(9);
  if (extra.some(function (value) { return !String(value || "").trim(); })) {
    sheet.getRange(1, 10, 1, 8).setValues([RESULTS_HEADERS.slice(9)]);
    sheet.getRange(1, 10, 1, 8).setFontWeight("bold");
  }

  return sheet;
}

function generateAttemptId() {
  const stamp = new Date().getTime();
  const random = Math.floor(Math.random() * 1679616).toString(36).toUpperCase();
  return "ATT_" + stamp + "_" + ("00000" + random).slice(-5);
}

function normalizeScores(raw) {
  let value = raw;
  if (typeof value === "string") value = parseJsonSafe(value, {});
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  Object.keys(value).forEach(function (key) {
    const num = Number(value[key]);
    if (isFinite(num)) result[String(key)] = num;
  });
  return result;
}

function parseJsonSafe(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch (err) {
    return fallback;
  }
}

function toIsoDate(value) {
  if (value instanceof Date) return value.toISOString();
  if (!value) return "";
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

// 3. Строгие правила оценивания ФИПИ (ЕГЭ / ОГЭ по физике)
function gradePhysicsTask(studentRaw, keyRaw, rule, maxPoints) {
  if (!studentRaw) return 0;

  const cleanStudent = studentRaw.replace(/\s+/g, "");
  const cleanKey = keyRaw.replace(/\s+/g, "");

  // Числовой ответ (1 балл)
  if (rule === "numeric") {
    const sNorm = cleanStudent.replace(/,/g, ".");
    const kNorm = cleanKey.replace(/,/g, ".");
    if (sNorm === kNorm) return maxPoints;
    const sNum = Number(sNorm);
    const kNum = Number(kNorm);
    if (!isNaN(sNum) && !isNaN(kNum) && Math.abs(sNum - kNum) < 1e-9) return maxPoints;
    return 0;
  }

  // Показание прибора с погрешностью — задание 19 ЕГЭ (например: 0,40,1)
  if (rule === "measurement") {
    const sNorm = cleanStudent.replace(/\./g, ",");
    const kNorm = cleanKey.replace(/\./g, ",");
    return sNorm === kNorm ? maxPoints : 0;
  }

  // Строгая последовательность цифр (соответствие А-Б, изменение величин: задания 6, 10, 15, 17)
  if (rule === "ordered_sequence") {
    // По спецификации ФИПИ: если символов больше требуемого -> 0 баллов
    if (cleanStudent.length > cleanKey.length) return 0;

    if (cleanStudent === cleanKey) return maxPoints;

    // Если задание 2-балльное и длина совпадает (или короче на 1 символ), считаем количество ошибок по позициям
    if (maxPoints === 2 && cleanStudent.length === cleanKey.length) {
      let diffs = 0;
      for (let i = 0; i < cleanKey.length; i++) {
        if (cleanStudent[i] !== cleanKey[i]) diffs++;
      }
      if (diffs === 1) return 1;
    }
    return 0;
  }

  // Множественный выбор без учета порядка (задания 5, 9, 14, 18 на 2 балла; задание 20 на 1 балл)
  if (rule === "unordered_set") {
    const sChars = cleanStudent.split("");
    const sSet = new Set(sChars);
    const kSet = new Set(cleanKey.split(""));

    // Если ученик продублировал одну и ту же цифру (например, "224") -> нарушение формата
    if (sChars.length !== sSet.size) return 0;

    let missingCount = 0; // сколько верных цифр не указано
    for (const k of kSet) {
      if (!sSet.has(k)) missingCount++;
    }

    let extraCount = 0; // сколько лишних (неверных) цифр указано
    for (const s of sSet) {
      if (!kSet.has(s)) extraCount++;
    }

    // Полное совпадение множеств
    if (missingCount === 0 && extraCount === 0) return maxPoints;

    // Для 1-балльных заданий (например, №20 в ЕГЭ) частичный балл не предусмотрен
    if (maxPoints === 1) return 0;

    // Для 2-балльных заданий (5, 9, 14, 18): 1 балл ставится, если:
    // а) указаны все верные + 1 лишний символ (missing == 0 && extra == 1)
    // б) отсутствует 1 верный символ и нет лишних (missing == 1 && extra == 0)
    // в) 1 верный символ заменен на 1 неверный (missing == 1 && extra == 1)
    if (
      (missingCount === 0 && extraCount === 1) ||
      (missingCount === 1 && extraCount === 0) ||
      (missingCount === 1 && extraCount === 1)
    ) {
      return 1;
    }
    return 0;
  }

  return cleanStudent === cleanKey ? maxPoints : 0;
}

function getOrCreateRootFolder() {
  const folders = DriveApp.getFoldersByName(FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(FOLDER_NAME);
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
