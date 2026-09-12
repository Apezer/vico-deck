const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vico", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveConfig: (config) => ipcRenderer.invoke("config:save", config),
  getAutostart: () => ipcRenderer.invoke("autostart:get"),
  setAutostart: (enabled) => ipcRenderer.invoke("autostart:set", enabled),
  minimize: () => ipcRenderer.invoke("window:minimize"),
  hide: () => ipcRenderer.invoke("window:hide"),
  getVersion: () => ipcRenderer.invoke("app:version"),
  selectDevice: (requestId, deviceId) => ipcRenderer.invoke("device:select", { requestId, deviceId }),
  onDeviceSelection: (callback) => {
    const listener = (_event, request) => callback(request);
    ipcRenderer.on("device:selection-requested", listener);
    return () => ipcRenderer.removeListener("device:selection-requested", listener);
  },
  getClaudeStatus: () => ipcRenderer.invoke("claude:status:get"),
  getClaudeHooksState: () => ipcRenderer.invoke("claude:hooks:get"),
  installClaudeHooks: () => ipcRenderer.invoke("claude:hooks:install"),
  onClaudeStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("claude:status", listener);
    return () => ipcRenderer.removeListener("claude:status", listener);
  },
  getSystemStatus: () => ipcRenderer.invoke("system:status:get"),
  onSystemStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("system:status", listener);
    return () => ipcRenderer.removeListener("system:status", listener);
  },
  openExternal: (url) => ipcRenderer.invoke("external:open", url),
  speech: {
    check: () => ipcRenderer.invoke("speech:check"),
    saveCredential: (key) => ipcRenderer.invoke("speech:credential:save", key),
    clearCredential: () => ipcRenderer.invoke("speech:credential:clear"),
    setShortcut: (shortcut) => ipcRenderer.invoke("speech:shortcut:set", shortcut),
    transcribeRecording: (bytes, settings) => ipcRenderer.invoke("speech:recording", bytes, settings),
    transcribeFile: (settings) => ipcRenderer.invoke("speech:file", settings),
    cancel: () => ipcRenderer.invoke("speech:cancel"),
    copyText: (text) => ipcRenderer.invoke("speech:copy", text),
    saveText: (text) => ipcRenderer.invoke("speech:save", text),
    updateShortcutState: (state) => ipcRenderer.invoke("speech:shortcut:state", state),
    completeShortcut: (text) => ipcRenderer.invoke("speech:shortcut:result", text),
    onShortcut: (callback) => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on("speech:shortcut", listener);
      return () => ipcRenderer.removeListener("speech:shortcut", listener);
    },
    onProgress: (callback) => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on("speech:progress", listener);
      return () => ipcRenderer.removeListener("speech:progress", listener);
    }
  }
});
