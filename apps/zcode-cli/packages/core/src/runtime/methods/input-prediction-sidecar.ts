// 输入预测纯函数（手机远控 ghost hint + 桌面候选胶囊共用）。规格见
// docs/web-remote-control/mobile-input-prediction.md。
//
// 2026-11-02 重构：候选由**独立辅助请求**生成（对齐 Claude Code 的 prompt
// suggestions），不再向主轮对话注入任何指令——注入方案会泄漏成用户消息、
// 并污染每一轮主请求。本文件只放无 IO 的纯函数：JSON 容错解析、续写收敛、
// 去重与决策门槛。
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
 * 候选是否携带协议标记：预测提示词自身的措辞或系统提醒包装。
 * 模型偶尔会把给它的指令原样复述成"用户会说的话"，这类文本一旦进胶囊
 * 被接受，就会作为用户输入发回模型（2026-11-02 线上事故）。
 */
export function isDirectiveEchoText(text: string): boolean {
  if (text.includes("【输入预测】")) return true;
  if (text.includes("<next_input") || text.includes("</next_input>")) return true;
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

/** 去重归一：小写 + 去掉全部空白。 */
function normalizeForDedupe(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "");
}
