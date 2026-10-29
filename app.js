/**
 * Электронный бланк ответов КИМ (Физика ЕГЭ / ОГЭ)
 * Клиентское веб-приложение для прохождения вариантов и отправки в Google Apps Script
 */

(function () {
  'use strict';

  // ── Состояние приложения ───────────────────────────────────────────────────
  let config = { GAS_WEBHOOK_URL: '' };
  let currentVariant = null;
  const studentAnswers = {};
  const attachedPhotos = []; // { id, originalSize, compressedSize, dataUrl }
  let timerInterval = null;
  let timeRemaining = 0;
  let timeSpentSeconds = 0;
  let draftTimestampStart = null; // метка времени начала теста для черновика

  // ── DOM Элементы ──────────────────────────────────────────────────────────
  const elements = {
    examBadge: document.getElementById('examBadge'),
    headerTitle: document.getElementById('headerTitle'),
    variantSubtitle: document.getElementById('variantSubtitle'),
    timerCard: document.getElementById('timerCard'),
    timerDigits: document.getElementById('timerDigits'),
    settingsBtn: document.getElementById('settingsBtn'),

    selectVariantSection: document.getElementById('selectVariantSection'),
    variantCodeInput: document.getElementById('variantCodeInput'),
    loadVariantBtn: document.getElementById('loadVariantBtn'),

    blankContainer: document.getElementById('blankContainer'),
    studentNameInput: document.getElementById('studentNameInput'),
    studentGradeInput: document.getElementById('studentGradeInput'),

    part1Section: document.getElementById('part1Section'),
    part1Progress: document.getElementById('part1Progress'),
    tasksGrid: document.getElementById('tasksGrid'),

    part2Section: document.getElementById('part2Section'),
    part2CountBadge: document.getElementById('part2CountBadge'),
    uploadDropzone: document.getElementById('uploadDropzone'),
    photoFileInput: document.getElementById('photoFileInput'),
    photosGallery: document.getElementById('photosGallery'),

    submitBtn: document.getElementById('submitBtn'),
    footerProgressText: document.getElementById('footerProgressText'),

    resultsSection: document.getElementById('resultsSection'),
    resultsSubtitle: document.getElementById('resultsSubtitle'),
    scoreCurrent: document.getElementById('scoreCurrent'),
    scoreMax: document.getElementById('scoreMax'),
    scorePercentageFill: document.getElementById('scorePercentageFill'),
    scorePercentText: document.getElementById('scorePercentText'),
    part2StatusAlert: document.getElementById('part2StatusAlert'),
    part2DetailsText: document.getElementById('part2DetailsText'),
    resultsTableBody: document.getElementById('resultsTableBody'),
    newAttemptBtn: document.getElementById('newAttemptBtn'),

    confirmModal: document.getElementById('confirmModal'),
    closeConfirmModalBtn: document.getElementById('closeConfirmModalBtn'),
    cancelConfirmBtn: document.getElementById('cancelConfirmBtn'),
    finalSubmitBtn: document.getElementById('finalSubmitBtn'),
    confirmStudentName: document.getElementById('confirmStudentName'),
    confirmStudentGrade: document.getElementById('confirmStudentGrade'),
    confirmPart1Count: document.getElementById('confirmPart1Count'),
    confirmPhotosCount: document.getElementById('confirmPhotosCount'),
    confirmPhotosSummaryItem: document.getElementById('confirmPhotosSummaryItem'),
    unansweredWarning: document.getElementById('unansweredWarning'),

    settingsModal: document.getElementById('settingsModal'),
    gasUrlInput: document.getElementById('gasUrlInput'),
    saveSettingsBtn: document.getElementById('saveSettingsBtn'),
    cancelSettingsBtn: document.getElementById('cancelSettingsBtn'),
    closeSettingsModalBtn: document.getElementById('closeSettingsModalBtn'),

    loadingOverlay: document.getElementById('loadingOverlay'),
    loadingText: document.getElementById('loadingText'),
    toastContainer: document.getElementById('toastContainer')
  };

  // ── Инициализация ─────────────────────────────────────────────────────────
  async function init() {
    await loadConfig();
    setupEventListeners();

    // Проверяем URL-параметр ?v=...
    const urlParams = new URLSearchParams(window.location.search);
    const variantId = urlParams.get('v');

    if (variantId) {
      loadVariant(variantId.trim().toUpperCase());
    } else {
      showVariantSelector();
    }
  }

  // ── Загрузка конфигурации ─────────────────────────────────────────────────
  async function loadConfig() {
    try {
      const resp = await fetch('config.json');
      if (resp.ok) {
        config = await resp.json();
      }
    } catch (e) {
      // Игнорируем ошибку при статическом открытии без config.json
    }

    // Приоритет у LocalStorage
    const savedUrl = localStorage.getItem('GAS_WEBHOOK_URL');
    if (savedUrl) {
      config.GAS_WEBHOOK_URL = savedUrl;
    }
  }

  // ── Обработчики событий ───────────────────────────────────────────────────
  function setupEventListeners() {
    // Выбор варианта
    elements.loadVariantBtn.addEventListener('click', () => {
      const v = elements.variantCodeInput.value.trim().toUpperCase();
      if (v) loadVariant(v);
    });

    elements.variantCodeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const v = elements.variantCodeInput.value.trim().toUpperCase();
        if (v) loadVariant(v);
      }
    });

    document.querySelectorAll('.btn-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const v = btn.getAttribute('data-v');
        if (v) loadVariant(v);
      });
    });

    // Настройки
    elements.settingsBtn.addEventListener('click', openSettingsModal);
    elements.closeSettingsModalBtn.addEventListener('click', closeSettingsModal);
    elements.cancelSettingsBtn.addEventListener('click', closeSettingsModal);
    elements.saveSettingsBtn.addEventListener('click', saveSettings);

    // Модальное окно подтверждения
    elements.submitBtn.addEventListener('click', openConfirmModal);
    elements.closeConfirmModalBtn.addEventListener('click', closeConfirmModal);
    elements.cancelConfirmBtn.addEventListener('click', closeConfirmModal);
    elements.finalSubmitBtn.addEventListener('click', submitExam);

    // Загрузка фото Части 2
    elements.uploadDropzone.addEventListener('click', () => elements.photoFileInput.click());
    elements.photoFileInput.addEventListener('change', handleFilesSelected);

    // Drag and drop для фото
    ['dragenter', 'dragover'].forEach(eventName => {
      elements.uploadDropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        elements.uploadDropzone.classList.add('dragover');
      });
    });

    ['dragleave', 'drop'].forEach(eventName => {
      elements.uploadDropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        elements.uploadDropzone.classList.remove('dragover');
      });
    });

    elements.uploadDropzone.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length) {
        processFiles(Array.from(dt.files));
      }
    });

    // Кнопка начала нового варианта
    elements.newAttemptBtn.addEventListener('click', () => {
      window.location.search = '';
    });

    // Автосохранение черновика при изменении полей регистрации
    elements.studentNameInput.addEventListener('input', saveDraft);
    elements.studentGradeInput.addEventListener('input', saveDraft);
    elements.studentGradeInput.addEventListener('change', saveDraft);
  }

  // ── Загрузка варианта ─────────────────────────────────────────────────────
  // 1) Пытаемся загрузить локальный файл ./variants/<ID>.json.
  // 2) Если его нет (404 на GitHub Pages / Vercel / Netlify) или произошла
  //    сетевая ошибка — запрашиваем публичный манифест из GAS (без ответов).
  async function loadVariant(variantId) {
    const id = String(variantId || '').trim().toUpperCase();
    if (!id) return;

    showLoading('Загрузка структуры варианта...');
    try {
      currentVariant = await fetchManifest(id);
      renderVariant(currentVariant);

      // Обновляем URL без перезагрузки
      const currentUrl = new URL(window.location);
      currentUrl.searchParams.set('v', id);
      window.history.pushState({}, '', currentUrl);
    } catch (err) {
      hideLoading();
      showToast(`Ошибка загрузки: ${err.message}`, 'error');
      showVariantSelector();
    }
  }

  async function fetchManifest(variantId) {
    const localUrl = `./variants/${variantId}.json`;

    try {
      const resp = await fetch(localUrl, { cache: 'no-store' });
      if (resp.ok) {
        const data = await resp.json();
        if (data && Array.isArray(data.tasks) && data.tasks.length > 0) {
          return data;
        }
      }
    } catch (e) {
      // 404, сетевая ошибка или не-JSON (SPA-фолбэк хостинга) — идём в GAS
    }

    return fetchManifestFromGas(variantId);
  }

  async function fetchManifestFromGas(variantId) {
    const webhookUrl = String(
      config.GAS_WEBHOOK_URL || localStorage.getItem('GAS_WEBHOOK_URL') || ''
    ).trim();

    if (!webhookUrl) {
      throw new Error(
        `файл варианта ${variantId} не найден локально, а URL Google Apps Script не задан в настройках.`
      );
    }

    const separator = webhookUrl.indexOf('?') === -1 ? '?' : '&';
    const manifestUrl = webhookUrl + separator +
      'action=get_manifest&v=' + encodeURIComponent(variantId);

    let resp;
    try {
      resp = await fetch(manifestUrl, { method: 'GET', cache: 'no-store' });
    } catch (e) {
      throw new Error(`не удалось связаться с Google Apps Script (${e.message}).`);
    }

    if (!resp.ok) {
      throw new Error(`GAS вернул HTTP ${resp.status} при загрузке варианта ${variantId}.`);
    }

    let data;
    try {
      data = await resp.json();
    } catch (e) {
      throw new Error(`GAS вернул ответ не в формате JSON для варианта ${variantId}.`);
    }

    if (!data || data.ok !== true) {
      throw new Error((data && data.error) || `GAS не вернул манифест варианта ${variantId}.`);
    }
    if (!Array.isArray(data.tasks) || data.tasks.length === 0) {
      throw new Error(`в манифесте варианта ${variantId} нет заданий.`);
    }

    return data;
  }

  function showVariantSelector() {
    elements.selectVariantSection.style.display = 'block';
    elements.blankContainer.style.display = 'none';
    elements.resultsSection.style.display = 'none';
    elements.headerTitle.textContent = 'Электронный бланк ответов';
    elements.variantSubtitle.textContent = 'Выберите вариант для начала работы';
    elements.examBadge.textContent = 'КИМ';
  }

  // ── Отрисовка бланка варианта ─────────────────────────────────────────────
  function renderVariant(variant) {
    hideLoading();
    elements.selectVariantSection.style.display = 'none';
    elements.resultsSection.style.display = 'none';
    elements.blankContainer.style.display = 'block';

    // Шапка
    elements.examBadge.textContent = variant.exam || 'КИМ';
    elements.headerTitle.textContent = variant.title || `Вариант ${variant.variant_id}`;
    elements.variantSubtitle.textContent = `Вариант: ${variant.variant_id}`;

    // Часть 1
    const part1Tasks = variant.tasks.filter(t => t.part === 1);
    elements.tasksGrid.innerHTML = '';

    part1Tasks.forEach(task => {
      const card = createTaskCard(task);
      elements.tasksGrid.appendChild(card);
    });

    updatePart1Progress();

    // Часть 2
    const part2Tasks = variant.tasks.filter(t => t.part === 2);
    if (part2Tasks.length > 0) {
      elements.part2Section.style.display = 'block';
      elements.part2CountBadge.textContent = `Заданий: ${part2Tasks.length}`;
      elements.confirmPhotosSummaryItem.style.display = 'flex';
    } else {
      elements.part2Section.style.display = 'none';
      elements.confirmPhotosSummaryItem.style.display = 'none';
    }

    // Попытка восстановить черновик для текущего варианта
    const draft = loadDraft(variant.variant_id);
    if (draft) {
      // Восстанавливаем поля регистрации
      if (draft.studentName) elements.studentNameInput.value = draft.studentName;
      if (draft.studentGrade) elements.studentGradeInput.value = draft.studentGrade;

      // Восстанавливаем ответы Части 1
      if (draft.answers) {
        Object.entries(draft.answers).forEach(([num, val]) => {
          studentAnswers[num] = val;
          const input = document.getElementById(`input_task_${num}`);
          if (input) {
            input.value = val;
            const card = document.getElementById(`taskCard_${num}`);
            if (card) card.classList.add('filled');
          }
        });
        updatePart1Progress();
      }

      // Восстанавливаем таймер с учётом прошедшего времени
      const durationMinutes = variant.duration_minutes || (variant.exam === 'EGE' ? 235 : 180);
      if (draft.timestampStart) {
        draftTimestampStart = draft.timestampStart;
        const elapsedSeconds = Math.floor((Date.now() - draftTimestampStart) / 1000);
        startTimer(durationMinutes, elapsedSeconds);
      } else {
        draftTimestampStart = Date.now();
        startTimer(durationMinutes);
      }

      showDraftRestoredBanner();
    } else {
      // Новая сессия — фиксируем момент начала
      draftTimestampStart = Date.now();
      const durationMinutes = variant.duration_minutes || (variant.exam === 'EGE' ? 235 : 180);
      startTimer(durationMinutes);
    }
  }

  // ── Карточка задания Части 1 ──────────────────────────────────────────────
  // Красивое форматирование единиц измерения для веб-бланка.
  // База хранит единицы в LaTeX-виде ($\text{м/с}^2$, $^\circ\text{C}$, $\%$),
  // поэтому единицу нужно привести к аккуратному HTML с <sup>.
  function formatUnitHtml(unit) {
    let text = String(unit == null ? '' : unit);
    if (!text.trim()) return '';

    text = text
      .replace(/\u00a0/g, ' ')
      .replace(/\u2009|\u202f/g, ' ')
      .replace(/\\text\s*\{([^{}]*)\}/g, '$1')
      .replace(/\\mathrm\s*\{([^{}]*)\}/g, '$1')
      .replace(/\\operatorname\s*\{([^{}]*)\}/g, '$1')
      // Градусы Цельсия: ^\circ\text{C}, ^{\circ}C, ^\circ C
      .replace(/\^\s*\{?\s*\\circ\s*\}?\s*\\text\s*\{\s*C\s*\}/gi, '°C')
      .replace(/\^\s*\{?\s*\\circ\s*\}?\s*C\b/g, '°C')
      // Остальные градусы
      .replace(/\^\s*\{?\s*\\circ\s*\}?/g, '°')
      .replace(/\\circ(?![A-Za-z])/g, '°')
      .replace(/\\%/g, '%')
      .replace(/\\cdot(?![A-Za-z])/g, '·')
      .replace(/\\times(?![A-Za-z])/g, '×')
      .replace(/\\Omega(?![A-Za-z])/g, 'Ом')
      .replace(/\\mu(?![A-Za-z])/g, 'мк')
      .replace(/\\,|\\;|\\!|\\ /g, ' ')
      .replace(/[{}]/g, '')
      .replace(/\$/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    // Степени: ^2, ^{2}, ^-1, ^{-1} -> <sup>
    text = text.replace(/\^\s*\{?\s*(-?\d+)\s*\}?/g, (match, power) =>
      `<sup>${String(power).replace('-', '−')}</sup>`
    );

    // Уже готовые юникод-степени
    text = text
      .replace(/²/g, '<sup>2</sup>')
      .replace(/³/g, '<sup>3</sup>')
      .replace(/⁻¹/g, '<sup>−1</sup>');

    return text;
  }

  function createTaskCard(task) {
    const card = document.createElement('div');
    card.className = 'task-card';
    card.id = `taskCard_${task.num}`;

    // Подсказка под полем ввода
    let hintText = 'Запишите ответ без пробелов';
    if (task.rule === 'numeric') {
      hintText = 'Целое число или десятичная дробь';
    } else if (task.rule === 'unordered_set') {
      hintText = 'Запишите цифры без пробелов и запятых';
    } else if (task.rule === 'ordered_sequence') {
      hintText = 'Запишите последовательность цифр в нужном порядке';
    } else if (task.rule === 'measurement') {
      hintText = 'Запишите показание и погрешность слитно (например: 0,40,1)';
    }

    const pointsText = task.max_points === 1 ? '1 балл' : `${task.max_points} балла`;
    const unitHtml = formatUnitHtml(task.unit);
    const unitTitle = unitHtml ? unitHtml.replace(/<[^>]+>/g, '') : '';

    card.innerHTML = `
      <div class="task-card-header">
        <span class="task-number-badge">№ ${task.num}</span>
        <span class="task-points-badge">${pointsText}</span>
      </div>
      <div class="fipi-input-row">
        <input type="text"
               class="fipi-answer-input"
               id="input_task_${task.num}"
               data-task="${task.num}"
               placeholder=""
               autocomplete="off"
               spellcheck="false">
        ${unitHtml ? `<span class="fipi-unit-label" title="${escapeHtml(unitTitle)}">${unitHtml}</span>` : ''}
      </div>
      <div class="task-rule-hint">${hintText}</div>
    `;

    const input = card.querySelector('.fipi-answer-input');

    // Форматирование ввода на лету (замена точки на запятую, удаление пробелов)
    input.addEventListener('input', (e) => {
      let val = e.target.value;
      // Автозамена точки на запятую для соответствия бланкам РФ
      val = val.replace(/\./g, ',');
      // Удаление любых пробелов
      val = val.replace(/\s+/g, '');
      e.target.value = val;

      studentAnswers[task.num] = val;

      if (val.length > 0) {
        card.classList.add('filled');
      } else {
        card.classList.remove('filled');
        delete studentAnswers[task.num];
      }

      updatePart1Progress();
      saveDraft();
    });

    return card;
  }

  // ── Прогресс заполнения Части 1 ───────────────────────────────────────────
  function updatePart1Progress() {
    if (!currentVariant) return;
    const part1Tasks = currentVariant.tasks.filter(t => t.part === 1);
    const total = part1Tasks.length;
    let filled = 0;

    part1Tasks.forEach(t => {
      if (studentAnswers[t.num] && studentAnswers[t.num].trim().length > 0) {
        filled++;
      }
    });

    elements.part1Progress.textContent = `Заполнено: ${filled} из ${total}`;
    elements.footerProgressText.textContent = `Заполнено ответов Части 1: ${filled} из ${total}. Фотографий Части 2: ${attachedPhotos.length}.`;
  }

  // ── Таймер экзамена ───────────────────────────────────────────────────────
  function startTimer(durationMinutes, elapsedSeconds) {
    if (timerInterval) clearInterval(timerInterval);

    const elapsed = elapsedSeconds || 0;
    timeRemaining = durationMinutes * 60 - elapsed;
    timeSpentSeconds = elapsed;
    updateTimerDisplay();

    timerInterval = setInterval(() => {
      timeRemaining--;
      timeSpentSeconds++;

      updateTimerDisplay();

      // Визуальные предупреждения
      if (timeRemaining <= 15 * 60 && timeRemaining > 5 * 60) {
        elements.timerCard.classList.add('warning');
        elements.timerCard.classList.remove('danger');
      } else if (timeRemaining <= 5 * 60) {
        elements.timerCard.classList.remove('warning');
        elements.timerCard.classList.add('danger');
      } else {
        elements.timerCard.classList.remove('warning', 'danger');
      }

      if (timeRemaining <= 0) {
        clearInterval(timerInterval);
        showToast('Время экзамена истекло! Отправьте вашу работу.', 'error');
      }
    }, 1000);
  }

  function updateTimerDisplay() {
    const hours = Math.floor(Math.max(0, timeRemaining) / 3600);
    const minutes = Math.floor((Math.max(0, timeRemaining) % 3600) / 60);
    const seconds = Math.max(0, timeRemaining) % 60;

    elements.timerDigits.textContent =
      `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  // ── Обработка и сжатие фотографий Части 2 (Canvas) ────────────────────────
  const MAX_PHOTOS = 10;
  // Безопасный бюджет пакета: тело запроса в GAS не должно приближаться к лимиту.
  const PHOTO_BUDGET_BYTES = 7 * 1024 * 1024;
  let photoQueue = Promise.resolve();

  function photoSignature(file) {
    return [file.name || 'photo', file.size || 0, file.lastModified || 0].join('|');
  }

  // 1–4 фото — максимум качества, 5–10 фото — экономный режим.
  function photoCompressionProfile(count) {
    return count >= 5
      ? { maxSide: 1400, quality: 0.68 }
      : { maxSide: 1600, quality: 0.78 };
  }

  function handleFilesSelected(e) {
    const files = Array.from(e.target.files || []);
    // Сбрасываем input сразу: следующий выбор (лист 2, лист 3) не потеряется.
    e.target.value = '';
    if (!files.length) return;

    // Очередь не даёт параллельным обработкам затереть друг друга.
    photoQueue = photoQueue
      .then(() => processFiles(files))
      .catch((err) => {
        console.error('Ошибка обработки фотографий:', err);
        hideLoading();
      });
  }

  async function processFiles(files) {
    const images = files.filter((file) => file.type.startsWith('image/'));
    if (!images.length) {
      showToast('Выбранные файлы не являются изображениями', 'error');
      return;
    }

    const known = new Set(attachedPhotos.map((photo) => photo.signature));
    const pending = [];
    let duplicates = 0;

    for (const file of images) {
      const signature = photoSignature(file);
      if (known.has(signature)) {
        duplicates++;
        continue;
      }
      known.add(signature);
      pending.push(file);
    }

    const freeSlots = MAX_PHOTOS - attachedPhotos.length;
    if (freeSlots <= 0) {
      showToast(`Можно прикрепить не больше ${MAX_PHOTOS} фотографий`, 'error');
      return;
    }
    if (pending.length > freeSlots) {
      pending.length = freeSlots;
      showToast(`Лимит ${MAX_PHOTOS} фото: лишние файлы не добавлены`, 'error');
    }
    if (!pending.length) {
      showToast(duplicates ? 'Это фото уже прикреплено' : 'Нечего добавлять', 'error');
      return;
    }

    const profile = photoCompressionProfile(attachedPhotos.length + pending.length);

    try {
      for (let index = 0; index < pending.length; index++) {
        const file = pending[index];
        showLoading(`Сжатие фото ${index + 1} из ${pending.length}...`);
        try {
          const compressed = await compressImage(file, profile.maxSide, profile.quality);
          attachedPhotos.push({
            id: 'photo_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
            name: file.name || `photo_${attachedPhotos.length + 1}.jpg`,
            signature: photoSignature(file),
            sourceFile: file,
            maxSide: profile.maxSide,
            quality: profile.quality,
            originalSize: file.size,
            compressedSize: compressed.size,
            dataUrl: compressed.dataUrl
          });
        } catch (err) {
          console.error('Ошибка сжатия:', err);
          showToast(`Не удалось обработать файл ${file.name}`, 'error');
        }
        renderPhotosGallery();
      }

      await shrinkPhotosToBudget();
    } finally {
      renderPhotosGallery();
      updatePart1Progress();
      saveDraft();
      hideLoading();
    }
  }

  function totalPhotosBytes() {
    return attachedPhotos.reduce((sum, photo) => sum + (Number(photo.compressedSize) || 0), 0);
  }

  // Если суммарный пакет превышает бюджет — дожимаем все снимки повторно.
  async function shrinkPhotosToBudget() {
    if (!attachedPhotos.length || totalPhotosBytes() <= PHOTO_BUDGET_BYTES) return;

    let profile = { maxSide: 1200, quality: 0.62 };
    let guard = 0;

    while (totalPhotosBytes() > PHOTO_BUDGET_BYTES && guard < 4) {
      showLoading('Оптимизация пакета фотографий...');
      for (const photo of attachedPhotos) {
        if (!photo.sourceFile) continue;
        try {
          const compressed = await compressImage(photo.sourceFile, profile.maxSide, profile.quality);
          photo.dataUrl = compressed.dataUrl;
          photo.compressedSize = compressed.size;
          photo.maxSide = profile.maxSide;
          photo.quality = profile.quality;
        } catch (err) {
          console.error('Ошибка дополнительного сжатия:', err);
        }
      }
      profile = { maxSide: 1000, quality: Math.max(0.45, profile.quality - 0.08) };
      guard++;
    }

    if (totalPhotosBytes() > PHOTO_BUDGET_BYTES) {
      showToast('Не удалось уложиться в лимит. Прикрепите меньше фотографий.', 'error');
    }
  }

  function compressImage(file, maxSide, quality) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          let width = img.width;
          let height = img.height;

          // Масштабирование с сохранением пропорций
          if (width > maxSide || height > maxSide) {
            if (width > height) {
              height = Math.round((height * maxSide) / width);
              width = maxSide;
            } else {
              width = Math.round((width * maxSide) / height);
              height = maxSide;
            }
          }

          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;

          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);

          const dataUrl = canvas.toDataURL('image/jpeg', quality);
          // Оценка размера base64
          const approxSize = Math.round((dataUrl.length - 22) * 0.75);

          resolve({
            dataUrl,
            size: approxSize,
            width,
            height
          });
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function movePhoto(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= attachedPhotos.length) return;
    const moved = attachedPhotos.splice(index, 1)[0];
    attachedPhotos.splice(target, 0, moved);
    renderPhotosGallery();
    updatePart1Progress();
    saveDraft();
  }

  function removePhoto(index) {
    if (index < 0 || index >= attachedPhotos.length) return;
    attachedPhotos.splice(index, 1);
    renderPhotosGallery();
    updatePart1Progress();
    saveDraft();
  }

  function renderPhotosGallery() {
    elements.photosGallery.innerHTML = '';

    attachedPhotos.forEach((photo, idx) => {
      const card = document.createElement('div');
      card.className = 'photo-card';

      const origMb = (photo.originalSize / (1024 * 1024)).toFixed(1);
      const compKb = Math.max(1, Math.round(photo.compressedSize / 1024));
      const last = idx === attachedPhotos.length - 1;

      card.innerHTML = `
        <div class="photo-thumb-wrap">
          <img src="${photo.dataUrl}" alt="Страница ${idx + 1}" class="photo-thumb">
        </div>
        <button type="button" class="photo-remove-btn" title="Удалить фото" aria-label="Удалить фото">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
        <div class="photo-move-row">
          <button type="button" class="photo-move-btn" data-photo-move="-1" title="Переместить раньше"${idx === 0 ? ' disabled' : ''}>←</button>
          <span class="photo-page-badge">Стр. ${idx + 1}</span>
          <button type="button" class="photo-move-btn" data-photo-move="1" title="Переместить позже"${last ? ' disabled' : ''}>→</button>
        </div>
        <div class="photo-info">
          <span class="photo-size-badge">${origMb} МБ → ${compKb} КБ</span>
        </div>
      `;

      card.querySelector('.photo-remove-btn').addEventListener('click', () => removePhoto(idx));

      const left = card.querySelector('[data-photo-move="-1"]');
      const right = card.querySelector('[data-photo-move="1"]');
      if (left) left.addEventListener('click', () => movePhoto(idx, -1));
      if (right) right.addEventListener('click', () => movePhoto(idx, 1));

      elements.photosGallery.appendChild(card);
    });
  }

  // ── Модальное окно подтверждения ───────────────────────────────────────────
  function openConfirmModal() {
    const studentName = elements.studentNameInput.value.trim();
    if (!studentName) {
      showToast('Пожалуйста, введите фамилию и имя ученика в Бланке регистрации!', 'error');
      elements.studentNameInput.focus();
      elements.studentNameInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    const part1Tasks = currentVariant.tasks.filter(t => t.part === 1);
    let filledCount = 0;
    part1Tasks.forEach(t => {
      if (studentAnswers[t.num] && studentAnswers[t.num].trim().length > 0) filledCount++;
    });

    elements.confirmStudentName.textContent = studentName;
    elements.confirmStudentGrade.textContent = elements.studentGradeInput.value.trim() || 'Не указан';
    elements.confirmPart1Count.textContent = `${filledCount} из ${part1Tasks.length}`;
    elements.confirmPhotosCount.textContent = `${attachedPhotos.length} шт.`;

    if (filledCount < part1Tasks.length) {
      elements.unansweredWarning.style.display = 'block';
    } else {
      elements.unansweredWarning.style.display = 'none';
    }

    elements.confirmModal.style.display = 'flex';
  }

  function closeConfirmModal() {
    elements.confirmModal.style.display = 'none';
  }

  // ── Отправка работы на сервер (GAS Webhook) ─────────────────────────────────
  async function submitExam() {
    closeConfirmModal();

    // Блокируем кнопку сразу, чтобы исключить повторную отправку
    elements.submitBtn.disabled = true;
    elements.finalSubmitBtn.disabled = true;

    showLoading('Отправка работы на сервер...');

    const studentName = elements.studentNameInput.value.trim();
    const studentGrade = elements.studentGradeInput.value.trim();
    const timeSpentMin = Math.max(1, Math.ceil(timeSpentSeconds / 60));

    const payload = {
      action: 'submit_attempt',
      variant_id: currentVariant.variant_id,
      student_name: studentName,
      student_grade: studentGrade,
      time_spent_minutes: timeSpentMin,
      answers: studentAnswers,
      photos: attachedPhotos.map((p, idx) => ({
        page: idx + 1,
        name: p.name,
        dataUrl: p.dataUrl
      }))
    };

    const payloadSize = JSON.stringify(payload).length;
    if (payloadSize > 9 * 1024 * 1024) {
      elements.submitBtn.disabled = false;
      elements.finalSubmitBtn.disabled = false;
      hideLoading();
      showToast('Пакет с фотографиями слишком большой. Удалите лишние снимки и попробуйте снова.', 'error');
      return;
    }

    const webhookUrl = config.GAS_WEBHOOK_URL || localStorage.getItem('GAS_WEBHOOK_URL') || '';

    // Если вебхук настроен — отправляем в GAS
    if (webhookUrl) {
      try {
        // Content-Type: text/plain;charset=utf-8 избегает CORS preflight OPTIONS в Google Apps Script
        const resp = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(payload)
        });

        const data = await resp.json();

        if (data && data.ok) {
          // Удаляем черновик после успешной сдачи
          clearDraft(currentVariant.variant_id);
          hideLoading();
          showResults(data);
          return;
        } else {
          throw new Error(data.error || 'Ошибка при обработке работы на сервере');
        }
      } catch (err) {
        console.error('Ошибка отправки в GAS:', err);
        // Разблокируем кнопку при ошибке, чтобы ученик мог попробовать снова
        elements.submitBtn.disabled = false;
        elements.finalSubmitBtn.disabled = false;
        hideLoading();
        showToast(`Сбой при обращении к серверу: ${err.message}. Проверьте URL в настройках.`, 'error');
        // Предлагаем открыть настройки
        setTimeout(() => openSettingsModal(), 1500);
        return;
      }
    }

    // Если GAS_WEBHOOK_URL не задан, выводим уведомление и предлагаем ввести URL
    elements.submitBtn.disabled = false;
    elements.finalSubmitBtn.disabled = false;
    hideLoading();
    showToast('GAS_WEBHOOK_URL не настроен! Укажите URL скрипта в настройках.', 'error');
    openSettingsModal();
  }

  // ── Отображение результатов проверки ──────────────────────────────────────
  function showResults(data) {
    if (timerInterval) clearInterval(timerInterval);

    elements.blankContainer.style.display = 'none';
    elements.resultsSection.style.display = 'block';
    window.scrollTo({ top: 0, behavior: 'smooth' });

    // Баллы за Часть 1
    const score = Number(data.score_part1) || 0;
    const maxScore = Number(data.max_part1) || 1;
    const percentage = Math.round((score / maxScore) * 100);

    elements.scoreCurrent.textContent = score;
    elements.scoreMax.textContent = maxScore;
    elements.scorePercentageFill.style.width = `${percentage}%`;
    elements.scorePercentText.textContent = `${percentage}% выполнено верно`;

    elements.resultsSubtitle.textContent =
      `Ученик: ${elements.studentNameInput.value.trim()} | Вариант: ${currentVariant.variant_id} | Время: ${Math.ceil(timeSpentSeconds / 60)} мин.`;

    // Статус Части 2
    if (attachedPhotos.length > 0) {
      elements.part2StatusAlert.style.display = 'flex';
      elements.part2DetailsText.textContent =
        `Загружено ${attachedPhotos.length} фото решений. Они сохранены в папку на Google Диске для экспертной проверки преподавателем.`;
    } else {
      const part2Tasks = currentVariant.tasks.filter(t => t.part === 2);
      if (part2Tasks.length > 0) {
        elements.part2StatusAlert.style.display = 'flex';
        elements.part2DetailsText.textContent =
          `Фотографии ко 2-й части не были прикреплены. Экспертная проверка не требуется.`;
      } else {
        elements.part2StatusAlert.style.display = 'none';
      }
    }

    // Таблица результатов Части 1
    elements.resultsTableBody.innerHTML = '';
    const resultsList = data.results || [];

    resultsList.forEach(r => {
      const tr = document.createElement('tr');

      let statusBadge = '';
      if (r.points === r.max_points) {
        statusBadge = `<span class="status-badge status-correct">Верно</span>`;
      } else if (r.points > 0) {
        statusBadge = `<span class="status-badge status-partial">Частично верно</span>`;
      } else {
        statusBadge = `<span class="status-badge status-incorrect">Неверно</span>`;
      }

      const displayAnswer = r.student_answer ? `<code>${escapeHtml(r.student_answer)}</code>` : '<em style="color:#94a3b8">нет ответа</em>';

      tr.innerHTML = `
        <td><strong>№ ${r.num}</strong></td>
        <td>${displayAnswer}</td>
        <td>${statusBadge}</td>
        <td><strong>${r.points}</strong> / ${r.max_points}</td>
      `;

      elements.resultsTableBody.appendChild(tr);
    });
  }

  // ── Черновик: сохранение в localStorage ───────────────────────────────────
  function getDraftKey(variantId) {
    return `kim_draft_${variantId}`;
  }

  function saveDraft() {
    if (!currentVariant) return;
    const draft = {
      studentName: elements.studentNameInput.value,
      studentGrade: elements.studentGradeInput.value,
      answers: Object.assign({}, studentAnswers),
      timestampStart: draftTimestampStart
    };
    try {
      localStorage.setItem(getDraftKey(currentVariant.variant_id), JSON.stringify(draft));
    } catch (e) {
      // localStorage недоступен или переполнен — игнорируем
    }
  }

  function loadDraft(variantId) {
    try {
      const raw = localStorage.getItem(getDraftKey(variantId));
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function clearDraft(variantId) {
    try {
      localStorage.removeItem(getDraftKey(variantId));
    } catch (e) {}
  }

  function showDraftRestoredBanner() {
    // Создаём ненавязчивую плашку-баннер под шапкой
    const existing = document.getElementById('draftRestoredBanner');
    if (existing) existing.remove();

    const banner = document.createElement('div');
    banner.id = 'draftRestoredBanner';
    banner.style.cssText = [
      'position:fixed', 'top:70px', 'left:50%', 'transform:translateX(-50%)',
      'background:#1e3a5f', 'color:#93c5fd', 'border:1px solid #2563eb',
      'border-radius:8px', 'padding:8px 20px', 'font-size:13px',
      'box-shadow:0 4px 16px rgba(0,0,0,0.4)', 'z-index:9999',
      'display:flex', 'align-items:center', 'gap:8px', 'pointer-events:none'
    ].join(';');
    banner.innerHTML =
      '<svg style="width:16px;height:16px;flex-shrink:0" viewBox="0 0 24 24" fill="none" stroke="#93c5fd" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>' +
      '<span>Черновик ответов восстановлен</span>';
    document.body.appendChild(banner);

    setTimeout(() => {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => banner.remove(), 400);
    }, 3500);
  }

  // ── Настройки (Модальное окно GAS URL) ────────────────────────────────────
  function openSettingsModal() {
    elements.gasUrlInput.value = config.GAS_WEBHOOK_URL || localStorage.getItem('GAS_WEBHOOK_URL') || '';
    elements.settingsModal.style.display = 'flex';
  }

  function closeSettingsModal() {
    elements.settingsModal.style.display = 'none';
  }

  function saveSettings() {
    const url = elements.gasUrlInput.value.trim();
    config.GAS_WEBHOOK_URL = url;
    localStorage.setItem('GAS_WEBHOOK_URL', url);
    closeSettingsModal();
    showToast('Настройки вебхука успешно сохранены!', 'success');
  }

  // ── Вспомогательные утилиты ───────────────────────────────────────────────
  function showLoading(text) {
    elements.loadingText.textContent = text || 'Загрузка...';
    elements.loadingOverlay.style.display = 'flex';
  }

  function hideLoading() {
    elements.loadingOverlay.style.display = 'none';
  }

  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type === 'error' ? 'toast-error' : (type === 'success' ? 'toast-success' : '')}`;
    toast.textContent = message;
    elements.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Запуск приложения
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

