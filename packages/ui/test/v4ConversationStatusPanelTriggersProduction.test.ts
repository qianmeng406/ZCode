import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { expect, it } from "vitest";

it.each(["module", "main"])(
  "keeps production menu refs stable with %s dependencies",
  async (entry) => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-tooltip-production-"));
    const outfile = join(directory, "probe.cjs");
    const harness = join(directory, "harness.cjs");
    const require = createRequire(import.meta.url);
    try {
      const source = await readFile(
        resolve("packages/ui/src/v4/ConversationStatusPanel.tsx"),
        "utf8",
      );
      const trigger = source
        .match(/<Tooltip>[\s\S]*?<\/Tooltip>/)?.[0]
        ?.replace("<Button", "<Button ref={recordButtonRef}");
      expect(trigger).toBeTruthy();
      await build({
        stdin: {
          contents: `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { flushSync } from 'react-dom';
          import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip.js';
          import { Button } from '@/components/ui/button.js';
          import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.js';
          import { EllipsisIcon } from 'lucide-react';
          const panelMenuLabel = 'Panel menu';
          const refEvents = [];
          const recordButtonRef = node => { refEvents.push(node === null ? 'detach' : 'attach'); };
          export async function run() {
            const root = createRoot(document.getElementById('root'), {
              onUncaughtError(error) { throw error; },
            });
            try {
              for (let revision = 0; revision < 5; revision++) {
                flushSync(() => root.render(<TooltipProvider><DropdownMenu>${trigger}</DropdownMenu></TooltipProvider>));
                await new Promise(resolve => setTimeout(resolve, 20));
                const button = document.querySelector('button');
                if (!button || document.querySelectorAll('button').length !== 1) throw new Error('Expected one trigger button');
                if (refEvents.length !== 1) throw new Error('Parent update detached the unchanged menu button ref: ' + JSON.stringify(refEvents));
                const beforeFocus = refEvents.length;
                button.focus();
                await new Promise(resolve => setTimeout(resolve, 20));
                if (refEvents.length !== beforeFocus) throw new Error('Tooltip state update detached the unchanged menu button ref: ' + JSON.stringify(refEvents));
                button.blur();
                button.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
                await new Promise(resolve => setTimeout(resolve, 20));
                if (button.getAttribute('aria-expanded') !== 'true') throw new Error('Menu did not open');
                if (refEvents.length !== 1) throw new Error('Menu state update detached the unchanged button ref');
                button.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
                await new Promise(resolve => setTimeout(resolve, 20));
              }
            } finally {
              flushSync(() => root.unmount());
              if (JSON.stringify(refEvents) !== JSON.stringify(['attach', 'detach'])) throw new Error('Unexpected unmount lifecycle: ' + JSON.stringify(refEvents));
            }
          }
        `,
          resolveDir: process.cwd(),
          loader: "tsx",
        },
        outfile,
        bundle: true,
        platform: "node",
        format: "cjs",
        mainFields: entry === "module" ? ["module", "main"] : ["main", "module"],
        alias: { "@": resolve("packages/ui/src") },
        external: ["react", "react-dom"],
        nodePaths: [resolve("node_modules")],
        jsx: "automatic",
        define: { "process.env.NODE_ENV": '"production"' },
      });
      // Radix 在模块初始化时选择 useLayoutEffect；DOM 必须先于组件依赖加载。
      await writeFile(
        harness,
        `
      const { JSDOM } = require(${JSON.stringify(require.resolve("jsdom"))});
      const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
      for (const name of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'CustomEvent', 'Event', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
        globalThis[name] = typeof dom.window[name] === 'function' && ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'].includes(name) ? dom.window[name].bind(dom.window) : dom.window[name];
      }
      require('./probe.cjs').run().then(() => dom.window.close(), error => { console.error(error); process.exitCode = 1; dom.window.close(); });
    `,
      );
      const result = spawnSync(process.execPath, [harness], {
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
  },
  60_000,
);
