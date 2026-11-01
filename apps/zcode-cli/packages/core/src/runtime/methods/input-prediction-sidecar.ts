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

/** 决策门槛：top 候选 confidence ≥ 0.80 才展示（宁缺毋滥）。 */
export const INPUT_PREDICTION_CONFIDENCE_THRESHOLD = 0.8;
/** 去重时只看最近 2 条真实用户输入：用户刚发过的不再预测。 */
const RECENT_USER_INPUT_DEDUPE_COUNT = 2;

export interface InputPredictionCandidate {
  text: string;
  confidence: number;
}

export interface InputPredictionOutcome {
  decision: "show" | "suppress_below_threshold" | "suppress_no_context";
  candidates: InputPredictionCandidate[];
  topConfidence: number;
}

const OUTPUT_FORMAT_RULE = `- 只输出一个 JSON 对象，不要 markdown 代码块，不要任何多余文字：
{"candidates":[{"text":"...","confidence":0.0},{"text":"...","confidence":0.0},{"text":"...","confidence":0.0}]}`;

const CONFIDENCE_RULE = `- 每个候选带 confidence（0 到 1 的小数）：你对"用户真的会这样写"的把握。三个候选的置信度要拉开差距；校准比乐观重要，拿不准就给低分。`;

// 草稿为空：预测下一条完整输入。
const NEXT_INPUT_SYSTEM_PROMPT = `你是输入预测器。根据下面的多轮对话上下文，预测这位用户下一条可能发送的输入。

这是预测任务，不是对话。绝不要回答、执行或延续对话内容；只输出预测结果。

规则：
- 恰好生成 3 个候选，按把握从高到低排列。
- 每个候选是一句用户自己会说的话（追问、指令、确认等语气），单行，不超过 ${INPUT_PREDICTION_MAX_TEXT_CHARS} 个字，语言与用户一致，不要像助手的回复。
- 候选之间要有区分度：覆盖不同的意图方向（如追问细节 / 提出新指令 / 确认推进），不要只是换个说法。
- 不要预测与上下文里用户最近已发送内容雷同的输入；那类候选会被丢弃。
- 上下文按时间正序排列，开头可能是被截断的更早内容；预测只基于给出的材料。
${CONFIDENCE_RULE}
${OUTPUT_FORMAT_RULE}`;

// 草稿非空：预测草稿后面要接上的部分。
const DRAFT_SYSTEM_PROMPT = `你是输入补全器。根据下面的多轮对话上下文和用户正在输入的草稿，预测用户接下来要在草稿后面接着写的内容。

这是补全任务，不是对话。绝不要回答、执行或延续对话内容；只输出补全结果。

规则：
- 恰好生成 3 个候选，按把握从高到低排列。
- text 只写接在草稿末尾之后的新内容，不要重复草稿本身；单行，不超过 ${INPUT_PREDICTION_MAX_TEXT_CHARS} 个字，语言与草稿一致。
- 如果草稿末尾是半个词，text 从这个词剩下的部分开始写。
- 候选之间要有区分度，不要只是换个说法。
- 上下文按时间正序排列，开头可能是被截断的更早内容；补全只基于给出的材料。
${CONFIDENCE_RULE}
${OUTPUT_FORMAT_RULE}`;

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
 * 后过滤 + 决策：
 * - 轮数不够 → suppress_no_context；
 * - 收敛为续写文本，空白丢弃；
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

const NEXT_INPUT_BLOCK_OPEN = "<next_input";
const NEXT_INPUT_BLOCK_CLOSE = "</next_input>";

/** 注入到本轮最后一条 user message 尾部的指令（request-only，不写入持久化轨迹）。 */
export const INPUT_PREDICTION_INJECTION_DIRECTIVE = [
  "",
  "【输入预测】回复正文全部结束后，另起一行输出一个预测块：",
  "<next_input>{\"candidates\":[{\"text\":\"...\",\"confidence\":0.9}]}</next_input>",
  "- candidates 是用户在本轮之后最可能发送的 1-3 条完整输入，按把握从高到低排序。",
  "- 每条 text 单行、不超过 40 字、语言与用户一致；confidence 为 0 到 1。",
  "- 没有把握就少写几条，不要编造；预测块必须放在回复的最末尾，除此之外不要输出任何解释。",
].join("\n");

/**
 * 把预测指令追加到最后一条 user message 的文本尾部（原地修改传入数组）。
 * content 为块数组时追加/复用最后一个 text 块。找不到 user message 时不做任何事。
 */
export function appendInputPredictionDirective(messages: ModelInputMessage[]): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user") continue;
    message.content = `${message.content}

${INPUT_PREDICTION_INJECTION_DIRECTIVE}`;
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
  const byKey = new Map<string, InputPredictionCandidate>();
  for (const candidate of raw) {
    const text = toInputPredictionSuffix(candidate.text, "");
    if (text.trim().length === 0) continue;
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

