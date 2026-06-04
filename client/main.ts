import {
  renderArticle,
  splitMarkdownByChapter,
  attachButton,
  renderFiveW1HCard,
  type FiveW1H,
} from "./render";
import { parseSubtitle } from "./subtitle";

const SAMPLE_URL = "https://www.youtube.com/watch?v=xRh2sVcNXQ8";

const form = byId<HTMLFormElement>("gen-form");
const urlInput = byId<HTMLInputElement>("url");
const urlLabel = byId<HTMLElement>("url-label");
const reqInput = byId<HTMLTextAreaElement>("requirement");
const submitBtn = byId<HTMLButtonElement>("submit-btn");
const cancelBtn = byId<HTMLButtonElement>("cancel-btn");
const sampleBtn = byId<HTMLButtonElement>("sample-btn");
const sourceSeg = byId<HTMLElement>("source-seg");
const fileField = byId<HTMLElement>("file-field");
const fileInput = byId<HTMLInputElement>("subtitle-file");
const fileHint = byId<HTMLElement>("file-hint");
const statusEl = byId<HTMLElement>("status");
const articleEl = byId<HTMLElement>("article");
const timingEl = byId<HTMLElement>("timing");

// 右侧 5W1H 面板元素。
const panelEl = byId<HTMLElement>("w5h1-panel");
const panelTitleEl = byId<HTMLElement>("w5h1-panel-title");
const panelBodyEl = byId<HTMLElement>("w5h1-panel-body");
const panelCloseEl = byId<HTMLButtonElement>("w5h1-panel-close");

let sessionId = "";
const summaryCache = new Map<number, FiveW1H>();
/** 正在生成总结（请求未返回）的章节，避免重复请求、保持 loading 态。 */
const pendingChapters = new Set<number>();
/** 当前面板正在展示的章节 id（null=未打开）。 */
let activeChapter: number | null = null;

panelCloseEl.addEventListener("click", closePanel);

/** 当前生成的中止控制器；null=空闲。点「取消生成」时 abort，从而中断 fetch/SSE。 */
let genAbort: AbortController | null = null;

cancelBtn.addEventListener("click", () => {
  genAbort?.abort();
});

sampleBtn.addEventListener("click", () => {
  urlInput.value = SAMPLE_URL;
});

// ---------- 字幕来源：线上 / 本地 ----------

type Source = "online" | "local";
let source: Source = "online";
/** 本地模式下已解析的字幕文本与标题（文件名）。 */
let localTranscript = "";
let localTitle = "";

sourceSeg.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".seg-btn");
  if (!btn) return;
  setSource((btn.dataset.source as Source) ?? "online");
});

function setSource(next: Source) {
  source = next;
  sourceSeg.querySelectorAll<HTMLButtonElement>(".seg-btn").forEach((b) => {
    const on = b.dataset.source === next;
    b.classList.toggle("active", on);
    b.setAttribute("aria-checked", String(on));
  });
  const local = next === "local";
  fileField.hidden = !local;
  // 本地模式链接可选（去掉 required），标签提示「可选」。
  urlInput.required = !local;
  urlLabel.textContent = local ? "YouTube 链接（可选，用于元信息）" : "YouTube 链接";
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) {
    localTranscript = "";
    localTitle = "";
    setFileHint("未选择文件", "");
    return;
  }
  setFileHint(`正在读取 ${file.name}…`, "");
  try {
    const raw = await file.text();
    const parsed = parseSubtitle(raw, file.name);
    if (!parsed.trim()) throw new Error("文件解析后无有效字幕文本");
    localTranscript = parsed;
    localTitle = stripExt(file.name);
    const chars = parsed.length;
    setFileHint(`已读取 ${file.name}（约 ${chars} 字）`, "ok");
  } catch (err) {
    localTranscript = "";
    localTitle = "";
    setFileHint(
      `读取失败：${err instanceof Error ? err.message : String(err)}`,
      "err",
    );
  }
});

function setFileHint(msg: string, cls: "" | "ok" | "err") {
  fileHint.textContent = msg;
  fileHint.classList.remove("ok", "err");
  if (cls) fileHint.classList.add(cls);
}

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (source === "local" && !localTranscript.trim()) {
    setFileHint("请先选择本地字幕文件", "err");
    return;
  }
  await generate(urlInput.value.trim(), reqInput.value.trim());
});

/** 客户端续写轮数上限（与服务端 MAX_RESUME_ROUNDS 双向封顶，防死循环）。 */
const MAX_ROUNDS = 8;

