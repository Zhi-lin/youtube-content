import type { Timing } from "../types";

/**
 * 阶段计时器（墙钟）。
 *
 * 注意：performance.now() 在 Worker 生产环境是墙钟时间且被钳制（只在 I/O 后推进），
 * 这里测的是「各阶段含网络等待的墙钟耗时」，用于定位「慢在哪一步」，
 * 并非真实 CPU 时间——后者请用 `wrangler tail` 的 cpuTime 字段查看。
 */
export class Timer {
  private start = performance.now();
  private marks: Record<string, number> = {};

  mark(name: string): void {
    this.marks[name] = performance.now() - this.start;
  }

  /** 汇总为 Timing；段耗时由相邻 mark 相减得出。 */
  summary(): Timing {
    const at = (k: string) => this.marks[k] ?? 0;
    const total = performance.now() - this.start;
    return {
      transcriptMs: at("transcript"),
      ttfbMs: Math.max(0, at("ttfb") - at("transcript")),
      articleMs: Math.max(0, at("article") - at("ttfb")),
      parseMs: Math.max(0, at("parse") - at("article")),
      totalMs: total,
    };
  }
}

/** 结构化日志一行（便于 wrangler tail 检索）。 */
export function logJson(record: Record<string, unknown>): void {
  console.log(JSON.stringify(record));
}
