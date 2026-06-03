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

/** 给文章里的大章节 <h2> 注入 [5W1H] 按钮（按 chapters 顺序）。 */
export function injectChapterButtons(
  root: HTMLElement,
  chapters: { id: number; title: string }[],
  onClick: (chapterId: number, h2: HTMLElement) => void,
): void {
  const h2s = Array.from(root.querySelectorAll("h2"));
  chapters.forEach((ch, idx) => {
    const h2 = h2s[idx];
    if (!h2 || h2.querySelector(".w5h1-btn")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "w5h1-btn";
    btn.textContent = "5W1H";
    btn.dataset.chapterId = String(ch.id);
    btn.addEventListener("click", () => onClick(ch.id, h2));
    h2.appendChild(btn);
  });
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
