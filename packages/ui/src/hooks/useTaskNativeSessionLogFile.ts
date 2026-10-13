import { useCallback, useEffect, useRef, useState } from "react";
import type { ZCodeProvider } from "@zcode/shared";
import { logger } from "@/logger.js";
import { useZCodeTaskService } from "@/hooks/useZCodeTaskService.js";

/**
 * 返回类型被任务菜单路径状态引用，声明生成要求它可导出。
 * @lintignore
 */
export interface TaskNativeSessionLogFileState {
  provider: ZCodeProvider | null;
  path: string | null;
  exists: boolean;
  loading: boolean;
  error: string | null;
}

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

const INITIAL_STATE: TaskNativeSessionLogFileState = {
  provider: null,
  path: null,
  exists: false,
  loading: false,
  error: null,
};

export function supportsTaskNativeSessionLogFile(
  _provider: ZCodeProvider | null | undefined,
): boolean {
  // 仅剩 glm provider，始终支持读取原生会话日志。
  return true;
}

/**
 * 读取当前 task 对应的原生会话日志路径。
 *
 * 路径规则统一通过 zcodeTaskService 解析，避免 UI 层猜 provider 自己的目录结构。
 * 查询按需执行：仅任务菜单打开时启用（enabled）。返回值带渲染期 scope 校验，
 * task/provider/identity 切换瞬间不会把上一 task 的路径露出。
 */
export function useTaskNativeSessionLogFile(
  workspacePath: string,
  taskId: string | null,
  providerHint?: ZCodeProvider | null,
  workspaceIdentity?: string,
  options: { enabled?: boolean } = {},
): TaskNativeSessionLogFileState & { retry: () => void } {
  const zcodeTaskService = useZCodeTaskService(workspacePath, undefined, workspaceIdentity);
  const [state, setState] = useState<TaskNativeSessionLogFileState & { scopeKey: string | null }>({
    ...INITIAL_STATE,
    scopeKey: null,
  });
  const requestVersionRef = useRef(0);
  const [reloadToken, setReloadToken] = useState(0);
  const enabled = options.enabled ?? true;
  const scopeKey = `${workspaceIdentity?.trim() || workspacePath} ${workspacePath} ${taskId ?? ""} ${providerHint ?? ""}`;
  const scopedState: TaskNativeSessionLogFileState =
    state.scopeKey === scopeKey
      ? state
      : {
          ...INITIAL_STATE,
          provider: providerHint ?? null,
          loading: enabled && Boolean(workspacePath && taskId),
        };
  const retry = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    let disposed = false;

    if (!enabled || !workspacePath || !taskId) {
      requestVersionRef.current += 1;
      // 原生日志路径只在菜单动作里使用；拖拽/列表重排不应让每个 row 都发路径 RPC。
      setState({ ...INITIAL_STATE, scopeKey: null });
      return () => {
        disposed = true;
      };
    }

    if (!supportsTaskNativeSessionLogFile(providerHint)) {
      requestVersionRef.current += 1;
      setState({
        provider: providerHint ?? null,
        path: null,
        exists: false,
        loading: false,
        error: null,
        scopeKey,
      });
      return () => {
        disposed = true;
      };
    }

    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;

    setState({
      provider: providerHint ?? null,
      path: null,
      exists: false,
      loading: true,
      error: null,
      scopeKey,
    });

    void zcodeTaskService
      .getTaskNativeSessionLogFile({
        taskId,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      })
      .then((result) => {
        if (disposed || requestVersionRef.current !== requestVersion) {
          return;
        }

        setState({
          provider: result.provider ?? providerHint ?? null,
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
        logger.warn("[useTaskNativeSessionLogFile] 读取 task 原生日志路径失败", {
          workspacePath,
          taskId,
          providerHint,
          workspaceIdentity,
          error: message,
        });
        setState({
          provider: providerHint ?? null,
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
  }, [
    enabled,
    reloadToken,
    zcodeTaskService,
    providerHint,
    taskId,
    workspaceIdentity,
    workspacePath,
    scopeKey,
  ]);

  return { ...scopedState, retry };
}
