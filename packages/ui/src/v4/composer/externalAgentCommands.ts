import type { CommandPayloadMap } from "@zcode/shared/zcode-protocol-v4";

/** 绑定命令的净荷；与协议 schema 同源，UI 不再重复声明一份形状。 */
export type BindExternalAgentPayload = CommandPayloadMap["bindExternalAgent"];

/** 表单里可选的驱动族：决定外部 CLI 的参数形状。 */
export const EXTERNAL_AGENT_DRIVER_OPTIONS = [
  {
    value: "claude-family" as const,
    // codebuddy / claude 等同构：-p 非交互 + --output-format json。
    label: "claude-family",
  },
  { value: "generic-template" as const, label: "generic-template" },
] as const;
