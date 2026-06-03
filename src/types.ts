// 共享类型定义。

/** Worker 环境绑定（与 wrangler.toml 一致）。 */
export interface Env {
  ASSETS: Fetcher;
  SESSIONS: KVNamespace;
  /** "markdown" | "sentinel" */
  CHAPTER_STRATEGY: string;
  GEMINI_MODEL: string;
  GEMINI_API_KEY: string;
  /** 可选：host:port:user:pass */
  WEBSHARE_PROXY?: string;
}

/** 一个大章节（## 级别）。body 含其下所有 ### 小节正文。 */
export interface Chapter {
  id: number;
  title: string;
  body: string;
}

/** 5W1H 结构化结果。 */
export interface FiveW1H {
  who: string;
  what: string;
  when: string;
  where: string;
  why: string;
  how: string;
}

/** KV 中保存的本次生成上下文。 */
export interface Session {
  videoId: string;
  title: string;
  requirement: string;
  transcript: string;
  chapters: Chapter[];
  createdAt: string;
}

/** 各阶段墙钟耗时（毫秒）。注意：非 CPU 时间。 */
export interface Timing {
  transcriptMs: number;
  ttfbMs: number;
  articleMs: number;
  parseMs: number;
  totalMs: number;
}

/** 字幕获取结果。 */
export interface TranscriptResult {
  videoId: string;
  title: string;
  text: string;
  /** 命中的来源，用于埋点与降级可观测。 */
  source: "direct" | "proxy" | "fixture";
}
