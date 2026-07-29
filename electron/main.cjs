const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const {
  getHooksState,
  installHooks,
  startStatusServer
} = require("./claude-monitor.cjs");

let mainWindow;
let tray;
let isQuitting = false;
let claudeStatusServer;
let latestClaudeStatus = {
  state: "offline",
  tool: "",
  text: "Waiting for Claude Code",
  event: "None",
  updatedAt: 0
};
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

const defaults = {
  startAtLogin: false,
  minimizeToTray: true,
  closeToTray: true,
  launchMinimized: false,
  theme: "dark",
  activeProfile: "default",
  profiles: [{
    id: "default",
    name: "默认配置",
    mappings: [
      { key: 1, type: "shortcut", value: "Ctrl+C", label: "复制" },
      { key: 2, type: "shortcut", value: "Ctrl+V", label: "粘贴" },
      { key: 3, type: "shortcut", value: "Ctrl+Z", label: "撤销" },
      { key: 4, type: "shortcut", value: "Ctrl+Shift+Z", label: "重做" },
      { key: 5, type: "media", value: "VOLUME_DOWN", label: "音量 -" },
      { key: 6, type: "media", value: "PLAY_PAUSE", label: "播放 / 暂停" },
      { key: 7, type: "media", value: "VOLUME_UP", label: "音量 +" },
      { key: 8, type: "system", value: "LOCK_SCREEN", label: "锁定屏幕" }
    ],
    oled: {
      mode: "dashboard",
      title: "VICO",
      subtitle: "CREATE YOUR FLOW",
      brightness: 78,
      sleepMinutes: 5,
      showBattery: true,
      showConnection: true
    }
  }]
};

function configPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function readConfig() {
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(configPath(), "utf8")) };
  } catch {
    return structuredClone(defaults);
  }
}

function writeConfig(config) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), "utf8");
  return config;
}

function createWindow() {
  const config = readConfig();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1060,
    minHeight: 680,
    show: !(config.launchMinimized && process.argv.includes("--hidden")),
    backgroundColor: "#090b0f",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#090b0f", symbolColor: "#8a919e", height: 46 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (app.isPackaged) {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  } else {
    mainWindow.loadURL("http://localhost:5173");
  }

  mainWindow.on("close", (event) => {
    const current = readConfig();
    if (!isQuitting && current.closeToTray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const iconPath = path.join(__dirname, "..", "asserts", "usb.png");
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 20, height: 20 });
  tray = new Tray(icon);
  tray.setToolTip("Vico Keyboard");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 Vico Keyboard", click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: "separator" },
    { label: "退出", click: () => { isQuitting = true; app.quit(); } }
  ]));
  tray.on("double-click", () => { mainWindow.show(); mainWindow.focus(); });
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
  createWindow();
  createTray();

  claudeStatusServer = startStatusServer((status) => {
    latestClaudeStatus = status;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("claude:status", status);
    }
  });

  // WebHID access is deliberately limited to devices explicitly selected by the user.
  const deviceSession = mainWindow.webContents.session;
  deviceSession.setPermissionCheckHandler((_wc, permission) =>
    permission === "hid" || permission === "bluetooth" || permission === "bluetoothScanning"
  );
  deviceSession.setDevicePermissionHandler((details) =>
    details.deviceType === "hid" || details.deviceType === "bluetooth"
  );
  deviceSession.on("select-hid-device", (event, details, callback) => {
    event.preventDefault();
    const preferred =
      details.deviceList.find((device) => /vico/i.test(device.productName || "")) ||
      details.deviceList[0];
    callback(preferred?.deviceId);
  });
  deviceSession.on("select-bluetooth-device", (event, deviceList, callback) => {
    event.preventDefault();
    const preferred =
      deviceList.find((device) => /vico keyboard/i.test(device.deviceName || "")) ||
      deviceList[0];
    if (preferred) callback(preferred.deviceId);
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow.show();
  });
});

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    const config = readConfig();
    if (!config.closeToTray) app.quit();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  claudeStatusServer?.close();
});

ipcMain.handle("config:get", () => readConfig());
ipcMain.handle("config:save", (_event, config) => writeConfig(config));
ipcMain.handle("autostart:get", () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle("autostart:set", (_event, enabled) => {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: enabled,
    args: enabled ? ["--hidden"] : []
  });
  const config = readConfig();
  config.startAtLogin = enabled;
  writeConfig(config);
  return app.getLoginItemSettings().openAtLogin;
});
ipcMain.handle("window:minimize", () => mainWindow.minimize());
ipcMain.handle("window:hide", () => mainWindow.hide());
ipcMain.handle("app:version", () => app.getVersion());
ipcMain.handle("claude:status:get", () => latestClaudeStatus);
ipcMain.handle("claude:hooks:get", () => getHooksState(app.getPath("userData")));
ipcMain.handle("claude:hooks:install", () => installHooks(app.getPath("userData")));
ipcMain.handle("external:open", (_event, url) => {
  if (typeof url === "string" && /^https?:\/\//.test(url)) return shell.openExternal(url);
});
