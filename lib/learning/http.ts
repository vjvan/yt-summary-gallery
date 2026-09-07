import { LearningInputError } from './validation';
/** PATCH may contain two CJK notes. Bound bytes independently of client character limits. */
export async function readLearningPatchJson(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new LearningInputError('請使用 JSON。', 415);
  const limit = 12_288;
  if (Number(request.headers.get('content-length')) > limit) throw new LearningInputError('請求過大。', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new LearningInputError('缺少請求內容。');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new LearningInputError('請求過大。', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new LearningInputError('JSON 格式不正確。'); }
}
