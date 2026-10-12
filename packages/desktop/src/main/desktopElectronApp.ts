// electron 用命名空间导入：`import { app } from "electron"` 在 Node ESM 测试进程里
// 会在链接期直接报 named export 缺失（electron 包是 CJS），下面的测试兜底永远到不了。
// 命名空间导入两种运行时都能完成链接：Electron main 下取到真实 app，Node 下为 undefined。
import * as electronModule from "electron";
import { getAppConfigDir } from "@zcode/services/node";

type ElectronAppPathName = "appData" | "userData";
type ElectronAppLike = {
  isPackaged?: boolean;
  getPath?: (pathName: ElectronAppPathName) => string;
};

function resolveElectronApp(): ElectronAppLike | undefined {
  const namespace = electronModule as unknown as {
    app?: ElectronAppLike;
    default?: { app?: ElectronAppLike } | ElectronAppLike;
  };
  if (namespace.app?.getPath || namespace.app?.isPackaged !== undefined) {
    return namespace.app;
  }
  // CJS 互操作形态：app 可能挂在 default 下（default 是 electron API 对象）。
  const fallback = namespace.default;
  const candidate =
    fallback && typeof fallback === "object" && "app" in fallback
      ? (fallback as { app?: ElectronAppLike }).app
      : (fallback as ElectronAppLike | undefined);
  return candidate?.getPath || candidate?.isPackaged !== undefined ? candidate : undefined;
}

export function isElectronAppPackaged(): boolean {
  return resolveElectronApp()?.isPackaged === true;
}

export function getElectronAppPath(name: ElectronAppPathName): string {
  const electronApp = resolveElectronApp();
  if (electronApp?.getPath) {
    return electronApp.getPath(name);
  }

  // 部分 main-process 单测只 mock 被测模块直接需要的 Electron API，
  // 间接导入 desktopRuntimeEnv 时可能拿不到 app。真实桌面运行仍走 app.getPath；
  // Node-only 测试用配置目录兜底，避免导入期常量把无关测试打断。
  return getAppConfigDir();
}
