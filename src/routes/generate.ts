import type { Env, Session } from "../types";
import { extractVideoId, fetchTranscript } from "../youtube/transcript";
import {
  streamArticle,
  streamArticleContinue,
  normalizeStrategy,
} from "../pipeline/article";
import { parseChapters } from "../pipeline/chapters";
import { precomputeSummaries } from "../pipeline/summarize";
import { saveSession, loadSession, saveRaw, loadRaw } from "../store/session";
import { Timer, logJson } from "../util/timing";
import type { ChapterStrategy } from "../gemini/prompts";

const DEFAULT_SEGMENT_BUDGET_MS = 150_000;
const DEFAULT_MAX_RESUME_ROUNDS = 6;

/**
 * POST /api/generate { url, requirement? }                    —— 首段
 *                    { resume: sessionId, round?, clientArticle?, requirement? } —— 续段
 *
 * 返回 SSE 流：session → [resume] → status → delta* → chapters → timing → (done|incomplete)。
 *
 * 单条 SSE 连接存在 ~180s 硬上限：每段在 SEGMENT_BUDGET_MS（默认 150s）内主动收尾，
 * 把已生成的原始 markdown 落 KV，发 incomplete；前端凭 sessionId 自动重连续写直到 done。
 */
export async function handleGenerate(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  let body: {
    url?: string;
    requirement?: string;
    resume?: string;
    round?: number;
    clientArticle?: string;
    /** 本地字幕模式：前端解析后的纯文本字幕。非空则跳过线上抓取。 */
    localTranscript?: string;
    /** 本地字幕模式：标题（一般用文件名），无链接时作 session 标题。 */
    localTitle?: string;
  };
  try {
    body = await req.json();
  } catch {
    return new Response("请求体非法 JSON", { status: 400 });
  }

  const isResume = !!body.resume;
  const localTranscript = (body.localTranscript ?? "").trim();
  if (!isResume) {
    // 本地字幕模式：链接可选；只要有字幕文本即可。否则必须能识别 YouTube 链接。
    if (!localTranscript) {
      const videoId = extractVideoId(body.url ?? "");
      if (!videoId) return new Response("无法识别 YouTube 链接", { status: 400 });
    }
  }

  const budgetMs = Number(env.SEGMENT_BUDGET_MS ?? "") || DEFAULT_SEGMENT_BUDGET_MS;
  const maxRounds = Number(env.MAX_RESUME_ROUNDS ?? "") || DEFAULT_MAX_RESUME_ROUNDS;

  const encoder = new TextEncoder();
  const send = (controller: ReadableStreamDefaultController, obj: unknown) =>
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

  const stream = new ReadableStream({
    async start(controller) {
      const timer = new Timer();
      const strategy = normalizeStrategy(env.CHAPTER_STRATEGY);
      try {
        // ---- 准备：续段 vs 首段 ----
        let sessionId: string;
        let videoId: string;
        let transcriptText: string;
        let titleHint: string;
        let requirement: string;
        let priorArticle = "";
        let round = 0;
        let transcriptSource: string;

        if (isResume) {
          sessionId = body.resume!;
          send(controller, { type: "session", sessionId });

          const sess = await loadSession(env, sessionId);
          if (!sess) {
            send(controller, { type: "error", message: "会话已过期或不存在，请重新生成。" });
            controller.close();
            return;
          }
          const raw = await loadRaw(env, sessionId);
          if (raw?.done) {
            // 已完成：无需再生成。
            send(controller, { type: "done" });
            controller.close();
            return;
          }

          videoId = sess.videoId;
          transcriptText = sess.transcript;
          titleHint = sess.title;
          requirement = sess.requirement;
          transcriptSource = "resume";

          // 续写上下文：服务端 raw 与前端 clientArticle 取更长者（KV 最终一致性后备）。
          const serverArt = raw?.article ?? "";
          const clientArt = (body.clientArticle ?? "").trim() ? body.clientArticle! : "";
          priorArticle = serverArt.length >= clientArt.length ? serverArt : clientArt;
          round = body.round ?? (raw?.round ?? 0) + 1;

          if (round > maxRounds) {
            // 轮数封顶：以已有内容定稿收尾，避免无限续写。
            const session = persistArticle(env, ctx, sessionId, priorArticle, strategy, {
              videoId,
              titleHint,
              requirement,
              transcript: transcriptText,
            });
            await saveRaw(env, sessionId, priorArticle, true, round);
            sendChaptersAndDone(controller, send, session);
            ctx.waitUntil(precomputeSummaries(env, sessionId, session));
            controller.close();
            return;
          }

          send(controller, {
            type: "resume",
            sessionId,
            round,
            restoredChars: priorArticle.length,
          });
        } else {
          sessionId = crypto.randomUUID();
          send(controller, { type: "session", sessionId });

          requirement = (body.requirement ?? "").trim();

          if (localTranscript) {
            // ---- 本地字幕：直接用前端解析后的文本，跳过所有线上抓取 ----
            // 链接可选：填了就取 videoId，没填用占位（仅作 session 标识，不影响生成）。
            videoId = extractVideoId(body.url ?? "") ?? `local-${sessionId.slice(0, 8)}`;
            transcriptText = localTranscript;
            titleHint = (body.localTitle ?? "").trim();
            transcriptSource = "local";
            timer.mark("transcript");
          } else {
            // ---- 线上字幕：分层降级抓取 ----
            send(controller, { type: "status", message: "正在获取字幕…" });
            videoId = extractVideoId(body.url ?? "")!;
            const tr = await fetchTranscript(videoId, env);
            timer.mark("transcript");
            transcriptText = tr.text;
            titleHint = tr.title;
            transcriptSource = tr.source;
          }
          // 首段即落一份 session 快照（含 transcript），保证续段一定能 loadSession。
          persistArticle(env, ctx, sessionId, "", strategy, {
            videoId,
            titleHint,
            requirement,
            transcript: transcriptText,
          });
          send(controller, {
            type: "status",
            message:
              transcriptSource === "local"
                ? "已读取本地字幕，正在生成文章…"
                : transcriptSource === "fixture"
                  ? "已使用内置演示字幕，正在生成文章…"
                  : "字幕就绪，正在生成文章…",
          });
        }

        // ---- 流式生成（首段 fresh / 续段 continue；priorArticle 为空则退回 fresh）----
        const source =
          priorArticle.length > 0
            ? streamArticleContinue(env, transcriptText, requirement, priorArticle)
            : streamArticle(env, transcriptText, requirement);

        // article 以 priorArticle 起始；续段不重发其 delta，仅发新增。
        let article = priorArticle;
        // 廉价章节计数：仅扫新 piece（见 countChaptersIncremental）。续段先用已有全文初始化。
        const tailState: TailState = { tail: "" };
        let chapterCount = countChaptersIncremental(priorArticle, 0, tailState, strategy);
        let savedChapters = chapterCount;
        let first = true;
        let cutover = false;

        const persist = (text: string): Session =>
          persistArticle(env, ctx, sessionId, text, strategy, {
            videoId,
            titleHint,
            requirement,
            transcript: transcriptText,
          });

        const deadline = Date.now() + budgetMs;
        const it = source[Symbol.asyncIterator]();
        try {
          while (true) {
            const { value: piece, done } = await it.next();
            if (done) break;
            if (first) {
              timer.mark("ttfb");
              first = false;
            }
            article += piece;
            send(controller, { type: "delta", text: piece });

            chapterCount = countChaptersIncremental(piece, chapterCount, tailState, strategy);
            if (chapterCount > savedChapters) {
              savedChapters = chapterCount;
              persist(article);
              ctx.waitUntil(saveRaw(env, sessionId, article, false, round));
            }

            if (Date.now() >= deadline) {
              cutover = true;
              break;
            }
          }
        } catch (streamErr) {
          // 流中途断：保底再存一次当前内容，再上抛由外层 catch 发 error。
          persist(article);
          ctx.waitUntil(saveRaw(env, sessionId, article, false, round));
          throw streamErr;
        } finally {
          // 主动收尾时取消上游 LLM fetch，避免泄漏。
          if (cutover && typeof it.return === "function") {
            await it.return(undefined).catch(() => {});
          }
        }
        if (first) timer.mark("ttfb"); // 空流兜底
        timer.mark("article");

        // ---- 收尾分支：未写完，等前端续段 ----
        if (cutover) {
          if (article.length === 0 && round === 0) {
            // 首段一字未出且被预算掐断：无内容可续，按错误处理走前端重试 UI。
            send(controller, { type: "error", message: "生成超时且无任何输出，请重试。" });
            controller.close();
            return;
          }
          await saveRaw(env, sessionId, article, false, round);
          persist(article); // 已写完的章节可经 /api/summary 懒加载 5W1H
          send(controller, {
            type: "incomplete",
            sessionId,
            round,
            nextRound: round + 1,
            chars: article.length,
          });
          logJson({ stage: "generate.cutover", sessionId, videoId, round, chars: article.length });
          controller.close();
          return;
        }

        // ---- 完成分支 ----
        const parsed = parseChapters(article, strategy);
        const session = persist(article);
        timer.mark("parse");
        await saveRaw(env, sessionId, article, true, round);

        sendChaptersAndDone(controller, send, session);
        send(controller, { type: "timing", timing: timer.summary() });

        logJson({
          stage: "generate.done",
          sessionId,
          videoId,
          transcriptSource,
          strategy,
          round,
          ...parsed.health,
          timing: timer.summary(),
        });

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

/** 解析并落一份 session 快照（异步写 KV，不阻塞流）。 */
function persistArticle(
  env: Env,
  ctx: ExecutionContext,
  sessionId: string,
  text: string,
  strategy: ChapterStrategy,
  meta: { videoId: string; titleHint: string; requirement: string; transcript: string },
): Session {
  const parsed = parseChapters(text, strategy);
  const session: Session = {
    videoId: meta.videoId,
    title: parsed.title || meta.titleHint,
    requirement: meta.requirement,
    transcript: meta.transcript,
    chapters: parsed.chapters,
    createdAt: new Date().toISOString(),
  };
  ctx.waitUntil(saveSession(env, sessionId, session));
  return session;
}

/** 发 chapters + done 两个收尾事件。 */
function sendChaptersAndDone(
  controller: ReadableStreamDefaultController,
  send: (c: ReadableStreamDefaultController, obj: unknown) => void,
  session: Session,
): void {
  send(controller, {
    type: "chapters",
    chapters: session.chapters.map((c) => ({ id: c.id, title: c.title })),
  });
  send(controller, { type: "done" });
}

interface TailState {
  /** 跨 delta 缓存的未完成末行（不含末尾换行）。 */
  tail: string;
}

/**
 * 廉价增量章节计数：仅扫新 piece（+ 上次残留半行），消除每 delta 全文重解析的 O(n²)。
 * 仅用于「章节数增加→触发快照」的判定；权威章节列表仍由完成路径的 parseChapters 产出。
 */
function countChaptersIncremental(
  piece: string,
  prev: number,
  st: TailState,
  strategy: ChapterStrategy,
): number {
  const text = st.tail + piece;
  const lines = text.split("\n");
  st.tail = lines.pop() ?? ""; // 末行可能未完，留到下次
  let n = prev;
  for (const line of lines) {
    const t = line.trimStart();
    if (strategy === "sentinel") {
      if (t.startsWith("[[H2]]")) n++;
    } else if (t.startsWith("## ") && !t.startsWith("### ")) {
      n++;
    }
  }
  return n;
}
