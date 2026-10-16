const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const WebSocket = require("ws");

const REGION_ID = "cn-beijing";
const ENDPOINT = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
const MODEL_ID = "qwen-audio-3.1-asr-flash-message";
const MODEL_LABEL = "Qwen Audio 3.1 ASR Flash Message";
const TARGET_SAMPLE_RATE = 16000;
const FRAME_BYTES = 3200;
const MAX_SOURCE_AUDIO_BYTES = 100 * 1024 * 1024;
const FORMAT_BY_EXTENSION = new Map([[".wav", "wav"]]);

/**
 * 解析 PCM WAV 的格式与数据块。
 * DashScope Message 模型要求单声道、16-bit PCM，并固定使用 16 kHz。
 */
function inspectPcmWav(audio) {
  if (audio.length < 44 || audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("百炼实时语音识别当前仅支持 PCM WAV 录音");
  }

  let offset = 12;
  let format = null;
  let dataBytes = 0;
  const dataChunks = [];
  while (offset + 8 <= audio.length) {
    const chunkId = audio.toString("ascii", offset, offset + 4);
    const chunkSize = audio.readUInt32LE(offset + 4);
    const contentOffset = offset + 8;
    if (contentOffset + chunkSize > audio.length) break;
    if (chunkId === "fmt " && chunkSize >= 16) {
      format = {
        audioFormat:audio.readUInt16LE(contentOffset),
        channels:audio.readUInt16LE(contentOffset + 2),
        sampleRate:audio.readUInt32LE(contentOffset + 4),
        bitsPerSample:audio.readUInt16LE(contentOffset + 14)
      };
    } else if (chunkId === "data") {
      dataBytes += chunkSize;
      dataChunks.push(audio.subarray(contentOffset, contentOffset + chunkSize));
    }
    offset = contentOffset + chunkSize + (chunkSize % 2);
  }

  if (!format || dataBytes < 2 || dataBytes % 2 !== 0) throw new Error("WAV 文件缺少有效的格式或音频数据");
  if (format.audioFormat !== 1 || format.channels !== 1 || format.bitsPerSample !== 16) {
    throw new Error("百炼实时语音识别要求单声道、16-bit PCM WAV");
  }
  if (!format.sampleRate) throw new Error("WAV 文件的采样率无效");
  return {
    ...format,
    duration:dataBytes / (format.sampleRate * 2),
    dataBytes,
    dataChunks
  };
}

/** 将任意常见输入采样率的 PCM16 音频线性重采样为 16 kHz 裸 PCM。 */
function preparePcmForDashScope(audio, audioInfo = inspectPcmWav(audio)) {
  const source = Buffer.concat(audioInfo.dataChunks);
  if (audioInfo.sampleRate === TARGET_SAMPLE_RATE) return source;

  const sourceSamples = Math.floor(source.length / 2);
  const targetSamples = Math.max(1, Math.round(sourceSamples * TARGET_SAMPLE_RATE / audioInfo.sampleRate));
  const output = Buffer.allocUnsafe(targetSamples * 2);
  for (let index = 0; index < targetSamples; index += 1) {
    const sourcePosition = index * audioInfo.sampleRate / TARGET_SAMPLE_RATE;
    const lower = Math.min(sourceSamples - 1, Math.floor(sourcePosition));
    const upper = Math.min(sourceSamples - 1, lower + 1);
    const fraction = sourcePosition - lower;
    const lowerValue = source.readInt16LE(lower * 2);
    const upperValue = source.readInt16LE(upper * 2);
    output.writeInt16LE(Math.round(lowerValue + (upperValue - lowerValue) * fraction), index * 2);
  }
  return output;
}

function createRunTask(taskId, options = {}) {
  return {
    header:{ action:"run-task", task_id:taskId, streaming:"duplex" },
    payload:{
      task_group:"audio",
      task:"asr",
      function:"recognition",
      model:MODEL_ID,
      parameters:{
        format:"pcm",
        sample_rate:TARGET_SAMPLE_RATE,
        disfluency_removal_enabled:options.enableDdc !== false,
        intermediate_result_enabled:false,
        keep_dialect:false,
        vad_model:"near_meeting_16k"
      },
      input:{}
    }
  };
}

function createFinishTask(taskId) {
  return {
    header:{ action:"finish-task", task_id:taskId, streaming:"duplex" },
    payload:{ input:{} }
  };
}

