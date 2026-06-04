import type { Env } from "../types";
import { streamText } from "../gemini/client";
import { streamTextMimo } from "../llm/mimo";
import {
  articleSystemInstruction,
  articleUserPrompt,
  articleContinuePrompt,
  type ChapterStrategy,
} from "../gemini/prompts";

/**
 * 流式生成对话体文章，逐块产出文本增量。
 *
 * 降级：优先 Gemini；若 Gemini 在「尚未产出任何内容」前失败（如 429 配额、
 * 鉴权、连接错误），且配置了 MIMO_API_KEY，则整段改用小米 MiMo 重试。
 * 一旦 Gemini 已产出过内容再失败，则直接抛错——此时切换会导致文章重复前半段。
 */
export async function* streamArticle(
  env: Env,
  transcript: string,
  requirement: string,
): AsyncGenerator<string, void, unknown> {
  const strategy = normalizeStrategy(env.CHAPTER_STRATEGY);
  const prompt = articleUserPrompt(transcript, requirement);
  const system = articleSystemInstruction(strategy);

  let produced = false;
  try {
    for await (const piece of streamText(prompt, {
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL,
      systemInstruction: system,
      temperature: 0.7,
    })) {
      produced = true;
      yield piece;
    }
    return;
  } catch (e) {
    // 已产出内容后失败：不可切换（会重复），直接抛。
    if (produced || !env.MIMO_API_KEY) throw e;
    console.log(
      JSON.stringify({ stage: "article.fallback", from: "gemini", error: String(e) }),
    );
  }

  // 降级到 MiMo（仅在 Gemini 尚未产出任何内容时到达此处）。
  yield* streamTextMimo(prompt, {
    apiKey: env.MIMO_API_KEY,
    model: env.MIMO_MODEL || "mimo-v2.5-pro",
    systemInstruction: system,
    temperature: 0.7,
  });
}

/** 续写时，比对已生成文章末尾的字符窗口大小：模型最多可能重述这么多字符。 */
const OVERLAP_WINDOW = 200;
/** 判定为「重叠」所需的最小匹配长度，避免巧合误裁短串。 */
const MIN_OVERLAP = 12;

/**
 * 断点续写：从已生成的部分文章 priorArticle 无缝接着流式产出。
 * 仅用 Gemini（与 streamArticle 同样的「已产出后不切换」语义）。
 *
 * 接缝去重：模型可能重述 priorArticle 的尾部。开头缓冲新流，找出「priorArticle
 * 末尾 tail 的最长后缀 == 新流 leading 的前缀」并裁掉；缓冲超过窗口仍无重叠则
 * 判定模型未重述、原样放行。之后转为直通透传。
 */
export async function* streamArticleContinue(
  env: Env,
  transcript: string,
  requirement: string,
  priorArticle: string,
): AsyncGenerator<string, void, unknown> {
  const strategy = normalizeStrategy(env.CHAPTER_STRATEGY);
  const system = articleSystemInstruction(strategy);
  const prompt = articleContinuePrompt(transcript, requirement, priorArticle);

  const tail = priorArticle.slice(-OVERLAP_WINDOW);
  let leading = "";
  let trimming = true;

  for await (const piece of streamText(prompt, {
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL,
    systemInstruction: system,
    temperature: 0.7,
  })) {
    if (trimming) {
      leading += piece;
      const trimmed = dedupeSeam(tail, leading);
      if (trimmed === null && leading.length < tail.length + OVERLAP_WINDOW) {
        continue; // 还不能判定，继续缓冲
      }
      trimming = false;
      const out = trimmed ?? leading; // 命中→裁掉重叠；超窗未命中→原样放行
      if (out) yield out;
      continue;
    }
    yield piece;
  }
}

/** 找 tail 的最长后缀同时是 leading 的前缀，命中则返回去掉该重叠后的 leading；否则 null。 */
function dedupeSeam(tail: string, leading: string): string | null {
  const max = Math.min(tail.length, leading.length);
  for (let k = max; k >= MIN_OVERLAP; k--) {
    if (tail.slice(tail.length - k) === leading.slice(0, k)) {
      return leading.slice(k);
    }
  }
  return null;
}

export function normalizeStrategy(raw: string | undefined): ChapterStrategy {
  return raw === "sentinel" ? "sentinel" : "markdown";
}
