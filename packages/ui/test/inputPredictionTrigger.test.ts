// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { ServiceProvider } from "@/hooks/useServices.js";
import { canRequestInputPrediction, useInputPrediction } from "@/v4/composer/useInputPrediction.js";

function createWrapper(conversationInputPredictionV4: unknown) {
  return ({ children }: { children: ReactNode }) =>
    ServiceProvider({
      services: { zcodeAgentService: { conversationInputPredictionV4 } } as never,
      children,
    });
}

function params(overrides: Partial<Parameters<typeof useInputPrediction>[0]> = {}) {
  return {
    enabled: true,
    workspacePath: "/w",
    sessionId: "s1",
    revision: 1,
    draft: "",
    blocked: false,
    idleMs: 20,
    ...overrides,
  };
}

describe("input prediction trigger", () => {
  it("requires the setting, a session and a non-rich draft", () => {
    expect(canRequestInputPrediction({ enabled: true, sessionId: "s1", blocked: false })).toBe(
      true,
    );
    expect(canRequestInputPrediction({ enabled: false, sessionId: "s1", blocked: false })).toBe(
      false,
    );
    expect(canRequestInputPrediction({ enabled: true, sessionId: null, blocked: false })).toBe(
      false,
    );
    expect(canRequestInputPrediction({ enabled: true, sessionId: "s1", blocked: true })).toBe(
      false,
    );
  });
});

describe("useInputPrediction", () => {
  it("debounces until the draft stops changing", async () => {
    const request = vi.fn(async (input: { draft?: string }) => ({
      decision: "show",
      candidates: [{ text: `${input.draft ?? ""}!` }],
    }));
    const hook = renderHook((props) => useInputPrediction(props), {
      wrapper: createWrapper(request),
      initialProps: params({ draft: "a" }),
    });

    hook.rerender(params({ draft: "ab" }));
    // 上一份草稿的定时器已被取消：空闲前一次都不该发请求。
    expect(request).not.toHaveBeenCalled();

    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ draft: "ab", revision: 1 }));
    await waitFor(() => expect(hook.result.current.candidate).toBe("ab!"));
  });

  it("drops a stale response that arrives after the draft changed", async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const request = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ decision: "show", candidates: [{ text: "ab!" }] });
    const hook = renderHook((props) => useInputPrediction(props), {
      wrapper: createWrapper(request),
      initialProps: params({ draft: "a" }),
    });

    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    hook.rerender(params({ draft: "ab" }));
    await waitFor(() => expect(hook.result.current.candidate).toBe("ab!"));

    await act(async () => {
      resolveFirst({ decision: "show", candidates: [{ text: "a!" }] });
      await first;
    });
    // 旧请求晚到：不得把当前草稿的候选顶掉。
    expect(hook.result.current.candidate).toBe("ab!");
  });

  it("does not request the same draft again after it was dismissed", async () => {
    const request = vi.fn(async () => ({
      decision: "show",
      candidates: [{ text: "补全内容" }],
    }));
    const hook = renderHook((props) => useInputPrediction(props), {
      wrapper: createWrapper(request),
      initialProps: params({ draft: "a" }),
    });

    await waitFor(() => expect(hook.result.current.candidate).toBe("补全内容"));
    act(() => hook.result.current.dismiss());
    expect(hook.result.current.candidate).toBeNull();

    // 附件加上又去掉会让 effect 重跑；同一份草稿不得再请求一次。
    hook.rerender(params({ draft: "a", blocked: true }));
    hook.rerender(params({ draft: "a", blocked: false }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("stays quiet while the setting is off or the draft is rich", async () => {
    const request = vi.fn(async () => ({
      decision: "show",
      candidates: [{ text: "x" }],
    }));
    const hook = renderHook((props) => useInputPrediction(props), {
      wrapper: createWrapper(request),
      initialProps: params({ enabled: false, draft: "a" }),
    });
    hook.rerender(params({ enabled: true, draft: "a", blocked: true }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(request).not.toHaveBeenCalled();
    expect(hook.result.current.candidate).toBeNull();
  });

  it("ignores unavailable predictions", async () => {
    const request = vi.fn(async () => ({ decision: "unavailable", candidates: [] }));
    const hook = renderHook((props) => useInputPrediction(props), {
      wrapper: createWrapper(request),
      initialProps: params({ draft: "a" }),
    });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(hook.result.current.candidate).toBeNull();
  });
});
