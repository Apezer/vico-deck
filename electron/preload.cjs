const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vico", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveConfig: (config) => ipcRenderer.invoke("config:save", config),
  getAutostart: () => ipcRenderer.invoke("autostart:get"),
  setAutostart: (enabled) => ipcRenderer.invoke("autostart:set", enabled),
  minimize: () => ipcRenderer.invoke("window:minimize"),
  hide: () => ipcRenderer.invoke("window:hide"),
  getVersion: () => ipcRenderer.invoke("app:version"),
  getClaudeStatus: () => ipcRenderer.invoke("claude:status:get"),
  getClaudeHooksState: () => ipcRenderer.invoke("claude:hooks:get"),
  installClaudeHooks: () => ipcRenderer.invoke("claude:hooks:install"),
  onClaudeStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("claude:status", listener);
    return () => ipcRenderer.removeListener("claude:status", listener);
  },
  openExternal: (url) => ipcRenderer.invoke("external:open", url)
});
