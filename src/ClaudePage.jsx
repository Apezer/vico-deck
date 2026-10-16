import { useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bluetooth,
  CheckCircle2,
  Clock3,
  Code2,
  Radio,
  RefreshCw,
  TerminalSquare,
  Unplug,
  Usb
} from "lucide-react";

const STATE_LABELS = {
  offline: "等待 Claude Code",
  ready: "会话已就绪",
  working: "正在思考",
  tool: "正在使用工具",
  waiting: "等待用户输入",
  done: "任务已完成",
  error: "执行遇到错误"
};

function formatTime(value) {
  if (!value) return "--:--:--";
  return new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
}

export default function ClaudePage({
  claudeStatus,
  usbStatus,
  bleStatus,
  hooksState,
  activity,
  connecting,
  installing,
  onConnect,
  onDisconnect,
  onInstallHooks,
  onSendTest
}) {
  const [showHooksConfirmation, setShowHooksConfirmation] = useState(false);
  const bleConnected = bleStatus.state === "connected";
  const usbConnected = usbStatus.state === "connected";
  const transportConnected = usbConnected || bleConnected;
  const hooksInstalled = hooksState?.installed;

  return <section className="page-pad claude-page">
    <div className="page-heading">
      <div className="icon-box"><Activity /></div>
      <div>
        <span>CLAUDE CODE RELAY</span>
        <h1>Claude Code 状态转发</h1>
        <p>后台捕获 Claude Code 生命周期事件，并通过 USB 或 BLE 转发到键盘 OLED。</p>
      </div>
      <div className={`relay-health ${hooksInstalled && transportConnected ? "online" : ""}`}>
        <i />{hooksInstalled && transportConnected ? "转发服务运行中" : "等待完成设置"}
      </div>
    </div>

    <div className="relay-flow">
      <div className={`relay-node ${hooksInstalled ? "ready" : ""}`}>
        <div className="relay-node-icon"><TerminalSquare /></div>
        <div><span>01 · SOURCE</span><b>Claude Code Hooks</b><small>{hooksInstalled ? `事件监听 v${hooksState.hookVersion} 已安装` : hooksState?.needsUpgrade ? "检测到旧版 hooks，需要升级" : "尚未安装 hooks"}</small></div>
        {hooksInstalled ? <CheckCircle2 className="node-check" /> : <i className="node-empty" />}
      </div>
      <div className="relay-link"><i /><i /><i /></div>
      <div className={`relay-node ${claudeStatus.updatedAt ? "ready" : ""}`}>
        <div className="relay-node-icon"><Radio /></div>
        <div><span>02 · RELAY</span><b>Vico 后台服务</b><small>localhost:38471 · {claudeStatus.activeSessions || 0} 个会话</small></div>
        <span className="node-live">LIVE</span>
      </div>
      <div className="relay-link"><i /><i /><i /></div>
      <div className={`relay-node ${transportConnected ? "ready" : ""}`}>
        <div className="relay-node-icon">{usbConnected ? <Usb /> : <Bluetooth />}</div>
        <div><span>03 · DISPLAY</span><b>Vico Keyboard</b><small>{usbConnected ? `${usbStatus.name || "Vico Keyboard"} · USB` : bleConnected ? `${bleStatus.name} · BLE GATT` : "USB / BLE 未连接"}</small></div>
        {transportConnected ? <CheckCircle2 className="node-check" /> : <i className="node-empty" />}
      </div>
    </div>

    <div className="claude-dashboard">
      <div className="claude-status-card">
        <div className="card-label"><span>当前状态</span><span>{formatTime(claudeStatus.updatedAt)}</span></div>
        <div className={`claude-orb state-${claudeStatus.state}`}><div><i /><i /><i /></div></div>
        <div className="claude-current">
          <span>{claudeStatus.event || "NO EVENT"}</span>
          <h2>{STATE_LABELS[claudeStatus.state] || claudeStatus.state}</h2>
          <p>{claudeStatus.tool ? `${claudeStatus.tool} · ` : ""}{claudeStatus.text}</p>
        </div>
        <div className="oled-payload">
          <span>OLED PAYLOAD</span>
          <code>{`{"state":"${claudeStatus.state}","tool":"${claudeStatus.tool || ""}","text":"${claudeStatus.text}"}`}</code>
        </div>
      </div>

      <div className="relay-control-card">
        <h2>连接设置</h2>
        <div className="relay-step">
          <div className={hooksInstalled ? "done" : ""}>{hooksInstalled ? <CheckCircle2 /> : "1"}</div>
          <section><b>安装或升级 Claude Code hooks</b><p>合并到现有 settings.json，不会覆盖环境变量、权限配置或第三方 hooks。</p></section>
          <button className="secondary" disabled={installing || hooksInstalled} onClick={() => setShowHooksConfirmation(true)}>
            {installing && <RefreshCw className="spin" size={14} />}{hooksInstalled ? `已安装 v${hooksState.hookVersion}` : installing ? "安装中" : hooksState?.needsUpgrade ? "升级" : "安装"}
          </button>
        </div>
        <div className="relay-step">
          <div className={transportConnected ? "done" : ""}>{transportConnected ? <CheckCircle2 /> : "2"}</div>
          <section><b>连接 Vico Keyboard</b><p>USB 配置通道可直接转发；蓝牙模式使用自定义 GATT 服务。</p></section>
          <button className="secondary" disabled={connecting || usbConnected} onClick={bleConnected ? onDisconnect : onConnect}>
            {connecting ? <RefreshCw className="spin" size={14} /> : bleConnected ? <Unplug size={14}/> : usbConnected ? <Usb size={14}/> : null}{usbConnected ? "USB 已连接" : bleConnected ? "断开" : connecting ? "连接中" : "选择蓝牙"}
          </button>
        </div>
        <div className="relay-actions">
          <button className="primary" disabled={!transportConnected} onClick={onSendTest}><Radio size={15} />发送测试状态</button>
          <p>关闭主窗口后应用会留在系统托盘，继续转发事件。</p>
        </div>
      </div>
    </div>

    <div className="activity-card">
      <div className="activity-head"><div><span>ACTIVITY</span><h2>最近事件</h2></div><div className="activity-badge"><Clock3 size={13} />最近 {activity.length} 条</div></div>
      <div className="activity-list">
        {activity.length === 0 && <div className="activity-empty"><Code2 /><p>启动一次 Claude Code 会话后，事件会显示在这里。</p></div>}
        {activity.map((item, index) => <div className="activity-item" key={`${item.updatedAt}-${index}`}>
          <i className={`activity-dot state-${item.state}`} />
          <time>{formatTime(item.updatedAt)}</time>
          <b>{item.event}</b>
          <span>{item.tool || item.text}</span>
          <small>{item.state}</small>
        </div>)}
      </div>
    </div>

    {showHooksConfirmation && <div className="device-picker-backdrop" onMouseDown={() => setShowHooksConfirmation(false)}>
      <section className="hooks-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="hooks-confirm-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="hooks-confirm-icon"><AlertTriangle /></div>
        <div className="hooks-confirm-copy">
          <span>CLAUDE CODE CONFIGURATION</span>
          <h2 id="hooks-confirm-title">将修改 Claude Code 配置文件</h2>
          <p>安装或升级 Vico Hooks 会写入以下文件：</p>
          <code>%USERPROFILE%\.claude\settings.json</code>
          <ul>
            <li>VicoDeck 会合并所需 Hooks，不会清空现有配置。</li>
            <li>环境变量、权限设置以及其他第三方 Hooks 将被保留。</li>
            <li>如果你曾手动维护该文件，建议先自行备份。</li>
          </ul>
        </div>
        <div className="hooks-confirm-actions">
          <button type="button" className="secondary" onClick={() => setShowHooksConfirmation(false)}>取消</button>
          <button type="button" className="primary" onClick={() => {
            setShowHooksConfirmation(false);
            onInstallHooks();
          }}>{hooksState?.needsUpgrade ? "确认升级" : "确认安装"}</button>
        </div>
      </section>
    </div>}
  </section>;
}
