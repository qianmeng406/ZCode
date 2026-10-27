import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type IMemoryService, type ProjectMemoryWorkspaceSummary } from "@zcode/services";
import {
  TID_SETTINGS_MEMORY_EDIT_HINT,
  TID_SETTINGS_MEMORY_EDIT_HINT_ACTION,
  TID_SETTINGS_MEMORY_SWITCH,
} from "@zcode/shared/test-ids";
import { runUserAction, runUserActionAsync } from "@/lib/userActionTelemetry.js";
import { setPendingSettingsSection } from "@/lib/settingsNavigation.js";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  MemorySettingsViewer,
  type MemoryViewerLoadingState,
} from "@/settings/MemorySettingsViewer.js";
import type { MemoryFileEditingService } from "@/settings/MemoryFileEditor.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

type MemoryCatalogService = Pick<IMemoryService, "listProjectMemories">;
type MemorySectionService = MemoryCatalogService & Partial<MemoryFileEditingService>;

function normalizeWorkspaceDisplayName(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "project";
}

function buildWorkspaceDisplayNameMap(names: readonly string[]): ReadonlyMap<string, string> {
  const matches = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const candidate of names) {
    const displayName = candidate.trim();
    const slug = normalizeWorkspaceDisplayName(displayName);
    if (!displayName || !slug || ambiguous.has(slug)) continue;
    const existing = matches.get(slug);
    if (existing && existing !== displayName) {
      matches.delete(slug);
      ambiguous.add(slug);
      continue;
    }
    matches.set(slug, displayName);
  }
  return matches;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function MemorySettingsSection({
  memoryEnabled,
  memoryService,
  memoryFileEditingEnabled = false,
  onMemoryEnabledChange,
  projectMemoryViewerAvailable,
  workspaceDisplayNames = [],
}: {
  memoryEnabled: boolean;
  memoryService: MemorySectionService;
  /** fork 开关：关闭时不渲染任何写入口，记忆页保持只读。 */
  memoryFileEditingEnabled?: boolean;
  onMemoryEnabledChange: (enabled: boolean) => Promise<void>;
  projectMemoryViewerAvailable: boolean;
  workspaceDisplayNames?: readonly string[];
}) {
  const { intl } = useZCodeIntl();
  const catalogRequestIdRef = useRef(0);
  const [catalogState, setCatalogState] = useState<MemoryViewerLoadingState>("idle");
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<ProjectMemoryWorkspaceSummary[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);

  const refreshCatalog = useCallback(async (): Promise<ProjectMemoryWorkspaceSummary[] | null> => {
    const requestId = catalogRequestIdRef.current + 1;
    catalogRequestIdRef.current = requestId;
    setCatalogState("loading");
    setCatalogError(null);
    try {
      const result = await memoryService.listProjectMemories();
      if (catalogRequestIdRef.current !== requestId) {
        return null;
      }
      setWorkspaces(result);
      setCatalogState("ready");
      return result;
    } catch (error) {
      if (catalogRequestIdRef.current !== requestId) {
        return null;
      }
      setWorkspaces([]);
      setSelectedWorkspaceId(null);
      setCatalogError(getErrorMessage(error));
      setCatalogState("error");
      return null;
    }
  }, [memoryService]);

  useEffect(() => {
    if (memoryEnabled && projectMemoryViewerAvailable) {
      void refreshCatalog();
      return;
    }

    catalogRequestIdRef.current += 1;
    setCatalogState("idle");
    setCatalogError(null);
    setWorkspaces([]);
    setSelectedWorkspaceId(null);
  }, [memoryEnabled, projectMemoryViewerAvailable, refreshCatalog]);

  const displayWorkspaces = useMemo(() => {
    const displayNameBySlug = buildWorkspaceDisplayNameMap(workspaceDisplayNames);
    const orderBySlug = new Map<string, number>();
    for (const [index, name] of workspaceDisplayNames.entries()) {
      const slug = normalizeWorkspaceDisplayName(name);
      if (!orderBySlug.has(slug)) orderBySlug.set(slug, index);
    }
    return workspaces
      .map((workspace, catalogIndex) => {
        const slug = normalizeWorkspaceDisplayName(workspace.label);
        return {
          catalogIndex,
          order: orderBySlug.get(slug) ?? Number.POSITIVE_INFINITY,
          workspace: {
            ...workspace,
            label: displayNameBySlug.get(slug) ?? workspace.label,
          },
        };
      })
      .sort((left, right) => left.order - right.order || left.catalogIndex - right.catalogIndex)
      .map(({ workspace }) => workspace);
  }, [workspaceDisplayNames, workspaces]);
  const selectedWorkspace = useMemo(
    () => displayWorkspaces.find((workspace) => workspace.id === selectedWorkspaceId),
    [displayWorkspaces, selectedWorkspaceId],
  );

  useEffect(() => {
    const firstWorkspace = displayWorkspaces[0];
    if (!firstWorkspace) {
      setSelectedWorkspaceId(null);
      return;
    }
    if (
      !selectedWorkspaceId ||
      !displayWorkspaces.some((workspace) => workspace.id === selectedWorkspaceId)
    ) {
      setSelectedWorkspaceId(firstWorkspace.id);
    }
  }, [displayWorkspaces, selectedWorkspaceId]);

  // 宿主版本不一定提供写方法：三个都在、且开关打开时才交出编辑服务，
  // 否则列表行干脆不渲染编辑入口，而不是渲染一个点了会崩的按钮。
  const memoryEditingService = useMemo<MemoryFileEditingService | undefined>(() => {
    if (!memoryFileEditingEnabled) return undefined;
    const { readProjectMemoryFile, writeProjectMemoryFile, deleteProjectMemoryFile } =
      memoryService;
    if (!readProjectMemoryFile || !writeProjectMemoryFile || !deleteProjectMemoryFile) {
      return undefined;
    }
    return { readProjectMemoryFile, writeProjectMemoryFile, deleteProjectMemoryFile };
  }, [memoryFileEditingEnabled, memoryService]);

  const handleRefresh = useCallback(async () => {
    await runUserActionAsync({
      input: { featureId: "settings.memory", action: "refresh_memory", trigger: "button" },
      operation: refreshCatalog,
      completed: { resultSource: "platform_result" },
      failureStage: "catalog_refresh",
    });
  }, [refreshCatalog]);

  return (
    <div className="space-y-6">
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({
            id: "settings.memory.workspaceMemory",
          })}
          description={intl.formatMessage({
            id: "settings.memoryDescription",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({
                id: "settings.memory.workspaceMemory",
              })}
              checked={memoryEnabled}
              data-testid={TID_SETTINGS_MEMORY_SWITCH}
              onCheckedChange={(checked) => {
                void onMemoryEnabledChange(checked);
              }}
            />
          }
        />
      </SettingsGroupCard>

      {/* 编辑入口只在「定制功能 › 记忆文件编辑」打开后才出现；不点明这一层，
          用户会在这个页面反复找不存在的铅笔按钮。 */}
      {projectMemoryViewerAvailable && memoryEnabled && !memoryEditingService ? (
        <div
          data-testid={TID_SETTINGS_MEMORY_EDIT_HINT}
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-border bg-transparent px-4 py-3"
        >
          <p className="min-w-0 text-ui-sm leading-5 text-foreground-subtle">
            {intl.formatMessage({
              id: memoryFileEditingEnabled
                ? "settings.memory.editor.unsupportedHint"
                : "settings.memory.editor.disabledHint",
            })}
          </p>
          {memoryFileEditingEnabled ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid={TID_SETTINGS_MEMORY_EDIT_HINT_ACTION}
              onClick={() => {
                setPendingSettingsSection("forkFeatures");
              }}
            >
              {intl.formatMessage({ id: "settings.memory.editor.disabledAction" })}
            </Button>
          )}
        </div>
      ) : null}
      {!projectMemoryViewerAvailable ? (
        <div className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.memory.viewer.localOnly" })}
        </div>
      ) : !memoryEnabled ? null : (
        <MemorySettingsViewer
          catalogError={catalogError}
          catalogState={catalogState}
          selectedWorkspace={selectedWorkspace}
          workspaces={displayWorkspaces}
          onRefresh={handleRefresh}
          memoryService={memoryEditingService}
          onScopeKeyChange={(workspaceId) =>
            runUserAction({
              input: {
                featureId: "settings.memory",
                action: "change_memory_scope",
                trigger: "select",
              },
              operation: () => setSelectedWorkspaceId(workspaceId),
              completed: { resultSource: "local_commit" },
              failureStage: "local_commit",
            })
          }
        />
      )}
    </div>
  );
}
