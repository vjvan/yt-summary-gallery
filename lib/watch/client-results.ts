import type { TranslatedCue, WatchCue } from './types';

/** Accept only real, source-aligned translations; neither a partial response nor
 * an advertised count may make a missing cue complete. */
export function verifiedWatchCues(source: WatchCue[], candidates: unknown): TranslatedCue[] {
  if (!Array.isArray(candidates)) return [];
  const byId = new Map(source.map(cue => [cue.id, cue]));
  const accepted = new Map<string, TranslatedCue>();
  for (const item of candidates) {
    if (!item || typeof item !== 'object') continue;
    const cue = byId.get(item.id);
    if (!cue || item.start !== cue.start || item.end !== cue.end || item.originalText !== cue.text
      || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 8000 || /[\r\n]/.test(item.text)) continue;
    accepted.set(cue.id, { id: cue.id, start: cue.start, end: cue.end, originalText: cue.text, text: item.text });
  }
  return source.flatMap(cue => accepted.has(cue.id) ? [accepted.get(cue.id)!] : []);
}
