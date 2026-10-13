import assert from "node:assert/strict";
import test from "node:test";
import type { QueueItem } from "@zcode/shared/zcode-protocol-v4";
import { inputIntentMetadataFromQueueItem } from "../src/zcode-protocol-v4/commands/input-intent.js";

/**
 * 端到端下半程的接缝：计划批准产生的换模 follow-up 以队列项形式等待提升
 * （sendQueuedNow 用 getQueueItem 取回原项 → inputIntentMetadataFromQueueItem
 * 还原 intent → startPromptTurn）。若这里丢失 modelSelection，提升后的执行回合
 * 会以会话原模型启动——现象正是「批准时选了执行模型却没切换」。
 * 本测试锁定「队列项 → 提升 intent」的模型选择保真。
 */

/** 只填该函数读取的字段，避开与投影 schema 的字段级耦合。 */
function queueItem(fields: { modelSelection?: QueueItem["modelSelection"] }): QueueItem {
  return {
    sourceCommandId: "plan_exit_approved_call-1",
    queueItemId: "plan_exit_approved_call-1",
    clientId: "plan_exit_approved_call-1",
    kind: "sendText",
    text: "The plan was approved. The user selected custom-provider/deepseek/deepseek-v4.1-flash.",
    attachments: [],
    ...(fields.modelSelection ? { modelSelection: fields.modelSelection } : {}),
    delivery: { requested: "queue", admitted: "queue" },
    order: { admissionSeq: 0, queuePosition: 1 },
    steer: {},
    dispatch: { state: "queued" },
    admittedAt: 1,
  } as unknown as QueueItem;
}

test("队列项携带的执行模型：提升 intent 原样保留（含推理档）", () => {
  const selection = {
    providerId: "custom-provider",
    modelId: "deepseek/deepseek-v4.1-flash",
    options: { reasoningLevel: "high" },
  };
  const intent = inputIntentMetadataFromQueueItem(queueItem({ modelSelection: selection }), "text");

  assert.deepEqual(intent.modelSelection, selection);
  // 提升只改调度状态；来源与队列车道必须一起保留，否则新回合无法按车道启动。
  assert.equal(intent.sourceCommandId, "plan_exit_approved_call-1");
  assert.equal(intent.queueItemId, "plan_exit_approved_call-1");
  assert.equal(intent.requestedDelivery, "queue");
  assert.equal(intent.kind, "sendText");
});

test("队列项不携带模型：提升 intent 不带 modelSelection（普通排队输入行为不变）", () => {
  const intent = inputIntentMetadataFromQueueItem(queueItem({}), "text");

  assert.equal(intent.modelSelection, undefined);
  assert.equal(intent.requestedDelivery, "queue");
});
