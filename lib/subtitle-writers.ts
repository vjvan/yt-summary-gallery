/**
 * 同一 process 內「正在整份重寫 segments_zh」的工作登記簿。
 * 重新翻譯、字幕續作這類工作會整份覆蓋中譯；語意校訂在套用／還原前查這裡，
 * 有人登記中就拒絕（409），避免人工修改被背景工作蓋掉。
 * 只涵蓋同一個 Node process；跨 process 的互斥列在 docs/subtitle-review.md 的 backlog。
 */
const runtime = globalThis as typeof globalThis & { __subtitleWriters?: Map<string, number> };
const writers = () => runtime.__subtitleWriters ??= new Map<string, number>();

export function beginSubtitleWrite(summaryId: string): () => void {
  const map = writers();
  map.set(summaryId, (map.get(summaryId) ?? 0) + 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const remaining = (map.get(summaryId) ?? 1) - 1;
    if (remaining <= 0) map.delete(summaryId); else map.set(summaryId, remaining);
  };
}

export function subtitleWriteActive(summaryId: string): boolean {
  return (writers().get(summaryId) ?? 0) > 0;
}