async function generate(url: string, requirement: string) {
  resetUi();
  // 新一轮生成的中止控制器；取消按钮 abort 它即可中断本轮所有 fetch/SSE。
  const abort = new AbortController();
  genAbort = abort;
  // 快照本地字幕（仅首段发送；续段不重发 transcript）。
  const local =
    source === "local"
      ? { transcript: localTranscript, title: localTitle }
      : null;
  setBusy(true);
  setStatus(local ? "正在读取本地字幕…" : "正在获取字幕…");

  // markdown 与 renderer 跨段只建一次：服务端续段不重发已有内容，故持续 append 不会重复渲染。
  let markdown = "";
  const renderer = new ChapterRenderer(articleEl);
  const follow = autoFollow();
  const ui = { firstToken: true };

  try {
    let resume: { sessionId: string; round: number } | null = null;

    for (let round = 0; round <= MAX_ROUNDS; round++) {
      const before = markdown.length;
      const outcome = await runSegment({
        url,
        requirement,
        resume,
        // 本地字幕只在首段（resume==null）发送。
        local: resume ? null : local,
        signal: abort.signal,
        getMarkdown: () => markdown,
        onDelta: (text) => {
          if (ui.firstToken) {
            ui.firstToken = false;
            // 第一个文字到达才显示文章框，取字幕/等待期间不露空框。
            articleEl.hidden = false;
            setStatus("正在生成文章…");
          }
          markdown += text;
          // 只重渲染「最后一个正在生成的章节」，已完成章节 DOM 冻结。
          renderer.update(markdown, /* streaming */ true);
          follow.tick();
        },
      });

      if (outcome.kind === "done") break;
      if (outcome.kind === "incomplete") {
        // 无进展兜底：一轮后内容没增长，停止而非空转。
        if (markdown.length <= before) break;
        if (round === MAX_ROUNDS) break; // 到上限：保留已生成内容定稿
        resume = { sessionId: outcome.sessionId, round: outcome.nextRound };
        setStatus("继续生成（分段续写）…");
        continue;
      }
      break; // 正常结束（无 done/incomplete 信号）
    }

    // 收尾：定稿最后一章（去光标、挂按钮）。
    renderer.update(markdown, /* streaming */ false);
    clearStatus();
  } catch (err) {
    // 用户主动取消：定稿已生成内容（仍可逐章总结），提示已取消，不当成错误。
    if (abort.signal.aborted) {
      renderer.update(markdown, /* streaming */ false);
      setStatus(markdown.trim() ? "已取消生成（保留已生成内容）" : "已取消生成");
    } else {
      // 流中断也保留已生成内容：定稿当前内容，已出现的章节仍可逐章总结。
      renderer.update(markdown, /* streaming */ false);
      showError(err instanceof Error ? err.message : String(err));
    }
  } finally {
    if (genAbort === abort) genAbort = null;
    setBusy(false);
  }
}

type SegmentOutcome =
  | { kind: "done" }
  | { kind: "incomplete"; sessionId: string; nextRound: number }
  | { kind: "ended" };

/** 跑一段 SSE：一次 fetch + 读流。首段或续段由 opts.resume 决定。 */
async function runSegment(opts: {
  url: string;
  requirement: string;
  resume: { sessionId: string; round: number } | null;
  local: { transcript: string; title: string } | null;
  signal: AbortSignal;
  getMarkdown: () => string;
  onDelta: (text: string) => void;
}): Promise<SegmentOutcome> {
  const body = opts.resume
    ? {
        resume: opts.resume.sessionId,
        round: opts.resume.round,
        requirement: opts.requirement,
        clientArticle: opts.getMarkdown(), // KV 最终一致性后备：服务端按长度取 max
      }
    : {
        url: opts.url,
        requirement: opts.requirement,
        // 本地字幕模式：带上解析后的字幕文本与标题，服务端据此跳过线上抓取。
        ...(opts.local
          ? { localTranscript: opts.local.transcript, localTitle: opts.local.title }
          : {}),
      };

  const res = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const msg = await res.text().catch(() => "");
    throw new Error(msg || `请求失败 (${res.status})`);
  }

  let outcome: SegmentOutcome = { kind: "ended" };
  await readSse(res.body, (evt) => {
    switch (evt.type) {
      case "session":
        sessionId = evt.sessionId;
        break;
      case "resume":
        // 服务端确认续写；已有 markdown 在前端，无需渲染。
        break;
      case "status":
        setStatus(evt.message);
        break;
      case "delta":
        opts.onDelta(evt.text);
        break;
      case "chapters":
        // 章节边界前端已自行推断（## 顺序），保留兼容，无需处理。
        break;
      case "timing":
        renderTiming(evt.timing);
        break;
      case "incomplete":
        outcome = {
          kind: "incomplete",
          sessionId: evt.sessionId,
          nextRound: evt.nextRound,
        };
        break;
      case "done":
        outcome = { kind: "done" };
        break;
      case "error":
        throw new Error(evt.message);
    }
  });
  return outcome;
}

