import type { Env } from "../types";
import { streamText } from "../gemini/client";
import { streamTextMimo } from "../llm/mimo";
import {
  articleSystemInstruction,
  articleUserPrompt,
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

export function normalizeStrategy(raw: string | undefined): ChapterStrategy {
  return raw === "sentinel" ? "sentinel" : "markdown";
}
