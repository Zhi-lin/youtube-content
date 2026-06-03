import type { FiveW1H } from "../types";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

interface GeminiCallOptions {
  apiKey: string;
  model: string;
  systemInstruction?: string;
  /** 生成温度，默认 0.7。 */
  temperature?: number;
}

/**
 * 流式生成文本。返回一个异步可迭代的文本增量序列。
 * 调用方逐块拼接即可得到全文。
 */
export async function* streamText(
  prompt: string,
  opts: GeminiCallOptions,
): AsyncGenerator<string, void, unknown> {
  const url = `${BASE}/${opts.model}:streamGenerateContent?alt=sse&key=${opts.apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildBody(prompt, opts)),
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gemini 流式请求失败 (${res.status}): ${detail.slice(0, 300)}`);
  }

  // 逐行解析 SSE：每个事件是一行 `data: {json}`。
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      const piece = extractText(payload);
      if (piece) yield piece;
    }
  }
}

/**
 * 非流式生成结构化 JSON（用于 5W1H）。
 * 通过 responseSchema 约束模型输出 6 字段 JSON。
 */
export async function generateFiveW1H(
  prompt: string,
  opts: GeminiCallOptions,
): Promise<FiveW1H> {
  const url = `${BASE}/${opts.model}:generateContent?key=${opts.apiKey}`;
  const body = {
    ...buildBody(prompt, opts),
    generationConfig: {
      temperature: opts.temperature ?? 0.4,
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          who: { type: "STRING" },
          what: { type: "STRING" },
          when: { type: "STRING" },
          where: { type: "STRING" },
          why: { type: "STRING" },
          how: { type: "STRING" },
        },
        required: ["who", "what", "when", "where", "why", "how"],
        propertyOrdering: ["who", "what", "when", "where", "why", "how"],
      },
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gemini 5W1H 请求失败 (${res.status}): ${detail.slice(0, 300)}`);
  }
  const data = (await res.json()) as unknown;
  const text = extractText(JSON.stringify(data)) ?? firstPartText(data);
  if (!text) throw new Error("Gemini 5W1H 返回为空");
  const parsed = JSON.parse(text) as FiveW1H;
  return parsed;
}

function buildBody(prompt: string, opts: GeminiCallOptions) {
  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: opts.temperature ?? 0.7 },
  };
  if (opts.systemInstruction) {
    body.systemInstruction = { parts: [{ text: opts.systemInstruction }] };
  }
  return body;
}

/** 从一个 chunk 的 JSON 字符串里取增量文本。容错：结构缺失返回 ""。 */
function extractText(jsonStr: string): string {
  try {
    const obj = JSON.parse(jsonStr);
    return firstPartText(obj);
  } catch {
    return "";
  }
}

function firstPartText(obj: unknown): string {
  const parts = (obj as any)?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((p: any) => p?.text ?? "").join("");
}
