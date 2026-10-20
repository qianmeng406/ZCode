import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionExecutionEnvironment, SessionExecutionState } from "@zcode/shared";
import { isValidWslUser } from "@zcode/shared";

// 组件消费层统一从本 hook 取 shared 环境类型；避免多处直连 @zcode/shared 导出形态。
export type { SessionExecutionEnvironment, SessionExecutionState };

/**
 * 会话级本机 Linux（WSL）执行环境 hook。
 *
 * shared 契约（packages/shared/src/sessionExecutionEnvironment.ts /
 * sessionExecutionWire.ts）已消费；service 三方法当前实际返回形态统一为
 * Promise<{ state: SessionExecutionState }>（接口负责人定稿中，以真正
 * IZCodeAgentService 落地代码为准；如有差异只需改本文件 port 与三个调用点）。
 *
 * spec: docs/research/session-linux-execution.spec.md
 * - 配置只保存 kind/distro/user，不保存 PID/lease/凭据；UI 只保留待提交状态。
 * - 远程 workspace 不叠加本机 Linux 绑定；未指定环境保留现有行为。
 */

/** UI 消费的 service 面（与 IZCodeAgentService 落地签名结构兼容）。 */
export interface SessionExecutionEnvironmentServicePort {
  getExecutionEnvironment(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    sessionId: string;
  }): Promise<{ state: SessionExecutionState }>;
  setExecutionEnvironment(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    sessionId: string;
    /** wsl 环境（distro 必填，user 缺省 = 发行版默认用户），或 kind:"local" 回到本机默认。 */
    environment: SessionExecutionEnvironment;
  }): Promise<{ state: SessionExecutionState }>;
  cancelExecutionEnvironmentPreparation(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    sessionId: string;
  }): Promise<{ state: SessionExecutionState }>;
}

/**
 * WSL 选择：distro 必须显式；user 留空表示使用该发行版默认用户
 * （执行端省略 `-u` 由 WSL 解析，不修改 WSL 默认用户）。
 */
export interface SessionExecutionEnvironmentSelection {
  kind: "wsl";
  distro: string;
  user?: string;
}

export type SessionExecutionEnvironmentPreparationPhase =
  | "idle"
  | "preparing"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface SessionExecutionEnvironmentPreparationState {
  phase: SessionExecutionEnvironmentPreparationPhase;
  error: string | null;
}

export const IDLE_PREPARATION_STATE: SessionExecutionEnvironmentPreparationState = {
  phase: "idle",
  error: null,
};

/** 已落库 task 才能承载环境切换；草稿没有稳定 session 身份。 */
export function canConfigureSessionExecutionEnvironment(params: {
  sessionId: string | null | undefined;
  isRemoteWorkspace: boolean;
  isWindowsLocalWorkspace: boolean;
}): boolean {
  return Boolean(params.sessionId) && !params.isRemoteWorkspace && params.isWindowsLocalWorkspace;
}

/** 选择校验：distro 必填；user 可留空（= 默认用户），填写时必须合法。 */
export function validateSessionExecutionEnvironmentSelection(
  selection: SessionExecutionEnvironmentSelection,
): string | null {
  const distro = selection.distro.trim();
  if (!distro) {
    return "sessionExecutionEnvironment.error.distroRequired";
  }
  const user = selection.user?.trim() ?? "";
  if (user && !isValidWslUser(user)) {
    return "sessionExecutionEnvironment.error.invalidUser";
  }
  return null;
}

export interface UseSessionExecutionEnvironmentParams {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null;
  /** 生产路径注入 services.zcodeAgentService（结构兼容落地签名）。 */
  service?: SessionExecutionEnvironmentServicePort;
  enabled?: boolean;
}

export interface UseSessionExecutionEnvironmentResult {
  /** 会话当前生效环境；未指定时为 null（保留现有本机默认行为）。 */
  current: SessionExecutionEnvironment | null;
  /** preparing 时的目标环境（来自 shared SessionExecutionState）。 */
  preparingTarget: SessionExecutionEnvironment | null;
  currentLoading: boolean;
  preparation: SessionExecutionEnvironmentPreparationState;
  submitSelection: (
    selection: SessionExecutionEnvironmentSelection | { kind: "local" },
  ) => Promise<boolean>;
  cancelPreparation: () => Promise<void>;
  /** 拉取当前环境的会话键，用于切换会话后丢弃旧投影。 */
  scopeKey: string;
}