/**
 * 增量章节渲染器：把文章按 `## ` 分块渲染到独立容器，
 * 流式时只重渲染「最后一个正在生成的章节」，已完成章节 DOM 冻结。
 *
 * 解决全量 innerHTML 重建导致的：①闪烁 ②点击落空 ③展开的 5W1H 卡片被冲掉。
 */
class ChapterRenderer {
  private headEl: HTMLElement;
  /** 各章节的容器，索引即 chapterId（与后端 H2 顺序一致）。 */
  private blocks: HTMLElement[] = [];
  /** 已「定稿」（不再重渲染）的章节数。 */
  private frozen = 0;

  constructor(private root: HTMLElement) {
    this.root.innerHTML = "";
    this.headEl = document.createElement("div");
    this.headEl.className = "article-head";
    this.root.appendChild(this.headEl);
  }

  /**
   * @param markdown 当前累积的全文
   * @param streaming true=生成中（最后一章带光标、不挂按钮）；false=定稿（去光标、挂按钮）
   */
  update(markdown: string, streaming: boolean): void {
    const { head, chapters } = splitMarkdownByChapter(markdown);

    // 头部（# 大标题等）：仅在变化时更新，开销极小。
    const headHtml = head.trim() ? renderArticle(head) : "";
    if (this.headEl.innerHTML !== headHtml) this.headEl.innerHTML = headHtml;

    // 为新出现的章节创建容器。
    for (let i = this.blocks.length; i < chapters.length; i++) {
      const el = document.createElement("section");
      el.className = "chapter-block";
      this.root.appendChild(el);
      this.blocks.push(el);
    }

    // 定稿已完成的章节（除最后一章外，或非 streaming 时含最后一章）。
    const lastIdx = chapters.length - 1;
    const freezeUpTo = streaming ? lastIdx : chapters.length; // 不含/含最后一章
    for (let i = this.frozen; i < freezeUpTo; i++) {
      this.renderBlock(i, chapters[i], /* withCursor */ false, /* withButton */ true);
    }
    this.frozen = Math.max(this.frozen, freezeUpTo);

    // 最后一章正在生成：只重渲染它（带光标、暂不挂按钮）。
    if (streaming && lastIdx >= this.frozen && lastIdx >= 0) {
      this.renderBlock(lastIdx, chapters[lastIdx], /* withCursor */ true, /* withButton */ false);
    }
  }

  private renderBlock(
    id: number,
    md: string,
    withCursor: boolean,
    withButton: boolean,
  ): void {
    const el = this.blocks[id];
    if (!el) return;
    el.innerHTML = renderArticle(md);
    if (withCursor) el.classList.add("cursor");
    else el.classList.remove("cursor");
    if (withButton) {
      const h2 = el.querySelector("h2");
      if (h2) attachButton(h2 as HTMLElement, id, onFiveW1HClick);
    }
  }
}

/**
 * 点击章节 5W1H 按钮：
 *  - 已在看同章 **且已生成/生成中** → 收起（toggle 关闭）。
 *  - 已在看同章 **但仍未生成**（多因滚动联动把面板切到此章只展示「未生成」提示）
 *    → 触发生成，而不是收起。这正是修复点：否则点击会误判为「再点一次=关闭」，
 *    导致卡片消失且不生成。
 *  - 未在看此章 → 打开 + 触发生成。
 */
function onFiveW1HClick(chapterId: number, h2: HTMLElement) {
  const generatedOrPending =
    summaryCache.has(chapterId) || pendingChapters.has(chapterId);
  if (activeChapter === chapterId && generatedOrPending) {
    closePanel();
    return;
  }
  const title = chapterTitle(h2);
  showChapterInPanel(chapterId, title, /* triggerGenerate */ true);
}

/** 从 h2 取纯标题文字（去掉 5W1H 按钮文本）。 */
function chapterTitle(h2: HTMLElement): string {
  return (h2.childNodes[0]?.textContent ?? "").trim();
}

