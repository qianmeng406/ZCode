// 外部 agent 的本地探测：装没装、什么版本、有哪些模型。
//
// 这是绑定对话框的"事实来源"。对话框本身不跑进程——它只读这里给出的结果，
// 这样 UI 侧没有 spawn 权限，也避免每次打开对话框都探测一遍。
//
// 三条探测各自的失败语义（都不抛错，UI 需要的是"能不能用"而不是异常）：
// - 版本探测失败 = 未安装/不可执行 → installed: false；
// - 模型探测失败 = 空清单 → 对话框退回自由输入，不把"猜不到"呈现成"没有模型"。
import type { ExecutionPort } from "@zcode/contracts";
import {
  EXTERNAL_AGENT_PRESETS,
  cwdToProjectDirName,
  parseModelCatalogFromProductJson,
  parseModelListFromHelp,
  parseServerModelCache,
  scanClaudeFamilySessionFile,
  type ExternalAgentModelInfo,
  type ExternalAgentPreset,
  type ExternalAgentSessionSummary,
} from "@zcode/shared";

/** 一个预设在本机的实测状态。 */
export interface ExternalAgentPresetStatus {
  preset: ExternalAgentPreset;
  installed: boolean;
  /** `--version` 的原始首行（未安装时缺席）。 */
  version?: string;
  /** 模型候选；空 = 该 CLI 不支持枚举（UI 退回自由输入）。 */
  models: string[];
  /**
   * 逐模型的档位事实（从 CLI 自带的模型目录读出）。
   *
   * 这是判断"某模型能选哪些档位"的唯一权威来源：`--help` 的全局值域对具体模型
   * 并不成立，而 CLI 对不支持的档位静默接受，拿错表用户察觉不到。空 = 读不到目录，
   * 调用方退回静态兜底表。
   */
  modelCatalog: ExternalAgentModelInfo[];
}

/** 探测结果的 RPC 形状（只读、无状态、超时重发安全）。 */
export interface ExternalAgentProbeResult {
  agents: ExternalAgentPresetStatus[];
}

const PROBE_TIMEOUT_MS = 15_000;

/**
 * 跑一条短命令并回收输出。
 *
 * 复用 ExecutionPort 而不是自己 spawn：探测与执行走同一条进程边界，
 * 远程/容器会话里的探测因此也能落到正确的工作机上（与 Bash 工具同源）。
 *
 * `outputLimit` 按用途给：读 product.json 需要整份（实测 370KB），默认的 64KB
 * 会把 JSON 截断成片段、解析失败后静默退回静态表——"探测不到"于是被误读成
 * "这个 CLI 没有模型目录"。
 */
async function probeCommand(
  executionPort: ExecutionPort,
  file: string,
  args: string[],
  cwd: string,
  outputLimit?: { maxInlineBytes: number; maxBufferBytes: number },
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const result = (await executionPort.run(
      {
        command: { mode: "argv", file, args },
        cwd,
        timeoutMs: PROBE_TIMEOUT_MS,
        outputLimit: {
          maxInlineBytes: outputLimit?.maxInlineBytes ?? 64_000,
          maxBufferBytes: outputLimit?.maxBufferBytes ?? 64_000,
          persistOutput: "none",
          tailBytes: 8_000,
        },
      },
      {},
    )) as unknown;
    // spawn 失败时端口**不抛错**，而是回一个带 error 的结果且 exitCode 缺席。
    // 只看 exitCode 会把"命令不存在"判成成功——探测的整个意义就没了。
    if (hasExecutionError(result)) return { ok: false, stdout: "" };
    const exitCode =
      typeof (result as { exitCode?: number }).exitCode === "number"
        ? (result as { exitCode: number }).exitCode
        : 0;
    return { ok: exitCode === 0, stdout: readStdout(result) };
  } catch {
    // 命令不存在 / 不可执行 / 超时：一律按"未安装"处理。
    return { ok: false, stdout: "" };
  }
}

/**
 * 端口是否回了执行级错误（spawn_error / timeout / cancelled / output_limit…）。
 *
 * 这是探测"装没装"的唯一可靠判据：命令不存在时端口不抛错，只把 error 放进结果，
 * 而 exitCode 字段是缺席的（不是非零）。
 */
