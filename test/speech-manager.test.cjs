const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { CredentialStore } = require("../electron/credential-store.cjs");
const { SpeechManager } = require("../electron/speech/speech-manager.cjs");
const { SpeechSettingsStore } = require("../electron/speech/speech-settings-store.cjs");

function safeStorage() {
  return {
    isEncryptionAvailable:() => true,
    encryptString:(value) => Buffer.from(value, "utf8").reverse(),
    decryptString:(value) => Buffer.from(value).reverse().toString("utf8")
  };
}

function provider(id, calls) {
  return {
    id,
    name:id === "doubao" ? "豆包" : "阿里云百炼 DashScope",
    model:`${id}-model`,
    resource:`${id}-resource`,
    description:`${id}-description`,
    credentialLabel:`${id} API Key`,
    capabilities:id === "doubao" ? ["enablePunc"] : ["enableDdc"],
    defaultConfig:{},
    sanitizeConfig:() => ({}),
    isConfigured:() => true,
    formats:new Map([[".wav", "wav"]]),
    service:{
      onProgress:null,
      transcribe:async (audioPath, key, options) => {
        calls.push({ id, audioPath, key, options });
        return { text:id, provider:id };
      },
      cancel:() => false
    }
  };
}

test("厂商切换后使用隔离凭据并路由到对应适配器", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vico-speech-manager-"));
  context.after(() => fs.rm(directory, { recursive:true, force:true }));
  const calls = [];
  const storage = safeStorage();
  const manager = new SpeechManager({
    providers:[provider("doubao", calls), provider("dashscope", calls)],
    credentialStores:{
      doubao:new CredentialStore(path.join(directory, "doubao.bin"), storage),
      dashscope:new CredentialStore(path.join(directory, "dashscope.bin"), storage)
    },
    settingsStore:new SpeechSettingsStore(path.join(directory, "settings.json"))
  });

  manager.saveProvider("doubao", { credential:"doubao-secret" });
  manager.saveProvider("dashscope", { credential:"dashscope-api-key" });
  manager.setActiveProvider("dashscope");
  const snapshot = manager.snapshot();
  assert.equal(snapshot.provider, "dashscope");
  assert.equal(snapshot.configured, true);
  assert.equal(snapshot.providers.find((item) => item.id === "doubao").configured, true);

  const result = await manager.transcribe("voice.wav", { enableDdc:true });
  assert.equal(result.provider, "dashscope");
  assert.equal(calls[0].key, "dashscope-api-key");
  assert.equal(calls[0].options.enableDdc, true);
});

test("旧版 ISI 服务商选择会迁移到 DashScope 且不迁移旧凭据配置", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vico-speech-migration-"));
  context.after(() => fs.rm(directory, { recursive:true, force:true }));
  const settingsPath = path.join(directory, "settings.json");
  await fs.writeFile(settingsPath, JSON.stringify({
    activeProvider:"aliyun-isi",
    providers:{ "aliyun-isi":{ appKey:"legacy-app-key" } }
  }));
  const settings = new SpeechSettingsStore(settingsPath).get();
  assert.equal(settings.activeProvider, "dashscope");
  assert.deepEqual(settings.providers, {
    doubao:{},
    dashscope:{},
    mimo:{ language:"auto", accessMode:"payg" }
  });
});

test("MiMo 按量 API 与 Token Plan 凭据相互隔离", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vico-mimo-credentials-"));
  context.after(() => fs.rm(directory, { recursive:true, force:true }));
  const calls = [];
  const storage = safeStorage();
  const mimoProvider = {
    id:"mimo",
    name:"小米 MiMo",
    model:"mimo-v2.5-asr",
    resource:"mimo-v2.5-asr",
    description:"test",
    credentialLabel:"MiMo API Key",
    capabilities:[],
    defaultConfig:{ language:"auto", accessMode:"payg" },
    sanitizeConfig:(config) => ({
      language:config.language || "auto",
      accessMode:config.accessMode === "tokenPlanCn" ? "tokenPlanCn" : "payg"
    }),
    credentialStoreId:(config) => config.accessMode === "tokenPlanCn" ? "mimo-token-plan" : "mimo",
    isConfigured:() => true,
    formats:new Map([[".wav", "wav"]]),
    service:{
      transcribe:async (_audioPath, key, options) => {
        calls.push({ key, accessMode:options.accessMode });
        return { text:"ok", provider:"mimo" };
      },
      cancel:() => false
    }
  };
  const manager = new SpeechManager({
    providers:[provider("doubao", calls), mimoProvider],
    credentialStores:{
      doubao:new CredentialStore(path.join(directory, "doubao.bin"), storage),
      mimo:new CredentialStore(path.join(directory, "mimo.bin"), storage),
      "mimo-token-plan":new CredentialStore(path.join(directory, "mimo-token-plan.bin"), storage)
    },
    settingsStore:new SpeechSettingsStore(path.join(directory, "settings.json"))
  });

  manager.saveProvider("mimo", { credential:"sk-payg", config:{ accessMode:"payg" } });
  manager.saveProvider("mimo", { credential:"tp-plan", config:{ accessMode:"tokenPlanCn" } });
  manager.setActiveProvider("mimo");
  await manager.transcribe("voice.wav");
  manager.saveProvider("mimo", { config:{ accessMode:"payg" } });
  await manager.transcribe("voice.wav");

  assert.deepEqual(calls, [
    { key:"tp-plan", accessMode:"tokenPlanCn" },
    { key:"sk-payg", accessMode:"payg" }
  ]);
});
