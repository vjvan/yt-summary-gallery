/** Local file/podcast adapter. Separate cache namespace; original segment boundaries are never rebuilt. */
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { TranscriptSegment } from './fetch-transcript';
import { WatchStore } from '../watch/store';
import { watchProviderInfo } from '../watch/provider';
import { translateWatchWindow, TRANSLATION_VERSION } from '../watch/translator';
import { withVideoTermbase } from '../watch/termbase';
import { getGlossary } from '../glossary-store';
import type { TranslatedCue, WatchSource } from '../watch/types';

export async function translateLocalLibrarySegments(segments: TranscriptSegment[]): Promise<TranscriptSegment[]> {
  const provider = watchProviderInfo();
  if (provider.processingMode !== 'local') throw new Error('本機影片翻譯不會自動切換到雲端。');
  if (segments.some(cue => !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start || !cue.text.trim() || cue.text.length > 4000)) throw new Error('字幕片段時間或長度無效，未開始翻譯。');
  const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const sourceHash = digest(segments);
  const source: WatchSource = { videoId: `local-file-${sourceHash}`, trackId: sourceHash, language: 'en', sourceKind: 'manual', title: '本機音訊/影片原文逐字稿',
    cues: segments.map((cue, i) => ({ ...cue, id: `${i}-${digest(cue).slice(0, 16)}` })) };
  const glossary = withVideoTermbase(getGlossary());
  const prefix = digest({ namespace: 'library-file-v1', source, glossary, model: provider.translationModel, version: TRANSLATION_VERSION });
  const store = new WatchStore(path.join(process.cwd(), 'data', 'library-translation.db'));
  try {
    const saved = new Map<string, TranslatedCue>();
    for (const cue of source.cues) { const value = store.getCue(`${prefix}:${cue.id}`, cue); if (value) saved.set(cue.id, value); }
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < source.cues.length; i++) {
      const cue = source.cues[i]; if (saved.has(cue.id)) continue;
      try {
        const result = await translateWatchWindow({ source, glossary, provider, targets: [cue], before: source.cues.slice(Math.max(0, i - 2), i), after: source.cues.slice(i + 1, i + 3) });
        if (result.length !== 1) throw new Error('本機字幕回傳數量不符。');
        store.putCue(`${prefix}:${cue.id}`, cue, result[0]); saved.set(cue.id, result[0]);
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'LOCAL_TRANSLATION_QUALITY') throw error;
      }
    }
    if (saved.size !== source.cues.length) throw new Error(`本機字幕已完成 ${saved.size}/${source.cues.length} 段，部分譯文未通過品質檢查；成功段落已保存，重試不重算。未將原文冒充中文。`);
    return source.cues.map(cue => ({ start: cue.start, end: cue.end, text: saved.get(cue.id)!.text }));
  } finally { store.close(); }
}
