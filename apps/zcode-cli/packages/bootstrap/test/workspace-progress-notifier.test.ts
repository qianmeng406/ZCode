import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceGenerateTextProgressNotifier } from "../src/zcode-protocol/server-operations.js";

/**
 * 通知器节流语义单测：连续工具调用不得被 500ms 窗口折叠（否则 UI 工具列表漏记），
 * 而字符流进度仍按窗口合并。
 */
function collectNotifier() {
  const notifications: Array<Record<string, unknown>> = [];
  const notifier = createWorkspaceGenerateTextProgressNotifier({
    notify: (notification) => {
      notifications.push(notification.params as Record<string, unknown>);
    },
    operationId: "op-1",
    workspacePath: "/repo",
    querySource: "oracle_deep_review",
  });
  return { notifier, notifications };
}

test("连续工具事件不被节流折叠，字符进度仍按窗口合并", () => {
  const { notifier, notifications } = collectNotifier();

  notifier.onProgress({ outputChars: 10, round: 1 });
  // 立刻连发三次不同工具调用（同一 500ms 窗口内）
  notifier.onProgress({ outputChars: 10, round: 1, toolName: "Read", toolTarget: "a.ts" });
  notifier.onProgress({ outputChars: 10, round: 1, toolName: "Grep", toolTarget: "TODO" });
  notifier.onProgress({ outputChars: 10, round: 1, toolName: "Bash", toolTarget: "git log" });

  const toolNames = notifications.map((n) => n.toolName).filter(Boolean);
  assert.deepEqual(toolNames, ["Read", "Grep", "Bash"]);

  // 字符流增量在窗口内被合并：多次 delta 不新增通知
  const before = notifications.length;
  notifier.onProgress({ outputChars: 11, round: 1 });
  notifier.onProgress({ outputChars: 12, round: 1 });
  assert.equal(notifications.length, before);
});

test("同一工具的重复进度不重复发工具事件，flush 补发尾包", () => {
  const { notifier, notifications } = collectNotifier();
  notifier.onProgress({ outputChars: 5, round: 1, toolName: "Read", toolTarget: "a.ts" });
  const afterFirst = notifications.length;
  // 同工具同目标再次上报（无变化）→ 不新增工具事件
  notifier.onProgress({ outputChars: 5, round: 1, toolName: "Read", toolTarget: "a.ts" });
  assert.equal(notifications.length, afterFirst);
  // flush：有未上报字符时补发尾包
  notifier.onProgress({ outputChars: 42, round: 1 });
  notifier.flush();
  assert.equal(notifications[notifications.length - 1]?.outputChars, 42);
});

test("可见正文增量窗口合并后随下一次通知一次带出，不丢不重", () => {
  const { notifier, notifications } = collectNotifier();
  notifier.onProgress({ outputChars: 10, round: 1, textDelta: "第一段" });
  assert.equal(notifications[0]?.textDelta, "第一段");

  // 窗口内的连续正文增量被合并，不单独发通知
  const before = notifications.length;
  notifier.onProgress({ outputChars: 13, round: 1, textDelta: "第二" });
  notifier.onProgress({ outputChars: 15, round: 1, textDelta: "段" });
  assert.equal(notifications.length, before);

  notifier.flush();
  assert.equal(notifications.length, before + 1);
  assert.equal(notifications[notifications.length - 1]?.textDelta, "第二段");
  // 已发送的增量不重复带出：收尾再 flush 不产生空 textDelta 通知
  notifier.flush();
  assert.equal(notifications.length, before + 1);
});

test("工具事件带出待发正文并清空，避免轮末丢尾", () => {
  const { notifier, notifications } = collectNotifier();
  notifier.onProgress({ outputChars: 10, round: 1 });
  // 同一窗口内先产生正文，再进入工具阶段（深审轮末顺序）
  notifier.onProgress({ outputChars: 12, round: 1, textDelta: "结" });
  notifier.onProgress({ outputChars: 13, round: 1, textDelta: "论" });
  notifier.onProgress({ outputChars: 13, round: 1, toolName: "Read", toolTarget: "a.ts" });

  const toolNotification = notifications[notifications.length - 1];
  assert.equal(toolNotification?.toolName, "Read");
  assert.equal(toolNotification?.textDelta, "结论");

  // 下一次工具事件没有新正文时不携带空字段
  notifier.onProgress({ outputChars: 13, round: 1, toolName: "Grep", toolTarget: "TODO" });
  assert.equal("textDelta" in (notifications[notifications.length - 1] ?? {}), false);
});

test("思考增量只推进字符数，不产生正文", () => {
  const { notifier, notifications } = collectNotifier();
  notifier.onProgress({ outputChars: 8, round: 1 });
  notifier.flush();
  assert.equal("textDelta" in (notifications[notifications.length - 1] ?? {}), false);
});
