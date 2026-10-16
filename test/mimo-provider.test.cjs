const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const {
  MiMoService,
  MIMO_MODEL_ID,
  normalizeLanguage,
  readWavDuration
} = require("../electron/speech/providers/mimo-provider.cjs");

function createWav({ sampleRate = 16000, seconds = 0.25 } = {}) {
  const dataBytes = Math.floor(sampleRate * 2 * seconds);
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

test("小米 MiMo 按官方 OpenAI 兼容格式提交 Base64 WAV", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vico-mimo-test-"));
  context.after(() => fs.rm(directory, { recursive:true, force:true }));
  const file = path.join(directory, "voice.wav");
  const wav = createWav();
  await fs.writeFile(file, wav);

  let request = null;
  const service = new MiMoService({
    fetchImpl:async (url, options) => {
      request = { url, options, body:JSON.parse(options.body) };
      return {
        ok:true,
        status:200,
        json:async () => ({
          choices:[{ message:{ content:"你好，Vico。" } }],
          usage:{ prompt_tokens:18, completion_tokens:5, total_tokens:23 }
        })
      };
    }
  });

  const result = await service.transcribe(file, "mimo-test-key", { language:"zh" });
  assert.equal(request.url, "https://api.xiaomimimo.com/v1/chat/completions");
  assert.equal(request.options.headers.Authorization, "Bearer mimo-test-key");
  assert.equal(request.body.model, MIMO_MODEL_ID);
  assert.equal(request.body.stream, false);
  assert.equal(request.body.asr_options.language, "zh");
  assert.equal(request.body.messages[0].content[0].type, "input_audio");
  assert.equal(
    request.body.messages[0].content[0].input_audio.data,
    `data:audio/wav;base64,${wav.toString("base64")}`
  );
  assert.equal(result.text, "你好，Vico。");
  assert.equal(result.provider, "mimo");
  assert.equal(result.language, "zh");
  assert.equal(result.duration, 0.25);
});

test("小米 MiMo 语言配置只接受官方支持的 auto、zh 和 en", () => {
  assert.equal(normalizeLanguage("AUTO"), "auto");
  assert.equal(normalizeLanguage("zh"), "zh");
  assert.equal(normalizeLanguage("en"), "en");
  assert.equal(normalizeLanguage("cantonese"), "auto");
  assert.equal(readWavDuration(createWav({ seconds:0.5 })), 0.5);
});

test("Token Plan 使用中国区专属 Base URL 与 api-key 请求头", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vico-mimo-token-plan-"));
  context.after(() => fs.rm(directory, { recursive:true, force:true }));
  const file = path.join(directory, "voice.wav");
  await fs.writeFile(file, createWav());
  let request = null;
  const service = new MiMoService({
    fetchImpl:async (url, options) => {
      request = { url, options };
      return {
        ok:true,
        status:200,
        json:async () => ({ choices:[{ message:{ content:"Token Plan 正常。" } }] })
      };
    }
  });

  const result = await service.transcribe(file, "tp-test-key", { accessMode:"tokenPlanCn" });
  assert.equal(request.url, "https://token-plan-cn.xiaomimimo.com/v1/chat/completions");
  assert.equal(request.options.headers["api-key"], "tp-test-key");
  assert.equal(request.options.headers.Authorization, undefined);
  assert.equal(result.text, "Token Plan 正常。");
});

test("小米 MiMo API 错误不会泄露 API Key", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vico-mimo-error-"));
  context.after(() => fs.rm(directory, { recursive:true, force:true }));
  const file = path.join(directory, "voice.wav");
  await fs.writeFile(file, createWav());
  const service = new MiMoService({
    fetchImpl:async () => ({
      ok:false,
      status:401,
      json:async () => ({ error:{ code:"invalid_api_key", message:"API Key never-print-this-mimo-key 无效" } })
    })
  });

  await assert.rejects(
    service.transcribe(file, "never-print-this-mimo-key"),
    (error) => {
      assert.match(error.message, /invalid_api_key/);
      assert.doesNotMatch(error.message, /never-print-this-mimo-key/);
      return true;
    }
  );
});
