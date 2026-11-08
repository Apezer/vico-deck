const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { gzipSync, gunzipSync } = require("node:zlib");
const {
  DoubaoFileStreamingService,
  DOUBAO_STREAMING_FRAME_BYTES,
  DOUBAO_STREAMING_FIRST_AUDIO_SEQUENCE
} = require("../electron/speech/providers/doubao-file-streaming-service.cjs");

function createPcmWav(pcm, sampleRate = 16000) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function serverResponse(payload, flags, sequence) {
  const compressed = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
  const header = Buffer.from([0x11, (0x9 << 4) | flags, 0x11, 0x00]);
  const sequenceBytes = Buffer.alloc(4);
  sequenceBytes.writeInt32BE(sequence, 0);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(compressed.length, 0);
  return Buffer.concat([header, sequenceBytes, length, compressed]);
}

class MockWebSocket extends EventEmitter {
  static instances = [];

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = 0;
    this.packets = [];
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open");
    });
  }

  send(value) {
    const packet = Buffer.from(value);
    this.packets.push(packet);
    if ((packet[1] >> 4) !== 0x2) return;

    const sequence = packet.readInt32BE(4);
    if (sequence > 0) {
      queueMicrotask(() => this.emit("message", serverResponse({
        code:0,
        payload_msg:{ result:{ text:"你好", utterances:[{ start_time:0, end_time:200, text:"你好", definite:false }] } }
      }, 0x1, sequence), true));
      return;
    }
    queueMicrotask(() => this.emit("message", serverResponse({
      code:0,
      is_last_package:true,
      payload_msg:{
        audio_info:{ duration:220 },
        result:{ text:"你好 Vico", utterances:[{ start_time:0, end_time:220, text:"你好 Vico", definite:true }] }
      }
    }, 0x3, sequence), true));
  }

  close() {
    this.readyState = 3;
    this.emit("close", 1000, Buffer.from("done"));
  }
}

test("完整 WAV 落盘后按 200 ms 帧发送并返回中间结果", async (context) => {
  MockWebSocket.instances.length = 0;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vico-doubao-stream-file-"));
  context.after(() => fs.rm(directory, { recursive:true, force:true }));
  const pcm = Buffer.alloc(DOUBAO_STREAMING_FRAME_BYTES + 640, 0x15);
  const file = path.join(directory, "complete.wav");
  await fs.writeFile(file, createPcmWav(pcm));

  const progress = [];
  const service = new DoubaoFileStreamingService({
    WebSocketImpl:MockWebSocket,
    frameInterval:0
  });
  service.onProgress = (value) => progress.push(value);
  const result = await service.transcribe(file, "test-api-key", { enableDdc:true });

  assert.equal(result.text, "你好 Vico");
  assert.equal(result.streaming, true);
  assert.equal(result.duration, 0.22);
  assert.ok(progress.some((item) => item.event === "partial-result" && item.text === "你好"));

  const socket = MockWebSocket.instances[0];
  assert.equal(socket.options.headers["X-Api-Key"], "test-api-key");
  assert.equal(socket.packets.length, 3);
  assert.equal(socket.packets[0][1] >> 4, 0x1);
  assert.equal(DOUBAO_STREAMING_FIRST_AUDIO_SEQUENCE, 2);
  assert.equal(socket.packets[1].readInt32BE(4), 2);
  assert.equal(socket.packets[2].readInt32BE(4), -3);

  const firstAudioBytes = socket.packets[1].readUInt32BE(8);
  assert.equal(gunzipSync(socket.packets[1].subarray(12, 12 + firstAudioBytes)).length, DOUBAO_STREAMING_FRAME_BYTES);
  const lastAudioBytes = socket.packets[2].readUInt32BE(8);
  assert.equal(gunzipSync(socket.packets[2].subarray(12, 12 + lastAudioBytes)).length, 640);
});
