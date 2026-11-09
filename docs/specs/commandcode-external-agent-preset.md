# Command Code CLI 外部主控预设

## 背景

外部 Agent 主控模式通过绑定对话框选择已适配的 CLI，把执行委派给外部进程，并在活动卡、
续接菜单与上下文面板中展示它的过程与会话。本规格定义 `command-code`（Command Code，
包名 `command-code`，Linux/macOS 可执行名 `cmd`，Windows 必须用 `command-code` 或
`cmdc`，因为 `cmd` 是系统 shell）的适配契约。

实测版本：`command-code` 1.88.5（2026-11-09，Linux）。

## 调用形状

- 非交互入口：`<command> -p --output-format json`。
- prompt 一律走 stdin（与 claude-family 同因：避免 Windows `.cmd` shim 截断多行与
  8191 字符上限）。
- 模型：`--model <id>`；推理档位：`--effort <level>`（逐模型能力，见下）。
- 权限：headless 默认拒绝写文件与执行 shell；必须追加 `--yolo`（`--permission-mode yolo`
  在 headless 下不解除限制）。预设以 `permissionMode: "yolo"` 声明，invocation 翻译为
  `--yolo`。
- 非交互信任：追加 `--trust` 跳过项目信任提示，`--skip-onboarding` 跳过 taste onboarding。
- 续接：`-r <sessionId>`（headless 模式支持显式 id；裸 `--resume` 会报错）。
- 输出：NDJSON。事件帧 `{"type":"event","event":{...}}`，最后一行为
  `{"type":"result","subtype":"success|error|max_turns","finalText","sessionId?","error?"}`。

## 模型与档位

- 模型目录与逐模型档位来自 CLI 自己的模型目录缓存：
  `~/.commandcode/cache/model-catalog/v1/catalog-*.json` 的 `body.data[]`。
  每项含 `id`、`name`、`display.label`、`display.order`、`reasoningEfforts[]`；
  `hidden: true` 的条目 CLI 不展示，必须跳过（实测 110 条里 14 条 hidden，
  过滤后正好等于 `--list-models` 的 96 条）。
- 探测优先读该缓存；缓存不存在时跑一次 `--list-models`（CLI 会拉取并落缓存）后重读；
  仍读不到则解析 `--list-models` 的表格行作为只有 id 的兜底。
- 档位是模型能力：缓存里 `reasoningEfforts` 为空的模型不提供档位入口（不回落到
  CLI 级缺省档，避免给不支持推理的模型显示无效选项）。
- 模型 id 大小写敏感（如 `moonshotai/Kimi-K3.1-Pro`），必须原样使用缓存/目录中的 id。

## 会话落盘

- 目录：`~/.commandcode/projects/<project-slug>/<session-id>.jsonl`，与本规格配套的
  slug 规则是 `@sindresorhus/slugify`：小写、音标折叠、非 `[a-z0-9]` 连续段折叠为 `-`，
  空结果回 `root`。
- 首行是头：`{"type":"session","version":3,"id","timestamp","cwd"}`。
- 其后每行一个条目（V3，免费模型实跑落盘）：`{"type":"message","id","parentId",
  "timestamp","message":{"role","content","meta"}}`；`message.meta.isMeta === true`
  是 CLI 注入元数据，列表与上下文都跳过。旧版扁平 `{role,content,metadata}` 也兼容。
- `content` 是 Anthropic 形状的 part 数组：
  - `{type:"text",text}` / `{type:"thinking",thinking}`；
  - `{type:"tool_use",id,name,input}`；
  - 工具结果挂在 user 消息里：`{type:"tool_result",tool_use_id,content:[{type:"text",text}]}`。
  - 旧版 V2 的 `{type:"reasoning"/"tool-call"/"tool-result",...}` 也兼容。
- 时间戳可能是 ISO 字符串或 epoch ms；列表的 `updatedAt` 统一换算为 epoch ms，
  读不到时回落文件 mtime。
- 会话列表只收 transcript：`<id>.checkpoints.jsonl` / `<id>.prompts.jsonl` 是侧车，
  不能当成额外会话。
- 删除会话时同时清理 `<id>.jsonl` 与侧车（`.meta.json` / `.share.json` /
  `.checkpoints.jsonl` / `.prompts.jsonl` / `.scheduled-tasks.json` / `.v2.bak`）及
  `~/.commandcode/file-history/<id>`。

## 过程流

- 正文/思考来自增量事件 `text_delta` / `thinking_delta`：解析器先累积到缓冲区，
  在 `tool_running`、`message_start`、`result` 或收口时整段产出，避免一屏碎片。
  `thinking_end` 自带整段文本时优先用它（更抗丢帧）。
- 工具调用以 `tool_running`（`toolName`、`description`）为准；`message_update` 里的
  tool part 不重复产出。
- 收口时用全量 stdout 重新解析并整体替换活动条目（与 claude-family/opencode 同一纪律）。

## 验收

- 绑定对话框出现「Command Code」，模型来自本机缓存，档位逐模型正确。
- 委派 invocation 为 `-p --output-format json --trust --skip-onboarding [--model]
  [--effort] --yolo [-r id]`，prompt 在 stdin。
- `--output-format json` 的 result 帧解析出正文、错误与 `sessionId`。
- 续接菜单能列出该 cwd 下的 headless 会话；上下文面板能还原用户/助手/工具条目。

## 未验证项

- 已用免费模型 `reflection/beam:free` 完成真实 `-p` 调用（两次：纯文本回复与一次
  `shell_command` 工具调用），验证了 result 帧、活动流与 V3 会话落盘解析。免费模型
  同样需要账号凭据（`COMMAND_CODE_API_KEY`）。
- `-r <sessionId>` 指向已失效 id 时 CLI 是报错还是自动新开会话未实测；按文档只
  确认了裸 `--resume` 在 headless 会报错。
- 服务端模型目录会变化，缓存过期后以 CLI 重新拉取的目录为准。
