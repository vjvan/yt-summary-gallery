import type { Summary } from "./extract-summary";

/**
 * 從 summary 生成社群貼文文案(IG/Threads 直接貼上)。
 * carousel zip 的 caption.txt 跟 HTML 編輯器的「複製文案」共用。
 */
export function buildCaption(summary: Summary, fallbackTitle: string): string {
  const lines: string[] = [];
  lines.push(summary.title_display || fallbackTitle);
  if (summary.one_liner) lines.push("", summary.one_liner);
  if (summary.tldr_paragraph) lines.push("", summary.tldr_paragraph);

  if (summary.key_points.length > 0) {
    lines.push("", "本篇重點:");
    for (const kp of summary.key_points.slice(0, 5)) {
      lines.push(`▸ ${kp.label}|${kp.content}`);
    }
  }

  if (summary.tags.length > 0) {
    lines.push(
      "",
      summary.tags
        .slice(0, 8)
        .map((t) => `#${t.replace(/\s+/g, "")}`)
        .join(" ")
    );
  }

  return lines.join("\n");
}
