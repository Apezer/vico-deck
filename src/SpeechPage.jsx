import { Fragment, useEffect, useRef, useState } from "react";
import {
  AudioLines, Bluetooth, Check, Cloud, Copy, Download, KeyRound,
  LoaderCircle, Mic, Radio, Square, Trash2, Upload, X
} from "lucide-react";
import { useRecorder } from "./useRecorder";

const defaultOptions = {
  enableDdc:true,
  enablePunc:true,
  enableItn:true,
  enableSpeakerInfo:false,
  enableChannelSplit:false,
  enableVad:true
};

const optionDefinitions = {
  enableDdc:["语义顺滑", "减少口语重复与停顿"],
  enablePunc:["自动标点", "补充逗号、句号和问号"],
  enableItn:["数字规整", "将口语数字转换为阿拉伯数字"],
  enableVad:["语音端点检测", "自动忽略录音前后的静音部分"]
};

function readOptions() {
  try {
    return { ...defaultOptions, ...JSON.parse(localStorage.getItem("vico-speech-options") || "{}") };
  } catch {
    return defaultOptions;
  }
}

async function unwrap(operation) {
  const response = await operation;
  if (!response?.ok) throw new Error(response?.error || "请通过 Electron 桌面应用运行");
  return response.data;
}

function seconds(value) {
  return `${Number(value || 0).toFixed(1)} 秒`;
}

function shortcutLabel(value) {
  return String(value || "CommandOrControl+Alt+I")
    .replace("CommandOrControl", "Ctrl")
    .replaceAll("+", " + ");
}