function dashScopeError(message = {}) {
  const code = message?.header?.error_code || "UNKNOWN_ERROR";
  const detail = message?.header?.error_message || "未知错误";
  const taskId = message?.header?.task_id || "";
  return new Error(`百炼语音识别失败：代码 ${code} · ${detail}${taskId ? ` · Task ID ${taskId}` : ""}`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * 通过 DashScope WebSocket 原始协议调用 Qwen Audio Message 模型。
 * 录音结束后按 100 ms 一帧发送 16 kHz PCM，兼容电脑麦克风和键盘麦克风的统一 WAV 链路。
 */
class DashScopeService {
  constructor({
    WebSocketImpl = WebSocket,
    endpoint = ENDPOINT,
    timeout = 15 * 60 * 1000,
    frameInterval = 100,
    wait = delay
  } = {}) {
    this.WebSocketImpl = WebSocketImpl;
    this.endpoint = endpoint;
    this.timeout = timeout;
    this.frameInterval = frameInterval;
    this.wait = wait;
    this.active = null;
    this.onProgress = null;
  }

  async sendAudio(socket, pcm, taskId, state) {
    for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
      if (state.cancelled) throw new Error("任务已取消");
      if (socket.readyState !== 1) throw new Error("百炼语音连接已断开");
      socket.send(pcm.subarray(offset, Math.min(offset + FRAME_BYTES, pcm.length)), { binary:true });
      const sent = Math.min(offset + FRAME_BYTES, pcm.length);
      this.onProgress?.({
        event:"uploading",
        progress:sent / pcm.length,
        message:`正在发送语音 ${Math.round(sent / pcm.length * 100)}%`
      });
      if (sent < pcm.length && this.frameInterval > 0) await this.wait(this.frameInterval);
    }
    if (state.cancelled) throw new Error("任务已取消");
    socket.send(JSON.stringify(createFinishTask(taskId)));
    this.onProgress?.({ event:"status", message:"音频发送完成，正在生成最终文字…" });
  }

  async transcribe(audioPath, apiKey, options = {}) {
    if (this.active) throw new Error("已有识别任务正在运行");
    if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("请先保存百炼 API Key");
    if (!FORMAT_BY_EXTENSION.has(path.extname(audioPath).toLowerCase())) {
      throw new Error("百炼实时语音识别当前仅支持 WAV 音频");
    }

    const stat = await fs.stat(audioPath);
    if (!stat.size || stat.size > MAX_SOURCE_AUDIO_BYTES) throw new Error("音频为空或 WAV 文件超过 100 MB");
    const audio = await fs.readFile(audioPath);
    const audioInfo = inspectPcmWav(audio);
    const pcm = preparePcmForDashScope(audio, audioInfo);
    const taskId = randomUUID();
    const startedAt = Date.now();
    const state = { cancelled:false, socket:null, reject:null };
    this.active = state;

    try {
      return await new Promise((resolve, reject) => {
        let settled = false;
        let timeoutId = null;
        const sentences = new Map();
        let usage = null;

        const closeSocket = () => {
          const socket = state.socket;
          if (!socket || socket.readyState > 1) return;
          try { socket.close(1000, "done"); } catch {}
        };
        const fail = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          closeSocket();
          reject(error instanceof Error ? error : new Error(String(error || "语音识别失败")));
        };
        const succeed = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          closeSocket();
          const segments = [...sentences.values()].sort((left, right) => left.id - right.id);
          const text = segments.map((item) => item.text).join("").trim();
          this.onProgress?.({ event:"status", message:"百炼语音识别完成" });
          resolve({
            text,
            segments,
            language:"auto",
            duration:audioInfo.duration,
            elapsed:Math.round((Date.now() - startedAt) / 10) / 100,
            model:MODEL_LABEL,
            provider:"dashscope",
            usage
          });
        };

        state.reject = fail;
        timeoutId = setTimeout(() => fail(new Error("百炼语音识别超时，请稍后重试")), this.timeout);

        let socket;
        try {
          socket = new this.WebSocketImpl(this.endpoint, {
            headers:{
              Authorization:`Bearer ${apiKey.trim()}`,
              "User-Agent":"VicoDeck"
            }
          });
          state.socket = socket;
        } catch (error) {
          fail(new Error(`无法连接阿里云百炼：${error.message}`));
          return;
        }

        socket.on("open", () => {
          this.onProgress?.({ event:"status", message:"已连接阿里云百炼，正在启动识别任务…" });
          socket.send(JSON.stringify(createRunTask(taskId, options)));
        });
        socket.on("message", (data, isBinary) => {
          if (isBinary || settled) return;
          let message;
          try {
            message = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
          } catch {
            fail(new Error("百炼返回了无法解析的响应"));
            return;
          }

          const event = message?.header?.event;
          if (event === "task-started") {
            this.onProgress?.({ event:"status", message:"识别任务已启动，正在发送录音…" });
            this.sendAudio(socket, pcm, taskId, state).catch(fail);
            return;
          }
          if (event === "result-generated") {
            const sentence = message?.payload?.output?.sentence;
            if (sentence && !sentence.heartbeat && sentence.text) {
              sentences.set(Number(sentence.sentence_id || 0), {
                id:Number(sentence.sentence_id || 0),
                text:String(sentence.text),
                begin:Number(sentence.begin_time || 0) / 1000,
                end:sentence.end_time == null ? null : Number(sentence.end_time) / 1000,
                final:sentence.sentence_end === true
              });
            }
            usage = message?.payload?.usage || usage;
            return;
          }
          if (event === "task-failed") {
            fail(dashScopeError(message));
            return;
          }
          if (event === "task-finished") {
            usage = message?.payload?.usage || usage;
            succeed();
          }
        });
        socket.on("unexpected-response", (_request, response) => {
          response?.resume?.();
          fail(new Error(`百炼 WebSocket 鉴权失败：HTTP ${response?.statusCode || "未知"}，请检查北京地域 API Key`));
        });
        socket.on("error", (error) => fail(new Error(`无法连接阿里云百炼：${error.message}`)));
        socket.on("close", (code, reason) => {
          if (!settled) fail(new Error(`百炼语音连接意外关闭：${code}${reason?.length ? ` · ${reason.toString()}` : ""}`));
        });
      });
    } finally {
      if (this.active === state) this.active = null;
    }
  }

  cancel() {
    if (!this.active) return false;
    this.active.cancelled = true;
    this.active.reject?.(new Error("任务已取消"));
    return true;
  }
}

module.exports = {
  DashScopeService,
  DASHSCOPE_ENDPOINT:ENDPOINT,
  DASHSCOPE_MODEL_ID:MODEL_ID,
  DASHSCOPE_REGION_ID:REGION_ID,
  DASHSCOPE_FORMATS:FORMAT_BY_EXTENSION,
  inspectPcmWav,
  preparePcmForDashScope,
  createRunTask,
  createFinishTask
};
