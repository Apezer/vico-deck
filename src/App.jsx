import { useEffect, useMemo, useRef, useState } from "react";
import {
  BatteryMedium, Bluetooth, ChevronDown, CircleHelp, Command, Cpu, Download,
  Eraser, Gauge, Keyboard, Layers3, Monitor, Moon, MoreHorizontal, Palette, Pencil,
  Play, Plus, Power, RefreshCw, Rocket, Save, Settings, SlidersHorizontal,
  Sparkles, Sun, Trash2, Unplug, Upload, Usb, Volume2, WifiOff, X
} from "lucide-react";
import { VicoBleDevice, VicoDevice } from "./device";
import ClaudePage from "./ClaudePage";
import LiveOledCanvas from "./LiveOledCanvas";
import OledPixelCanvas from "./OledPixelCanvas";
import { OLED_CONTENT_OPTIONS, renderRuntimePreview } from "./oled-runtime-preview";
import {
  bitmapFromBase64,
  bitmapToBase64,
  createBlankBitmap,
  importImageBitmap,
  invertBitmap
} from "./oled-bitmap";
import { profileCrc } from "./profile-protocol";
import { buildRgbSettingsPacket, buildRuntimeBitmapPackets, buildRuntimeSettingsPacket, buildRuntimeStatusPackets } from "./runtime-protocol";
import defaultProfiles from "../shared/default-profiles.json";

const fallbackConfig = {
  schemaVersion: 2,
  startAtLogin: false, minimizeToTray: true, closeToTray: true,
  oledRuntime: { page:"brand", autoClaude:true },
  rgb: { effect:0, brightness:50, speed:100, enabled:true, color:"#D6FF38" },
  activeProfile: "preset-1",
  profiles: structuredClone(defaultProfiles)
};

const actionGroups = [
  { label: "键盘", options: [
    ["keyboard", "ARROW_LEFT", "左方向键"], ["keyboard", "ARROW_DOWN", "下方向键"],
    ["keyboard", "ARROW_RIGHT", "右方向键"], ["keyboard", "ARROW_UP", "上方向键"],
    ["keyboard", "ENTER", "Enter"], ["keyboard", "BACKSPACE", "Backspace"],
    ["keyboard", "ESC", "Esc"], ["keyboard", "TAB", "Tab"],
    ["keyboard", "DELETE", "Delete"],
    ["shortcut", "Ctrl+Win", "Ctrl + Win"], ["layer", "FN", "Fn"]
  ]},
  { label: "常用", options: [
    ["shortcut", "Ctrl+C", "复制"], ["shortcut", "Ctrl+V", "粘贴"],
    ["shortcut", "Ctrl+Z", "撤销"], ["shortcut", "Ctrl+Shift+Z", "重做"]
  ]},
  { label: "媒体", options: [
    ["media", "PREVIOUS_TRACK", "上一曲"], ["media", "PLAY_PAUSE", "播放 / 暂停"],
    ["media", "NEXT_TRACK", "下一曲"], ["media", "STOP", "停止"], ["media", "VOLUME_UP", "音量 +"],
    ["media", "VOLUME_DOWN", "音量 -"], ["media", "MUTE", "静音"]
  ]},
  { label: "系统", options: [
    ["system", "LOCK_SCREEN", "锁定屏幕"], ["system", "SHOW_DESKTOP", "显示桌面"],
    ["system", "SCREENSHOT", "截图"], ["system", "DO_NOTHING", "无操作"]
  ]}
];

const physicalKeySlots = [
  { key:8, area:"up" },
  { key:7, area:"left" },
  { key:6, area:"down" },
  { key:5, area:"right" },
  { key:1, area:"aux1" },
  { key:2, area:"aux2" },
  { key:3, area:"aux3" },
  { key:4, area:"enter" }
];

const RGB_EFFECTS = [
  { id:6, name:"常亮", description:"保持你选择的固定颜色", className:"static" },
  { id:0, name:"彩虹流光", description:"连续变化的全色相渐变", className:"rainbow" },
  { id:1, name:"呼吸", description:"柔和明暗循环", className:"breathing" },
  { id:2, name:"彗星", description:"单点移动并保留拖尾", className:"comet" },
  { id:3, name:"逐键点亮", description:"灯光依次扫过每个按键", className:"wipe" },
  { id:4, name:"火焰", description:"暖色随机闪烁", className:"fire" },
  { id:5, name:"纯色渐变", description:"整块灯光缓慢变色", className:"solid" },
  { id:7, name:"七彩呼吸", description:"每完成一次呼吸后切换一种颜色", className:"rainbow-breathing" }
];

