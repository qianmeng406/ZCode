import assert from "node:assert/strict";
import test from "node:test";
import type { RemoteWorkspaceSessionEntry } from "@zcode/shared";
import {
  buildRemoteWorkspaceSessionMutation,
  createRemoteTargetFromSnapshot,
  isResidentRemoteWorkspaceEntry,
} from "@/lib/remoteWorkspaceHistory.js";

/**
 * 常驻模式（Linux SSH resident）的桌面侧专项回归：
 * 1) resident 是连接语义的一部分，持久化快照与重连重建必须双向保留；
 * 2) 断开语义判定与连接选项共用同一助手，两处规则不能漂移。
 * （回合内联的 session-close 处理属 React hook，无法在纯函数测试中覆盖，
 * 其正确性由类型检查与断开判定助手收敛保证。）
 */

function sshSnapshot(resident?: boolean) {
  return {
    kind: "ssh" as const,
    host: "example.com",
    port: 22,
    username: "dev",
    ...(resident ? { resident: true } : {}),
  };
}

function sshTarget(resident?: boolean) {
  return {
    kind: "ssh" as const,
    host: "example.com",
    port: 22,
    username: "dev",
    ...(resident ? { resident: true } : {}),
  };
}

function entryWithTarget(target: Parameters<typeof isResidentRemoteWorkspaceEntry>[0]["target"]) {
  return {
    kind: "remote" as const,
    workspacePath: "/srv/project",
    target,
    lastOpenedAt: 0,
    lastConnectionStatus: "connected" as const,
  } satisfies RemoteWorkspaceSessionEntry;
}

test("快照持久化：resident 目标写入快照；标准目标不带该键", () => {
  const residentMutation = buildRemoteWorkspaceSessionMutation({
    remoteSessions: [],
    workspacePath: "/srv/project",
    target: sshTarget(true),
    lastConnectionStatus: "connected",
    touchOpenedAt: false,
  });
  const residentEntry = residentMutation.nextRemoteSessions[0] as RemoteWorkspaceSessionEntry;
  assert.equal(residentEntry.target.kind, "ssh");
  assert.equal(
    residentEntry.target.kind === "ssh" && residentEntry.target.resident,
    true,
    "resident 必须持久化",
  );

  const standardMutation = buildRemoteWorkspaceSessionMutation({
    remoteSessions: [],
    workspacePath: "/srv/project2",
    target: sshTarget(),
    lastConnectionStatus: "connected",
    touchOpenedAt: false,
  });
  const standardEntry = standardMutation.nextRemoteSessions[0] as RemoteWorkspaceSessionEntry;
  assert.equal(standardEntry.target.kind, "ssh");
  // 缺席即未启用：键不得以 false 形式写入。
  assert.equal(
    standardEntry.target.kind === "ssh" && standardEntry.target.resident,
    undefined,
    "标准目标不得携带 resident",
  );
});

test("重连重建：resident 快照恢复为 resident 目标（含凭据路径）", () => {
  const target = createRemoteTargetFromSnapshot(sshSnapshot(true), {
    password: "secret",
    privateKeyPassphrase: null,
  });
  assert.equal(target.kind === "ssh" && target.resident, true);
  // 凭据与 resident 互不干扰：标准快照不带 resident。
  const standard = createRemoteTargetFromSnapshot(sshSnapshot(), {
    password: "secret",
    privateKeyPassphrase: null,
  });
  assert.equal(standard.kind === "ssh" && standard.resident, undefined);
});

test("断开判定助手：仅 ssh+resident 命中；wsl/docker/标准 ssh 一律不命中", () => {
  assert.equal(isResidentRemoteWorkspaceEntry(entryWithTarget(sshSnapshot(true))), true);
  assert.equal(isResidentRemoteWorkspaceEntry(entryWithTarget(sshSnapshot())), false);
  assert.equal(
    isResidentRemoteWorkspaceEntry(
      entryWithTarget({ kind: "wsl", distro: "Ubuntu-22.04", user: "dev" }),
    ),
    false,
  );
  assert.equal(isResidentRemoteWorkspaceEntry(entryWithTarget({ kind: "docker", container: "c1" })), false);
});
