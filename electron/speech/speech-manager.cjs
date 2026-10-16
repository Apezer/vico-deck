/**
 * 管理当前语音厂商、各厂商凭据和统一识别入口。
 * 录音来源无需知道具体厂商，只依赖这里返回的统一结果结构。
 */
class SpeechManager {
  constructor({ providers, credentialStores, settingsStore }) {
    this.providers = new Map((providers || []).map((provider) => [provider.id, provider]));
    this.credentialStores = credentialStores || {};
    this.settingsStore = settingsStore;
    this.activeService = null;
    this.progressListener = null;
    if (!this.providers.has("doubao")) throw new Error("缺少默认豆包语音厂商");
  }

  set onProgress(listener) {
    this.progressListener = typeof listener === "function" ? listener : null;
    for (const provider of this.providers.values()) {
      provider.service.onProgress = this.progressListener;
    }
  }

  getSettings() {
    const settings = this.settingsStore.get();
    if (!this.providers.has(settings.activeProvider)) settings.activeProvider = "doubao";
    return settings;
  }

  providerConfig(provider, settings = this.getSettings()) {
    return provider.sanitizeConfig({
      ...provider.defaultConfig,
      ...(settings.providers?.[provider.id] || {})
    });
  }

  providerSnapshot(provider, settings = this.getSettings()) {
    const credential = this.credentialStores[provider.id]?.info() || { configured:false, masked:"" };
    const config = this.providerConfig(provider, settings);
    return {
      id:provider.id,
      name:provider.name,
      model:provider.model,
      resource:provider.resource,
      regionId:provider.regionId || "",
      description:provider.description,
      credentialLabel:provider.credentialLabel,
      capabilities:[...provider.capabilities],
      config,
      configured:Boolean(credential.configured && provider.isConfigured(config)),
      credentialSaved:Boolean(credential.configured),
      masked:credential.masked
    };
  }

  snapshot() {
    const settings = this.getSettings();
    const providers = [...this.providers.values()].map((provider) => this.providerSnapshot(provider, settings));
    const active = providers.find((provider) => provider.id === settings.activeProvider) || providers[0];
    return {
      provider:active.id,
      providerName:active.name,
      model:active.model,
      resource:active.resource,
      regionId:active.regionId,
      configured:active.configured,
      credentialSaved:active.credentialSaved,
      masked:active.masked,
      config:active.config,
      capabilities:active.capabilities,
      providers
    };
  }

  setActiveProvider(providerId) {
    if (this.activeService) throw new Error("请等待当前语音识别完成后再切换服务商");
    if (!this.providers.has(providerId)) throw new Error("不支持的语音识别服务商");
    const settings = this.getSettings();
    settings.activeProvider = providerId;
    this.settingsStore.save(settings);
    return this.snapshot();
  }

  saveProvider(providerId, { credential, config } = {}) {
    if (this.activeService) throw new Error("请等待当前语音识别完成后再修改服务商设置");
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error("不支持的语音识别服务商");

    const settings = this.getSettings();
    const sanitized = provider.sanitizeConfig({
      ...provider.defaultConfig,
      ...(settings.providers?.[providerId] || {}),
      ...(config || {})
    });
    settings.providers[providerId] = sanitized;
    this.settingsStore.save(settings);
    if (String(credential || "").trim()) this.credentialStores[providerId].save(credential);
    return this.snapshot();
  }

  clearCredential(providerId) {
    if (this.activeService) throw new Error("请等待当前语音识别完成后再删除密钥");
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error("不支持的语音识别服务商");
    this.credentialStores[providerId].clear();
    return this.snapshot();
  }

  async transcribe(audioPath, options = {}) {
    if (this.activeService) throw new Error("已有识别任务正在运行");
    const settings = this.getSettings();
    const provider = this.providers.get(settings.activeProvider) || this.providers.get("doubao");
    const config = this.providerConfig(provider, settings);
    const credential = this.credentialStores[provider.id]?.get() || "";
    if (!credential) throw new Error(`请先在语音输入页面保存${provider.credentialLabel}`);
    if (!provider.isConfigured(config)) throw new Error(`请先完成${provider.name}的服务配置`);

    this.activeService = provider.service;
    try {
      return await provider.service.transcribe(audioPath, credential, { ...options, ...config });
    } finally {
      this.activeService = null;
    }
  }

  cancel() {
    return this.activeService?.cancel() || false;
  }

  supportedExtensions() {
    const extensions = new Set();
    const settings = this.getSettings();
    const provider = this.providers.get(settings.activeProvider) || this.providers.get("doubao");
    for (const extension of provider.formats.keys()) extensions.add(extension.slice(1));
    return [...extensions].sort();
  }
}

module.exports = { SpeechManager };
