const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const {
  DashScopeService,
  DASHSCOPE_MODEL_ID,
  inspectPcmWav,
  preparePcmForDashScope
} = require("../electron/speech/providers/dashscope-provider.cjs");

function createWav({ sampleRate = 48000, channels = 1, bitsPerSample = 16, seconds = 0.2 } = {}) {
  const dataBytes = Math.floor(sampleRate * channels * (bitsPerSample / 8) * seconds);
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  wav.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

class SuccessfulSocket extends EventEmitter {
  static instances = [];

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = 0;
    this.messages = [];
    this.binaryFrames = [];
    SuccessfulSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open");
    });
  }

  send(data, options = {}) {
    if (Buffer.isBuffer(data) || options.binary) {
      this.binaryFrames.push(Buffer.from(data));
      return;
    }
    const message = JSON.parse(String(data));
    this.messages.push(message);
    if (message.header.action === "run-task") {
      queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify({
        header:{ event:"task-started", task_id:message.header.task_id },
        payload:{}
      })), false));
    } else if (message.header.action === "finish-task") {
      queueMicrotask(() => {
        this.emit("message", Buffer.from(JSON.stringify({
          header:{ event:"result-generated", task_id:message.header.task_id },
          payload:{
            output:{ sentence:{ sentence_id:1, begin_time:0, end_time:200, text:"你好，Vico。", sentence_end:true } },
            usage:{ input_tokens:12, output_tokens:4, total_tokens:16 }
          }
        })), false);
        this.emit("message", Buffer.from(JSON.stringify({
          header:{ event:"task-finished", task_id:message.header.task_id },
          payload:{ usage:{ input_tokens:12, output_tokens:4, total_tokens:16 } }
        })), false);
      });
    }
  }

  close() {
    this.readyState = 3;
    queueMicrotask(() => this.emit("close", 1000, Buffer.alloc(0)));
  }
}

test("百炼通过 WebSocket 向 Qwen Audio Message 发送 16 kHz PCM", async (context) => {
  SuccessfulSocket.instances = [];
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vico-dashscope-test-"));
  context.after(() => fs.rm(directory, { recursive:true, force:true }));
  const file = path.join(directory, "voice.wav");
  await fs.writeFile(file, createWav());
  const service = new DashScopeService({ WebSocketImpl:SuccessfulSocket, frameInterval:0 });

  const result = await service.transcribe(file, "sk-test-secret", { enableDdc:true });
  const socket = SuccessfulSocket.instances[0];
  const runTask = socket.messages.find((message) => message.header.action === "run-task");
  assert.equal(new URL(socket.url).hostname, "dashscope.aliyuncs.com");
  assert.equal(socket.options.headers.Authorization, "Bearer sk-test-secret");
  assert.equal(runTask.payload.model, DASHSCOPE_MODEL_ID);
  assert.equal(runTask.payload.parameters.format, "pcm");
  assert.equal(runTask.payload.parameters.sample_rate, 16000);
  assert.equal(runTask.payload.parameters.disfluency_removal_enabled, true);
  assert.equal(Buffer.concat(socket.binaryFrames).length, 6400);
  assert.equal(result.text, "你好，Vico。");
  assert.equal(result.provider, "dashscope");
  assert.deepEqual(result.usage, { input_tokens:12, output_tokens:4, total_tokens:16 });
});

test("电脑麦克风常见采样率会转换为 16 kHz 裸 PCM", () => {
  const source = createWav({ sampleRate:48000 });
  const info = inspectPcmWav(source);
  const prepared = preparePcmForDashScope(source, info);
  assert.equal(info.sampleRate, 48000);
  assert.equal(prepared.length, 6400);
});

test("WAV 声道参数不符合要求时在联网前给出明确错误", () => {
  assert.throws(() => inspectPcmWav(createWav({ channels:2 })), /单声道/);
});

test("WebSocket 鉴权错误不会泄露百炼 API Key", async (context) => {
  class RejectedSocket extends EventEmitter {
    constructor() {
      super();
      this.readyState = 0;
      queueMicrotask(() => this.emit("unexpected-response", {}, { statusCode:401 }));
    }

    close() {
      this.readyState = 3;
    }
  }

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vico-dashscope-error-"));
  context.after(() => fs.rm(directory, { recursive:true, force:true }));
  const file = path.join(directory, "voice.wav");
  await fs.writeFile(file, createWav());
  const service = new DashScopeService({ WebSocketImpl:RejectedSocket, frameInterval:0 });
  await assert.rejects(
    service.transcribe(file, "never-print-this-key"),
    (error) => {
      assert.match(error.message, /HTTP 401/);
      assert.doesNotMatch(error.message, /never-print-this-key/);
      return true;
    }
  );
});
