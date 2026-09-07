import type { LearningPublicDraft, SourceClaim } from './types';
import { verifySourceClaim, type LearningSource } from './source';
/** Input comes ONLY from source-only extraction (before profile application).
 * This explicit projection deliberately never accepts a private analysis/profile object. */
export function buildLearningPublicDraft(claims: SourceClaim[], source: LearningSource): LearningPublicDraft {
  const seen = new Set<string>();
  const safe = claims.filter(claim => {
    if (!verifySourceClaim(claim, source.lines) || typeof claim.explanation !== 'string' || !claim.explanation.trim()) return false;
    const key = `${claim.timestamp}:${claim.quote}`;
    if (seen.has(key)) return false; seen.add(key); return true;
  }).slice(0, 20);
  return { targetCount: 20, status: safe.length < 20 ? 'insufficient-evidence' : 'draft',
    reason: `${safe.length} 則可回查來源的繁中觀點草稿；不補頁、不發布、不取代既有圖卡。引用時間及原文字串已核對，譯述與上下文仍待人工語意覆核；受訪者自述不代表已查證的事實。`,
    cards: safe.map((claim, index) => ({ id: `source-draft-${index + 1}`, kind: 'source-paraphrase-draft', reviewStatus: 'needs-semantic-review',
      title: `原片觀點 ${String(index + 1).padStart(2, '0')}`, body: claim.explanation, sourceHash: source.hash,
      sourceClaims: [{ timestamp: claim.timestamp, quote: claim.quote }] })) };
}
