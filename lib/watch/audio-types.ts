import type { TranslatedCue, WatchCue } from './types';
export interface AudioSessionView {
  audioSessionId: string; videoId: string; sourceLanguage: 'en';
  processingMode: 'local' | 'cloud'; unlimited: boolean;
  limits: { sessionChunks: number | null; dailyChunks: number | null; maxChunkSeconds: 15 };
}
export interface AudioChunkInput {
  audioSessionId: string; chunkId: string; start: number; end: number;
  confirmAudio: boolean; bytes: Uint8Array; mime: 'audio/webm' | 'audio/wav';
}
export interface AudioChunkResult {
  audioSessionId: string; chunkId: string; cues: TranslatedCue[]; originalCues: WatchCue[];
  usage: { sessionChunks: number; dailyChunks: number }; cached: boolean;
}
