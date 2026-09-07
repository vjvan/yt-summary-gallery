import type { requestLocalTranslation } from '../lib/watch/local-translator';
import { prepareLearningSource } from '../lib/learning/source';
export const sourceInput = { transcript: 'Do not assume growth means profit. First test the real customer problem.',
  segments: JSON.stringify([{ start: 12.16, end: 17, text: 'Do not assume growth means profit.' }, { start: 17, end: 22, text: 'First test the real customer problem.' }]),
  title: 'Source interview', transcriptSource: 'subtitle:automatic:en' };
export const source = () => prepareLearningSource(sourceInput);
export const pointResult = (supported = true) => ({ sourceFaithfulness: { supported, reason: supported ? '保留了來源的否定語意，未把規模當成利潤。' : '候選把原文否定改成肯定，不支持。' },
  whyImportant: '把成長與獲利區分，避免用表面數字代替判斷。', conditions: ['仍需確認實際成本與收入定義。'],
  application: { decision: 'PRIVATE_APP_TOKEN：先查定義再決定是否借鏡。', operation: '檢查來源主張的成立條件。', understanding: '成長不等同利潤。', action: '寫下目前要驗證的一項假設。', observableEvidence: '留下假設與觀察結果的對照。' },
  assessment: Object.fromEntries(['credible', 'relevant', 'changes', 'feasible', 'verifiable'].map(key => [key, { answer: 'uncertain', reason: '未取得足夠背景，先核對。' }])), disposition: 'understand', reason: '先理解判斷方式，不急著套用。',
});
export function fixtureRequest(onCall?: (input: Parameters<typeof requestLocalTranslation>[0]) => void): typeof requestLocalTranslation {
  return async input => {
    onCall?.(input);
    const data = JSON.parse(input.messages[1].content);
    if (data.sourceLines) {
      const line = data.sourceLines.find((item: { timestamp: number | null; text: string }) => item.timestamp !== null && item.text.length >= 12);
      return JSON.stringify({ candidates: line ? [{ core: '不要把成長規模直接視為獲利。', sourceClaims: [{ lineId: line.anchorId, explanation: '原片提醒，不要假定成長規模等於利潤。' }] }] : [] });
    }
    if (data.candidates) return JSON.stringify({ ids: data.candidates.slice(0, 4).map((item: { id: string }) => item.id) });
    return JSON.stringify(pointResult());
  };
}
