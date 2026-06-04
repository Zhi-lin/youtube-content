# YouTube 字幕 → 对话体文章 + 章节 5W1H

把一个 YouTube 视频（或本地字幕文件）整理成一篇结构清晰的「对话体」中文文章，**边生成边流式渲染**，并为每个大章节按需产出 **5W1H 结构化总结**。

整套服务跑在 **Cloudflare Workers** 上，前端为纯 TS 静态资源，LLM 用 **Gemini**（失败时降级小米 MiMo），会话状态落 **KV**。

---

## 架构一览

```
浏览器 (client/)
  │  POST /api/generate  (SSE)        ── 流式生成文章
  │  GET  /api/summary?...            ── 懒加载章节 5W1H
  ▼
Cloudflare Worker (src/)
  ├─ youtube/transcript  分层降级抓字幕
  ├─ pipeline/article    流式生成 / 断点续写
  ├─ pipeline/summarize  后台预算 5W1H
  ├─ gemini/             Gemini 流式 + 结构化调用、prompt 拼装
  ├─ llm/mimo            降级备用模型 (OpenAI 兼容)
  └─ store/session       Session / raw / summary 落 KV
```

---

## 1. 如何获取和处理 YouTube 字幕

入口 [`fetchTranscript`](src/youtube/transcript.ts)，采用**分层降级**，每层失败都把原因累积到 `diag`，最终错误一并带出便于排查：

1. **直连 youtubei**（Worker `fetch`）—— 调 InnerTube `player` 接口拿字幕轨道，再取 `timedtext` 的 json3 格式解析为纯文本。
2. **Webshare 代理**（TCP Socket 隧道）—— Cloudflare 出口 IP 常被 YouTube 风控，整链路（player POST + timedtext GET）改走代理重试。
3. **Supadata 第三方字幕 API** —— 绕过对数据中心 IP 的风控，作为更稳的兜底。
4. **内置 fixture** —— 演示视频回落硬编码字幕，保证 demo 永远可跑。
5. 全部失败 → 抛带诊断的友好错误。

> 字幕来源记录在 `TranscriptResult.source`（`direct｜proxy｜supadata｜fixture｜local`），用于埋点与降级可观测。

**videoId 提取** [`extractVideoId`](src/youtube/transcript.ts) 兼容 `youtu.be/…`、`watch?v=…`、`/embed|shorts|v/…` 及裸 11 位 id。

**本地字幕模式**：前端解析字幕文件（[`client/subtitle.ts`](client/subtitle.ts)）后把纯文本随请求传入 `localTranscript`，服务端**跳过所有线上抓取**直接进入生成 —— 链接此时可选。

---

## 2. 如何调用 Gemini 并实现流式输出

核心 [`streamText`](src/gemini/client.ts)（`AsyncGenerator<string>`）：

- 请求 Gemini `:streamGenerateContent?alt=sse`，按行解析 SSE（`data: {json}`），从每个 chunk 抽增量文本逐块 `yield`。
- **空闲超时兜底**：Gemini 偶发「内容发完但连接不关、不发结束标记」，会让 `reader.read()` 永久挂起。这里用 `readWithIdleTimeout` 让 read 与 15s 计时器竞争，超时即判定上游结束、主动 `cancel` 收尾，避免后端卡死、前端状态条永远转圈。

上层 [`streamArticle`](src/pipeline/article.ts) 把增量透传给路由，路由再以 SSE `delta` 事件推给浏览器（[`handleGenerate`](src/routes/generate.ts)），实现端到端流式：

```
session → status → delta* → chapters → timing → (done | incomplete)
```

**降级链**：Gemini 在「尚未产出任何内容」前失败（429 配额 / 鉴权 / 连接错误）→ 整段切小米 MiMo 重试；**一旦已产出过内容再失败则直接抛错**（中途切换会导致重复前半段）。

---

## 3. 如何根据用户生成要求影响输出结果

用户在前端填的「生成要求」(`requirement`) 沿这条链影响输出：

1. 随请求进入路由，首段 `trim` 后**存入 Session**；续段从 `loadSession` 复用，保证全程一致（[`src/routes/generate.ts`](src/routes/generate.ts)）。
2. 经 [`requirementBlock`](src/gemini/prompts.ts) 以 **「软约束」** 形式拼进 user prompt：

   > 请在不超出上述要求范围的前提下尽量体现这些约束（任务类型 / 输出风格 / 目标受众 / 约束条件）；不必逐条强行覆盖，但不要引入要求之外的额外风格。

