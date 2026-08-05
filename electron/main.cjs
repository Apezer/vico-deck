const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const defaultProfiles = require("../shared/default-profiles.json");
const {
  getHooksState,
  installHooks,
  startStatusServer
} = require("./claude-monitor.cjs");

let mainWindow;
let tray;
let isQuitting = false;
let claudeStatusServer;
let pendingDeviceSelection = null;
let deviceSelectionSequence = 0;
const VICO_USB_VENDOR_ID = 0x3343;
const VICO_USB_PRODUCT_ID = 0x83cf;
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
  schemaVersion: 2,
  startAtLogin: false,
  minimizeToTray: true,
  closeToTray: true,
  launchMinimized: false,
  theme: "dark",
  activeProfile: "preset-1",
  profiles: structuredClone(defaultProfiles)
};

function configPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function readConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    if (saved.schemaVersion === 2 && saved.profiles?.length === 5) {
      return { ...structuredClone(defaults), ...saved };
    }

    // Preserve the previous active layout in P5 while installing the new
    // fixed five-slot model. P1 always remains the required navigation preset.
    const migrated = structuredClone(defaults);
    const legacy = saved.profiles?.find((profile) => profile.id === saved.activeProfile) || saved.profiles?.[0];
    if (legacy?.mappings?.length === 8) {
      migrated.profiles[4] = {
        ...migrated.profiles[4],
        name: "旧配置",
        mappings: structuredClone(legacy.mappings),
        oled: { ...migrated.profiles[4].oled, ...legacy.oled }
      };
    }
    return {
      ...migrated,
      startAtLogin: saved.startAtLogin ?? migrated.startAtLogin,
      minimizeToTray: saved.minimizeToTray ?? migrated.minimizeToTray,
      closeToTray: saved.closeToTray ?? migrated.closeToTray,
      launchMinimized: saved.launchMinimized ?? migrated.launchMinimized,
      theme: saved.theme ?? migrated.theme
    };
  } catch {
    return structuredClone(defaults);
  }
}

function writeConfig(config) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), "utf8");
  return config;
}

function cancelPendingDeviceSelection() {
  if (!pendingDeviceSelection) return;
  pendingDeviceSelection.callback("");
  pendingDeviceSelection = null;
}

function requestDeviceSelection(type, devices, callback) {
  const allowedDevices = devices.filter((device) => {
    if (type === "bluetooth") return /^vico keyboard$/i.test(device.deviceName || "");
    return Number(device.vendorId) === VICO_USB_VENDOR_ID
      && Number(device.productId) === VICO_USB_PRODUCT_ID
      && /^vico keyboard$/i.test(device.productName || "");
  });
  const normalized = allowedDevices.map((device) => {
    const isBluetooth = type === "bluetooth";
    const name = isBluetooth ? device.deviceName : device.productName;
    const vendorId = Number(device.vendorId || 0);
    const productId = Number(device.productId || 0);
    return {
      id: device.deviceId,
      name: name || (isBluetooth ? "未命名蓝牙设备" : "未命名 HID 设备"),
      vendorId,
      productId,
      recommended: /vico keyboard|vico/i.test(name || "")
    };
  }).sort((a, b) => Number(b.recommended) - Number(a.recommended));

  if (type === "bluetooth" && pendingDeviceSelection?.type === "bluetooth") {
    pendingDeviceSelection.callback = callback;
    pendingDeviceSelection.deviceIds = new Set(normalized.map((device) => device.id));
    mainWindow.webContents.send("device:selection-requested", {
      requestId: pendingDeviceSelection.requestId,
      type,
      devices: normalized
    });
    return;
  }

  cancelPendingDeviceSelection();
  const requestId = `${type}-${Date.now()}-${deviceSelectionSequence += 1}`;
  pendingDeviceSelection = {
    requestId,
    type,
    callback,
    deviceIds: new Set(normalized.map((device) => device.id))
  };
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send("device:selection-requested", {
    requestId,
    type,
    devices: normalized
  });
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
    requestDeviceSelection("usb", details.deviceList, callback);
  });
  deviceSession.on("select-bluetooth-device", (event, deviceList, callback) => {
    event.preventDefault();
    requestDeviceSelection("bluetooth", deviceList, callback);
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
ipcMain.handle("device:select", (_event, selection) => {
  if (!pendingDeviceSelection || selection?.requestId !== pendingDeviceSelection.requestId) return false;
  const { callback, deviceIds } = pendingDeviceSelection;
  pendingDeviceSelection = null;
  const deviceId = typeof selection.deviceId === "string" && deviceIds.has(selection.deviceId)
    ? selection.deviceId
    : "";
  callback(deviceId);
  return true;
});
ipcMain.handle("claude:status:get", () => latestClaudeStatus);
ipcMain.handle("claude:hooks:get", () => getHooksState(app.getPath("userData")));
ipcMain.handle("claude:hooks:install", () => installHooks(app.getPath("userData")));
ipcMain.handle("external:open", (_event, url) => {
  if (typeof url === "string" && /^https?:\/\//.test(url)) return shell.openExternal(url);
});
