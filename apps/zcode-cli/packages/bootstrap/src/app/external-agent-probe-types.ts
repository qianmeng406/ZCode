// App 层暴露给协议面的探测结果形状。
//
// 直接复用 bootstrap 内部探测的返回类型会形成循环（app/types ← 探测实现 → 探测实现
// 又 import 执行端口）。这里只做类型再导出，形状的唯一权威仍在
// ../zcode-protocol/external-agent-probe.ts。
export type {
  ExternalAgentPresetStatus as AppExternalAgentProbeAgent,
  ExternalAgentProbeResult as AppExternalAgentProbeResult,
} from "../zcode-protocol/external-agent-probe.js";