**设计要点 —— system 与 user 的职责隔离**：
- 体裁（对话体 `说话人: 内容`）、标题层级、大章节 4~8 个、忠实字幕不虚构等**产品形态**写死在 [`articleSystemInstruction`](src/gemini/prompts.ts)（system instruction）。
- 用户要求只进 user prompt，**能调"怎么写"（风格/受众），动不了"必须是对话体文章"**。这样既给用户自由度，又守住输出契约不被一句话指令带偏。

---

## 4. 如何实现章节级 5W1H 总结

文章完成后，路由通过 `ctx.waitUntil` 触发 [`precomputeSummaries`](src/pipeline/summarize.ts) **后台串行**预算每个大章节的 5W1H，逐个写回 KV（串行是为了不撞免费档 RPM 限流），不阻塞主响应。

- **结构化输出**：[`generateFiveW1H`](src/gemini/client.ts) 用 Gemini 的 `responseSchema` + `responseMimeType: application/json` 强约束输出 `who/what/when/where/why/how` 六字段，免去脆弱的文本解析。
- **全局上下文**：[`fiveW1HUserPrompt`](src/gemini/prompts.ts) 同时喂入**整篇字幕**（全局背景）与**当前章节正文**，让总结结合上下文而非孤立段落。
- **MiMo 降级**：OpenAI 兼容端不支持 `responseSchema`，故在 prompt 里显式要求纯 JSON，再容错解析（剥 ```json 围栏、截首个 `{...}`）。
- **前端懒加载**：每章渲染完即挂按钮，用户点击才 `GET /api/summary` 取（命中后台已算好的 KV 结果），算与看解耦。

---

## 5. 主要工程取舍与亮点

| 主题 | 取舍 / 亮点 |
| --- | --- |
| **绕过 SSE ~180s 硬上限** | 单段在墙钟预算（`SEGMENT_BUDGET_MS`，默认 150s）内主动收尾、落 KV、发 `incomplete`；前端凭 `sessionId` **自动重连断点续写**直到 `done`，轮数封顶 `MAX_RESUME_ROUNDS` 防死循环。 |
| **续写接缝去重** | 模型续写易重述上文尾部 —— [`dedupeSeam`](src/pipeline/article.ts) 在 200 字符窗口内找「prior 尾部后缀 == 新流前缀」并裁掉，避免重复段落。 |
| **多源降级，全程可观测** | 字幕 4 层降级、LLM 双模型降级，每层失败都结构化 `logJson` 埋点，`source` 字段标命中来源。 |
| **廉价增量章节计数** | 流式中只扫新 piece（+残留半行）数 `## / [[H2]]`，避免每个 delta 全文重解析的 O(n²)；章节数增加才触发快照落 KV。 |
| **空闲超时兜底** | Gemini 流不发结束标记导致挂起的真实坑，用 read-vs-timer 竞争解决。 |
| **算看解耦** | 文章流式即时可读；5W1H 后台预算 + 前端懒加载，互不阻塞。 |
| **章节策略可切** | `CHAPTER_STRATEGY` 支持 `markdown`（`## / ###`）与 `sentinel`（`[[H2]] / [[H3]]` 哨兵，防正文里的 `#` 误判），system instruction 与计数逻辑同步切换。 |

---

## 配置（环境变量）

见 [`.dev.vars.example`](.dev.vars.example) / `wrangler.toml`：

| 变量 | 说明 |
| --- | --- |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | 主模型（必填） |
| `MIMO_API_KEY` / `MIMO_MODEL` | 降级备用模型（可选，OpenAI 兼容） |
| `SUPADATA_API_KEY` | 第三方字幕 API（可选，强烈建议） |
| `WEBSHARE_PROXY` | `host:port:user:pass`（可选） |
| `CHAPTER_STRATEGY` | `markdown`（默认）｜`sentinel` |
| `SEGMENT_BUDGET_MS` | 单段墙钟预算，默认 `150000` |
| `MAX_RESUME_ROUNDS` | 续写轮数上限，默认 `6` |

## 本地开发 & 部署

```bash
npm install
npm run dev        # vite build + wrangler dev
npm run typecheck  # tsc --noEmit
npm run deploy     # vite build + 部署到 Cloudflare Workers
```
