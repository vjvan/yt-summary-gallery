import type { TranslatedCue, WatchCue } from '../watch/types';

export type LiveGapReason = 'silence' | 'overload' | 'capture-gap' | 'missing-chunks' | 'processing-failed';
export interface LiveGap { start: number; end: number; reason: LiveGapReason; missingSequences?: number }
export type LiveTone = 'natural' | 'polite' | 'concise';
export type LiveStopReason = 'user' | 'source-closed' | 'queue-overflow' | 'permission-revoked' | 'capture-error' | 'server-unavailable' | 'mode-changed';
export interface LiveSessionMetadata {
  sessionId: string; url: string; title: string; source: 'discord'; processingMode: 'local'; unlimited: true;
  state: 'active' | 'stopped'; status: 'active' | 'stopped' | 'error';
  createdAt: number; updatedAt: number; nextSequence: number; processing: boolean;
  audioProcessing: boolean; replyProcessing: boolean; translationModel: string;
  stopReason?: string; unprocessedSeconds?: number;
  limits: { maxChunkSeconds: 15; maxStoredChunks: 100; maxStoredCues: 500 };
}
export interface LiveChunkView {
  sequence: number; start: number; end: number; status: 'processing' | 'done' | 'silent' | 'error';
  error?: string; gapBefore?: LiveGap; processingMs?: number;
}
export interface LiveReplyDraft {
  sessionId: string; draftId: string; sourceText: string; english: string; tone: LiveTone; createdAt: number;
}
export interface LiveSessionDetail extends LiveSessionMetadata {
  cues: TranslatedCue[]; chunks: LiveChunkView[]; gaps: LiveGap[]; drafts: LiveReplyDraft[];
}
export interface LiveChunkInput {
  sessionId: string; sequence: number; start: number; end: number; bytes: Uint8Array;
  gapReason?: 'silence' | 'overload' | 'capture-gap';
}
export interface LiveChunkResult {
  sessionId: string; sequence: number; start: number; end: number;
  cues: TranslatedCue[]; originalCues: WatchCue[]; cached: boolean; gapBefore?: LiveGap;
}
export interface LiveReplyInput { sessionId: string; text: string; tone?: LiveTone }
export interface LiveStopInput { reason?: LiveStopReason; unprocessedSeconds?: number }
