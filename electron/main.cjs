const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, dialog, clipboard, safeStorage, globalShortcut, screen } = require("electron");
const { execFile } = require("node:child_process");
const fs = require("fs");
const fsp = require("node:fs/promises");
const path = require("path");
const { promisify } = require("node:util");
const defaultProfiles = require("../shared/default-profiles.json");
const {
  getHooksState,
  installHooks,
  startStatusServer
} = require("./claude-monitor.cjs");
const { startSystemMonitor } = require("./system-monitor.cjs");
const { DoubaoService, FORMAT_BY_EXTENSION } = require("./doubao-service.cjs");
const { CredentialStore } = require("./credential-store.cjs");

let mainWindow;
let tray;
let isQuitting = false;
let claudeStatusServer;
let systemMonitor;
let speechService;
let speechCredentials;
let speechBusy = false;
let speechOverlayWindow;
let speechOverlayHideTimer;
// 一次语音会话期间锁定显示器，避免状态切换或鼠标跨屏导致悬浮窗跳动。
let speechOverlayDisplayId = null;
let speechShortcutState = "idle";
let speechTargetWindowHandle = "0";
let speechShortcutRegistered = false;
let activeSpeechShortcut = "CommandOrControl+Alt+I";
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
let latestSystemStatus = {
  cpu: 0,
  gpu: null,
  memory: 0,
  temperature: null,
  online: true,
  updatedAt: 0
};
const hasSingleInstanceLock = app.requestSingleInstanceLock();
const execFileAsync = promisify(execFile);
const DEFAULT_SPEECH_SHORTCUT = "CommandOrControl+Alt+I";
if (!hasSingleInstanceLock) app.quit();

