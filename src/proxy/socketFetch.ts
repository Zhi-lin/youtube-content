import { connect } from "cloudflare:sockets";

export interface ProxyConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
}

export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** 解析 `host:port:user:pass` 形式的 WEBSHARE_PROXY 变量。 */
export function parseProxy(raw: string | undefined): ProxyConfig | null {
  if (!raw) return null;
  const parts = raw.split(":");
  if (parts.length < 4) return null;
  const [host, port, user, ...rest] = parts;
  return { host, port: Number(port), user, pass: rest.join(":") };
}

export interface ProxyRequestInit {
  /** 默认 GET。 */
  method?: string;
  headers?: Record<string, string>;
  /** 请求体（POST 用）。会自动补 Content-Length。 */
  body?: string;
}

/**
 * 经 Webshare HTTP 代理发起一个 HTTPS 请求，绕过 Worker fetch 不能配代理的限制。
 *
 * 流程：明文 socket 连代理 → CONNECT 隧道 → startTls 升级 → 隧道内手写 HTTPS 请求。
 * 支持 GET 与 POST（带 body）。读到 `Connection: close` 为止。
 */
export async function fetchViaProxy(
  targetUrl: string,
  proxy: ProxyConfig,
  init: ProxyRequestInit = {},
): Promise<ProxyResponse> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = init.headers ?? {};
  const body = init.body;
  const u = new URL(targetUrl);
  const targetHost = u.hostname;
  const targetPort = u.port ? Number(u.port) : 443;
  const path = u.pathname + u.search;

  // 1. 明文 socket 到代理，starttls 模式以便后续升级。
  const socket = connect(
    { hostname: proxy.host, port: proxy.port },
    { secureTransport: "starttls", allowHalfOpen: false },
  );

  let writer = socket.writable.getWriter();
  let reader = socket.readable.getReader();
  const enc = new TextEncoder();

  try {
    // 2. CONNECT 握手（明文发给代理）。
    const auth = btoa(`${proxy.user}:${proxy.pass}`);
    const connectReq =
      `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
      `Host: ${targetHost}:${targetPort}\r\n` +
      `Proxy-Authorization: Basic ${auth}\r\n` +
      `Proxy-Connection: keep-alive\r\n\r\n`;
    await writer.write(enc.encode(connectReq));

    // 3. 读代理应答，直到 header 终止符。期待 200。
    const handshake = await readUntil(reader, "\r\n\r\n");
    if (!/^HTTP\/1\.[01] 200/.test(handshake)) {
      throw new Error(`代理 CONNECT 失败：${handshake.split("\r\n")[0]}`);
    }

    // 4. 隧道已建立，升级为 TLS。startTls 是同步的，返回新 socket。
    //    必须传 expectedServerHostname：workerd 用它做 SNI 与证书校验，
    //    缺省会导致依赖 SNI 的服务器（如 www.youtube.com）握手失败。
    //    注意：Webshare 免费代理是 HTTP/1.0 隧道，其与 workerd startTls 不兼容，
    //    实测此处握手必然失败（见各 IP 一致结果）；付费 HTTP/1.1 住宅代理可用。
    writer.releaseLock();
    reader.releaseLock();
    const tls = socket.startTls({ expectedServerHostname: targetHost });
    writer = tls.writable.getWriter();
    reader = tls.readable.getReader();

    // 5. 隧道内发真正的 HTTPS 请求。
    const bodyBytes = body ? enc.encode(body) : null;
    const hdrLines = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join("");
    const lengthLine = bodyBytes
      ? `Content-Length: ${bodyBytes.length}\r\n`
      : "";
    const req =
      `${method} ${path} HTTP/1.1\r\n` +
      `Host: ${targetHost}\r\n` +
      hdrLines +
      lengthLine +
      `Accept-Encoding: identity\r\n` +
      `Connection: close\r\n\r\n`;
    await writer.write(enc.encode(req));
    if (bodyBytes) await writer.write(bodyBytes);

    // 6. 读完整响应（Connection: close → 读到流结束）。
    const raw = await readAll(reader);
    return parseHttpResponse(raw);
  } finally {
    try {
      writer.releaseLock();
    } catch {
      /* noop */
    }
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
    await socket.close().catch(() => {});
  }
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  terminator: string,
): Promise<string> {
  const dec = new TextDecoder();
  let acc = "";
  while (!acc.includes(terminator)) {
    const { value, done } = await reader.read();
    if (done) break;
    acc += dec.decode(value, { stream: true });
  }
  return acc;
}

async function readAll(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** 解析原始 HTTP/1.1 响应，处理 chunked 传输编码。 */
function parseHttpResponse(raw: Uint8Array): ProxyResponse {
  const sep = indexOfCrlfCrlf(raw);
  const headPart = new TextDecoder().decode(raw.slice(0, sep < 0 ? raw.length : sep));
  const bodyBytes = sep < 0 ? new Uint8Array() : raw.slice(sep + 4);

  const lines = headPart.split("\r\n");
  const statusLine = lines[0] ?? "";
  const status = Number(statusLine.split(" ")[1] ?? 0);
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
  }

  let body: string;
  if ((headers["transfer-encoding"] ?? "").toLowerCase().includes("chunked")) {
    body = decodeChunked(bodyBytes);
  } else {
    body = new TextDecoder().decode(bodyBytes);
  }
  return { status, headers, body };
}

function indexOfCrlfCrlf(buf: Uint8Array): number {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) {
      return i;
    }
  }
  return -1;
}

function decodeChunked(buf: Uint8Array): string {
  const dec = new TextDecoder();
  const out: Uint8Array[] = [];
  let i = 0;
  while (i < buf.length) {
    // 读 chunk-size 行（十六进制）。
    let lineEnd = i;
    while (lineEnd + 1 < buf.length && !(buf[lineEnd] === 13 && buf[lineEnd + 1] === 10)) {
      lineEnd++;
    }
    const sizeStr = dec.decode(buf.slice(i, lineEnd)).trim();
    const size = parseInt(sizeStr, 16);
    if (!Number.isFinite(size) || size <= 0) break;
    const start = lineEnd + 2;
    out.push(buf.slice(start, start + size));
    i = start + size + 2; // 跳过 chunk 后的 CRLF
  }
  let total = 0;
  for (const c of out) total += c.length;
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of out) {
    merged.set(c, off);
    off += c.length;
  }
  return dec.decode(merged);
}
