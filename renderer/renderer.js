let monacoEditor = null;
let monacoReady = false;
const pendingTabs = [];
let tabs = [];
let activeTabId = null;
let currentSettings = {
  theme: 'dark',
  fontFamily: 'Consolas',
  fontSize: 14,
  recentFiles: []
};
let removeMaximizeListener = null;

// --- Утилиты ---
function escapeHtml(text) {
  if (text == null) return '';
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return String(text).replace(/[&<>"']/g, m => map[m]);
}

function generateId() {
  return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function getLanguageFromPath(filePath) {
  if (!filePath) return 'plaintext';
  const ext = filePath.split('.').pop().toLowerCase();
  const map = {
    js: 'javascript',
    html: 'html',
    css: 'css',
    md: 'markdown',
    lua: 'lua',
    txt: 'plaintext'
  };
  return map[ext] || 'plaintext';
}

// --- Инициализация ---
async function initApp() {
  try {
    const saved = await window.electronAPI.loadSettings();
    // ФИКС: раньше настройки применялись только если в файле было поле theme,
    // из-за чего валидные fontFamily/fontSize из settings.json могли игнорироваться.
    if (saved && typeof saved === 'object') {
      currentSettings = { ...currentSettings, ...saved };
    }
  } catch (e) { console.warn('Could not load settings', e); }

  // Список недавних файлов подгружается асинхронно вместе с настройками —
  // перерисовываем сайдбар, чтобы он отразил уже загруженный список
  // (при первом вызове в DOMContentLoaded currentSettings.recentFiles
  // ещё пуст по умолчанию).
  renderSidebar();

  document.body.className = `theme-${currentSettings.theme}`;
  document.getElementById('fontSelect').value = currentSettings.fontFamily;
  document.getElementById('sizeSelect').value = currentSettings.fontSize;

  require.config({ paths: { vs: 'vs' } });
  require(['vs/editor/editor.main'], () => {
    defineMonacoTheme();
    monacoReady = true;
    pendingTabs.forEach(({ title, filePath, content, language }) => createNewTab(title, filePath, content, language));
    pendingTabs.length = 0;
    if (tabs.length === 0) createNewTab('Welcome');
  });

  removeMaximizeListener = window.electronAPI.onMaximizeChange((isMaximized) => {
    document.getElementById('maxBtn').textContent = isMaximized ? '❐' : '□';
  });

  // Обработчики закрытия приложения
  window.electronAPI.onQueryUnsaved(() => {
    const hasUnsaved = tabs.some(t => t.dirty);
    window.electronAPI.sendCanClose(hasUnsaved);
  });

  window.electronAPI.onDoSaveAndClose(async () => {
    // ФИКС: раньше сохранялась только активная вкладка (saveCurrentTab()
    // без аргумента), хотя проверка hasUnsaved смотрит на ВСЕ вкладки.
    // Если несохранённые изменения были в неактивной вкладке, они молча
    // терялись при закрытии приложения. Теперь сохраняем все "грязные"
    // вкладки по очереди.
    const success = await saveAllDirtyTabs();
    if (success) {
      window.electronAPI.notifySaveDoneClose();
    }
  });
}

// ФИКС: новая функция — сохраняет все вкладки с несохранёнными
// изменениями (а не только текущую активную). Останавливается и
// возвращает false, если сохранение какой-то вкладки не удалось
// (например, пользователь отменил диалог "Save As") — в этом случае
// приложение не закроется, и пользователь сможет попробовать снова.
async function saveAllDirtyTabs() {
  const dirtyTabs = tabs.filter(t => t.dirty);
  for (const tab of dirtyTabs) {
    const success = await saveCurrentTab(tab);
    if (!success) return false;
  }
  return true;
}

function defineMonacoTheme() {
  monaco.editor.defineTheme('midnight-custom', {
    base: 'vs-dark',
    inherit: true,
    rules: [{ token: '', foreground: '#c3cee8' }],
    colors: {
      // ФИКС: было '#202225' (непрозрачный) — Monaco рисовал этим цветом
      // сплошной фон поверх всего editor-container, из-за чего градиент,
      // заданный на body.theme-midnight в style.css, был полностью
      // перекрыт и никогда не показывался. Прозрачный фон (+ прозрачный
      // левый margin с номерами строк) позволяет градиенту проступать
      // сквозь область редактора.
      'editor.background': '#20222500',
      'editorGutter.background': '#00000000',
      'minimap.background': '#20222500',
      'editor.foreground': '#c3cee8',
      'editor.lineHighlightBackground': '#2f3136',
      'editor.selectionBackground': '#5865f2',
      'editorCursor.foreground': '#5865f2'
    }
  });
}

function getMonacoTheme() {
  if (currentSettings.theme === 'light') return 'vs';
  if (currentSettings.theme === 'midnight') return 'midnight-custom';
  return 'vs-dark';
}

// --- Управление вкладками ---
// ФИКС: добавлен отдельный параметр `language`, не зависящий от `filePath`.
// Раньше для элементов сайдбара в filePath передавалось выдуманное имя файла
// только ради подсветки синтаксиса, но оно же сохранялось в tab.path и
// использовалось при Ctrl+S как реальный путь для записи на диск.
function createNewTab(title = null, filePath = null, content = '', language = null) {
  if (!monacoReady) {
    pendingTabs.push({ title, filePath, content, language });
    return;
  }

  const id = generateId();
  const resolvedLanguage = language || getLanguageFromPath(filePath);
  const model = monaco.editor.createModel(content, resolvedLanguage);
  const tab = {
    id,
    title: title || (filePath ? filePath.split(/[\\/]/).pop() : 'Untitled'),
    path: filePath,
    model,
    dirty: false,
    savedContent: content, // базовое содержимое для сравнения (последнее открытое/сохранённое)
    lastSaved: filePath ? Date.now() : null
  };

  // ФИКС: раньше dirty был флагом "было хоть одно изменение" и никогда
  // не сбрасывался обратно. Из-за этого, например, если что-то напечатать
  // и затем полностью стереть (вернувшись к пустому файлу), вкладка
  // всё равно считалась "грязной", и при закрытии приложение спрашивало
  // про сохранение пустого файла. Теперь dirty — это сравнение текущего
  // содержимого с последним сохранённым/открытым (savedContent): если
  // текст вернулся к исходному состоянию (в том числе к пустому), точка
  // "•" пропадает и предупреждение о несохранённых изменениях не всплывает.
  model.onDidChangeContent(() => {
    const isDirtyNow = model.getValue() !== tab.savedContent;
    if (isDirtyNow !== tab.dirty) {
      tab.dirty = isDirtyNow;
      renderTabs();
    }
  });

  tabs.push(tab);
  renderTabs();
  switchTab(id);
}

async function closeTab(id, e) {
  if (e) e.stopPropagation();
  const tab = tabs.find(t => t.id === id);
  if (!tab) return;

  if (tab.dirty) {
    // Предлагаем сохранить или отбросить изменения
    const shouldSave = confirm(`Save changes to "${tab.title}"? Press OK to save, Cancel to discard.`);
    if (shouldSave) {
      const saved = await saveCurrentTab(tab);
      if (!saved) return; // не удалось сохранить – отмена закрытия
    }
    // если shouldSave == false – закрываем без сохранения
  }

  if (tabs.length <= 1) {
    // Очищаем единственную вкладку
    if (tab.model && !tab.model.isDisposed()) {
      tab.model.setValue('');
    }
    tab.title = 'Untitled';
    tab.path = null;
    tab.dirty = false;
    tab.savedContent = '';
    renderTabs();
    return;
  }

  const index = tabs.findIndex(t => t.id === id);
  tabs.splice(index, 1);
  if (tab.model && !tab.model.isDisposed()) tab.model.dispose();

  if (activeTabId === id) {
    const newActive = tabs[Math.min(index, tabs.length - 1)];
    if (newActive) switchTab(newActive.id);
  }
  renderTabs();
}

function switchTab(id) {
  if (!monacoReady) return;
  if (activeTabId === id) return;

  if (monacoEditor) {
    monacoEditor.setModel(null);
  }

  activeTabId = id;
  const tab = tabs.find(t => t.id === id);
  if (!tab) return;

  const empty = document.getElementById('emptyState');
  if (empty) empty.style.display = 'none';

  if (!monacoEditor) {
    monacoEditor = monaco.editor.create(document.getElementById('editorContainer'), {
      model: tab.model,
      automaticLayout: true,
      theme: getMonacoTheme(),
      fontSize: currentSettings.fontSize,
      fontFamily: currentSettings.fontFamily
    });
  } else {
    monacoEditor.setModel(tab.model);
    monacoEditor.updateOptions({
      fontSize: currentSettings.fontSize,
      fontFamily: currentSettings.fontFamily
    });
    monacoEditor.layout();
  }
  updateTabHighlight();
}

function renderTabs() {
  const container = document.getElementById('tabsContainer');
  container.innerHTML = '';
  tabs.forEach(tab => {
    const div = document.createElement('div');
    div.className = 'tab' + (tab.id === activeTabId ? ' active' : '');
    div.dataset.id = tab.id;
    div.innerHTML = `<span class="tab-title" title="${escapeHtml(tab.path || '')}">${escapeHtml(tab.title)}${tab.dirty ? ' •' : ''}</span> <span class="close-tab">&times;</span>`;
    div.querySelector('.close-tab').addEventListener('click', (e) => closeTab(tab.id, e));
    div.addEventListener('click', () => switchTab(tab.id));
    div.querySelector('.tab-title').addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startRenameTab(tab, div.querySelector('.tab-title'));
    });
    container.appendChild(div);
  });
}

function startRenameTab(tab, titleSpan) {
  let renameDone = false;
  const input = document.createElement('input');
  input.value = tab.title;
  input.className = 'tab-rename-input';
  Object.assign(input.style, {
    background: 'var(--bg-tab)',
    color: 'var(--text)',
    border: '1px solid var(--accent)',
    borderRadius: '3px',
    padding: '0 4px',
    width: '120px'
  });
  titleSpan.replaceWith(input);
  input.focus();
  input.select();

  const finish = () => {
    if (renameDone) return;
    renameDone = true;
    const newTitle = input.value.trim() || tab.title;
    tab.title = newTitle;
    // Если у вкладки был путь к файлу, переименование отсоединяет её от файла
    if (tab.path) {
      tab.path = null;
      tab.dirty = true;
    }
    input.replaceWith(titleSpan);
    titleSpan.textContent = newTitle + (tab.dirty ? ' •' : '');
  };
  input.addEventListener('blur', finish);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(); }
    if (e.key === 'Escape') { input.value = tab.title; finish(); }
  });
}

