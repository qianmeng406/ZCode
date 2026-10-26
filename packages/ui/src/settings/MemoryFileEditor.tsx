import { useCallback, useEffect, useState } from "react";
import {
  FORK_FEATURE_DISABLED_ERROR_CODE,
  PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE,
  PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED_ERROR_CODE,
  type IMemoryService,
} from "@zcode/services";
import {
  TID_SETTINGS_MEMORY_EDITOR,
  TID_SETTINGS_MEMORY_EDITOR_CANCEL,
  TID_SETTINGS_MEMORY_EDITOR_DELETE,
  TID_SETTINGS_MEMORY_EDITOR_DELETE_CONFIRM,
  TID_SETTINGS_MEMORY_EDITOR_ERROR,
  TID_SETTINGS_MEMORY_EDITOR_RELOAD,
  TID_SETTINGS_MEMORY_EDITOR_SAVE,
  TID_SETTINGS_MEMORY_EDITOR_TEXTAREA,
} from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsFormActions } from "@/settings/SettingsFormActions.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";

export type MemoryFileEditingService = Pick<
  IMemoryService,
  "readProjectMemoryFile" | "writeProjectMemoryFile" | "deleteProjectMemoryFile"
>;

type EditorStatus = "loading" | "ready" | "error";

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Project Memory 文件编辑器（fork 开关「记忆文件编辑」打开时才有入口）。
 *
 * 保存与删除都带 CAS：打开面板时记下 updatedAt，写入时服务端比对，不一致就提示
 * 「文件已被改动」并给重新加载，避免覆盖 Memory Agent 刚写下的内容。
 */
