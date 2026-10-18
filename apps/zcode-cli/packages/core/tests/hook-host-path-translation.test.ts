import { describe, expect, it, vi } from "vitest";
import {
  HookEventName,
  SessionEventType,
  createSessionId,
  createTraceId,
  createTurnId,
  type ExecutionPort,
  type ExecutionRequest,
  type HookInput,
  type SessionEvent,
} from "@zcode/contracts";
import { createConfiguredHookRunner } from "../src/hooks/index.js";

/**
 * hook 宿主路径翻译（会话 Linux 执行环境）。
 *
 * 现场缺陷：官方插件 hook 命令 `python3 "${CLAUDE_PLUGIN_ROOT}/hooks/check_video_input.py"`
 * 的 `${CLAUDE_PLUGIN_ROOT}` 展开成 Windows 插件目录，被原样交给 WSL shell——`C:\...` 被当
 * 相对路径拼到 cwd（`/mnt/c/.../agent/C:\...`），python3 打不开文件退非零码，hook 被
 * 当成拦阻（fail-closed）。该脚本本身从不 block，于是 Linux 会话里每条 prompt 都被拦下。
 */

const WORKSPACE = "C:\\Users\\me\\project";
const PLUGIN_ROOT = "C:\\Users\\me\\.zcode\\cli\\plugins\\cache\\official\\video-agent-kit\\0.4.3";

function createResult(now: Date) {
  return {
    status: "completed" as const,
    exitCode: 0,
    stdout: { text: "", bytes: 0, truncated: false },
    stderr: { text: "", bytes: 0, truncated: false },
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    startedAt: now,
    completedAt: now,
  };
}

/** 记录 hook 实际下发到执行端口的请求；translateHostPath 按「Linux 借用端口」语义提供。 */
function createRecordingPort(options: { translate?: (path: string) => Promise<string | null> }) {
  const requests: ExecutionRequest[] = [];
  const port = {
    async run(request: ExecutionRequest) {
      requests.push(request);
      return createResult(new Date());
    },
    ...(options.translate ? { translateHostPath: options.translate } : {}),
  } as unknown as ExecutionPort;
  return { port, requests };
}

/** 与真实 Linux 借用端口同源：Windows 盘路径 → /mnt/<drive>/...，其余不可映射。 */
function wslLikeTranslate(path: string): Promise<string | null> {
  const match = /^([A-Za-z]):\\(.*)$/.exec(path);
  if (!match) return Promise.resolve(null);
  return Promise.resolve(`/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`);
}

function promptInput(): HookInput {
  return {
    cwd: WORKSPACE,
    hookEventName: HookEventName.UserPromptSubmit,
    mode: "build",
    prompt: "hello",
    sessionId: createSessionId("hook-path-translation"),
    timestamp: new Date().toISOString(),
    traceId: createTraceId(),
    turnId: createTurnId("turn-1"),
  } as HookInput;
}

function createRunner(port: ExecutionPort, events: SessionEvent[] = []) {
  return createConfiguredHookRunner({
    config: {
      enabled: true,
      events: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: 'python3 "${CLAUDE_PLUGIN_ROOT}/hooks/check_video_input.py"',
                plugin: {
                  dataPath: `${PLUGIN_ROOT}\\data`,
                  id: "video-agent-kit@zcode-plugins-official",
                  name: "video-agent-kit",
                  rootPath: PLUGIN_ROOT,
                  sourcePath: `${PLUGIN_ROOT}\\hooks\\hooks.json`,
                },
              },
            ],
          },
        ],
      },
      maxOutputBytes: 1_024,
      timeoutMs: 60_000,
    },
    emitEvent: async (event) => {
      events.push(event);
    },
    executionPort: port,
    getWorkingDirectory: () => WORKSPACE,
  });
}

function commandOf(requests: ExecutionRequest[]): string {
  const command = requests[0]?.command;
  if (!command || command.mode !== "shell") {
    throw new Error("expected a shell command request");
  }
  return command.command;
}

