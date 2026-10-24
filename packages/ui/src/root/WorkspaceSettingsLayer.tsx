import { Suspense, useEffect } from "react";
import { ServiceProvider } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { LazySettingsPage, SettingsPageLoading } from "@/root/lazySettingsPage.js";
import type { WorkspaceSettingsLayerProps } from "@/root/types.js";

export function WorkspaceSettingsLayer({
  workspaceScopedServices,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  isWebRemoteControl,
  windowsWindowControlsRightPaddingPx,
  captionWorkspacePath,
  onBack,
  onCreateTask,
  onOpenWorkspace,
  onOpenRemoteWorkspace,
  allowOpenWorkspace,
  onLogin,
  onLogout,
  user,
}: WorkspaceSettingsLayerProps) {
  useEffect(() => {
    logger.info("[Root] settings layer mounted");
    return () => {
      logger.info("[Root] settings layer unmounted");
    };
  }, []);

  return (
    <div className="absolute inset-0 z-10">
      {workspaceScopedServices ? (
        <ServiceProvider services={workspaceScopedServices}>
          <Suspense fallback={<SettingsPageLoading />}>
            <LazySettingsPage
              isDesktop={isDesktop}
              isMacDesktop={isMacDesktop}
              isWindowsDesktop={isWindowsDesktop}
              isWebRemoteControl={isWebRemoteControl}
              windowsWindowControlsRightPaddingPx={windowsWindowControlsRightPaddingPx}
              captionWorkspacePath={captionWorkspacePath}
              onBack={onBack}
              onCreateTask={onCreateTask}
              onOpenWorkspace={onOpenWorkspace}
              onOpenRemoteWorkspace={onOpenRemoteWorkspace}
              allowOpenWorkspace={allowOpenWorkspace}
              onLogin={onLogin}
              onLogout={onLogout}
              user={user}
            />
          </Suspense>
        </ServiceProvider>
      ) : (
        <Suspense fallback={<SettingsPageLoading />}>
          <LazySettingsPage
            isDesktop={isDesktop}
            isMacDesktop={isMacDesktop}
            isWindowsDesktop={isWindowsDesktop}
            isWebRemoteControl={isWebRemoteControl}
            windowsWindowControlsRightPaddingPx={windowsWindowControlsRightPaddingPx}
            captionWorkspacePath={captionWorkspacePath}
            onBack={onBack}
            onCreateTask={onCreateTask}
            onOpenWorkspace={onOpenWorkspace}
            onOpenRemoteWorkspace={onOpenRemoteWorkspace}
            allowOpenWorkspace={allowOpenWorkspace}
            onLogin={onLogin}
            onLogout={onLogout}
            user={user}
          />
        </Suspense>
      )}
    </div>
  );
}
