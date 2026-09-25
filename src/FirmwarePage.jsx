import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, Check, CheckCircle2, ChevronDown, CircuitBoard, CloudDownload, Download,
  FolderOpen, HardDriveDownload, RefreshCw, ShieldCheck, Usb, XCircle, Zap
} from "lucide-react";
import SparkMD5 from "spark-md5";
import { ESPLoader, Transport } from "esptool-js";

const ESPRESSIF_USB_VENDOR_ID = 0x303a;
const VICO_USB_VENDOR_ID = 0x3343;

// 发布包中的镜像已经完成参数写入与 SHA-256 校验。这里必须保持镜像原样，
// 避免 esptool-js 再次改写 bootloader 头部后未同步更新镜像内部摘要。
const PRESERVE_IMAGE_FLASH_OPTIONS = Object.freeze({
  flashMode:"keep",
  flashFreq:"keep",
  flashSize:"keep"
});

const EXPECTED_RESET_DISCONNECT = /device has been lost|device was disconnected|disconnected|networkerror|port.*closed/i;

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function restartFlashedDevice(transport, pushLog) {
  try {
    // DTR=false 保证 GPIO0 不处于下载模式；RTS 脉冲对应 ESP32-S3 的 EN 复位。
    // 该时序与 PlatformIO/esptool 的硬复位行为一致。
    await transport.setDTR(false);
    await transport.setRTS(true);
    await wait(200);
    await transport.setRTS(false);
    await wait(500);
    pushLog("ESP32-S3 已复位，正在启动新固件");
  } catch (error) {
    const message = String(error?.message || error || "自动复位失败");
    if (EXPECTED_RESET_DISCONNECT.test(message)) {
      // 原生 USB 控制器会在 EN 复位后立即离线，端口消失说明复位已经触发。
      pushLog("ESP32-S3 已复位，USB 端口正在重新枚举");
      return;
    }
    throw new Error(`固件已写入，但自动重启失败：${message}。请短按一次 RST。`);
  }
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function md5(bytes) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return SparkMD5.ArrayBuffer.hash(buffer);
}

function friendlyFlashError(error) {
  const message = String(error?.message || error || "固件升级失败");
  if (/Failed to execute 'open'|NetworkError|port is already open/i.test(message)) {
    return "串口被占用。请关闭 PlatformIO 串口监视器或其他烧录工具，然后重试。";
  }
  if (/Failed to connect|sync|bootloader|timed? ?out|timeout/i.test(message)) {
    return "无法进入下载模式。请先将模式拨片切到蓝牙侧；仍无法连接时，再按住 BOOT、短按 RST 后重试。";
  }
  if (/not ESP32-S3|不是 ESP32-S3/i.test(message)) {
    return "检测到的芯片不是 ESP32-S3，已阻止写入。请确认选择的是 Vico Keyboard。";
  }
  if (/device has been lost|disconnected|device was disconnected/i.test(message)) {
    return "烧录期间 USB 连接中断。请重新插拔数据线并再次升级。";
  }
  return message;
}

const PHASE_COPY = {
  idle:["准备就绪", "请先将模式拨片切到蓝牙侧，避免 USB 模式占用端口"],
  preparing:["正在准备固件", "读取并校验每个固件镜像"],
  connecting:["正在识别芯片", "正在验证所选设备是否为 ESP32-S3"],
  flashing:["正在写入并校验", "请勿拔出 USB 数据线或关闭软件"],
  success:["升级完成", "键盘已重启，可重新连接 USB 配置通道"],
  error:["升级未完成", "设备没有被继续写入，请按提示重试"]
};

