// 外部子智能体实例的外部会话 id 持久化。
//
// 关键不变量：**按 agentId 隔离**。混用会话级绑定会让同会话里多个外部子智能体
// 共用一条 CLI 会话，续接时拿到完全无关的历史——这类串台在结果里表现为
// "它怎么知道我上一个任务"，排查成本很高。
import { describe, expect, it } from "vitest";
import {
  readExternalSubagentSessionId,
  saveExternalSubagentSessionId,
} from "../src/zcode-protocol/session-external-subagent.js";

function createStore() {
  const entries: Array<{ id: string; sessionID: string; type: string; data: unknown }> = [];
  return {
    entries,
    async saveSessionEntry(entry: { id: string; sessionID: string; type: string; data: unknown }) {
      // 同一 id 原子覆盖（与真实 store 的 on conflict(id) 语义一致）。
      const index = entries.findIndex((existing) => existing.id === entry.id);
      if (index >= 0) entries[index] = entry;
      else entries.push(entry);
    },
    async sessionEntries({ sessionID, type }: { sessionID: string; type?: string }) {
      return entries.filter(
        (entry) => entry.sessionID === sessionID && (!type || entry.type === type),
      );
    },
  };
}

describe("外部子智能体实例的会话 id 持久化", () => {
  it("写回后能按 agentId 读回", async () => {
    const sessionStore = createStore();
    await saveExternalSubagentSessionId({
      sessionId: "s1",
      agentId: "agent_a",
      externalSessionId: "sess-1",
      sessionStore: sessionStore as never,
    });

    await expect(
      readExternalSubagentSessionId({
        sessionId: "s1",
        agentId: "agent_a",
        sessionStore: sessionStore as never,
      }),
    ).resolves.toBe("sess-1");
  });

  it("同一会话里不同 agentId 各存各的（绝不串台）", async () => {
    const sessionStore = createStore();
    await saveExternalSubagentSessionId({
      sessionId: "s1",
      agentId: "agent_a",
      externalSessionId: "sess-a",
      sessionStore: sessionStore as never,
    });
    await saveExternalSubagentSessionId({
      sessionId: "s1",
      agentId: "agent_b",
      externalSessionId: "sess-b",
      sessionStore: sessionStore as never,
    });

    expect(
      await readExternalSubagentSessionId({
        sessionId: "s1",
        agentId: "agent_a",
        sessionStore: sessionStore as never,
      }),
    ).toBe("sess-a");
    expect(
      await readExternalSubagentSessionId({
        sessionId: "s1",
        agentId: "agent_b",
        sessionStore: sessionStore as never,
      }),
    ).toBe("sess-b");
  });

  it("不同会话之间互不可见", async () => {
    const sessionStore = createStore();
    await saveExternalSubagentSessionId({
      sessionId: "s1",
      agentId: "agent_a",
      externalSessionId: "sess-1",
      sessionStore: sessionStore as never,
    });

    await expect(
      readExternalSubagentSessionId({
        sessionId: "s2",
        agentId: "agent_a",
        sessionStore: sessionStore as never,
      }),
    ).resolves.toBeUndefined();
  });

  it("同一实例重复写回是覆盖而不是追加", async () => {
    const sessionStore = createStore();
    for (const id of ["sess-1", "sess-2"]) {
      await saveExternalSubagentSessionId({
        sessionId: "s1",
        agentId: "agent_a",
        externalSessionId: id,
        sessionStore: sessionStore as never,
      });
    }

    expect(sessionStore.entries).toHaveLength(1);
    expect(
      await readExternalSubagentSessionId({
        sessionId: "s1",
        agentId: "agent_a",
        sessionStore: sessionStore as never,
      }),
    ).toBe("sess-2");
  });

  it("没有记录时返回 undefined（语义 = 开新会话，不阻塞执行）", async () => {
    await expect(
      readExternalSubagentSessionId({
        sessionId: "s1",
        agentId: "agent_missing",
        sessionStore: createStore() as never,
      }),
    ).resolves.toBeUndefined();
  });

  it("store 不支持 entry 读写时静默退化为不续接", async () => {
    await expect(
      saveExternalSubagentSessionId({
        sessionId: "s1",
        agentId: "agent_a",
        externalSessionId: "sess-1",
        sessionStore: {} as never,
      }),
    ).resolves.toBeUndefined();
    await expect(
      readExternalSubagentSessionId({
        sessionId: "s1",
        agentId: "agent_a",
        sessionStore: {} as never,
      }),
    ).resolves.toBeUndefined();
  });
});
