import type { Env } from "../types";
import { streamText } from "../gemini/client";
import {
  articleSystemInstruction,
  articleUserPrompt,
  type ChapterStrategy,
} from "../gemini/prompts";

/** 流式生成对话体文章，逐块产出文本增量。 */
export function streamArticle(
  env: Env,
  transcript: string,
  requirement: string,
): AsyncGenerator<string, void, unknown> {
  const strategy = normalizeStrategy(env.CHAPTER_STRATEGY);
  return streamText(articleUserPrompt(transcript, requirement), {
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL,
    systemInstruction: articleSystemInstruction(strategy),
    temperature: 0.7,
  });
}

export function normalizeStrategy(raw: string | undefined): ChapterStrategy {
  return raw === "sentinel" ? "sentinel" : "markdown";
}
