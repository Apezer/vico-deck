const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_SETTINGS = Object.freeze({
  activeProvider:"doubao",
  providers:{
    doubao:{},
    dashscope:{}
  }
});

/**
 * 保存非敏感的语音识别设置。
 * API Key 不会写入此文件，而是由 CredentialStore 通过 Electron safeStorage 单独加密。
 */
class SpeechSettingsStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  get() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return this.normalize(saved);
    } catch {
      return this.normalize(DEFAULT_SETTINGS);
    }
  }

  save(value) {
    const normalized = this.normalize(value);
    fs.mkdirSync(path.dirname(this.filePath), { recursive:true });
    fs.writeFileSync(this.filePath, JSON.stringify(normalized, null, 2), "utf8");
    return normalized;
  }

  normalize(value = {}) {
    // 旧版 ISI 配置不能复用为百炼 API Key，只迁移服务商选择，不迁移敏感凭据。
    const activeProvider = value.activeProvider === "aliyun-isi"
      ? "dashscope"
      : String(value.activeProvider || DEFAULT_SETTINGS.activeProvider);
    return {
      activeProvider,
      providers:{
        doubao:{ ...(value.providers?.doubao || {}) },
        dashscope:{ ...(value.providers?.dashscope || {}) }
      }
    };
  }
}

module.exports = { SpeechSettingsStore, DEFAULT_SETTINGS };
