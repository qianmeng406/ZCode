// 测试专用：同一远端用户共享 Provider 配置，因此并行实例必须共享回放入口。
// 只路由真实请求，不生成模型响应或工具结果；无匹配或多匹配显式拒绝。
import { createServer, request } from "node:http";

export function createWSLPairRouter() {
  const targets = new Map();
  return createServer((req, res) => {
    const registration = /^\/register\/(r[a-z0-9]+)\/(\d+)$/u.exec(req.url ?? "");
    if (req.method === "GET" && registration) {
      const port = Number(registration[2]);
      if (port < 1 || port > 65535) {
        res.writeHead(400).end();
        return;
      }
      const previous = targets.get(registration[1]);
      if (previous !== undefined && previous !== port) {
        res.writeHead(409).end();
        return;
      }
      targets.set(registration[1], port);
      res.writeHead(204).end();
      return;
    }
    if (req.method === "GET" && req.url === "/healthz") {
      res.end("ok");
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 8 * 1024 * 1024) req.destroy();
    });
    req.on("end", () => {
      const matches = [...targets].filter(([runId]) => body.includes(`E2E_WSLP2_${runId}`));
      if (matches.length !== 1) {
        res.writeHead(400).end("Expected exactly one registered WSL run marker");
        return;
      }
      const [runId, port] = matches[0];
      console.info(`ROUTE run=${runId}`);
      const upstream = request(
        {
          hostname: "127.0.0.1",
          port,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: `127.0.0.1:${port}` },
          timeout: 30_000,
        },
        (response) => {
          res.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(res);
        },
      );
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      upstream.on("timeout", () => upstream.destroy());
      upstream.end(body);
    });
  });
}

if (process.env.ZCODE_WSL_PAIR_ROUTER === "1") {
  const server = createWSLPairRouter();
  server.listen(0, "127.0.0.1", () => {
    console.info(`PAIR_ROUTER_PORT=${server.address().port}`);
    console.info(`PAIR_ROUTER_PID=${process.pid}`);
  });
  process.stdin.resume();
  process.stdin.once("end", () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 3_000).unref();
  });
}
