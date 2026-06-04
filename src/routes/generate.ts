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
        const tr = await fetchTranscript(videoId, env);
        timer.mark("transcript");
        send(controller, {
          type: "status",
          message:
            tr.source === "fixture"
              ? "已使用内置演示字幕，正在生成文章…"
              : "字幕就绪，正在生成文章…",
        });

        const strategy = normalizeStrategy(env.CHAPTER_STRATEGY);
        const persist = (text: string): Session => {
          const parsed = parseChapters(text, strategy);
          const session: Session = {
            videoId,
            title: parsed.title || tr.title,
            requirement,
            transcript: tr.text,
            chapters: parsed.chapters,
            createdAt: new Date().toISOString(),
          };
          // 不阻塞流：异步写 KV（覆盖上一次快照）。
          ctx.waitUntil(saveSession(env, sessionId, session));
          return session;
        };

        // 2. 流式生成文章。每当解析出的章节数增加，就增量保存 session 到 KV——
        //    与前端「按章节即时挂 5W1H 按钮」对称，使流式中/中断后点总结都能命中。
        let article = "";
        let first = true;
        let savedChapters = 0;
        try {
          for await (const piece of streamArticle(env, tr.text, requirement)) {
            if (first) {
              timer.mark("ttfb");
              first = false;
            }
            article += piece;
            send(controller, { type: "delta", text: piece });

            // 章节数增加 → 有新章节写完 → 存一次快照（口径与最终解析一致）。
            const n = parseChapters(article, strategy).chapters.length;
            if (n > savedChapters) {
              savedChapters = n;
              persist(article);
            }
          }
        } catch (streamErr) {
          // 流中途断：保底再存一次当前内容，再上抛由外层 catch 发 error 事件。
          persist(article);
          throw streamErr;
        }
        if (first) timer.mark("ttfb"); // 空流兜底
        timer.mark("article");

        // 3. 解析章节并最终保存 session（覆盖增量快照，含最后一章）。
        const parsed = parseChapters(article, strategy);
        const session = persist(article);
        timer.mark("parse");

        send(controller, {
          type: "chapters",
          chapters: session.chapters.map((c) => ({ id: c.id, title: c.title })),
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