/**
 * 在面板中展示某章的 5W1H。
 * @param triggerGenerate 缓存未命中时是否主动请求生成。
 *   点击=true（用户意图明确）；滚动联动=false（只展示已有，否则会狂刷 API）。
 */
async function showChapterInPanel(
  chapterId: number,
  title: string,
  triggerGenerate: boolean,
) {
  openPanel(chapterId, title);

  // 已有缓存 → 完成态，直接渲染。
  if (summaryCache.has(chapterId)) {
    setChapterState(chapterId, "done");
    panelBodyEl.innerHTML = renderFiveW1HCard(summaryCache.get(chapterId)!);
    return;
  }

  // 无缓存且不主动生成（滚动联动）。
  if (!triggerGenerate) {
    // 该章正在生成中 → 显示生成中，不打断、不重复请求。
    if (pendingChapters.has(chapterId)) {
      setChapterState(chapterId, "loading");
      panelBodyEl.innerHTML = `<div class="loading">总结生成中…</div>`;
      return;
    }
    // 否则未生成态，只显示提示。
    setChapterState(chapterId, "idle");
    panelBodyEl.innerHTML =
      `<div class="hint">该章节尚未生成总结。<br/>点此章的 <b>5W1H</b> 按钮即可生成。</div>`;
    return;
  }

  // 生成中态。
  setChapterState(chapterId, "loading");
  panelBodyEl.innerHTML = `<div class="loading">总结生成中…</div>`;

  // 已有在途请求 → 不重复发起，等它返回即可（loading 态已展示）。
  if (pendingChapters.has(chapterId)) return;

  pendingChapters.add(chapterId);
  try {
    const data = await fetchSummary(chapterId);
    summaryCache.set(chapterId, data);
    setChapterState(chapterId, "done"); // 成功 → 绿（无论面板是否还开着）
    if (activeChapter === chapterId) {
      panelBodyEl.innerHTML = renderFiveW1HCard(data);
    }
  } catch (err) {
    setChapterState(chapterId, "idle"); // 失败 → 回到未生成，可重试
    if (activeChapter === chapterId) {
      panelBodyEl.innerHTML = `<div class="err">总结获取失败：${
        err instanceof Error ? err.message : String(err)
      }</div>`;
    }
  } finally {
    pendingChapters.delete(chapterId);
  }
}

type ChapterState = "idle" | "loading" | "done";

/**
 * 设置某章的状态，同步「流式框里的按钮」与「面板标签」的三态配色。
 * idle=灰(未生成) / loading=蓝(生成中) / done=绿(完成)。
 */
function setChapterState(chapterId: number, state: ChapterState) {
  const btn = buttonOf(chapterId);
  if (btn) {
    btn.classList.toggle("loading", state === "loading");
    btn.classList.toggle("done", state === "done");
  }
  // 面板标签只反映「当前正在查看的章」的状态。
  if (activeChapter === chapterId) {
    panelEl.classList.toggle("state-loading", state === "loading");
    panelEl.classList.toggle("state-done", state === "done");
  }
}

/** 打开/切换右侧面板到某章。切章时先清面板标签状态，由 showChapterInPanel 重设。 */
function openPanel(chapterId: number, title: string) {
  activeChapter = chapterId;
  panelTitleEl.textContent = title;
  panelEl.classList.remove("state-loading", "state-done");
  panelEl.hidden = false;
  panelEl.setAttribute("aria-hidden", "false");
  document.body.classList.add("panel-open");
  requestAnimationFrame(() => panelEl.classList.add("open"));
  highlightActiveButton(chapterId);
}

/** 关闭右侧面板。 */
function closePanel() {
  activeChapter = null;
  panelEl.classList.remove("open", "state-loading", "state-done");
  panelEl.setAttribute("aria-hidden", "true");
  document.body.classList.remove("panel-open");
  highlightActiveButton(null);
  setTimeout(() => {
    if (activeChapter === null) panelEl.hidden = true;
  }, 280);
}

/** 标记当前面板查看中的章节按钮（.active 发光环，不影响三态色）。 */
function highlightActiveButton(chapterId: number | null) {
  articleEl.querySelectorAll(".w5h1-btn.active").forEach((b) =>
    b.classList.remove("active"),
  );
  if (chapterId === null) return;
  buttonOf(chapterId)?.classList.add("active");
}

function buttonOf(chapterId: number): HTMLElement | null {
  return articleEl.querySelector(`.w5h1-btn[data-chapter-id="${chapterId}"]`);
}

