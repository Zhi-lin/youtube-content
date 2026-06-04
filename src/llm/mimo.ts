/**
 * 小米 MiMo 模型客户端（OpenAI 兼容）。
 * 作为 Gemini 的降级备用：Gemini 失败时由 article/summarize 流水线回退到此。
 *
 * Endpoint: https://api.xiaomimimo.com/v1/chat/completions
 * 认证: Authorization: Bearer <key>
 *
 * 注意 MiMo 是推理模型：流式 chunk 含 reasoning_content（思考过程）与
 * content（正式回答）两类，二者交替/分段出现。本模块只取 content，丢弃
 * reasoning_content，避免思考文本混入文章。SSE 中还有 `: PROCESSING` 心跳注释行需跳过。
 */

const ENDPOINT = "https://api.xiaomimimo.com/v1/chat/completions";

export interface MimoCallOptions {
  apiKey: string;
  model: string;
  systemInstruction?: string;
  temperature?: number;
}

/** 流式生成文本（只产出正式回答 content 的增量）。 */
export async function* streamTextMimo(
  prompt: string,
  opts: MimoCallOptions,
): AsyncGenerator<string, void, unknown> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildBody(prompt, opts, true)),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`MiMo 流式请求失败 (${res.status}): ${detail.slice(0, 300)}`);
  }

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
      // 跳过空行与 `: PROCESSING` 等 SSE 注释/心跳行。
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      const piece = extractDelta(payload);
      if (piece) yield piece;
    }
  }
}

/** 非流式生成（用于 5W1H 等需要完整文本的场景）。返回正式回答全文。 */
export async function generateTextMimo(
  prompt: string,
  opts: MimoCallOptions,
): Promise<string> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildBody(prompt, opts, false)),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`MiMo 请求失败 (${res.status}): ${detail.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return data.choices?.[0]?.message?.content ?? "";
}

function buildBody(prompt: string, opts: MimoCallOptions, stream: boolean) {
  const messages: { role: string; content: string }[] = [];
  if (opts.systemInstruction) {
    messages.push({ role: "system", content: opts.systemInstruction });
  }
  messages.push({ role: "user", content: prompt });
  return {
    model: opts.model,
    messages,
    temperature: opts.temperature ?? 0.7,
    stream,
  };
}

/** 从一个流式 chunk 取 delta.content（忽略 reasoning_content）。容错返回 ""。 */
function extractDelta(jsonStr: string): string {
  try {
    const obj = JSON.parse(jsonStr) as {
      choices?: { delta?: { content?: string | null } }[];
    };
    return obj.choices?.[0]?.delta?.content ?? "";
  } catch {
    return "";
  }
}
