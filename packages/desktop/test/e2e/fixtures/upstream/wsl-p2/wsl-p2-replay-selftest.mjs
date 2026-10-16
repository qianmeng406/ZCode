// WSL P2 replay fixture 可复跑自测（不依赖 WSL/WDIO，本地 node 直接跑）。
// 覆盖：无 tools 400 守门、四轮推进（Write→Bash 读校验+append+输出→Read→final）、
// tool_result is_error/缺 marker 不推进、schema 不匹配 400、MCP 前缀工具名匹配、
// stdin end 自退出。用法：node test/e2e/fixtures/upstream/wsl-p2/wsl-p2-replay-selftest.mjs
// 退出码 0=全部通过；任一失败打印 FAIL 行并 exit 1。
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "wsl-p2-replay.mjs");
const workRoot = mkdtempSync(join(tmpdir(), "wslp2-selftest-"));
const workspace = join(workRoot, "ws");
const runId = "selftest";
const fixturePath = `${workspace.split("\\").join("/")}/.zcode-e2e/wsl-p2-${runId}/marker.txt`;

const FILE_MARKER = "E2E_WSLP2_FILE_MARKER_V1";
const FINAL_MARKER = "E2E_WSLP2_ROUND_DONE";

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "OK " : "FAIL"} ${label}${ok ? "" : ` :: ${detail}`}`);
  if (!ok) failures += 1;
}

const child = spawn(process.execPath, [scriptPath], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, REPLAY_RUNID: runId, REPLAY_WORKSPACE: workspace },
});
let stdoutText = "";
let stderrText = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdoutText += chunk;
});
child.stderr.on("data", (chunk) => {
  stderrText += chunk;
});
await new Promise((resolveWait) => setTimeout(resolveWait, 800));
const port = Number(/REPLAY_PORT=(\d+)/.exec(stdoutText)?.[1]);
check("replay-started", Boolean(port), stdoutText + stderrText);

async function post(body) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}
function toolNames(sseText) {
  return [
    ...sseText.matchAll(/"content_block":\{"type":"tool_use","id":"([^"]*)","name":"([^"]*)"/g),
  ].map((match) => match[2]);
}

const tools = [
  { name: "Write", input_schema: { properties: { file_path: {}, content: {} } } },
  { name: "Bash", input_schema: { properties: { command: {} } } },
  { name: "Read", input_schema: { properties: { file_path: {} } } },
];
const round1Messages = [{ role: "user", content: `E2E_WSLP2_${runId} round` }];

// 1) 无 tools：400 守门
const noTools = await post({ model: "m", messages: round1Messages });
check("no-tools-400", noTools.status === 400, `status=${noTools.status}`);
check("no-tools-evidence-logged", stderrText.includes("EVIDENCE request_without_tools"));

// 2) 轮 1：Write tool_use
const round1 = await post({ model: "m", tools, messages: round1Messages });
const round1Names = toolNames(round1.text);
check("round1-write-tooluse", round1Names[0] === "Write", JSON.stringify(round1Names));
check(
  "round1-input-file-path",
  round1.text.includes(".zcode-e2e/wsl-p2-selftest"),
  "fixture path not echoed",
);

// 模拟真实 Write
mkdirSync(dirname(fixturePath), { recursive: true });
writeFileSync(fixturePath, `${FILE_MARKER}\n`);

const writeAckMessages = [
  ...round1Messages,
  {
    role: "assistant",
    content: [{ type: "tool_use", id: "toolu_wslp2_write", name: "Write", input: {} }],
  },
  {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_wslp2_write",
        is_error: false,
        content: "written",
      },
    ],
  },
];
const bashMessages = [
  ...writeAckMessages,
  {
    role: "assistant",
    content: [{ type: "tool_use", id: "toolu_wslp2_bash", name: "Bash", input: {} }],
  },
];

// 3) bash result is_error=true → 不推进（仍 Bash）
const bashError = await post({
  model: "m",
  tools,
  messages: [
    ...bashMessages,
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_wslp2_bash", is_error: true, content: "boom" },
      ],
    },
  ],
});
check(
  "bash-error-not-advance",
  toolNames(bashError.text)[0] === "Bash",
  JSON.stringify(toolNames(bashError.text)),
);

// 4) bash result 缺 marker → 不推进
const bashNoSeen = await post({
  model: "m",
  tools,
  messages: [
    ...bashMessages,
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_wslp2_bash",
          is_error: false,
          content: "unrelated",
        },
      ],
    },
  ],
});
check(
  "bash-no-seen-not-advance",
  toolNames(bashNoSeen.text)[0] === "Bash",
  JSON.stringify(toolNames(bashNoSeen.text)),
);

// 5) 模拟真实 Bash：cat 校验 + append + cat 输出（与 replay 下发的 command 语义一致）
appendFileSync(fixturePath, `${FILE_MARKER}-seen\n`);
const bashOutput = readFileSync(fixturePath, "utf8");
check(
  "bash-output-has-both-lines",
  bashOutput.includes(FILE_MARKER) && bashOutput.includes(`${FILE_MARKER}-seen`),
);

// 6) bash result 含 -seen → 推进 Read
const bashSeen = await post({
  model: "m",
  tools,
  messages: [
    ...bashMessages,
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_wslp2_bash",
          is_error: false,
          content: bashOutput,
        },
      ],
    },
  ],
});
check(
  "bash-seen-advance-read",
  toolNames(bashSeen.text)[0] === "Read",
  JSON.stringify(toolNames(bashSeen.text)),
);

// 7) read result 双 marker → final text
const readResult = await post({
  model: "m",
  tools,
  messages: [
    ...bashSeenMessages(bashMessages, bashOutput),
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_wslp2_read", name: "Read", input: {} }],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_wslp2_read",
          is_error: false,
          content: bashOutput,
        },
      ],
    },
  ],
});
function bashSeenMessages(messages, output) {
  return [
    ...messages,
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_wslp2_bash", is_error: false, content: output },
      ],
    },
  ];
}
check(
  "read-result-final-marker",
  readResult.text.includes(FINAL_MARKER),
  readResult.text.slice(0, 120),
);

// 8) schema 不匹配 → 400
const badTools = [{ name: "Write", input_schema: { properties: { path: {} } } }];
const bad = await post({ model: "m", tools: badTools, messages: round1Messages });
check("schema-mismatch-400", bad.status === 400, `status=${bad.status}`);

// 9) MCP 前缀工具名匹配
const mcpTools = [
  { name: "core__Write", input_schema: { properties: { file_path: {}, content: {} } } },
  { name: "core__Bash", input_schema: { properties: { command: {} } } },
  { name: "core__Read", input_schema: { properties: { file_path: {} } } },
];
const mcpRound1 = await post({ model: "m", tools: mcpTools, messages: round1Messages });
check(
  "mcp-prefix-write",
  toolNames(mcpRound1.text)[0] === "core__Write",
  JSON.stringify(toolNames(mcpRound1.text)),
);

// 续发必须携带前轮真实 Read 历史；新的 lifecycle 请求不能命中旧 final。
const history = [
  ...bashSeenMessages(bashMessages, bashOutput),
  {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_wslp2_read", content: bashOutput }],
  },
];
for (const mode of ["FOLLOW", "BACKGROUND", "CANCEL"]) {
  const messages = [...history, { role: "user", content: `E2E_WSLP2_${runId}_${mode}` }];
  const response = await post({ model: "m", tools, messages });
  check(`lifecycle-${mode}-tool`, toolNames(response.text)[0] === "Bash");
  const deltas = response.text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)))
    .filter((value) => value.delta?.type === "input_json_delta");
  const input = JSON.parse(deltas.map((value) => value.delta.partial_json).join(""));
  if (mode !== "FOLLOW") {
    check(`lifecycle-${mode}-background-flag`, input.run_in_background === (mode === "BACKGROUND"));
  }
  const final = await post({
    model: "m",
    tools,
    messages: [
      ...messages,
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: `toolu_wslp2_${mode.toLowerCase()}`,
            content: bashOutput,
          },
        ],
      },
    ],
  });
  check(`lifecycle-${mode}-result`, final.text.includes(`E2E_WSLP2_${mode}_DONE`));
}

// 10) stdin end → 自退出
child.stdin.end();
const exited = await Promise.race([
  new Promise((resolveExit) => child.once("exit", () => resolveExit(true))),
  new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 4000)),
]);
check("stdin-end-exit", exited === true);

rmSync(workRoot, { recursive: true, force: true });
console.log(failures === 0 ? "SELFTEST_ALL_PASS" : `SELFTEST_FAILED count=${failures}`);
// Windows 下父进程持有 undici keep-alive socket 时强制 process.exit 会触发
// libuv assertion（src/win/async.c UV_HANDLE_CLOSING）把退出码变 127。改用
// exitCode，让事件循环自然排空后以真实退出码收口。
const keepAliveFailure = failures > 0;
process.exitCode = keepAliveFailure ? 1 : 0;
