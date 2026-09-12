const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const BASE_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel";
const RESOURCE_ID = "volc.seedasr.auc";
const SUCCESS = "20000000";
const PENDING = new Set(["20000001", "20000002"]);
const FORMAT_BY_EXTENSION = new Map([
  [".wav", "wav"], [".mp3", "mp3"], [".ogg", "ogg"], [".opus", "ogg"],
  [".m4a", "m4a"], [".aac", "aac"], [".mp4", "mp4"], [".flac", "flac"]
]);

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason || new Error("任务已取消"));
    }, { once:true });
  });
}

function responseStatus(response) {
  return {
    code:response.headers.get("x-api-status-code") || "",
    message:response.headers.get("x-api-message") || response.headers.get("x-api-status-message") || "",
    logId:response.headers.get("x-tt-logid") || ""
  };
}

function apiError(prefix, status, httpStatus) {
  const detail = [
    status.code && `代码 ${status.code}`,
    status.message,
    status.logId && `LogID ${status.logId}`
  ].filter(Boolean).join(" · ");
  return new Error(`${prefix}${detail ? `：${detail}` : `：HTTP ${httpStatus}`}`);
}

function normalizeResult(body, elapsed) {
  const utterances = Array.isArray(body?.result?.utterances) ? body.result.utterances : [];
  const segments = utterances.map(item => ({
    start:Number(item.start_time || 0) / 1000,
    end:Number(item.end_time || 0) / 1000,
    text:String(item.text || "").trim(),
    speaker:item.speaker_id ?? item.speaker_info ?? null
  })).filter(item => item.text);
  const durationMs = Number(body?.audio_info?.duration || body?.result?.additions?.duration || 0);
  return {
    text:String(body?.result?.text || segments.map(item => item.text).join("\n")).trim(),
    segments,
    language:body?.result?.language || "auto",
    duration:durationMs / 1000,
    elapsed,
    model:"Doubao Seed-ASR 2.0",
    provider:"doubao"
  };
}

class DoubaoService {
  constructor({ fetchImpl = globalThis.fetch, pollInterval = 1000, timeout = 10 * 60 * 1000 } = {}) {
    if (typeof fetchImpl !== "function") throw new Error("当前运行环境不支持网络请求");
    this.fetch = fetchImpl;
    this.pollInterval = pollInterval;
    this.timeout = timeout;
    this.controller = null;
    this.onProgress = null;
  }

  async transcribe(audioPath, apiKey, options = {}) {
    if (this.controller) throw new Error("已有识别任务正在运行");
    if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("请先保存豆包 API Key");
    const format = FORMAT_BY_EXTENSION.get(path.extname(audioPath).toLowerCase());
    if (!format) throw new Error("豆包暂不支持该音频格式");
    const stat = await fs.stat(audioPath);
    if (!stat.size || stat.size > 100 * 1024 * 1024) throw new Error("音频为空或超过 100 MB");

    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(new Error("豆包识别超时，请稍后重试")), this.timeout);
    const started = Date.now();
    const requestId = randomUUID();
    const headers = {
      "Content-Type":"application/json",
      "X-Api-Key":apiKey.trim(),
      "X-Api-Resource-Id":RESOURCE_ID,
      "X-Api-Request-Id":requestId
    };
    try {
      const audio = await fs.readFile(audioPath);
      this.onProgress?.({ event:"status", message:"正在上传键盘录音…" });
      const submit = await this.fetch(`${BASE_URL}/submit`, {
        method:"POST",
        headers:{ ...headers, "X-Api-Sequence":"-1" },
        body:JSON.stringify({
          user:{ uid:"vico-keyboard" },
          audio:{ data:audio.toString("base64"), format },
          request:{
            model_name:"bigmodel",
            enable_channel_split:Boolean(options.enableChannelSplit),
            enable_ddc:options.enableDdc !== false,
            enable_speaker_info:Boolean(options.enableSpeakerInfo),
            enable_punc:options.enablePunc !== false,
            enable_itn:options.enableItn !== false,
            show_utterances:true
          }
        }),
        signal:controller.signal
      });
      const submitted = responseStatus(submit);
      if (!submit.ok || submitted.code !== SUCCESS) throw apiError("豆包任务提交失败", submitted, submit.status);

      while (true) {
        await delay(this.pollInterval, controller.signal);
        const query = await this.fetch(`${BASE_URL}/query`, {
          method:"POST", headers, body:"{}", signal:controller.signal
        });
        const queried = responseStatus(query);
        if (query.ok && queried.code === SUCCESS) {
          return normalizeResult(await query.json(), Math.round((Date.now() - started) / 10) / 100);
        }
        if (query.ok && PENDING.has(queried.code)) {
          this.onProgress?.({
            event:"status",
            message:queried.code === "20000002" ? "任务正在豆包队列中…" : "豆包正在识别语音…"
          });
          continue;
        }
        throw apiError("豆包识别失败", queried, query.status);
      }
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason || new Error("任务已取消");
      if (error instanceof TypeError) throw new Error(`无法连接豆包语音服务：${error.message}`);
      throw error;
    } finally {
      clearTimeout(timeout);
      if (this.controller === controller) this.controller = null;
    }
  }

  cancel() {
    if (!this.controller) return false;
    this.controller.abort(new Error("任务已取消"));
    return true;
  }
}

module.exports = { DoubaoService, FORMAT_BY_EXTENSION, normalizeResult };
