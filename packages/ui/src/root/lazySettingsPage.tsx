import { lazy } from "react";
import { Spinner } from "@/components/ui/spinner.js";

// 设置页连同自动化、插件管理、拼音检索词典一起占入口包很大一块，但只有打开设置 tab
// 时才用得上。所有挂载点共用同一个 lazy 边界，避免各自产出一份设置页代码。
export const LazySettingsPage = lazy(async () => {
  const module = await import("@/SettingsPage.js");
  return { default: module.SettingsPage };
});

export function SettingsPageLoading() {
  return (
    <div
      className="flex h-full items-center justify-center"
      role="status"
      data-testid="settings-page-loading"
    >
      <Spinner className="size-5 text-muted-foreground" />
    </div>
  );
}
