import { z } from "zod";
import { isValidWslUser, WSL_USER_MAX_LENGTH } from "./wslUserValidation.js";

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

/** 本机 WSL 执行环境。显式 distro/user 必填（spec：不能借用实验配置作全用户默认）。 */
export interface SessionExecutionEnvironmentWsl {
  kind: "wsl";
  distro: string;
  user: string;
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
    // 显式 distro/user 是本机环境批准的一部分：trim 后必须非空且不含控制符/分隔符。
    // 不复用 remoteTarget 的 wslConnectOptions 缺省语义（那是远程默认发行版语义）。
    distro: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .refine((value) => !containsControlCharacter(value) && !/[/\\:]/.test(value), {
        message: "Invalid WSL distro",
      }),
    user: z
      .string()
      .trim()
      .min(1)
      .max(WSL_USER_MAX_LENGTH)
      .refine((value) => isValidWslUser(value), { message: "Invalid WSL user" }),
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

export function parseSessionExecutionEnvironment(
  value: unknown,
): SessionExecutionEnvironment | undefined {
  const parsed = sessionExecutionEnvironmentSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
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
  return value;
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
