import type { LearningPatchPayload, LearningAssessment, LearningPoint, SourceClaim } from './types';
import { normalizeLearningProse } from './language';
import { sourceInterpretationError } from './source-gates';
import { hashValue, verifySourceClaim, type SourceLine } from './source';
export class LearningInputError extends Error { constructor(message: string, public status = 400) { super(message); } }
export const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LearningInputError('資料格式必須是 JSON 物件。');
  return value as Record<string, unknown>;
};
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new LearningInputError('包含不允許修改的欄位。');
}
export function boundedText(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw new LearningInputError('文字欄位缺漏或超過長度上限。');
  return value;
}
const dispositions = ['now', 'later', 'understand', 'skip'] as const;
export function parseLearningPost(value: unknown): { action: 'generate'; consent: true } | { action: 'cancel' } {
  const body = record(value);
  if (body.action === 'cancel') { keys(body, ['action']); return { action: 'cancel' }; }
  keys(body, ['action', 'consent']);
  if (body.action !== 'generate' || body.consent !== true) throw new LearningInputError('請明確同意後，再手動啟動本片本機分析。');
  return { action: 'generate', consent: true };
}
export function parseLearningPatch(value: unknown): LearningPatchPayload {
  const body = record(value); keys(body, ['sourceHash', 'pointId', 'disposition', 'reason', 'implementation']);
  if (typeof body.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.sourceHash)) throw new LearningInputError('來源版本無效。');
  if (typeof body.pointId !== 'string' || !/^point-[a-f0-9]{16}$/.test(body.pointId)) throw new LearningInputError('重點識別碼無效。');
  const result: LearningPatchPayload = { sourceHash: body.sourceHash, pointId: body.pointId };
  if (body.disposition !== undefined) {
    if (!dispositions.includes(body.disposition as typeof dispositions[number])) throw new LearningInputError('學習分類無效。');
    result.disposition = body.disposition as LearningPatchPayload['disposition'];
  }
  if (body.reason !== undefined) result.reason = boundedText(body.reason, 1200, true);
  if (body.implementation !== undefined) {
    const implementation = record(body.implementation); keys(implementation, ['action', 'result', 'observedAt']);
    const observedAt = boundedText(implementation.observedAt, 40);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(observedAt) || !Number.isFinite(Date.parse(observedAt))) throw new LearningInputError('實作日期必須是有效 ISO 日期時間。');
    result.implementation = { action: boundedText(implementation.action, 1200), result: boundedText(implementation.result, 1600), observedAt };
  }
  if (result.disposition === undefined && result.reason === undefined && result.implementation === undefined) throw new LearningInputError('請提供分類、理由或實作紀錄。');
  return result;
}
const modelText = (value: unknown, max: number) => normalizeLearningProse(boundedText(value, max));
export interface LearningCandidate { id: string; core: string; sourceClaims: SourceClaim[]; chunk: number }
export interface CandidateBatch { candidates: LearningCandidate[]; invalidEvidenceCount: number; unsupportedInterpretations?: number; diagnosticCodes?: string[] }
export function parseCandidateBatch(value: unknown, lines: SourceLine[], chunk: number): CandidateBatch {
  const body = record(value); keys(body, ['candidates']);
  if (!Array.isArray(body.candidates) || body.candidates.length > 3) throw new LearningInputError('候選重點格式無效。');
  const candidates: LearningCandidate[] = []; let invalidEvidenceCount = 0;
  for (const raw of body.candidates) {
    const candidate = record(raw); keys(candidate, ['core', 'sourceClaims']);
    const core = modelText(candidate.core, 240);
    if (!Array.isArray(candidate.sourceClaims) || !candidate.sourceClaims.length || candidate.sourceClaims.length > 3) throw new LearningInputError('候選重點缺少來源引用。');
    const claims = candidate.sourceClaims.map(rawClaim => {
      const claim = record(rawClaim); keys(claim, ['timestamp', 'quote', 'explanation']);
      return { timestamp: typeof claim.timestamp === 'number' ? claim.timestamp : NaN,
        quote: boundedText(claim.quote, 500), explanation: modelText(claim.explanation, 400) };
    });
    const invalid = claims.filter(claim => !verifySourceClaim(claim, lines)).length;
    invalidEvidenceCount += invalid;
    if (invalid) continue; // Never keep a core with partially unsupported evidence.
    candidates.push({ id: `point-${hashValue([core, claims.map(({ timestamp, quote }) => ({ timestamp, quote }))]).slice(0, 16)}`, core, sourceClaims: claims, chunk });
  }
  return { candidates, invalidEvidenceCount };
}

