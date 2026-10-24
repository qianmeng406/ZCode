import { lazy, Suspense, type ComponentProps, type ReactNode } from "react";

// 侧栏的每个视图都是「切到该 tab 才需要」的重模块：Git 图、文件树和调用轨迹合计超过
// 4 MB 源码。静态导入会让它们全部进入入口包，这里统一按需加载。
export const LazyFileManagerPane = lazy(async () => {
  const module = await import("@/WorkspaceFileTree.js");
  return { default: module.FileManagerPane };
});

export const LazyGitPane = lazy(async () => {
  const module = await import("@/GitPane.js");
  return { default: module.GitPane };
});

export const LazyModelTrajectoryPane = lazy(async () => {
  const module = await import("@/ModelTrajectoryPane.js");
  return { default: module.ModelTrajectoryPane };
});

export function FileManagerPaneBoundary(
  props: ComponentProps<typeof LazyFileManagerPane>,
): ReactNode {
  return (
    <Suspense fallback={null}>
      <LazyFileManagerPane {...props} />
    </Suspense>
  );
}

export function GitPaneBoundary(props: ComponentProps<typeof LazyGitPane>): ReactNode {
  return (
    <Suspense fallback={null}>
      <LazyGitPane {...props} />
    </Suspense>
  );
}

export function ModelTrajectoryPaneBoundary(
  props: ComponentProps<typeof LazyModelTrajectoryPane>,
): ReactNode {
  return (
    <Suspense fallback={null}>
      <LazyModelTrajectoryPane {...props} />
    </Suspense>
  );
}
