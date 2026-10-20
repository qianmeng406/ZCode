// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionExecutionEnvironment, SessionExecutionState } from "@zcode/shared";
import {
  IDLE_PREPARATION_STATE,
  canConfigureSessionExecutionEnvironment,
  formatSessionExecutionEnvironmentLabel,
  useSessionExecutionEnvironment,
  validateSessionExecutionEnvironmentSelection,
  type SessionExecutionEnvironmentServicePort,
  type UseSessionExecutionEnvironmentResult,
} from "@/hooks/useSessionExecutionEnvironment.js";
import { SessionExecutionEnvironmentDialog } from "@/SessionExecutionEnvironmentDialog.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

// 定向 UI 测试（docs/research/session-linux-execution.spec.md「UI」+协调口径）：
// 1) service 调用带完整 session identity（workspacePath/workspaceIdentity/sessionId）；
// 2) 切换 session 后迟到结果被丢弃，不串投影；
// 3) distro 必填、user 可选（留空 = 发行版默认用户）校验；
// 4) 准备取消（cancel 不提交、脱离 cancelling）；
// 5) 失败保留原环境、可重试；
// 6) 隐藏规则（非 Windows/remote/无 session 不可配）。

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface Fixture {
  port: SessionExecutionEnvironmentServicePort;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  setStates: Array<(result: SessionExecutionState) => void>;
}

function fixture(): Fixture {
  // deferred 队列：测试控制每个 set 何时结算与结算什么 state。
  const setStates: Array<(result: SessionExecutionState) => void> = [];
  const get = vi.fn(async () => ({
    state: { status: "idle", environment: { kind: "local" } } as SessionExecutionState,
  }));
  const set = vi.fn(
    () =>
      new Promise<{ state: SessionExecutionState }>((resolve) => {
        setStates.push((result) => resolve({ state: result }));
      }),
  );
  const cancel = vi.fn(async () => ({
    state: { status: "idle", environment: { kind: "local" } } as SessionExecutionState,
  }));
  return {
    port: {
      getExecutionEnvironment: get,
      setExecutionEnvironment: set,
      cancelExecutionEnvironmentPreparation: cancel,
    },
    get,
    set,
    cancel,
    setStates,
  };
}

const idleWsl = (distro: string, user: string): SessionExecutionState => ({
  status: "idle",
  environment: { kind: "wsl", distro, user },
});

function renderEnv(params?: {
  workspacePath?: string;
  workspaceIdentity?: string;
  sessionId?: string | null;
  enabled?: boolean;
  port?: SessionExecutionEnvironmentServicePort;
}) {
  const rendered = renderHook(() =>
    useSessionExecutionEnvironment({
      workspacePath: params?.workspacePath ?? "C:/ws",
      ...(params?.workspaceIdentity !== undefined
        ? { workspaceIdentity: params.workspaceIdentity }
        : {}),
      sessionId: params?.sessionId !== undefined ? params.sessionId : "session-a",
      service: params?.port ?? fixture().port,
      ...(params?.enabled !== undefined ? { enabled: params.enabled } : {}),
    }),
  );
  return rendered;
}

describe("canConfigureSessionExecutionEnvironment（入口隐藏规则）", () => {
  it("非 Windows 本地 workspace 不可配", () => {
    expect(
      canConfigureSessionExecutionEnvironment({
        sessionId: "s1",
        isRemoteWorkspace: false,
        isWindowsLocalWorkspace: false,
      }),
    ).toBe(false);
  });
  it("远程 workspace 不叠加绑定", () => {
    expect(
      canConfigureSessionExecutionEnvironment({
        sessionId: "s1",
        isRemoteWorkspace: true,
        isWindowsLocalWorkspace: true,
      }),
    ).toBe(false);
  });
  it("草稿（无 session 身份）不可配，须先经公开创建流拿到 sessionId", () => {
    expect(
      canConfigureSessionExecutionEnvironment({
        sessionId: null,
        isRemoteWorkspace: false,
        isWindowsLocalWorkspace: true,
      }),
    ).toBe(false);
  });
  it("Windows 本地 + 已落库 session 可配", () => {
    expect(
      canConfigureSessionExecutionEnvironment({
        sessionId: "s1",
        isRemoteWorkspace: false,
        isWindowsLocalWorkspace: true,
      }),
    ).toBe(true);
  });
});

