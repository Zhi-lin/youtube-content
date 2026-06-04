/**
 * Supadata 字幕 API 客户端。
 *
 * 由第三方服务（自带住宅 IP 池）抓取 YouTube 字幕，绕过 YouTube 对
 * Cloudflare 等数据中心出口 IP 的风控。Worker 直连此 API 即可拿到字幕文本。
 *
 * 接口：GET https://api.supadata.ai/v1/transcript?url=<youtube-url>[&lang=xx]
 *   头：x-api-key: <SUPADATA_API_KEY>
 *   返回：{ lang, content: [{ text, offset, duration, lang }, ...] }
 * 免费档 100 次/月。无字幕视频会自动用 Whisper 转写，返回同样结构。
 *
 * 文档：https://supadata.ai/youtube-transcript-api
 */

const ENDPOINT = "https://api.supadata.ai/v1/transcript";

interface SupadataSegment {
  text: string;
  offset?: number;
  duration?: number;
  lang?: string;
}

interface SupadataResponse {
  lang?: string;
  /** 分段字幕；某些情况下也可能直接返回纯文本（见容错处理）。 */
  content?: SupadataSegment[] | string;
}

export interface SupadataTranscript {
  title: string;
  text: string;
}

/**
 * 调 Supadata 抓 videoId 的字幕，拼成纯文本（去时间戳）。
 * 失败抛错（由调用方降级链捕获）。
 */
export async function fetchViaSupadata(
  videoId: string,
  apiKey: string,
): Promise<SupadataTranscript | null> {
  const url = `${ENDPOINT}?url=${encodeURIComponent(
    `https://www.youtube.com/watch?v=${videoId}`,
  )}`;
  const res = await fetch(url, { headers: { "x-api-key": apiKey } });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`supadata ${res.status}: ${detail.slice(0, 200)}`);
  }

  const data = (await res.json()) as SupadataResponse;
  const text = normalizeContent(data.content);
  if (!text) return null;

  // Supadata 不返回标题；用占位，后续由章节解析的首个 H1 覆盖。
  return { title: "", text };
}

/** 把 content（分段数组或纯文本）规整为换行分隔的纯文本。 */
function normalizeContent(content: SupadataResponse["content"]): string {
  if (!content) return "";
  if (typeof content === "string") return content.trim();
  return content
    .map((seg) => (seg.text ?? "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}
