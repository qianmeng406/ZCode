import { useEffect, useRef } from "react";
import type { IFileWatcherService } from "@zcode/services";
import { shouldCommitDeferredRequest } from "@/lib/onDemandLoadingGuards.js";
import { logger } from "@/logger.js";
import type { WorkspaceFileTreeWatcherRegistration } from "@/workspace-file-tree/types.js";

export function useWorkspaceFileTreeWatchers({
  fileWatcherService,
  watchedDirectoryPaths,
  onDirectoryChange,
}: {
  fileWatcherService: IFileWatcherService;
  watchedDirectoryPaths: Set<string>;
  onDirectoryChange: (path: string) => void;
}) {
  const fileWatcherServiceRef = useRef(fileWatcherService);
  const watcherGenerationRef = useRef(0);
  const watchedDirectoryPathsRef = useRef<Set<string>>(new Set());
  const watcherRegistrationsRef = useRef<Map<string, WorkspaceFileTreeWatcherRegistration>>(
    new Map(),
  );
  const pendingWatcherDirectoryPathsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const releaseWatcherRegistration = (
      directoryPath: string,
      registration: WorkspaceFileTreeWatcherRegistration,
    ) => {
      registration.subscription.dispose();
      void registration.unwatch().catch((error) => {
        logger.warn("[WorkspaceFileTree] 停止监听目录失败", {
          path: directoryPath,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    };

    if (fileWatcherServiceRef.current !== fileWatcherService) {
      watcherGenerationRef.current += 1;
      for (const [directoryPath, registration] of watcherRegistrationsRef.current) {
        releaseWatcherRegistration(directoryPath, registration);
      }
      watcherRegistrationsRef.current = new Map();
      pendingWatcherDirectoryPathsRef.current = new Set();
      fileWatcherServiceRef.current = fileWatcherService;
    }

    watchedDirectoryPathsRef.current = watchedDirectoryPaths;

    for (const [directoryPath, registration] of watcherRegistrationsRef.current) {
      if (!watchedDirectoryPaths.has(directoryPath)) {
        watcherRegistrationsRef.current.delete(directoryPath);
        releaseWatcherRegistration(directoryPath, registration);
      }
    }

    for (const directoryPath of watchedDirectoryPaths) {
      if (
        watcherRegistrationsRef.current.has(directoryPath) ||
        pendingWatcherDirectoryPathsRef.current.has(directoryPath)
      ) {
        continue;
      }

      pendingWatcherDirectoryPathsRef.current.add(directoryPath);
      const watcherGeneration = watcherGenerationRef.current;
      void fileWatcherService
        .watch({ path: directoryPath })
        .then(({ id }) => {
          // 只释放同代 pending 登记：换代（服务变更/卸载）后 pending 已被整体重置，
          // 这里再删会误删新一代尝试的登记。同代时登记就是本尝试创建的，删它不会泄漏。
          if (watcherGeneration === watcherGenerationRef.current) {
            pendingWatcherDirectoryPathsRef.current.delete(directoryPath);
          }
          // 迟到的 watch 结果只在“仍被需要且未换代”时安装订阅；否则立即 unwatch。
          if (
            !shouldCommitDeferredRequest({
              active: watchedDirectoryPathsRef.current.has(directoryPath),
              generation: watcherGeneration,
              expectedGeneration: watcherGenerationRef.current,
            })
          ) {
            void fileWatcherService.unwatch({ id });
            return;
          }

          const subscription = fileWatcherService.onDynamicChange(id)((event) => {
            onDirectoryChange(event.dirPath);
          });
          watcherRegistrationsRef.current.set(directoryPath, {
            id,
            subscription,
            unwatch: () => fileWatcherService.unwatch({ id }),
          });
        })
        .catch((error: unknown) => {
          if (watcherGeneration === watcherGenerationRef.current) {
            pendingWatcherDirectoryPathsRef.current.delete(directoryPath);
          }
          logger.warn("[WorkspaceFileTree] 监听目录失败", {
            path: directoryPath,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }

    return undefined;
  }, [fileWatcherService, onDirectoryChange, watchedDirectoryPaths]);

  useEffect(
    () => () => {
      watcherGenerationRef.current += 1;
      pendingWatcherDirectoryPathsRef.current = new Set();
      for (const [directoryPath, registration] of watcherRegistrationsRef.current) {
        registration.subscription.dispose();
        void registration.unwatch().catch((error) => {
          logger.warn("[WorkspaceFileTree] 停止监听目录失败", {
            path: directoryPath,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      watcherRegistrationsRef.current = new Map();
      watchedDirectoryPathsRef.current = new Set();
    },
    [],
  );
}
