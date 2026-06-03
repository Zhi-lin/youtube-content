import type { Env, Session } from "../types";
import { extractVideoId, fetchTranscript } from "../youtube/transcript";
import { streamArticle, normalizeStrategy } from "../pipeline/article";
import { parseChapters } from "../pipeline/chapters";
import { precomputeSummaries } from "../pipeline/summarize";
import { saveSession } from "../store/session";
import { Timer, logJson } from "../util/timing";

/**
 * POST /api/generate { url, requirement? }
 * 返回 SSE 流：session → status → delta* → chapters → timing。
 */
export async function handleGenerate(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  let body: { url?: string; requirement?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("请求体非法 JSON", { status: 400 });
  }
  const videoId = extractVideoId(body.url ?? "");
  if (!videoId) return new Response("无法识别 YouTube 链接", { status: 400 });
  const requirement = (body.requirement ?? "").trim();

  const encoder = new TextEncoder();
  const send = (
    controller: ReadableStreamDefaultController,
    obj: unknown,
  ) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

  const stream = new ReadableStream({
    async start(controller) {
      const timer = new Timer();
      const sessionId = crypto.randomUUID();
      try {
        send(controller, { type: "session", sessionId });

        // 1. 取字幕
        send(controller, { type: "status", message: "正在获取字幕…" });
        const tr = await fetchTranscript(videoId, env.WEBSHARE_PROXY);
        timer.mark("transcript");
        send(controller, {
          type: "status",
          message:
            tr.source === "fixture"
              ? "已使用内置演示字幕，正在生成文章…"
              : "字幕就绪，正在生成文章…",
        });

        // 2. 流式生成文章
        let article = "";
        let first = true;
        for await (const piece of streamArticle(env, tr.text, requirement)) {
          if (first) {
            timer.mark("ttfb");
            first = false;
          }
          article += piece;
          send(controller, { type: "delta", text: piece });
        }
        if (first) timer.mark("ttfb"); // 空流兜底
        timer.mark("article");

        // 3. 解析章节
        const strategy = normalizeStrategy(env.CHAPTER_STRATEGY);
        const parsed = parseChapters(article, strategy);
        timer.mark("parse");

        const session: Session = {
          videoId,
          title: parsed.title || tr.title,
          requirement,
          transcript: tr.text,
          chapters: parsed.chapters,
          createdAt: new Date().toISOString(),
        };
        await saveSession(env, sessionId, session);

        send(controller, {
          type: "chapters",
          chapters: parsed.chapters.map((c) => ({ id: c.id, title: c.title })),
        });
        send(controller, { type: "timing", timing: timer.summary() });

        // 埋点：切分健康度 + 字幕来源 + 墙钟耗时
        logJson({
          stage: "generate.done",
          sessionId,
          videoId,
          transcriptSource: tr.source,
          strategy,
          ...parsed.health,
          timing: timer.summary(),
        });

        // 4. 后台预算 5W1H（不阻塞响应）
        ctx.waitUntil(precomputeSummaries(env, sessionId, session));

        controller.close();
      } catch (e) {
        logJson({ stage: "generate.error", error: String(e) });
        send(controller, {
          type: "error",
          message: e instanceof Error ? e.message : String(e),
        });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
