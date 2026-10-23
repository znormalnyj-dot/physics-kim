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

function doGet(e) {
  const params = (e && e.parameter) || {};
  const action = String(params.action || "").trim();

  try {
    // Публичный манифест варианта для веб-бланка на внешнем хостинге
    // (GitHub Pages / Vercel / Netlify). Ответ не содержит ответов и решений.
    if (action === "get_manifest") {
      return jsonResponse(getPublicManifest(params.v));
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

  // Сохранение фотографий Части 2 на Google Диск
  let folderUrl = "Без фото 2-й части";
  if (data.photos && data.photos.length > 0) {
    const rootFolder = getOrCreateRootFolder();
    const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd_HH-mm");
    const safeName = (data.student_name || "Ученик").replace(/[^\wа-яА-ЯёЁ\s-]/g, "");
    const studentFolder = rootFolder.createFolder(`${data.variant_id}_${safeName}_${timestamp}`);

    data.photos.forEach((photoObj, idx) => {
      const base64Data = photoObj.dataUrl.split(",")[1];
      const mimeType = photoObj.dataUrl.match(/data:(.*);base64/)[1] || "image/jpeg";
      const blob = Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType, `Part2_Page_${idx + 1}.jpg`);
      studentFolder.createFile(blob);
    });

    folderUrl = studentFolder.getUrl();
  }

  // Запись результата в лист Results
  let resSheet = ss.getSheetByName("Results");
  if (!resSheet) {
    resSheet = ss.insertSheet("Results");
    resSheet.appendRow([
      "Дата и время", "Вариант", "Ученик", "Класс", "Время (мин)",
      "Балл Ч.1", "Макс Ч.1", "Ссылка на фото Ч.2", "Детализация Ч.1 (№: ответ [балл])"
    ]);
    resSheet.getRange("A1:I1").setFontWeight("bold");
  }

  const breakdownStr = detailedResults
    .map(r => `№${r.num}: "${r.student_answer}" [${r.points}/${r.max_points}]`)
    .join(" | ");

  resSheet.appendRow([
    new Date(),
    data.variant_id,
    data.student_name || "Не указано",
    data.student_grade || "",
    data.time_spent_minutes || "",
    totalPointsPart1,
    maxPointsPart1,
    folderUrl,
    breakdownStr
  ]);

  return {
    ok: true,
    variant_id: data.variant_id,
    score_part1: totalPointsPart1,
    max_part1: maxPointsPart1,
    results: detailedResults
  };
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

