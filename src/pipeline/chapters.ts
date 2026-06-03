import type { Chapter } from "../types";
import type { ChapterStrategy } from "../gemini/prompts";

export interface ParseResult {
  /** 文章标题（# 一级标题，可空）。 */
  title: string;
  /** 大章节数组（## 级别），body 含其下小节。 */
  chapters: Chapter[];
  /** 切分健康度信号，用于埋点。 */
  health: {
    /** 命中的防线层级：1=策略命中, 2=Markdown 退化, 3=###升级, 4=单章兜底 */
    fallbackLevel: 1 | 2 | 3 | 4;
    chapterCount: number;
    /** 章节数是否落在期望区间 [4,8] 外 */
    countOutOfRange: boolean;
    emptyTitle: number;
    emptyBody: number;
  };
}

const H1_MD = /^#\s+(.+)$/;
const H2_MD = /^##\s+(.+)$/;
const H3_MD = /^###\s+(.+)$/;
const H2_SENT = /^\[\[H2\]\]\s*(.+)$/;
const H3_SENT = /^\[\[H3\]\]\s*(.+)$/;

/**
 * 解析文章为「大章节数组」。永不抛错，最坏退化为单章。
 *
 * sentinel 策略下，先把哨兵行规整为标准 Markdown 标题，再统一按 Markdown 解析，
 * 这样下游（含前端 marked 渲染）只需处理一种结构。
 */
export function parseChapters(
  article: string,
  strategy: ChapterStrategy,
): ParseResult {
  const normalized =
    strategy === "sentinel" ? sentinelToMarkdown(article) : article;

  // 防线 1/2：按 ## 切（策略命中；非约定标记则退化为通用 Markdown 标题解析）。
  const { title, chapters } = splitByH2(normalized);
  if (chapters.length > 0) {
    return finalize(title, chapters, 1);
  }

  // 防线 3：无 ## 但有 ###，把 ### 升级为大章节。
  const promoted = splitByH3AsChapters(normalized);
  if (promoted.length > 0) {
    return finalize(title, promoted, 3);
  }

  // 防线 4：连标题都没有，整篇作单章。
  const body = stripTitleLine(normalized).trim();
  return finalize(title, [{ id: 0, title: title || "全文", body }], 4);
}

/** 把 [[H2]]/[[H3]] 哨兵行转成 ## / ### 标准标题。 */
function sentinelToMarkdown(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const t = line.trimStart();
      const h2 = t.match(H2_SENT);
      if (h2) return `## ${h2[1].trim()}`;
      const h3 = t.match(H3_SENT);
      if (h3) return `### ${h3[1].trim()}`;
      return line;
    })
    .join("\n");
}

/** 按 ## 切大章节；body 包含其下所有 ### 小节正文。 */
function splitByH2(text: string): { title: string; chapters: Chapter[] } {
  const lines = text.split("\n");
  let title = "";
  const chapters: Chapter[] = [];
  let cur: { title: string; bodyLines: string[] } | null = null;

  for (const line of lines) {
    const t = line.trimStart();
    const h1 = t.match(H1_MD);
    if (h1 && !t.startsWith("##")) {
      if (!title) title = h1[1].trim();
      continue;
    }
    const h2 = t.match(H2_MD);
    if (h2 && !t.startsWith("###")) {
      if (cur) chapters.push(toChapter(chapters.length, cur));
      cur = { title: h2[1].trim(), bodyLines: [] };
      continue;
    }
    if (cur) cur.bodyLines.push(line);
  }
  if (cur) chapters.push(toChapter(chapters.length, cur));
  return { title, chapters };
}

/** 无 ## 时，把每个 ### 当作一个大章节。 */
function splitByH3AsChapters(text: string): Chapter[] {
  const lines = text.split("\n");
  const chapters: Chapter[] = [];
  let cur: { title: string; bodyLines: string[] } | null = null;
  for (const line of lines) {
    const t = line.trimStart();
    const h3 = t.match(H3_MD);
    if (h3) {
      if (cur) chapters.push(toChapter(chapters.length, cur));
      cur = { title: h3[1].trim(), bodyLines: [] };
      continue;
    }
    if (cur) cur.bodyLines.push(line);
  }
  if (cur) chapters.push(toChapter(chapters.length, cur));
  return chapters;
}

function toChapter(
  id: number,
  cur: { title: string; bodyLines: string[] },
): Chapter {
  return { id, title: cur.title, body: cur.bodyLines.join("\n").trim() };
}

function stripTitleLine(text: string): string {
  return text
    .split("\n")
    .filter((l) => !H1_MD.test(l.trimStart()))
    .join("\n");
}

function finalize(
  title: string,
  raw: Chapter[],
  level: 1 | 2 | 3 | 4,
): ParseResult {
  // 过滤完全空的章节（无标题且无正文），并重排 id。
  const chapters = raw
    .filter((c) => c.title || c.body)
    .map((c, i) => ({ ...c, id: i }));

  const emptyTitle = chapters.filter((c) => !c.title).length;
  const emptyBody = chapters.filter((c) => !c.body).length;

  return {
    title,
    chapters,
    health: {
      fallbackLevel: level,
      chapterCount: chapters.length,
      countOutOfRange: chapters.length < 4 || chapters.length > 8,
      emptyTitle,
      emptyBody,
    },
  };
}