function hasExecutionError(result: unknown): boolean {
  if (!result || typeof result !== "object") return true;
  const error = (result as { error?: unknown }).error;
  if (error !== undefined && error !== null) return true;
  const status = (result as { status?: unknown }).status;
  return status !== undefined && status !== "completed";
}

/**
 * 从端口的 run 结果里取 stdout 文本。
 *
 * 端口实测形状是 `{ stdout: { text, bytes, truncated, tail } }`（对象，不是字符串）；
 * 旧适配器可能直接给字符串。两种都收，取不到回空串——绝不把"取不到"当成失败。
 */
function readStdout(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const record = result as Record<string, unknown>;
  const streams = record.streams;
  if (streams && typeof streams === "object") {
    const fromStreams = readStreamEntry((streams as Record<string, unknown>).stdout);
    if (fromStreams !== undefined) return fromStreams;
  }
  return readStreamEntry(record.stdout) ?? "";
}

/** 单路输出的兼容读取：字符串 / `{text}` / `{tail}` 三种形态。 */
function readStreamEntry(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return undefined;
  const text = (entry as { text?: unknown }).text;
  if (typeof text === "string") return text;
  const tail = (entry as { tail?: unknown }).tail;
  return typeof tail === "string" ? tail : undefined;
}

/**
 * 读取 CLI 自带的产品清单（`product.json`）里的模型目录。
 *
 * 定位方式：让 node 沿 PATH 找到命令的真实文件（压过 .cmd shim / 无扩展名脚本），
 * 再从它往上找 `product.json`。用 `node -e` 而不是在 zcode 进程里拼路径：
 * 远程/容器会话里文件在工作机上，只有子进程读得到。
 *
 * 失败一律返回空数组：探测不可用时调用方退回静态兜底表，不把"读不到"当"没模型"。
 */
async function probeModelCatalog(
  executionPort: ExecutionPort,
  preset: ExternalAgentPreset,
  cwd: string,
): Promise<ExternalAgentModelInfo[]> {
  if (preset.modelSource !== "server-cache") return [];
  // ── 首选：服务端下发的模型缓存（~/.codebuddy/local_storage/entry_*.info）──
  // 这是 /model 面板的权威来源：模型集合与逐模型档位都来自登录后的服务端目录。
  // 本地 product.json 是构建期快照，与服务端列表对得上（实测差 9 / 13 个模型、
  // 价格过期），只作读不到缓存时的兜底。
  const serverCache = await probeServerModelCache(executionPort, cwd);
  if (serverCache.length > 0) return serverCache;

  // ── 兜底：npm 包里的 product.json ──
  const script = [
    "const fs=require('fs'),path=require('path');",
    "const cmd=process.argv[1];",
    "const exts=(process.env.PATHEXT||'.COM;.EXE;.BAT;.CMD').split(';');",
    "const dirs=(process.env.PATH||process.env.Path||'').split(path.delimiter).filter(Boolean);",
    // 扩展名优先、裸名兜底：Windows 裸名多半是跑不了的 sh 脚本。
    "const names=[...(process.platform==='win32'?exts.map(e=>cmd+e.toLowerCase()):[]),cmd];",
    "let found=null;",
    "for(const d of dirs){if(found)break;for(const n of names){const q=path.join(d,n);try{if(fs.statSync(q).isFile()){found=q;break;}}catch{}}}",
    "if(!found)process.exit(2);",
    "const candidates=[found];",
    // npm 的 .cmd shim 只转发到包内真实入口；从 shim 文本里取出那条相对路径。
    // 不用正则拼捕获组（多层转义容易出错）：直接找 node_modules 那一截。
    "if(/\.cmd$/i.test(found)){",
    "  try{const t=fs.readFileSync(found,'utf8');",
    "    const i=t.indexOf('node_modules');",
    "    if(i>=0){",
    "      let rel=t.slice(i);",
    "      rel=rel.split('%*')[0].replace(/[\"\r\n]+$/g,'').trim();",
    "      rel=rel.split('\"')[0];",
    "      candidates.push(path.join(path.dirname(found),rel));",
    "    }",
    "  }catch{}",
    "}",
    "for(const start of candidates){",
    "  let d=path.dirname(start);",
    "  for(let i=0;i<6&&d&&d!==path.dirname(d);i++){",
    "    const p=path.join(d,'product.json');",
    "    if(fs.existsSync(p)){process.stdout.write(fs.readFileSync(p,'utf8'));process.exit(0);}",
    "    d=path.dirname(d);",
    "  }",
    "}",
    "process.exit(3);",
  ].join("");
  // 整份 product.json 实测约 370KB：给足上限，否则截断后 JSON.parse 失败，
  // 会静默退回静态表，把"目录读到了"错判成"没有目录"。
  const read = await probeCommand(executionPort, "node", ["-e", script, preset.command], cwd, {
    maxInlineBytes: 4_000_000,
    maxBufferBytes: 4_000_000,
  });
  if (!read.ok || !read.stdout.trim()) return [];
  try {
    return parseModelCatalogFromProductJson(JSON.parse(read.stdout));
  } catch {
    return [];
  }
}