describe("validateSessionExecutionEnvironmentSelection（distro 必填，user 可选）", () => {
  it("distro 必填", () => {
    expect(
      validateSessionExecutionEnvironmentSelection({ kind: "wsl", distro: "  ", user: "u" }),
    ).toBe("sessionExecutionEnvironment.error.distroRequired");
  });
  it("user 留空允许使用发行版默认用户", () => {
    expect(
      validateSessionExecutionEnvironmentSelection({ kind: "wsl", distro: "Ubuntu", user: "" }),
    ).toBeNull();
    expect(
      validateSessionExecutionEnvironmentSelection({ kind: "wsl", distro: "Ubuntu" }),
    ).toBeNull();
  });
  it("user 含路径分隔/冒号/控制字符拒绝", () => {
    expect(
      validateSessionExecutionEnvironmentSelection({ kind: "wsl", distro: "Ubuntu", user: "a/b" }),
    ).toBe("sessionExecutionEnvironment.error.invalidUser");
    expect(
      validateSessionExecutionEnvironmentSelection({ kind: "wsl", distro: "Ubuntu", user: "a:b" }),
    ).toBe("sessionExecutionEnvironment.error.invalidUser");
  });
  it("显式 distro+user 通过", () => {
    expect(
      validateSessionExecutionEnvironmentSelection({ kind: "wsl", distro: "Ubuntu", user: "dev" }),
    ).toBeNull();
  });
});

describe("formatSessionExecutionEnvironmentLabel（当前环境展示）", () => {
  const intl = {
    formatMessage: ({ id }: { id: string }) =>
      ({
        "sessionExecutionEnvironment.current.default": "本机默认（Windows）",
        "sessionExecutionEnvironment.user.defaultTag": "默认用户",
      })[id] ?? id,
  };

  it("显式用户显示 user@distro", () => {
    expect(
      formatSessionExecutionEnvironmentLabel(intl, {
        kind: "wsl",
        distro: "Ubuntu",
        user: "dev",
      }),
    ).toBe("dev@Ubuntu");
  });
  it("未指定用户显示 distro · 默认用户", () => {
    expect(formatSessionExecutionEnvironmentLabel(intl, { kind: "wsl", distro: "Ubuntu" })).toBe(
      "Ubuntu · 默认用户",
    );
  });
  it("本机默认回退文案", () => {
    expect(formatSessionExecutionEnvironmentLabel(intl, null)).toBe("本机默认（Windows）");
  });
});

