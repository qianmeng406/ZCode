// 等一个后台外部 agent 任务收口（两个工具共用）。
//
// 为什么单独一个文件：DelegateToExternalAgent 的有界内联等待与
// GetExternalAgentTaskResult 的阻塞等待必须是**同一套语义**——旧端口轮询节拍、
// 超时只结束等待不取消任务、abort 立即返回。两处各写一份，迟早会漂。
import type { ExternalAgentPort, ExternalAgentTaskSnapshot } from "@zcode/contracts";

/** 旧执行端没有事件驱动 wait 时的轮询节拍（仍然比模型自己 sleep 及时）。 */
const WAIT_POLL_INTERVAL_MS = 1_000;

/**
 * 等到任务收口或等满 `waitMs`，返回当时的快照；未知 taskId 返回 undefined。
 *
 * - `waitMs <= 0`：只看一眼，立刻返回（不阻塞）；
 * - 端口有 `wait`：事件驱动，任务收口当刻返回；
 * - 端口没有 `wait`（旧执行端）：1 秒轮询兜底，语义对模型不变。
 */
export async function waitForExternalAgentTask(
  port: ExternalAgentPort,
  taskId: string,
  waitMs: number,
  signal: AbortSignal | undefined,
): Promise<ExternalAgentTaskSnapshot | undefined> {
  if (waitMs > 0 && port.wait) return await port.wait(taskId, { timeoutMs: waitMs, signal });
  const poll = port.poll;
  if (!poll) return await port.wait?.(taskId, { timeoutMs: 0 });
  if (waitMs <= 0) return await poll(taskId);
  const deadline = Date.now() + waitMs;
  let snapshot = await poll(taskId);
  while (snapshot?.status === "running" && Date.now() < deadline) {
    if (signal?.aborted === true) break;
    const sleepMs = Math.min(WAIT_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()));
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
    snapshot = await poll(taskId);
  }
  return snapshot;
}
