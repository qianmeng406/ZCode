#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { computeStats } from "./lib/bench-agent-linux-stats.mjs";

export function parseBoundaryArgs(argv) {
  const options = { distro: "Ubuntu-24.04", samples: 30 };
  const keys = new Map([
    ["--distro", "distro"],
    ["--workspace", "workspace"],
    ["--output", "output"],
    ["--samples", "samples"],
  ]);
  for (let i = 0; i < argv.length; i += 2) {
    const key = keys.get(argv[i]);
    if (!key || !argv[i + 1] || argv[i + 1].startsWith("--")) {
      throw new Error("Expected --distro, --workspace, --output, or --samples with a value");
    }
    options[key] = key === "samples" ? Number(argv[i + 1]) : argv[i + 1];
  }
  if (
    !options.distro.trim() ||
    !options.workspace?.startsWith("/") ||
    !isAbsolute(options.output ?? "")
  ) {
    throw new Error("Require a distro, absolute Linux workspace, and absolute output file");
  }
  if (!Number.isSafeInteger(options.samples) || options.samples < 1 || options.samples > 1000) {
    throw new Error("Samples must be an integer between 1 and 1000");
  }
  return options;
}

async function probe(options) {
  const started = performance.now();
  const args = [
    "-d",
    options.distro,
    "--cd",
    options.workspace,
    "--exec",
    "/bin/bash",
    "--noprofile",
    "--norc",
    "-c",
    "printf zcode-boundary-ok",
  ];
  return new Promise((accept, reject) => {
    const child = spawn("wsl.exe", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let bytes = 0;
    let timedOut = false;
    let overflow = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 15_000);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 65_536) {
        overflow = true;
        child.kill();
      } else chunks.push(chunk);
    });
    child.stderr.resume();
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (
        code !== 0 ||
        timedOut ||
        overflow ||
        Buffer.concat(chunks).toString("utf8") !== "zcode-boundary-ok"
      ) {
        reject(
          new Error(
            `WSL boundary probe failed: exit=${code}, timeout=${timedOut}, overflow=${overflow}`,
          ),
        );
      } else accept(performance.now() - started);
    });
  });
}

async function main() {
  const options = parseBoundaryArgs(process.argv.slice(2));
  if (process.platform !== "win32") throw new Error("Run the WSL boundary benchmark on Windows");
  const firstSample = await probe(options);
  await probe(options);
  const samples = [];
  for (let i = 0; i < options.samples; i++) samples.push(await probe(options));
  const result = {
    schema: "bench-wsl-boundary/v1",
    recordedAt: new Date().toISOString(),
    method: "Windows Node spawn -> wsl.exe -> Linux bash -> marker output",
    scope: "Wrapper cost; not Agent/RPC latency. First observation is not a forced cold boot.",
    node: process.version,
    distro: options.distro,
    workspace: options.workspace,
    stats: computeStats(samples, { firstSample }),
  };
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
