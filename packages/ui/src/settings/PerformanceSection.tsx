// 「性能」设置分区：流式渲染/长会话优化开关的集中页。
// 纯受控组件——所有值与 setter 经 props 注入（照 AppearanceSectionContent 模式），
// 不读 store、不碰 localStorage；每个开关默认关闭，开启才改变渲染策略。
import { Switch } from "@/components/ui/switch.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface PerformanceSectionContentProps {
  conversationWindowCollapseEnabled: boolean;
  setConversationWindowCollapseEnabled: (enabled: boolean) => void;
  streamingMarkdownIncrementalEnabled: boolean;
  setStreamingMarkdownIncrementalEnabled: (enabled: boolean) => void;
  stableRenderUnitsEnabled: boolean;
  setStableRenderUnitsEnabled: (enabled: boolean) => void;
  scopedPresentationClockEnabled: boolean;
  setScopedPresentationClockEnabled: (enabled: boolean) => void;
  coalescedBottomScrollEnabled: boolean;
  setCoalescedBottomScrollEnabled: (enabled: boolean) => void;
  coalescedDeltaFramesEnabled: boolean;
  setCoalescedDeltaFramesEnabled: (enabled: boolean) => void;
  idleParticlePauseEnabled: boolean;
  setIdleParticlePauseEnabled: (enabled: boolean) => void;
  boundedHighlightCacheEnabled: boolean;
  setBoundedHighlightCacheEnabled: (enabled: boolean) => void;
  idleTickScanReductionEnabled: boolean;
  setIdleTickScanReductionEnabled: (enabled: boolean) => void;
  dedupedIdlePollingEnabled: boolean;
  setDedupedIdlePollingEnabled: (enabled: boolean) => void;
}

export function PerformanceSectionContent({
  conversationWindowCollapseEnabled,
  setConversationWindowCollapseEnabled,
  streamingMarkdownIncrementalEnabled,
  setStreamingMarkdownIncrementalEnabled,
  stableRenderUnitsEnabled,
  setStableRenderUnitsEnabled,
  scopedPresentationClockEnabled,
  setScopedPresentationClockEnabled,
  coalescedBottomScrollEnabled,
  setCoalescedBottomScrollEnabled,
  coalescedDeltaFramesEnabled,
  setCoalescedDeltaFramesEnabled,
  idleParticlePauseEnabled,
  setIdleParticlePauseEnabled,
  boundedHighlightCacheEnabled,
  setBoundedHighlightCacheEnabled,
  idleTickScanReductionEnabled,
  setIdleTickScanReductionEnabled,
  dedupedIdlePollingEnabled,
  setDedupedIdlePollingEnabled,
}: PerformanceSectionContentProps) {
  const { intl } = useZCodeIntl();
  const text = (id: string) => intl.formatMessage({ id });

  return (
    <div className="min-w-0 space-y-3">
      <div>
        <h3 className="text-ui-lg font-semibold text-foreground">
          {text("settings.performanceTitle")}
        </h3>
        <p className="mt-1 text-ui-base leading-6 text-foreground-subtle">
          {text("settings.performance.description")}
        </p>
      </div>
      <div className="border border-border bg-card py-0 shadow-none">
        <SettingsRow
          label={text("settings.conversationWindowCollapse")}
          description={text("settings.conversationWindowCollapseDescription")}
          control={
            <Switch
              checked={conversationWindowCollapseEnabled}
              onCheckedChange={setConversationWindowCollapseEnabled}
            />
          }
        />
        <SettingsRow
          label={text("settings.performance.streamingMarkdownIncremental")}
          description={text("settings.performance.streamingMarkdownIncrementalDescription")}
          control={
            <Switch
              checked={streamingMarkdownIncrementalEnabled}
              onCheckedChange={setStreamingMarkdownIncrementalEnabled}
            />
          }
        />
        <SettingsRow
          label={text("settings.performance.stableRenderUnits")}
          description={text("settings.performance.stableRenderUnitsDescription")}
          control={
            <Switch
              checked={stableRenderUnitsEnabled}
              onCheckedChange={setStableRenderUnitsEnabled}
            />
          }
        />
        <SettingsRow
          label={text("settings.performance.scopedPresentationClock")}
          description={text("settings.performance.scopedPresentationClockDescription")}
          control={
            <Switch
              checked={scopedPresentationClockEnabled}
              onCheckedChange={setScopedPresentationClockEnabled}
            />
          }
        />
        <SettingsRow
          label={text("settings.performance.coalescedBottomScroll")}
          description={text("settings.performance.coalescedBottomScrollDescription")}
          control={
            <Switch
              checked={coalescedBottomScrollEnabled}
              onCheckedChange={setCoalescedBottomScrollEnabled}
            />
          }
        />
        <SettingsRow
          label={text("settings.performance.coalescedDeltaFrames")}
          description={text("settings.performance.coalescedDeltaFramesDescription")}
          control={
            <Switch
              checked={coalescedDeltaFramesEnabled}
              onCheckedChange={setCoalescedDeltaFramesEnabled}
            />
          }
        />
        <SettingsRow
          label={text("settings.performance.idleParticlePause")}
          description={text("settings.performance.idleParticlePauseDescription")}
          control={
            <Switch
              checked={idleParticlePauseEnabled}
              onCheckedChange={setIdleParticlePauseEnabled}
            />
          }
        />
        <SettingsRow
          label={text("settings.performance.boundedHighlightCache")}
          description={text("settings.performance.boundedHighlightCacheDescription")}
          control={
            <Switch
              checked={boundedHighlightCacheEnabled}
              onCheckedChange={setBoundedHighlightCacheEnabled}
            />
          }
        />
        <SettingsRow
          label={text("settings.performance.idleTickScanReduction")}
          description={text("settings.performance.idleTickScanReductionDescription")}
          control={
            <Switch
              checked={idleTickScanReductionEnabled}
              onCheckedChange={setIdleTickScanReductionEnabled}
            />
          }
        />
        <SettingsRow
          label={text("settings.performance.dedupedIdlePolling")}
          description={text("settings.performance.dedupedIdlePollingDescription")}
          control={
            <Switch
              checked={dedupedIdlePollingEnabled}
              onCheckedChange={setDedupedIdlePollingEnabled}
            />
          }
        />
      </div>
    </div>
  );
}
