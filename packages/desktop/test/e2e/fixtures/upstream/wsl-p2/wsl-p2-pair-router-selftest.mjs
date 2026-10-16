import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createWSLPairRouter } from "./wsl-p2-pair-router.mjs";

const received = [];
const upstreams = ["A", "B"].map((label) =>
  createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      received.push({ label, body });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${label}\n\n`);
    });
  }),
);
const router = createWSLPairRouter();
try {
  for (const server of [...upstreams, router]) {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
  }
  const base = `http://127.0.0.1:${router.address().port}`;
  for (const [i, runId] of ["ra", "rb"].entries()) {
    assert.equal(
      (await fetch(`${base}/register/${runId}/${upstreams[i].address().port}`)).status,
      204,
    );
  }
  assert.equal((await fetch(`${base}/register/ra/1`)).status, 409);
  assert.equal((await fetch(`${base}/register/rc/65536`)).status, 400);
  const responses = await Promise.all(
    ["ra", "rb"].map(async (runId) => {
      const response = await fetch(`${base}/v1/messages`, {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: `E2E_WSLP2_${runId}` }] }),
      });
      assert.equal(response.headers.get("content-type"), "text/event-stream");
      return response.text();
    }),
  );
  assert.deepEqual(responses, ["data: A\n\n", "data: B\n\n"]);
  for (const body of ["unknown", "E2E_WSLP2_ra E2E_WSLP2_rb"]) {
    assert.equal((await fetch(`${base}/v1/messages`, { method: "POST", body })).status, 400);
  }
  assert.equal(received.length, 2);
  assert(received.every(({ label, body }) => body.includes(`E2E_WSLP2_r${label.toLowerCase()}`)));
  console.info(
    "PASS router: registration, conflict, port validation, concurrent SSE forwarding, unknown/ambiguous rejection, no cross-route",
  );
} finally {
  for (const server of [...upstreams, router]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
