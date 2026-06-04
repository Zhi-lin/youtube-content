import type { Env, Session, FiveW1H } from "../types";

const TTL_SECONDS = 60 * 60 * 24; // 24h

const sessionKey = (id: string) => `session:${id}`;
const summaryKey = (id: string, chapterId: number) =>
  `session:${id}:summary:${chapterId}`;
const rawKey = (id: string) => `session:${id}:raw`;

/** 断点续写用：本次生成累积的原始 markdown 全文 + 完成标志 + 轮次。 */
export interface RawArticle {
  article: string;
  done: boolean;
  round: number;
  updatedAt: string;
}

export async function saveSession(env: Env, id: string, s: Session): Promise<void> {
  await env.SESSIONS.put(sessionKey(id), JSON.stringify(s), {
    expirationTtl: TTL_SECONDS,
  });
}

export async function loadSession(env: Env, id: string): Promise<Session | null> {
  const raw = await env.SESSIONS.get(sessionKey(id));
  return raw ? (JSON.parse(raw) as Session) : null;
}

export async function saveSummary(
  env: Env,
  id: string,
  chapterId: number,
  data: FiveW1H,
): Promise<void> {
  await env.SESSIONS.put(summaryKey(id, chapterId), JSON.stringify(data), {
    expirationTtl: TTL_SECONDS,
  });
}

export async function loadSummary(
  env: Env,
  id: string,
  chapterId: number,
): Promise<FiveW1H | null> {
  const raw = await env.SESSIONS.get(summaryKey(id, chapterId));
  return raw ? (JSON.parse(raw) as FiveW1H) : null;
}

export async function saveRaw(
  env: Env,
  id: string,
  article: string,
  done: boolean,
  round: number,
): Promise<void> {
  const v: RawArticle = {
    article,
    done,
    round,
    updatedAt: new Date().toISOString(),
  };
  await env.SESSIONS.put(rawKey(id), JSON.stringify(v), {
    expirationTtl: TTL_SECONDS,
  });
}

export async function loadRaw(env: Env, id: string): Promise<RawArticle | null> {
  const raw = await env.SESSIONS.get(rawKey(id));
  return raw ? (JSON.parse(raw) as RawArticle) : null;
}
