import {
  Activity,
  Bluetooth,
  CheckCircle2,
  Clock3,
  Code2,
  Radio,
  RefreshCw,
  TerminalSquare,
  Unplug
} from "lucide-react";

const STATE_LABELS = {
  offline: "等待 Claude Code",
  ready: "会话已就绪",
  working: "正在思考",
  tool: "正在使用工具",
  waiting: "等待处理",
  done: "任务已完成",
  error: "执行遇到错误"
};

function formatTime(value) {
  if (!value) return "--:--:--";
  return new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
}

export default function ClaudePage({
  claudeStatus,
  bleStatus,
  hooksState,
  activity,
  connecting,
  installing,
  onConnect,
  onInstallHooks,
  onSendTest
}) {
  const bleConnected = bleStatus.state === "connected";
  const hooksInstalled = hooksState?.installed;

  return <section className="page-pad claude-page">
    <div className="page-heading">
      <div className="icon-box"><Activity /></div>
      <div>
        <span>CLAUDE CODE RELAY</span>
        <h1>Claude Code 状态转发</h1>
        <p>后台捕获 Claude Code 生命周期事件，并通过 BLE GATT 转发到键盘 OLED。</p>
      </div>
      <div className={`relay-health ${hooksInstalled && bleConnected ? "online" : ""}`}>
        <i />{hooksInstalled && bleConnected ? "转发服务运行中" : "等待完成设置"}
      </div>
    </div>

    <div className="relay-flow">
      <div className={`relay-node ${hooksInstalled ? "ready" : ""}`}>
        <div className="relay-node-icon"><TerminalSquare /></div>
        <div><span>01 · SOURCE</span><b>Claude Code Hooks</b><small>{hooksInstalled ? "事件监听已安装" : "尚未安装 hooks"}</small></div>
        {hooksInstalled ? <CheckCircle2 className="node-check" /> : <i className="node-empty" />}
      </div>
      <div className="relay-link"><i /><i /><i /></div>
      <div className={`relay-node ${claudeStatus.updatedAt ? "ready" : ""}`}>
        <div className="relay-node-icon"><Radio /></div>
        <div><span>02 · RELAY</span><b>Vico 后台服务</b><small>localhost:38471</small></div>
        <span className="node-live">LIVE</span>
      </div>
      <div className="relay-link"><i /><i /><i /></div>
      <div className={`relay-node ${bleConnected ? "ready" : ""}`}>
        <div className="relay-node-icon"><Bluetooth /></div>
        <div><span>03 · DISPLAY</span><b>Vico Keyboard</b><small>{bleConnected ? bleStatus.name : "BLE GATT 未连接"}</small></div>
        {bleConnected ? <CheckCircle2 className="node-check" /> : <i className="node-empty" />}
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
          <section><b>安装 Claude Code hooks</b><p>合并到现有 settings.json，不会覆盖环境变量或权限配置。</p></section>
          <button className="secondary" disabled={installing || hooksInstalled} onClick={onInstallHooks}>
            {installing && <RefreshCw className="spin" size={14} />}{hooksInstalled ? "已安装" : installing ? "安装中" : "安装"}
          </button>
        </div>
        <div className="relay-step">
          <div className={bleConnected ? "done" : ""}>{bleConnected ? <CheckCircle2 /> : "2"}</div>
          <section><b>连接 Vico 蓝牙键盘</b><p>查找 Vico Keyboard ESP32-S3 的自定义 GATT 服务。</p></section>
          <button className="secondary" disabled={connecting || bleConnected} onClick={onConnect}>
            {connecting && <RefreshCw className="spin" size={14} />}{bleConnected ? "已连接" : connecting ? "连接中" : "连接"}
          </button>
        </div>
        <div className="relay-actions">
          <button className="primary" disabled={!bleConnected} onClick={onSendTest}><Radio size={15} />发送测试状态</button>
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
  </section>;
}
