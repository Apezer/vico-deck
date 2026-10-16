const fs = require("node:fs/promises");
const path = require("node:path");

const ENDPOINTS = Object.freeze({
  payg:"https://api.xiaomimimo.com/v1/chat/completions",
  tokenPlanCn:"https://token-plan-cn.xiaomimimo.com/v1/chat/completions"
});
const MODEL_ID = "mimo-v2.5-asr";
const MODEL_LABEL = "MiMo-V2.5-ASR";
const MAX_BASE64_BYTES = 10 * 1024 * 1024;
const FORMAT_BY_EXTENSION = new Map([
  [".wav", "audio/wav"],
  [".mp3", "audio/mpeg"]
]);
const LANGUAGES = new Set(["auto", "zh", "en"]);
const ACCESS_MODES = new Set(["payg", "tokenPlanCn"]);

function normalizeAccessMode(value) {
  return ACCESS_MODES.has(value) ? value : "payg";
}

/** 将界面或旧配置中的语言值收敛为 MiMo 官方支持的取值。 */
function normalizeLanguage(value) {
  const language = String(value || "auto").toLowerCase();
  return LANGUAGES.has(language) ? language : "auto";
}

/** 尽可能读取 PCM WAV 时长；MP3 或非标准 WAV 不影响识别，只不显示时长。 */
function readWavDuration(audio) {
  if (audio.length < 44 || audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }

  let byteRate = 0;
  let dataBytes = 0;
  for (let offset = 12; offset + 8 <= audio.length;) {
    const chunkId = audio.toString("ascii", offset, offset + 4);
    const chunkSize = audio.readUInt32LE(offset + 4);
    const contentOffset = offset + 8;
    if (contentOffset + chunkSize > audio.length) break;
    if (chunkId === "fmt " && chunkSize >= 12) byteRate = audio.readUInt32LE(contentOffset + 8);
    if (chunkId === "data") dataBytes += chunkSize;
    offset = contentOffset + chunkSize + (chunkSize % 2);
  }
  return byteRate > 0 && dataBytes > 0 ? dataBytes / byteRate : null;
}

/** 兼容 OpenAI 风格字符串内容，以及可能返回的文本内容数组。 */
function extractTranscript(payload) {
  const choice = payload?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((item) => typeof item === "string" ? item : item?.text || item?.content || "")
      .join("")
      .trim();
  }
  return String(choice?.text || payload?.text || "").trim();
}

function redactSecret(value, secret) {
  const text = String(value || "");
  return secret ? text.split(secret).join("[已隐藏]") : text;
}

function mimoError(status, payload, apiKey) {
  const code = payload?.error?.code || payload?.code || "UNKNOWN_ERROR";
  const message = redactSecret(payload?.error?.message || payload?.message || `HTTP ${status}`, apiKey);
  return new Error(`小米 MiMo 语音识别失败：代码 ${code} · ${message}`);
}

/**
 * 调用小米 MiMo 的 OpenAI 兼容非流式接口。
 * 当前 VicoDeck 会在用户松开快捷键或旋钮后提交完整 WAV，后续可独立扩展实时流式链路。
 */
class MiMoService {
  constructor({ fetchImpl = globalThis.fetch, endpoints = ENDPOINTS, timeout = 2 * 60 * 1000 } = {}) {
    this.fetchImpl = fetchImpl;
    this.endpoints = endpoints;
    this.timeout = timeout;
    this.active = null;
    this.onProgress = null;
  }

  async transcribe(audioPath, apiKey, options = {}) {
    if (this.active) throw new Error("已有识别任务正在运行");
    if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("请先保存小米 MiMo API Key");

    const extension = path.extname(audioPath).toLowerCase();
    const mimeType = FORMAT_BY_EXTENSION.get(extension);
    if (!mimeType) throw new Error("小米 MiMo 语音识别仅支持 WAV 或 MP3 音频");

    const audio = await fs.readFile(audioPath);
    if (!audio.length) throw new Error("音频文件为空");
    const base64 = audio.toString("base64");
    if (Buffer.byteLength(base64, "ascii") > MAX_BASE64_BYTES) {
      throw new Error("音频的 Base64 数据超过小米 MiMo 规定的 10 MB 上限");
    }

    const controller = new AbortController();
    const state = { controller, cancelled:false };
    const timer = setTimeout(() => controller.abort(), this.timeout);
    const startedAt = Date.now();
    this.active = state;
    this.onProgress?.({ event:"uploading", progress:0.2, message:"正在向小米 MiMo 发送录音…" });

    try {
      const accessMode = normalizeAccessMode(options.accessMode);
      const apiHeaders = accessMode === "tokenPlanCn"
        ? { "api-key":apiKey.trim() }
        : { Authorization:`Bearer ${apiKey.trim()}` };
      const response = await this.fetchImpl(this.endpoints[accessMode], {
        method:"POST",
        headers:{
          ...apiHeaders,
          "Content-Type":"application/json",
          "User-Agent":"VicoDeck"
        },
        body:JSON.stringify({
          model:MODEL_ID,
          messages:[{
            role:"user",
            content:[{
              type:"input_audio",
              input_audio:{ data:`data:${mimeType};base64,${base64}` }
            }]
          }],
          asr_options:{ language:normalizeLanguage(options.language) },
          stream:false
        }),
        signal:controller.signal
      });

      let payload = null;
      try { payload = await response.json(); } catch {}
      if (!response.ok) throw mimoError(response.status, payload, apiKey.trim());

      const text = extractTranscript(payload);
      if (!text) throw new Error("小米 MiMo 已完成请求，但没有返回可用的识别文字");
      this.onProgress?.({ event:"status", message:"小米 MiMo 语音识别完成" });
      return {
        text,
        segments:[],
        language:normalizeLanguage(options.language),
        duration:extension === ".wav" ? readWavDuration(audio) : null,
        elapsed:Math.round((Date.now() - startedAt) / 10) / 100,
        model:MODEL_LABEL,
        provider:"mimo",
        usage:payload?.usage || null
      };
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(state.cancelled ? "任务已取消" : "小米 MiMo 语音识别超时，请稍后重试");
      }
      const safeMessage = redactSecret(error?.message || error, apiKey.trim());
      throw new Error(safeMessage || "小米 MiMo 语音识别失败");
    } finally {
      clearTimeout(timer);
      if (this.active === state) this.active = null;
    }
  }

  cancel() {
    if (!this.active) return false;
    this.active.cancelled = true;
    this.active.controller.abort();
    return true;
  }
}

module.exports = {
  MiMoService,
  MIMO_ENDPOINTS:ENDPOINTS,
  MIMO_MODEL_ID:MODEL_ID,
  MIMO_FORMATS:FORMAT_BY_EXTENSION,
  normalizeAccessMode,
  normalizeLanguage,
  extractTranscript,
  readWavDuration
};
