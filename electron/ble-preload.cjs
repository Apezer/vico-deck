const { contextBridge, ipcRenderer } = require("electron");

// 隐藏窗口只允许向主进程报告蓝牙事件，不暴露任何 Node.js 能力。
contextBridge.exposeInMainWorld("vicoBleHost", {
  emit: (event) => ipcRenderer.send("ble:bridge-event", event)
});
