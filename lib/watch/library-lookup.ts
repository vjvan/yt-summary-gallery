/**
 * 即時字幕的「庫內優先」：影片庫已經有這支影片翻好的字幕（外部翻譯載入、語意校訂套用，或本機首輪），
 * 原站擴充與 /watch 就直接用，不再逐句跑本機模型；命中的句子由 service 回寫 watch 快取，下次連庫都不必查。
 *
 * 配對只認「原文完全相同（空白正規化後）＋ 開始時間相近」；擴充抓到的字幕切段跟庫內不同時，那些句子交回模型，不硬塞。
 * 同一句原文在庫裡出現多次而譯文不同（Right. 可能是「對」也可能是「右邊」）時，只有時間幾乎重合才敢用，否則交回模型。
 * 這裡只讀 summaries，不寫任何東西。
 */
import type Database from 'better-sqlite3';
import { getDb } from '../db';
import type { TranslatedCue, WatchCue } from './types';

export interface LibraryTranslations {
  videoId: string;
  /** 可配對的原文句數（同一句原文多次出現只算一次）。 */
  size: number;
  find(cue: WatchCue): TranslatedCue | null;
}

/** 開始時間差在這以內才算同一句。 */
const MAX_DRIFT_SECONDS = 5;
/** 多個不同譯文候選時，只有最近的一個在這以內、其餘都在 3 秒外，才敢選它。 */
const EXACT_DRIFT_SECONDS = 1;
const AMBIGUOUS_DRIFT_SECONDS = 3;
const CONTROL = /[\p{Cc}\u2028\u2029\u200B-\u200F\u202A-\u202E\u2066-\u2069]+/gu;
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function libraryTranslationsFrom(db: Database.Database, videoId: string): LibraryTranslations | null {
  const row = db.prepare('SELECT segments, segments_zh FROM summaries WHERE video_id = ? AND is_translated = 1 AND segments IS NOT NULL AND segments_zh IS NOT NULL LIMIT 1')
    .get(videoId) as { segments: string; segments_zh: string } | undefined;
  if (!row) return null;
  let segments: unknown;
  let translated: unknown;
  try { segments = JSON.parse(row.segments); translated = JSON.parse(row.segments_zh); } catch { return null; }
  if (!Array.isArray(segments) || !Array.isArray(translated) || !segments.length || segments.length !== translated.length) return null;
  const index = new Map<string, Array<{ start: number; text: string }>>();
  segments.forEach((segment: { start?: unknown; end?: unknown; text?: unknown } | null, position) => {
    const target = translated[position] as { start?: unknown; text?: unknown } | null;
    // 逐項驗結構與時間：原文與譯文各自帶合法時間，而且對得上；壞資料跳過，不補造 0 秒。
    if (!segment || !target || typeof segment.text !== 'string' || typeof target.text !== 'string') return;
    if (!finite(segment.start) || !finite(segment.end) || segment.end <= segment.start || !finite(target.start) || Math.abs(target.start - segment.start) > 0.01) return;
    const source = normalize(segment.text);
    const text = target.text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
    if (!source || !text || text.length > 8000) return;
    const list = index.get(source);
    if (list) list.push({ start: segment.start, text });
    else index.set(source, [{ start: segment.start, text }]);
  });
  if (!index.size) return null;
  return {
    videoId,
    size: index.size,
    find(cue) {
      const candidates = index.get(normalize(cue.text));
      if (!candidates) return null;
      const nearby = candidates.map(candidate => ({ drift: Math.abs(candidate.start - cue.start), text: candidate.text }))
        .filter(candidate => candidate.drift <= MAX_DRIFT_SECONDS).sort((a, b) => a.drift - b.drift);
      if (!nearby.length) return null;
      const best = nearby[0];
      const rivals = nearby.filter(candidate => candidate.text !== best.text);
      // 附近有譯文不同的同句原文：最近的要幾乎重合、其餘要明顯更遠，才不會把「右邊」套到「對」上。
      if (rivals.length && (best.drift > EXACT_DRIFT_SECONDS || rivals.some(candidate => candidate.drift <= AMBIGUOUS_DRIFT_SECONDS))) return null;
      // 鍵順序無所謂，但只能有這五個欄位：store 會用欄位集合驗證來源。
      return { id: cue.id, start: cue.start, end: cue.end, text: best.text, originalText: cue.text };
    },
  };
}

/** 讀不到資料庫或資料壞掉都當成「庫裡沒有」，即時字幕照常走模型。 */
export function libraryTranslations(videoId: string): LibraryTranslations | null {
  try { return libraryTranslationsFrom(getDb(), videoId); } catch { return null; }
}
