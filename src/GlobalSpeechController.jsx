import { useEffect, useRef } from "react";
import { useRecorder } from "./useRecorder";

const defaultOptions = {
  enableDdc:true,
  enablePunc:true,
  enableItn:true,
  enableSpeakerInfo:false,
  enableChannelSplit:false
};

function readOptions() {
  try {
    return { ...defaultOptions, ...JSON.parse(localStorage.getItem("vico-speech-options") || "{}") };
  } catch {
    return defaultOptions;
  }
}

function microphoneError(reason) {
  const messages = {
    NotAllowedError:"没有电脑麦克风权限，请在 Windows 隐私设置中允许访问",
    NotFoundError:"没有找到可用的电脑麦克风",
    OverconstrainedError:"所选麦克风已不可用，请在软件测试页重新选择",
    NotReadableError:"麦克风正被其他程序独占，或设备暂时不可用"
  };
  return messages[reason?.name] || reason?.message || "电脑麦克风录音失败";
}

/**
 * 常驻后台的按住说话控制器。
 * 它不渲染页面，因此切换侧边栏或把主窗口隐藏到托盘都不会中断快捷键录音。
 */
export default function GlobalSpeechController() {
  const recorder = useRecorder();
  const recorderRef = useRef(recorder);
  const startingRef = useRef(false);
  const stopRequestedRef = useRef(false);
  recorderRef.current = recorder;

  useEffect(() => {
    const reportError = (reason) => {
      window.vico?.speech?.updateShortcutState?.({
        state:"error",
        message:microphoneError(reason)
      });
    };

    const removeListener = window.vico?.speech?.onShortcut?.(async (event) => {
      if (event?.action === "stop") {
        if (startingRef.current) stopRequestedRef.current = true;
        else recorderRef.current.stop();
        return;
      }
      if (event?.action !== "start" || recorderRef.current.recording) return;

      try {
        startingRef.current = true;
        stopRequestedRef.current = false;
        const cloud = await window.vico.speech.check();
        if (!cloud?.ok) throw new Error(cloud?.error || "无法检查语音识别服务");
        if (!cloud.data?.configured) throw new Error("请先在 Vico Keyboard 的语音识别页面保存豆包 API Key");

        const microphoneId = localStorage.getItem("vico-speech-microphone") || "";
        await recorderRef.current.start(microphoneId, async (wavBytes) => {
          try {
            await window.vico.speech.updateShortcutState({ state:"processing" });
            const response = await window.vico.speech.transcribeRecording(wavBytes, readOptions());
            if (!response?.ok) throw new Error(response?.error || "语音识别失败");
            const text = String(response.data?.text || "").trim();
            if (!text) throw new Error("没有识别到有效语音");
            const pasted = await window.vico.speech.completeShortcut(text);
            if (!pasted?.ok) throw new Error(pasted?.error || "无法输入识别结果");
          } catch (reason) {
            reportError(reason);
          }
        }, reportError);
        startingRef.current = false;
        if (stopRequestedRef.current) recorderRef.current.stop();
        else await window.vico.speech.updateShortcutState({ state:"recording" });
      } catch (reason) {
        startingRef.current = false;
        reportError(reason);
      }
    });

    return () => removeListener?.();
  }, []);

  return null;
}
