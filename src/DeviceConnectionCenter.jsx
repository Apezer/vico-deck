import { useEffect, useRef } from "react";
import {
  BatteryMedium,
  Bluetooth,
  CheckCircle2,
  RefreshCw,
  Unplug,
  Usb,
  X
} from "lucide-react";

function batteryText(status) {
  return Number.isFinite(status?.batteryPercent) ? `${status.batteryPercent}%` : null;
}

/**
 * 全局设备连接中心。
 * USB WebHID 与蓝牙 GATT 都属于 VicoDeck 的设备通信通道，统一放在这里管理，
 * 避免用户为了连接蓝牙而在 OLED、RGB 或 Claude Code 页面之间寻找入口。
 */
export default function DeviceConnectionCenter({
  open,
  onClose,
  usbStatus,
  bleStatus,
  bleConnecting,
  onConnectUsb,
  onDisconnectUsb,
  onConnectBle,
  onDisconnectBle
}) {
  const closeButtonRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    const previouslyFocused = document.activeElement;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };

    window.addEventListener("keydown", handleKeyDown);
    closeButtonRef.current?.focus();

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  const usbConnected = usbStatus?.state === "connected";
  const usbConnecting = usbStatus?.state === "connecting";
  const bleConnected = bleStatus?.state === "connected";
  const busy = usbConnecting || bleConnecting;
  const activeMode = usbConnected ? "USB" : bleConnected ? "蓝牙" : null;
  const activeStatus = usbConnected ? usbStatus : bleStatus;
  const activeBattery = batteryText(activeStatus);

  const connectAndClose = async (connect) => {
    const connected = await connect();
    if (connected) onClose();
  };

  return <div className="connection-center-backdrop" onMouseDown={onClose}>
    <aside
      className="connection-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="connection-center-title"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="connection-center-head">
        <div>
          <span>DEVICE CONNECTION</span>
          <h2 id="connection-center-title">连接 Vico Keyboard</h2>
          <p>根据小键盘拨片当前所在的模式选择通信方式。</p>
        </div>
        <button ref={closeButtonRef} className="ghost square" onClick={onClose} aria-label="关闭设备连接中心"><X size={20}/></button>
      </div>

      <div className={`connection-overview ${activeMode ? "online" : ""}`}>
        <div className="connection-overview-icon">{activeMode === "蓝牙" ? <Bluetooth/> : <Usb/>}</div>
        <div>
          <span>{activeMode ? "当前通信通道" : "当前状态"}</span>
          <b>{activeMode ? `Vico Keyboard · ${activeMode}` : "尚未连接设备"}</b>
          <small>{activeMode
            ? `${activeStatus?.name || "Vico Keyboard"}${activeBattery ? ` · 电量 ${activeBattery}` : ""}`
            : "连接后，OLED、RGB 和状态信息会自动同步。"}</small>
        </div>
        {activeMode && <CheckCircle2/>}
      </div>

      <div className="connection-methods">
        <article className={`connection-method ${usbConnected ? "active" : ""}`}>
          <div className="connection-method-icon usb"><Usb/></div>
          <div className="connection-method-copy">
            <div><span>USB</span>{usbConnected && <em>当前使用</em>}</div>
            <h3>USB 配置连接</h3>
            <p>速度更快，适合预设同步、GIF 上传和键盘麦克风录音。</p>
            <small>请将模式拨片切到 USB，并使用支持数据传输的线缆。</small>
          </div>
          {usbConnected
            ? <button className="secondary danger-subtle" disabled={busy} onClick={onDisconnectUsb}><Unplug size={15}/>断开 USB</button>
            : <button className="secondary" disabled={busy} onClick={() => connectAndClose(onConnectUsb)}>
                {usbConnecting ? <RefreshCw className="spin" size={15}/> : <Usb size={15}/>}
                {usbConnecting ? "正在连接…" : bleConnected ? "切换到 USB" : "连接 USB"}
              </button>}
        </article>

        <article className={`connection-method ${bleConnected ? "active" : ""}`}>
          <div className="connection-method-icon bluetooth"><Bluetooth/></div>
          <div className="connection-method-copy">
            <div><span>BLUETOOTH</span>{bleConnected && <em>当前使用</em>}</div>
            <h3>蓝牙连接</h3>
            <p>适合无线同步 OLED、RGB、Claude Code 状态和语音数据。</p>
            <small>首次连接会打开设备选择窗口；Windows 配对不等于 VicoDeck 已连接。</small>
          </div>
          {bleConnected
            ? <button className="secondary danger-subtle" disabled={busy} onClick={onDisconnectBle}><Unplug size={15}/>断开蓝牙</button>
            : <button className="secondary" disabled={busy} onClick={() => connectAndClose(onConnectBle)}>
                {bleConnecting ? <RefreshCw className="spin" size={15}/> : <Bluetooth size={15}/>}
                {bleConnecting ? "正在连接…" : usbConnected ? "切换到蓝牙" : "选择蓝牙键盘"}
              </button>}
        </article>
      </div>

      <div className="connection-center-note">
        <RefreshCw size={15}/>
        <div><b>自动恢复连接</b><span>软件启动或键盘唤醒后，会尝试恢复上次已经授权的设备。用户主动断开后，可从这里重新连接。</span></div>
      </div>
    </aside>
  </div>;
}

/** 页面级提示只负责说明当前功能尚未同步，连接操作统一进入全局连接中心。 */
export function ConnectionNotice({ icon:Icon, title, description, onOpenConnection }) {
  return <div className="device-connection-notice" role="status">
    <Icon size={17}/>
    <div><b>{title}</b><span>{description}</span></div>
    <button className="secondary" onClick={onOpenConnection}>连接设备</button>
  </div>;
}
