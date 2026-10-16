const { DoubaoService, FORMAT_BY_EXTENSION:DOUBAO_FORMATS } = require("../doubao-service.cjs");
const {
  DashScopeService,
  DASHSCOPE_FORMATS,
  DASHSCOPE_REGION_ID
} = require("./providers/dashscope-provider.cjs");
const {
  MiMoService,
  MIMO_FORMATS
} = require("./providers/mimo-provider.cjs");

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
    },
    {
      id:"mimo",
      name:"小米 MiMo",
      model:"MiMo-V2.5-ASR",
      resource:"mimo-v2.5-asr",
      description:"支持中英文、粤语、吴语、闽南语和四川话等场景的语音识别",
      credentialLabel:"MiMo API Key",
      capabilities:[],
      defaultConfig:{ language:"auto", accessMode:"payg" },
      sanitizeConfig:(config = {}) => ({
        language:["auto", "zh", "en"].includes(config.language) ? config.language : "auto",
        accessMode:config.accessMode === "tokenPlanCn" ? "tokenPlanCn" : "payg"
      }),
      credentialStoreId:(config) => config.accessMode === "tokenPlanCn" ? "mimo-token-plan" : "mimo",
      isConfigured:() => true,
      formats:MIMO_FORMATS,
      service:new MiMoService({ fetchImpl })
    }
  ];
}

module.exports = { createProviderRegistry };
