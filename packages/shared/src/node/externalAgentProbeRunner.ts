// 外部 agent 预设探测的编排逻辑（node-only 导出面 `@zcode/shared/node`）。
//
// 从 bootstrap（zcode-protocol/external-agent-probe.ts）下沉：编排本身只依赖
// "能跑一条命令并回收 stdout"，不依赖 ExecutionPort。拆成回调后两个执行环境共用
// 同一份"哪个 CLI 跑哪条命令、按什么顺序、怎么解析"的知识：
// - bootstrap（会话绑定 v4 RPC）：ExecutionPort.run 适配成回调，远程/容器落在执行机；
// - desktop host（设置页 S6 新增）：child_process 直接实现回调，只探本机。
//
// 只读、无状态、超时安全：同一参数多次调用等价。
// 三条探测的失败语义（都不抛错，UI 需要的是"能不能用"而不是异常）：
// - 版本探测失败 = 未安装/不可执行 → installed: false（基础设施问题时带 probeError）；
// - 模型探测失败 = 空清单 → 调用方退回自由输入，不把"猜不到"呈现成"没有模型"。
import {
  EXTERNAL_AGENT_BINDABLE_PRESETS,
  parseCommandCodeModelCatalog,
  parseCommandCodeModelList,
  parseModelCatalogFromProductJson,
  parseModelListFromHelp,
  parseServerModelCache,
  type ExternalAgentModelInfo,
  type ExternalAgentPreset,
  type ExternalAgentPresetStatus,
} from "../externalAgentCatalog.js";

/** 单次探测命令的输入（环境无关：file/args/cwd + 输出与时间上限）。 */
export interface ExternalAgentProbeCommandInput {
  file: string;
  args: string[];
  cwd: string;
  /** 本次输出的字节上限：读整份 JSON 的探测给 4_000_000 级，普通 `--version` 缺省 64_000。 */
  maxOutputBytes?: number;
  timeoutMs: number;
}

/**
 * 一条探测命令的归一化结果。
 *
 * `failure` 是基础设施层面的（起不来 / 通道断 / 超时 / ENOENT），而不是命令自己
 * 跑完后非零退出——后者是 `ok:false` 且不带 failure。区分开才能让 UI 说
 * "探测失败，可重试"，而不是把"问不到"断言成"没安装"。
 */
export interface ExternalAgentProbeCommandResult {
  ok: boolean;
  stdout: string;
  failure?: string;
}

/** 环境注入的命令执行通道（bootstrap 用 ExecutionPort 适配，desktop 用 child_process）。 */
export type ExternalAgentProbeCommandRunner = (
  input: ExternalAgentProbeCommandInput,
) => Promise<ExternalAgentProbeCommandResult>;

const PROBE_TIMEOUT_MS = 15_000;

/**
 * 探测全部**可绑定**预设（`adaptation === "full"`）。
 *
 * 半适配的预设不进探测：列表里没有它，探测它的版本/模型就没有意义，还会让
 * 对话框多出几条"看起来能选、选了半残"的选项。
 *
 * 并发探测：几条命令互不依赖，串行会让对话框打开慢 N 倍。
 */
export async function probeExternalPresets(options: {
  runCommand: ExternalAgentProbeCommandRunner;
  cwd: string;
}): Promise<ExternalAgentPresetStatus[]> {
  return Promise.all(
    EXTERNAL_AGENT_BINDABLE_PRESETS.map((preset) =>
      probePreset(options.runCommand, preset, options.cwd),
    ),
  );
}

