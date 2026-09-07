/**
 * Convert segments with start/end timestamps to SRT subtitle format.
 * Preserve supplied text/line order verbatim. Bilingual callers supply zh-TW above English;
 * serialization must not reorder languages or modify existing subtitle artifacts.
 */

interface Segment {
  start: number;
  end: number;
  text: string;
}

function formatSrtTime(seconds: number): string {
  // Round total milliseconds first, so 59.9996 becomes 00:01:00,000.
  const total = Math.round(seconds * 1000);
  const h = Math.floor(total / 3600000);
  const m = Math.floor(total / 60000) % 60;
  const s = Math.floor(total / 1000) % 60;
  const ms = total % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

export function assertValidSubtitleSegments(segments: Segment[]): void {
  if (!Array.isArray(segments) || segments.some(seg => !seg || !Number.isFinite(seg.start) || !Number.isFinite(seg.end)
    || seg.start < 0 || seg.end <= seg.start || Math.round(seg.end * 1000) <= Math.round(seg.start * 1000)
    || typeof seg.text !== "string" || !seg.text.trim())) throw new Error("字幕時間或文字無效，已停止匯出。");
}

export function segmentsToSrt(segments: Segment[]): string {
  assertValidSubtitleSegments(segments);
  return segments
    .map((seg, i) => {
      const index = i + 1;
      const start = formatSrtTime(seg.start);
      const end = formatSrtTime(seg.end);
      return `${index}\n${start} --> ${end}\n${seg.text}\n`;
    })
    .join("\n");
}

/**
 * WebVTT 格式(瀏覽器 <track> 只認這個,不認 SRT)。
 * 與 SRT 差別:檔頭 WEBVTT、時間用 . 而非 ,
 */
export function segmentsToVtt(segments: Segment[]): string {
  assertValidSubtitleSegments(segments);
  const body = segments
    .map((seg) => {
      const start = formatSrtTime(seg.start).replace(",", ".");
      const end = formatSrtTime(seg.end).replace(",", ".");
      return `${start} --> ${end}\n${seg.text}\n`;
    })
    .join("\n");
  return `WEBVTT\n\n${body}`;
}
