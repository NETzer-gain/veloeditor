const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  openFile: () => ipcRenderer.invoke('dialog:openFile'),
  saveFile: (data) => ipcRenderer.invoke('dialog:saveFile', data),
  saveToPath: (filePath, content) => ipcRenderer.invoke('file:saveToPath', { filePath, content }),
  onMaximizeChange: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('window:maximize-changed', handler);
    return () => ipcRenderer.removeListener('window:maximize-changed', handler);
  },
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  saveSettingsSync: (settings) => ipcRenderer.sendSync('settings:saveSync', settings),

  // Диалог закрытия
  onQueryUnsaved: (callback) => ipcRenderer.on('app:query-unsaved', callback),
  onDoSaveAndClose: (callback) => ipcRenderer.on('app:do-save-and-close', callback),
  sendCanClose: (hasUnsaved) => ipcRenderer.send('app:can-close', hasUnsaved),
  notifySaveDoneClose: () => ipcRenderer.send('app:save-done-close')
});