const defaults = {
  schemaVersion: 2,
  startAtLogin: false,
  minimizeToTray: true,
  closeToTray: true,
  launchMinimized: false,
  theme: "dark",
  speechShortcut: DEFAULT_SPEECH_SHORTCUT,
  oledRuntime: { page:"brand", autoClaude:true },
  rgb: { effect:0, brightness:50, speed:100, enabled:true, color:"#D6FF38" },
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

    // 安装新的五槽位固定模型时，将之前的活动布局保存在 P5。
    // P1 始终保留为必需的导航预设。
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
  const iconPath = path.join(__dirname, "..", "asserts", "vico-keyboard.ico");
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1060,
    minHeight: 680,
    show: !(config.launchMinimized && process.argv.includes("--hidden")),
    backgroundColor: "#090b0f",
    icon: iconPath,
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#090b0f", symbolColor: "#8a919e", height: 46 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  // Web Bluetooth 的设备选择事件属于发起请求的 WebContents，而不是 Session。
  // 扫描期间 Electron 会多次触发该事件，requestDeviceSelection() 会复用同一请求
  // 并持续更新软件内的设备列表，直到用户选择设备或主动取消。
  mainWindow.webContents.on("select-bluetooth-device", (event, deviceList, callback) => {
    event.preventDefault();
    requestDeviceSelection("bluetooth", deviceList, callback);
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
  const iconPath = path.join(__dirname, "..", "asserts", "vico-keyboard.png");
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

function parseSpeechShortcut(value) {
  if (typeof value !== "string" || value.length > 64) throw new Error("快捷键格式无效");
  const tokens = value.split("+").map((token) => token.trim()).filter(Boolean);
  const modifiers = new Set();
  let primaryKey = "";
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (["commandorcontrol", "control", "ctrl"].includes(lower)) modifiers.add("CommandOrControl");
    else if (["alt", "option"].includes(lower)) modifiers.add("Alt");
    else if (lower === "shift") modifiers.add("Shift");
    else if (["super", "meta"].includes(lower)) modifiers.add("Super");
    else if (!primaryKey) primaryKey = token.length === 1 ? token.toUpperCase() : token;
    else throw new Error("快捷键只能包含一个普通按键");
  }
  if (!modifiers.size || !primaryKey) throw new Error("快捷键必须包含修饰键和一个普通按键");

  const namedKeys = new Map([
    ["space", ["Space", 0x20]], ["tab", ["Tab", 0x09]], ["enter", ["Enter", 0x0d]],
    ["escape", ["Escape", 0x1b]], ["backspace", ["Backspace", 0x08]],
    ["delete", ["Delete", 0x2e]], ["insert", ["Insert", 0x2d]],
    ["home", ["Home", 0x24]], ["end", ["End", 0x23]],
    ["pageup", ["PageUp", 0x21]], ["pagedown", ["PageDown", 0x22]],
    ["up", ["Up", 0x26]], ["down", ["Down", 0x28]],
    ["left", ["Left", 0x25]], ["right", ["Right", 0x27]]
  ]);
  let canonicalKey;
  let primaryVirtualKey;
  if (/^[A-Z0-9]$/.test(primaryKey)) {
    canonicalKey = primaryKey;
    primaryVirtualKey = primaryKey.charCodeAt(0);
  } else if (/^F(?:[1-9]|1[0-9]|2[0-4])$/i.test(primaryKey)) {
    const number = Number(primaryKey.slice(1));
    canonicalKey = `F${number}`;
    primaryVirtualKey = 0x6f + number;
  } else {
    const named = namedKeys.get(primaryKey.toLowerCase());
    if (!named) throw new Error("暂不支持这个普通按键，请使用字母、数字、F1～F24 或常用功能键");
    [canonicalKey, primaryVirtualKey] = named;
  }

  const order = ["CommandOrControl", "Alt", "Shift", "Super"];
  const canonicalModifiers = order.filter((modifier) => modifiers.has(modifier));
  const modifierVirtualKeys = canonicalModifiers.map((modifier) => ({
    CommandOrControl:0x11,
    Alt:0x12,
    Shift:0x10,
    Super:0x5b
  })[modifier]);
  return {
    accelerator:[...canonicalModifiers, canonicalKey].join("+"),
    virtualKeys:[...modifierVirtualKeys, primaryVirtualKey]
  };
}

function shortcutLabel(value = activeSpeechShortcut) {
  return value.replace("CommandOrControl", "Ctrl").replaceAll("+", " + ");
}

function registerSpeechShortcut(value) {
  const parsed = parseSpeechShortcut(value);
  if (parsed.accelerator === activeSpeechShortcut && globalShortcut.isRegistered(activeSpeechShortcut)) {
    speechShortcutRegistered = true;
    return { shortcut:activeSpeechShortcut, registered:true };
  }
  const registered = globalShortcut.register(parsed.accelerator, () => {
    handleSpeechShortcut().catch((error) => {
      speechShortcutState = "idle";
      updateSpeechOverlay("error", "语音快捷键失败", error.message || "请重试", 2600);
    });
  });
  if (!registered) throw new Error("快捷键已被其他软件占用，请换一个组合键");
  if (speechShortcutRegistered && activeSpeechShortcut !== parsed.accelerator) {
    globalShortcut.unregister(activeSpeechShortcut);
  }
  activeSpeechShortcut = parsed.accelerator;
  speechShortcutRegistered = true;
  return { shortcut:activeSpeechShortcut, registered:true };
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
  speechService = new DoubaoService();
  speechCredentials = new CredentialStore(
    path.join(app.getPath("userData"), "doubao-api-key.bin"),
    safeStorage
  );
  speechService.onProgress = (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("speech:progress", progress);
  };

  createWindow();
  createTray();
  try {
    registerSpeechShortcut(readConfig().speechShortcut || DEFAULT_SPEECH_SHORTCUT);
  } catch {
    activeSpeechShortcut = DEFAULT_SPEECH_SHORTCUT;
    try { registerSpeechShortcut(DEFAULT_SPEECH_SHORTCUT); } catch { speechShortcutRegistered = false; }
  }

  claudeStatusServer = startStatusServer((status) => {
    latestClaudeStatus = status;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("claude:status", status);
    }
  });
  systemMonitor = startSystemMonitor((status) => {
    latestSystemStatus = status;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("system:status", status);
    }
  });

  // WebHID 访问仅限用户明确选择的设备。
  const deviceSession = mainWindow.webContents.session;
  deviceSession.setPermissionCheckHandler((_wc, permission) =>
    permission === "hid" || permission === "bluetooth" || permission === "bluetoothScanning" || permission === "media"
  );
  deviceSession.setDevicePermissionHandler((details) =>
    details.deviceType === "hid" || details.deviceType === "bluetooth"
  );
  // 语音输入页只申请麦克风权限，不允许摄像头等其他媒体权限。
  deviceSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const mediaTypes = details?.mediaTypes || [];
    const audioOnly = mediaTypes.length > 0 && mediaTypes.every((type) => type === "audio");
    callback(webContents === mainWindow.webContents && permission === "media" && audioOnly);
  });
  deviceSession.on("select-hid-device", (event, details, callback) => {
    event.preventDefault();
    requestDeviceSelection("usb", details.deviceList, callback);
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
  globalShortcut.unregisterAll();
  claudeStatusServer?.close();
  systemMonitor?.close();
  speechService?.cancel();
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
ipcMain.handle("system:status:get", () => latestSystemStatus);
ipcMain.handle("claude:hooks:get", () => getHooksState(app.getPath("userData")));
ipcMain.handle("claude:hooks:install", () => installHooks(app.getPath("userData")));
ipcMain.handle("external:open", (_event, url) => {
  if (typeof url === "string" && /^https?:\/\//.test(url)) return shell.openExternal(url);
});

function speechResult(operation) {
  return Promise.resolve().then(operation)
    .then((data) => ({ ok:true, data }))
    .catch((error) => ({ ok:false, error:error.message || "语音识别失败" }));
}

/** 创建不会抢走聊天框焦点的桌面语音悬浮窗。 */
function createSpeechOverlay() {
  speechOverlayWindow = new BrowserWindow({
    width: 300,
    height: 82,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: { contextIsolation:true, nodeIntegration:false }
  });
  speechOverlayWindow.setAlwaysOnTop(true, "status");
  speechOverlayWindow.setIgnoreMouseEvents(true);
  const html = `<!doctype html><html><head><meta charset="UTF-8"><style>
    *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;font-family:"Microsoft YaHei UI",sans-serif}
    #card{height:70px;margin:6px;padding:10px 15px;display:flex;align-items:center;gap:13px;border:1px solid rgba(214,255,56,.42);border-radius:18px;background:rgba(12,16,21,.94);box-shadow:0 12px 36px rgba(0,0,0,.42);color:#edf2f6}
    #icon{position:relative;width:43px;height:43px;flex:none;display:grid;place-items:center;border-radius:50%;background:rgba(214,255,56,.11);color:#d6ff38;box-shadow:0 0 18px rgba(214,255,56,.16)}
    #icon::before{content:"";position:absolute;inset:-6px;padding:2px;border-radius:50%;opacity:0;background:conic-gradient(from 0deg,transparent 0 18%,rgba(214,255,56,.18) 34%,#d6ff38 62%,#fff 72%,transparent 86%);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;filter:drop-shadow(0 0 4px rgba(214,255,56,.85));pointer-events:none}
    #icon svg{width:23px;height:23px}b,span{display:block}b{font-size:13px;margin-bottom:5px}span{font-size:10px;color:#929da8;white-space:nowrap}
    body[data-state="recording"] #icon{color:#ff7474;background:rgba(255,82,82,.13);animation:recording-glow 1.15s ease-in-out infinite}
    body[data-state="recording"] #card{border-color:rgba(255,102,102,.48)}
    body[data-state="processing"] #icon::before{opacity:1;animation:speech-ring 1.15s linear infinite}
    body[data-state="done"] #icon{color:#d6ff38}body[data-state="error"] #icon{color:#ff7474}
    @keyframes recording-glow{50%{box-shadow:0 0 25px currentColor}}@keyframes speech-ring{to{transform:rotate(360deg)}}
  </style></head><body data-state="recording"><div id="card"><div id="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8"/></svg></div><div><b id="title">正在录音</b><span id="message">松开快捷键后停止并识别</span></div></div><script>
    window.setSpeechState=(state,title,message)=>{document.body.dataset.state=state;document.getElementById("title").textContent=title;document.getElementById("message").textContent=message};
  </script></body></html>`;
  speechOverlayWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`);
}

function placeAndShowSpeechOverlay() {
  if (!speechOverlayWindow || speechOverlayWindow.isDestroyed()) createSpeechOverlay();
  const displays = screen.getAllDisplays();
  let display = displays.find((item) => String(item.id) === String(speechOverlayDisplayId));
  if (!display) {
    display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    speechOverlayDisplayId = display.id;
  }
  const [width, height] = speechOverlayWindow.getSize();
  const x = Math.round(display.workArea.x + (display.workArea.width - width) / 2);
  const y = display.workArea.y + display.workArea.height - height - 26;
  speechOverlayWindow.setBounds({ x, y, width, height }, false);
  speechOverlayWindow.showInactive();
}

/** 新语音会话只在开始时选择一次鼠标所在显示器。 */
function beginSpeechOverlaySession(state, title, message) {
  speechOverlayDisplayId = null;
  updateSpeechOverlay(state, title, message);
}

function updateSpeechOverlay(state, title, message, hideDelay = 0) {
  clearTimeout(speechOverlayHideTimer);
  placeAndShowSpeechOverlay();
  const script = `window.setSpeechState(${JSON.stringify(state)},${JSON.stringify(title)},${JSON.stringify(message)})`;
  speechOverlayWindow.webContents.executeJavaScript(script).catch(() => {});
  if (hideDelay > 0) {
    speechOverlayHideTimer = setTimeout(() => {
      speechOverlayWindow?.hide();
      speechOverlayDisplayId = null;
    }, hideDelay);
  }
}

/** 记录快捷键按下前拥有输入焦点的窗口，识别完成后将焦点还给它。 */
async function getForegroundWindowHandle() {
  const script = "Add-Type 'using System; using System.Runtime.InteropServices; public static class VicoWindow { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); }'; [Console]::Out.Write([VicoWindow]::GetForegroundWindow().ToInt64())";
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide:true, timeout:4000 });
  const value = String(stdout).trim();
  return /^\d+$/.test(value) ? value : "0";
}

/** Electron 只上报全局快捷键按下事件，因此由 Windows 等待组合键释放。 */
async function waitForSpeechShortcutRelease() {
  const keyChecks = parseSpeechShortcut(activeSpeechShortcut).virtualKeys
    .map((key) => `(([VicoKeys]::GetAsyncKeyState(${key}) -band 0x8000) -ne 0)`)
    .join(" -and ");
  const script = `Add-Type 'using System.Runtime.InteropServices; public static class VicoKeys { [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int k); }'; while(${keyChecks}){Start-Sleep -Milliseconds 12}`;
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide:true,
    timeout:10 * 60 * 1000
  });
}

/** 恢复原窗口并发送 Ctrl+V；识别文本同时留在剪贴板中作为失败回退。 */
async function pasteSpeechText(text) {
  if (typeof text !== "string" || !text.trim() || text.length > 5e6) throw new Error("识别文本无效");
  clipboard.writeText(text.trim());
  const handle = /^\d+$/.test(speechTargetWindowHandle) ? speechTargetWindowHandle : "0";
  const script = `Add-Type 'using System; using System.Runtime.InteropServices; public static class VicoPaste { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int c); [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e); }'; $h=[IntPtr]::new(${handle}); if($h -ne [IntPtr]::Zero){[VicoPaste]::ShowWindowAsync($h,5)|Out-Null;[VicoPaste]::SetForegroundWindow($h)|Out-Null}; Start-Sleep -Milliseconds 140; [VicoPaste]::keybd_event(0x11,0,0,[UIntPtr]::Zero);[VicoPaste]::keybd_event(0x56,0,0,[UIntPtr]::Zero);[VicoPaste]::keybd_event(0x56,0,2,[UIntPtr]::Zero);[VicoPaste]::keybd_event(0x11,0,2,[UIntPtr]::Zero)`;
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], { windowsHide:true, timeout:5000 });
}

async function handleSpeechShortcut() {
  // 按住快捷键时 Windows 会产生重复按键事件，只处理第一次回调。
  if (speechShortcutState !== "idle") return;

  speechShortcutState = "starting";
  beginSpeechOverlaySession("processing", "正在启动麦克风", `按住 ${shortcutLabel()} 说话`);
  try {
    // 焦点窗口捕获与按键释放监听并行执行，避免 PowerShell 启动时间延迟录音。
    const targetWindowPromise = getForegroundWindowHandle().catch(() => "0");
    const shortcutReleasePromise = waitForSpeechShortcutRelease();
    speechShortcutState = "recording";
    updateSpeechOverlay("recording", "正在录音", `松开 ${shortcutLabel()} 后停止并识别`);
    mainWindow?.webContents.send("speech:shortcut", { action:"start" });
    await shortcutReleasePromise;
    speechTargetWindowHandle = await targetWindowPromise;
    if (speechShortcutState === "recording") {
      speechShortcutState = "processing";
      updateSpeechOverlay("processing", "正在识别", "结果将自动输入到原聊天框");
      mainWindow?.webContents.send("speech:shortcut", { action:"stop" });
    }
  } catch (error) {
    speechShortcutState = "idle";
    updateSpeechOverlay("error", "无法启动语音输入", error.message || "请重试", 2600);
  }
}

function validateSpeechOptions(value = {}) {
  return {
    enableDdc:value.enableDdc !== false,
    enablePunc:value.enablePunc !== false,
    enableItn:value.enableItn !== false,
    enableSpeakerInfo:Boolean(value.enableSpeakerInfo),
    enableChannelSplit:Boolean(value.enableChannelSplit)
  };
}

async function runSpeechExclusive(operation) {
  if (speechBusy) throw new Error("已有语音识别任务正在运行");
  speechBusy = true;
  try {
    return await operation();
  } finally {
    speechBusy = false;
  }
}

async function transcribeSpeechPath(audioPath, options) {
  const apiKey = speechCredentials?.get();
  if (!apiKey) throw new Error("请先在语音输入页面保存豆包 API Key");
  return speechService.transcribe(audioPath, apiKey, validateSpeechOptions(options));
}

ipcMain.handle("speech:check", () => speechResult(() => ({
  provider:"doubao",
  model:"Doubao Seed-ASR 2.0",
  resource:"volc.seedasr.auc",
  shortcut:activeSpeechShortcut,
  shortcutRegistered:speechShortcutRegistered,
  ...(speechCredentials?.info() || { configured:false, masked:"" })
})));
ipcMain.handle("speech:credential:save", (_event, key) =>
  speechResult(() => speechCredentials.save(key)));
ipcMain.handle("speech:credential:clear", () =>
  speechResult(() => speechCredentials.clear()));
ipcMain.handle("speech:shortcut:set", (_event, shortcut) => speechResult(() => {
  if (speechShortcutState !== "idle") throw new Error("请等待当前录音或识别结束后再修改快捷键");
  const result = registerSpeechShortcut(shortcut);
  const config = readConfig();
  writeConfig({ ...config, speechShortcut:result.shortcut });
  return result;
}));
ipcMain.handle("speech:recording", (_event, bytes, options) => speechResult(() =>
  runSpeechExclusive(async () => {
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 100 * 1024 * 1024) {
      throw new Error("录音为空或超过 100 MB");
    }
    const tempDirectory = await fsp.mkdtemp(path.join(app.getPath("temp"), "vico-voice-"));
    const audioPath = path.join(tempDirectory, "keyboard-recording.wav");
    try {
      await fsp.writeFile(audioPath, bytes);
      return await transcribeSpeechPath(audioPath, options);
    } finally {
      await fsp.rm(tempDirectory, { recursive:true, force:true, maxRetries:5, retryDelay:100 });
    }
  })));
ipcMain.handle("speech:file", (_event, options) => speechResult(() =>
  runSpeechExclusive(async () => {
    const extensions = [...FORMAT_BY_EXTENSION.keys()].map((value) => value.slice(1));
    const result = await dialog.showOpenDialog(mainWindow, {
      title:"选择需要识别的音频",
      properties:["openFile"],
      filters:[{ name:"音频", extensions }]
    });
    if (result.canceled) return null;
    return {
      ...await transcribeSpeechPath(result.filePaths[0], options),
      source:path.basename(result.filePaths[0])
    };
  })));
ipcMain.handle("speech:cancel", () => speechResult(() => speechService?.cancel() || false));
ipcMain.handle("speech:shortcut:state", (_event, value = {}) => speechResult(async () => {
  const state = String(value.state || "");
  const keyboardSource = value.source === "keyboard";
  if (state === "recording") {
    if (keyboardSource && speechShortcutState === "idle") {
      speechTargetWindowHandle = await getForegroundWindowHandle().catch(() => "0");
      speechOverlayDisplayId = null;
    }
    speechShortcutState = "recording";
    updateSpeechOverlay(
      "recording",
      "正在录音",
      keyboardSource ? "松开小键盘旋钮后停止并识别" : `松开 ${shortcutLabel()} 后停止并识别`
    );
  } else if (state === "processing") {
    speechShortcutState = "processing";
    updateSpeechOverlay("processing", "正在识别", "结果将自动输入到原聊天框");
  } else if (state === "error") {
    speechShortcutState = "idle";
    speechTargetWindowHandle = "0";
    updateSpeechOverlay("error", "语音输入失败", String(value.message || "请检查麦克风和 API 设置"), 3200);
  }
  return true;
}));
ipcMain.handle("speech:shortcut:result", (_event, text) => speechResult(async () => {
  try {
    await pasteSpeechText(text);
    updateSpeechOverlay("done", "识别完成", "文字已输入到原聊天框", 1500);
    return true;
  } finally {
    speechShortcutState = "idle";
    speechTargetWindowHandle = "0";
  }
}));
ipcMain.handle("speech:copy", (_event, value) => speechResult(() => {
  if (typeof value !== "string" || value.length > 5e6) throw new Error("识别文本无效");
  clipboard.writeText(value);
  return true;
}));
ipcMain.handle("speech:save", (_event, value) => speechResult(async () => {
  if (typeof value !== "string" || value.length > 5e6) throw new Error("识别文本无效");
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath:"语音识别.txt",
    filters:[{ name:"文本", extensions:["txt"] }]
  });
  if (result.canceled) return null;
  await fsp.writeFile(result.filePath, `\ufeff${value}`, "utf8");
  return result.filePath;
}));