function updateTabHighlight() {
  document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
  if (activeTabId) {
    const active = document.querySelector(`.tab[data-id="${activeTabId}"]`);
    if (active) active.classList.add('active');
  }
}

// --- Недавние файлы ---
function addRecentFile(filePath) {
  if (!filePath) return;
  const list = (currentSettings.recentFiles || []).filter(f => f.path !== filePath);
  list.unshift({ path: filePath, timestamp: Date.now() });
  currentSettings.recentFiles = list.slice(0, 20); // ограничиваем длину списка
  window.electronAPI.saveSettingsSync(currentSettings);
  renderSidebar(document.getElementById('searchInput').value);
}

// --- Файловые операции ---
async function openFileDialog() {
  // ФИКС: раньше при !monacoReady функция выходила до открытия диалога,
  // и клик "Open" в первые секунды после старта приложения просто ничего
  // не делал без какой-либо обратной связи для пользователя.
  // Теперь диалог открывается всегда, а результат при необходимости
  // уходит в ту же очередь pendingTabs, что и createNewTab.
  const file = await window.electronAPI.openFile();
  if (!file) return;

  const existing = tabs.find(t => t.path === file.path);
  if (existing) {
    if (existing.model && !existing.model.isDisposed()) {
      existing.model.setValue(file.content);
    }
    existing.dirty = false;
    existing.savedContent = file.content;
    switchTab(existing.id);
    addRecentFile(file.path);
    return;
  }

  const filename = file.path.split(/[\\/]/).pop();
  createNewTab(filename, file.path, file.content);
  addRecentFile(file.path);
}