function buildScopeKey(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null;
}): string {
  // Workspace Identity 约定：身份键统一为 workspaceIdentity?.trim() || workspacePath。
  return JSON.stringify([
    params.workspaceIdentity?.trim() || params.workspacePath,
    params.sessionId,
  ]);
}

function resolveState(
  state: SessionExecutionState | undefined,
  fallbackEnvironment: SessionExecutionEnvironment,
): {
  current: SessionExecutionEnvironment | null;
  preparingTarget: SessionExecutionEnvironment | null;
} {
  // kind:"local"（本机默认）对 UI 等价于未指定环境：投影为 null，展示层回
  // “本机默认（Windows）”文案；wsl 才携带 distro/user。
  const normalize = (
    environment: SessionExecutionEnvironment | null,
  ): SessionExecutionEnvironment | null =>
    environment && environment.kind === "wsl" ? environment : null;
  if (!state) {
    return { current: normalize(fallbackEnvironment), preparingTarget: null };
  }
  if (state.status === "preparing") {
    return { current: normalize(state.current), preparingTarget: state.target };
  }
  return { current: normalize(state.environment), preparingTarget: null };
}

export function useSessionExecutionEnvironment(
  params: UseSessionExecutionEnvironmentParams,
): UseSessionExecutionEnvironmentResult {
  const {
    workspacePath,
    workspaceIdentity,
    sessionId,
    service: injectedService,
    enabled = true,
  } = params;

  const scopeKey = useMemo(
    () => buildScopeKey({ workspacePath, workspaceIdentity, sessionId }),
    [workspacePath, workspaceIdentity, sessionId],
  );

  const [current, setCurrent] = useState<SessionExecutionEnvironment | null>(null);
  const [preparingTarget, setPreparingTarget] = useState<SessionExecutionEnvironment | null>(null);
  const [currentLoading, setCurrentLoading] = useState(false);
  const [preparation, setPreparation] = useState(IDLE_PREPARATION_STATE);

  // scopeKey 守卫：会话切换/卸载后丢弃旧会话的投影，绝不把 A 会话的结果写进 B。
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  // 会话内“已请求取消准备”标记：取消后迟到的 set 结算不再改变环境投影。
  const cancelledRef = useRef(false);

  const getCurrentEnvironment = useCallback(async () => {
    if (!enabled || !sessionId) {
      setCurrent(null);
      setPreparingTarget(null);
      return;
    }
    setCurrentLoading(true);
    try {
      const result = await resolvePort(injectedService).getExecutionEnvironment({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        sessionId,
      });
      if (scopeRef.current !== scopeKey) {
        return;
      }
      // get 返回当前状态投影；preparing 态同时携带 current+target。
      const projected = resolveState(result.state, { kind: "local" });
      setCurrent(projected.current);
      setPreparingTarget(projected.preparingTarget);
    } catch {
      // 读取失败不阻塞会话：按“未指定环境”处理，保留现有本机默认行为。
      if (scopeRef.current === scopeKey) {
        setCurrent(null);
        setPreparingTarget(null);
      }
    } finally {
      if (scopeRef.current === scopeKey) {
        setCurrentLoading(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scopeKey 已覆盖全部身份字段
  }, [scopeKey, enabled, sessionId]);

  useEffect(() => {
    // 会话切换先清旧投影再拉新值，避免短暂显示上一个会话的环境。
    setCurrent(null);
    setPreparingTarget(null);
    setPreparation(IDLE_PREPARATION_STATE);
    cancelledRef.current = false;
    void getCurrentEnvironment();
  }, [getCurrentEnvironment]);

  const submitSelection = useCallback(
    async (
      selection: SessionExecutionEnvironmentSelection | { kind: "local" },
    ): Promise<boolean> => {
      if (!sessionId || preparation.phase === "preparing" || preparation.phase === "cancelling") {
        return false;
      }
      const keyAtSubmit = scopeKey;
      cancelledRef.current = false;
      setPreparation({ phase: "preparing", error: null });
      try {
        const user = selection.kind === "wsl" ? (selection.user?.trim() ?? "") : "";
        const environment: SessionExecutionEnvironment =
          selection.kind === "local"
            ? { kind: "local" }
            : {
                kind: "wsl",
                distro: selection.distro.trim(),
                // 留空即缺省字段：Host 端省略 `-u`，由 WSL 使用发行版默认用户。
                ...(user ? { user } : {}),
              };
        const result = await resolvePort(injectedService).setExecutionEnvironment({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          sessionId,
          environment,
        });
        if (scopeRef.current !== keyAtSubmit) {
          return false;
        }
        // spec「切换 admission」：准备取消不提交。用户已请求取消时，
        // 迟到的 set 结算不得再改变环境投影（服务端 side 由 cancel 语义保证）。
        if (cancelledRef.current) {
          return true;
        }
        const projected = resolveState(result.state, environment);
        setCurrent(projected.current);
        setPreparingTarget(projected.preparingTarget);
        setPreparation({ phase: "succeeded", error: null });
        return true;
      } catch (runtimeError) {
        if (scopeRef.current !== keyAtSubmit) {
          return false;
        }
        setPreparation({
          phase: "failed",
          error: String(runtimeError),
        });
        return false;
      }
    },
    [injectedService, preparation.phase, sessionId, scopeKey, workspaceIdentity, workspacePath],
  );

  const cancelPreparation = useCallback(async () => {
    if (!sessionId || preparation.phase !== "preparing") {
      return;
    }
    const keyAtCancel = scopeKey;
    cancelledRef.current = true;
    setPreparation((previous) =>
      previous.phase === "preparing" ? { ...previous, phase: "cancelling" } : previous,
    );
    try {
      const result = await resolvePort(injectedService).cancelExecutionEnvironmentPreparation({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        sessionId,
      });
      if (scopeRef.current === keyAtCancel) {
        const projected = resolveState(result.state, current ?? { kind: "local" });
        setCurrent(projected.current);
        setPreparingTarget(projected.preparingTarget);
      }
    } catch {
      // 取消失败也必须让 UI 脱离 cancelling：服务端 admission 未确认时，
      // 下一次 set 会被拒绝并落回 failed，UI 不永久卡在取消态。
    } finally {
      if (scopeRef.current === keyAtCancel) {
        setPreparation((previous) =>
          previous.phase === "cancelling" ? { phase: "cancelled", error: null } : previous,
        );
      }
    }
  }, [
    current,
    injectedService,
    preparation.phase,
    sessionId,
    scopeKey,
    workspaceIdentity,
    workspacePath,
  ]);

  return {
    current,
    preparingTarget,
    currentLoading,
    preparation,
    submitSelection,
    cancelPreparation,
    scopeKey,
  };
}

// 【接线点】IZCodeAgentService 三方法落地后，组件注入处直接传
// services.zcodeAgentService（结构兼容 SessionExecutionEnvironmentServicePort）。
function resolvePort(
  injected: SessionExecutionEnvironmentServicePort | undefined,
): SessionExecutionEnvironmentServicePort {
  if (!injected) {
    throw new Error(
      "useSessionExecutionEnvironment 需要在 params.service 注入 services.zcodeAgentService",
    );
  }
  return injected;
}

/**
 * 弹窗草稿校验：distro 未选时不报错（提交按钮自行禁用）；已选则校验显式必填。
 */
export function validateSessionExecutionEnvironmentDraft(
  distroDraft: string,
  userDraft: string,
): string | null {
  if (!distroDraft.trim()) {
    return null;
  }
  return validateSessionExecutionEnvironmentSelection({
    kind: "wsl",
    distro: distroDraft,
    user: userDraft,
  });
}

/**
 * 环境展示标签：wsl 用 user@distro；未指定 user 时显式标注“默认用户”，
 * 避免只显示 distro 让用户误以为没配置成功；local/null 回本机默认文案。
 */
export function formatSessionExecutionEnvironmentLabel(
  intl: { formatMessage: (desc: { id: string }) => string },
  environment: SessionExecutionEnvironment | null,
): string {
  if (!environment || environment.kind !== "wsl") {
    return intl.formatMessage({ id: "sessionExecutionEnvironment.current.default" });
  }
  const user = environment.user?.trim();
  if (user) {
    return `${user}@${environment.distro}`;
  }
  return `${environment.distro} · ${intl.formatMessage({
    id: "sessionExecutionEnvironment.user.defaultTag",
  })}`;
}
