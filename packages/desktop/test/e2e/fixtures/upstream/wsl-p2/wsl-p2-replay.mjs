// WSL P2 Linux loopback replay fixture（test-only）。
// 独立文件可用 `node --check` 与本地启动自测，不嵌入 helper 模板转义。
// 协议：anthropic-messages SSE（与 default e2e provider apiFormat 一致）。
// 行为：
// - 无 tools 定义的请求不推进：记录 EVIDENCE 后返回 400，绝不 fallback 猜工具名。
// - 工具只从当轮请求 tools 数组按 name+input_schema 匹配：
//   Write 需 properties 含 file_path+content；Bash 需含 command；Read 需含 file_path。
//   名字可能带 MCP 前缀（xx__Write）：exact 优先，去前缀尾段次之；全不匹配返回 400。
// - 轮次推进条件：对应 toolu_wslp2_* 的 tool_result 必须 is_error=false 且内容命中
//   对应 marker（bash 轮需 FILE-seen；read 轮需 FILE 与 FILE-seen 两行）。
// - 日志只记 tools 名单/阶段布尔/is_error/命中布尔，不输出 header/key/完整请求。
// - 监听 127.0.0.1 随机端口；stdout 输出 REPLAY_PORT/REPLAY_FIXTURE/REPLAY_PID；
//   stdin 关闭后自退出（wsl.exe stdin pipe 传导），供测试 helper 回收。
import { createServer } from "node:http";

const RUN = `E2E_WSLP2_${process.env.REPLAY_RUNID ?? "SELFTEST"}`;
const WORKSPACE = process.env.REPLAY_WORKSPACE ?? "/home/zcodewslp2/workspace";
// 输入安全：workspace/runid 会被拼进远端 sh 单引号串，拒单引号/NUL/换行，fail-fast。
function assertSafeShellValue(value, label) {
  const unsafeCharacters = ["'", "\n", "\r", "\u0000"];
  if (unsafeCharacters.some((character) => value.includes(character))) {
    console.error(`EVIDENCE unsafe_${label}`);
    process.exit(2);
  }
}
assertSafeShellValue(WORKSPACE, "REPLAY_WORKSPACE");
const RUNID_RAW = process.env.REPLAY_RUNID ?? "selftest";
assertSafeShellValue(RUNID_RAW, "REPLAY_RUNID");
const FILE_MARKER = "E2E_WSLP2_FILE_MARKER_V1";
const FINAL_MARKER = "E2E_WSLP2_ROUND_DONE";
const fixturePath = `${WORKSPACE}/.zcode-e2e/wsl-p2-${RUNID_RAW.toLowerCase()}/marker.txt`;

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function textBody(id, text) {
  return [
    sse("message_start", {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: "e2e-wslp2-replay",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 8, output_tokens: 0 },
      },
    }),
    sse("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { input_tokens: 8, output_tokens: 16 },
    }),
    sse("message_stop", { type: "message_stop" }),
  ].join("");
}

function toolUseBody(id, toolId, name, input) {
  return [
    sse("message_start", {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: "e2e-wslp2-replay",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 8, output_tokens: 0 },
      },
    }),
    sse("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: toolId, name, input: {} },
    }),
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { input_tokens: 8, output_tokens: 16 },
    }),
    sse("message_stop", { type: "message_stop" }),
  ].join("");
}

function toolSchemaHasProps(tool, keys) {
  const schema = tool?.input_schema ?? tool?.inputSchema;
  const props = schema?.properties ?? {};
  return keys.every((key) => Boolean(props[key]));
}

function pickTool(tools, candidates, schemaKeys) {
  for (const candidate of candidates) {
    const exact = tools.find(
      (tool) => String(tool.name) === candidate && toolSchemaHasProps(tool, schemaKeys),
    );
    if (exact) return exact.name;
  }
  for (const candidate of candidates) {
    const tail = tools.find((tool) => {
      const name = String(tool.name);
      const tailName = name.includes("__") ? name.split("__").at(-1) : name;
      return tailName === candidate && toolSchemaHasProps(tool, schemaKeys);
    });
    if (tail) return tail.name;
  }
  return null;
}