async function saveCurrentTab(tabOverride) {
  if (!monacoEditor && !tabOverride) return false;
  const tab = tabOverride || tabs.find(t => t.id === activeTabId);
  if (!tab || !tab.model || tab.model.isDisposed()) return false;
  const content = tab.model.getValue();

  if (tab.path) {
    const success = await window.electronAPI.saveToPath(tab.path, content);
    if (success) {
      tab.dirty = false;
      tab.savedContent = content;
      tab.lastSaved = Date.now();
      renderTabs();
      addRecentFile(tab.path);
      return true;
    }
    return false;
  } else {
    const newPath = await window.electronAPI.saveFile({ defaultName: tab.title, content });
    if (newPath) {
      tab.path = newPath;
      tab.title = newPath.split(/[\\/]/).pop();
      tab.dirty = false;
      tab.savedContent = content;
      tab.lastSaved = Date.now();
      renderTabs();
      addRecentFile(newPath);
      return true;
    }
    return false;
  }
}

function clearEditor() {
  if (!monacoEditor) return;
  const model = monacoEditor.getModel();
  if (!model || model.isDisposed()) return;
  const fullRange = model.getFullModelRange();
  monacoEditor.executeEdits('clear', [{ range: fullRange, text: '' }]);
  monacoEditor.focus();
}

// --- Горячие клавиши ---
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey) {
    switch (e.key.toLowerCase()) {
      case 's': e.preventDefault(); saveCurrentTab(); break;
      case 'o': e.preventDefault(); openFileDialog(); break;
      case 'n': e.preventDefault(); createNewTab(); break;
    }
  }
});