export default function FirmwarePage({ onPrepareFlash }) {
  const [sourceMode, setSourceMode] = useState("server");
  const [writeMode, setWriteMode] = useState("quick");
  const [catalog, setCatalog] = useState(null);
  const [catalogError, setCatalogError] = useState("");
  const [selectedReleaseId, setSelectedReleaseId] = useState("");
  const [localBundle, setLocalBundle] = useState(null);
  const [localError, setLocalError] = useState("");
  const [localSelecting, setLocalSelecting] = useState(false);
  const [phase, setPhase] = useState("idle");
  const [progress, setProgress] = useState(0);
  const [chipName, setChipName] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [logs, setLogs] = useState([]);
  const logTail = useRef("");

  const loadCatalog = async (refresh = false) => {
    setCatalogError("");
    try {
      const next = await window.vico.firmware.getCatalog(refresh);
      setCatalog(next);
      setSelectedReleaseId((current) => current && next.releases.some((item) => item.id === current)
        ? current
        : next.releases[0]?.id || "");
    } catch (error) {
      setCatalogError(error.message || "无法读取固件目录");
    }
  };

  useEffect(() => { loadCatalog(); }, []);

  const selectedRelease = useMemo(
    () => catalog?.releases?.find((item) => item.id === selectedReleaseId) || null,
    [catalog, selectedReleaseId]
  );
  const activeFirmware = sourceMode === "server"
    ? selectedRelease
    : localBundle?.writeMode === writeMode ? localBundle : null;
  const activeImages = sourceMode === "server" && selectedRelease
    ? selectedRelease.images
    : activeFirmware?.images || [];
  const totalSize = activeFirmware?.totalSize && sourceMode === "local"
    ? activeFirmware.totalSize
    : activeImages.reduce((total, image) => total + image.size, 0);
  const busy = ["preparing", "connecting", "flashing"].includes(phase);
  const [phaseTitle, phaseDetail] = PHASE_COPY[phase] || PHASE_COPY.idle;

  const resetFlashState = () => {
    setPhase("idle");
    setProgress(0);
    setChipName("");
    setErrorMessage("");
    setLogs([]);
    logTail.current = "";
  };

  const chooseSourceMode = (mode) => {
    if (busy || mode === sourceMode) return;
    setSourceMode(mode);
    resetFlashState();
  };

  const chooseWriteMode = (mode) => {
    if (busy || mode === writeMode) return;
    setWriteMode(mode);
    // 本地来源的文件类型取决于烧录方式，切换后要求用户重新确认。
    if (sourceMode === "local") {
      setLocalBundle(null);
      setLocalError("");
    }
    resetFlashState();
  };

  const selectLocalSource = async () => {
    if (busy || localSelecting) return;
    setLocalSelecting(true);
    setLocalError("");
    try {
      const bundle = await window.vico.firmware.selectLocal(writeMode);
      if (!bundle) return;
      setLocalBundle(bundle);
      resetFlashState();
    } catch (error) {
      setLocalBundle(null);
      setLocalError(error.message || "无法读取本地 BIN 文件");
    } finally {
      setLocalSelecting(false);
    }
  };

  const pushLog = (value, newline = true) => {
    const text = String(value || "").replace(/\r/g, "");
    if (!text) return;
    if (!newline) {
      logTail.current += text;
      return;
    }
    const lines = `${logTail.current}${text}`.split("\n").filter(Boolean);
    logTail.current = "";
    setLogs((current) => [...current, ...lines].slice(-80));
  };

  const startFlash = async () => {
    if (!activeFirmware || busy) return;
    if (!navigator.serial?.requestPort) {
      setPhase("error");
      setErrorMessage("当前运行环境不支持 USB 串口烧录，请安装最新版 VicoDeck。");
      return;
    }

    let transport = null;
    setPhase("preparing");
    setProgress(1);
    setChipName("");
    setErrorMessage("");
    setLogs([]);
    logTail.current = "";

    try {
      await onPrepareFlash?.();
      pushLog(sourceMode === "server"
        ? `正在准备 Vico Keyboard ${selectedRelease.version}…`
        : `正在准备本地固件 ${localBundle.title}…`);
      const bundle = sourceMode === "server"
        ? await window.vico.firmware.getBundle(selectedRelease.id)
        : localBundle;
      pushLog(`SHA-256 校验完成，共 ${formatBytes(bundle.totalSize)}`);
      setProgress(4);

      setPhase("connecting");
      const port = await navigator.serial.requestPort({
        filters:[
          { usbVendorId:ESPRESSIF_USB_VENDOR_ID },
          { usbVendorId:VICO_USB_VENDOR_ID }
        ]
      });
      transport = new Transport(port, false);
      const terminal = {
        clean() {},
        writeLine(value) { pushLog(value, true); },
        write(value) { pushLog(value, false); }
      };
      const loader = new ESPLoader({
        transport,
        baudrate:460800,
        romBaudrate:115200,
        terminal,
        debugLogging:false,
        enableTracing:false
      });
      const detectedChip = await loader.main();
      setChipName(detectedChip);
      if (!/ESP32-S3/i.test(detectedChip || "")) {
        throw new Error(`检测到 ${detectedChip || "未知芯片"}，不是 ESP32-S3`);
      }
      pushLog(`芯片验证通过：${detectedChip}`);

      const fileArray = bundle.images.map((image) => ({
        data:decodeBase64(image.data),
        address:image.address
      }));
      const sourceSizes = bundle.images.map((image) => image.size);
      const sourceTotal = sourceSizes.reduce((total, size) => total + size, 0);

      setPhase("flashing");
      await loader.writeFlash({
        fileArray,
        ...PRESERVE_IMAGE_FLASH_OPTIONS,
        eraseAll:false,
        compress:true,
        calculateMD5Hash:md5,
        reportProgress(fileIndex, written, total) {
          const completed = sourceSizes.slice(0, fileIndex).reduce((sum, size) => sum + size, 0);
          const ratio = total > 0 ? Math.min(1, written / total) : 0;
          const weighted = completed + ratio * sourceSizes[fileIndex];
          setProgress(5 + Math.round((weighted / sourceTotal) * 94));
        }
      });
      setProgress(100);
      pushLog("所有镜像均已写入并通过设备端 MD5 校验");
      await restartFlashedDevice(transport, pushLog);
      setPhase("success");
    } catch (error) {
      if (error?.name === "NotFoundError") {
        setPhase("idle");
        setProgress(0);
        pushLog("已取消选择设备");
      } else {
        const friendly = friendlyFlashError(error);
        setErrorMessage(friendly);
        pushLog(`错误：${friendly}`);
        setPhase("error");
      }
    } finally {
      if (transport) {
        try { await transport.disconnect(); } catch { /* 复位后端口消失属于正常情况。 */ }
      }
    }
  };

  return <section className="page-pad firmware-page">
    <div className="page-heading firmware-heading">
      <div className="icon-box"><HardDriveDownload/></div>
      <div><span>FIRMWARE CENTER</span><h1>固件升级</h1><p>通过 USB 安装云端固件或本地 BIN 文件。</p></div>
      {sourceMode === "server" && <button className="secondary firmware-refresh" disabled={busy} onClick={() => loadCatalog(true)}><RefreshCw size={14}/>刷新云端</button>}
    </div>

    <div className="firmware-grid">
      <div className="firmware-main-column">
        <section className="firmware-card release-card">
          <div className="firmware-source-tabs">
            <button className={sourceMode === "server" ? "active" : ""} disabled={busy} onClick={() => chooseSourceMode("server")}><CloudDownload/>云端固件</button>
            <button className={sourceMode === "local" ? "active" : ""} disabled={busy} onClick={() => chooseSourceMode("local")}><FolderOpen/>本地 BIN 文件</button>
          </div>

          {sourceMode === "local" && <div className="firmware-write-mode">
            <div><span>烧录范围</span><small>日常更新推荐快速升级</small></div>
            <div>
              <button className={writeMode === "quick" ? "active" : ""} disabled={busy} onClick={() => chooseWriteMode("quick")}><b>快速升级</b><small>仅 firmware.bin</small></button>
              <button className={writeMode === "full" ? "active" : ""} disabled={busy} onClick={() => chooseWriteMode("full")}><b>完整烧录</b><small>四个 BIN 文件</small></button>
            </div>
          </div>}

          {sourceMode === "server" ? <>
            <div className="firmware-card-head firmware-source-head"><div><span>CLOUD FIRMWARE</span><h2>选择云端固件</h2></div>{catalog && <em>{catalog.source === "server" ? "云端在线" : "离线版本"}</em>}</div>
            {catalogError && <div className="firmware-inline-error"><XCircle size={16}/>{catalogError}</div>}
            {!catalog && !catalogError && <div className="firmware-loading"><RefreshCw className="spin"/>正在读取云端固件…</div>}
            {catalog && <>
              <label className="firmware-version-select">
                <select value={selectedReleaseId} disabled={busy} onChange={(event) => { setSelectedReleaseId(event.target.value); resetFlashState(); }}>
                  {catalog.releases.map((release) => <option key={release.id} value={release.id}>{release.title} · v{release.version}</option>)}
                </select>
                <ChevronDown size={15}/>
              </label>
              {selectedRelease && <div className="release-detail">
                <div className="release-title"><div className="release-chip"><CircuitBoard/></div><div><b>{selectedRelease.title}</b><span>{catalog.board} · {formatBytes(totalSize)}</span></div><small>v{selectedRelease.version}</small></div>
                <p>{selectedRelease.description}</p>
                <ul>{selectedRelease.notes.map((note) => <li key={note}><Check size={13}/>{note}</li>)}</ul>
                <div className="release-integrity"><ShieldCheck size={15}/><span>云端版本已定义 {selectedRelease.images.length} 个烧录镜像；写入后执行设备端 MD5 校验。</span></div>
              </div>}
            </>}
          </> : <>
            <div className="firmware-card-head firmware-source-head"><div><span>LOCAL FIRMWARE</span><h2>{writeMode === "quick" ? "选择本地 BIN 文件" : "选择完整固件文件夹"}</h2></div>{activeFirmware && <em>已验证</em>}</div>
            <button className="secondary local-folder-button" disabled={busy || localSelecting} onClick={selectLocalSource}>
              {localSelecting ? <RefreshCw className="spin"/> : <FolderOpen/>}{activeFirmware ? "重新选择" : writeMode === "quick" ? "选择 BIN 文件" : "选择固件文件夹"}
            </button>
            <p className="local-folder-help">{writeMode === "quick"
              ? "选择一个应用固件 BIN 文件，软件会将其写入 0x10000。"
              : "完整烧录要求文件夹包含 bootloader.bin、partitions.bin、boot_app0.bin 和 firmware.bin。"}</p>
            {localError && <div className="firmware-inline-error"><XCircle size={16}/>{localError}</div>}
            {activeFirmware && <div className="release-detail local-release-detail">
              <div className="release-title"><div className="release-chip"><FolderOpen/></div><div><b>{activeFirmware.title}</b><span title={activeFirmware.sourcePath}>{activeFirmware.sourcePath} · {formatBytes(totalSize)}</span></div><small>LOCAL</small></div>
              <p>{activeFirmware.description}</p>
              <ul>{activeFirmware.notes.map((note) => <li key={note}><Check size={13}/>{note}</li>)}</ul>
              <div className="release-integrity"><ShieldCheck size={15}/><span>{writeMode === "quick" ? "已验证应用镜像内部 SHA-256；写入后还会执行设备端 MD5 校验。" : "已验证 bootloader 与应用镜像内部 SHA-256；写入后还会执行设备端 MD5 校验。"}</span></div>
            </div>}
          </>}
        </section>

        <section className={`firmware-card flash-card phase-${phase}`}>
          <div className="flash-status-head">
            <div className="flash-status-icon">{phase === "success" ? <CheckCircle2/> : phase === "error" ? <XCircle/> : busy ? <RefreshCw className="spin"/> : <Zap/>}</div>
            <div><span>{phaseTitle}</span><small>{phase === "error" ? errorMessage : phaseDetail}</small>{chipName && <em>{chipName}</em>}</div>
            <b>{progress}%</b>
          </div>
          <div className="firmware-progress"><i style={{ width:`${progress}%` }}/></div>
          <button className="firmware-flash-button" disabled={!activeFirmware || busy} onClick={startFlash}>
            {busy ? <><RefreshCw className="spin"/>正在升级</> : phase === "success" ? <><RefreshCw/>再次烧录</> : <><Download/>{sourceMode === "server" ? "开始云端烧录" : writeMode === "quick" ? "开始快速升级" : "开始完整烧录"}</>}
          </button>
          <p className="flash-button-help">切换到蓝牙模式后点击，软件会自动让 ESP32-S3 进入下载模式。</p>
          {logs.length > 0 && <details className="firmware-log" open={phase === "error"}>
            <summary>查看烧录日志</summary>
            <pre>{logs.join("\n")}</pre>
          </details>}
        </section>
      </div>

      <aside className="firmware-side-column">
        <section className="firmware-card boot-guide">
          <div className="firmware-card-head"><div><span>BEFORE FLASHING</span><h2>升级前准备</h2></div><Usb/></div>
          <ol>
            <li><i>1</i><div><b>切换到蓝牙模式</b><span>将模式拨片拨到蓝牙侧，避免 USB HID 占用升级端口。</span></div></li>
            <li><i>2</i><div><b>连接 USB 数据线</b><span>请使用支持数据传输的 Type-C 线为设备供电和烧录。</span></div></li>
            <li><i>3</i><div><b>开始 USB 升级</b><span>点击升级按钮，在弹窗中选择 ESP32-S3 端口。</span></div></li>
            <li><i>4</i><div><b>仅在无法连接时</b><span>按住 BOOT，短按 RST，松开 BOOT 后重新尝试。</span></div></li>
          </ol>
        </section>
        <div className="firmware-warning"><AlertTriangle/><div><b>烧录期间不要断电</b><span>{sourceMode === "server" ? "云端版本会自动决定需要写入的镜像，并保留 NVS 中的用户设置。" : writeMode === "quick" ? "快速升级要求设备已有兼容的 bootloader 和分区表，并且只更新主程序。" : "完整烧录覆盖启动与程序相关区域，但仍会保留 NVS 中的按键、OLED 与 RGB 设置。"}</span></div></div>
        <div className="firmware-target"><span>安全限制</span><b>仅 ESP32-S3</b><small>连接后读取芯片型号，其他芯片不会被写入。</small></div>
      </aside>
    </div>
  </section>;
}
