import { useEffect, useState } from "react";
import type { IMemoryService } from "@zcode/services";
import {
  TID_V4_MEMORY_CAPTURE_CANCEL,
  TID_V4_MEMORY_CAPTURE_DIALOG,
  TID_V4_MEMORY_CAPTURE_ERROR,
  TID_V4_MEMORY_CAPTURE_SAVE,
} from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import {
  appendMemoryIndexLine,
  buildMemoryIndexLine,
  formatMemoryCaptureFile,
  memoryCaptureFileName,
  type MemoryCaptureDraft,
} from "@/v4/memory/memoryCapturePrompt.js";

export type MemoryCaptureService = Pick<
  IMemoryService,
  "readProjectMemoryFile" | "writeProjectMemoryFile"
>;

const MAX_UNIQUE_NAME_ATTEMPTS = 20;

/**
 * 沉淀预览：模型给出的条目先在这里可改，确认后才落盘。
 *
 * 两次写入的顺序与语义：
 *   1. 新建条目文件（从不覆盖：同名已存在就换一个 `-2`/`-3` 后缀），
 *   2. 用打开时读到的 `updatedAt` 作为 CAS 往 MEMORY.md 追加索引行。
 * 索引写失败时条目文件已经存在，重试只会再追加一次索引——因此索引写失败不回滚文件，
 * 而是把错误如实交给用户（重复条目比丢文件和静默失败更容易收拾）。
 */
export function MemoryCaptureDialog({
  open,
  workspaceId,
  draft,
  memoryService,
  onCancel,
  onSaved,
}: {
  open: boolean;
  workspaceId: string;
  draft: MemoryCaptureDraft | null;
  memoryService: MemoryCaptureService;
  onCancel: () => void;
  onSaved: (result: { fileName: string; indexUpdated: boolean }) => void;
}) {
  const { intl } = useZCodeIntl();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(draft?.name ?? "");
    setDescription(draft?.description ?? "");
    setBody(draft?.body ?? "");
    setError(null);
    setSaving(false);
  }, [draft]);

  const canSave = name.trim().length > 0 && body.trim().length > 0 && !saving;

  const handleSave = async (): Promise<void> => {
    if (draft === null) return;
    setSaving(true);
    setError(null);
    try {
      const fileName = await resolveUniqueMemoryFileName({
        workspaceId,
        baseName: memoryCaptureFileName(name),
        memoryService,
      });
      await memoryService.writeProjectMemoryFile({
        workspaceId,
        fileName,
        content: formatMemoryCaptureFile(
          { ...draft, name: name.trim(), description: description.trim(), body },
          fileName,
        ),
      });

      const index = await readIndexState(workspaceId, memoryService);
      const line = buildMemoryIndexLine({
        fileName,
        title: name.trim(),
        description: description.trim(),
      });
      const nextIndex = appendMemoryIndexLine(index.content, line);
      const indexUpdated = nextIndex !== index.content;
      if (indexUpdated) {
        await memoryService.writeProjectMemoryFile({
          workspaceId,
          fileName: "MEMORY.md",
          content: nextIndex,
          ...(index.updatedAt === undefined ? {} : { expectedUpdatedAt: index.updatedAt }),
        });
      }
      onSaved({ fileName, indexUpdated });
    } catch (saveError) {
      setError(describeCaptureError(saveError, intl.formatMessage));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !saving) onCancel();
      }}
    >
      <DialogContent className="max-w-2xl" data-testid={TID_V4_MEMORY_CAPTURE_DIALOG}>
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "chat.memoryCapture.title" })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "chat.memoryCapture.description" })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block space-y-1.5">
            <span className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "chat.memoryCapture.name" })}
            </span>
            <Input
              value={name}
              disabled={saving}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "chat.memoryCapture.summary" })}
            </span>
            <Input
              value={description}
              disabled={saving}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "chat.memoryCapture.body" })}
            </span>
            <SettingsFormTextarea
              value={body}
              rows={10}
              disabled={saving}
              className="min-h-40 text-ui-sm"
              onChange={(event) => setBody(event.target.value)}
            />
          </label>
          {error ? (
            <p data-testid={TID_V4_MEMORY_CAPTURE_ERROR} className="text-ui-base text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="lg"
            data-testid={TID_V4_MEMORY_CAPTURE_CANCEL}
            disabled={saving}
            onClick={onCancel}
          >
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          <Button
            type="button"
            variant="default"
            size="lg"
            data-testid={TID_V4_MEMORY_CAPTURE_SAVE}
            disabled={!canSave}
            onClick={() => void handleSave()}
          >
            {saving
              ? intl.formatMessage({ id: "common.saving" })
              : intl.formatMessage({ id: "chat.memoryCapture.save" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

async function readIndexState(
  workspaceId: string,
  memoryService: MemoryCaptureService,
): Promise<{ content: string | null; updatedAt: number | undefined }> {
  try {
    const index = await memoryService.readProjectMemoryFile({ workspaceId, fileName: "MEMORY.md" });
    return { content: index.content, updatedAt: index.updatedAt };
  } catch {
    // 还没有索引：按新建处理，写入时不需要 CAS。
    return { content: null, updatedAt: undefined };
  }
}

/** 沉淀只新建文件，不覆盖既有条目：同名就先试 `-2`、`-3`。 */
async function resolveUniqueMemoryFileName(input: {
  workspaceId: string;
  baseName: string;
  memoryService: MemoryCaptureService;
}): Promise<string> {
  const stem = input.baseName.replace(/\.md$/u, "");
  for (let attempt = 1; attempt <= MAX_UNIQUE_NAME_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 1 ? `${stem}.md` : `${stem}-${attempt}.md`;
    if (!(await memoryFileExists(input.workspaceId, candidate, input.memoryService))) {
      return candidate;
    }
  }
  throw new Error("Too many memory files with the same name");
}

async function memoryFileExists(
  workspaceId: string,
  fileName: string,
  memoryService: MemoryCaptureService,
): Promise<boolean> {
  try {
    await memoryService.readProjectMemoryFile({ workspaceId, fileName });
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    // 读取失败不是「不存在」；继续写会覆盖一个我们看不清楚的文件，直接放弃。
    throw error;
  }
}

function describeCaptureError(
  error: unknown,
  formatMessage: (descriptor: { id: string }) => string,
): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "PROJECT_MEMORY_FILE_CHANGED") {
      return formatMessage({ id: "settings.memory.viewer.fileChanged" });
    }
    if (code === "FORK_FEATURE_DISABLED") {
      return formatMessage({ id: "settings.memory.editor.error.disabled" });
    }
    if (code === "PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED") {
      return formatMessage({ id: "settings.memory.viewer.fileTooLarge" });
    }
  }
  return error instanceof Error ? error.message : String(error);
}
