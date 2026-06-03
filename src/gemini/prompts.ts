import type { Chapter } from "../types";

export type ChapterStrategy = "markdown" | "sentinel";

/** 文章生成的 system instruction：固定体裁与排版契约。 */
export function articleSystemInstruction(strategy: ChapterStrategy): string {
  const headingRule =
    strategy === "sentinel"
      ? [
          "章节结构（务必严格遵守）：",
          "- 每个【大章节】单独起一行，以 `[[H2]] 标题` 开头。",
          "- 每个【小节】单独起一行，以 `[[H3]] 标题` 开头。",
          "- 正文中不得出现 `[[H2]]` 或 `[[H3]]` 字样。",
        ].join("\n")
      : [
          "章节结构（务必严格遵守）：",
          "- 每个【大章节】用二级标题：`## 标题`。",
          "- 每个【小节】用三级标题：`### 标题`。",
          "- 正文段落不要使用 `#` 标题语法。",
        ].join("\n");

  return [
    "你是一名资深中文内容编辑，擅长把视频字幕整理成结构清晰、可读性强的「对话体」文章。",
    "",
    "输出要求：",
    "- 用简体中文。",
    "- 体裁为【对话体】：用 `说话人: 内容` 的形式逐轮呈现，例如 `主持人: ……` / `嘉宾: ……`。",
    "  若字幕能辨别说话人则沿用其称呼；若无法辨别，则用「主持人 / 嘉宾」等通用角色，或退化为问答（Q/A）/ 叙述体，但仍保持清晰的对话感。",
    "- 全文开头用一级标题 `# 文章标题` 给出一个凝练、有吸引力的标题。",
    headingRule,
    "- 大章节数量控制在 4~8 个；每个大章节用「概念性命名」（如「智能经济：收入爆发与成本塌陷」），不要写成流水账标题。",
    "- 忠实于字幕内容，可润色与归纳，但不得虚构事实。",
    "- 直接输出文章本身，不要任何前言、解释或代码块包裹。",
  ].join("\n");
}

/** 文章生成的 user prompt：拼入字幕与可选的用户生成要求。 */
export function articleUserPrompt(transcript: string, requirement: string): string {
  const reqBlock = requirement.trim()
    ? [
        "",
        "【用户的生成要求（软约束）】",
        requirement.trim(),
        "",
        "请在不超出上述要求范围的前提下尽量体现这些约束（任务类型 / 输出风格 / 目标受众 / 约束条件）；",
        "不必逐条强行覆盖，但不要引入要求之外的额外风格。",
      ].join("\n")
    : "";

  return [
    "下面是一段 YouTube 视频字幕。请基于它生成一篇对话体中文文章。",
    reqBlock,
    "",
    "【视频字幕】",
    transcript,
  ].join("\n");
}

/** 5W1H 的 system instruction。 */
export function fiveW1HSystemInstruction(): string {
  return [
    "你是一名分析师。请针对【指定章节】产出 5W1H 结构化总结。",
    "要求：",
    "- 结合整篇视频的全局背景与该章节的具体内容来概括。",
    "- 每一项用简体中文，简洁准确，避免空话；若某一维度在内容中确无信息，则填写「未提及」。",
    "- 严格按给定 JSON Schema 输出 who/what/when/where/why/how 六个字段。",
  ].join("\n");
}

/** 5W1H 的 user prompt：喂入整篇字幕（全局上下文）+ 当前大章节正文。 */
export function fiveW1HUserPrompt(
  transcript: string,
  chapter: Chapter,
): string {
  return [
    "【整篇视频字幕（全局背景）】",
    transcript,
    "",
    `【当前章节：${chapter.title}】`,
    chapter.body,
    "",
    "请基于以上内容，输出该章节的 5W1H 总结。",
  ].join("\n");
}
