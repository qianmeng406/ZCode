import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CACHE_FORMAT_VERSION,
  cacheRecordPath,
  computeCacheKey,
  decideGateOutcome,
  parsePrePushInput,
  runPrePushGate,
} from "../pre-push-gate.mjs";

const HEAD_SHA = "1".repeat(40);
const BASE_SHA = "2".repeat(40);
const ZERO_SHA = "0".repeat(40);
const CLEAN = "";
const DIRTY = " M packages/services/src/example.ts\n";
/** 与注入的 env.npm_config_user_agent 一致，确保测试里算出的键和脚本一致。 */
const TEST_USER_AGENT = "pnpm/10.33.2";

function makeCacheDir() {
  return mkdtempSync(join(tmpdir(), "zcode-prepush-cache-"));
}

function makeEntry(baseSha = BASE_SHA) {
  return {
    localRef: "refs/heads/main",
    localSha: HEAD_SHA,
    remoteRef: "refs/heads/main",
    remoteSha: baseSha,
  };
}

function makeEnv(extra = {}) {
  return {
    ZCODE_PRE_PUSH_STDIN: `refs/heads/main ${HEAD_SHA} refs/heads/main ${BASE_SHA}`,
    npm_config_user_agent: TEST_USER_AGENT,
    ...extra,
  };
}

function baseKey(overrides = {}) {
  return computeCacheKey({
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    nodeVersion: process.version,
    pnpmVersion: TEST_USER_AGENT,
    platform: process.platform,
    ...overrides,
  });
}

test("parsePrePushInput 解析推送范围并容忍异常输入", () => {
  const parsed = parsePrePushInput(
    [
      `refs/heads/main ${HEAD_SHA} refs/heads/main ${BASE_SHA}`,
      `refs/heads/new ${HEAD_SHA} refs/heads/new ${ZERO_SHA}`,
      "malformed line",
      `refs/heads/short not-a-sha refs/heads/short ${BASE_SHA}`,
      "",
    ].join("\n"),
  );
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].baseSha, BASE_SHA);
  assert.equal(parsed[1].baseSha, ZERO_SHA, "新分支的全零 base 保留原值");
  assert.deepEqual(parsePrePushInput(""), []);
  assert.deepEqual(parsePrePushInput(undefined), []);
});

test("computeCacheKey 对推送范围与工具链环境敏感且稳定", () => {
  assert.equal(baseKey(), baseKey());
  const variants = [
    { baseSha: "3".repeat(40) },
    { headSha: "4".repeat(40) },
    { nodeVersion: "v25.0.0" },
    { pnpmVersion: "pnpm/9.0.0" },
    { platform: "linux" },
    { scope: "full" },
    { cacheFormatVersion: CACHE_FORMAT_VERSION + 1 },
  ];
  for (const variant of variants) {
    assert.notEqual(baseKey(variant), baseKey(), `变体应改变键：${JSON.stringify(variant)}`);
  }
});

test("decideGateOutcome 只在确定已通过时才命中缓存", () => {
  const record = {
    cacheFormatVersion: CACHE_FORMAT_VERSION,
    finishedAt: "2026-10-18T00:00:00.000Z",
  };
  assert.equal(
    decideGateOutcome({ entries: [makeEntry()], record, worktreeClean: true, disabled: false })
      .action,
    "hit",
  );
  const shouldRun = [
    { entries: [makeEntry()], record, worktreeClean: true, disabled: true },
    { entries: [], record, worktreeClean: true, disabled: false },
    { entries: [makeEntry()], record: undefined, worktreeClean: true, disabled: false },
    { entries: [makeEntry()], record, worktreeClean: false, disabled: false },
    { entries: [makeEntry()], record, worktreeClean: null, disabled: false },
  ];
  for (const scenario of shouldRun) {
    assert.equal(decideGateOutcome(scenario).action, "run", JSON.stringify(scenario));
  }
});

