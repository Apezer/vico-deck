import { useEffect, useRef, useState } from "react";

/**
 * 将浏览器采集到的单声道 PCM 数据封装为 16-bit WAV。
 * 云端识别服务可以直接读取该格式，不需要安装本地编码器。
 */
export function encodeWav(chunks, sampleRate, sampleCount) {
  const buffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(buffer);
  const writeAscii = (offset, value) => {
    [...value].forEach((character, index) => {
      view.setUint8(offset + index, character.charCodeAt(0));
    });
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, sampleCount * 2, true);

  let offset = 44;
  for (const chunk of chunks) {
    for (const sample of chunk) {
      view.setInt16(offset, sample, true);
      offset += 2;
    }
  }
  return new Uint8Array(buffer);
}

/**
 * 使用电脑麦克风录音，并在停止时返回 WAV 字节流。
 * 音频仅保存在内存中，完成或取消后会立即释放麦克风和 AudioContext。
 */
export function useRecorder() {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const active = useRef(null);

  function release() {
    const state = active.current;
    if (!state) return;
    clearInterval(state.timer);
    state.processor.disconnect();
    state.source.disconnect();
    state.mute.disconnect();
    state.stream.getTracks().forEach((track) => track.stop());
    state.context.close().catch(() => {});
    active.current = null;
    setRecording(false);
    setLevel(0);
  }

  useEffect(() => () => release(), []);

  async function start(deviceId, onComplete, onError) {
    if (active.current) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId:{ exact:deviceId } } : {}),
        echoCancellation:true,
        noiseSuppression:true
      },
      video:false
    });

    try {
      const context = new AudioContext();
      await context.resume();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const mute = context.createGain();
      mute.gain.value = 0;
      const chunks = [];
      let sampleCount = 0;
      let stopped = false;
      const startedAt = Date.now();
      const state = { stream, context, source, processor, mute, timer:null, finish:null };
      active.current = state;

      processor.onaudioprocess = (event) => {
        if (stopped) return;
        const input = event.inputBuffer.getChannelData(0);
        const pcm = new Int16Array(input.length);
        let peak = 0;
        for (let index = 0; index < input.length; index += 1) {
          const sample = Math.max(-1, Math.min(1, input[index]));
          pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
          peak = Math.max(peak, Math.abs(sample));
        }
        chunks.push(pcm);
        sampleCount += pcm.length;
        setLevel(Math.min(1, peak * 3));
      };

      source.connect(processor);
      processor.connect(mute);
      mute.connect(context.destination);
      state.finish = async () => {
        if (stopped) return;
        stopped = true;
        const sampleRate = context.sampleRate;
        const durationSeconds = sampleCount / sampleRate;
        release();
        try {
          if (!sampleCount) throw new Error("没有录到音频，请检查麦克风");
          await onComplete(encodeWav(chunks, sampleRate, sampleCount), {
            durationSeconds,
            sampleRate
          });
        } catch (error) {
          onError(error);
        }
      };
      state.timer = setInterval(() => {
        const elapsed = (Date.now() - startedAt) / 1000;
        setSeconds(Math.floor(elapsed));
        if (elapsed >= 600) state.finish();
      }, 100);
      setSeconds(0);
      setRecording(true);
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      release();
      throw error;
    }
  }

  function stop() {
    active.current?.finish?.();
  }

  return { recording, seconds, level, start, stop };
}
