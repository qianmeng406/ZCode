import { useCallback, useEffect, useRef, useState } from "react";
import { logger } from "@/logger.js";
import { useZCodeTaskService } from "@/hooks/useZCodeTaskService.js";

/**
 * 返回类型被任务菜单路径状态引用，声明生成要求它可导出。
 * @lintignore
 */
export interface TaskSessionFilePathState {
  path: string | null;
  exists: boolean;
  loading: boolean;
  error: string | null;
}

const INITIAL_STATE: TaskSessionFilePathState = {
  path: null,
  exists: false,
  loading: false,
  error: null,
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || String(error);
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }

  return String(error);
}

/**
 * 读取当前 task 对应的持久化快照文件路径。
 *
 * UI 之前直接在浏览器里访问 crypto.subtle 计算 workspace hash，
 * 在 http 预览或远程访问这类非安全上下文里 subtle 可能不存在，副作用阶段会直接抛错。
 * 这里改成统一走 zcodeTaskService 解析最终路径，既不让 UI 猜目录规则，也能兼容 remote workspace 的远端 home 目录。
 *
 * 查询按需执行：仅任务菜单打开时启用（enabled）。返回值带渲染期 scope 校验，
 * task/identity 切换瞬间不会把上一 task 的路径露出。
 */
export function useTaskSessionFilePath(
  workspacePath: string,
  taskId: string | null,
  workspaceIdentity?: string,
  options: { enabled?: boolean } = {},
): TaskSessionFilePathState & { retry: () => void } {
  const zcodeTaskService = useZCodeTaskService(workspacePath, undefined, workspaceIdentity);
  const [state, setState] = useState<TaskSessionFilePathState & { scopeKey: string | null }>({
    ...INITIAL_STATE,
    scopeKey: null,
  });
  const requestVersionRef = useRef(0);
  const [reloadToken, setReloadToken] = useState(0);
  const enabled = options.enabled ?? true;
  const scopeKey = `${workspaceIdentity?.trim() || workspacePath} ${workspacePath} ${taskId ?? ""}`;
  // 渲染期 scope 校验：taskId/identity 切换到 effect 重跑之间可能短暂展示旧 scope 的
  // 路径；返回前比对 scope，不一致即按未加载展示。
  const scopedState: TaskSessionFilePathState =
    state.scopeKey === scopeKey
      ? state
      : { ...INITIAL_STATE, loading: enabled && Boolean(workspacePath && taskId) };
  const retry = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    let disposed = false;

    if (!enabled || !workspacePath || !taskId) {
      requestVersionRef.current += 1;
      // task 路径只服务右键/更多菜单；菜单未打开时停止 RPC，避免拖拽重排放大为路径查询风暴。
      setState({ ...INITIAL_STATE, scopeKey: null });
      return () => {
        disposed = true;
      };
    }

    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;

    setState({
      path: null,
      exists: false,
      loading: true,
      error: null,
      scopeKey,
    });

    void zcodeTaskService
      .getTaskSessionFilePath({
        workspacePath,
        taskId,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      })
      .then((result) => {
        if (disposed || requestVersionRef.current !== requestVersion) {
          return;
        }

        setState({
          path: result.path,
          exists: result.exists,
          loading: false,
          error: null,
          scopeKey,
        });
      })
      .catch((error: unknown) => {
        if (disposed || requestVersionRef.current !== requestVersion) {
          return;
        }

        const message = getErrorMessage(error);
        logger.warn("[useTaskSessionFilePath] 读取 task 快照路径失败", {
          workspacePath,
          taskId,
          workspaceIdentity,
          error: message,
        });
        setState({
          path: null,
          exists: false,
          loading: false,
          error: message,
          scopeKey,
        });
      });

    return () => {
      disposed = true;
    };
  }, [enabled, reloadToken, zcodeTaskService, taskId, workspaceIdentity, workspacePath, scopeKey]);

  return { ...scopedState, retry };
}
