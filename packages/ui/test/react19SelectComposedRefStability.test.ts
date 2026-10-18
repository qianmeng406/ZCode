// @vitest-environment jsdom
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

/**
 * React 19 + Radix「组合 ref 身份不稳定」更新环（React #185）回归防线。
 *
 * 现象：桌面渲染器在「草稿态点击 Linux 环境触发器」时抛 React error #185
 * （maximum update depth exceeded），被 ScopedErrorBoundary:workspace-chat 捕获，弹窗永不挂载。
 *
 * 逐帧映射崩溃栈（hidden sourcemap）后的因果链：
 *   1) 最内层用户帧 = node_modules/@radix-ui/react-select/dist/index.mjs:909
 *      SelectItemText 的 `useComposedRefs(forwardedRef, (node) => setItemTextNode(node), …)`；
 *      补丁落地后在对话框挂载时同一形态又命中
 *      @radix-ui/react-focus-scope/dist/index.mjs:25 `(node) => setContainer(node)`；
 *   2) 内联箭头每次 render 都换新身份 → useComposedRefs 的 useCallback 依赖抖动；
 *   3) React 19 每次 commit 都对该 ref detach（`ref(null)`）+ attach；
 *   4) detach 会调用 setState（`setItemTextNode(null)` / `setContainer(null)`）→ 嵌套更新；
 *   5) 真实渲染器里被 popper 测量 / Presence 动画反复重渲染放大 → nestedUpdateCount > 50 → #185。
 *
 * 修复与仓库既有先例一致（patches/@radix-ui__react-slot@1.2.4.patch、
 * patches/@radix-ui__react-dropdown-menu@2.1.16.patch、ControlHintTooltip 的 composedTriggerRef）：
 * 把内联箭头换成稳定引用（useState setter / useCallbackRef 产物），
 * 让 useComposedRefs 的依赖不随 render 抖动。上游同款修复见 radix-ui/primitives #3967。
 *
 * 本用例读安装态 dist 断言补丁已落地：旧码（原始 dist）必挂。
 */

const require_ = createRequire(import.meta.url);

/**
 * 扫出所有 `useComposedRefs(<参数>)` 实参里出现内联箭头函数的调用。
 * CJS dist 形态为 `(0, import_react_compose_refs.useComposedRefs)(…)`，故跳过紧跟的 `)`。
 */
function unstableComposedRefArgs(source: string): string[] {
  const bad: string[] = [];
  const marker = "useComposedRefs";
  for (let i = source.indexOf(marker); i !== -1; i = source.indexOf(marker, i + 1)) {
    let open = i + marker.length;
    while (source[open] === ")") open += 1;
    if (source[open] !== "(") continue;
    let depth = 0;
    for (let k = open; k < source.length; k += 1) {
      const ch = source[k];
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) break;
      } else if (ch === "=" && source[k + 1] === ">") {
        bad.push(`${source.slice(Math.max(0, i - 40), Math.min(k + 2, source.length))}`);
        break;
      }
    }
  }
  return bad;
}

/** 全部已安装 @radix-ui 包的 dist 入口（index.mjs / index.js）。 */
function radixDistSources(): Array<{ path: string; source: string }> {
  // dist/index.js → 包目录 → @radix-ui 目录（package.json 不在 exports 映射里）。
  const radixDir = dirname(dirname(dirname(require_.resolve("@radix-ui/react-compose-refs"))));
  const out: Array<{ path: string; source: string }> = [];
  for (const entry of readdirSync(radixDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("react-")) continue;
    const dist = resolve(radixDir, entry.name, "dist");
    if (!existsSync(dist)) continue;
    for (const file of ["index.mjs", "index.js"]) {
      const path = join(dist, file);
      if (existsSync(path)) out.push({ path, source: readFileSync(path, "utf8") });
    }
  }
  return out;
}

function selectDistSources(): Array<{ path: string; source: string }> {
  const distDir = dirname(require_.resolve("@radix-ui/react-select"));
  return ["index.js", "index.mjs"]
    .map((file) => resolve(distDir, file))
    .filter((path) => existsSync(path))
    .map((path) => ({ path, source: readFileSync(path, "utf8") }));
}

afterEach(() => {
  cleanup();
});

describe("Radix 组合 ref 稳定性（React 19 ref detach 更新环防线）", () => {
  it("所有已安装 @radix-ui 包都不再把内联箭头交给 useComposedRefs", () => {
    const sources = radixDistSources();
    expect(sources.length).toBeGreaterThan(50);
    const offenders = sources.flatMap(({ path, source }) =>
      unstableComposedRefArgs(source).map((snippet) => `${path}: ${snippet}`),
    );
    expect(offenders).toEqual([]);
  });

  it("崩溃现场 select / focus-scope 的具体站点已换成稳定引用", () => {
    const selectSources = selectDistSources();
    expect(selectSources.length).toBeGreaterThan(0);
    for (const { path, source } of selectSources) {
      // 崩溃帧：setItemTextNode 必须是同一个稳定 setter，而不是包一层新箭头。
      expect(source, `${path} 未把 setItemTextNode 直接作为 ref`).toContain("setItemTextNode,");
      expect(source, `${path} 缺少稳定的 itemText ref`).toContain("handleItemTextRefCallback");
      expect(source, `${path} 缺少稳定的 item ref`).toContain("handleItemRefCallback");
    }

    const focusScopeDist = dirname(require_.resolve("@radix-ui/react-focus-scope"));
    for (const file of ["index.mjs", "index.js"]) {
      const path = resolve(focusScopeDist, file);
      if (!existsSync(path)) continue;
      const source = readFileSync(path, "utf8");
      expect(source, `${path} 未把 setContainer 直接作为 ref`).toContain("setContainer");
      expect(source, `${path} 仍含不稳定容器 ref`).not.toContain("setContainer(node)");
    }
  });

  it("补丁后 Select 仍正常渲染选项（打开态 item 文本可见且重渲染不丢）", () => {
    const prototype = Element.prototype as unknown as Record<string, unknown>;
    prototype.scrollIntoView = prototype.scrollIntoView ?? (() => {});
    prototype.hasPointerCapture = prototype.hasPointerCapture ?? (() => false);
    prototype.setPointerCapture = prototype.setPointerCapture ?? (() => {});
    prototype.releasePointerCapture = prototype.releasePointerCapture ?? (() => {});

    const tree = () =>
      createElement(
        TooltipProvider,
        null,
        createElement(
          Select,
          { value: "high", open: true, onOpenChange: () => {} } as never,
          createElement(
            SelectTrigger,
            { "data-testid": "t" } as never,
            createElement(SelectValue, null),
          ),
          createElement(
            SelectContent,
            { position: "popper" } as never,
            createElement(SelectItem, { value: "off", key: "off" }, "Off"),
            createElement(SelectItem, { value: "high", key: "high" }, "High"),
            createElement(SelectItem, { value: "max", key: "max" }, "Max"),
          ),
        ),
      );

    const view = render(tree());
    const text = () => document.body.textContent ?? "";
    expect(text()).toContain("Off");
    expect(text()).toContain("High");
    expect(text()).toContain("Max");

    for (let i = 0; i < 3; i += 1) {
      view.rerender(tree());
      expect(text()).toContain("Max");
    }
  });
});
