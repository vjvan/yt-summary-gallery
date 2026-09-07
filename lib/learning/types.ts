/** Private, additive learning analysis. Never embed this object in public summary JSON. */
export const LEARNING_VERSION = 'learning-v1.1-source-anchors';
export type LearningDisposition = 'now' | 'later' | 'understand' | 'skip';
export type LearningStatus = 'idle' | 'running' | 'complete' | 'partial' | 'failed' | 'cancelled';
export type AssessmentAnswer = 'yes' | 'no' | 'uncertain';
export interface LearningAssessment { answer: AssessmentAnswer; reason: string }
export interface SourceClaim {
  timestamp: number;
  /** Exact source substring, validated against the source-owned timestamp. */
  quote: string;
  /** Model interpretation of the excerpt, NOT a verbatim source quote. */
  explanation: string;
}
export interface LearningImplementation {
  id: string;
  action: string;
  result: string;
  observedAt: string;
  createdAt: string;
}
export interface LearningPoint {
  id: string;
  /** Model's concise rendering of the source idea; sourceClaims hold actual evidence. */
  core: string;
  sourceClaims: SourceClaim[];
  /** Model analysis, not source statements. */
  sourceFaithfulness: { supported: boolean; reason: string };
  whyImportant: string;
  conditions: string[];
  /** Suggestions for the authorized goals only, not promises of results. */
  application: {
    decision: string; operation: string; understanding: string;
    action: string; observableEvidence: string;
  };
  assessment: {
    credible: LearningAssessment; relevant: LearningAssessment; changes: LearningAssessment;
    feasible: LearningAssessment; verifiable: LearningAssessment;
  };
  disposition: LearningDisposition;
  reason: string;
  implementationRecords: LearningImplementation[];
}
export interface LearningProfileSnapshot {
  version: string;
  source: 'user-authorized-this-conversation';
  goals: string[];
}
export interface LearningCoverage {
  totalChunks: number;
  processedChunks: number;
  failedChunks: number[];
  totalSourceLines: number;
  processedSourceLines: number;
  unparsedLines: number;
  invalidEvidenceCount: number;
  candidateCount: number;
  analyzedCandidates: number;
  unsupportedInterpretations: number;
  /** Explicitly says reading all chunks does not establish complete understanding/truth. */
  limitations: string[];
}
export interface LearningPublicCard {
  id: string;
  kind: 'source-paraphrase-draft';
  reviewStatus: 'needs-semantic-review';
  title: string;
  body: string;
  sourceHash: string;
  sourceClaims: { timestamp: number; quote: string }[];
}
export interface LearningPublicDraft {
  targetCount: 20;
  status: 'draft' | 'insufficient-evidence';
  cards: LearningPublicCard[];
  reason: string;
}
/** Explicit assistant-edited demonstration, not raw model output or independent human verification.
 * Never accepted from model output or public API mutations. */
export interface LearningEditorialReview {
  kind: 'assistant-source-review';
  reviewedAt: string;
  originalPointCount: number;
  retainedPointCount: number;
  scope: 'transcript-only';
  notes: string[];
}
export interface LearningAnalysis {
  version: string;
  sourceHash: string;
  model: string;
  createdAt: string;
  coverage: LearningCoverage;
  profileSnapshot: LearningProfileSnapshot;
  points: LearningPoint[];
  publicCards: LearningPublicDraft;
  editorialReview?: LearningEditorialReview;
}
export interface LearningProgress {
  stage: 'idle' | 'extracting' | 'selecting' | 'analyzing' | 'complete';
  completed: number;
  total: number;
  message: string;
}
export interface LearningResponse {
  status: LearningStatus;
  progress: LearningProgress;
  /** Last saved analysis remains visible when a retry fails or is cancelled. */
  analysis: LearningAnalysis | null;
  error: string | null;
}
export interface LearningGeneratePayload { action: 'generate'; consent: true }
export interface LearningCancelPayload { action: 'cancel' }
export interface LearningPatchPayload {
  /** Optimistic source guard: reject edits to a replaced analysis. */
  sourceHash: string;
  pointId: string;
  disposition?: LearningDisposition;
  reason?: string;
  implementation?: { action: string; result: string; observedAt: string };
}
