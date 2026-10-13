import assert from "node:assert/strict";
import test from "node:test";
import { createComposerSubmissionConfig } from "../src/v4/composer/composerSubmissionConfig.js";
import {
  captureComposerRecentSubmission,
  readComposerRecent,
} from "../src/lib/composerRecent.js";
import { initializeNewTaskDraft } from "../src/v4/composer/newTaskDraft.js";
import type { V4ComposerDraft } from "../src/v4/composer/composerDraftStore.js";

/**
 * 上下文档位与权限正交的 UI 契约：提交冻结档位、新任务不继承专用任务/旧组合模式、
 * Recent 不外溢 zcodeUpdate/minimal。存储在测试里是内存 fake，不触碰真实 localStorage。
 */

const view = {
  providers: [
    {
      providerId: "fake",
      models: [
        {
          modelId: "m1",
          config: { optionSpecs: { reasoningLevel: { values: ["low"] } } },
        },
      ],
    },
  ],
} as never;

function fakeStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

const selection = { providerId: "fake", modelId: "m1", options: { reasoningLevel: "low" } } as never;

test("submission freeze keeps the context profile independent of permission", () => {
  const frozen = createComposerSubmissionConfig(
    { mode: "build", planEnabled: false, contextProfile: "minimal", modelSelection: selection },
    view,
  );
  assert.equal(frozen!.mode, "build");
  assert.equal(frozen!.contextProfile, "minimal", "切档位不改权限、冻结必须带档位");
});

test("legacy minimal drafts resolve to the minimal profile", () => {
  const frozen = createComposerSubmissionConfig(
    { mode: "minimal", modelSelection: selection },
    view,
  );
  assert.equal(frozen!.mode, "minimal", "旧组合语义保留旧权限标记");
  assert.equal(frozen!.contextProfile, "minimal", "旧 minimal 补出极简档位");
});

test("recent does not propagate zcodeUpdate or legacy minimal into new tasks", () => {
  const storage = fakeStorage();
  captureComposerRecentSubmission(
    "C:/tmp/ws",
    { mode: "zcodeUpdate" as never, modelSelection: selection },
    undefined,
    storage,
  )();
  captureComposerRecentSubmission(
    "C:/tmp/ws",
    { mode: "minimal" as never, modelSelection: selection },
    undefined,
    storage,
  )();
  const recent = readComposerRecent("C:/tmp/ws", undefined, storage);
  assert.equal(recent?.mode, undefined, "专用任务/旧组合模式不进 Recent");
  assert.ok(recent?.modelSelection, "模型选择照常记录");

  // 白名单模式仍可继承。
  captureComposerRecentSubmission(
    "C:/tmp/ws",
    { mode: "edit" as never, modelSelection: selection },
    undefined,
    storage,
  )();
  assert.equal(readComposerRecent("C:/tmp/ws", undefined, storage)?.mode, "edit");
});

test("new tasks always start with the standard context profile", () => {
  const storage = fakeStorage();
  captureComposerRecentSubmission(
    "C:/tmp/ws",
    { mode: "edit" as never, modelSelection: selection },
    undefined,
    storage,
  )();
  (globalThis as { window?: unknown }).window = { localStorage: storage };
  try {
    const draft = initializeNewTaskDraft(
      { text: "", updatedAt: 0 } as V4ComposerDraft,
      "C:/tmp/ws",
      undefined,
      view,
    );
    assert.equal(draft.mode, "edit", "权限仍按 Recent 继承");
    assert.equal(draft.contextProfile, "standard", "上下文档位不随 Recent 继承");
    assert.equal(draft.planEnabled, false);
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});
