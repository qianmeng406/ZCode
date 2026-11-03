// 委派后的工作区变更摘要（git 可用时）。
//
// 目的：主 agent 在只读模式下看不到外部 agent 改了什么，只能靠对方自述。这里从
// 工作区自身的事实（git status/numstat）汇总一份"改了哪些文件、各增删多少行"，
// 主 agent 据此决定要不要自己读 diff 复审。
//
// 失败语义：非 git 工作区、git 不可用、命令出错一律返回 `unavailable` 或不返回——
// 摘要只是线索，不能因为拿不到就让委派本身失败。
import type { ExecutionPort, ExternalAgentChangeSummary } from "@zcode/contracts";
import { parsePorcelainStatus, parseNumstat } from "./external-agent-changes-parse.js";

const MAX_FILES = 20;

export async function summarizeWorkspaceChanges(options: {
  executionPort: ExecutionPort;
  cwd: string;
}): Promise<ExternalAgentChangeSummary | undefined> {
  const { executionPort, cwd } = options;
  const run = async (args: string[]): Promise<string | undefined> => {
    try {
      const result = (await executionPort.run(
        {
          command: { mode: "argv", file: "git", args },
          cwd,
          timeoutMs: 15_000,
          outputLimit: {
            maxInlineBytes: 512_000,
            maxBufferBytes: 512_000,
            persistOutput: "none",
            tailBytes: 64_000,
          },
        },
        {},
      )) as unknown;
      if (!result || typeof result !== "object") return undefined;
      const record = result as {
        exitCode?: unknown;
        error?: unknown;
        streams?: { stdout?: { text?: unknown } };
        stdout?: { text?: unknown } | string;
      };
      if (record.error !== undefined && record.error !== null) return undefined;
      if (typeof record.exitCode === "number" && record.exitCode !== 0) return undefined;
      const stream = record.streams?.stdout ?? record.stdout;
      if (typeof stream === "string") return stream;
      const text = (stream as { text?: unknown } | undefined)?.text;
      return typeof text === "string" ? text : undefined;
    } catch {
      return undefined;
    }
  };

  const insideWorkTree = await run(["-C", cwd, "rev-parse", "--is-inside-work-tree"]);
  if (!insideWorkTree?.trim().startsWith("true")) {
    return { files: [], truncated: false, unavailable: true };
  }

  const [statusText, numstatText] = await Promise.all([
    run(["-C", cwd, "status", "--porcelain=v1"]),
    // HEAD 对比覆盖已暂存 + 未暂存；无 HEAD（空仓库）时退回工作区 diff。
    run(["-C", cwd, "diff", "HEAD", "--numstat"]),
  ]);
  if (statusText === undefined) return { files: [], truncated: false, unavailable: true };

  const changedPaths = parsePorcelainStatus(statusText);
  if (changedPaths.length === 0) return { files: [], truncated: false };

  const numstat = parseNumstat(numstatText ?? "");
  const files = changedPaths
    .map((path) => {
      const stat = numstat.get(path);
      return { path, added: stat?.added ?? 0, deleted: stat?.deleted ?? 0 };
    })
    .sort((left, right) => right.added + right.deleted - (left.added + left.deleted));

  return {
    files: files.slice(0, MAX_FILES),
    truncated: files.length > MAX_FILES,
  };
}
