import {
  renderArticle,
  injectChapterButtons,
  renderFiveW1HCard,
  type FiveW1H,
} from "./render";

const SAMPLE_URL = "https://www.youtube.com/watch?v=xRh2sVcNXQ8";

const form = byId<HTMLFormElement>("gen-form");
const urlInput = byId<HTMLInputElement>("url");
const reqInput = byId<HTMLTextAreaElement>("requirement");
const submitBtn = byId<HTMLButtonElement>("submit-btn");
const sampleBtn = byId<HTMLButtonElement>("sample-btn");
const statusEl = byId<HTMLElement>("status");
const articleEl = byId<HTMLElement>("article");
const timingEl = byId<HTMLElement>("timing");

let sessionId = "";
const summaryCache = new Map<number, FiveW1H>();

sampleBtn.addEventListener("click", () => {
  urlInput.value = SAMPLE_URL;
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  await generate(urlInput.value.trim(), reqInput.value.trim());
});

async function generate(url: string, requirement: string) {
  resetUi();
  setBusy(true);
  setStatus("正在获取字幕…");

  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, requirement }),
    });
    if (!res.ok || !res.body) {
      const msg = await res.text().catch(() => "");
      throw new Error(msg || `请求失败 (${res.status})`);
    }

    articleEl.hidden = false;
    let firstToken = true;
    let markdown = "";
    let chapters: { id: number; title: string }[] = [];
    const follow = autoFollow();

    await readSse(res.body, (evt) => {
      switch (evt.type) {
        case "session":
          sessionId = evt.sessionId;
          break;
        case "status":
          setStatus(evt.message);
          break;
        case "delta":
          if (firstToken) {
            firstToken = false;
            setStatus("正在生成文章…");
          }
          markdown += evt.text;
          articleEl.innerHTML = renderArticle(markdown);
          articleEl.classList.add("cursor");
          follow.tick();
          break;
        case "chapters":
          chapters = evt.chapters;
          break;
        case "timing":
          renderTiming(evt.timing);
          break;
        case "error":
          throw new Error(evt.message);
      }
    });

    // 收尾：去掉光标，挂按钮。
    articleEl.classList.remove("cursor");
    articleEl.innerHTML = renderArticle(markdown);
    injectChapterButtons(articleEl, chapters, onFiveW1HClick);
    clearStatus();
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  } finally {
    setBusy(false);
  }
}

async function onFiveW1HClick(chapterId: number, h2: HTMLElement) {
  const existing = h2.nextElementSibling;
  if (existing && existing.classList.contains("w5h1-card")) {
    existing.remove(); // 再次点击收起
    return;
  }

  const card = document.createElement("div");
  card.className = "w5h1-card";
  h2.after(card);

  if (summaryCache.has(chapterId)) {
    card.innerHTML = renderFiveW1HCard(summaryCache.get(chapterId)!);
    return;
  }

  card.innerHTML = `<div class="loading">总结生成中…</div>`;
  try {
    const data = await fetchSummary(chapterId);
    summaryCache.set(chapterId, data);
    card.innerHTML = renderFiveW1HCard(data);
  } catch (err) {
    card.innerHTML = `<div class="err">总结获取失败：${
      err instanceof Error ? err.message : String(err)
    }</div>`;
  }
}

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
  | { type: "status"; message: string }
  | { type: "delta"; text: string }
  | { type: "chapters"; chapters: { id: number; title: string }[] }
  | { type: "timing"; timing: Record<string, number> }
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
}
function setBusy(b: boolean) {
  submitBtn.disabled = b;
  submitBtn.textContent = b ? "生成中…" : "生成文章";
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
