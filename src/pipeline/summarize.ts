import type { Env, Session, FiveW1H } from "../types";
import { generateFiveW1H } from "../gemini/client";
import { generateTextMimo } from "../llm/mimo";
import { fiveW1HSystemInstruction, fiveW1HUserPrompt } from "../gemini/prompts";
import { saveSummary } from "../store/session";
import { logJson } from "../util/timing";

/**
 * 后台预算一个 session 的所有大章节 5W1H，逐个写回 KV。
 * 由 generate 路由通过 ctx.waitUntil 触发，不阻塞主响应。
 *
 * 串行执行：免费档 Gemini RPM 有限，避免并发撞限流。
 */
export async function precomputeSummaries(
  env: Env,
  sessionId: string,
  session: Session,
): Promise<void> {
  const start = performance.now();
  const sys = fiveW1HSystemInstruction();
  let ok = 0;

  for (const chapter of session.chapters) {
    const prompt = fiveW1HUserPrompt(session.transcript, chapter);
    try {
      let data: FiveW1H;
      try {
        data = await generateFiveW1H(prompt, {
          apiKey: env.GEMINI_API_KEY,
          model: env.GEMINI_MODEL,
          systemInstruction: sys,
        });
      } catch (e) {
        // 降级到 MiMo（无 key 则继续抛）。
        if (!env.MIMO_API_KEY) throw e;
        logJson({ stage: "summarize.fallback", chapterId: chapter.id, error: String(e) });
        data = await fiveW1HViaMimo(prompt, sys, env);
      }
      await saveSummary(env, sessionId, chapter.id, data);
      ok++;
    } catch (e) {
      logJson({ stage: "summarize.chapter", chapterId: chapter.id, error: String(e) });
    }
  }

  logJson({
    stage: "summarize.done",
    sessionId,
    total: session.chapters.length,
    ok,
    summarizeMs: Math.round(performance.now() - start),
  });
}

/**
 * MiMo 版 5W1H：OpenAI 兼容端不支持 Gemini 的 responseSchema，故在 prompt 里
 * 显式要求纯 JSON，再容错解析（剥离 ```json 围栏、截取首个 {...}）。
 */
export async function fiveW1HViaMimo(
  prompt: string,
  sys: string,
  env: Env,
): Promise<FiveW1H> {
  const jsonSys =
    sys +
    '\n\n只输出一个 JSON 对象，键为 who/what/when/where/why/how，值为中文字符串，不要任何额外文字或代码围栏。';
  const raw = await generateTextMimo(prompt, {
    apiKey: env.MIMO_API_KEY!,
    model: env.MIMO_MODEL || "mimo-v2.5-pro",
    systemInstruction: jsonSys,
    temperature: 0.4,
  });
  const json = extractJsonObject(raw);
  const parsed = JSON.parse(json) as Partial<FiveW1H>;
  return {
    who: parsed.who ?? "",
    what: parsed.what ?? "",
    when: parsed.when ?? "",
    where: parsed.where ?? "",
    why: parsed.why ?? "",
    how: parsed.how ?? "",
  };
}

/** 从模型输出里抽出首个 JSON 对象文本（容忍 ```json 围栏与前后噪声）。 */
function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("MiMo 5W1H 未返回可解析 JSON");
  }
  return body.slice(start, end + 1);
}