test("门禁失败不写记录，且不会用旧记录掩盖失败", async () => {
  const cacheDir = makeCacheDir();
  try {
    const env = makeEnv({ ZCODE_PREPUSH_CACHE_DIR: cacheDir });
    const recordPath = cacheRecordPath(cacheDir, baseKey());

    // A. 无记录 + 门禁失败：不得写入记录
    let gateCalls = 0;
    const failing = await runPrePushGate({
      env,
      cwd: cacheDir,
      gitStatusPorcelain: () => CLEAN,
      spawnGate: () => {
        gateCalls += 1;
        return 1;
      },
    });
    assert.equal(failing, 1);
    assert.equal(gateCalls, 1, "无记录时跑门禁");
    assert.equal(existsSync(recordPath), false, "失败不写记录");

    // B. 工作区脏（强制跑门禁）+ 存在同键旧记录 + 门禁失败：旧记录必须被清掉
    writeFileSync(recordPath, JSON.stringify({ cacheFormatVersion: CACHE_FORMAT_VERSION }), "utf8");
    const failedAgain = await runPrePushGate({
      env,
      cwd: cacheDir,
      gitStatusPorcelain: () => DIRTY,
      spawnGate: () => {
        gateCalls += 1;
        return 1;
      },
    });
    assert.equal(failedAgain, 1);
    assert.equal(gateCalls, 2, "工作区脏时跑门禁");
    assert.equal(existsSync(recordPath), false, "失败清掉同键旧记录");
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("门禁通过后同一推送范围命中缓存，工作区改动或强制开关使其重跑", async () => {
  const cacheDir = makeCacheDir();
  try {
    const env = makeEnv({ ZCODE_PREPUSH_CACHE_DIR: cacheDir });
    let gateCalls = 0;
    const spawnGate = () => {
      gateCalls += 1;
      return 0;
    };

    assert.equal(
      await runPrePushGate({ env, cwd: cacheDir, gitStatusPorcelain: () => CLEAN, spawnGate }),
      0,
    );
    assert.equal(gateCalls, 1);

    assert.equal(
      await runPrePushGate({ env, cwd: cacheDir, gitStatusPorcelain: () => CLEAN, spawnGate }),
      0,
    );
    assert.equal(gateCalls, 1, "第二次不再跑门禁");

    assert.equal(
      await runPrePushGate({ env, cwd: cacheDir, gitStatusPorcelain: () => DIRTY, spawnGate }),
      0,
    );
    assert.equal(gateCalls, 2, "工作区脏时不使用缓存");

    assert.equal(
      await runPrePushGate({
        env: { ...env, ZCODE_PREPUSH_NO_CACHE: "1" },
        cwd: cacheDir,
        gitStatusPorcelain: () => CLEAN,
        spawnGate,
      }),
      0,
    );
    assert.equal(gateCalls, 3, "强制开关下重跑");
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("不同 ZCODE_GATE_SCOPE 互不复用通过记录", async () => {
  const cacheDir = makeCacheDir();
  try {
    const env = makeEnv({ ZCODE_PREPUSH_CACHE_DIR: cacheDir });
    let gateCalls = 0;
    const spawnGate = () => {
      gateCalls += 1;
      return 0;
    };

    await runPrePushGate({ env, cwd: cacheDir, gitStatusPorcelain: () => CLEAN, spawnGate });
    assert.equal(gateCalls, 1);

    await runPrePushGate({
      env: { ...env, ZCODE_GATE_SCOPE: "full" },
      cwd: cacheDir,
      gitStatusPorcelain: () => CLEAN,
      spawnGate,
    });
    assert.equal(gateCalls, 2, "scope 变化后键不同，必须重跑");

    await runPrePushGate({
      env: { ...env, ZCODE_GATE_SCOPE: "full" },
      cwd: cacheDir,
      gitStatusPorcelain: () => CLEAN,
      spawnGate,
    });
    assert.equal(gateCalls, 2, "同一 scope 再次命中");
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("缺少 stdin 推送范围时始终跑门禁", async () => {
  const cacheDir = makeCacheDir();
  try {
    let gateCalls = 0;
    const status = await runPrePushGate({
      env: { ZCODE_PREPUSH_CACHE_DIR: cacheDir },
      cwd: cacheDir,
      gitStatusPorcelain: () => CLEAN,
      spawnGate: () => {
        gateCalls += 1;
        return 0;
      },
    });
    assert.equal(status, 0);
    assert.equal(gateCalls, 1);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