describe("hook 宿主路径翻译", () => {
  it("Linux 借用端口：命令/env/stdin 里的插件与项目路径都落到执行环境", async () => {
    const { port, requests } = createRecordingPort({ translate: wslLikeTranslate });
    await createRunner(port)?.run(promptInput());

    expect(commandOf(requests)).toBe(
      'python3 "/mnt/c/Users/me/.zcode/cli/plugins/cache/official/video-agent-kit/0.4.3/hooks/check_video_input.py"',
    );
    const request = requests[0];
    expect(request.env?.set).toMatchObject({
      CLAUDE_PLUGIN_ROOT: "/mnt/c/Users/me/.zcode/cli/plugins/cache/official/video-agent-kit/0.4.3",
      CLAUDE_PLUGIN_DATA:
        "/mnt/c/Users/me/.zcode/cli/plugins/cache/official/video-agent-kit/0.4.3/data",
      CLAUDE_PROJECT_DIR: "/mnt/c/Users/me/project",
      ZCODE_PROJECT_DIR: "/mnt/c/Users/me/project",
    });
    // cwd 也必须是执行环境路径，否则 Linux shell 起在 Windows 路径上
    expect(request.cwd).toBe("/mnt/c/Users/me/project");
    // stdin 里的 transcript 路径同属宿主临时目录，必须一起翻译
    const stdin = JSON.parse(String(request.stdin)) as { transcript_path?: string };
    expect(stdin.transcript_path?.startsWith("/mnt/c/")).toBe(true);
    // 原始 Windows 路径不得出现在下发请求里（现场缺陷就是它漏进去了）
    expect(JSON.stringify(request)).not.toContain("C:\\\\Users");
  });

  it("不可映射时显式失败：报出变量名与宿主路径，且不下发任何执行请求", async () => {
    const { port, requests } = createRecordingPort({ translate: async () => null });
    const events: SessionEvent[] = [];
    const runner = createRunner(port, events);

    await runner?.run(promptInput());

    // 不把宿主路径交给执行环境：一个请求都不发
    expect(requests).toHaveLength(0);
    const failure = events.find((event) => event.type === SessionEventType.HookRunFailed);
    expect(failure).toBeDefined();
    const payload = JSON.stringify(failure?.payload);
    expect(payload).toContain(
      "Hook variable CLAUDE_PROJECT_DIR points to a host path that cannot be used in this execution environment: C:\\\\Users\\\\me\\\\project",
    );
  });

  it("执行端口没有翻译能力（本机默认）时保持原样，不引入新行为", async () => {
    const { port, requests } = createRecordingPort({});
    await createRunner(port)?.run(promptInput());

    expect(commandOf(requests)).toBe(`python3 "${PLUGIN_ROOT}/hooks/check_video_input.py"`);
    expect(requests[0].cwd).toBe(WORKSPACE);
  });

  it("已是执行环境绝对路径的值不做二次翻译", async () => {
    const translate = vi.fn(async (path: string) => `/mapped${path.replace(/\\/g, "/")}`);
    const { port, requests } = createRecordingPort({ translate });
    const events: SessionEvent[] = [];
    const runner = createConfiguredHookRunner({
      config: {
        enabled: true,
        events: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  command: 'sh "${ZCODE_PLUGIN_ROOT}/hooks/run.sh"',
                  plugin: {
                    dataPath: "/home/me/plugin-data",
                    id: "p@example",
                    name: "P",
                    rootPath: "/home/me/plugin",
                    sourcePath: "/home/me/plugin/hooks/hooks.json",
                  },
                },
              ],
            },
          ],
        },
        maxOutputBytes: 1_024,
        timeoutMs: 60_000,
      },
      emitEvent: async (event) => {
        events.push(event);
      },
      executionPort: port,
      getWorkingDirectory: () => "/workspace",
    });

    await runner?.run({ ...promptInput(), cwd: "/workspace" });

    // 插件路径已是 POSIX 绝对路径 → 不送翻译器（翻译器只处理宿主路径，如 Windows 临时目录）
    expect(
      translate.mock.calls.map((call) => call[0]).every((value) => !value.startsWith("/")),
    ).toBe(true);
    expect(requests[0].env?.set).toMatchObject({
      ZCODE_PLUGIN_ROOT: "/home/me/plugin",
      ZCODE_PLUGIN_DATA: "/home/me/plugin-data",
      ZCODE_PROJECT_DIR: "/workspace",
    });
    expect(commandOf(requests)).toBe('sh "/home/me/plugin/hooks/run.sh"');
  });
});
