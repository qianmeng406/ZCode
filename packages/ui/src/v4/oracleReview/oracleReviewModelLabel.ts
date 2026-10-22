import { formatProviderModelLabel } from "../composer/modelTriggerDisplay.js";

/**
 * Oracle 审查卡片上的模型名。
 *
 * 审查记录保存的是规范串 `providerId/modelId`（给机器回填用）。自定义/团队连接的
 * providerId 往往是 UUID，直接上屏就是一串十六进制；这里按当前 provider 目录换成
 * 可读名字，拼名规则与 composer/子代理标签共用 `formatProviderModelLabel`
 * （内置家族只显示模型名，自定义 provider 显示「名字/模型」）。
 * 查不到 provider（连接已删除）时只去掉 UUID 段，绝不把纯 ID 摆到屏幕上；
 * 规范原文由调用方放进 tooltip。
 */
export interface OracleModelLabelProvider {
  providerId: string;
  providerName?: string | null | undefined;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function formatOracleModelLabel(
  label: string | undefined,
  providers: readonly OracleModelLabelProvider[],
): string | undefined {
  const canonical = label?.trim();
  if (!canonical) return undefined;

  // providerId 本身可能含 "/"（复合连接 id）：取最长前缀，避免把模型名切错。
  const provider = providers
    .filter((candidate) => candidate.providerId.length > 0)
    .reduce<OracleModelLabelProvider | undefined>((best, candidate) => {
      if (!canonical.startsWith(`${candidate.providerId}/`)) return best;
      return best === undefined || candidate.providerId.length > best.providerId.length
        ? candidate
        : best;
    }, undefined);

  if (provider) {
    const rawName = provider.providerName?.trim();
    // 目录回退会把 providerId 当名字填进来，那种「名字」正是要挡掉的东西。
    const providerName = rawName && rawName !== provider.providerId ? rawName : undefined;
    const modelId = canonical.slice(provider.providerId.length + 1);
    return formatProviderModelLabel(provider.providerId, providerName, modelId);
  }

  const separatorIndex = canonical.indexOf("/");
  if (separatorIndex > 0 && UUID_PATTERN.test(canonical.slice(0, separatorIndex))) {
    return canonical.slice(separatorIndex + 1);
  }
  return canonical;
}
