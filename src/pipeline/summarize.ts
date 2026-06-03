import type { Env, Session } from "../types";
import { generateFiveW1H } from "../gemini/client";
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
    try {
      const data = await generateFiveW1H(
        fiveW1HUserPrompt(session.transcript, chapter),
        {
          apiKey: env.GEMINI_API_KEY,
          model: env.GEMINI_MODEL,
          systemInstruction: sys,
        },
      );
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
