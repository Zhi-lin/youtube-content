import { marked } from "marked";

export interface FiveW1H {
  who: string;
  what: string;
  when: string;
  where: string;
  why: string;
  how: string;
}

marked.setOptions({ gfm: true, breaks: true });

/** 已知说话人 → 颜色槽位，保证同一人颜色稳定。 */
const speakerSlots = new Map<string, number>();
function speakerSlot(name: string): number {
  if (!speakerSlots.has(name)) {
    speakerSlots.set(name, speakerSlots.size % 4);
  }
  return speakerSlots.get(name)!;
}

/**
 * 把（可能是半成品的）Markdown 渲染为 HTML。
 * 对话行 `说话人: 内容` 在渲染前转成带样式的 HTML，便于高亮。
 */
export function renderArticle(markdown: string): string {
  const dialogued = markdown
    .split("\n")
    .map((line) => toDialogue(line))
    .join("\n");
  return marked.parse(dialogued, { async: false }) as string;
}

// 行首 `说话人: 内容`：说话人为 1~12 个非空白且不含 `:` 的字符。
const DIALOGUE_RE = /^([^\s:：#>*\-][^:：]{0,11})[:：]\s+(.+)$/;

function toDialogue(line: string): string {
  const trimmed = line.trimStart();
  // 跳过标题/列表/引用等 Markdown 结构行。
  if (/^(#{1,6}\s|[-*+]\s|>\s|\d+\.\s|\[\[H[23]\]\])/.test(trimmed)) return line;
  const m = trimmed.match(DIALOGUE_RE);
  if (!m) return line;
  const [, speaker, content] = m;
  const slot = speakerSlot(speaker.trim());
  // 用裸 HTML（marked 默认允许），包成段落级对话块。
  return `<p class="dialogue" data-spk="${slot}"><span class="speaker">${escapeHtml(
    speaker.trim(),
  )}：</span>${escapeHtml(content)}</p>`;
}

/** 给单个 <h2> 注入 [5W1H] 按钮（已存在则跳过）。chapterId = H2 顺序索引。 */
export function attachButton(
  h2: HTMLElement,
  chapterId: number,
  onClick: (chapterId: number, h2: HTMLElement) => void,
): void {
  if (h2.querySelector(".w5h1-btn")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "w5h1-btn";
  btn.textContent = "5W1H";
  btn.dataset.chapterId = String(chapterId);
  btn.addEventListener("click", () => onClick(chapterId, h2));
  h2.appendChild(btn);
}

/**
 * 流式过程中：给「已完成」的大章节注入 5W1H 按钮。
 * 判定：当文中已有 N 个 <h2> 时，前 N-1 个必已写完（其后已出现下一个标题），
 * 立即给它们加按钮；最后一个待全文结束由 finalizeChapterButtons 补上。
 * chapterId 取 H2 顺序索引，与后端 parseChapters 的 id 规则一致。
 */
export function injectButtonsForCompletedChapters(
  root: HTMLElement,
  onClick: (chapterId: number, h2: HTMLElement) => void,
): void {
  const h2s = Array.from(root.querySelectorAll("h2"));
  for (let i = 0; i < h2s.length - 1; i++) {
    attachButton(h2s[i] as HTMLElement, i, onClick);
  }
}

/** 全文结束：给所有 <h2>（含最后一个）补齐 5W1H 按钮。 */
export function finalizeChapterButtons(
  root: HTMLElement,
  onClick: (chapterId: number, h2: HTMLElement) => void,
): void {
  const h2s = Array.from(root.querySelectorAll("h2"));
  h2s.forEach((h2, i) => attachButton(h2 as HTMLElement, i, onClick));
}

/**
 * 把（可能半成品的）markdown 按 `## ` 切成块。
 * 返回 { head, chapters }：head 是第一个 `##` 之前的内容（# 大标题等）；
 * chapters[i] 是第 i 个 `## ` 章节的完整 markdown（含其标题行）。
 * 口径与后端 splitByH2 一致：行首 `## ` 且非 `###` 才算章节边界。
 */
export function splitMarkdownByChapter(markdown: string): {
  head: string;
  chapters: string[];
} {
  const lines = markdown.split("\n");
  const headLines: string[] = [];
  const chapters: string[][] = [];
  let cur: string[] | null = null;
  for (const line of lines) {
    const t = line.trimStart();
    if (/^##\s/.test(t) && !/^###\s/.test(t)) {
      cur = [line];
      chapters.push(cur);
    } else if (cur) {
      cur.push(line);
    } else {
      headLines.push(line);
    }
  }
  return {
    head: headLines.join("\n"),
    chapters: chapters.map((c) => c.join("\n")),
  };
}

/** 5W1H 键值表格卡片。 */
export function renderFiveW1HCard(data: FiveW1H): string {
  const rows: [string, string][] = [
    ["Who", data.who],
    ["What", data.what],
    ["When", data.when],
    ["Where", data.where],
    ["Why", data.why],
    ["How", data.how],
  ];
  const body = rows
    .map(
      ([k, v]) =>
        `<tr><th>${k}</th><td>${escapeHtml(v ?? "")}</td></tr>`,
    )
    .join("");
  return `<table><tbody>${body}</tbody></table>`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
