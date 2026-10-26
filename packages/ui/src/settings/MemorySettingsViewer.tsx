import { Fragment, useEffect, useMemo, useState } from "react";
import type { ProjectMemoryWorkspaceSummary } from "@zcode/services";
import {
  TID_SETTINGS_MEMORY_COUNT,
  TID_SETTINGS_MEMORY_FILE,
  TID_SETTINGS_MEMORY_FILE_EDIT,
  TID_SETTINGS_MEMORY_FILE_EDITOR_ACTIONS,
  TID_SETTINGS_MEMORY_FILE_ICON,
  TID_SETTINGS_MEMORY_FILE_NAME,
  TID_SETTINGS_MEMORY_FILE_UPDATED_AT,
  TID_SETTINGS_MEMORY_REFRESH,
  TID_SETTINGS_MEMORY_SCOPE_ICON,
  TID_SETTINGS_MEMORY_SCOPE_TRIGGER,
  TID_SETTINGS_MEMORY_SEARCH_CLEAR,
  TID_SETTINGS_MEMORY_SEARCH_INPUT,
  TID_SETTINGS_MEMORY_WORKSPACE,
  testId,
} from "@zcode/shared/test-ids";
import { Pencil } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { MemoryFileEditor, type MemoryFileEditingService } from "@/settings/MemoryFileEditor.js";
import { PluginScopeMenu } from "@/settings/PluginScopeMenu.js";
import { PluginSearchEmptyState } from "@/settings/PluginInstallEmptyState.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import { formatMemoryUpdatedAt } from "@/settings/memoryUpdatedAt.js";
import { WorkspaceEditorButtonGroup } from "@/WorkspaceEditorButtonGroup.js";

export type MemoryViewerLoadingState = "idle" | "loading" | "ready" | "error";

