/**
 * 字幕語意校訂（v1，完整話語視窗）。
 *
 * 目的：既有字幕是逐句、無前後文翻出來的，否定、量級、前後景、跨句指涉容易翻反。
 * 校訂以「一段完整話語」為單位重譯，輸出仍對回原本每一句的 id 與時間，
 * 結果只當候選，人工採用後才寫回字幕；原始譯文永遠留一份可還原。
 */
export const SUBTITLE_REVIEW_VERSION = 'subtitle-review-v1-discourse-window';

export type RiskCode = 'negation' | 'magnitude' | 'quantity' | 'question' | 'foreground' | 'fragment' | 'comparison' | 'idiom' | 'pronoun';
export interface RiskFlag { code: RiskCode; detail: string }

export interface ReviewCue {
  index: number;
  id: string;
  start: number;
  end: number;
  source: string;
  /** 目前字幕的中譯；尚未翻譯的影片為 null。 */
  current: string | null;
}

export interface ReviewWindow {
  key: string;
  cues: ReviewCue[];
  before: ReviewCue[];
  after: ReviewCue[];
  flags: RiskFlag[];
  score: number;
}

export type CandidateDecision = 'candidate' | 'approved' | 'rejected' | 'applied';

export interface ReviewCandidate {
  cueIndex: number;
  cueId: string;
  windowKey: string;
  start: number;
  end: number;
  source: string;
  current: string | null;
  candidate: string;
  flags: RiskFlag[];
  changed: boolean;
  /** 候選的可疑之處（例如數字未逐字保留），人工採用前要看。 */
  notes: string[];
  decision: CandidateDecision;
}

export type ReviewStatus = 'idle' | 'running' | 'complete' | 'partial' | 'failed' | 'cancelled';
export interface ReviewProgress { stage: 'idle' | 'planning' | 'translating' | 'complete'; completed: number; total: number; message: string }

export interface ReviewSummaryCounts {
  windows: number;
  flaggedWindows: number;
  candidates: number;
  changed: number;
  approved: number;
  rejected: number;
  applied: number;
}

export interface ReviewResponse {
  status: ReviewStatus;
  progress: ReviewProgress;
  sourceHash: string | null;
  model: string | null;
  version: string | null;
  counts: ReviewSummaryCounts;
  windows: Array<Pick<ReviewWindow, 'key' | 'flags' | 'score'> & { start: number; end: number; cueIndexes: number[]; flagged: boolean }>;
  candidates: ReviewCandidate[];
  error: string | null;
  lastAppliedAt: string | null;
  /** 資料庫已更新但 SRT／VTT 沒寫成功時的說明；可用 export 動作重試。 */
  exportError: string | null;
  /** 已寫回、但此刻字幕內容已不同（被別的工作覆蓋）的句數；可用 reapply 重新套用。 */
  drifted: number;
}
