import { useEffect, useState } from "react";
import { Maximize2Icon, XIcon } from "lucide-react";
import { PreviewPane } from "@/PreviewPane.js";
import { WorkspaceFileTree } from "@/WorkspaceFileTree.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { shouldRenderPreviewPaneHeavyContent } from "@/app-shell/animatedSidePanePanelModel.js";
import { Button } from "@/components/ui/button.js";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { inferMediaPreview, type CodeViewerSource } from "@/lib/codeViewer.js";
import { getPathLeaf } from "@/lib/path.js";

const FILE_EXPLORER_PANEL_IDS = ["file-explorer-tree", "file-explorer-preview"];

/**
 * 侧边面板的「文件」标签：左树右预览的分栏视图。
 *
 * 左栏复用工作区边栏的文件树（搜索 / git 过滤 / 右键菜单全部一致）；右栏内嵌
 * PreviewPane——与 code viewer 标签同一个预览组件，代码/图片/PDF/PPTX/媒体/_diff
 * 全部支持。点文件不再另开标签，直接落到本标签的预览区；「在新标签打开」按钮保留
 * 通向全宽 code viewer 标签的入口。
 */
export function FileExplorerSidePane({
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  canOpenLocalFileManager = false,
  active = false,
  onOpenBrowserUrl,
  onOpenCodeViewer,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  canOpenLocalFileManager?: boolean;
  /** 本标签是否处于激活且面板可见状态；据此裁剪重内容（千行 diff Shadow DOM 等）。 */
  active?: boolean;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenCodeViewer: (source: CodeViewerSource) => void;
}) {
  const { intl } = useZCodeIntl();
  const [preview, setPreview] = useState<CodeViewerSource | null>(null);

  // 切换 workspace 后旧预览指向别的目录，必须在边界清掉。
  useEffect(() => {
    setPreview(null);
  }, [workspacePath, workspaceIdentity]);

  const handleOpenPreview = (source: CodeViewerSource) => {
    // 预览 source 带 workspace 作用域，PreviewPane 才能用正确 host 读取（远程 workspace 同样成立）。
    setPreview({
      ...source,
      workspacePath,
      workspaceIdentity,
      workspaceRemoteSessionId,
    });
  };

  const previewPath = preview && "path" in preview ? preview.path : undefined;
  const previewTitle = preview?.title || getPathLeaf(previewPath ?? "") || preview?.path || "";
  const renderHeavyContent = shouldRenderPreviewPaneHeavyContent({
    isActiveTab: active,
    isMediaPreview:
      preview?.type === "media" ||
      (preview?.type === "file" && inferMediaPreview(preview.path) !== null),
    isSidePaneVisible: active,
    visibleInlineSizePx: null,
  });

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      layoutId="workspace-file-explorer-layout"
      panelIds={FILE_EXPLORER_PANEL_IDS}
      className="h-full min-h-0 bg-background"
    >
      <ResizablePanel id="file-explorer-tree" minSize="25%" defaultSize="38%">
        <WorkspaceFileTree
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          workspaceRemoteSessionId={workspaceRemoteSessionId}
          canOpenLocalFileManager={canOpenLocalFileManager}
          activePreviewPath={previewPath ?? null}
          // 非活动 tab / 面板隐藏时暂停树专属查询与 watcher（保留缓存）。
          active={active}
          onOpenBrowserUrl={onOpenBrowserUrl}
          onOpenPreview={handleOpenPreview}
        />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="file-explorer-preview" minSize="30%" className="min-w-0">
        {preview ? (
          <section className="flex h-full min-h-0 min-w-0 flex-col bg-background">
            <header className="flex h-9 shrink-0 items-center gap-1 border-b border-border/50 px-2">
              <span
                className="min-w-0 flex-1 truncate text-ui-sm font-medium text-foreground"
                title={previewPath ?? previewTitle}
              >
                {previewTitle}
              </span>
              <ControlHintTooltip
                title={intl.formatMessage({ id: "fileExplorer.openInTab" })}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
                  aria-label={intl.formatMessage({ id: "fileExplorer.openInTab" })}
                  onClick={() => {
                    if (!preview) {
                      return;
                    }
                    onOpenCodeViewer(preview);
                    setPreview(null);
                  }}
                >
                  <Maximize2Icon className="size-3.5" aria-hidden="true" />
                </Button>
              </ControlHintTooltip>
              <ControlHintTooltip
                title={intl.formatMessage({ id: "fileExplorer.closePreview" })}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
                  aria-label={intl.formatMessage({ id: "fileExplorer.closePreview" })}
                  onClick={() => setPreview(null)}
                >
                  <XIcon className="size-3.5" aria-hidden="true" />
                </Button>
              </ControlHintTooltip>
            </header>
            <div className="min-h-0 min-w-0 flex-1">
              <PreviewPane
                source={preview}
                onClose={() => setPreview(null)}
                workspacePath={workspacePath}
                onOpenBrowserUrl={onOpenBrowserUrl}
                onOpenCodeViewer={onOpenCodeViewer}
                renderHeavyContent={renderHeavyContent}
              />
            </div>
          </section>
        ) : (
          <div className="flex h-full min-w-0 items-center justify-center overflow-hidden px-6 text-center text-ui-sm text-foreground-subtlest">
            {intl.formatMessage({ id: "fileExplorer.previewEmpty" })}
          </div>
        )}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
