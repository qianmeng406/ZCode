/**
 * 「在内置浏览器打开 URL」的桥接。
 *
 * 右侧 Browser 面板的状态由工作区外壳内的 `useAppPanels` 持有（React state，非全局 store），
 * 而设置页是 Root 下的兄弟分支，两边没有共同的 prop 通路。这里用一个极薄的注册式桥接把
 * 外壳的打开能力暴露出来，避免为一个按钮把面板状态上提到 Root。
 *
 * 没有注册方（web 端、无活动工作区）时返回 false，调用方自行回退到系统浏览器，
 * 调用方不需要知道当前壳层形态。
 */

type EmbeddedBrowserOpenHandler = (url: string) => void;

let opener: EmbeddedBrowserOpenHandler | null = null;

/** 由持有右侧 Browser 面板的壳层注册；返回注销函数。 */
export function registerEmbeddedBrowserOpener(handler: EmbeddedBrowserOpenHandler): () => void {
  opener = handler;
  return () => {
    if (opener === handler) {
      opener = null;
    }
  };
}

/**
 * 请求在内置浏览器打开 URL。
 *
 * @returns true 表示已交给内置浏览器；false 表示当前壳层没有可用的 Browser 面板。
 */
export function requestEmbeddedBrowserOpen(url: string): boolean {
  if (!opener) {
    return false;
  }
  opener(url);
  return true;
}