/** Model output supplies only source anchor IDs plus generated prose. Text/time remain server-owned. */
export function parseAnchoredCandidateBatch(value: unknown, lines: SourceLine[], chunk: number): CandidateBatch {
  const body = record(value); keys(body, ['candidates']);
  if (!Array.isArray(body.candidates) || body.candidates.length > 3) throw new LearningInputError('候選重點格式無效。');
  const candidates: LearningCandidate[] = []; let invalidEvidenceCount = 0; let unsupportedInterpretations = 0; const diagnosticCodes: string[] = [];
  for (const raw of body.candidates) {
    try {
      const candidate = record(raw); keys(candidate, ['core', 'sourceClaims']);
      const core = modelText(candidate.core, 240);
      if (!Array.isArray(candidate.sourceClaims) || !candidate.sourceClaims.length || candidate.sourceClaims.length > 3) throw new LearningInputError('來源錨點數量無效。');
      const claims = candidate.sourceClaims.map(rawClaim => {
        const claim = record(rawClaim); keys(claim, ['lineId', 'explanation']);
        const lineId = boundedText(claim.lineId, 80);
        const matches = lines.filter(line => line.anchorId === lineId);
        if (matches.length !== 1 || matches[0].timestamp === null || matches[0].text.length > 500 || matches[0].text.trim().length < 12) throw new LearningInputError('來源錨點不存在或不適合引用。');
        return { timestamp: matches[0].timestamp!, quote: matches[0].text, explanation: modelText(claim.explanation, 400) };
      });
      const gate = sourceInterpretationError(claims.map(claim => claim.quote).join(' '), [core, ...claims.map(claim => claim.explanation)].join(' '));
      if (gate) { unsupportedInterpretations++; diagnosticCodes.push(gate); continue; }
      const parsed = parseCandidateBatch({ candidates: [{ core, sourceClaims: claims }] }, lines, chunk);
      candidates.push(...parsed.candidates); invalidEvidenceCount += parsed.invalidEvidenceCount;
    } catch { invalidEvidenceCount++; diagnosticCodes.push('INVALID_SOURCE_ANCHOR_OR_SCHEMA'); }
  }
  return { candidates, invalidEvidenceCount, unsupportedInterpretations, diagnosticCodes };
}

function assessment(value: unknown): LearningAssessment {
  const body = record(value); keys(body, ['answer', 'reason']);
  if (!['yes', 'no', 'uncertain'].includes(body.answer as string)) throw new LearningInputError('五問判讀格式無效。');
  return { answer: body.answer as LearningAssessment['answer'], reason: modelText(body.reason, 500) };
}
export class UnsupportedInterpretationError extends LearningInputError {}
export function parsePointAnalysis(value: unknown, candidate: LearningCandidate): LearningPoint {
  const body = record(value); keys(body, ['sourceFaithfulness', 'whyImportant', 'conditions', 'application', 'assessment', 'disposition', 'reason']);
  const faithfulness = record(body.sourceFaithfulness); keys(faithfulness, ['supported', 'reason']);
  if (typeof faithfulness.supported !== 'boolean') throw new LearningInputError('來源語意覆核格式無效。');
  const faithfulnessReason = modelText(faithfulness.reason, 600);
  if (!faithfulness.supported) throw new UnsupportedInterpretationError('候選核心或譯述未通過原文語意覆核；未採納該重點。');
  if (!Array.isArray(body.conditions) || body.conditions.length > 5) throw new LearningInputError('成立條件格式無效。');
  const application = record(body.application); keys(application, ['decision', 'operation', 'understanding', 'action', 'observableEvidence']);
  const checks = record(body.assessment); keys(checks, ['credible', 'relevant', 'changes', 'feasible', 'verifiable']);
  if (!dispositions.includes(body.disposition as typeof dispositions[number])) throw new LearningInputError('建議分類格式無效。');
  const credible = assessment(checks.credible);
  return { id: candidate.id, core: candidate.core, sourceClaims: candidate.sourceClaims.map(claim => ({ ...claim })),
    sourceFaithfulness: { supported: true, reason: faithfulnessReason },
    whyImportant: modelText(body.whyImportant, 700), conditions: body.conditions.map(item => modelText(item, 400)),
    application: { decision: modelText(application.decision, 500), operation: modelText(application.operation, 500), understanding: modelText(application.understanding, 500),
      action: modelText(application.action, 500), observableEvidence: modelText(application.observableEvidence, 500) },
    assessment: { credible: { answer: 'uncertain', reason: `${credible.reason}（僅核對字幕引用，未独立查證事實。）`.replace('独立', '獨立') },
      relevant: assessment(checks.relevant), changes: assessment(checks.changes), feasible: assessment(checks.feasible), verifiable: assessment(checks.verifiable) },
    disposition: body.disposition as LearningPoint['disposition'], reason: modelText(body.reason, 700), implementationRecords: [] };
}