describe("useSessionExecutionEnvironment", () => {
  it("读取当前环境时携带完整 session identity（workspacePath/workspaceIdentity/sessionId）", async () => {
    const f = fixture();
    renderEnv({
      workspacePath: "C:/repo",
      workspaceIdentity: "ident-1",
      sessionId: "session-9",
      port: f.port,
    });
    await act(async () => {});
    expect(f.get).toHaveBeenCalledWith({
      workspacePath: "C:/repo",
      workspaceIdentity: "ident-1",
      sessionId: "session-9",
    });
  });

  it("提交时携带同一 session identity 并投影 returned wsl 环境", async () => {
    const f = fixture();
    const { result } = renderEnv({ port: f.port });
    await act(async () => {});

    let submitted = false;
    await act(async () => {
      const promise = result.current.submitSelection({
        kind: "wsl",
        distro: "Ubuntu",
        user: "dev",
      });
      // set 尚未结算（deferred）
      expect(f.set).toHaveBeenCalledWith({
        workspacePath: "C:/ws",
        sessionId: "session-a",
        environment: { kind: "wsl", distro: "Ubuntu", user: "dev" },
      });
      f.setStates[0]!(idleWsl("Ubuntu", "dev"));
      submitted = await promise;
    });
    expect(submitted).toBe(true);
    expect(result.current.current).toEqual({ kind: "wsl", distro: "Ubuntu", user: "dev" });
    expect(result.current.preparation.phase).toBe("succeeded");
  });

  it("用户留空提交时省略 user 字段，交由执行端使用发行版默认用户", async () => {
    const f = fixture();
    const { result } = renderEnv({ port: f.port });
    await act(async () => {});

    let submitted = false;
    await act(async () => {
      const promise = result.current.submitSelection({ kind: "wsl", distro: "Ubuntu" });
      expect(f.set).toHaveBeenCalledWith({
        workspacePath: "C:/ws",
        sessionId: "session-a",
        environment: { kind: "wsl", distro: "Ubuntu" },
      });
      f.setStates[0]!({ status: "idle", environment: { kind: "wsl", distro: "Ubuntu" } });
      submitted = await promise;
    });
    expect(submitted).toBe(true);
    expect(result.current.current).toEqual({ kind: "wsl", distro: "Ubuntu" });
    expect(result.current.preparation.phase).toBe("succeeded");
  });

  it("切换 session 后迟到的 set 结果被丢弃，不写入新会话投影", async () => {
    const f = fixture();
    // 可变 props 驱动同一 hook 实例，模拟真实“同一 workspace 面板切会话”。
    const props = { workspacePath: "C:/ws", sessionId: "session-a", service: f.port };
    const { result, rerender } = renderHook(
      (p: typeof props) => useSessionExecutionEnvironment(p),
      { initialProps: props },
    );
    await act(async () => {});

    let promise: Promise<boolean> = Promise.resolve(false);
    act(() => {
      promise = result.current.submitSelection({ kind: "wsl", distro: "Ubuntu", user: "dev" });
    });
    await waitFor(() => expect(result.current.preparation.phase).toBe("preparing"));

    // 切到 session-b：清投影并拉新值；A 的迟到结算必须被丢弃，B 不被写入。
    rerender({ ...props, sessionId: "session-b" });
    await act(async () => {});
    expect(result.current.current).toBeNull();
    expect(result.current.preparation.phase).toBe("idle");

    f.setStates[0]!(idleWsl("Ubuntu", "dev"));
    const submitted = await act(() => promise);
    expect(submitted).toBe(false);
    expect(result.current.current).toBeNull();
    // set 只发出过一次（A 的提交），B 会话没有环境写入。
    expect(f.set).toHaveBeenCalledTimes(1);
    expect(f.get).toHaveBeenCalledTimes(2);
  });

  it("preparing 中再次提交被拒绝（busy disabled 语义）", async () => {
    const f = fixture();
    const { result } = renderEnv({ port: f.port });
    await act(async () => {});

    let first: Promise<boolean> = Promise.resolve(false);
    act(() => {
      first = result.current.submitSelection({ kind: "wsl", distro: "Ubuntu", user: "dev" });
    });
    await act(async () => {});
    expect(result.current.preparation.phase).toBe("preparing");

    const second = await act(() =>
      result.current.submitSelection({ kind: "wsl", distro: "Debian", user: "other" }),
    );
    expect(second).toBe(false);
    expect(f.set).toHaveBeenCalledTimes(1);

    f.setStates[0]!(idleWsl("Ubuntu", "dev"));
    expect(await act(() => first)).toBe(true);
  });

  it("取消准备：调用 cancel 带 identity，不提交新配置，脱离 cancelling 回 idle 投影", async () => {
    const f = fixture();
    const { result } = renderEnv({
      workspacePath: "C:/repo",
      workspaceIdentity: "ident-2",
      port: f.port,
    });
    await act(async () => {});

    let first: Promise<boolean> = Promise.resolve(false);
    act(() => {
      first = result.current.submitSelection({ kind: "wsl", distro: "Ubuntu", user: "dev" });
    });
    await waitFor(() => expect(result.current.preparation.phase).toBe("preparing"));

    await act(async () => {
      await result.current.cancelPreparation();
    });
    expect(f.cancel).toHaveBeenCalledWith({
      workspacePath: "C:/repo",
      workspaceIdentity: "ident-2",
      sessionId: "session-a",
    });
    // cancel 返回 idle：投影回本机默认，preparingTarget 清空。
    expect(result.current.current).toBeNull();
    expect(result.current.preparation.phase).toBe("cancelled");

    // 原提交在取消后结算：不再提交（cancelled 不改配置），环境保持本机默认。
    f.setStates[0]!(idleWsl("Ubuntu", "dev"));
    expect(await act(() => first)).toBe(true);
    // hook 侧：提交本身成功返回，但 state 是 idle/local，投影仍为 null（wsl 才投影）。
    expect(result.current.current).toBeNull();
  });

  it("失败保留原环境并暴露错误（可重试）", async () => {
    // 预置当前已是 wsl 环境：让 set 直接拒绝结算（同步 reject 的端口覆盖）。
    const failingPort: SessionExecutionEnvironmentServicePort = {
      getExecutionEnvironment: async () => ({ state: idleWsl("Ubuntu", "dev") }),
      setExecutionEnvironment: async () => {
        throw new Error("admission: busy turn");
      },
      cancelExecutionEnvironmentPreparation: async () => ({
        state: idleWsl("Ubuntu", "dev"),
      }),
    };
    const { result } = renderEnv({ port: failingPort });
    await act(async () => {});
    expect(result.current.current).toEqual({ kind: "wsl", distro: "Ubuntu", user: "dev" });

    const submitted = await act(() =>
      result.current.submitSelection({ kind: "wsl", distro: "Debian", user: "other" }),
    );
    expect(submitted).toBe(false);
    expect(result.current.preparation.phase).toBe("failed");
    expect(result.current.preparation.error).toContain("busy turn");
    // 失败不提交：原环境保持。
    expect(result.current.current).toEqual({ kind: "wsl", distro: "Ubuntu", user: "dev" });
  });

  it("enabled=false 或无 session 时不发起 service 调用（默认行为不变）", async () => {
    const f = fixture();
    const { result } = renderEnv({ enabled: false, port: f.port });
    await act(async () => {});
    expect(f.get).not.toHaveBeenCalled();
    expect(result.current.current).toBeNull();

    const f2 = fixture();
    renderEnv({ sessionId: null, port: f2.port });
    await act(async () => {});
    expect(f2.get).not.toHaveBeenCalled();
  });

  it("本机默认（kind:local）投影为 null：未指定环境保留现有行为", async () => {
    const port: SessionExecutionEnvironmentServicePort = {
      getExecutionEnvironment: async () => ({
        state: { status: "idle", environment: { kind: "local" } },
      }),
      setExecutionEnvironment: async () => ({
        state: { status: "idle", environment: { kind: "local" } },
      }),
      cancelExecutionEnvironmentPreparation: async () => ({
        state: { status: "idle", environment: { kind: "local" } },
      }),
    };
    const { result } = renderEnv({ port });
    await act(async () => {});
    expect(result.current.current).toBeNull();
  });
});

