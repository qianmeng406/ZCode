/**
 * 会话级本机 Linux 执行 — lease/generation 注册表。
 *
 * 规格见 docs/research/session-linux-execution.spec.md：
 * - 执行、poll、取消、后台读取均验证 sessionId + lease + generation + executionId。
 * - 旧代请求拒绝；release 仅由持有匹配 lease 的会话触发，不能释放其他会话资源。
 * - 连接复用与会话 lease 分离：本注册表不持有连接，只持有执行侧状态。
 */

export interface SessionLinuxLeaseInput {
  sessionId: string;
  leaseId: string;
  generation: number;
  /** Linux 端已验证的工作区映射（prepare 产物）。 */
  workspace: SessionLinuxWorkspaceMapping;
  createdAtMs: number;
}

export interface SessionLinuxWorkspaceMapping {
  /** Windows 项目根真源（workspaceIdentity 传入，不迁移）。 */
  windowsPath: string;
  /** Linux 端 realpath 后的项目根（wslpath -u → realpath 验证产物）。 */
  linuxPath: string;
  /** wslpath -w roundtrip 回的 Windows 形式路径；Host 侧做同文件比较。 */
  mappedWindowsPath?: string;
}

export interface SessionLinuxExecutionRecord {
  executionId: string;
  startedAtMs: number;
  /** 后台任务在适配器中的 taskId；前台任务为 undefined。 */
  taskId?: string;
}

export type SessionLinuxScopeCheckFailure =
  | "unknown_lease"
  | "stale_generation"
  | "unknown_execution"
  | "lease_released";

export class SessionLinuxScopeError extends Error {
  readonly code: SessionLinuxScopeCheckFailure;
  constructor(code: SessionLinuxScopeCheckFailure, message: string) {
    super(message);
    this.name = "SessionLinuxScopeError";
    this.code = code;
  }
}

interface LeaseEntry extends SessionLinuxLeaseInput {
  released: boolean;
  executions: Map<string, SessionLinuxExecutionRecord>;
}

export interface CreateSessionLinuxLeaseRegistryOptions {
  now?: () => number;
}

export class SessionLinuxLeaseRegistry {
  private readonly leases = new Map<string, LeaseEntry>();
  private readonly now: () => number;

  constructor(options: CreateSessionLinuxLeaseRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /**
   * 注册新 lease。同一 sessionId 允许并存多代：新代准备成功前旧代仍可用，
   * 提交（切换 admission 成功）由上层 release 旧代。
   */
  register(input: SessionLinuxLeaseInput): void {
    const existing = this.leases.get(input.leaseId);
    if (existing) {
      throw new Error(`lease already registered: ${input.leaseId}`);
    }
    this.leases.set(input.leaseId, {
      ...input,
      released: false,
      executions: new Map(),
    });
  }

  /** 提交新代：显式释放该会话其他 lease（旧代）。仅释放同会话资源。 */
  commitLease(leaseId: string): void {
    const entry = this.leases.get(leaseId);
    if (!entry) {
      throw new SessionLinuxScopeError("unknown_lease", "lease is not active on this server");
    }
    for (const [otherId, other] of this.leases) {
      if (other.sessionId === entry.sessionId && otherId !== leaseId) {
        other.released = true;
        other.executions.clear();
        this.leases.delete(otherId);
      }
    }
  }

  release(leaseId: string): void {
    const entry = this.leases.get(leaseId);
    if (!entry) {
      // release 幂等：未知/已释放 lease 静默返回，不抛错。
      return;
    }
    entry.released = true;
    entry.executions.clear();
    this.leases.delete(leaseId);
  }

  /** 该会话当前持有的全部 leaseId（releaseSession 会话级回收用）。 */
  listSessionLeaseIds(sessionId: string): string[] {
    const ids: string[] = [];
    for (const [leaseId, entry] of this.leases) {
      if (entry.sessionId === sessionId) ids.push(leaseId);
    }
    return ids;
  }

  /** 终止全部 lease（stdin EOF / 退出 barrier），返回受影响的 sessionId 集合。 */
  releaseAll(): Set<string> {
    const sessionIds = new Set<string>();
    for (const entry of this.leases.values()) {
      sessionIds.add(entry.sessionId);
    }
    this.leases.clear();
    return sessionIds;
  }

  getLease(leaseId: string): SessionLinuxLeaseInput | undefined {
    const entry = this.leases.get(leaseId);
    return entry ? { ...entry } : undefined;
  }

  /** prepare 映射完成后补全 workspace（Linux realpath + roundtrip 证据）。 */
  updateWorkspace(leaseId: string, workspace: SessionLinuxWorkspaceMapping): void {
    const entry = this.leases.get(leaseId);
    if (!entry) {
      throw new SessionLinuxScopeError("unknown_lease", "lease is not active on this server");
    }
    entry.workspace = workspace;
  }

  /** 移除单条 execution 登记（start 失败回滚等）。 */
  dropExecution(
    params: { sessionId: string; leaseId: string; generation: number },
    executionId: string,
  ): void {
    const entry = this.leases.get(params.leaseId);
    entry?.executions.delete(executionId);
  }

  /** scope 校验：sessionId + lease + generation 三元必须匹配且未释放。 */
  requireActiveLease(params: {
    sessionId: string;
    leaseId: string;
    generation: number;
  }): SessionLinuxLeaseInput {
    const entry = this.leases.get(params.leaseId);
    if (!entry) {
      throw new SessionLinuxScopeError("unknown_lease", "lease is not active on this server");
    }
    if (entry.sessionId !== params.sessionId || entry.generation !== params.generation) {
      throw new SessionLinuxScopeError("stale_generation", "lease/generation mismatch");
    }
    return { ...entry };
  }

  registerExecution(
    params: { sessionId: string; leaseId: string; generation: number },
    execution: { executionId: string },
  ): void {
    const entry = this.leases.get(params.leaseId);
    if (!entry || entry.released) {
      throw new SessionLinuxScopeError("unknown_lease", "lease is not active on this server");
    }
    this.requireActiveLease(params);
    if (entry.executions.has(execution.executionId)) {
      throw new Error(`execution already registered: ${execution.executionId}`);
    }
    entry.executions.set(execution.executionId, {
      executionId: execution.executionId,
      startedAtMs: this.now(),
    });
  }

  /** 校验 executionId 归属当前 lease；返回记录快照。 */
  requireExecution(
    params: { sessionId: string; leaseId: string; generation: number },
    executionId: string,
  ): { lease: SessionLinuxLeaseInput; execution: SessionLinuxExecutionRecord } {
    const lease = this.requireActiveLease(params);
    const execution = this.leases.get(params.leaseId)?.executions.get(executionId);
    if (!execution) {
      throw new SessionLinuxScopeError(
        "unknown_execution",
        `execution ${executionId} is not owned by this lease`,
      );
    }
    return { lease, execution: { ...execution } };
  }

  /** 更新 execution 记录（如补记后台 taskId）。 */
  updateExecution(
    params: { sessionId: string; leaseId: string; generation: number },
    executionId: string,
    update: Partial<Pick<SessionLinuxExecutionRecord, "taskId">>,
  ): void {
    const entry = this.leases.get(params.leaseId);
    const execution = entry?.executions.get(executionId);
    if (!entry || !execution) {
      throw new SessionLinuxScopeError("unknown_execution", "execution not found");
    }
    entry.executions.set(executionId, { ...execution, ...update });
  }

  /** 列出 lease 下所有 execution（dispose 时逐个终止）。 */
  listExecutions(leaseId: string): SessionLinuxExecutionRecord[] {
    const entry = this.leases.get(leaseId);
    return entry ? [...entry.executions.values()] : [];
  }

  size(): number {
    return this.leases.size;
  }
}
