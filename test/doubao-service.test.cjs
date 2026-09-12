const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { DoubaoService } = require("../electron/doubao-service.cjs");

function response(code, body = {}, message = "OK") {
  return new Response(JSON.stringify(body), {
    status:200,
    headers:{ "X-Api-Status-Code":code, "X-Api-Message":message, "X-Tt-Logid":"test-log" }
  });
}

test("豆包服务提交 Base64 WAV 并轮询到统一结果", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vico-doubao-test-"));
  context.after(() => fs.rm(directory, { recursive:true, force:true }));
  const file = path.join(directory, "voice.wav");
  await fs.writeFile(file, Buffer.from("RIFF test audio"));
  const calls = [];
  const service = new DoubaoService({
    pollInterval:1,
    fetchImpl:async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/submit")) return response("20000000");
      if (calls.length === 2) return response("20000001");
      return response("20000000", {
        audio_info:{ duration:1200 },
        result:{ text:"你好，Vico。", utterances:[{ start_time:0, end_time:1200, text:"你好，Vico。" }] }
      });
    }
  });
  const result = await service.transcribe(file, "secret-key");
  assert.equal(result.text, "你好，Vico。");
  assert.equal(result.duration, 1.2);
  assert.equal(calls[0].options.headers["X-Api-Key"], "secret-key");
  assert.equal(JSON.parse(calls[0].options.body).audio.format, "wav");
});

test("云端错误不会泄露 API Key", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vico-doubao-error-"));
  context.after(() => fs.rm(directory, { recursive:true, force:true }));
  const file = path.join(directory, "voice.wav");
  await fs.writeFile(file, Buffer.from("RIFF test audio"));
  const service = new DoubaoService({ fetchImpl:async () => response("45000001", {}, "invalid request") });
  await assert.rejects(service.transcribe(file, "never-print-secret"), (error) => {
    assert.match(error.message, /45000001/);
    assert.doesNotMatch(error.message, /never-print-secret/);
    return true;
  });
});
