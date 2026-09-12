import assert from "node:assert/strict";
import { encodeWav } from "../src/useRecorder.js";

const samples = new Int16Array([0, 32767, -32768, 1024]);
const wav = encodeWav([samples], 48000, samples.length);
const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
const ascii = (offset, length) => String.fromCharCode(...wav.slice(offset, offset + length));

assert.equal(ascii(0, 4), "RIFF");
assert.equal(ascii(8, 4), "WAVE");
assert.equal(ascii(12, 4), "fmt ");
assert.equal(ascii(36, 4), "data");
assert.equal(view.getUint16(20, true), 1, "应使用 PCM 编码");
assert.equal(view.getUint16(22, true), 1, "应为单声道");
assert.equal(view.getUint32(24, true), 48000);
assert.equal(view.getUint16(34, true), 16, "应为 16-bit PCM");
assert.equal(view.getUint32(40, true), samples.length * 2);
assert.equal(view.getInt16(46, true), 32767);
assert.equal(view.getInt16(48, true), -32768);

console.log("电脑麦克风 WAV 编码测试通过");