function toolResultEvidence(messages, toolId) {
  for (const message of messages ?? []) {
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block?.type !== "tool_result" || block?.tool_use_id !== toolId) continue;
      const text =
        typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
      return { isError: Boolean(block.is_error), text };
    }
  }
  return null;
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      // 保持空对象：阶段判定全部落 false，走标题兜底。
    }
    const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const toolNames = tools.map((tool) => String(tool.name)).join(",");
    const writeResult = toolResultEvidence(messages, "toolu_wslp2_write");
    const bashResult = toolResultEvidence(messages, "toolu_wslp2_bash");
    const readResult = toolResultEvidence(messages, "toolu_wslp2_read");
    const hasWriteResult = Boolean(writeResult && !writeResult.isError);
    const hasBashResult = Boolean(
      bashResult && !bashResult.isError && bashResult.text.includes(`${FILE_MARKER}-seen`),
    );
    const hasReadResult = Boolean(
      readResult &&
      !readResult.isError &&
      readResult.text.includes(FILE_MARKER) &&
      readResult.text.includes(`${FILE_MARKER}-seen`),
    );
    // 阶段摘要日志：tools 名单 + 布尔，不含 header/key/完整请求。
    console.log(
      `REQ stage write=${hasWriteResult} bash=${hasBashResult} read=${hasReadResult} tools=[${toolNames}]`,
    );
    const lastUserText =
      [...messages].reverse().flatMap((message) => {
        if (message.role !== "user") return [];
        const text =
          typeof message.content === "string"
            ? message.content
            : (message.content ?? [])
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("\n");
        return text ? [text] : [];
      })[0] ?? "";
    if (tools.length === 0 && /generate a concise title/iu.test(body)) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textBody("msg_title", "WSL workspace acceptance"));
      return;
    }
    // 续发与生命周期仍由真实工具执行；仅选择测试脚本，不伪造工具结果。
    const mode = ["FOLLOW", "CANCEL", "BACKGROUND"].find((kind) =>
      lastUserText.includes(`${RUN}_${kind}`),
    );
    if (mode) {
      const toolId = `toolu_wslp2_${mode.toLowerCase()}`;
      const result = toolResultEvidence(messages, toolId);
      const send = (data) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(data);
      };
      if (result) {
        const valid =
          !result.isError &&
          (mode !== "FOLLOW" || (hasReadResult && result.text.includes(`${FILE_MARKER}-seen`)));
        console.log(`EVIDENCE lifecycle=${mode} toolResult=true valid=${valid}`);
        if (!valid) {
          res.writeHead(400);
          res.end("lifecycle tool failed");
          return;
        }
        send(textBody(`msg_${mode}`, `E2E_WSLP2_${mode}_DONE`));
        return;
      }
      const toolName = pickTool(tools, ["Bash"], ["command"]);
      if (!toolName || (mode === "FOLLOW" && !hasReadResult)) {
        res.writeHead(400);
        res.end("lifecycle schema/history mismatch");
        return;
      }
      if (mode === "FOLLOW") {
        send(
          toolUseBody("msg_follow", toolId, toolName, {
            command: `cat '${fixturePath}'`,
            description: "Read prior turn file in same workspace",
          }),
        );
        return;
      }
      const root = fixturePath.slice(0, -"/marker.txt".length);
      const python =
        mode === "CANCEL"
          ? [
              "import os,time,pathlib",
              `pathlib.Path(${JSON.stringify(`${root}/cancel.pid`)}).write_text(str(os.getpid()))`,
              'print("WSL_CANCEL_RUNNING",flush=True)',
              "time.sleep(90)",
            ].join("; ")
          : [
              "import os,time,pathlib,sys",
              `root=pathlib.Path(${JSON.stringify(root)})`,
              '(root/"background.pid").write_text(str(os.getpid()))',
              'print("WSL_BACKGROUND_FIRST",flush=True)',
              'print("WSL_BACKGROUND_STDERR",file=sys.stderr,flush=True)',
              "deadline=time.monotonic()+60",
              'while not (root/"background.release").exists() and time.monotonic()<deadline: time.sleep(0.1)',
              'print("WSL_BACKGROUND_FINAL",flush=True)',
              '(root/"background.done").write_text("completed")',
            ].join("\n");
      console.log(`EVIDENCE lifecycle=${mode} toolResult=false`);
      send(
        toolUseBody(`msg_${mode}`, toolId, toolName, {
          command: `exec python3 -c '${python}'`,
          timeout: 120_000,
          run_in_background: mode === "BACKGROUND",
          description: `WSL P2 ${mode.toLowerCase()} lifecycle`,
        }),
      );
      return;
    }
    // 只有真实 Read tool_result（is_error=false 且含两行 marker）才发 FINAL_MARKER，
    // prompt 里出现的预期字符串不能伪通过：final 判定不看 body.includes。
    if (hasReadResult) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textBody("msg_final", FINAL_MARKER));
      return;
    }
    if (tools.length === 0) {
      console.error(
        `EVIDENCE request_without_tools stage write=${hasWriteResult} bash=${hasBashResult} read=${hasReadResult}`,
      );
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("e2e replay: request has no tools definitions; refusing to advance");
      return;
    }
    if (body.includes(RUN) && !hasWriteResult && !hasBashResult && !hasReadResult) {
      const writeName = pickTool(tools, ["Write"], ["file_path", "content"]);
      if (!writeName) {
        console.error(`EVIDENCE no_write_tool tools=[${toolNames}]`);
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("e2e replay: no Write-like tool with file_path+content schema");
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        toolUseBody("msg_write", "toolu_wslp2_write", writeName, {
          file_path: fixturePath,
          content: `${FILE_MARKER}\n`,
        }),
      );
      return;
    }
    if (hasWriteResult && !hasBashResult) {
      const bashName = pickTool(tools, ["Bash"], ["command"]);
      if (!bashName) {
        console.error(`EVIDENCE no_bash_tool tools=[${toolNames}]`);
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("e2e replay: no Bash-like tool with command schema");
        return;
      }
      // Bash 必须真实读入文件并输出内容：cat 结果作为 tool_result 返回，
      // is_error=false 且含 FILE-seen 才允许推进到 Read 轮。
      const command = [
        `content=$(cat '${fixturePath}')`,
        `if [ "$content" = '${FILE_MARKER}' ]; then`,
        `  printf '${FILE_MARKER}-seen\\n' >> '${fixturePath}'`,
        `  cat '${fixturePath}'`,
        `else`,
        `  printf 'unexpected fixture content\\n' >&2; exit 1`,
        `fi`,
      ].join("\n");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        toolUseBody("msg_bash", "toolu_wslp2_bash", bashName, {
          command,
          description: "Read fixture, append marker, print content",
        }),
      );
      return;
    }
    if (hasBashResult && !hasReadResult) {
      const readName = pickTool(tools, ["Read"], ["file_path"]);
      if (!readName) {
        console.error(`EVIDENCE no_read_tool tools=[${toolNames}]`);
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("e2e replay: no Read-like tool with file_path schema");
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        toolUseBody("msg_read", "toolu_wslp2_read", readName, {
          file_path: fixturePath,
        }),
      );
      return;
    }
    if (hasReadResult) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textBody("msg_final", FINAL_MARKER));
      return;
    }
    // 标题/摘要类请求：固定短文本。
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(textBody("msg_misc", "ok"));
  });
});

// stdin 保持存活信号：resume 后监听 end，wsl.exe stdin 关闭时自退出，便于测试回收。
process.stdin.resume();
process.stdin.once("end", () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  console.log(`REPLAY_PORT=${address.port}`);
  console.log(`REPLAY_FIXTURE=${fixturePath}`);
  console.log(`REPLAY_PID=${process.pid}`);
  console.log(`REPLAY_RUN=${RUN}`);
});
