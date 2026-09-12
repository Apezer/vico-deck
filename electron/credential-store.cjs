const fs = require("node:fs");
const path = require("node:path");

/** 使用 Electron safeStorage（Windows 下为 DPAPI）保存云端 API Key。 */
class CredentialStore {
  constructor(filePath, safeStorage) {
    this.filePath = filePath;
    this.safeStorage = safeStorage;
  }

  get() {
    try {
      return this.safeStorage.decryptString(fs.readFileSync(this.filePath));
    } catch {
      return "";
    }
  }

  save(value) {
    const key = String(value || "").trim();
    if (!key || key.length > 512) throw new Error("API Key 格式无效");
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error("Windows 安全存储暂不可用");
    fs.mkdirSync(path.dirname(this.filePath), { recursive:true });
    fs.writeFileSync(this.filePath, this.safeStorage.encryptString(key));
    return { configured:true, masked:`${key.slice(0, 4)}••••${key.slice(-4)}` };
  }

  info() {
    const key = this.get();
    return key
      ? { configured:true, masked:`${key.slice(0, 4)}••••${key.slice(-4)}` }
      : { configured:false, masked:"" };
  }

  clear() {
    try {
      fs.unlinkSync(this.filePath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return { configured:false, masked:"" };
  }
}

module.exports = { CredentialStore };
