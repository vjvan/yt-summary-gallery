import type { LocalQualityReason } from './errors';
/** 即時觀看支線的共用資料契約；時間一律為影片秒數。 */
export interface WatchCue { id: string; start: number; end: number; text: string }
export interface TranslatedCue extends WatchCue { originalText: string }
export interface WatchSource {
  videoId: string; title: string; language: string;
  sourceKind: 'manual' | 'automatic'; trackId: string; cues: WatchCue[];
}
export type WatchProcessingMode = 'local' | 'cloud';
export interface WatchProviderInfo {
  processingMode: WatchProcessingMode; unlimited: boolean; translationModel: string;
  translationConfigured: boolean; audioConfigured: boolean;
  /** Runtime availability when checked; configuration alone is not an online guarantee. */
  translationReady?: boolean; translationStatusMessage?: string;
}
export interface WatchLimits { sessionCalls: number | null; dailyCalls: number | null }
export interface WatchSessionView extends WatchSource, WatchProviderInfo {
  sessionId: string; glossaryVersion: string; translationEnabled: boolean;
  limits: WatchLimits;
  /** Local-only validated cue cache snapshot; reading this never starts inference. */
  cachedCues?: TranslatedCue[];
}
export interface WatchCueFailure {
  id: string; start: number; end: number;
  code: 'LOCAL_TRANSLATION_QUALITY'; message: string;
  /** Fixed safe classification, never raw model text or exception messages. */
  reason?: LocalQualityReason;
}
export interface WatchWindowResult {
  sessionId: string; windowKey: string; cues: TranslatedCue[]; cached: boolean;
  callsUsed: number; dailyCallsUsed: number;
  /** Local-only: partial results are not a successfully completed window. */
  complete?: boolean;
  failedCues?: WatchCueFailure[];
}
