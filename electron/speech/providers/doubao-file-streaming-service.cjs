const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { gzipSync, gunzipSync } = require("node:zlib");
const WebSocket = require("ws");
const {
  inspectPcmWav,
  preparePcmForDashScope
} = require("./dashscope-provider.cjs");

const ENDPOINT = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";
const RESOURCE_ID = "volc.seedasr.sauc.duration";
const MODEL_LABEL = "Doubao Seed-ASR 2.0 Streaming";
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const FRAME_DURATION_MS = 200;
const FRAME_BYTES = SAMPLE_RATE * BYTES_PER_SAMPLE * FRAME_DURATION_MS / 1000;
// 豆包 V1 协议会把不携带显式序号的配置首包自动记为序号 1，
// 因此第一份音频必须从 2 开始，之后逐包递增，末包使用对应的负序号。
const FIRST_AUDIO_SEQUENCE = 2;
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;

const MESSAGE_TYPE = Object.freeze({
  FULL_CLIENT_REQUEST:0x1,
  AUDIO_ONLY_REQUEST:0x2,
  FULL_SERVER_RESPONSE:0x9,
  SERVER_ACK:0xb,
  SERVER_ERROR:0xf
});

const MESSAGE_FLAG = Object.freeze({
  NO_SEQUENCE:0x0,
  POSITIVE_SEQUENCE:0x1,
  NEGATIVE_SEQUENCE:0x3
});

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** 将数值编码为豆包二进制协议使用的大端 32-bit 整数。 */
function int32(value, signed = false) {
  const buffer = Buffer.allocUnsafe(4);
  if (signed) buffer.writeInt32BE(value, 0);
  else buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

/** 构造固定四字节协议头：v1、四字节头、消息类型、序列化和压缩方式。 */
function protocolHeader(messageType, flags, serialization, compression) {
  return Buffer.from([
    0x11,
    (messageType << 4) | flags,
    (serialization << 4) | compression,
    0x00
  ]);
}

/** 创建会话首包，声明后续发送的是 16 kHz、单声道、16-bit 裸 PCM。 */
function buildFullClientRequest(options = {}) {
  const payload = gzipSync(Buffer.from(JSON.stringify({
    user:{ uid:"vico-keyboard" },
    audio:{ format:"pcm", codec:"raw", rate:SAMPLE_RATE, bits:16, channel:1 },
    request:{
      model_name:"bigmodel",
      enable_nonstream:true,
      enable_itn:options.enableItn !== false,
      enable_punc:options.enablePunc !== false,
      enable_ddc:options.enableDdc !== false,
      show_utterances:true
    }
  }), "utf8"));
  return Buffer.concat([
    protocolHeader(MESSAGE_TYPE.FULL_CLIENT_REQUEST, MESSAGE_FLAG.NO_SEQUENCE, 1, 1),
    int32(payload.length),
    payload
  ]);
}

/** 创建音频包；最后一帧使用负序号，通知服务端音频已经发送完毕。 */
function buildAudioRequest(pcm, sequence, last = false) {
  const payload = gzipSync(Buffer.from(pcm));
  const flags = last ? MESSAGE_FLAG.NEGATIVE_SEQUENCE : MESSAGE_FLAG.POSITIVE_SEQUENCE;
  const wireSequence = last ? -Math.abs(sequence) : Math.abs(sequence);
  return Buffer.concat([
    protocolHeader(MESSAGE_TYPE.AUDIO_ONLY_REQUEST, flags, 0, 1),
    int32(wireSequence, true),
    int32(payload.length),
    payload
  ]);
}

function decodePayload(buffer, compression, serialization) {
  let payload = Buffer.from(buffer);
  if (compression === 1 && payload.length) payload = gunzipSync(payload);
  if (serialization === 1 && payload.length) return JSON.parse(payload.toString("utf8"));
  if (payload.length && (payload[0] === 0x7b || payload[0] === 0x5b)) {
    return JSON.parse(payload.toString("utf8"));
  }
  return payload;
}

/** 解析豆包二进制响应，兼容全量响应、ACK 与错误包。 */
function parseServerMessage(value) {
  const buffer = Buffer.from(value);
  if (buffer.length < 4) throw new Error("豆包返回了过短的 WebSocket 数据包");
  const headerBytes = (buffer[0] & 0x0f) * 4;
  const messageType = buffer[1] >> 4;
  const flags = buffer[1] & 0x0f;
  const serialization = buffer[2] >> 4;
  const compression = buffer[2] & 0x0f;
  if (headerBytes < 4 || buffer.length < headerBytes) throw new Error("豆包响应头无效");

  let offset = headerBytes;
  let sequence = null;
  let errorCode = null;
  if (messageType === MESSAGE_TYPE.FULL_SERVER_RESPONSE && (flags & 0x01)) {
    if (buffer.length < offset + 4) throw new Error("豆包响应缺少序号");
    sequence = buffer.readInt32BE(offset);
    offset += 4;
  } else if (messageType === MESSAGE_TYPE.SERVER_ACK) {
    if (buffer.length < offset + 4) throw new Error("豆包 ACK 缺少序号");
    sequence = buffer.readInt32BE(offset);
    offset += 4;
  } else if (messageType === MESSAGE_TYPE.SERVER_ERROR) {
    if (buffer.length < offset + 4) throw new Error("豆包错误响应缺少错误码");
    errorCode = buffer.readUInt32BE(offset);
    offset += 4;
  }

  if (buffer.length < offset + 4) {
    return { messageType, flags, sequence, errorCode, payload:null, last:(flags & 0x02) !== 0 };
  }
  const payloadBytes = buffer.readUInt32BE(offset);
  offset += 4;
  if (payloadBytes > buffer.length - offset) throw new Error("豆包响应负载长度无效");
  const payload = decodePayload(buffer.subarray(offset, offset + payloadBytes), compression, serialization);
  return {
    messageType,
    flags,
    sequence,
    errorCode,
    payload,
    last:(flags & 0x02) !== 0 || payload?.is_last_package === true
  };
}

function responseBody(parsed) {
  return parsed?.payload?.payload_msg || parsed?.payload || {};
}

function responseText(parsed) {
  const body = responseBody(parsed);
  const result = Array.isArray(body?.result) ? body.result[0] : body?.result;
  return String(result?.text || body?.text || "").trim();
}

function responseSegments(parsed) {
  const body = responseBody(parsed);
  const result = Array.isArray(body?.result) ? body.result[0] : body?.result;
  const utterances = Array.isArray(result?.utterances) ? result.utterances : [];
  return utterances.map((item) => ({
    start:Number(item.start_time || 0) / 1000,
    end:Number(item.end_time || 0) / 1000,
    text:String(item.text || "").trim(),
    final:item.definite === true,
    speaker:item?.additions?.speaker_id ?? item?.speaker_id ?? null
  })).filter((item) => item.text);
}

/**
 * 完整录音文件的豆包流式识别适配器。
 *
 * 键盘录音仍由原有 USB/BLE 协议完整接收并校验。只有 WAV 已经落盘后，
 * 本适配器才读取音频、转换为 16 kHz PCM，并按 200 ms 一帧回放给豆包。
 */
class DoubaoFileStreamingService {
  constructor({
    WebSocketImpl = WebSocket,
    endpoint = ENDPOINT,
    resourceId = RESOURCE_ID,
    frameInterval = FRAME_DURATION_MS,
    timeout = 15 * 60 * 1000,
    wait = delay
  } = {}) {
    this.WebSocketImpl = WebSocketImpl;
    this.endpoint = endpoint;
    this.resourceId = resourceId;
    this.frameInterval = frameInterval;
    this.timeout = timeout;
    this.wait = wait;
    this.active = null;
    this.onProgress = null;
  }

  async sendAudio(socket, pcm, state) {
    const totalFrames = Math.ceil(pcm.length / FRAME_BYTES);
    for (let offset = 0, sequence = FIRST_AUDIO_SEQUENCE; offset < pcm.length; offset += FRAME_BYTES, sequence += 1) {
      if (state.cancelled) throw new Error("任务已取消");
      if (socket.readyState !== 1) throw new Error("豆包流式语音连接已断开");
      const end = Math.min(offset + FRAME_BYTES, pcm.length);
      const last = end >= pcm.length;
      socket.send(buildAudioRequest(pcm.subarray(offset, end), sequence, last), { binary:true });
      this.onProgress?.({
        event:"uploading",
        progress:(sequence - FIRST_AUDIO_SEQUENCE + 1) / totalFrames,
        message:last
          ? "录音发送完成，正在确认最终文字…"
          : `正在流式发送录音 ${Math.round((sequence - FIRST_AUDIO_SEQUENCE + 1) / totalFrames * 100)}%`
      });
      if (!last && this.frameInterval > 0) await this.wait(this.frameInterval);
    }
  }

  async transcribe(audioPath, apiKey, options = {}) {
    if (this.active) throw new Error("已有豆包流式识别任务正在运行");
    if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("请先保存豆包 API Key");
    if (path.extname(audioPath).toLowerCase() !== ".wav") {
      throw new Error("完整录音流式识别当前仅支持 PCM WAV 音频");
    }

    const stat = await fs.stat(audioPath);
    if (!stat.size || stat.size > MAX_AUDIO_BYTES) throw new Error("音频为空或 WAV 文件超过 100 MB");
    const audio = await fs.readFile(audioPath);
    const audioInfo = inspectPcmWav(audio);
    const pcm = preparePcmForDashScope(audio, audioInfo);
    const startedAt = Date.now();
    const state = { cancelled:false, socket:null, reject:null };
    this.active = state;

    try {
      return await new Promise((resolve, reject) => {
        let settled = false;
        let timeoutId = null;
        let latestText = "";
        let latestSegments = [];
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
          reject(error instanceof Error ? error : new Error(String(error || "豆包流式识别失败")));
        };
        const succeed = (parsed) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          closeSocket();
          const body = responseBody(parsed);
          const durationMs = Number(body?.audio_info?.duration || 0);
          this.onProgress?.({ event:"status", message:"豆包流式语音识别完成" });
          resolve({
            text:latestText,
            segments:latestSegments,
            language:"auto",
            duration:durationMs > 0 ? durationMs / 1000 : audioInfo.duration,
            elapsed:Math.round((Date.now() - startedAt) / 10) / 100,
            model:MODEL_LABEL,
            provider:"doubao",
            usage,
            streaming:true
          });
        };

        state.reject = fail;
        timeoutId = setTimeout(() => fail(new Error("豆包流式识别超时，请稍后重试")), this.timeout);

        let socket;
        try {
          socket = new this.WebSocketImpl(this.endpoint, {
            headers:{
              "X-Api-Key":apiKey.trim(),
              "X-Api-Resource-Id":this.resourceId,
              "X-Api-Request-Id":randomUUID(),
              "User-Agent":"VicoDeck"
            }
          });
          state.socket = socket;
        } catch (error) {
          fail(new Error(`无法连接豆包流式语音服务：${error.message}`));
          return;
        }

        socket.on("open", () => {
          this.onProgress?.({ event:"status", message:"已完整接收录音，正在启动豆包流式识别…" });
          socket.send(buildFullClientRequest(options), { binary:true });
          this.sendAudio(socket, pcm, state).catch(fail);
        });
        socket.on("message", (data) => {
          if (settled || state.cancelled) return;
          let parsed;
          try {
            parsed = parseServerMessage(data);
          } catch (error) {
            fail(new Error(`无法解析豆包流式识别响应：${error.message}`));
            return;
          }

          const payloadCode = Number(parsed?.payload?.code || 0);
          if (parsed.messageType === MESSAGE_TYPE.SERVER_ERROR || parsed.errorCode || payloadCode) {
            const detail = parsed.payload?.message || parsed.payload?.error || "未知错误";
            fail(new Error(`豆包流式识别失败：代码 ${parsed.errorCode || payloadCode || "UNKNOWN"} · ${detail}`));
            return;
          }

          const text = responseText(parsed);
          const segments = responseSegments(parsed);
          if (text) {
            latestText = text;
            if (segments.length) latestSegments = segments;
            this.onProgress?.({
              event:"partial-result",
              text,
              segments,
              message:"豆包正在流式识别…"
            });
          }
          usage = parsed.payload?.usage || parsed.payload?.payload_msg?.usage || usage;
          if (parsed.last) succeed(parsed);
        });
        socket.on("unexpected-response", (_request, response) => {
          response?.resume?.();
          fail(new Error(`豆包流式语音鉴权失败：HTTP ${response?.statusCode || "未知"}，请确认已开通流式识别 2.0`));
        });
        socket.on("error", (error) => fail(new Error(`无法连接豆包流式语音服务：${error.message}`)));
        socket.on("close", (code, reason) => {
          if (!settled) fail(new Error(`豆包流式语音连接意外关闭：${code}${reason?.length ? ` · ${reason.toString()}` : ""}`));
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
  DoubaoFileStreamingService,
  DOUBAO_STREAMING_ENDPOINT:ENDPOINT,
  DOUBAO_STREAMING_RESOURCE_ID:RESOURCE_ID,
  DOUBAO_STREAMING_FRAME_BYTES:FRAME_BYTES,
  DOUBAO_STREAMING_FIRST_AUDIO_SEQUENCE:FIRST_AUDIO_SEQUENCE,
  buildFullClientRequest,
  buildAudioRequest,
  parseServerMessage,
  responseText,
  responseSegments
};
