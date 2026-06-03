// YouTube InnerTube 公开常量 key（baked-in 到 youtube.com，非密钥，无配额）。
const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const PLAYER_URL = `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}&prettyPrint=false`;

// 用 ANDROID 客户端 context：其 timedtext baseUrl 无需 POT，最适合无 JS 的 Worker。
const ANDROID_CONTEXT = {
  client: {
    clientName: "ANDROID",
    clientVersion: "20.10.38",
    androidSdkVersion: 30,
    hl: "en",
    gl: "US",
    userAgent: "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip",
  },
};
const ANDROID_UA = ANDROID_CONTEXT.client.userAgent;

export interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind?: string; // "asr" = 自动生成
}

export interface PlayerInfo {
  title: string;
  tracks: CaptionTrack[];
}

/** 构造 player 请求的 body 与 headers（供直连 fetch 与代理共用）。 */
export function playerRequest(videoId: string): {
  url: string;
  body: string;
  headers: Record<string, string>;
} {
  return {
    url: PLAYER_URL,
    body: JSON.stringify({ context: ANDROID_CONTEXT, videoId }),
    headers: {
      "Content-Type": "application/json",
      "User-Agent": ANDROID_UA,
      "Accept-Language": "en-US,en",
    },
  };
}

/** 给 timedtext baseUrl 附加 json3 头（供直连 / 代理共用）。 */
export function timedtextHeaders(): Record<string, string> {
  return { "User-Agent": ANDROID_UA, "Accept-Language": "en-US,en" };
}

/** 从 player 响应 JSON 提取标题与字幕轨道列表。 */
export function parsePlayer(rawJson: string): PlayerInfo {
  const data = JSON.parse(rawJson);
  const title: string = data?.videoDetails?.title ?? "未命名视频";
  const tracks: CaptionTrack[] =
    data?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  return {
    title,
    tracks: tracks.map((t: any) => ({
      baseUrl: t.baseUrl,
      languageCode: t.languageCode,
      kind: t.kind,
    })),
  };
}

/** 选轨道：人工字幕优先于自动生成；优先英文，否则取第一条。 */
export function pickTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  if (tracks.length === 0) return null;
  const manual = tracks.filter((t) => t.kind !== "asr");
  const pool = manual.length ? manual : tracks;
  return pool.find((t) => t.languageCode.startsWith("en")) ?? pool[0];
}

/** 给 baseUrl 追加 fmt=json3。 */
export function json3Url(baseUrl: string): string {
  return baseUrl.includes("fmt=") ? baseUrl : `${baseUrl}&fmt=json3`;
}