// --- Старт ---
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('minBtn').addEventListener('click', () => window.electronAPI.minimize());
  document.getElementById('maxBtn').addEventListener('click', () => window.electronAPI.maximize());
  document.getElementById('closeBtn').addEventListener('click', () => window.electronAPI.close());

  document.getElementById('newTabBtn').addEventListener('click', () => createNewTab());
  document.getElementById('btnNew').addEventListener('click', () => createNewTab());
  document.getElementById('btnOpen').addEventListener('click', openFileDialog);
  document.getElementById('btnSave').addEventListener('click', () => saveCurrentTab());
  document.getElementById('btnClear').addEventListener('click', clearEditor);

  document.getElementById('fontSelect').addEventListener('change', (e) => {
    currentSettings.fontFamily = e.target.value;
    if (monacoEditor) monacoEditor.updateOptions({ fontFamily: e.target.value });
    window.electronAPI.saveSettingsSync(currentSettings);
  });
  document.getElementById('sizeSelect').addEventListener('change', (e) => {
    const size = Number(e.target.value);
    if (Number.isFinite(size)) {
      currentSettings.fontSize = size;
      if (monacoEditor) monacoEditor.updateOptions({ fontSize: size });
      window.electronAPI.saveSettingsSync(currentSettings);
    }
  });

  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const theme = btn.dataset.theme;
      document.body.className = `theme-${theme}`;
      currentSettings.theme = theme;
      if (monacoEditor) monaco.editor.setTheme(getMonacoTheme());
      // ФИКС: раньше настройки сохранялись только один раз, в обработчике
      // beforeunload при закрытии окна. У нашего кастомного flow закрытия
      // (main.js перехватывает close, спрашивает про несохранённые изменения,
      // потом ещё раз вызывает win.close()) beforeunload срабатывает
      // ненадёжно — тема после перезапуска не подхватывалась. Теперь
      // сохраняем сразу при выборе темы, не дожидаясь закрытия окна.
      window.electronAPI.saveSettingsSync(currentSettings);
    });
  });

  // ФИКС: поле поиска и кнопка "Обновить" в сайдбаре были в HTML,
  // но не имели ни одного обработчика событий.
  document.getElementById('searchInput').addEventListener('input', (e) => {
    renderSidebar(e.target.value);
  });
  document.getElementById('refreshBtn').addEventListener('click', () => {
    document.getElementById('searchInput').value = '';
    renderSidebar();
  });

  renderSidebar();
  initApp();
});

window.addEventListener('beforeunload', () => {
  window.electronAPI.saveSettingsSync(currentSettings);
  if (removeMaximizeListener) removeMaximizeListener();
});

// --- Сайдбар (недавние файлы) ---
// ФИКС: раньше здесь были захардкоженные списки FAVOURITES/FUN SCRIPTS
// с несуществующими файлами (Dark Dex.lua и т.п.). Теперь это список
// реально недавно открытых/сохранённых файлов, который пополняется из
// addRecentFile() и хранится в settings.json через currentSettings.recentFiles.
function renderSidebar(filterText = '') {
  const list = document.getElementById('recentList');
  if (!list) return;
  const query = filterText.trim().toLowerCase();
  const recentFiles = currentSettings.recentFiles || [];
  const filtered = recentFiles.filter(entry => !query || entry.path.toLowerCase().includes(query));

  list.innerHTML = '';

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'file-list-item';
    empty.style.cursor = 'default';
    empty.style.color = 'var(--text-secondary)';
    empty.textContent = query ? 'Nothing found' : 'No recent files yet';
    list.appendChild(empty);
    return;
  }

  filtered.forEach(entry => {
    const filename = entry.path.split(/[\\/]/).pop();
    const div = document.createElement('div');
    div.className = 'file-list-item';
    div.innerHTML = `<span class="icon file">📄</span> <span title="${escapeHtml(entry.path)}">${escapeHtml(filename)}</span>`;
    div.addEventListener('click', async () => {
      const existingTab = tabs.find(t => t.path === entry.path);
      if (existingTab) {
        switchTab(existingTab.id);
        return;
      }
      const file = await window.electronAPI.readPath(entry.path);
      if (!file) {
        // Файл, вероятно, удалён/перемещён — убираем его из списка недавних
        currentSettings.recentFiles = (currentSettings.recentFiles || []).filter(f => f.path !== entry.path);
        window.electronAPI.saveSettingsSync(currentSettings);
        renderSidebar(document.getElementById('searchInput').value);
        alert(`Could not open file, it may have been moved or deleted:\n${entry.path}`);
        return;
      }
      createNewTab(filename, entry.path, file.content);
      addRecentFile(entry.path); // поднимаем в начало списка недавних
    });
    list.appendChild(div);
  });
    }