/**
 * 滚动联动：面板打开时，找视口顶部附近最靠上的章节，自动切换面板到该章。
 * 只展示已有总结（不主动生成）。节流到每帧一次。
 */
let followScrollRaf = 0;
function onArticleScroll() {
  if (activeChapter === null) return; // 面板没开就不联动
  if (followScrollRaf) return;
  followScrollRaf = requestAnimationFrame(() => {
    followScrollRaf = 0;
    const blocks = Array.from(
      articleEl.querySelectorAll<HTMLElement>(".chapter-block"),
    );
    if (!blocks.length) return;
    // 选「标题顶部已越过视口 ~120px 线」的最后一个章节（即当前正在读的章）。
    const line = 120;
    let current = 0;
    blocks.forEach((b, i) => {
      if (b.getBoundingClientRect().top <= line) current = i;
    });
    if (current !== activeChapter) {
      const h2 = blocks[current]?.querySelector("h2");
      if (h2) showChapterInPanel(current, chapterTitle(h2 as HTMLElement), false);
    }
  });
}
window.addEventListener("scroll", onArticleScroll, { passive: true });

/** 拉取 5W1H；后台未算完返回 202 时短暂重试。 */
async function fetchSummary(chapterId: number): Promise<FiveW1H> {
  const max = 8;
  for (let i = 0; i < max; i++) {
    const res = await fetch(
      `/api/summary?session=${encodeURIComponent(sessionId)}&chapter=${chapterId}`,
    );
    if (res.status === 202) {
      await sleep(1200);
      continue;
    }
    if (!res.ok) throw new Error(`(${res.status})`);
    return (await res.json()) as FiveW1H;
  }
  throw new Error("超时，请稍后重试");
}

// ---------- SSE 读取 ----------

type SseEvent =
  | { type: "session"; sessionId: string }
  | { type: "resume"; sessionId: string; round: number; restoredChars: number }
  | { type: "status"; message: string }
  | { type: "delta"; text: string }
  | { type: "chapters"; chapters: { id: number; title: string }[] }
  | { type: "timing"; timing: Record<string, number> }
  | { type: "incomplete"; sessionId: string; round: number; nextRound: number; chars: number }
  | { type: "done" }
  | { type: "error"; message: string };

async function readSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (evt: SseEvent) => void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const line = raw.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const json = line.slice(5).trim();
      if (!json) continue;
      onEvent(JSON.parse(json) as SseEvent);
    }
  }
}

// ---------- 自动跟随滚动 ----------

function autoFollow() {
  let following = true;
  const onScroll = () => {
    const nearBottom =
      window.innerHeight + window.scrollY >=
      document.body.scrollHeight - 80;
    following = nearBottom;
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  return {
    tick() {
      if (following) window.scrollTo(0, document.body.scrollHeight);
    },
  };
}

// ---------- UI 辅助 ----------

function renderTiming(t: Record<string, number>) {
  timingEl.hidden = false;
  timingEl.innerHTML = `<details><summary>⏱ 本次耗时：取字幕 ${fmt(
    t.transcriptMs,
  )} · 首字节 ${fmt(t.ttfbMs)} · 生成 ${fmt(t.articleMs)} · 合计 ${fmt(
    t.totalMs,
  )}</summary><div class="note">以上均为墙钟时间（含网络等待）；真实 CPU 时间请用 <code>wrangler tail</code> 或 Cloudflare 后台查看（本应用为 I/O 密集型，CPU 占用极小）。</div></details>`;
}
function fmt(ms: number) {
  return ms == null ? "—" : `${Math.round(ms)}ms`;
}

function resetUi() {
  sessionId = "";
  summaryCache.clear();
  articleEl.innerHTML = "";
  articleEl.hidden = true;
  timingEl.hidden = true;
  statusEl.classList.remove("error");
  closePanel();
}
function setBusy(b: boolean) {
  submitBtn.disabled = b;
  submitBtn.textContent = b ? "生成中…" : "生成文章";
  cancelBtn.hidden = !b; // 生成中才显示「取消生成」
}
function setStatus(msg: string) {
  statusEl.hidden = false;
  statusEl.classList.remove("error");
  statusEl.textContent = msg;
}
function clearStatus() {
  statusEl.hidden = true;
}
function showError(msg: string) {
  statusEl.hidden = false;
  statusEl.classList.add("error");
  statusEl.innerHTML = `生成失败：${msg}<button type="button" class="link-btn retry">重试</button>`;
  statusEl.querySelector(".retry")?.addEventListener("click", () => {
    generate(urlInput.value.trim(), reqInput.value.trim());
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}