function colorHueOffset(hexColor) {
  const match = /^#?([0-9a-f]{6})$/i.exec(hexColor || "");
  if (!match) return 0;
  const value = Number.parseInt(match[1], 16);
  const r = ((value >> 16) & 255) / 255;
  const g = ((value >> 8) & 255) / 255;
  const b = (value & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return -76;
  let hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  hue = Math.round(hue * 60);
  if (hue < 0) hue += 360;
  // 预览图中的基准灯光为约 76° 的黄绿色。
  return hue - 76;
}

function Toggle({ value, onChange, disabled }) {
  return <button disabled={disabled} className={`toggle ${value ? "on" : ""}`} onClick={() => onChange(!value)}><span /></button>;
}

function Brand() {
  return <div className="brand"><div className="brand-mark"><span>V</span></div><div><b>VICO</b><small>KEYBOARD</small></div></div>;
}

function Sidebar({ page, setPage }) {
  const items = [
    ["keys", Keyboard, "按键配置"], ["oled", Monitor, "OLED 显示"], ["rgb", Palette, "RGB 灯光"], ["profiles", Layers3, "配置文件"], ["claude", Cpu, "Claude Code"], ["settings", Settings, "设置"]
  ];
  return <aside className="sidebar">
    <Brand />
    <nav>
      <p>设备</p>
      {items.slice(0, 4).map(([id, Icon, label]) => <button key={id} className={page === id ? "active" : ""} onClick={() => setPage(id)}><Icon size={18}/><span>{label}</span></button>)}
      <p>应用</p>
      {items.slice(4).map(([id, Icon, label]) => <button key={id} className={page === id ? "active" : ""} onClick={() => setPage(id)}><Icon size={18}/><span>{label}</span></button>)}
    </nav>
    <div className="sidebar-help"><CircleHelp size={17}/><div><b>需要帮助？</b><span>查看连接与固件指南</span></div></div>
  </aside>;
}

function Header({ status, connect, disconnect, syncing, sync }) {
  const connected = status.state === "connected";
  const connecting = status.state === "connecting";
  const battery = Number.isFinite(status.batteryPercent) ? `${status.batteryPercent}%` : null;
  return <header className="topbar">
    <div className="crumb"><span>Vico Keyboard</span><ChevronDown size={15}/></div>
    <div className="top-actions">
      <div className={`device-pill ${connected ? "connected" : connecting ? "connecting" : ""}`}><span className="status-dot"/>{connected ? `${status.name}${battery ? ` · ${battery}` : ""}` : connecting ? "正在验证 Vico 固件" : "设备未连接"}</div>
      <button className="ghost square"><MoreHorizontal size={19}/></button>
      {connected && <button className="secondary header-disconnect" onClick={disconnect}><Unplug size={15}/>断开</button>}
      <button className="connect-btn" onClick={connected ? sync : connect} disabled={syncing || connecting}>
        {syncing || connecting ? <RefreshCw className="spin" size={16}/> : connected ? <Save size={16}/> : <Usb size={16}/>}
        {syncing ? "正在同步" : connecting ? "正在连接" : connected ? "同步到设备" : "连接设备"}
      </button>
    </div>
  </header>;
}

function DeviceSelectionDialog({ request, onSelect }) {
  if (!request) return null;
  const bluetooth = request.type === "bluetooth";
  const formatId = (value) => Number(value || 0).toString(16).toUpperCase().padStart(4, "0");
  return <div className="device-picker-backdrop" onMouseDown={() => onSelect("")}>
    <section className="device-picker" onMouseDown={(event) => event.stopPropagation()}>
      <div className="device-picker-head">
        <div className="device-picker-icon">{bluetooth ? <Bluetooth/> : <Usb/>}</div>
        <div><span>{bluetooth ? "BLUETOOTH GATT" : "USB WEBHID"}</span><h2>选择要连接的设备</h2></div>
        <button className="ghost square" onClick={() => onSelect("")}><X size={19}/></button>
      </div>
      <p className="device-picker-help">
        {bluetooth ? "这里只显示名称为 Vico Keyboard 的设备。" : "这里只显示通过 Vico 产品名和 USB VID/PID 双重验证的设备，其他键盘会被自动忽略。"}
      </p>
      <div className="device-picker-list">
        {request.devices.length === 0 && <div className="device-picker-empty">
          {bluetooth
            ? "正在扫描 Vico Keyboard…请确认模式拨片位于 BLE、键盘正在广播，并且 Windows 蓝牙已开启。"
            : "没有发现 Vico Keyboard，请确认模式与连接状态，并重新插拔设备。"}
        </div>}
        {request.devices.map((device) => <button key={device.id} onClick={() => onSelect(device.id)}>
          <span className="device-choice-icon">{bluetooth ? <Bluetooth/> : <Keyboard/>}</span>
          <span className="device-choice-copy">
            <b>{device.name}</b>
            <small>{bluetooth ? `设备 ID · ${device.id.slice(-8)}` : `VID ${formatId(device.vendorId)} · PID ${formatId(device.productId)}`}</small>
          </span>
          {device.recommended ? <em>VICO</em> : <small>其他设备</small>}
        </button>)}
      </div>
      <div className="device-picker-foot"><button className="secondary" onClick={() => onSelect("")}>取消</button></div>
    </section>
  </div>;
}

function DeviceHero({ status, connect }) {
  const connected = status.state === "connected";
  const connecting = status.state === "connecting";
  const battery = Number.isFinite(status.batteryPercent) ? `${status.batteryPercent}%` : "--%";
  return <section className="device-hero">
    <div>
      <div className="eyebrow"><span className="live-dot"/> VICO 8 · ESP32-S3</div>
      <h1>让每一次触发，<br/><em>都恰到好处。</em></h1>
      <p>8 个可编程按键与一块属于你的 OLED。<br/>为常用动作创建更短、更自然的路径。</p>
      {!connected && !connecting && <button className="hero-connect" onClick={connect}><Usb size={17}/>连接 Vico 8</button>}
    </div>
    <div className="device-visual">
      <div className="glow"/>
      <div className="keyboard-shell">
        <div className="mini-oled"><b>VICO KEYBOARD</b><span>CLAUDE CODE · WORKING...</span><i/></div>
        <span className="mini-key mini-up">↑</span>
        <div className="mini-knob"><i/></div>
        <span className="mini-key mini-left">←</span>
        <span className="mini-key mini-down">↓</span>
        <span className="mini-key mini-right">→</span>
        <span className="mini-key mini-aux1"/>
        <span className="mini-key mini-aux2"/>
        <span className="mini-key mini-aux3"/>
        <span className="mini-key mini-enter">ENTER</span>
      </div>
      <div className="connection-tag">{connected ? <><BatteryMedium size={16}/> {battery} · USB</> : <><WifiOff size={16}/> 等待连接</>}</div>
    </div>
  </section>;
}

function KeyEditor({ mapping, onClose, onChange }) {
  const [custom, setCustom] = useState(mapping.value);
  return <div className="drawer-backdrop" onMouseDown={onClose}>
    <aside className="drawer" onMouseDown={(e) => e.stopPropagation()}>
      <div className="drawer-head"><div><span>KEY {mapping.key}</span><h2>设置按键功能</h2></div><button className="ghost square" onClick={onClose}><X size={20}/></button></div>
      {actionGroups.map((group) => <section className="action-section" key={group.label}>
        <h3>{group.label}</h3>
        <div className="action-grid">{group.options.map(([type, value, label]) =>
          <button key={value} className={mapping.value === value ? "selected" : ""} onClick={() => onChange({ ...mapping, type, value, label })}>
            <span>{type === "media" ? <Volume2/> : type === "system" ? <Power/> : <Command/>}</span><b>{label}</b><small>{value}</small>
          </button>)}
        </div>
      </section>)}
      <section className="action-section">
        <h3>自定义快捷键</h3>
        <div className="shortcut-input"><Command size={16}/><input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="例如 Ctrl+Shift+P"/><button onClick={() => onChange({ ...mapping, type: "shortcut", value: custom, label: custom })}>应用</button></div>
      </section>
    </aside>
  </div>;
}

function KeysPage({ profile, profiles, selectProfile, updateProfile, status, connect, liveOledFrame }) {
  const [selected, setSelected] = useState(null);
  const changeMapping = (next) => {
    updateProfile({ ...profile, mappings: profile.mappings.map((m) => m.key === next.key ? next : m) });
    setSelected(next);
  };
  return <>
    <DeviceHero status={status} connect={connect}/>
    <section className="content-section">
      <div className="section-title"><div><p>按键布局</p><h2>选择一个按键进行配置</h2></div><div className="layer-control"><span>当前预设</span><label className="profile-select"><select aria-label="选择当前预设" value={profile.id} onChange={(event) => { setSelected(null); selectProfile(event.target.value); }}>{profiles.map((item) => <option key={item.id} value={item.id}>P{item.slot + 1} · {item.name}</option>)}</select><ChevronDown size={14}/></label></div></div>
      <div className="physical-key-layout">
        <div className="layout-oled">
          <LiveOledCanvas
            frame={liveOledFrame}
            connected={status.state === "connected"}
          />
        </div>
        <div className="layout-knob"><div/><span>旋钮</span></div>
        {physicalKeySlots.map((slot) => {
          const mapping = profile.mappings.find((item) => item.key === slot.key);
          if (!mapping) return null;
          return <button
            key={mapping.key}
            className={`key-card physical-key-card slot-${slot.area}`}
            onClick={() => setSelected(mapping)}
          >
            <div className="key-top"><span>KEY {mapping.key}</span><SlidersHorizontal size={15}/></div>
            <div className={`keycap ${slot.area === "enter" ? "tall" : ""}`}><b>{mapping.label.length <= 4 ? mapping.label : mapping.key}</b><i/></div>
            <b className="action-label">{mapping.label}</b><small>{mapping.value}</small>
          </button>;
        })}
      </div>
    </section>
    {selected && <KeyEditor mapping={selected} onClose={() => setSelected(null)} onChange={changeMapping}/>}
  </>;
}

function OledPage({
  profile, updateProfile, runtime, updateRuntime, systemStatus, claudeStatus,
  deviceConnected, deviceMode, batteryPercent, batteryMillivolts,
  usbStatus, bleStatus, bleConnecting, onConnectBle, onDisconnectBle
}) {
  const oled = profile.oled;
  const [tool, setTool] = useState("draw");
  const [importMessage, setImportMessage] = useState("");
  const [previewNow, setPreviewNow] = useState(() => new Date());
  const imageInputRef = useRef(null);
  const set = (patch) => updateProfile({ ...profile, oled: { ...oled, ...patch } });
  const setBitmap = (bitmap) => set({ mode:"custom", bitmap });
  const selectContent = (page) => {
    if (page === "custom" && oled.mode !== "custom") {
      set({ mode:"custom", bitmap:oled.bitmap || bitmapToBase64(createBlankBitmap()) });
    }
    // 自定义画布必须保持可见，不能被后台 Coding 状态临时覆盖。
    updateRuntime({ ...runtime, page, autoClaude:page === "custom" ? false : runtime.autoClaude });
  };
  const importImage = async (event) => {
    const [file] = event.target.files || [];
    event.target.value = "";
    if (!file) return;
    try {
      const bitmap = await importImageBitmap(file);
      setBitmap(bitmapToBase64(bitmap));
      setImportMessage(`${file.name} 已转换为 1-bit 位图`);
    } catch (error) {
      setImportMessage(error.message);
    }
  };
  const selectedPage = runtime.page === "auto" ? "brand" : runtime.page;
  const claudeOverrides = selectedPage !== "custom" && runtime.autoClaude && (
    ["ready", "working", "tool", "waiting", "error"].includes(claudeStatus?.state) ||
    (claudeStatus?.state === "done" && Date.now() - Number(claudeStatus.updatedAt || 0) < 5000)
  );
  const previewPage = claudeOverrides ? "claude" : selectedPage;
  useEffect(() => {
    if (previewPage !== "claude") return undefined;
    const timer = setInterval(() => setPreviewNow(new Date()), 180);
    return () => clearInterval(timer);
  }, [previewPage]);
  const runtimePreviewBitmap = useMemo(() => renderRuntimePreview({
    page:previewPage,
    systemStatus,
    claudeStatus,
    profileSlot:profile.slot,
    connected:deviceConnected,
    connectionMode:deviceMode,
    batteryPercent,
    batteryMillivolts,
    now:previewNow
  }), [previewPage, systemStatus, claudeStatus, profile.slot, deviceConnected, deviceMode, batteryPercent, batteryMillivolts, previewNow]);
  const metricValue = (value) => Number.isFinite(value) ? `${Math.round(value)}%` : "--";
  const usbConnected = usbStatus?.state === "connected";
  const bleConnected = bleStatus?.state === "connected";
  const gattStatusText = usbConnected
    ? "USB 配置通道已连接"
    : bleConnected
      ? `蓝牙 GATT 已连接${Number.isFinite(bleStatus?.batteryPercent) ? ` · ${bleStatus.batteryPercent}%` : ""}`
      : bleConnecting
        ? "正在查找 Vico Keyboard…"
        : "蓝牙 GATT 未连接";

  return <section className="page-pad">
    <div className="page-heading oled-page-heading">
      <div className="icon-box"><Monitor/></div>
      <div><span>OLED STUDIO</span><h1>设计你的显示界面</h1><p>预览会实时呈现最终的 128 × 64 单色画面。</p></div>
      <div className={`oled-gatt-control ${deviceConnected ? "online" : ""}`}>
        <div className="oled-gatt-state">
          <i/>
          <div><b>{gattStatusText}</b><small>{usbConnected ? "OLED 修改将通过 USB 同步" : "用于同步 OLED 页面和状态信息"}</small></div>
        </div>
        <button
          className="secondary"
          disabled={bleConnecting || usbConnected}
          onClick={bleConnected ? onDisconnectBle : onConnectBle}
        >
          {bleConnecting ? <RefreshCw className="spin" size={14}/> : usbConnected ? <Usb size={14}/> : bleConnected ? <Unplug size={14}/> : <Bluetooth size={14}/>}
          {usbConnected ? "USB 已连接" : bleConnected ? "断开 GATT" : bleConnecting ? "连接中…" : "连接蓝牙 GATT"}
        </button>
      </div>
    </div>
    {!deviceConnected && <div className="oled-connection-notice"><Bluetooth size={16}/><div><b>当前仅显示本地预览</b><span>Windows 已配对键盘并不代表配置用 GATT 已连接。点击上方“连接蓝牙 GATT”，连接后当前 OLED 页面会自动同步到键盘。</span></div></div>}
    <div className="oled-grid">
      <div className="oled-preview-card">
        <div className="card-label"><span>设备实时预览</span><span>128 × 64 · 1-BIT</span></div>
        <OledPixelCanvas oled={selectedPage === "custom" ? { ...oled, mode:"custom" } : oled} tool={tool} onBitmapChange={setBitmap} previewBitmap={selectedPage === "custom" ? null : runtimePreviewBitmap}/>
        <p>{selectedPage === "custom" ? "拖动鼠标绘制；每个小方块对应 OLED 上的一个真实像素。" : claudeOverrides ? "Coding 自动覆盖正在生效；结束后会返回所选页面。" : "预览和键盘固件使用相同的像素坐标；性能数据约每秒更新一次。"}</p>
      </div>
      <div className="settings-card">
        <h2>显示内容</h2>
        <label htmlFor="oled-content-select">OLED 显示内容</label>
        <div className="oled-select-wrap">
          <select id="oled-content-select" value={selectedPage} onChange={(event) => selectContent(event.target.value)}>
            {OLED_CONTENT_OPTIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
          <ChevronDown size={15}/>
        </div>

        {selectedPage === "system" && <div className="performance-live">
          <div className="performance-live-head"><span className="live-dot"/>电脑性能实时数据</div>
          {[["CPU", systemStatus.cpu],["GPU", systemStatus.gpu],["内存", systemStatus.memory]].map(([label, value]) => <div className="performance-metric" key={label}>
            <div><span>{label}</span><b>{metricValue(value)}</b></div>
            <i><span style={{ width:Number.isFinite(value) ? `${Math.max(0, Math.min(100, value))}%` : "0%" }}/></i>
          </div>)}
          <small>{systemStatus.online === false ? "电脑监控服务离线" : "由 VicoDeck 后台服务持续采集"}</small>
        </div>}

        {selectedPage === "custom" && <div className="pixel-tools custom-pixel-tools">
          <div className="pixel-tool-row">
            <button className={tool === "draw" ? "active" : ""} onClick={() => setTool("draw")}><Pencil size={14}/>画笔</button>
            <button className={tool === "erase" ? "active" : ""} onClick={() => setTool("erase")}><Eraser size={14}/>橡皮</button>
            <button onClick={() => setBitmap(bitmapToBase64(invertBitmap(bitmapFromBase64(oled.bitmap))))}>反相</button>
          </div>
          <div className="pixel-tool-row">
            <button onClick={() => imageInputRef.current?.click()}><Upload size={14}/>导入图片</button>
            <button className="danger-subtle" onClick={() => setBitmap(bitmapToBase64(createBlankBitmap()))}><Trash2 size={14}/>清空</button>
          </div>
          <input ref={imageInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/bmp" hidden onChange={importImage}/>
          <p className="pixel-help">图片会等比缩放到 128 × 64，并转换成黑白 1-bit 数据。松开画笔或导入图片后自动同步。</p>
          {importMessage && <p className="pixel-import-message">{importMessage}</p>}
        </div>}

        <div className="setting-row compact"><div><b>Coding 自动覆盖</b><span>{selectedPage === "custom" ? "自定义像素画显示期间保持关闭" : "Claude Code 工作、等待或出错时自动切换到 Coding"}</span></div><Toggle disabled={selectedPage === "custom"} value={runtime.autoClaude} onChange={(value) => updateRuntime({ ...runtime, autoClaude:value })}/></div>
        <div className="runtime-help">选择后会立即通过 USB 或蓝牙同步到键盘；键盘端也可使用 Fn + KEY6 / KEY7 切换。</div>
        <div className="range-label"><label>屏幕亮度</label><b>{oled.brightness}%</b></div><input className="range" type="range" min="10" max="100" value={oled.brightness} onChange={(e) => set({ brightness:Number(e.target.value) })}/>
      </div>
    </div>
  </section>;
}

function RgbPage({ settings, updateSettings, usbStatus, bleStatus, bleConnecting, onConnectBle, onDisconnectBle }) {
  const usbConnected = usbStatus?.state === "connected";
  const bleConnected = bleStatus?.state === "connected";
  const connected = usbConnected || bleConnected;
  const effect = RGB_EFFECTS.find((item) => item.id === settings.effect) || RGB_EFFECTS[0];
  const previewStyle = {
    "--rgb-brightness":settings.enabled ? Math.max(.25, settings.brightness / 100) : 0,
    "--rgb-speed":`${Math.max(.35, 2.6 * 100 / settings.speed)}s`,
    "--rgb-fire-speed":`${Math.max(.12, .9 * 100 / settings.speed)}s`,
    "--rgb-solid-speed":`${Math.max(1.5, 6.2 * 100 / settings.speed)}s`,
    "--rgb-rainbow-breathe-speed":`${Math.max(2.1, 15.6 * 100 / settings.speed)}s`,
    "--rgb-custom-hue":`${colorHueOffset(settings.color)}deg`
  };
  const set = (patch) => updateSettings({ ...settings, ...patch });

  return <section className="page-pad rgb-page">
    <div className="page-heading rgb-page-heading">
      <div className="icon-box"><Palette/></div>
      <div><span>RGB LIGHTING</span><h1>设计你的键盘灯光</h1><p>灯效参数通过 USB 或蓝牙 GATT 实时同步，并保存在键盘中。</p></div>
      <div className={`rgb-connection ${connected ? "online" : ""}`}>
        <i/><b>{usbConnected ? "USB 已连接" : bleConnected ? "蓝牙 GATT 已连接" : "设备未连接"}</b>
        {!usbConnected && <button className="secondary" disabled={bleConnecting} onClick={bleConnected ? onDisconnectBle : onConnectBle}>
          {bleConnecting ? <RefreshCw className="spin" size={14}/> : bleConnected ? <Unplug size={14}/> : <Bluetooth size={14}/>}
          {bleConnecting ? "连接中…" : bleConnected ? "断开" : "连接蓝牙"}
        </button>}
      </div>
    </div>

    {!connected && <div className="oled-connection-notice"><Palette size={16}/><div><b>当前为本地灯效预览</b><span>连接 USB 配置通道或蓝牙 GATT 后，模式、亮度、速度和常亮颜色会自动同步到键盘。</span></div></div>}

    <div className="rgb-layout">
      <div className="rgb-preview-card">
        <div className="card-label"><span>灯光实时预览</span><span>8 × WS2812B · GPIO8</span></div>
        <div className={`rgb-product-preview effect-${effect.className} ${settings.enabled ? "enabled" : "disabled"}`} style={previewStyle}>
          <img src="/rgb-keyboard-layout.png" alt="Vico Keyboard RGB 灯光布局：OLED、八个按键与无灯光旋钮"/>
        </div>
        <div className="rgb-preview-meta"><div><span>当前灯效</span><b>{effect.name}</b></div><div><span>亮度</span><b>{settings.enabled ? `${settings.brightness}%` : "OFF"}</b></div><div><span>速度</span><b>{settings.effect === 6 ? "—" : `${settings.speed}%`}</b></div></div>
      </div>

      <div className="rgb-settings-card">
        <div className="rgb-master-row"><div><b>RGB 灯光</b><span>关闭后键盘会立即熄灭并记住设置</span></div><Toggle value={settings.enabled} onChange={(enabled) => set({ enabled })}/></div>
        <h2>灯光模式</h2>
        <div className="rgb-mode-select">
          <select aria-label="选择灯光模式" value={settings.effect} onChange={(event) => set({ effect:Number(event.target.value) })}>
            {RGB_EFFECTS.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
          </select>
          <ChevronDown size={15}/>
        </div>
        <p className="rgb-mode-description">{effect.description}</p>
        {(settings.effect === 1 || settings.effect === 6) && <div className="rgb-color-control">
          <div><label htmlFor="rgb-static-color">{settings.effect === 1 ? "呼吸颜色" : "常亮颜色"}</label><b>{settings.color?.toUpperCase?.() || "#D6FF38"}</b></div>
          <label className="rgb-color-picker" htmlFor="rgb-static-color">
            <input id="rgb-static-color" type="color" value={settings.color || "#D6FF38"} onChange={(event) => set({ color:event.target.value.toUpperCase() })}/>
            <span style={{ background:settings.color || "#D6FF38" }}/><em>选择颜色</em>
          </label>
          <small>{settings.effect === 1 ? "键盘会使用这个颜色完成连续的明暗呼吸。" : "键盘会持续保持这个颜色，直到你修改模式或关闭灯光。"}</small>
        </div>}
        <div className={`rgb-range-control ${settings.effect === 6 ? "disabled" : ""}`}>
          <div><label htmlFor="rgb-brightness">亮度</label><b>{settings.brightness}%</b></div>
          <input id="rgb-brightness" className="range" type="range" min="25" max="100" step="1" value={settings.brightness} onChange={(event) => set({ brightness:Number(event.target.value) })}/>
          <small>较低亮度可以明显延长电池续航。</small>
        </div>
        <div className="rgb-range-control">
          <div><label htmlFor="rgb-speed">动画速度</label><b>{settings.speed}%</b></div>
          <input disabled={settings.effect === 6} id="rgb-speed" className="range" type="range" min="50" max="200" step="5" value={settings.speed} onChange={(event) => set({ speed:Number(event.target.value) })}/>
          <small>{settings.effect === 6 ? "常亮模式不需要动画速度。" : "100% 为标准速度；仅影响动态灯效。"}</small>
        </div>
        <div className={`rgb-sync-state ${connected ? "online" : ""}`}><i/><span>{connected ? `修改会立即通过 ${usbConnected ? "USB" : "蓝牙 GATT"} 保存到键盘` : "等待连接，设置已保存在软件中"}</span></div>
      </div>
    </div>
  </section>;
}

function ProfilesPage({ config, status, syncing, onSelectProfile, onSyncCurrent, onSyncAll }) {
  const connected = status.state === "connected";
  const getSyncState = (profile) => {
    if (!connected || !status.profileCrcs?.length) return "未连接";
    try {
      return status.profileCrcs[profile.slot] === profileCrc(profile) ? "已同步" : "未同步";
    } catch {
      return "配置有误";
    }
  };
  return <section className="page-pad">
    <div className="page-heading"><div className="icon-box"><Layers3/></div><div><span>PROFILES</span><h1>五套预设</h1><p>在软件中编辑，随后同步到键盘；按住 Fn + KEY1～KEY5 可离线切换。</p></div><div className="profile-actions push"><button className="secondary" disabled={!connected || syncing} onClick={onSyncCurrent}>同步当前</button><button className="primary" disabled={!connected || syncing} onClick={onSyncAll}>{syncing ? "同步中…" : "同步全部"}</button></div></div>
    <div className="profile-list">{config.profiles.map((p, i) => {
      const syncState = getSyncState(p);
      const stateLabel = status.activeProfile === p.slot ? `键盘当前 · ${syncState}` : syncState;
      return <button key={p.id} className={`profile-card ${p.id === config.activeProfile ? "active" : ""}`} onClick={() => onSelectProfile(p.id)}>
        <div className="profile-number">0{i+1}</div><div><span>{stateLabel}</span><h3>{p.name}</h3><p>8 个按键 · P{i + 1} · {p.id === config.activeProfile ? "正在编辑" : "点击编辑"}</p></div><ChevronDown className="profile-chevron"/>
      </button>;
    })}</div>
  </section>;
}

function SettingsPage({ config, setConfig, version }) {
  const setAutostart = async (value) => {
    const actual = window.vico ? await window.vico.setAutostart(value) : value;
    setConfig({ ...config, startAtLogin:actual });
  };
  const rows = [
    ["开机时启动 Vico Keyboard", "登录 Windows 后自动在后台运行", config.startAtLogin, setAutostart],
    ["关闭窗口时最小化到托盘", "保持按键服务与设备连接", config.closeToTray, (v) => setConfig({ ...config, closeToTray:v })],
    ["启动时隐藏主窗口", "配合开机自启动安静运行", config.launchMinimized, (v) => setConfig({ ...config, launchMinimized:v })]
  ];
  return <section className="page-pad settings-page">
    <div className="page-heading"><div className="icon-box"><Settings/></div><div><span>PREFERENCES</span><h1>应用设置</h1><p>控制后台服务、启动方式与更新策略。</p></div></div>
    <div className="settings-block"><h2>启动与后台</h2>{rows.map(([title, sub, value, change]) => <div className="setting-row" key={title}><div><b>{title}</b><span>{sub}</span></div><Toggle value={value} onChange={change}/></div>)}</div>
    <div className="settings-block"><h2>设备与更新</h2>
      <div className="setting-row"><div><b>Vico Keyboard Desktop</b><span>版本 {version} · Electron / WebHID</span></div><button className="secondary"><RefreshCw size={15}/>检查更新</button></div>
      <div className="setting-row"><div><b>设备通信协议</b><span>64-byte HID Feature Report · 草案 v1</span></div><span className="tag">开发模式</span></div>
    </div>
  </section>;
}

export default function App() {
  const [config, setConfig] = useState(null);
  const [page, setPage] = useState("keys");
  const [status, setStatus] = useState({ state:"disconnected" });
  const [syncing, setSyncing] = useState(false);
  const [toast, setToast] = useState("");
  const [version, setVersion] = useState("0.1.0");
  const [claudeStatus, setClaudeStatus] = useState({ state:"offline", tool:"", text:"Waiting for Claude Code", event:"None", updatedAt:0 });
  const [systemStatus, setSystemStatus] = useState({ cpu:0, gpu:null, memory:0, temperature:null, online:true, updatedAt:0 });
  const [bleStatus, setBleStatus] = useState({ state:"disconnected" });
  const [hooksState, setHooksState] = useState(null);
  const [activity, setActivity] = useState([]);
  const [bleConnecting, setBleConnecting] = useState(false);
  const [hooksInstalling, setHooksInstalling] = useState(false);
  const [deviceSelection, setDeviceSelection] = useState(null);
  const [liveOledFrame, setLiveOledFrame] = useState(null);
  const deviceRef = useRef(null);
  const bleDeviceRef = useRef(null);
  const saveTimer = useRef(null);
  const rgbSyncTimer = useRef(null);
  const lastDeviceProfile = useRef(null);
  const activeOledBitmap = config?.profiles
    ?.find((item) => item.id === config.activeProfile)
    ?.oled?.bitmap;

  useEffect(() => {
    const receiveRuntimeSettings = (oledRuntime) => {
      setConfig((current) => {
        if (!current || (current.oledRuntime?.page === oledRuntime.page &&
            current.oledRuntime?.autoClaude === oledRuntime.autoClaude)) return current;
        return { ...current, oledRuntime };
      });
    };
    deviceRef.current = new VicoDevice(setStatus, setLiveOledFrame, receiveRuntimeSettings);
    deviceRef.current.restore().catch(() => {});
    bleDeviceRef.current = new VicoBleDevice(setBleStatus, () => {}, receiveRuntimeSettings);
    bleDeviceRef.current.restore().catch(() => {});
    Promise.all([
      window.vico?.getConfig?.() || fallbackConfig,
      window.vico?.getAutostart?.() ?? false,
      window.vico?.getVersion?.() || "0.1.0",
      window.vico?.getClaudeStatus?.(),
      window.vico?.getClaudeHooksState?.(),
      window.vico?.getSystemStatus?.()
    ]).then(([saved, autostart, appVersion, initialClaudeStatus, initialHooksState, initialSystemStatus]) => {
      const savedRuntime = saved?.oledRuntime || fallbackConfig.oledRuntime;
      setConfig({
        ...fallbackConfig,
        ...saved,
        oledRuntime:{ ...savedRuntime, page:savedRuntime.page === "auto" ? "brand" : savedRuntime.page },
        rgb:{ ...fallbackConfig.rgb, ...(saved?.rgb || {}) },
        startAtLogin:autostart
      });
      setVersion(appVersion);
      if (initialClaudeStatus) {
        setClaudeStatus(initialClaudeStatus);
      }
      setHooksState(initialHooksState || null);
      if (initialSystemStatus) setSystemStatus(initialSystemStatus);
    });

    const removeClaudeListener = window.vico?.onClaudeStatus?.((nextStatus) => {
      setClaudeStatus(nextStatus);
      setActivity((items) => [nextStatus.observed || nextStatus, ...items].slice(0, 10));
    });
    const removeSystemListener = window.vico?.onSystemStatus?.(setSystemStatus);
    const removeDeviceSelectionListener = window.vico?.onDeviceSelection?.(setDeviceSelection);
    return () => {
      removeClaudeListener?.();
      removeSystemListener?.();
      removeDeviceSelectionListener?.();
    };
  }, []);

  useEffect(() => {
    if (!config) return;
    const packets = buildRuntimeStatusPackets(claudeStatus, systemStatus);
    deviceRef.current?.writeRuntimePackets(packets).catch(() => {});
    bleDeviceRef.current?.writeRuntimePackets(packets).catch(() => {});
  }, [config, claudeStatus, systemStatus, status.state, bleStatus.state]);

  useEffect(() => {
    bleDeviceRef.current?.writeClaudeStatus(claudeStatus).catch(() => {});
  }, [claudeStatus, bleStatus.state]);

  useEffect(() => {
    if (!config?.oledRuntime) return;
    const packet = buildRuntimeSettingsPacket(config.oledRuntime);
    deviceRef.current?.writeRuntimePacket(packet).catch(() => {});
    bleDeviceRef.current?.writeRuntimePacket(packet).catch(() => {});
  }, [config?.oledRuntime, status.state, bleStatus.state]);

  useEffect(() => {
    if (config?.oledRuntime?.page !== "custom") return;
    const packets = buildRuntimeBitmapPackets(bitmapFromBase64(activeOledBitmap));
    deviceRef.current?.writeRuntimePackets(packets).catch(() => {});
    bleDeviceRef.current?.writeRuntimePackets(packets).catch(() => {});
  }, [config?.oledRuntime?.page, activeOledBitmap, status.state, bleStatus.state]);

  useEffect(() => {
    if (!config?.rgb) return;
    clearTimeout(rgbSyncTimer.current);
    // 滑块拖动时只发送最后一个值，避免大量过期设置堆积在 BLE 写入队列中。
    rgbSyncTimer.current = setTimeout(() => {
      const packet = buildRgbSettingsPacket(config.rgb);
      deviceRef.current?.writeRuntimePacket(packet).catch(() => {});
      bleDeviceRef.current?.writeRuntimePacket(packet).catch(() => {});
    }, 80);
    return () => clearTimeout(rgbSyncTimer.current);
  }, [config?.rgb, status.state, bleStatus.state]);

  useEffect(() => {
    if (!config) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => window.vico?.saveConfig?.(config), 350);
    return () => clearTimeout(saveTimer.current);
  }, [config]);

  useEffect(() => {
    if (status.state !== "connected" || !Number.isInteger(status.activeProfile)) {
      lastDeviceProfile.current = null;
      return;
    }
    if (lastDeviceProfile.current === status.activeProfile) return;
    lastDeviceProfile.current = status.activeProfile;

    // 让所有页面跟随键盘端发起的预设切换（设置菜单或 Fn + KEY1～KEY5）。
    // 重新连接后也会立即对齐；当设备活动预设没有真正变化时，
    // 该引用可防止软件中的本地编辑选择被覆盖。
    setConfig((current) => {
      if (!current) return current;
      const target = current.profiles.find((item) => item.slot === status.activeProfile);
      return target && target.id !== current.activeProfile
        ? { ...current, activeProfile: target.id }
        : current;
    });
  }, [status.state, status.activeProfile]);

  const profile = useMemo(() => config?.profiles.find((p) => p.id === config.activeProfile) || config?.profiles[0], [config]);
  if (!config || !profile) return <div className="loading"><div className="brand-mark"><span>V</span></div><p>正在准备你的工作台…</p></div>;

  const updateProfile = (next) => setConfig((current) => ({
    ...current,
    profiles:current.profiles.map((item) => item.id === next.id ? next : item)
  }));
  const selectProfile = async (profileId) => {
    const target = config.profiles.find((item) => item.id === profileId);
    if (!target) return;

    // 立即选择以保证编辑操作流畅；USB 配置通道连接时，
    // 同时激活设备上的相同槽位。该命令不会覆盖预设的按键绑定。
    setConfig((current) => current
      ? { ...current, activeProfile: target.id }
      : current);
    if (status.state !== "connected") return;

    try {
      await deviceRef.current.activateProfile(target.slot);
    } catch (error) {
      // 激活失败时恢复设备确认的槽位，避免两端静默显示不同的活动预设。
      const actualSlot = deviceRef.current?.connectedStatus?.activeProfile;
      setConfig((current) => {
        if (!current || !Number.isInteger(actualSlot)) return current;
        const actual = current.profiles.find((item) => item.slot === actualSlot);
        return actual ? { ...current, activeProfile: actual.id } : current;
      });
      setToast(error.message);
    }
  };
  const connect = async () => {
    try { await deviceRef.current.request(); setToast("Vico Keyboard 已连接"); }
    catch (error) { if (error.name !== "NotFoundError") setToast(error.message); }
  };
  const disconnect = async () => {
    try { await deviceRef.current.disconnect(); setToast("USB 配置通道已断开"); }
    catch (error) { setToast(error.message); }
  };
  const sync = async () => {
    setSyncing(true);
    try { await deviceRef.current.sync(profile); setToast("配置已同步到键盘"); }
    catch (error) { setToast(error.message); }
    finally { setSyncing(false); }
  };
  const syncAll = async () => {
    setSyncing(true);
    try {
      await deviceRef.current.syncAll(config.profiles, config.activeProfile);
      setToast("五套预设已全部同步到键盘");
    } catch (error) { setToast(error.message); }
    finally { setSyncing(false); }
  };
  const connectBle = async () => {
    setBleConnecting(true);
    try {
      await bleDeviceRef.current.request();
      setToast("Vico 蓝牙状态通道已连接");
    } catch (error) {
      if (error.name !== "NotFoundError") setToast(error.message);
    } finally { setBleConnecting(false); }
  };
  const disconnectBle = () => {
    bleDeviceRef.current.disconnect();
    setToast("Vico 蓝牙状态通道已断开");
  };
  const selectDevice = async (deviceId) => {
    if (!deviceSelection) return;
    const requestId = deviceSelection.requestId;
    setDeviceSelection(null);
    await window.vico?.selectDevice?.(requestId, deviceId);
  };
  const installHooks = async () => {
    setHooksInstalling(true);
    try {
      const result = await window.vico.installClaudeHooks();
      setHooksState(result);
      setToast("Claude Code hooks 已安装，新会话将自动上报状态");
    } catch (error) { setToast(error.message); }
    finally { setHooksInstalling(false); }
  };
  const sendTestStatus = async () => {
    const testStatus = { state:"tool", tool:"Vico Test", text:"Status relay is working", event:"ManualTest", updatedAt:Date.now() };
    try {
      const packets = buildRuntimeStatusPackets(testStatus, systemStatus);
      const [usbSent, bleSent] = await Promise.all([
        deviceRef.current.writeRuntimePackets(packets),
        bleDeviceRef.current.writeRuntimePackets(packets)
      ]);
      if (!usbSent && !bleSent) throw new Error("请先通过 USB 或蓝牙连接 Vico Keyboard");
      setToast("测试状态已发送到 OLED");
    }
    catch (error) { setToast(error.message); }
  };

  return <div className="app-shell">
    <Sidebar page={page} setPage={setPage}/>
    <main className="main">
      <Header status={status} connect={connect} disconnect={disconnect} syncing={syncing} sync={sync}/>
      <div className="scroll-area">
        {page === "keys" && <KeysPage profile={profile} profiles={config.profiles} selectProfile={selectProfile} updateProfile={updateProfile} status={status} connect={connect} liveOledFrame={liveOledFrame}/>}
        {page === "oled" && (
          <OledPage
            profile={profile}
            updateProfile={updateProfile}
            runtime={config.oledRuntime}
            updateRuntime={(oledRuntime) => setConfig((current) => ({ ...current, oledRuntime }))}
            systemStatus={systemStatus}
            claudeStatus={claudeStatus}
            deviceConnected={status.state === "connected" || bleStatus.state === "connected"}
            deviceMode={status.state === "connected" ? "USB" : bleStatus.state === "connected" ? "BLE" : "ADV"}
            batteryPercent={status.state === "connected" ? status.batteryPercent : bleStatus.batteryPercent}
            batteryMillivolts={status.state === "connected" ? status.batteryMillivolts : null}
            usbStatus={status}
            bleStatus={bleStatus}
            bleConnecting={bleConnecting}
            onConnectBle={connectBle}
            onDisconnectBle={disconnectBle}
          />
        )}
        {page === "rgb" && <RgbPage
          settings={config.rgb}
          updateSettings={(rgb) => setConfig((current) => ({ ...current, rgb }))}
          usbStatus={status}
          bleStatus={bleStatus}
          bleConnecting={bleConnecting}
          onConnectBle={connectBle}
          onDisconnectBle={disconnectBle}
        />}
        {page === "profiles" && <ProfilesPage config={config} status={status} syncing={syncing} onSelectProfile={selectProfile} onSyncCurrent={sync} onSyncAll={syncAll}/>}
        {page === "claude" && <ClaudePage claudeStatus={claudeStatus} usbStatus={status} bleStatus={bleStatus} hooksState={hooksState} activity={activity} connecting={bleConnecting} installing={hooksInstalling} onConnect={connectBle} onDisconnect={disconnectBle} onInstallHooks={installHooks} onSendTest={sendTestStatus}/>}
        {page === "settings" && <SettingsPage config={config} setConfig={setConfig} version={version}/>}
      </div>
    </main>
    <DeviceSelectionDialog request={deviceSelection} onSelect={selectDevice}/>
    {toast && <div className="toast" onAnimationEnd={() => setToast("")}><Sparkles size={15}/>{toast}</div>}
  </div>;
}
