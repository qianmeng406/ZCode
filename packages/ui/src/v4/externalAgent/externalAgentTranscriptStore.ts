// 外部 CLI 会话的完整上下文（读取状态 + 分页缓存）。
//
// 面板挂在 App 壳层，拿不到 SessionPane 的 transport；而 transcript 必须走 RPC
// （文件在执行机上）。所以沿用活动面板同一条路：SessionPane 在打开面板时把
// loader 注册进来，面板只订阅这个模块级 store。
//
// 分页语义：游标是"条目序号"。会话文件只追加，已有条目序号稳定，所以
// 「加载更早」是严格的向前翻页，不会跳段；文件在面板打开期间继续增长时，
// 新条目落在当前窗口之后，不影响已加载区间。
import type { ExternalAgentTranscriptEntry } from "@zcode/shared";

export interface ExternalAgentTranscriptPageLike {
  entries: ExternalAgentTranscriptEntry[];
  total: number;
  hasMore: boolean;
  truncated: boolean;
}

export type ExternalAgentTranscriptLoader = (input: {
  before?: number;
  limit?: number;
}) => Promise<ExternalAgentTranscriptPageLike | null>;

export interface ExternalAgentTranscriptState {
  entries: ExternalAgentTranscriptEntry[];
  /** 当前窗口第一条在整段会话里的绝对序号。 */
  firstIndex: number;
  /** 最近一次读到的总条目数（会随文件增长而变大）。 */
  total: number;
  hasMore: boolean;
  /** 源文件过大，只解析了尾部。 */
  truncated: boolean;
  loading: boolean;
  loaded: boolean;
  error: string | null;
}

/** 每页条数：面板一次显示一屏左右，"加载更早"按需翻。 */
const PAGE_SIZE = 30;
/** 累计上限：上下文省略的硬边界，超过后不再提供"加载更早"。 */
const MAX_LOADED_ENTRIES = 300;

const EMPTY_STATE: ExternalAgentTranscriptState = {
  entries: [],
  firstIndex: 0,
  total: 0,
  hasMore: false,
  truncated: false,
  loading: false,
  loaded: false,
  error: null,
};

const states = new Map<string, ExternalAgentTranscriptState>();
const loaders = new Map<string, ExternalAgentTranscriptLoader>();
const listeners = new Map<string, Set<() => void>>();

/** 一个外部会话在 UI 里的键：同 zcode 会话下的不同外部会话互不干扰。 */
export function externalAgentTranscriptKey(sessionId: string, externalSessionId: string): string {
  return `${sessionId}::${externalSessionId}`;
}

function notify(key: string): void {
  const target = listeners.get(key);
  if (!target) return;
  for (const listener of target) listener();
}

function write(key: string, next: ExternalAgentTranscriptState): void {
  states.set(key, next);
  notify(key);
}

/**
 * 注册读取器（SessionPane 打开面板时调用）。
 *
 * 保留已加载状态：同一会话重复打开面板直接命中缓存，不重读文件。
 */
export function registerExternalAgentTranscriptLoader(
  key: string,
  loader: ExternalAgentTranscriptLoader,
): void {
  loaders.set(key, loader);
}

export function getExternalAgentTranscriptState(key: string): ExternalAgentTranscriptState {
  return states.get(key) ?? EMPTY_STATE;
}

/** 是否注册过读取器：恢复出来的历史 tab 没有注册器，面板据此给出明确提示。 */
export function hasExternalAgentTranscriptLoader(key: string): boolean {
  return loaders.has(key);
}

export function subscribeExternalAgentTranscript(key: string, listener: () => void): () => void {
  const existing = listeners.get(key);
  if (existing) existing.add(listener);
  else listeners.set(key, new Set([listener]));
  return () => {
    const target = listeners.get(key);
    if (!target) return;
    target.delete(listener);
    if (target.size === 0) listeners.delete(key);
  };
}

/** 丢弃缓存（会话被删除 / 强制刷新时用）。 */
export function resetExternalAgentTranscript(key: string): void {
  states.delete(key);
  notify(key);
}

/**
 * 读取下一页。
 *
 * - 未加载（或 `reload`）：读最新一页；
 * - 已加载：以当前窗口的第一条为 `before` 向前翻一页。
 */
export async function loadExternalAgentTranscript(
  key: string,
  options: { reload?: boolean } = {},
): Promise<void> {
  const loader = loaders.get(key);
  const current = states.get(key) ?? EMPTY_STATE;
  if (!loader || current.loading) return;
  if (!options.reload && current.loaded && !current.hasMore) return;
  const before = options.reload || !current.loaded ? undefined : current.firstIndex;
  write(key, { ...current, loading: true, error: null });
  try {
    const page = await loader({
      limit: PAGE_SIZE,
      ...(before !== undefined ? { before } : {}),
    });
    if (!page) {
      write(key, { ...getExternalAgentTranscriptState(key), loading: false, loaded: true });
      return;
    }
    const next = getExternalAgentTranscriptState(key);
    const prepended = before !== undefined;
    const entries = prepended ? [...page.entries, ...next.entries] : page.entries;
    const firstIndex = prepended
      ? Math.max(0, next.firstIndex - page.entries.length)
      : Math.max(0, page.total - page.entries.length);
    write(key, {
      entries,
      firstIndex,
      total: page.total,
      // 达到累计上限就停：上下文省略的硬边界，避免无限翻页把内存撑满。
      hasMore: page.hasMore && firstIndex > 0 && entries.length < MAX_LOADED_ENTRIES,
      truncated: page.truncated,
      loading: false,
      loaded: true,
      error: null,
    });
  } catch (error) {
    write(key, {
      ...getExternalAgentTranscriptState(key),
      loading: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
