import type { TranscriptResult } from "../types";
import { fetchViaProxy, parseProxy, type ProxyConfig } from "../proxy/socketFetch";
import {
  playerRequest,
  parsePlayer,
  pickTrack,
  json3Url,
  timedtextHeaders,
} from "./innertube";
import { parseJson3 } from "./timedtext";
import { getFixture } from "./fixtures";

/** 从各种 YouTube URL 形态提取 videoId。 */
export function extractVideoId(input: string): string | null {
  const s = input.trim();
  // 纯 11 位 id
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname === "youtu.be") return u.pathname.slice(1, 12) || null;
    const v = u.searchParams.get("v");
    if (v) return v;
    const m = u.pathname.match(/\/(embed|shorts|v)\/([\w-]{11})/);
    if (m) return m[2];
  } catch {
    /* not a URL */
  }
  return null;
}

/**
 * 分层降级取字幕：
 *  1. 直连 youtubei（Worker fetch）
 *  2. 经 Webshare 代理重试（TCP Socket）
 *  3. 演示视频回落硬编码字幕
 *  4. 否则抛友好错误
 */
export async function fetchTranscript(
  videoId: string,
  proxyRaw: string | undefined,
): Promise<TranscriptResult> {
  const proxy = parseProxy(proxyRaw);
  const diag: string[] = []; // 累积各阶段失败原因，附到最终错误便于排查

  // 1. 直连
  try {
    const r = await viaDirect(videoId);
    if (r) return { ...r, videoId, source: "direct" };
    diag.push("direct: 无字幕轨道");
  } catch (e) {
    diag.push(`direct: ${String(e)}`);
    console.log(JSON.stringify({ stage: "transcript.direct", error: String(e) }));
  }

  // 2. 代理
  if (proxy) {
    try {
      const r = await viaProxy(videoId, proxy);
      if (r) return { ...r, videoId, source: "proxy" };
      diag.push("proxy: 无字幕轨道");
    } catch (e) {
      diag.push(`proxy: ${String(e)}`);
      console.log(JSON.stringify({ stage: "transcript.proxy", error: String(e) }));
    }
  } else {
    diag.push("proxy: 未配置 WEBSHARE_PROXY");
  }

  // 3. 硬编码兜底
  const fx = getFixture(videoId);
  if (fx) {
    console.log(JSON.stringify({ stage: "transcript.fixture", videoId }));
    return { videoId, title: fx.title, text: fx.text, source: "fixture" };
  }

  // 4. 失败 —— 带上各阶段诊断
  throw new Error(
    `无法获取该视频字幕（可能无字幕或被风控）。诊断：${diag.join(" | ")}`,
  );
}

async function viaDirect(videoId: string) {
  const { url, body, headers } = playerRequest(videoId);
  const res = await fetch(url, { method: "POST", body, headers });
  if (!res.ok) throw new Error(`player ${res.status}`);
  const info = parsePlayer(await res.text());
  const track = pickTrack(info.tracks);
  if (!track) return null;

  const ttRes = await fetch(json3Url(track.baseUrl), { headers: timedtextHeaders() });
  const raw = await ttRes.text();
  const text = parseJson3(raw);
  if (!text) return null;
  return { title: info.title, text };
}

async function viaProxy(videoId: string, proxy: ProxyConfig) {
  // 整链路走代理：player（POST）与 timedtext（GET）都经代理隧道，
  // 因为 Cloudflare 出口 IP 常被 YouTube 风控，player 直连已失败。
  const { url, body, headers } = playerRequest(videoId);
  const pr = await fetchViaProxy(url, proxy, { method: "POST", body, headers });
  if (pr.status !== 200) throw new Error(`proxy player ${pr.status}`);
  const info = parsePlayer(pr.body);
  const track = pickTrack(info.tracks);
  if (!track) return null;

  const r = await fetchViaProxy(json3Url(track.baseUrl), proxy, {
    headers: timedtextHeaders(),
  });
  if (r.status !== 200 || !r.body) throw new Error(`proxy timedtext ${r.status}`);
  const text = parseJson3(r.body);
  if (!text) return null;
  return { title: info.title, text };
}