export default function SpeechPage({ deviceEvent, usbStatus, bleStatus, onConnectBle, connecting }) {
  const [cloud, setCloud] = useState(null);
  const [apiKey, setApiKey] = useState("");
  const [providerConfig, setProviderConfig] = useState({});
  const [options, setOptions] = useState(readOptions);
  const [status, setStatus] = useState("正在检查识别服务…");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [pending, setPending] = useState(null);
  const [result, setResult] = useState(null);
  const [text, setText] = useState("");
  const [notice, setNotice] = useState("");
  const [microphones, setMicrophones] = useState([]);
  const [microphoneId, setMicrophoneId] = useState(() => localStorage.getItem("vico-speech-microphone") || "");
  const [startingRecorder, setStartingRecorder] = useState(false);
  const handledSession = useRef(0);
  const recorder = useRecorder();
  const connected = usbStatus.state === "connected" || bleStatus.state === "connected";
  const activeProvider = cloud?.providers?.find((provider) => provider.id === cloud.provider);

  const refreshMicrophones = async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    setMicrophones(devices.filter((device) => device.kind === "audioinput"));
  };

  useEffect(() => {
    localStorage.setItem("vico-speech-options", JSON.stringify(options));
  }, [options]);

  useEffect(() => {
    localStorage.setItem("vico-speech-microphone", microphoneId);
  }, [microphoneId]);

  useEffect(() => {
    let active = true;
    unwrap(window.vico?.speech?.check?.()).then((value) => {
      if (!active) return;
      setCloud(value);
      setProviderConfig(value.config || {});
      setStatus(value.configured
        ? `按住 ${shortcutLabel(value.shortcut)} 开始语音输入`
        : `请先配置${value.providerName || "语音服务商"}，或先录音稍后识别`);
    }).catch((reason) => {
      if (active) setError(reason.message);
    });
    const removeProgress = window.vico?.speech?.onProgress?.((value) => {
      if (value?.message) setStatus(value.message);
    });
    return () => {
      active = false;
      removeProgress?.();
    };
  }, []);

  useEffect(() => {
    refreshMicrophones().catch(() => {});
    const handleDeviceChange = () => refreshMicrophones().catch(() => {});
    navigator.mediaDevices?.addEventListener?.("devicechange", handleDeviceChange);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", handleDeviceChange);
  }, []);

  const transcribeBytes = async (capture) => {
    if (!capture?.wavBytes) return;
    const keyboardInput = capture.source === "keyboard";
    setBusy(true);
    setError("");
    setResult(null);
    setText("");
    setStatus("正在准备录音…");
    try {
      if (keyboardInput) {
        await window.vico.speech.updateShortcutState({ state:"processing", source:"keyboard" });
      }
      const value = await unwrap(window.vico.speech.transcribeRecording(capture.wavBytes, options));
      setResult(value);
      setText(value.text || "");
      setPending(null);
      setStatus(value.text ? "识别完成" : "没有识别到有效语音");
      if (keyboardInput) {
        if (value.text) await unwrap(window.vico.speech.completeShortcut(value.text));
        else await window.vico.speech.updateShortcutState({ state:"error", source:"keyboard", message:"没有识别到有效语音" });
      }
    } catch (reason) {
      setError(reason.message);
      setStatus("识别任务已停止");
      if (keyboardInput) {
        await window.vico.speech.updateShortcutState({ state:"error", source:"keyboard", message:reason.message });
      }
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!deviceEvent) return;
    if (deviceEvent.type === "recording") {
      setError("");
      setProgress(0);
      setStatus(`正在录音，松开旋钮后发送（最长 ${deviceEvent.maxSeconds} 秒）`);
      return;
    }
    if (deviceEvent.type === "transfer") {
      setProgress(deviceEvent.progress || 0);
      setStatus(deviceEvent.recording
        ? `正在录音并实时接收 · ${(deviceEvent.received / 1024).toFixed(1)} KB`
        : `正在接收剩余录音 ${Math.round((deviceEvent.progress || 0) * 100)}%`);
      return;
    }
    if (deviceEvent.type === "error") {
      setError(deviceEvent.message);
      setStatus("键盘录音失败");
      return;
    }
    if (deviceEvent.type === "complete" && handledSession.current !== deviceEvent.sessionId) {
      handledSession.current = deviceEvent.sessionId;
      setProgress(1);
      setPending(deviceEvent);
      if (cloud?.configured) transcribeBytes(deviceEvent);
      else {
        setStatus("录音已收到，请完成当前语音服务商配置后开始识别");
        window.vico.speech.updateShortcutState({ state:"error", source:"keyboard", message:"请先在软件中配置当前语音服务商" });
      }
    }
  }, [deviceEvent, cloud?.configured]);

  const handleRecorderError = (reason) => {
    const messages = {
      NotAllowedError:"无法访问电脑麦克风，请在 Windows 隐私设置中允许 VicoDeck 使用麦克风",
      NotFoundError:"没有找到可用的电脑麦克风",
      OverconstrainedError:"所选麦克风已不可用，请重新选择设备",
      NotReadableError:"麦克风正被其他程序独占，或设备暂时不可用"
    };
    setError(messages[reason?.name] || reason?.message || "电脑麦克风录音失败");
    setStatus("电脑录音失败");
  };

  const startComputerRecording = async () => {
    setStartingRecorder(true);
    setError("");
    setNotice("");
    try {
      await recorder.start(microphoneId, async (wavBytes, metadata) => {
        const capture = {
          wavBytes,
          duration:metadata.durationSeconds,
          source:"computer"
        };
        setPending(capture);
        setStatus("电脑录音已完成，正在准备识别…");
        if (cloud?.configured) await transcribeBytes(capture);
        else setStatus("电脑录音已保存，请先完成当前语音服务商配置后识别");
      }, handleRecorderError);
      setStatus("正在使用电脑麦克风录音，点击停止后自动识别");
      await refreshMicrophones();
    } catch (reason) {
      handleRecorderError(reason);
    } finally {
      setStartingRecorder(false);
    }
  };

  const saveProvider = async () => {
    setBusy(true);
    setError("");
    try {
      const value = await unwrap(window.vico.speech.saveProvider(cloud.provider, apiKey, providerConfig));
      setCloud(value);
      setProviderConfig(value.config || {});
      setApiKey("");
      setStatus(value.configured
        ? pending
          ? "服务商设置已保存，可以识别刚才的录音"
          : `按住 ${shortcutLabel(value.shortcut)} 开始语音输入`
        : `请补充${value.providerName}的必要配置`);
      setNotice(apiKey.trim()
        ? `${value.providerName}认证凭据已通过 Windows 安全存储加密保存`
        : `${value.providerName}设置已保存`);
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  };

  const clearCredential = async () => {
    setBusy(true);
    try {
      const value = await unwrap(window.vico.speech.clearCredential(cloud.provider));
      setCloud(value);
      setProviderConfig(value.config || {});
      setStatus(`请先保存${value.providerName}认证凭据`);
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  };

  const selectProvider = async (providerId) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const value = await unwrap(window.vico.speech.setProvider(providerId));
      setCloud(value);
      setProviderConfig(value.config || {});
      setApiKey("");
      setStatus(value.configured
        ? `已切换到${value.providerName}，按住 ${shortcutLabel(value.shortcut)} 开始语音输入`
        : `已切换到${value.providerName}，请先完成服务配置`);
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  };

  const importAudio = async () => {
    setBusy(true);
    setError("");
    try {
      const value = await unwrap(window.vico.speech.transcribeFile(options));
      if (value) {
        setResult(value);
        setText(value.text || "");
        setStatus("识别完成");
      }
    } catch (reason) {
      setError(reason.message);
      setStatus("识别任务已停止");
    } finally {
      setBusy(false);
    }
  };

  const output = async (save) => {
    try {
      await unwrap(save ? window.vico.speech.saveText(text) : window.vico.speech.copyText(text));
      setNotice(save ? "识别文本已保存" : "识别文本已复制");
    } catch (reason) {
      setError(reason.message);
    }
  };

  const setOption = (name, value) => setOptions((current) => ({ ...current, [name]:value }));

  return <section className="page-pad speech-page">
    <div className="page-heading">
      <div className="icon-box"><Mic/></div>
      <div><span>VOICE INPUT</span><h1>语音识别与 API 测试</h1><p>日常使用请按住 {shortcutLabel(cloud?.shortcut)}；本页面的录音按钮仅用于测试麦克风和云端 API。</p></div>
    </div>

    <div className="speech-grid">
      <div className="speech-main-card">
        <div className={`speech-orb ${deviceEvent?.type === "recording" || deviceEvent?.recording || recorder.recording ? "recording" : busy ? "busy" : ""}`}>
          {busy ? <LoaderCircle className="spin"/> : <AudioLines/>}
        </div>
        <h2>{status}</h2>
        <div className="speech-progress"><i style={{ width:`${Math.round((recorder.recording ? recorder.level : progress) * 100)}%` }}/></div>

        <div className={`speech-shortcut-guide ${cloud?.shortcutRegistered === false ? "unavailable" : ""}`}>
          <div>{shortcutLabel(cloud?.shortcut).split(" + ").map((part, index, parts) => <Fragment key={`${part}-${index}`}><kbd>{part}</kbd>{index < parts.length - 1 && <b>+</b>}</Fragment>)}</div>
          <span>{cloud?.shortcutRegistered === false ? "快捷键注册失败，可能已被其他软件占用" : "按住开始录音 · 松开结束识别 · 结果自动输入原聊天框"}</span>
        </div>

        <div className="speech-computer-card">
          <div className="speech-computer-head"><div><b>电脑麦克风 API 测试</b><span>确认所选麦克风、API Key 和云端模型可以正常工作</span></div><em>{recorder.recording ? `${recorder.seconds} 秒` : "TEST"}</em></div>
          <select value={microphoneId} onChange={(event) => setMicrophoneId(event.target.value)} disabled={recorder.recording || startingRecorder}>
            <option value="">系统默认麦克风</option>
            {microphones.map((device, index) => <option value={device.deviceId} key={device.deviceId || index}>{device.label || `麦克风 ${index + 1}`}</option>)}
          </select>
          <button
            className={recorder.recording ? "speech-stop-recording" : "primary speech-start-recording"}
            disabled={busy || startingRecorder}
            onClick={recorder.recording ? recorder.stop : startComputerRecording}
          >
            {recorder.recording ? <><Square size={15}/>停止测试并识别</> : <><Mic size={15}/>{startingRecorder ? "正在打开麦克风…" : "开始 API 录音测试"}</>}
          </button>
          {!cloud?.configured && <small>可以先录音；完成当前语音服务商配置后再识别刚才的内容。</small>}
        </div>

        <div className="speech-device-line">
          <Radio size={14}/>
          <span>{connected ? `${usbStatus.state === "connected" ? "USB" : "BLE"} 键盘语音通道已连接` : "键盘麦克风通道未连接（不影响电脑录音）"}</span>
          {!connected && <button onClick={onConnectBle} disabled={connecting}><Bluetooth size={14}/>{connecting ? "连接中…" : "连接蓝牙"}</button>}
        </div>
        <div className="speech-instruction">
          <KeyRound/><div><b>可选：键盘麦克风</b><span>固件支持时，按住旋钮录音，松开后也会自动识别</span></div>
        </div>
        {pending && !busy && <button className="primary speech-recognize" disabled={!cloud?.configured} onClick={() => transcribeBytes(pending)}><Cloud size={15}/>识别刚才的录音</button>}
        <button className="secondary speech-import" disabled={busy || recorder.recording || !cloud?.configured} onClick={importAudio}><Upload size={15}/>导入本地音频识别</button>
        {busy && <button className="danger-subtle speech-cancel" onClick={() => window.vico.speech.cancel()}><X size={15}/>取消识别</button>}
        {error && <div className="speech-error">{error}</div>}
        {notice && <div className="speech-notice"><Check size={14}/>{notice}</div>}
      </div>

      <div className="speech-side">
        <div className="settings-block speech-cloud-card">
          <div className="speech-card-title"><Cloud/><div><span>CLOUD MODEL</span><h2>语音服务商设置</h2></div></div>
          <label className="speech-provider-field"><span>语音服务商</span><select value={cloud?.provider || "doubao"} disabled={busy || recorder.recording} onChange={(event) => selectProvider(event.target.value)}>{(cloud?.providers || []).map((provider) => <option value={provider.id} key={provider.id}>{provider.name} · {provider.model}</option>)}</select></label>
          <p className="speech-provider-description">{activeProvider?.description || "选择电脑麦克风与键盘麦克风共用的识别服务。"}</p>
          {cloud?.provider === "dashscope" && <div className="speech-provider-region"><span>服务地域</span><b>华北 2（北京）</b><code>{cloud.regionId || "cn-beijing"}</code></div>}
          {cloud?.provider === "mimo" && <>
            <label className="speech-provider-field"><span>调用方式</span><select value={providerConfig.accessMode || "payg"} disabled={busy || recorder.recording} onChange={(event) => setProviderConfig((current) => ({ ...current, accessMode:event.target.value }))}><option value="payg">按量付费 API</option><option value="tokenPlanCn">Token Plan · 中国区</option></select></label>
            <label className="speech-provider-field"><span>识别语言</span><select value={providerConfig.language || "auto"} disabled={busy || recorder.recording} onChange={(event) => setProviderConfig((current) => ({ ...current, language:event.target.value }))}><option value="auto">自动检测</option><option value="zh">中文</option><option value="en">英文</option></select></label>
            <div className="speech-provider-region"><span>API Key 类型</span><b>{providerConfig.accessMode === "tokenPlanCn" ? "Token Plan" : "按量付费"}</b><code>{providerConfig.accessMode === "tokenPlanCn" ? "tp- / ttp-" : "sk-"}</code></div>
          </>}
          <p>认证凭据仅以 Windows DPAPI 加密文件保存在本机，不写入普通设置或日志。</p>
          <div className="speech-key-status">{cloud?.configured ? <><Check/>已配置 · {cloud.masked}</> : cloud?.credentialSaved ? <>凭据已保存 · 请补充必要配置</> : `尚未配置${activeProvider?.credentialLabel || "认证凭据"}`}</div>
          <div className="speech-key-row"><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={cloud?.provider === "mimo" ? `输入${providerConfig.accessMode === "tokenPlanCn" ? "Token Plan" : "按量付费"} API Key` : `输入${activeProvider?.credentialLabel || "认证凭据"}`}/><button disabled={!cloud || busy || (!apiKey.trim() && !cloud?.credentialSaved)} onClick={saveProvider}>保存设置</button></div>
          {cloud?.credentialSaved && <button className="speech-clear-key" disabled={busy} onClick={clearCredential}><Trash2 size={13}/>删除已保存密钥</button>}
        </div>
        {(cloud?.capabilities || []).length > 0 && <div className="settings-block speech-options-card">
          <h2>识别选项</h2>
          {(cloud?.capabilities || []).map((name) => {
            const [title, description] = optionDefinitions[name] || [name, "服务商专属识别选项"];
            return <label key={name}><div><b>{title}</b><span>{description}</span></div><input type="checkbox" checked={options[name] !== false} onChange={(event) => setOption(name, event.target.checked)}/></label>;
          })}
        </div>}
      </div>
    </div>

    <div className="speech-result-card">
      <div className="speech-result-head"><div><span>TEST TRANSCRIPT</span><h2>API 测试结果</h2></div>{result && <small>{result.model} · 音频 {seconds(result.duration)} · 耗时 {seconds(result.elapsed)}</small>}</div>
      <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="识别完成后，文字会显示在这里…"/>
      <div className="speech-result-actions"><button disabled={!text} onClick={() => output(false)}><Copy size={14}/>复制文字</button><button disabled={!text} onClick={() => output(true)}><Download size={14}/>导出 TXT</button></div>
    </div>
  </section>;
}
