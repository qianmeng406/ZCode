import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BrowserWindow } from "electron";
import { ClipboardItem, clipboard, shell } from "electron";

type DesktopIpcLogger = {
  info?: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

export async function openFileUrlInDefaultApp(
  url: string,
  logger: DesktopIpcLogger,
): Promise<void> {
  try {
    const filePath = fileURLToPath(url);
    await openPathInDefaultApp(filePath, logger);
  } catch (error) {
    logger.warn("[open-external] file URL 打开失败", {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function openPathInDefaultApp(
  rawPath: string,
  logger: DesktopIpcLogger,
): Promise<{ success: boolean; error?: string }> {
  const trimmed = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!trimmed) {
    const error = "empty path";
    logger.warn("[open-external] 本地文件打开失败", { path: rawPath, error });
    return { success: false, error };
  }

  const normalized = normalize(trimmed);
  let target = normalized;
  try {
    target = await realpath(normalized);
  } catch {
    // 路径不存在或无法解析时仍尝试用规范化后的原路径，让系统返回更具体的错误。
  }

  try {
    const error = await shell.openPath(target);
    if (error) {
      logger.warn("[open-external] 本地文件打开失败", { path: target, error });
      return { success: false, error };
    }
    logger.info?.("[open-external] 本地文件打开成功", { path: target });
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("[open-external] 本地文件打开失败", { path: target, error: message });
    return { success: false, error: message };
  }
}

export async function openPathInFileManager(
  rawPath: string,
  logger: DesktopIpcLogger,
): Promise<{ success: boolean; error?: string }> {
  const trimmed = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!trimmed) {
    return { success: false, error: "empty path" };
  }
  const normalized = normalize(trimmed);
  let target = normalized;
  try {
    target = await realpath(normalized);
  } catch {
    // 路径不存在或无法解析时仍尝试用规范化后的原路径打开，便于定位权限等问题。
  }

  if (process.platform === "darwin") {
    return openDarwinPathInFileManager(target, logger);
  }

  const error = await shell.openPath(target);
  if (error) {
    logger.warn("[open-in-file-manager] shell.openPath 失败", {
      path: target,
      error,
    });
    return { success: false, error };
  }
  return { success: true };
}

/**
 * 把本地文件复制进系统剪贴板，使用户能在文件管理器里直接粘贴。
 *
 * Electron 没有原生的「复制文件」API，各平台走剪贴板的私有格式：
 * - Windows：FileNameW（UTF-16 带 NUL 终止符的资源管理器文件引用）；
 * - macOS：public.file-url（file:// URL）；
 * - Linux：text/uri-list（文件管理器普遍接受的 URI 列表）。
 * 单文件场景各平台均可工作；多文件（CF_HDROP）不在本入口的语义内。
 *
 * Electron 44 移除了同步的 clipboard.writeBuffer，私有格式必须包成 ClipboardItem 的
 * osclipboard 原始格式（`electron application/osclipboard;format="<name>"`）写入。
 */
function buildFileClipboardItem(target: string): ClipboardItem {
  const rawFormat = (format: string, bytes: Buffer) =>
    new ClipboardItem({
      [`electron application/osclipboard;format="${format}"`]: new Blob([Uint8Array.from(bytes)]),
    });
  if (process.platform === "win32") {
    // UTF-16 且以 NUL 终止：资源管理器按这个私有格式识别文件引用。
    return rawFormat("FileNameW", Buffer.from(`${target}${String.fromCharCode(0)}`, "ucs2"));
  }
  const fileUrl = pathToFileURL(target).href;
  return process.platform === "darwin"
    ? rawFormat("public.file-url", Buffer.from(fileUrl, "utf8"))
    : rawFormat("text/uri-list", Buffer.from(fileUrl, "utf8"));
}

export async function copyFileToOsClipboard(
  rawPath: string,
  logger: DesktopIpcLogger,
): Promise<{ success: boolean; error?: string }> {
  const trimmed = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!trimmed) {
    return { success: false, error: "empty path" };
  }
  const target = normalize(trimmed);
  try {
    const info = await stat(target);
    if (!info.isFile()) {
      return { success: false, error: "not a regular file" };
    }
  } catch {
    return { success: false, error: "file not found" };
  }

  try {
    await clipboard.write([buildFileClipboardItem(target)]);
    logger.info?.("[copy-file] 文件已复制到剪贴板", { path: target });
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("[copy-file] 文件复制到剪贴板失败", { path: target, error: message });
    return { success: false, error: message };
  }
}

export async function captureWindowScreenshot(senderWindow: BrowserWindow | null) {
  if (!senderWindow || senderWindow.isDestroyed()) {
    return null;
  }

  // 报错横幅里的反馈需要带上用户看到的现场。
  // 这里在 main 进程截当前窗口，避免 renderer 走屏幕录制权限或只能截到局部 DOM。
  const image = await senderWindow.webContents.capturePage();
  const buffer = image.toPNG();
  return {
    dataBase64: buffer.toString("base64"),
    filename: `zcode-error-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
    contentType: "image/png",
    size: buffer.byteLength,
  };
}

async function openDarwinPathInFileManager(target: string, logger: DesktopIpcLogger) {
  const runOpen = (args: string[]) =>
    new Promise<void>((resolve, reject) => {
      execFile("open", args, (error) => (error ? reject(error) : resolve()));
    });

  try {
    await runOpen([target]);
    return { success: true };
  } catch (firstError) {
    try {
      await runOpen(["-a", "Finder", target]);
      return { success: true };
    } catch (finderError) {
      const shellMessage = await shell.openPath(target);
      if (!shellMessage) {
        return { success: true };
      }
      logger.warn("[open-in-file-manager] macOS 打开目录均失败", {
        path: target,
        shellMessage,
        firstError: firstError instanceof Error ? firstError.message : String(firstError),
        finderError: finderError instanceof Error ? finderError.message : String(finderError),
      });
      return { success: false, error: shellMessage };
    }
  }
}