// 类型面守卫：环境联合的 local 分支保持可表达（编译期即可发现 shared 收窄破坏）。
describe("shared 环境类型消费", () => {
  it("local 与 wsl 均为合法 SessionExecutionEnvironment", () => {
    const local: SessionExecutionEnvironment = { kind: "local" };
    const wsl: SessionExecutionEnvironment = { kind: "wsl", distro: "Ubuntu", user: "dev" };
    expect(local.kind).toBe("local");
    expect(wsl.kind).toBe("wsl");
  });
});

// 发行版加载回归：真实 IPC 以宏任务结算。修复前 effect 把 distrosLoading 放进依赖，
// 自身 setState 触发重跑后 cleanup 作废在途回调，loading 永久卡死（单测同步 stub 恰好掩盖）。
describe("SessionExecutionEnvironmentDialog 发行版加载（真实 IPC 时序回归）", () => {
  function dialogProps(
    platform: Pick<import("@zcode/shared").IPlatformService, "listWSLDistros">,
    onOpenChange: (open: boolean) => void = () => undefined,
  ) {
    const environment = {
      current: null,
      preparingTarget: null,
      currentLoading: false,
      preparation: IDLE_PREPARATION_STATE,
      submitSelection: async () => false,
      cancelPreparation: async () => undefined,
      scopeKey: "C:/ws::session-a",
    } as unknown as UseSessionExecutionEnvironmentResult;
    return {
      open: true,
      onOpenChange,
      sessionId: "session-a",
      isRemoteWorkspace: false,
      isWindowsLocalWorkspace: true,
      platform,
      environment,
    };
  }

  function renderDialog(
    platform: Pick<import("@zcode/shared").IPlatformService, "listWSLDistros">,
    open = true,
    onOpenChange: (open: boolean) => void = () => undefined,
  ) {
    return render(
      createElement(
        ZCodeIntlProvider,
        null,
        createElement(SessionExecutionEnvironmentDialog, {
          ...dialogProps(platform, onOpenChange),
          open,
        }),
      ),
    );
  }

  it("listWSLDistros 以宏任务结算时仍能离开 loading 并启用选择", async () => {
    let resolveDistros: (value: import("@zcode/shared").WSLDistro[]) => void = () => undefined;
    const listWSLDistros = vi.fn(
      () =>
        new Promise<import("@zcode/shared").WSLDistro[]>((resolve) => {
          resolveDistros = resolve;
        }),
    );
    renderDialog({ listWSLDistros });
    const trigger = screen.getByRole("combobox");
    // 在途请求期间禁用（如实 loading）。
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    // 以宏任务结算，模拟真实 IPC 时序。
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
      resolveDistros([{ name: "Ubuntu-24.04", isDefault: true }]);
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => {
      expect((screen.getByRole("combobox") as HTMLButtonElement).disabled).toBe(false);
    });
    // 单次打开只拉一次：不存在自触发重入轮询。
    expect(listWSLDistros).toHaveBeenCalledTimes(1);
  });

  it("加载失败后重新打开弹窗会重试，不再被 guard 锁死", async () => {
    let attempt = 0;
    const listWSLDistros = vi.fn(
      () =>
        new Promise<import("@zcode/shared").WSLDistro[]>((resolve, reject) => {
          attempt += 1;
          setTimeout(() => {
            if (attempt === 1) reject(new Error("wsl unavailable"));
            else resolve([{ name: "Ubuntu-24.04", isDefault: false }]);
          }, 0);
        }),
    );
    const view = renderDialog({ listWSLDistros }, true);
    await waitFor(() => {
      expect(listWSLDistros).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    // 关闭再打开：应发起第二次拉取。
    view.rerender(
      createElement(
        ZCodeIntlProvider,
        null,
        createElement(SessionExecutionEnvironmentDialog, {
          ...dialogProps({ listWSLDistros }),
          open: false,
        }),
      ),
    );
    view.rerender(
      createElement(
        ZCodeIntlProvider,
        null,
        createElement(SessionExecutionEnvironmentDialog, {
          ...dialogProps({ listWSLDistros }),
          open: true,
        }),
      ),
    );
    await waitFor(() => {
      expect(listWSLDistros).toHaveBeenCalledTimes(2);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => {
      expect((screen.getByRole("combobox") as HTMLButtonElement).disabled).toBe(false);
    });
  });
});
