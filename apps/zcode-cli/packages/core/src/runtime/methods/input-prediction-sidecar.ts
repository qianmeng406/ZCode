// 输入预测纯函数（手机远控 ghost hint + 桌面候选胶囊共用）。规格见
// docs/web-remote-control/mobile-input-prediction.md。
//
// 2026-11-01 重构：候选不再由独立模型请求生成——开启输入预测时，主轮请求的
// 提示词附带指令（appendInputPredictionDirective），模型在回复尾部输出
// <next_input> 候选块；流式过滤器（createNextInputStreamFilter）吞掉该块的
// 可见流，完成边界（parseNextInputPredictionBlock）解析候选并存入 runtime。
// 本文件只放纯函数，无 IO、无 runtime 依赖。
import type { ModelInputMessage } from "@zcode/contracts";
import {
  INPUT_PREDICTION_MAX_CANDIDATES,
  INPUT_PREDICTION_MAX_TEXT_CHARS,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * 决策门槛：top 候选 confidence ≥ 0.6 才展示。
 * 0.8 实测过严：GLM 按提示词的校准指令诚实打分，日常候选普遍 0.5-0.7，
 * 门槛 0.8 时几乎永远 suppress（2026-11-01 线上实测：0.7/0.6/0.5 全压掉）。
 */
export const INPUT_PREDICTION_CONFIDENCE_THRESHOLD = 0.6;
/** 去重时只看最近 2 条真实用户输入：用户刚发过的不再预测。 */
const RECENT_USER_INPUT_DEDUPE_COUNT = 2;

// 预测块标签：既用于流过滤/完成边界解析，也用于拦"指令回显型"候选。
const NEXT_INPUT_BLOCK_OPEN = "<next_input";
const NEXT_INPUT_BLOCK_CLOSE = "</next_input>";

export interface InputPredictionCandidate {
  text: string;
  confidence: number;
}

export interface InputPredictionOutcome {
  decision: "show" | "suppress_below_threshold" | "suppress_no_context";
  candidates: InputPredictionCandidate[];
  topConfidence: number;
}

/** 草稿归一：纯空白视为无草稿。 */
export function normalizeInputPredictionDraft(draft: string | undefined): string {
  return draft && draft.trim().length > 0 ? draft : "";
}

/** JSON 清洗容错：剥 think 段、code fence、尾逗号、前后说明文字。 */
export function parseInputPredictionResponse(raw: string): InputPredictionCandidate[] | null {
  const withoutThinking = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const parsed =
    tryParseCandidates(withoutThinking) ?? tryParseCandidates(stripJsonArtifacts(withoutThinking));
  if (!parsed) return null;
  const cleaned = parsed.filter(
    (candidate) => candidate.text.length > 0 && Number.isFinite(candidate.confidence),
  );
  return cleaned.length > 0 ? cleaned : null;
}

function tryParseCandidates(text: string): InputPredictionCandidate[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const candidates = (parsed as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return null;
  const result: InputPredictionCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const { text, confidence } = candidate as { text?: unknown; confidence?: unknown };
    if (typeof text === "string" && typeof confidence === "number") {
      result.push({ text, confidence });
    }
  }
  return result;
}

function stripJsonArtifacts(text: string): string {
  const fenced = text.match(/^```[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i);
  let candidate = (fenced?.[1] ?? text).trim().replace(/,\s*([}\]])/g, "$1");
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first >= 0 && last > first) candidate = candidate.slice(first, last + 1);
  return candidate;
}

/**
 * 把模型给的候选收敛成「接在草稿后面的文本」：
 * - 单行化；
 * - 模型重复了草稿时剥掉草稿前缀；
 * - 无草稿时两端 trim，有草稿时只 trim 末尾（续写开头的空格有意义），
 *   但草稿以空白结尾时续写不再以空白开头；
 * - 截断到上限：线格式按 UTF-16 长度计（zod .max），截断时不劈开代理对。
 */
export function toInputPredictionSuffix(rawText: string, draft: string): string {
  let text = rawText.replace(/[\r\n]+/g, " ");
  if (draft.length === 0) {
    text = text.trim();
  } else {
    const trimmedDraft = draft.trimEnd();
    if (text.startsWith(draft)) text = text.slice(draft.length);
    else if (trimmedDraft.length > 0 && text.startsWith(trimmedDraft)) {
      text = text.slice(trimmedDraft.length);
    }
    text = text.trimEnd();
    if (/\s$/.test(draft)) text = text.trimStart();
  }
  if (text.length <= INPUT_PREDICTION_MAX_TEXT_CHARS) return text;
  let bounded = "";
  for (const codePoint of text) {
    if (bounded.length + codePoint.length > INPUT_PREDICTION_MAX_TEXT_CHARS) break;
    bounded += codePoint;
  }
  return bounded.trimEnd();
}

/**
 * 候选是否携带协议标记：指令回显、预测块标签或系统提醒包装。
 * 这类文本一旦被当成候选展示并被接受，就会被用户原样发回模型
 * （2026-11-02 线上事故：候选胶囊回显注入指令，接受后整段指令被当成输入发出）。
 */
export function isDirectiveEchoText(text: string): boolean {
  if (text.includes("【输入预测】")) return true;
  if (text.includes(NEXT_INPUT_BLOCK_OPEN) || text.includes(NEXT_INPUT_BLOCK_CLOSE)) return true;
  if (text.includes("<system-reminder>") || text.includes("</system-reminder>")) return true;
  return false;
}

/**
 * 后过滤 + 决策：
 * - 轮数不够 → suppress_no_context；
 * - 收敛为续写文本，空白丢弃；
 * - 指令/协议标记回显一律丢弃（见 {@link isDirectiveEchoText}）；
 * - 与最近 2 条真实用户输入相同（按完整文本，大小写/空白不敏感）丢弃；
 * - 候选间同文本只留置信度高者；
 * - 按置信度降序取前 3；top ≥ 门槛 → show，否则 suppress_below_threshold。
 */
export function decideInputPrediction(input: {
  rawCandidates: readonly InputPredictionCandidate[];
  draft: string;
  recentUserInputs: readonly string[];
  turnCount: number;
  threshold?: number;
}): InputPredictionOutcome {
  const { draft } = input;
  const threshold = input.threshold ?? INPUT_PREDICTION_CONFIDENCE_THRESHOLD;
  const recent = new Set(
    input.recentUserInputs.slice(-RECENT_USER_INPUT_DEDUPE_COUNT).map(normalizeForDedupe),
  );
  const byKey = new Map<string, InputPredictionCandidate>();
  for (const candidate of input.rawCandidates) {
    const confidence = Math.min(1, Math.max(0, candidate.confidence));
    const text = toInputPredictionSuffix(candidate.text, draft);
    if (text.trim().length === 0) continue;
    if (isDirectiveEchoText(text)) continue;
    const key = normalizeForDedupe(draft + text);
    if (recent.has(key)) continue;
    const existing = byKey.get(key);
    if (!existing || existing.confidence < confidence) byKey.set(key, { text, confidence });
  }
  const candidates = Array.from(byKey.values())
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, INPUT_PREDICTION_MAX_CANDIDATES);
  const topConfidence = candidates[0]?.confidence ?? 0;
  return {
    decision:
      candidates.length > 0 && topConfidence >= threshold ? "show" : "suppress_below_threshold",
    candidates,
    topConfidence,
  };
}

// ─── 主轮输出附带预测（注入指令 + 流过滤 + 尾块解析） ────────────────────────

/** 注入到本轮最后一条 user message 尾部的指令（request-only，不写入持久化轨迹）。 */
export const INPUT_PREDICTION_INJECTION_DIRECTIVE = [
  "",
  "【输入预测】回复正文全部结束后，另起一行输出一个预测块：",
  '<next_input>{"candidates":[{"text":"...","confidence":0.9}]}</next_input>',
  "- candidates 是用户在本轮之后最可能发送的 1-3 条完整输入，按把握从高到低排序。",
  "- 每条 text 单行、不超过 40 字、语言与用户一致；confidence 为 0 到 1。",
  "- 没有把握就少写几条，不要编造；预测块必须放在回复的最末尾，除此之外不要输出任何解释。",
].join("\n");

// 指令起止标记：用于把「已经被带进消息正文的指令副本」剥掉（出站清洗）。
const DIRECTIVE_START_MARKER = "【输入预测】回复正文全部结束后";
const DIRECTIVE_END_MARKER = "不要输出任何解释。";

/**
 * 剥掉消息正文里已存在的注入指令副本（可能来自模型回显被接受、粘贴、或
 * 上一轮注入残留）。循环删除每一段「标记起点 → 标记终点」，保护用户真实内容。
 * 没有标记（或标记不成对）时原样返回，不猜边界。
 */
export function stripInjectedPredictionDirective(text: string): string {
  let result = text;
  for (;;) {
    const start = result.indexOf(DIRECTIVE_START_MARKER);
    if (start < 0) return result;
    const endIndex = result.indexOf(DIRECTIVE_END_MARKER, start);
    if (endIndex < 0) return result;
    const before = result.slice(0, start);
    const after = result.slice(endIndex + DIRECTIVE_END_MARKER.length);
    // 合并两侧时去掉因删除产生的多余空行，但不吞用户正文。
    const trimmedBefore = before.replace(/\s+$/u, "");
    const trimmedAfter = after.replace(/^\s+/u, "");
    result =
      trimmedAfter.length > 0
        ? `${trimmedBefore}${trimmedBefore.length > 0 ? "\n" : ""}${trimmedAfter}`
        : trimmedBefore;
  }
}

/**
 * 出站清洗：把**整个请求**里所有 user message 中残留的指令副本剥掉。
 * 指令副本可能来自：模型回显被当成候选接受、用户粘贴、上一轮注入残留。
 * 不清洗的话指令会一轮轮堆进对话正文（2026-11-02 线上：同一段指令被连续
 * 多轮当成用户消息发给模型）。只删标记段，用户真实正文不受影响。
 */
function sanitizeInjectedDirectives(messages: ModelInputMessage[]): void {
  for (const message of messages) {
    if (message.role !== "user") continue;
    if (typeof message.content === "string") {
      message.content = stripInjectedPredictionDirective(message.content);
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "text") block.text = stripInjectedPredictionDirective(block.text);
    }
  }
}

/**
 * 给本次请求注入预测指令（原地修改传入数组）。
 *
 * 分两步，顺序不能反：
 * 1. **先全请求清洗**：剥掉所有 user message 里已存在的指令副本；
 * 2. **再对最后一条 user message 追加一份**。
 * 这样无论指令副本从哪条路径进来，模型每次只会看到末尾这一份规范副本。
 *
 * content 为块数组（带图片/文件附件的消息）时复用最后一个 text 块——
 * 绝不能用模板字符串拼接整个 content，那会把块数组强转成
 * "[object Object],[object Object]" 并毁掉图片块（2026-11-01 线上事故）。
 * 找不到 user message 时不做任何事。
 */
export function appendInputPredictionDirective(messages: ModelInputMessage[]): void {
  sanitizeInjectedDirectives(messages);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user") continue;
    if (typeof message.content === "string") {
      const cleaned = message.content.trimEnd();
      // 清洗后正文为空 = 这条消息原本只有指令副本：不注入（否则会造出
      // "只有指令、没有任何提问"的请求，模型无从预测）。
      if (cleaned.length === 0) return;
      message.content = `${cleaned}

${INPUT_PREDICTION_INJECTION_DIRECTIVE}`;
      return;
    }
    if (Array.isArray(message.content)) {
      for (let block = message.content.length - 1; block >= 0; block -= 1) {
        const candidate = message.content[block];
        if (candidate?.type === "text") {
          const cleaned = candidate.text.trimEnd();
          if (cleaned.length === 0) return;
          candidate.text = `${cleaned}

${INPUT_PREDICTION_INJECTION_DIRECTIVE}`;
          return;
        }
      }
      message.content.push({ type: "text", text: INPUT_PREDICTION_INJECTION_DIRECTIVE });
      return;
    }
  }
}

export interface NextInputStreamFilter {
  /** 返回本次可见的增量；预测块开标签之后的增量一律吞掉。 */
  consume(delta: string): string;
  /** 流结束时冲出扣住的尾部（可能是标签前缀的可见部分）。 */
  finish(): string;
  /** 未过滤全文：完成边界用它解析候选块。 */
  readonly fullText: string;
}

/**
 * 流式过滤器：预测块一旦开始就不再进入可见流；标签前缀扣住等下一个增量判定，
 * 避免把 `<next_in` 这样的半个标签闪给用户。全文另行保留供完成边界解析。
 */
export function createNextInputStreamFilter(): NextInputStreamFilter {
  let full = "";
  let visibleHeld = "";
  let suppressed = false;
  return {
    consume(delta: string): string {
      full += delta;
      if (suppressed) return "";
      visibleHeld += delta;
      const open = visibleHeld.indexOf(NEXT_INPUT_BLOCK_OPEN);
      if (open >= 0) {
        const visible = visibleHeld.slice(0, open);
        visibleHeld = "";
        suppressed = true;
        return visible;
      }
      // 尾部可能是标签前缀：扣住等下一个增量再判定。
      let hold = Math.min(visibleHeld.length, NEXT_INPUT_BLOCK_OPEN.length - 1);
      while (hold > 0 && !NEXT_INPUT_BLOCK_OPEN.startsWith(visibleHeld.slice(-hold))) hold -= 1;
      if (hold === 0) {
        const visible = visibleHeld;
        visibleHeld = "";
        return visible;
      }
      const visible = visibleHeld.slice(0, visibleHeld.length - hold);
      visibleHeld = visibleHeld.slice(visibleHeld.length - hold);
      return visible;
    },
    finish(): string {
      const tail = visibleHeld;
      visibleHeld = "";
      return tail;
    },
    get fullText(): string {
      return full;
    },
  };
}

/** 完成边界：从全文解析 `<next_input>` 候选块；无块或解析失败返回 null。 */
export function parseNextInputPredictionBlock(fullText: string): InputPredictionCandidate[] | null {
  const open = fullText.lastIndexOf(NEXT_INPUT_BLOCK_OPEN);
  if (open < 0) return null;
  const close = fullText.indexOf(NEXT_INPUT_BLOCK_CLOSE, open);
  const inner = fullText
    .slice(open + NEXT_INPUT_BLOCK_OPEN.length, close >= 0 ? close : undefined)
    .replace(/^>/, "")
    .trim();
  const raw = tryParseCandidates(inner);
  if (!raw || raw.length === 0) return null;
  // 钳制置信度 + 按文本去重 + 截到上限（与独立调模型路径同规则）。
  // 解析边界同样拦指令回显：模型可能把注入指令本身当成"用户会说的话"返回，
  // 那种文本一旦进胶囊并被接受，就会被原样发回模型（线上事故）。
  const byKey = new Map<string, InputPredictionCandidate>();
  for (const candidate of raw) {
    const text = toInputPredictionSuffix(candidate.text, "");
    if (text.trim().length === 0) continue;
    if (isDirectiveEchoText(text)) continue;
    const confidence = Math.min(1, Math.max(0, candidate.confidence));
    const key = normalizeForDedupe(text);
    const existing = byKey.get(key);
    if (!existing || existing.confidence < confidence) byKey.set(key, { text, confidence });
  }
  const candidates = Array.from(byKey.values())
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, INPUT_PREDICTION_MAX_CANDIDATES);
  return candidates.length > 0 ? candidates : null;
}

/** 去重归一：小写 + 去掉全部空白。 */
function normalizeForDedupe(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "");
}