/** 单个预设的探测：先版本，装了才查模型与档位目录。 */
async function probePreset(
  runCommand: ExternalAgentProbeCommandRunner,
  preset: ExternalAgentPreset,
  cwd: string,
): Promise<ExternalAgentPresetStatus> {
  const versionProbe = await runPresetCommand(runCommand, preset.command, ["--version"], cwd);
  if (!versionProbe.ok) {
    // 探测链路本身出错时如实带上 probeError：`installed:false` 此时只表示"没探到"。
    // 少了这个字段，UI 会把它渲染成"未检测到（未安装）"——实测会话冷启动时端口
    // 还没装配，用户看到的就是"我的 OpenCode 明明装了，对话框说没装"。
    return {
      preset,
      installed: false,
      models: [],
      modelCatalog: [],
      ...(versionProbe.failure ? { probeError: versionProbe.failure } : {}),
    };
  }
  const version = versionProbe.stdout.trim().split(/\r?\n/u)[0]?.trim() || undefined;
  const base = { preset, installed: true, ...(version ? { version } : {}) };

  // Command Code 的模型目录（含逐模型档位）在 CLI 自己的缓存里；缓存还没生成时
  // 跑一次 `--list-models` 让 CLI 拉取并落缓存，再读一次。两次都读不到才退回
  // 文本解析（只有 id，没有档位）——不让首次打开对话框变成"没有模型"。
  if (preset.modelSource === "catalog-cache") {
    const cached = await probeCatalogCache(runCommand, preset, cwd);
    if (cached.length > 0) {
      return { ...base, models: cached.map((entry) => entry.id), modelCatalog: cached };
    }
    const listed = await runPresetCommand(runCommand, preset.command, ["--list-models"], cwd, {
      maxOutputBytes: 2_000_000,
    });
    const refreshed = await probeCatalogCache(runCommand, preset, cwd);
    if (refreshed.length > 0) {
      return { ...base, models: refreshed.map((entry) => entry.id), modelCatalog: refreshed };
    }
    return {
      ...base,
      models: listed.ok ? parseCommandCodeModelList(listed.stdout) : [],
      modelCatalog: [],
    };
  }

  // 模型清单来自 CLI 自己的子命令（opencode 的 `models`）：--help 不列模型，
  // 只能跑一次拿逐行输出。档位另取 opencode 的本地模型缓存（见
  // probeOpencodeModelCatalog）——那是唯一逐模型的 reasoning 能力事实。
  if (preset.modelSource === "command" && preset.modelListCommand?.length) {
    const listed = await runPresetCommand(runCommand, preset.command, preset.modelListCommand, cwd);
    // qoder 的 `--list-models` 首行是表头 `MODEL`（预设 modelListSkipHeader 声明）：
    // 不跳过它会被当成一个叫 "MODEL" 的模型混进候选。
    const stdout = listed.ok
      ? preset.modelListSkipHeader
        ? listed.stdout.split(/\r?\n/u).slice(1).join("\n")
        : listed.stdout
      : "";
    const models = listed.ok ? parseModelListLines(stdout) : [];
    return {
      ...base,
      models,
      // 读得到缓存就给逐模型档位；读不到留空 → 调用方退回静态兜底 / 不显示档位。
      modelCatalog:
        preset.effortDelivery === "variant"
          ? await probeOpencodeModelCatalog(runCommand, models, cwd)
          : [],
    };
  }

  // 产品清单优先：它同时给出模型名与逐模型档位，是唯一权威来源。
  const modelCatalog = await probeModelCatalog(runCommand, preset, cwd);
  if (modelCatalog.length > 0) {
    return { ...base, models: modelCatalog.map((entry) => entry.id), modelCatalog };
  }

  // 退回 --help 解析（只有模型名，没有逐模型档位）。
  if (preset.modelSource !== "help-probe") return { ...base, models: [], modelCatalog: [] };
  const helpProbe = await runPresetCommand(runCommand, preset.command, ["--help"], cwd);
  return {
    ...base,
    models: helpProbe.ok ? parseModelListFromHelp(helpProbe.stdout) : [],
    modelCatalog: [],
  };
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
  runCommand: ExternalAgentProbeCommandRunner,
  preset: ExternalAgentPreset,
  cwd: string,
): Promise<ExternalAgentModelInfo[]> {
  if (preset.modelSource !== "server-cache") return [];
  // ── 首选：服务端下发的模型缓存（~/.codebuddy/local_storage/entry_*.info）──
  // 这是 /model 面板的权威来源：模型集合与逐模型档位都来自登录后的服务端目录。
  // 本地 product.json 是构建期快照，与服务端列表对得上（实测差 9 / 13 个模型、
  // 价格过期），只作读不到缓存时的兜底。
  const serverCache = await probeServerModelCache(runCommand, cwd);
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
    "if(/\\.cmd$/i.test(found)){",
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
  const read = await runPresetCommand(runCommand, "node", ["-e", script, preset.command], cwd, {
    maxOutputBytes: 4_000_000,
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
 * 必须在 CLI 所在机器上执行（经 runner 落到目标机），远程会话的缓存在远端；
 * 用 `os.homedir()` 定位，多用户缓存取 ts 最新的一份（解析规则见
 * parseServerModelCache）。失败返回空数组 → 调用方退回 product.json 兜底。
 */
async function probeServerModelCache(
  runCommand: ExternalAgentProbeCommandRunner,
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
  const read = await runPresetCommand(runCommand, "node", ["-e", script], cwd, {
    maxOutputBytes: 4_000_000,
  });
  if (!read.ok || !read.stdout.trim()) return [];
  try {
    return parseServerModelCache(JSON.parse(read.stdout));
  } catch {
    return [];
  }
}

/**
 * 读 Command Code 的模型目录缓存（`~/.commandcode/cache/model-catalog/v1/catalog-*.json`）。
 *
 * 这份缓存由 CLI 自己从服务端拉取并落盘，同时给出模型 id 与逐模型
 * `reasoningEfforts`——是唯一不用登录就能拿到的权威目录。多份缓存按 mtime 取最新，
 * 解析失败/目录不存在一律回空数组（调用方退回 `--list-models` 文本兜底）。
 */
async function probeCatalogCache(
  runCommand: ExternalAgentProbeCommandRunner,
  preset: ExternalAgentPreset,
  cwd: string,
): Promise<ExternalAgentModelInfo[]> {
  const cacheHome = preset.sessionHomeDir ?? ".commandcode";
  const script = [
    "const fs=require('fs'),path=require('path'),os=require('os');",
    `const base=path.join(os.homedir(),${JSON.stringify(cacheHome)},'cache','model-catalog','v1');`,
    "let files=[];try{files=fs.readdirSync(base).filter(f=>f.startsWith('catalog-')&&f.endsWith('.json'));}catch{process.exit(3);}",
    "if(!files.length)process.exit(4);",
    "let best=null;",
    "for(const f of files){try{const p=path.join(base,f);const m=fs.statSync(p).mtimeMs;if(!best||m>best.m)best={p,m};}catch{}}",
    "if(!best)process.exit(5);",
    "process.stdout.write(fs.readFileSync(best.p,'utf8'));",
  ].join("");
  const read = await runPresetCommand(runCommand, "node", ["-e", script], cwd, {
    // 整份目录实测约 67KB；给足上限，避免截断后 JSON.parse 失败被误判成"没有目录"。
    maxOutputBytes: 4_000_000,
  });
  if (!read.ok || !read.stdout.trim()) return [];
  try {
    return parseCommandCodeModelCatalog(JSON.parse(read.stdout));
  } catch {
    return [];
  }
}

/**
 * 探测 opencode 的逐模型档位（从 CLI 自己的模型缓存读）。
 *
 * 档位的权威来源是 `~/.cache/opencode/models.json`：opencode 首次运行时把它从
 * 服务端拉下来，按 `providerID → models[modelID] → reasoning_options[]` 存
 * 每个模型的推理能力。实测（v2.2.5）：
 *
 * - `reasoning:false` 或没有 `reasoning_options` → 该模型没有档位（传 `#low`
 *   会报 `Variant unavailable for <model>: low`）；
 * - `{"type":"toggle"}` → 只是开关语义（开=默认档），不构成可选档位；
 * - `{"type":"effort","values":[...]}` → 就是可选档位集合（如 beam-free 的
 *   `low/medium/high/xhigh/max`，deepseek-v4.1-flash-free 的 `low/high/max`）。
 *
 * 必须读执行机上的文件（远程会话的缓存在远端）。失败一律返回空数组：
 * 档位是可选增强，读不到就让 UI 退回"不给档位选择"，不影响绑定本身。
 */
async function probeOpencodeModelCatalog(
  runCommand: ExternalAgentProbeCommandRunner,
  models: readonly string[],
  cwd: string,
): Promise<ExternalAgentModelInfo[]> {
  if (models.length === 0) return [];
  const script = [
    "const fs=require('fs'),path=require('path'),os=require('os');",
    "const p=path.join(os.homedir(),'.cache','opencode','models.json');",
    "if(!fs.existsSync(p))process.exit(4);",
    "process.stdout.write(fs.readFileSync(p,'utf8'));",
  ].join("");
  const read = await runPresetCommand(runCommand, "node", ["-e", script], cwd, {
    // 整份缓存实测数百 KB（全部 provider 的模型目录）：给足上限，否则截断后
    // JSON.parse 失败，会被误判成"这个 CLI 没有档位信息"。
    maxOutputBytes: 8_000_000,
  });
  if (!read.ok || !read.stdout.trim()) return [];
  try {
    return parseOpencodeModelCatalog(JSON.parse(read.stdout), models);
  } catch {
    return [];
  }
}

/**
 * 把 `models` 子命令的 stdout 转成模型 id 列表（每行一个 `providerID/modelID`）。
 *
 * 去空行、去重、保序（CLI 的输出顺序本身就是用户习惯的顺序）；cap 100 与
 * 单条 120 字符上限是为了不让一条异常的探测输出把对话框撑爆——模型 id 再长
 * 也就几十字符，超出的只可能是 CLI 打了别的东西进来。
 */
export function parseModelListLines(stdout: string): string[] {
  const seen = new Set<string>();
  const models: string[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const id = line.trim();
    if (!id || id.length > 120 || seen.has(id)) continue;
    seen.add(id);
    models.push(id);
    if (models.length >= 100) break;
  }
  return models;
}

/**
 * 把 `models.json` 的 provider 目录映射成逐模型档位。
 *
 * 只认探测到的模型 id（`models` 是 `opencode models` 的权威清单）：缓存里还有
 * 一堆当前 provider 不可用的模型，把它们列进档位候选只会对不上。模型 id 形如
 * `providerID/modelID`，缓存结构是 `{providerID: {models: {modelID: {...}}}}`。
 *
 * 没档位的模型也收录（`supportedEfforts: []`）：调用方据此"不给档位"，而不是
 * 落回一张可能是错的静态表。
 */
export function parseOpencodeModelCatalog(
  raw: unknown,
  models: readonly string[],
): ExternalAgentModelInfo[] {
  if (!raw || typeof raw !== "object") return [];
  const providers = raw as Record<string, unknown>;
  const catalog: ExternalAgentModelInfo[] = [];
  for (const id of models) {
    const slash = id.indexOf("/");
    if (slash <= 0) continue;
    const providerId = id.slice(0, slash);
    const modelId = id.slice(slash + 1);
    const provider = providers[providerId];
    if (!provider || typeof provider !== "object") continue;
    const providerModels = (provider as { models?: unknown }).models;
    if (!providerModels || typeof providerModels !== "object") continue;
    const entry = (providerModels as Record<string, unknown>)[modelId];
    if (!entry || typeof entry !== "object") continue;
    const options = (entry as { reasoning_options?: unknown }).reasoning_options;
    catalog.push({
      id,
      name: id,
      supportedEfforts: Array.isArray(options) ? extractEffortValues(options) : [],
    });
  }
  return catalog;
}

/** 从 `reasoning_options[]` 里取 `type:"effort"` 那一条的 values。 */
function extractEffortValues(options: readonly unknown[]): string[] {
  for (const option of options) {
    if (!option || typeof option !== "object") continue;
    const record = option as { type?: unknown; values?: unknown };
    if (record.type !== "effort" || !Array.isArray(record.values)) continue;
    return record.values
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim());
  }
  return [];
}

/** 带缺省输出上限的命令执行（编排内部统一填 timeout 与缺省 64KB 上限）。 */
async function runPresetCommand(
  runCommand: ExternalAgentProbeCommandRunner,
  file: string,
  args: string[],
  cwd: string,
  limits?: { maxOutputBytes: number },
): Promise<ExternalAgentProbeCommandResult> {
  return runCommand({
    file,
    args,
    cwd,
    timeoutMs: PROBE_TIMEOUT_MS,
    ...(limits?.maxOutputBytes !== undefined ? { maxOutputBytes: limits.maxOutputBytes } : {}),
  });
}