export function MemoryFileEditor({
  workspaceId,
  fileName,
  memoryService,
  onCancel,
  onSaved,
  onDeleted,
}: {
  workspaceId: string;
  fileName: string;
  memoryService: MemoryFileEditingService;
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
  onDeleted: () => void | Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const [status, setStatus] = useState<EditorStatus>("loading");
  const [loadedContent, setLoadedContent] = useState("");
  const [loadedUpdatedAt, setLoadedUpdatedAt] = useState<number | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const result = await memoryService.readProjectMemoryFile({ workspaceId, fileName });
      setLoadedContent(result.content);
      setDraft(result.content);
      setLoadedUpdatedAt(result.updatedAt);
      setStatus("ready");
    } catch (loadError) {
      setError(errorMessageOf(loadError));
      setStatus("error");
    }
  }, [fileName, memoryService, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const describeError = (saveError: unknown): string => {
    const code = errorCodeOf(saveError);
    if (code === PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE) {
      return intl.formatMessage({ id: "settings.memory.viewer.fileChanged" });
    }
    if (code === PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED_ERROR_CODE) {
      return intl.formatMessage({ id: "settings.memory.viewer.fileTooLarge" });
    }
    if (code === FORK_FEATURE_DISABLED_ERROR_CODE) {
      return intl.formatMessage({ id: "settings.memory.editor.error.disabled" });
    }
    return errorMessageOf(saveError);
  };

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const result = await memoryService.writeProjectMemoryFile({
        workspaceId,
        fileName,
        content: draft,
        ...(loadedUpdatedAt === undefined ? {} : { expectedUpdatedAt: loadedUpdatedAt }),
      });
      setLoadedUpdatedAt(result.updatedAt);
      setLoadedContent(draft);
      await onSaved();
    } catch (saveError) {
      setError(describeError(saveError));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    setDeleting(true);
    setError(null);
    try {
      await memoryService.deleteProjectMemoryFile({
        workspaceId,
        fileName,
        ...(loadedUpdatedAt === undefined ? {} : { expectedUpdatedAt: loadedUpdatedAt }),
      });
      setConfirmDeleteOpen(false);
      await onDeleted();
    } catch (deleteError) {
      setConfirmDeleteOpen(false);
      setError(describeError(deleteError));
    } finally {
      setDeleting(false);
    }
  };

  const busy = saving || deleting;
  const dirty = status === "ready" && draft !== loadedContent;

  return (
    <section
      data-testid={`${TID_SETTINGS_MEMORY_EDITOR}:${fileName}`}
      className="space-y-3 rounded-xl border border-border bg-surface p-4"
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <h3 className="min-w-0 truncate text-ui-base font-medium text-foreground">{fileName}</h3>
        <span className="shrink-0 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.memory.editor.hint" })}
        </span>
      </div>

      {status === "loading" ? (
        <p className="py-6 text-center text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.memory.viewer.fileLoading" })}
        </p>
      ) : null}

      {status === "error" ? (
        <div className="space-y-3">
          <p
            data-testid={TID_SETTINGS_MEMORY_EDITOR_ERROR}
            className="text-ui-base text-destructive"
          >
            {error}
          </p>
          <SettingsFormActions>
            <Button type="button" variant="ghost" size="lg" onClick={onCancel}>
              {intl.formatMessage({ id: "common.close" })}
            </Button>
            <Button
              type="button"
              variant="default"
              size="lg"
              data-testid={TID_SETTINGS_MEMORY_EDITOR_RELOAD}
              onClick={() => void load()}
            >
              {intl.formatMessage({ id: "settings.memory.editor.reload" })}
            </Button>
          </SettingsFormActions>
        </div>
      ) : null}

      {status === "ready" ? (
        <>
          <SettingsFormTextarea
            data-testid={TID_SETTINGS_MEMORY_EDITOR_TEXTAREA}
            value={draft}
            rows={14}
            spellCheck={false}
            disabled={busy}
            className="min-h-64 font-mono text-ui-sm"
            onChange={(event) => setDraft(event.target.value)}
          />
          {error ? (
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <p
                data-testid={TID_SETTINGS_MEMORY_EDITOR_ERROR}
                className="min-w-0 text-ui-base text-destructive"
              >
                {error}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid={TID_SETTINGS_MEMORY_EDITOR_RELOAD}
                disabled={busy}
                onClick={() => void load()}
              >
                {intl.formatMessage({ id: "settings.memory.editor.reload" })}
              </Button>
            </div>
          ) : null}
          <SettingsFormActions
            leadingAction={
              <Button
                type="button"
                variant="link"
                size="lg"
                data-testid={TID_SETTINGS_MEMORY_EDITOR_DELETE}
                className="px-0 text-destructive hover:text-destructive"
                disabled={busy}
                onClick={() => setConfirmDeleteOpen(true)}
              >
                {intl.formatMessage({ id: "common.delete" })}
              </Button>
            }
          >
            <Button
              type="button"
              variant="default"
              size="lg"
              data-testid={TID_SETTINGS_MEMORY_EDITOR_SAVE}
              disabled={!dirty || busy}
              onClick={() => void handleSave()}
            >
              {saving
                ? intl.formatMessage({ id: "common.saving" })
                : intl.formatMessage({ id: "common.save" })}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="lg"
              data-testid={TID_SETTINGS_MEMORY_EDITOR_CANCEL}
              disabled={busy}
              onClick={onCancel}
            >
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
          </SettingsFormActions>
        </>
      ) : null}

      <AlertDialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {intl.formatMessage({ id: "settings.memory.editor.deleteTitle" }, { name: fileName })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {intl.formatMessage({ id: "settings.memory.editor.deleteDescription" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button" size="sm" disabled={deleting}>
              {intl.formatMessage({ id: "common.cancel" })}
            </AlertDialogCancel>
            <AlertDialogAction
              type="button"
              size="sm"
              variant="destructive"
              data-testid={TID_SETTINGS_MEMORY_EDITOR_DELETE_CONFIRM}
              disabled={deleting}
              onClick={(event) => {
                event.preventDefault();
                void handleDelete();
              }}
            >
              {intl.formatMessage({ id: "common.delete" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
