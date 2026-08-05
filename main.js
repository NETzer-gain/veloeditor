const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs').promises;

// --- Регистрация IPC один раз ---
function registerIpcHandlers() {
  ipcMain.on('window:minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.minimize();
  });
  ipcMain.on('window:maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.isMaximized() ? win.unmaximize() : win.maximize();
    }
  });
  ipcMain.on('window:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.close();
  });

  // Открытие файла
  ipcMain.handle('dialog:openFile', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [
        { name: 'Text Files', extensions: ['txt', 'lua', 'md', 'js', 'html', 'css'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (!result.canceled && result.filePaths.length > 0) {
      try {
        const content = await fs.readFile(result.filePaths[0], 'utf-8');
        return { path: result.filePaths[0], content };
      } catch (err) {
        console.error('Read error:', err);
        return null;
      }
    }
    return null;
  });

  // Сохранение через диалог (Save As)
  ipcMain.handle('dialog:saveFile', async (event, { defaultName, content }) => {
    if (typeof content !== 'string') throw new Error('Invalid content type');
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;
    const result = await dialog.showSaveDialog(win, {
      defaultPath: defaultName || 'untitled.txt',
      filters: [
        { name: 'Text Files', extensions: ['txt', 'lua', 'md', 'js', 'html', 'css'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (!result.canceled && result.filePath) {
      try {
        await fs.writeFile(result.filePath, content, 'utf-8');
        return result.filePath;
      } catch (err) {
        console.error('Write error:', err);
        return null;
      }
    }
    return null;
  });

  // Прямое сохранение по известному пути
  ipcMain.handle('file:saveToPath', async (event, { filePath, content }) => {
    if (typeof content !== 'string' || !filePath) throw new Error('Invalid arguments');
    try {
      await fs.writeFile(filePath, content, 'utf-8');
      return true;
    } catch (err) {
      console.error('Save error:', err);
      return false;
    }
  });

  // Настройки
  ipcMain.handle('settings:load', async () => {
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    try {
      const data = await fs.readFile(settingsPath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return {};
    }
  });

  ipcMain.handle('settings:save', async (event, settings) => {
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    try {
      await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
      return true;
    } catch (err) {
      console.error('Settings save error:', err);
      return false;
    }
  });

  ipcMain.on('settings:saveSync', (event, settings) => {
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    try {
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
      event.returnValue = true;
    } catch (err) {
      console.error('Sync settings save error:', err);
      event.returnValue = false;
    }
  });

  // Подтверждение закрытия
  ipcMain.on('app:can-close', (event, hasUnsaved) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;

    const doClose = () => {
      win._closingConfirmed = true;
      win.close();
    };

    if (hasUnsaved) {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'question',
        buttons: ["Don't save", 'Cancel', 'Save'],
        defaultId: 2,
        title: 'Unsaved changes',
        message: 'You have unsaved changes. Do you want to save before closing?'
      });
      if (choice === 2) {
        // Save — рендерер сохранит и пришлёт app:save-done-close
        event.sender.send('app:do-save-and-close');
        return;
      } else if (choice === 1) {
        return; // Cancel
      }
      // choice 0: don't save – просто закрываем
    }
    doClose();
  });

  // Рендерер подтвердил, что сохранение выполнено успешно
  ipcMain.on('app:save-done-close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      win._closingConfirmed = true;
      win.close();
    }
  });
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    backgroundColor: '#111111',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.on('did-fail-load', () => {
    console.error('Failed to load renderer/index.html');
  });

  mainWindow.on('close', (e) => {
    if (mainWindow._closingConfirmed) return;
    e.preventDefault();
    mainWindow.webContents.send('app:query-unsaved');
  });

  mainWindow.on('maximize', () => mainWindow.webContents.send('window:maximize-changed', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:maximize-changed', false));
}

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
