/**
 * Convert segments with start/end timestamps to SRT subtitle format.
 */

interface Segment {
  start: number;
  end: number;
  text: string;
}

function formatSrtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return (
    String(h).padStart(2, "0") +
    ":" +
    String(m).padStart(2, "0") +
    ":" +
    String(s).padStart(2, "0") +
    "," +
    String(ms).padStart(3, "0")
  );
}

export function segmentsToSrt(segments: Segment[]): string {
  return segments
    .map((seg, i) => {
      const index = i + 1;
      const start = formatSrtTime(seg.start);
      const end = formatSrtTime(seg.end);
      return `${index}\n${start} --> ${end}\n${seg.text.trim()}\n`;
    })
    .join("\n");
}

/**
 * WebVTT 格式(瀏覽器 <track> 只認這個,不認 SRT)。
 * 與 SRT 差別:檔頭 WEBVTT、時間用 . 而非 ,
 */
export function segmentsToVtt(segments: Segment[]): string {
  const body = segments
    .map((seg) => {
      const start = formatSrtTime(seg.start).replace(",", ".");
      const end = formatSrtTime(seg.end).replace(",", ".");
      return `${start} --> ${end}\n${seg.text.trim()}\n`;
    })
    .join("\n");
  return `WEBVTT\n\n${body}`;
}
