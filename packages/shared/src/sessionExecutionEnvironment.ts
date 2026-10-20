import { z } from "zod";
import { wslUserSchema } from "./wslUserValidation.js";

// ============================================================
// 会话级执行环境（session execution environment）
// ============================================================
// spec: docs/research/session-linux-execution.spec.md
//
// 配置只保存 kind/distro/user；目录映射、lease、generation、PID 等
// 运行态一律不进配置持久化（spec「所有者及接口」第 6 条）。

export const SESSION_EXECUTION_ENVIRONMENT_KINDS = ["local", "wsl"] as const;
export type SessionExecutionEnvironmentKind = (typeof SESSION_EXECUTION_ENVIRONMENT_KINDS)[number];

/** 本机默认执行环境。缺省/未配置时保持现有行为。 */
export interface SessionExecutionEnvironmentLocal {
  kind: "local";
}

/**
 * 本机 WSL 执行环境。distro 必填；user 缺省表示使用该发行版的默认用户
 * （由执行端 `wsl.exe` 自行解析，不修改 WSL 的默认用户配置）。
 */
export interface SessionExecutionEnvironmentWsl {
  kind: "wsl";
  distro: string;
  user?: string;
}

export type SessionExecutionEnvironment =
  | SessionExecutionEnvironmentLocal
  | SessionExecutionEnvironmentWsl;

export const sessionExecutionEnvironmentLocalSchema = z
  .object({ kind: z.literal("local") })
  .strict();

export const sessionExecutionEnvironmentWslSchema = z
  .object({
    kind: z.literal("wsl"),
    // distro 是本机环境批准的一部分：trim 后必须非空且不含控制符/分隔符。
    // user 可缺省/留空 = 使用该发行版默认用户（执行端省略 `-u`，不改 WSL 的默认用户）。
    distro: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .refine((value) => !containsControlCharacter(value) && !/[/\\:]/.test(value), {
        message: "Invalid WSL distro",
      }),
    user: wslUserSchema.optional(),
  })
  .strict();

export const sessionExecutionEnvironmentSchema = z.discriminatedUnion("kind", [
  sessionExecutionEnvironmentLocalSchema,
  sessionExecutionEnvironmentWslSchema,
]);

export function containsControlCharacter(value: string): boolean {
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint < 32 || codePoint === 127) {
      return true;
    }
  }
  return false;
}

/** 空 user（含纯空白）归一为缺省字段，避免持久层出现 `user: ""` 两种等价形态。 */
function normalizeWslUser(environment: SessionExecutionEnvironment): SessionExecutionEnvironment {
  if (environment.kind !== "wsl") return environment;
  const user = environment.user?.trim();
  return user
    ? { kind: "wsl", distro: environment.distro, user }
    : { kind: "wsl", distro: environment.distro };
}

export function parseSessionExecutionEnvironment(
  value: unknown,
): SessionExecutionEnvironment | undefined {
  const parsed = sessionExecutionEnvironmentSchema.safeParse(value);
  return parsed.success ? normalizeWslUser(parsed.data) : undefined;
}

/**
 * 归一化：undefined/null/kind 缺失一律视为未配置（默认 local 行为），
 * local 显式配置与缺省等价，返回 undefined 便于持久层省略空条目。
 */
export function normalizeSessionExecutionEnvironment(
  value: SessionExecutionEnvironment | undefined | null,
): SessionExecutionEnvironment | undefined {
  if (!value) return undefined;
  if (value.kind === "local") return undefined;
  return normalizeWslUser(value);
}

/**
 * 会话执行环境状态投影。UI 只读；pending 表示切换准备进行中，
 * 失败不提交原环境（spec「切换 admission」）。
 */
export type SessionExecutionState =
  | {
      status: "idle";
      environment: SessionExecutionEnvironment;
    }
  | {
      status: "preparing";
      current: SessionExecutionEnvironment;
      target: SessionExecutionEnvironment;
    };

export const sessionExecutionStateSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("idle"),
      environment: sessionExecutionEnvironmentSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("preparing"),
      current: sessionExecutionEnvironmentSchema,
      target: sessionExecutionEnvironmentSchema,
    })
    .strict(),
]);