export function MemorySettingsViewer({
  catalogError,
  catalogState,
  selectedWorkspace,
  workspaces,
  onRefresh,
  onScopeKeyChange,
  memoryService,
}: {
  catalogError: string | null;
  catalogState: MemoryViewerLoadingState;
  selectedWorkspace: ProjectMemoryWorkspaceSummary | undefined;
  workspaces: ProjectMemoryWorkspaceSummary[];
  onRefresh: () => Promise<void>;
  onScopeKeyChange: (workspaceId: string) => void;
  /** 仅在「记忆文件编辑」开关打开时传入；缺省时列表行没有编辑入口。 */
  memoryService?: MemoryFileEditingService;
}) {
  const { intl, locale } = useZCodeIntl();
  const [searchQuery, setSearchQuery] = useState("");
  const [editingFileName, setEditingFileName] = useState<string | null>(null);
  const selectedWorkspaceId = selectedWorkspace?.id;
  useEffect(() => {
    // 切工作区/目录刷新后旧文件名可能已不存在，编辑器随之收口。
    setEditingFileName(null);
  }, [selectedWorkspaceId]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);
  const formatMemoryCount = (count: number) =>
    intl.formatMessage(
      {
        id: `settings.memory.viewer.memoryCount.${count === 1 ? "one" : "other"}`,
      },
      { count },
    );
  const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase();
  const visibleFiles = useMemo(
    () =>
      selectedWorkspace?.files.filter((file) =>
        file.name.toLocaleLowerCase().includes(normalizedSearchQuery),
      ) ?? [],
    [normalizedSearchQuery, selectedWorkspace],
  );

  if (catalogError) {
    return (
      <Alert>
        <AlertDescription>{catalogError}</AlertDescription>
      </Alert>
    );
  }

  if (catalogState === "loading" && workspaces.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.memory.viewer.loading" })}
      </div>
    );
  }

  if (!selectedWorkspace) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.memory.viewer.empty" })}
      </div>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <PluginScopeMenu
            includeUser={false}
            selectedScopeKey={selectedWorkspace.id}
            workspaceOptions={workspaces.map((workspace) => ({
              key: workspace.id,
              label: workspace.label,
            }))}
            onScopeKeyChange={onScopeKeyChange}
            triggerIconTestId={TID_SETTINGS_MEMORY_SCOPE_ICON}
            triggerTestId={TID_SETTINGS_MEMORY_SCOPE_TRIGGER}
            workspaceOptionTestIdPrefix={TID_SETTINGS_MEMORY_WORKSPACE}
          />
          <div className="h-4 w-px bg-border" aria-hidden="true" />
          <span
            data-testid={TID_SETTINGS_MEMORY_COUNT}
            className="shrink-0 text-ui-sm text-foreground-subtle"
          >
            {formatMemoryCount(selectedWorkspace.files.length)}
          </span>
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
          <SettingsSearchInput
            containerClassName="w-full sm:w-64"
            clearLabel={intl.formatMessage({ id: "settings.search.clear" })}
            clearTestId={TID_SETTINGS_MEMORY_SEARCH_CLEAR}
            data-testid={TID_SETTINGS_MEMORY_SEARCH_INPUT}
            value={searchQuery}
            onClear={() => setSearchQuery("")}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={intl.formatMessage({
              id: "settings.memory.viewer.searchPlaceholder",
            })}
          />
        </div>
      </div>

      {editingFileName !== null && memoryService ? (
        <MemoryFileEditor
          workspaceId={selectedWorkspace.id}
          fileName={editingFileName}
          memoryService={memoryService}
          onCancel={() => setEditingFileName(null)}
          onSaved={() => onRefresh()}
          onDeleted={async () => {
            setEditingFileName(null);
            await onRefresh();
          }}
        />
      ) : normalizedSearchQuery && visibleFiles.length === 0 ? (
        <PluginSearchEmptyState
          label={intl.formatMessage({
            id: "settings.memory.viewer.searchEmpty",
          })}
        />
      ) : (
        <>
          <div className="flex min-h-7 flex-wrap items-center justify-between gap-3">
            <h3 className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "settings.memory.viewer.files" })}
            </h3>
            <SettingsResourceHeaderActions
              onRefresh={() => void onRefresh()}
              refreshing={catalogState === "loading"}
              refreshTestId={TID_SETTINGS_MEMORY_REFRESH}
              refreshLabel={intl.formatMessage({
                id: "settings.memory.viewer.refresh",
              })}
            />
          </div>
          <div className="overflow-hidden rounded-xl bg-surface">
            {visibleFiles.map((file, index) => (
              <Fragment key={file.name}>
                {index > 0 ? <div className="h-px bg-border/50" aria-hidden="true" /> : null}
                <div className="flex min-w-0 items-center hover:bg-hover">
                  <div
                    data-testid={testId(TID_SETTINGS_MEMORY_FILE, file.name)}
                    className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left"
                  >
                    <span
                      data-testid={testId(TID_SETTINGS_MEMORY_FILE_ICON, file.name)}
                      className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-background"
                    >
                      <FileDisplayIcon
                        src={resolveFileDisplayDescriptor(file.path).fileIconSrc}
                        size={16}
                        className="size-4 shrink-0"
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        data-testid={testId(TID_SETTINGS_MEMORY_FILE_NAME, file.name)}
                        className="block truncate text-ui-base font-medium text-foreground"
                      >
                        {file.name}
                      </span>
                      <span
                        data-testid={testId(TID_SETTINGS_MEMORY_FILE_UPDATED_AT, file.name)}
                        className="mt-0.5 block truncate text-ui-sm text-foreground-subtle"
                      >
                        {formatMemoryUpdatedAt({
                          formatMessage: intl.formatMessage,
                          locale,
                          now,
                          updatedAt: file.updatedAt,
                        })}
                      </span>
                    </span>
                  </div>
                  <span
                    data-testid={testId(TID_SETTINGS_MEMORY_FILE_EDITOR_ACTIONS, file.name)}
                    className="mr-3 flex shrink-0 items-center gap-1"
                  >
                    {memoryService ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        data-testid={testId(TID_SETTINGS_MEMORY_FILE_EDIT, file.name)}
                        aria-label={intl.formatMessage({ id: "settings.memory.editor.edit" })}
                        onClick={() => setEditingFileName(file.name)}
                      >
                        <Pencil className="size-3.5" aria-hidden="true" />
                      </Button>
                    ) : null}
                    <WorkspaceEditorButtonGroup workspaceAbsPath={file.path} />
                  </span>
                </div>
              </Fragment>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
