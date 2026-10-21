import assert from "node:assert/strict";
import test from "node:test";
import { createComposerSubmissionConfig } from "../src/v4/composer/composerSubmissionConfig.js";
import { captureComposerRecentSubmission, readComposerRecent } from "../src/lib/composerRecent.js";
import { initializeNewTaskDraft } from "../src/v4/composer/newTaskDraft.js";
import type { V4ComposerDraft } from "../src/v4/composer/composerDraftStore.js";

/**
 * 上下文档位与权限正交的 UI 契约：提交冻结档位、新任务不继承专用任务/旧组合模式、
 * Recent 不外溢已移除的 zcodeUpdate 与旧 minimal。存储在测试里是内存 fake，不触碰真实 localStorage。
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

const selection = {
  providerId: "fake",
  modelId: "m1",
  options: { reasoningLevel: "low" },
} as never;

test("submission freeze keeps the context profile independent of permission", () => {
  const frozen = createComposerSubmissionConfig(
    { mode: "build", planEnabled: false, contextProfile: "minimal", modelSelection: selection },
    view,
  );
  assert.equal(frozen!.mode, "build");
  assert.equal(frozen!.contextProfile, "minimal", "切档位不改权限、冻结必须带档位");
});

test("legacy guarded+fusion drafts keep the historical profile through submission", () => {
  // 提交正文/同模式重申不是显式选模式：旧 guarded+fusion 历史组合按历史语义执行，
  // 不得借提交静默清掉融合提示词；用户在模式菜单明确选模式时才切入新语义。
  const frozen = createComposerSubmissionConfig(
    { mode: "guarded", planEnabled: false, contextProfile: "fusion", modelSelection: selection },
    view,
  );
  assert.equal(frozen!.mode, "guarded", "重申提交不改写旧权限");
  assert.equal(frozen!.planEnabled, false);
  assert.equal(frozen!.contextProfile, "fusion", "历史融合档位保留到用户明确选模式");
});

test("beta mode freezes through submission as an independent working mode", () => {
  const frozen = createComposerSubmissionConfig(
    { mode: "beta", planEnabled: false, contextProfile: "standard", modelSelection: selection },
    view,
  );
  assert.equal(frozen!.mode, "beta", "Beta 独立模式随提交冻结");
  assert.equal(frozen!.contextProfile, "standard", "Beta 使用完整上下文，不写 fusion 档位");
});

test("legacy build+fusion drafts keep build permissions through submission", () => {
  // 历史兼容：build+fusion 保留原权限；Beta 是完全访问，自动升级会静默提权。
  const frozen = createComposerSubmissionConfig(
    { mode: "build", planEnabled: false, contextProfile: "fusion", modelSelection: selection },
    view,
  );
  assert.equal(frozen!.mode, "build", "build+fusion 不升级为完全访问的 Beta");
  assert.equal(frozen!.contextProfile, "fusion", "历史融合档位保留到用户明确选模式");
});

test("legacy minimal drafts resolve to the minimal profile", () => {
  const frozen = createComposerSubmissionConfig(
    { mode: "minimal", modelSelection: selection },
    view,
  );
  assert.equal(frozen!.mode, "minimal", "旧组合语义保留旧权限标记");
  assert.equal(frozen!.contextProfile, "minimal", "旧 minimal 补出极简档位");
});

test("recent does not propagate removed zcodeUpdate or legacy minimal into new tasks", () => {
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

  // 白名单模式（含 Beta 独立模式）仍可继承。
  captureComposerRecentSubmission(
    "C:/tmp/ws",
    { mode: "edit" as never, modelSelection: selection },
    undefined,
    storage,
  )();
  assert.equal(readComposerRecent("C:/tmp/ws", undefined, storage)?.mode, "edit");

  captureComposerRecentSubmission(
    "C:/tmp/ws",
    { mode: "beta" as never, modelSelection: selection },
    undefined,
    storage,
  )();
  assert.equal(readComposerRecent("C:/tmp/ws", undefined, storage)?.mode, "beta");
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
