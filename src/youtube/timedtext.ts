/** json3 字幕格式的事件结构（只取我们需要的字段）。 */
interface Json3Event {
  segs?: { utf8?: string }[];
}
interface Json3 {
  events?: Json3Event[];
}

/**
 * 把 timedtext fmt=json3 的响应解析为纯文本。
 * 规则：跳过无 segs 的事件（样式/时序标记），拼接每个事件的 segs.utf8。
 */
export function parseJson3(raw: string): string {
  let data: Json3;
  try {
    data = JSON.parse(raw) as Json3;
  } catch {
    return "";
  }
  const events = data.events ?? [];
  const lines: string[] = [];
  for (const ev of events) {
    if (!ev.segs) continue;
    const text = ev.segs.map((s) => s.utf8 ?? "").join("").replace(/\s+/g, " ").trim();
    if (text) lines.push(text);
  }
  // 合并为段落，去重连续重复（自动字幕常见的滚动重复）。
  const merged: string[] = [];
  for (const l of lines) {
    if (merged[merged.length - 1] !== l) merged.push(l);
  }
  return merged.join("\n");
}
