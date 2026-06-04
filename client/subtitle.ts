/**
 * 本地字幕解析：把 .srt / .vtt / .txt 文件内容解析成纯文本（逐行对白）。
 *
 * 目标是「去掉时间轴/序号/格式标记，只留对白文本」，喂给生成管线。
 * 解析尽量宽松：无法识别格式时退回按行清洗的纯文本。
 */

/** 解析字幕文件文本为纯对白文本（多行，行间用 \n）。 */
export function parseSubtitle(raw: string, filename = ""): string {
  const text = stripBom(raw).replace(/\r\n?/g, "\n");
  const lower = filename.toLowerCase();

  if (lower.endsWith(".vtt") || /^WEBVTT/.test(text.trimStart())) {
    return parseCueBased(text, /* isVtt */ true);
  }
  if (lower.endsWith(".srt") || hasSrtTimecodes(text)) {
    return parseCueBased(text, /* isVtt */ false);
  }
  // 纯文本：逐行清洗。
  return cleanLines(text.split("\n")).join("\n");
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** 是否含 SRT 风格时间码（00:00:00,000 --> 00:00:01,000）。 */
function hasSrtTimecodes(text: string): boolean {
  return /\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(text);
}

/** 时间码行：00:00:00,000 --> 00:00:01,000（SRT 用逗号、VTT 用点，且 VTT 可省时）。 */
const TIMECODE_RE = /-->/;
/** 纯数字序号行（SRT 的 cue 编号）。 */
const INDEX_RE = /^\d+$/;
/** VTT 行内/块内的标签：<00:00:00.000>、<c>…</c>、NOTE/STYLE/REGION 块头等。 */
const VTT_TAG_RE = /<[^>]*>/g;

/**
 * 解析基于 cue 块（SRT/VTT）：丢弃序号行、时间码行、VTT 元数据块，
 * 收集每个 cue 的文本行，去重相邻重复（VTT 滚动字幕常见），拼成纯文本。
 */
function parseCueBased(text: string, isVtt: boolean): string {
  const out: string[] = [];
  let prev = "";
  for (const rawLine of text.split("\n")) {
    let line = rawLine.trim();
    if (!line) continue;
    if (TIMECODE_RE.test(line)) continue;
    if (INDEX_RE.test(line)) continue;
    if (isVtt) {
      if (/^WEBVTT/.test(line)) continue;
      if (/^(NOTE|STYLE|REGION)\b/.test(line)) continue;
      if (line.includes(":") && /^[A-Za-z-]+:\s/.test(line)) continue; // cue settings 行
      line = line.replace(VTT_TAG_RE, "").trim();
      if (!line) continue;
    }
    // 去掉相邻完全重复的行（VTT 逐字滚动会重复整句）。
    if (line === prev) continue;
    prev = line;
    out.push(line);
  }
  return out.join("\n");
}

/** 纯文本兜底：去空行、trim。 */
function cleanLines(lines: string[]): string[] {
  return lines.map((l) => l.trim()).filter(Boolean);
}
