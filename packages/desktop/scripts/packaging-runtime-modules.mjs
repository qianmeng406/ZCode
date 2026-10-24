import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { collectRuntimeModuleClosureEntries } from "./runtime-dependency-closure.mjs";

/**
 * 打包时必须能从 app.asar 里解析到的运行时闭包根。
 *
 * 这些包在 pnpm hoisted 布局下能被开发态解析，但 electron-builder 的依赖收集
 * 不保证把它们（及其传递依赖）一起打进产物，缺一个就是安装后启动即崩。
 * 完整打包（electron-builder FileSet 注入）和增量打包（直接刷新 app.asar）
 * 都用这份清单，避免两条路径产出不同的包。
 */
export const REQUIRED_ASAR_RUNTIME_MODULES = [
  "module-details-from-path",
  "@opentelemetry/api-logs",
  // Bugfix: telemetry 的 OTLP exporter 会在启动阶段加载 sdk-metrics。pnpm 开发态可从
  // workspace 根目录解析，但 electron-builder 不会稳定复制这条 hoisted 依赖，导致安装包启动即崩溃。
  // 将 sdk-metrics 作为闭包根注入，同时递归带齐它的 OpenTelemetry 运行时依赖。
  "@opentelemetry/sdk-metrics",
  // Bugfix：主进程的本地 TTFT / renderer 动作追踪导出器使用 OTLP proto 导出链。pnpm hoisted 布局下
  // electron-builder 会把 otlp-transformer 打进 app.asar，却漏拷其传递依赖 protobufjs，已安装应用启动即报
  // Cannot find module protobufjs/minimal（开源侧 3.14.0 arm64 DMG 实测复现）。以两个 proto exporter
  // 作为闭包根注入，递归带齐 otlp-transformer、protobufjs 与 @protobufjs/* 全链。
  "@opentelemetry/exporter-trace-otlp-proto",
  "@opentelemetry/exporter-metrics-otlp-proto",
  "pngjs",
  // Bugfix: @arms/rum-core 把 @babel/runtime 声明成 peerDependency，pnpm 安装时可由 peer 解析兜住，
  // 但 electron-builder 重打 app.asar 时不会因为 @arms/rum-electron 本体进包，就稳定把这个 peer 运行时一起带上。
  // 线上已出现安装包启动即报 Cannot find module '@babel/runtime/helpers/interopRequireDefault'，
  // 这里显式把 @babel/runtime 作为闭包根注入，确保 ARMS 主进程埋点链路在生产包内可解析。
  "@babel/runtime",
  // Bugfix: @zcode/services 的代理连通性探测会动态 require("undici") 取 ProxyAgent。
  // tsup 虽然把 services 代码并进了主/host 产物，但不会把这个运行时 require 的包内联进去，
  // electron-builder 产物又可能漏掉 hoisted 的 undici，最终 mac 安装包启动即报 Cannot find module "undici"。
  // 这里把 undici 和其他兜底依赖一样强制注入 app.asar，避免用户在已安装应用里主进程直接崩溃。
  "undici",
  // node-forge 一直只写在 bundle.mjs 的校验名单里，靠 electron-builder 自己打进 app.asar；
  // 这与 yauzl 漏 pend 是同一类隐患——校验要求的模块必须有人负责补齐。node-forge 无子依赖，
  // 已在产物里时 afterPack 扫描会跳过它，不改变现有打包结果。
  "node-forge",
  // 2.7.0 起 services 新增反馈日志压缩链路并引入 yazl；2.6.0 没有这条启动期依赖，
  // pnpm hoisted 布局下 yazl 可能进了 app.asar，但子依赖 buffer-crc32 没有稳定随包进入产物；
  // 这里显式以 yazl 作为闭包根注入，让递归依赖收集把 ZIP 打包链路所需依赖一起补齐。
  "yazl",
  // yauzl 成为 desktop/services 的直接生产依赖后，pnpm list --prod 会把顶层 yauzl 节点
  // 去重成没有子依赖的空节点；electron-builder 的 pnpm collector 以先登记的空节点为准，
  // 跳过后面带完整子树的那个，于是 app.asar 里有 yauzl 却没有它的运行时依赖 pend，
  // 要到 bundle 校验阶段才报「缺少运行时依赖 pend」。这里以 yauzl 作为闭包根注入，
  // 与 bundle.mjs 的校验名单保持一致，让递归依赖收集把 pend 一起补进产物。
  "yauzl",
  // Bugfix: 飞书 SDK 被 desktop main/host 外置后，安装包运行时必须能从 app.asar 解析到它。
  // 这里显式注入 scoped 包，避免开发态正常、生产包启动时才报 Cannot find module。
  "@larksuiteoapi/node-sdk",
  // 生产态里 ssh2 虽然被打进 app.asar，但它的依赖链偶发被 electron-builder 漏拷。
  // 已出现线上报错 Cannot find module 'asn1'（Require stack: ssh2 keyParser）。
  // 这里把 ssh2 关键依赖链一起注入，避免远程 SSH 连接在已安装应用里因缺包直接失败。
  "asn1",
  "bcrypt-pbkdf",
  "tweetnacl",
  // electron-updater → builder-util-runtime → debug 运行时 require("ms")。
  // pnpm hoisted 布局下 electron-builder 偶发漏拷这个叶子依赖；3.4.0(ci/cua-v0.3.17 打的)
  // 已在线上触发安装包启动即报 Cannot find module 'ms'（Require stack: debug/src/common.js），
  // 自动更新链路直接崩。ms 是叶子包，显式注入即可让 debug 在 app.asar 内稳定解析。
  "ms",
];

export function createRuntimeModuleLookupRoots({ desktopRoot, workspaceRoot }) {
  return [
    desktopRoot,
    workspaceRoot,
    resolve(desktopRoot, "node_modules", ".pnpm", "node_modules"),
    resolve(workspaceRoot, "node_modules", ".pnpm", "node_modules"),
  ];
}

export function collectPackagingRuntimeModules(lookupRoots) {
  return collectRuntimeModuleClosureEntries(REQUIRED_ASAR_RUNTIME_MODULES, lookupRoots);
}

/**
 * 把闭包依赖复制到 staging 的 node_modules 下。
 *
 * 复制真实文件而不是软链：Windows 上指向 pnpm store 的软链在打包器里解析不稳定。
 */
export function materializeRuntimeModules({ stagingDir, entries }) {
  for (const entry of entries) {
    if (!entry.sourceModulePath) continue;
    const targetPath = resolve(stagingDir, entry.moduleName);
    mkdirSync(dirname(targetPath), { recursive: true });
    cpSync(entry.sourceModulePath, targetPath, { recursive: true, dereference: true });
  }
}

export function removeRuntimeModulesStaging(stagingDir) {
  rmSync(stagingDir, { force: true, recursive: true });
}
