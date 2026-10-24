import { lazy, Suspense, type ComponentProps, type ReactNode } from "react";

// 插件市场与自动化面包屑都属于「切到对应视图才需要」的重模块。它们的依赖（市场卡片、
// 设置面包屑、图标与校验）会把入口包显著撑大，因此统一放在这里按需加载，所有挂载点
// 复用同一条 lazy 边界。
export const LazyPluginStorePage = lazy(async () => {
  const module = await import("@/settings/PluginStorePage.js");
  return { default: module.PluginStorePage };
});

export const LazyAutomationsMainBreadcrumbFrame = lazy(async () => {
  const module = await import("@/settings/AutomationsMainBreadcrumbFrame.js");
  return { default: module.AutomationsMainBreadcrumbFrame };
});

export function PluginStorePageBoundary(
  props: ComponentProps<typeof LazyPluginStorePage>,
): ReactNode {
  return (
    <Suspense fallback={null}>
      <LazyPluginStorePage {...props} />
    </Suspense>
  );
}

export function AutomationsBreadcrumbBoundary(
  props: ComponentProps<typeof LazyAutomationsMainBreadcrumbFrame>,
): ReactNode {
  return (
    <Suspense fallback={null}>
      <LazyAutomationsMainBreadcrumbFrame {...props} />
    </Suspense>
  );
}