/**
 * 读服务端模型缓存（codebuddy 的 `~/.codebuddy/local_storage/entry_*.info`）。
 *
 * 必须在 CLI 所在机器上执行（复用 ExecutionPort），远程会话的缓存在远端；
 * 用 `os.homedir()` 定位，多用户缓存取 ts 最新的一份（解析规则见 shared 的
 * parseServerModelCache）。失败返回空数组 → 调用方退回 product.json 兜底。
 */
async function probeServerModelCache(
  executionPort: ExecutionPort,
  cwd: string,
): Promise<ExternalAgentModelInfo[]> {
  const script = [
    "const fs=require('fs'),path=require('path'),os=require('os');",
    "const dir=path.join(os.homedir(),'.codebuddy','local_storage');",
    "if(!fs.existsSync(dir))process.exit(5);",
    "let best=null;",
    "for(const f of fs.readdirSync(dir)){",
    "  if(!f.startsWith('entry_')||!f.endsWith('.info'))continue;",
    "  try{",
    "    const arr=JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'));",
    "    for(const u of (Array.isArray(arr)?arr:[])){",
    "      const d=u&&u.data;",
    "      if(!d||!Array.isArray(d.models)||!d.models.length)continue;",
    "      const ts=typeof u.ts==='number'?u.ts:0;",
    "      if(!best||ts>best.ts)best={ts,d};",
    "    }",
    "  }catch{}",
    "}",
    "if(!best)process.exit(5);",
    "process.stdout.write(JSON.stringify(best.d));",
  ].join("");
  const read = await probeCommand(executionPort, "node", ["-e", script], cwd, {
    maxInlineBytes: 4_000_000,
    maxBufferBytes: 4_000_000,
  });
  if (!read.ok || !read.stdout.trim()) return [];
  try {
    return parseServerModelCache(JSON.parse(read.stdout));
  } catch {
    return [];
  }
}

/** 单个预设的探测：先版本，装了才查模型与档位目录。 */
async function probePreset(
  executionPort: ExecutionPort,
  preset: ExternalAgentPreset,
  cwd: string,
): Promise<ExternalAgentPresetStatus> {
  const versionProbe = await probeCommand(executionPort, preset.command, ["--version"], cwd);
  if (!versionProbe.ok) {
    return { preset, installed: false, models: [], modelCatalog: [] };
  }
  const version = versionProbe.stdout.trim().split(/\r?\n/u)[0]?.trim() || undefined;
  const base = { preset, installed: true, ...(version ? { version } : {}) };

  // 产品清单优先：它同时给出模型名与逐模型档位，是唯一权威来源。
  const modelCatalog = await probeModelCatalog(executionPort, preset, cwd);
  if (modelCatalog.length > 0) {
    return { ...base, models: modelCatalog.map((entry) => entry.id), modelCatalog };
  }

  // 退回 --help 解析（只有模型名，没有逐模型档位）。
  if (preset.modelSource !== "help-probe") return { ...base, models: [], modelCatalog: [] };
  const helpProbe = await probeCommand(executionPort, preset.command, ["--help"], cwd);
  return {
    ...base,
    models: helpProbe.ok ? parseModelListFromHelp(helpProbe.stdout) : [],
    modelCatalog: [],
  };
}

/**
 * 探测全部内置预设。
 *
 * 并发探测：三条命令互不依赖，串行会让对话框打开慢 3 倍。
 */
