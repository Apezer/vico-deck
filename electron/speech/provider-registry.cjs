const { DoubaoService, FORMAT_BY_EXTENSION:DOUBAO_FORMATS } = require("../doubao-service.cjs");
const {
  DashScopeService,
  DASHSCOPE_FORMATS,
  DASHSCOPE_REGION_ID
} = require("./providers/dashscope-provider.cjs");

/** 创建内置语音厂商列表；厂商差异被限制在各自适配器和元数据中。 */
function createProviderRegistry({ fetchImpl = globalThis.fetch } = {}) {
  return [
    {
      id:"doubao",
      name:"豆包",
      model:"Doubao Seed-ASR 2.0",
      resource:"volc.seedasr.auc",
      description:"适合国内网络环境的豆包大模型语音识别",
      credentialLabel:"豆包 API Key",
      capabilities:["enableDdc", "enablePunc", "enableItn"],
      defaultConfig:{},
      sanitizeConfig:() => ({}),
      isConfigured:() => true,
      formats:DOUBAO_FORMATS,
      service:new DoubaoService({ fetchImpl })
    },
    {
      id:"dashscope",
      name:"阿里云百炼 DashScope",
      model:"Qwen Audio 3.1 ASR Flash Message",
      resource:"qwen-audio-3.1-asr-flash-message",
      regionId:DASHSCOPE_REGION_ID,
      description:"面向语音输入法与短语音消息优化，只需配置北京地域的百炼 API Key",
      credentialLabel:"百炼 API Key",
      capabilities:["enableDdc"],
      defaultConfig:{},
      sanitizeConfig:() => ({}),
      isConfigured:() => true,
      formats:DASHSCOPE_FORMATS,
      service:new DashScopeService()
    }
  ];
}

module.exports = { createProviderRegistry };
