import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  attributeConnectPhases,
  parseLatencyArgs,
  sanitizeCommandDetail,
} from "../scripts/wsl-connect-latency-support.js";

function smokeArgs(): string[] {
  return [
    "--distro",
    "Ubuntu-24.04",
    "--user",
    "zcodewslp2",
    "--workspace",
    "/home/zcodewslp2/workspace",
    "--mock-cdn-dir",
    "C:/lab/phase3/assets",
    "--output",
    "C:/lab/phase3/out/result.json",
  ];
}

describe("wsl-connect-latency-support", () => {
  it("默认 iterations=5 且透传 smoke 参数", () => {
    const parsed = parseLatencyArgs(smokeArgs());
    expect(parsed.iterations).toBe(5);
    expect(parsed.smoke.distro).toBe("Ubuntu-24.04");
    // parseSmokeArgs 对本地路径做 resolve，Windows 下分隔符为反斜杠。
    expect(parsed.smoke.output).toBe(resolve("C:/lab/phase3/out/result.json"));
  });

  it("抽取 --iterations 并校验范围", () => {
    expect(parseLatencyArgs([...smokeArgs(), "--iterations", "10"]).iterations).toBe(10);
    expect(() => parseLatencyArgs([...smokeArgs(), "--iterations", "abc"])).toThrow("--iterations");
    expect(() => parseLatencyArgs([...smokeArgs(), "--iterations", "0"])).toThrow("--iterations");
    expect(() => parseLatencyArgs([...smokeArgs(), "--iterations", "51"])).toThrow("--iterations");
  });

  it("全标记时六段归因精确，缺口只进 unattributedMs", () => {
    const breakdown = attributeConnectPhases(
      {
        detecting: 100,
        detected: 300,
        deploying: 400,
        deployComplete: 900,
        launching: 910,
        execStarted: 1500,
        handshaking: 1510,
        handshakeDone: 2500,
      },
      0,
      2600,
    );
    expect(breakdown).toEqual({
      detectMs: 200,
      runtimeNetworkMs: 100,
      deployMs: 500,
      launchMs: 600,
      handshakeMs: 990,
      wrapMs: 100,
      // 调用前隙 100 + execStarted→handshaking 10，不做估算填补。
      unattributedMs: 110,
    });
  });

  it("缺 deploy 标记时对应段为 null，launch 回退到 launching", () => {
    const breakdown = attributeConnectPhases(
      {
        detecting: 0,
        detected: 100,
        launching: 200,
        execStarted: 500,
        handshaking: 510,
        handshakeDone: 900,
      },
      0,
      1000,
    );
    expect(breakdown.deployMs).toBeNull();
    expect(breakdown.runtimeNetworkMs).toBeNull();
    expect(breakdown.launchMs).toBe(300);
    expect(breakdown.wrapMs).toBe(100);
    expect(breakdown.unattributedMs).toBe(1000 - (100 + 300 + 390 + 100));
  });

  it("缺 handshake 结束标记时 handshake/wrap 为 null，不估算", () => {
    const breakdown = attributeConnectPhases(
      { detecting: 0, detected: 10, handshaking: 50 },
      0,
      100,
    );
    expect(breakdown.detectMs).toBe(10);
    expect(breakdown.handshakeMs).toBeNull();
    expect(breakdown.wrapMs).toBeNull();
    expect(breakdown.unattributedMs).toBe(90);
  });

  it("空标记时全部段为 null，unattributedMs 等于总墙钟", () => {
    const breakdown = attributeConnectPhases({}, 10, 610);
    expect(breakdown.detectMs).toBeNull();
    expect(breakdown.deployMs).toBeNull();
    expect(breakdown.unattributedMs).toBe(600);
  });

  it("detail 脱敏替换凭据类赋值并截断到 240 字符", () => {
    const redacted = sanitizeCommandDetail(
      "env API_KEY=abc123 OTHER_TOKEN='xyz' PATH=/usr/bin zcode-server --stdio",
    );
    expect(redacted).toContain("API_KEY=<redacted>");
    expect(redacted).toContain("OTHER_TOKEN=<redacted>");
    expect(redacted).toContain("PATH=/usr/bin");
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("xyz");
    const long = sanitizeCommandDetail("x".repeat(300));
    expect(long).toHaveLength(240);
  });
});
