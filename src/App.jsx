import { useEffect, useMemo, useRef, useState } from "react";
import {
  BatteryMedium, Bluetooth, ChevronDown, CircleHelp, Command, Cpu, Download,
  Gauge, Keyboard, Layers3, Monitor, Moon, MoreHorizontal, Play, Plus,
  Power, RefreshCw, Rocket, Save, Settings, SlidersHorizontal, Sparkles,
  Sun, Usb, Volume2, WifiOff, X
} from "lucide-react";
import { VicoBleDevice, VicoDevice } from "./device";
import ClaudePage from "./ClaudePage";

const fallbackConfig = {
  startAtLogin: false, minimizeToTray: true, closeToTray: true,
  activeProfile: "default",
  profiles: [{
    id: "default", name: "默认配置",
    mappings: Array.from({ length: 8 }, (_, i) => ({ key: i + 1, type: "keyboard", value: `F${i + 1}`, label: `F${i + 1}` })),
    oled: { mode: "dashboard", title: "VICO", subtitle: "CREATE YOUR FLOW", brightness: 78, sleepMinutes: 5, showBattery: true, showConnection: true }
  }]
};

const actionGroups = [
  { label: "常用", options: [
    ["shortcut", "Ctrl+C", "复制"], ["shortcut", "Ctrl+V", "粘贴"],
    ["shortcut", "Ctrl+Z", "撤销"], ["shortcut", "Ctrl+Shift+Z", "重做"]
  ]},
  { label: "媒体", options: [
    ["media", "PLAY_PAUSE", "播放 / 暂停"], ["media", "VOLUME_UP", "音量 +"],
    ["media", "VOLUME_DOWN", "音量 -"], ["media", "MUTE", "静音"]
  ]},
  { label: "系统", options: [
    ["system", "LOCK_SCREEN", "锁定屏幕"], ["system", "SHOW_DESKTOP", "显示桌面"],
    ["system", "SCREENSHOT", "截图"], ["system", "DO_NOTHING", "无操作"]
  ]}
];

function Toggle({ value, onChange, disabled }) {
  return <button disabled={disabled} className={`toggle ${value ? "on" : ""}`} onClick={() => onChange(!value)}><span /></button>;
}

function Brand() {
  return <div className="brand"><div className="brand-mark"><span>V</span></div><div><b>VICO</b><small>KEYBOARD</small></div></div>;
}

function Sidebar({ page, setPage }) {
  const items = [
    ["keys", Keyboard, "按键配置"], ["oled", Monitor, "OLED 显示"], ["profiles", Layers3, "配置文件"], ["claude", Cpu, "Claude Code"], ["settings", Settings, "设置"]
  ];
  return <aside className="sidebar">
    <Brand />
    <nav>
      <p>设备</p>
      {items.slice(0, 3).map(([id, Icon, label]) => <button key={id} className={page === id ? "active" : ""} onClick={() => setPage(id)}><Icon size={18}/><span>{label}</span></button>)}
      <p>应用</p>
      {items.slice(3).map(([id, Icon, label]) => <button key={id} className={page === id ? "active" : ""} onClick={() => setPage(id)}><Icon size={18}/><span>{label}</span></button>)}
    </nav>
    <div className="sidebar-help"><CircleHelp size={17}/><div><b>需要帮助？</b><span>查看连接与固件指南</span></div></div>
  </aside>;
}

function Header({ status, connect, syncing, sync }) {
  const connected = status.state === "connected";
  return <header className="topbar">
    <div className="crumb"><span>Vico Keyboard</span><ChevronDown size={15}/></div>
    <div className="top-actions">
      <div className={`device-pill ${connected ? "connected" : ""}`}><span className="status-dot"/>{connected ? status.name : "设备未连接"}</div>
      <button className="ghost square"><MoreHorizontal size={19}/></button>
      <button className="connect-btn" onClick={connected ? sync : connect} disabled={syncing}>
        {syncing ? <RefreshCw className="spin" size={16}/> : connected ? <Save size={16}/> : <Usb size={16}/>}
        {syncing ? "正在同步" : connected ? "同步到设备" : "连接设备"}
      </button>
    </div>
  </header>;
}

