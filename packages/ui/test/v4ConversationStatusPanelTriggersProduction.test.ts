import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("mounts the status panel menu source with production React without error #185", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-tooltip-production-"));
  const outfile = join(directory, "probe.cjs");
  const require = createRequire(import.meta.url);
  try {
    const source = await readFile(
      resolve("packages/ui/src/v4/ConversationStatusPanel.tsx"),
      "utf8",
    );
    const trigger = source.match(/<Tooltip>[\s\S]*?<\/Tooltip>/)?.[0];
    expect(trigger).toBeTruthy();
    await build({
      stdin: {
        contents: `
          const { JSDOM } = require(${JSON.stringify(require.resolve("jsdom"))});
          const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
          for (const name of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'CustomEvent', 'getComputedStyle']) {
            globalThis[name] = name === 'getComputedStyle' ? dom.window[name].bind(dom.window) : dom.window[name];
          }
          const React = require(${JSON.stringify(require.resolve("react"))});
          const { createRoot } = require(${JSON.stringify(require.resolve("react-dom/client"))});
          const { flushSync } = require(${JSON.stringify(require.resolve("react-dom"))});
          const { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } = require('@/components/ui/tooltip.js');
          const { Button } = require('@/components/ui/button.js');
          const { DropdownMenu, DropdownMenuTrigger } = require('@/components/ui/dropdown-menu.js');
          const { EllipsisIcon } = require('lucide-react');
          const panelMenuLabel = 'Panel menu';
          const root = createRoot(document.getElementById('root'), {
            onUncaughtError(error) { throw error; },
          });
          async function run() {
            for (let revision = 0; revision < 5; revision++) {
              root.render(<TooltipProvider><DropdownMenu>${trigger}</DropdownMenu></TooltipProvider>);
              await new Promise(resolve => setTimeout(resolve, 50));
              if (document.querySelectorAll('button').length !== 1) throw new Error('Expected one trigger button');
            }
            flushSync(() => root.unmount());
            dom.window.close();
          }
          run().catch(error => { console.error(error); process.exitCode = 1; dom.window.close(); });
        `,
        resolveDir: process.cwd(),
        loader: "tsx",
      },
      outfile,
      bundle: true,
      platform: "node",
      format: "cjs",
      mainFields: ["module", "main"],
      alias: { "@": resolve("packages/ui/src") },
      external: [
        require.resolve("jsdom"),
        require.resolve("react"),
        require.resolve("react-dom/client"),
        require.resolve("react-dom"),
        "react",
        "react-dom",
        "jsdom",
      ],
      nodePaths: [resolve("node_modules")],
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    const result = spawnSync(process.execPath, [outfile], {
      env: { ...process.env, NODE_ENV: "production", NODE_PATH: resolve("node_modules") },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