export async function probeExternalAgents(options: {
  executionPort: ExecutionPort;
  cwd: string;
}): Promise<ExternalAgentProbeResult> {
  const agents = await Promise.all(
    EXTERNAL_AGENT_PRESETS.map((preset) =>
      probePreset(options.executionPort, preset, options.cwd),
    ),
  );
  return { agents };
}

/**
 * 列出某 cwd 的外部会话（claude-family 落盘扫描）。
 *
 * 扫描必须发生在**执行机**上：远程/容器会话里 CLI 的 home 在工作机上，
 * zcode 进程读不到。做法与 probeServerModelCache 同款——`node -e` 内联脚本
 * 在目标机上枚举 `~/.codebuddy/projects/<cwd->/*.jsonl`，把每个文件的行流
 * 原样倒回 stdout（事件之间以 \x00 分隔），宿主侧再按行扫描出概要。
 *
 * 失败语义与探测一致：不抛错，返回空列表（目录不存在 / node 不可用都是
 * "没有可续接的会话"，不是故障）。
 */
export async function listExternalAgentSessions(options: {
  executionPort: ExecutionPort;
  cwd: string;
  limit?: number;
}): Promise<ExternalAgentSessionSummary[]> {
  const limit = options.limit ?? 30;
  const read = await probeCommand(
    options.executionPort,
    "node",
    ["-e", buildExternalAgentSessionsScript(options.cwd)],
    options.cwd,
    { maxInlineBytes: 8_000_000, maxBufferBytes: 8_000_000 },
  );
  if (!read.ok || !read.stdout.trim()) return [];
  return parseExternalAgentSessionsProbe(read.stdout).slice(0, limit);
}

/**
 * 探测脚本源码。
 *
 * 分隔符必须用 `String.fromCharCode(0)` 现算，**不能**把 `\u0000` 写进脚本字面量：
 * argv 里的字面量 NUL 会让 spawn 直接抛 `ERR_INVALID_ARG_VALUE`（Windows 上尤其
 * 明显，因为命令行是单字符串），整条探测静默返回空列表——会话列表永远是空的。
 * 输出流里用 NUL 分隔仍然安全（JSONL 正文不会出现裸 NUL）。
 */
export function buildExternalAgentSessionsScript(cwd: string): string {
  return [
    "const fs=require('fs'),path=require('path'),os=require('os');",
    `const dir=path.join(os.homedir(),'.codebuddy','projects',${JSON.stringify(cwdToProjectDirName(cwd))});`,
    "let files=[];",
    "try{files=fs.readdirSync(dir).filter(f=>f.endsWith('.jsonl'));}catch{process.exit(0);}",
    "const stats=files.map(f=>{try{return {f,m:fs.statSync(path.join(dir,f)).mtimeMs};}catch{return null;}}).filter(Boolean);",
    "stats.sort((a,b)=>b.m-a.m);",
    "const NUL=String.fromCharCode(0);",
    "for(const {f,m} of stats.slice(0,60)){",
    "  let content='';",
    "  try{content=fs.readFileSync(path.join(dir,f),'utf8');}catch{continue;}",
    "  process.stdout.write(NUL+'FILE'+NUL+f+NUL+m+NUL+content.split(NUL).join('')+NUL+'END'+NUL);",
    "}",
  ].join("");
}

/** 宿主侧解析探测输出（与 `buildExternalAgentSessionsScript` 的线格式配对）。 */
export function parseExternalAgentSessionsProbe(
  stdout: string,
): ExternalAgentSessionSummary[] {
  const summaries: ExternalAgentSessionSummary[] = [];
  for (const block of stdout.split("\u0000END\u0000")) {
    const parts = block.split("\u0000FILE\u0000");
    if (parts.length < 2) continue;
    const rest = parts[1]!.split("\u0000");
    const fileName = rest[0] ?? "";
    const mtimeMs = Number(rest[1] ?? 0);
    const content = rest.slice(2).join("\u0000");
    if (!fileName || !content) continue;
    const summary = scanClaudeFamilySessionFile(
      content,
      fileName.slice(0, -".jsonl".length),
      Number.isFinite(mtimeMs) ? mtimeMs : 0,
    );
    if (summary) summaries.push(summary);
  }
  return summaries.sort((left, right) => right.updatedAt - left.updatedAt);
}