function DeviceHero({ status, connect }) {
  const connected = status.state === "connected";
  return <section className="device-hero">
    <div>
      <div className="eyebrow"><span className="live-dot"/> VICO 8 · ESP32-S3</div>
      <h1>让每一次触发，<br/><em>都恰到好处。</em></h1>
      <p>8 个可编程按键与一块属于你的 OLED。<br/>为常用动作创建更短、更自然的路径。</p>
      {!connected && <button className="hero-connect" onClick={connect}><Usb size={17}/>连接 Vico 8</button>}
    </div>
    <div className="device-visual">
      <div className="glow"/>
      <div className="keyboard-shell">
        <div className="mini-oled"><b>VICO</b><span>READY TO CREATE</span><i/></div>
        <div className="mini-keys">{Array.from({ length: 8 }, (_, i) => <span key={i}>{i + 1}</span>)}</div>
      </div>
      <div className="connection-tag">{connected ? <><BatteryMedium size={16}/> 86% · USB</> : <><WifiOff size={16}/> 等待连接</>}</div>
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

function KeysPage({ profile, updateProfile, status, connect }) {
  const [selected, setSelected] = useState(null);
  const changeMapping = (next) => {
    updateProfile({ ...profile, mappings: profile.mappings.map((m) => m.key === next.key ? next : m) });
    setSelected(next);
  };
  return <>
    <DeviceHero status={status} connect={connect}/>
    <section className="content-section">
      <div className="section-title"><div><p>按键布局</p><h2>选择一个按键进行配置</h2></div><div className="layer-control"><span>当前层</span><button>基础层 <ChevronDown size={14}/></button></div></div>
      <div className="key-layout">
        {profile.mappings.map((mapping) => <button key={mapping.key} className="key-card" onClick={() => setSelected(mapping)}>
          <div className="key-top"><span>KEY {mapping.key}</span><SlidersHorizontal size={15}/></div>
          <div className="keycap"><b>{mapping.label.length <= 4 ? mapping.label : mapping.key}</b><i/></div>
          <b className="action-label">{mapping.label}</b><small>{mapping.value}</small>
        </button>)}
      </div>
    </section>
    {selected && <KeyEditor mapping={selected} onClose={() => setSelected(null)} onChange={changeMapping}/>}
  </>;
}

function OledPreview({ oled }) {
  return <div className="oled-device">
    <div className="oled-screen" style={{ opacity: .35 + oled.brightness / 155 }}>
      <div className="oled-status"><span>{oled.showConnection ? "USB" : ""}</span><span>{oled.showBattery ? "86%" : ""}</span></div>
      {oled.mode === "minimal" ? <><h4>{oled.title}</h4><div className="oled-line"/></> :
       oled.mode === "stats" ? <><h4>72 WPM</h4><p>KEYS 1,284</p><div className="oled-bars"><i/><i/><i/><i/><i/></div></> :
       <><h4>{oled.title || "VICO"}</h4><p>{oled.subtitle || "CREATE YOUR FLOW"}</p><div className="oled-wave">⌁⌁⌁⌁⌁</div></>}
    </div>
  </div>;
}

function OledPage({ profile, updateProfile }) {
  const oled = profile.oled;
  const set = (patch) => updateProfile({ ...profile, oled: { ...oled, ...patch } });
  return <section className="page-pad">
    <div className="page-heading"><div className="icon-box"><Monitor/></div><div><span>OLED STUDIO</span><h1>设计你的显示界面</h1><p>预览会实时呈现最终的 128 × 64 单色画面。</p></div></div>
    <div className="oled-grid">
      <div className="oled-preview-card"><div className="card-label"><span>实时预览</span><span>128 × 64 PX</span></div><OledPreview oled={oled}/><p>拖动亮度滑块，预览真实屏幕的明暗效果</p></div>
      <div className="settings-card">
        <h2>显示内容</h2>
        <label>布局样式</label>
        <div className="mode-tabs">{[["dashboard","品牌"],["minimal","极简"],["stats","统计"]].map(([id,label]) => <button className={oled.mode === id ? "active" : ""} onClick={() => set({ mode:id })} key={id}>{label}</button>)}</div>
        <label>主标题</label><input maxLength={16} value={oled.title} onChange={(e) => set({ title:e.target.value.toUpperCase() })}/>
        <label>副标题</label><input maxLength={24} value={oled.subtitle} onChange={(e) => set({ subtitle:e.target.value.toUpperCase() })}/>
        <div className="range-label"><label>屏幕亮度</label><b>{oled.brightness}%</b></div><input className="range" type="range" min="10" max="100" value={oled.brightness} onChange={(e) => set({ brightness:Number(e.target.value) })}/>
        <div className="setting-row compact"><div><b>显示连接状态</b><span>USB / 蓝牙状态图标</span></div><Toggle value={oled.showConnection} onChange={(v) => set({ showConnection:v })}/></div>
        <div className="setting-row compact"><div><b>显示电量</b><span>无线模式下显示剩余电量</span></div><Toggle value={oled.showBattery} onChange={(v) => set({ showBattery:v })}/></div>
      </div>
    </div>
  </section>;
}

function ProfilesPage({ config, setConfig }) {
  const add = () => {
    const id = `profile-${Date.now()}`;
    const base = config.profiles.find((p) => p.id === config.activeProfile);
    setConfig({ ...config, activeProfile:id, profiles:[...config.profiles, { ...structuredClone(base), id, name:`配置 ${config.profiles.length + 1}` }] });
  };
  return <section className="page-pad">
    <div className="page-heading"><div className="icon-box"><Layers3/></div><div><span>PROFILES</span><h1>配置文件</h1><p>为不同应用和工作场景准备独立布局。</p></div><button className="primary push" onClick={add}><Plus size={16}/>新建配置</button></div>
    <div className="profile-list">{config.profiles.map((p, i) => <button key={p.id} className={`profile-card ${p.id === config.activeProfile ? "active" : ""}`} onClick={() => setConfig({ ...config, activeProfile:p.id })}>
      <div className="profile-number">0{i+1}</div><div><span>{p.id === config.activeProfile ? "当前使用" : "本地配置"}</span><h3>{p.name}</h3><p>8 个按键 · {p.oled.mode === "dashboard" ? "品牌 OLED" : "自定义 OLED"}</p></div><ChevronDown className="profile-chevron"/>
    </button>)}</div>
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
  const [bleStatus, setBleStatus] = useState({ state:"disconnected" });
  const [hooksState, setHooksState] = useState(null);
  const [activity, setActivity] = useState([]);
  const [bleConnecting, setBleConnecting] = useState(false);
  const [hooksInstalling, setHooksInstalling] = useState(false);
  const deviceRef = useRef(null);
  const bleDeviceRef = useRef(null);
  const latestClaudeStatus = useRef(claudeStatus);
  const saveTimer = useRef(null);

  useEffect(() => {
    deviceRef.current = new VicoDevice(setStatus);
    deviceRef.current.restore().catch(() => {});
    bleDeviceRef.current = new VicoBleDevice(setBleStatus, () => {});
    bleDeviceRef.current.restore().catch(() => {});
    Promise.all([
      window.vico?.getConfig?.() || fallbackConfig,
      window.vico?.getAutostart?.() ?? false,
      window.vico?.getVersion?.() || "0.1.0",
      window.vico?.getClaudeStatus?.(),
      window.vico?.getClaudeHooksState?.()
    ]).then(([saved, autostart, appVersion, initialClaudeStatus, initialHooksState]) => {
      setConfig({ ...fallbackConfig, ...saved, startAtLogin:autostart });
      setVersion(appVersion);
      if (initialClaudeStatus) {
        latestClaudeStatus.current = initialClaudeStatus;
        setClaudeStatus(initialClaudeStatus);
      }
      setHooksState(initialHooksState || null);
    });

    const removeClaudeListener = window.vico?.onClaudeStatus?.((nextStatus) => {
      latestClaudeStatus.current = nextStatus;
      setClaudeStatus(nextStatus);
      setActivity((items) => [nextStatus, ...items].slice(0, 10));
      bleDeviceRef.current?.writeClaudeStatus(nextStatus).catch(() => {});
    });
    return () => removeClaudeListener?.();
  }, []);

  useEffect(() => {
    if (bleStatus.state === "connected") {
      bleDeviceRef.current?.writeClaudeStatus(latestClaudeStatus.current).catch(() => {});
    }
  }, [bleStatus.state]);

  useEffect(() => {
    if (!config) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => window.vico?.saveConfig?.(config), 350);
    return () => clearTimeout(saveTimer.current);
  }, [config]);

  const profile = useMemo(() => config?.profiles.find((p) => p.id === config.activeProfile) || config?.profiles[0], [config]);
  if (!config || !profile) return <div className="loading"><div className="brand-mark"><span>V</span></div><p>正在准备你的工作台…</p></div>;

  const updateProfile = (next) => setConfig({ ...config, profiles:config.profiles.map((p) => p.id === next.id ? next : p) });
  const connect = async () => {
    try { await deviceRef.current.request(); setToast("Vico Keyboard 已连接"); }
    catch (error) { if (error.name !== "NotFoundError") setToast(error.message); }
  };
  const sync = async () => {
    setSyncing(true);
    try { await deviceRef.current.sync(profile); setToast("配置已同步到键盘"); }
    catch (error) { setToast(error.message); }
    finally { setSyncing(false); }
  };
  const connectBle = async () => {
    setBleConnecting(true);
    try {
      await bleDeviceRef.current.request();
      await bleDeviceRef.current.writeClaudeStatus(latestClaudeStatus.current);
      setToast("Vico 蓝牙状态通道已连接");
    } catch (error) {
      if (error.name !== "NotFoundError") setToast(error.message);
    } finally { setBleConnecting(false); }
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
    try { await bleDeviceRef.current.writeClaudeStatus(testStatus); setToast("测试状态已发送到 OLED"); }
    catch (error) { setToast(error.message); }
  };

  return <div className="app-shell">
    <Sidebar page={page} setPage={setPage}/>
    <main className="main">
      <Header status={status} connect={connect} syncing={syncing} sync={sync}/>
      <div className="scroll-area">
        {page === "keys" && <KeysPage profile={profile} updateProfile={updateProfile} status={status} connect={connect}/>}
        {page === "oled" && <OledPage profile={profile} updateProfile={updateProfile}/>}
        {page === "profiles" && <ProfilesPage config={config} setConfig={setConfig}/>}
        {page === "claude" && <ClaudePage claudeStatus={claudeStatus} bleStatus={bleStatus} hooksState={hooksState} activity={activity} connecting={bleConnecting} installing={hooksInstalling} onConnect={connectBle} onInstallHooks={installHooks} onSendTest={sendTestStatus}/>}
        {page === "settings" && <SettingsPage config={config} setConfig={setConfig} version={version}/>}
      </div>
    </main>
    {toast && <div className="toast" onAnimationEnd={() => setToast("")}><Sparkles size={15}/>{toast}</div>}
  </div>;
}
