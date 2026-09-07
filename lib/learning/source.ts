import { createHash } from 'node:crypto';
import type { SourceClaim } from './types';
export interface LearningSourceInput { transcript: string; segments?: string | null; title?: string | null; transcriptSource?: string | null }
export interface SourceLine { anchorId?: string; id: number; timestamp: number | null; text: string }
export interface LearningSource { hash: string; title: string; transcriptSource: string; lines: SourceLine[]; unparsedLines: number }
export const hashValue = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const learningSourceHash = (input: LearningSourceInput) => hashValue([input.transcript, input.segments || '', input.transcriptSource || '']);
export function prepareLearningSource(input: LearningSourceInput): LearningSource {
  if (typeof input.transcript !== 'string' || !input.transcript.trim()) throw new Error('缺少原始逐字稿，尚未啟動學習分析。');
  if (input.transcript.length > 1_000_000 || (input.segments?.length || 0) > 3_000_000) throw new Error('逐字稿超過本次單片分析上限；請先按章節拆分，不會截斷分析。');
  let segments: unknown;
  try { segments = JSON.parse(input.segments || 'null'); } catch { segments = null; }
  let lines: SourceLine[];
  if (Array.isArray(segments) && segments.length) {
    lines = segments.map((raw, id) => {
      const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      return { id, timestamp: typeof item.start === 'number' && Number.isFinite(item.start) && item.start >= 0 ? item.start : null,
        text: typeof item.text === 'string' ? item.text : '' };
    });
  } else {
    lines = input.transcript.split(/\r?\n/).filter(text => text.trim()).map((text, id) => {
      const match = text.match(/^\[(\d+):(\d{2})(?:\.(\d+))?\]\s(.*)$/);
      return { id, timestamp: match && Number(match[2]) < 60 ? Number(match[1]) * 60 + Number(match[2]) + (match[3] ? Number(`0.${match[3]}`) : 0) : null,
        text: match ? match[4] : text };
    });
  }
  if (!lines.some(line => line.timestamp !== null && line.text.trim())) throw new Error('缺少可核對的原文時間戳；不會推估時間或產生無證據重點。');
  return { hash: learningSourceHash(input), title: input.title || '',
    transcriptSource: input.transcriptSource || '', lines, unparsedLines: lines.filter(line => line.timestamp === null || !line.text.trim()).length };
}
/** Every source line is retained, including untimed lines (which cannot serve as evidence). */
export function chunkLearningSource(source: LearningSource, maxCharacters = 3800): SourceLine[][] {
  const pieces = source.lines.flatMap(line => {
    // Unique, source-owned anchors. The model chooses an anchor; the server copies its exact text/time.
    const evidenceLimit = Math.min(480, maxCharacters);
    if (line.text.length <= evidenceLimit) return [{ ...line, anchorId: `line-${line.id}-0` }];
    const parts: SourceLine[] = [];
    for (let offset = 0; offset < line.text.length; offset += evidenceLimit) parts.push({ ...line, anchorId: `line-${line.id}-${offset}`, text: line.text.slice(offset, offset + evidenceLimit) });
    return parts;
  });
  const chunks: SourceLine[][] = []; let chunk: SourceLine[] = []; let size = 0;
  for (const line of pieces) {
    if (chunk.length && size + line.text.length + 40 > maxCharacters) { chunks.push(chunk); chunk = []; size = 0; }
    chunk.push(line); size += line.text.length + 40;
  }
  if (chunk.length) chunks.push(chunk);
  if (chunks.length > 128) throw new Error('逐字稿超過 128 段的單次安全上限；請按章節拆分，不會略過中間內容。');
  return chunks;
}
/** Literal match only: no normalization, fuzzy matching, inferred times, or translated evidence. */
export function verifySourceClaim(claim: Pick<SourceClaim, 'timestamp' | 'quote'>, lines: SourceLine[]): boolean {
  return Number.isFinite(claim.timestamp) && claim.timestamp >= 0 && typeof claim.quote === 'string'
    && claim.quote.trim().length >= 12 && claim.quote.length <= 500
    && lines.some(line => line.timestamp === claim.timestamp && line.text.includes(claim.quote));
}
export function sourceContext(claims: SourceClaim[], source: LearningSource): SourceLine[] {
  const ids = new Set<number>();
  for (const claim of claims) {
    const index = source.lines.findIndex(line => line.timestamp === claim.timestamp && line.text.includes(claim.quote));
    if (index >= 0) for (let i = Math.max(0, index - 1); i <= Math.min(source.lines.length - 1, index + 1); i++) ids.add(i);
  }
  return [...ids].sort((a, b) => a - b).map(index => source.lines[index]);
}
