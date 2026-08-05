let monacoEditor = null;
let monacoReady = false;
const pendingTabs = [];
let tabs = [];
let activeTabId = null;
let currentSettings = {
  theme: 'dark',
  fontFamily: 'Consolas',
  fontSize: 14
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
    if (saved && saved.theme) {
      currentSettings = { ...currentSettings, ...saved };
    }
  } catch (e) { console.warn('Could not load settings', e); }

  document.body.className = `theme-${currentSettings.theme}`;
  document.getElementById('fontSelect').value = currentSettings.fontFamily;
  document.getElementById('sizeSelect').value = currentSettings.fontSize;

  require.config({ paths: { vs: 'vs' } });
  require(['vs/editor/editor.main'], () => {
    defineMonacoTheme();
    monacoReady = true;
    pendingTabs.forEach(({ title, filePath, content }) => createNewTab(title, filePath, content));
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
    const success = await saveCurrentTab();
    if (success) {
      window.electronAPI.notifySaveDoneClose();
    }
  });
}

function defineMonacoTheme() {
  monaco.editor.defineTheme('midnight-custom', {
    base: 'vs-dark',
    inherit: true,
    rules: [{ token: '', foreground: '#c3cee8' }],
    colors: {
      'editor.background': '#202225',
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
function createNewTab(title = null, filePath = null, content = '') {
  if (!monacoReady) {
    pendingTabs.push({ title, filePath, content });
    return;
  }

  const id = generateId();
  const language = getLanguageFromPath(filePath);
  const model = monaco.editor.createModel(content, language);
  const tab = {
    id,
    title: title || (filePath ? filePath.split(/[\\/]/).pop() : 'Untitled'),
    path: filePath,
    model,
    dirty: false,
    lastSaved: filePath ? Date.now() : null
  };

  model.onDidChangeContent(() => {
  if (!tab.dirty) {
    tab.dirty = true;
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

// --- Файловые операции ---
async function openFileDialog() {
  if (!monacoReady) return;
  const file = await window.electronAPI.openFile();
  if (!file) return;
  const existing = tabs.find(t => t.path === file.path);
  if (existing) {
    if (existing.model && !existing.model.isDisposed()) {
      existing.model.setValue(file.content);
    }
    existing.dirty = false;
    switchTab(existing.id);
  } else {
    const filename = file.path.split(/[\\/]/).pop();
    createNewTab(filename, file.path, file.content);
  }
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
      tab.lastSaved = Date.now();
      renderTabs();
      return true;
    }
    return false;
  } else {
    const newPath = await window.electronAPI.saveFile({ defaultName: tab.title, content });
    if (newPath) {
      tab.path = newPath;
      tab.title = newPath.split(/[\\/]/).pop();
      tab.dirty = false;
      tab.lastSaved = Date.now();
      renderTabs();
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
  });
  document.getElementById('sizeSelect').addEventListener('change', (e) => {
    const size = Number(e.target.value);
    if (Number.isFinite(size)) {
      currentSettings.fontSize = size;
      if (monacoEditor) monacoEditor.updateOptions({ fontSize: size });
    }
  });

  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const theme = btn.dataset.theme;
      document.body.className = `theme-${theme}`;
      currentSettings.theme = theme;
      if (monacoEditor) monaco.editor.setTheme(getMonacoTheme());
    });
  });

  renderSidebar();
  initApp();
});

window.addEventListener('beforeunload', () => {
  window.electronAPI.saveSettingsSync(currentSettings);
  if (removeMaximizeListener) removeMaximizeListener();
});

// --- Сайдбар ---
const favorites = [
  { label: 'Dark Dex.lua', icon: 'star' },
  { label: 'Hydroxide.lua', icon: 'star' }
];
const funScripts = [
  { label: 'Infinite Yield FE.lua', icon: 'file' },
  { label: 'Sirius.lua', icon: 'file' }
];

function renderSidebar() {
  const favList = document.getElementById('favoritesList');
  const scrList = document.getElementById('scriptsList');
  const createItem = (item) => {
    const div = document.createElement('div');
    div.className = 'file-list-item';
    div.innerHTML = `<span class="icon ${item.icon}">${item.icon === 'star' ? '★' : '📄'}</span> ${item.label}`;
    div.addEventListener('click', () => {
      // Проверяем, нет ли уже вкладки с таким же названием и без пути
      const existing = tabs.find(t => t.title === item.label && !t.path);
      if (existing) {
        switchTab(existing.id);
        return;
      }
      // Передаём фиктивный путь для правильной языковой подсветки
      createNewTab(item.label, item.label, '');
    });
    return div;
  };
  favList.innerHTML = '';
  scrList.innerHTML = '';
  favorites.forEach(f => favList.appendChild(createItem(f)));
  funScripts.forEach(f => scrList.appendChild(createItem(f)));
                                 }
