import type { Env } from "../types";
import { loadSession, loadSummary, saveSummary } from "../store/session";
import { generateFiveW1H } from "../gemini/client";
import { fiveW1HSystemInstruction, fiveW1HUserPrompt } from "../gemini/prompts";

/**
 * GET /api/summary?session=<id>&chapter=<id>
 *
 * 优先返回后台预算好的结果（秒出）。若尚未算完，则就地补算一次并回写
 * （兼顾「点击秒出」与「后台偶发失败也能恢复」）；上下文全部来自服务端 KV，
 * 前端不传任何文章内容。
 */
export async function handleSummary(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("session") ?? "";
  const chapterId = Number(url.searchParams.get("chapter"));
  if (!sessionId || !Number.isInteger(chapterId)) {
    return json({ error: "缺少 session 或 chapter 参数" }, 400);
  }

  // 1. 命中预算结果 → 秒出
  const cached = await loadSummary(env, sessionId, chapterId);
  if (cached) return json(cached, 200);

  // 2. 未命中：取上下文补算
  const session = await loadSession(env, sessionId);
  if (!session) return json({ error: "会话已过期或不存在" }, 404);
  const chapter = session.chapters.find((c) => c.id === chapterId);
  if (!chapter) return json({ error: "章节不存在" }, 404);

  try {
    const data = await generateFiveW1H(
      fiveW1HUserPrompt(session.transcript, chapter),
      {
        apiKey: env.GEMINI_API_KEY,
        model: env.GEMINI_MODEL,
        systemInstruction: fiveW1HSystemInstruction(),
      },
    );
    await saveSummary(env, sessionId, chapterId, data);
    return json(data, 200);
  } catch (e) {
    // 可能是限流：让前端按 202 短暂重试。
    return json({ error: String(e) }, 202);
  }
}

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
