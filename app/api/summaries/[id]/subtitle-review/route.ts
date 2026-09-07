import { getSubtitleReviewService } from '@/lib/review/runtime';
import { ReviewInputError } from '@/lib/review/store';
import { assertPairingRequest, readWatchJson } from '@/lib/watch/security';
import { WatchError } from '@/lib/watch/errors';

/**
 * 字幕語意校訂（完整話語視窗重譯，本機模型，不自動寫回字幕）。
 *
 * GET   目前狀態、視窗與風險、候選與決定。只讀，不呼叫模型。
 * POST  { action: 'start', scope?: 'flagged'|'all'|'windows', limit?: number, windowKeys?: string[] } 啟動一輪（202）
 *       { action: 'cancel' } 取消
 * PATCH { action: 'approve'|'reject'|'reset', sourceHash, cueIndexes: number[] } 逐句決定
 *       { action: 'apply', sourceHash } 把已採用的候選寫回字幕與 SRT，並記錄版本
 *       { action: 'revert' } 還原上一批套用
 *       { action: 'export' } 資料庫已更新但字幕檔沒寫成功時，重新匯出 SRT／VTT
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
const headers = { 'Cache-Control': 'private, no-store', 'Vary': 'Origin', 'Cross-Origin-Resource-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff' };

function errorResponse(error: unknown) {
  if (error instanceof ReviewInputError || error instanceof WatchError) return Response.json({ error: error.message }, { status: error.status, headers });
  console.error('[subtitle-review]', error);
  return Response.json({ error: '語意校訂暫時無法處理，未修改既有字幕。' }, { status: 500, headers });
}

async function checkedId(request: Request, context: Context): Promise<string> {
  assertPairingRequest(request);
  const { id } = await context.params;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new ReviewInputError('影片識別碼無效。');
  return id;
}

const cueIndexes = (value: unknown): number[] => {
  if (!Array.isArray(value) || !value.length || value.length > 500) throw new ReviewInputError('cueIndexes 必須是 1 到 500 個句子索引；請分批決定。');
  const list = value.map(item => Number(item));
  if (list.some(item => !Number.isInteger(item) || item < 0)) throw new ReviewInputError('cueIndexes 含無效索引。');
  return [...new Set(list)];
};

export async function GET(request: Request, context: Context) {
  try { const id = await checkedId(request, context); return Response.json(getSubtitleReviewService().get(id), { headers }); }
  catch (error) { return errorResponse(error); }
}

export async function POST(request: Request, context: Context) {
  try {
    const id = await checkedId(request, context);
    const body = await readWatchJson(request);
    const service = getSubtitleReviewService();
    if (body.action === 'cancel') return Response.json(service.cancel(id), { headers });
    if (body.action !== 'start') throw new ReviewInputError('action 只接受 start 或 cancel。');
    const scope = body.scope === 'all' || body.scope === 'windows' ? body.scope : 'flagged';
    const limit = Number.isInteger(body.limit) && Number(body.limit) >= 1 && Number(body.limit) <= 200 ? Number(body.limit) : 40;
    const windowKeys = Array.isArray(body.windowKeys) ? body.windowKeys.filter((key): key is string => typeof key === 'string' && /^w-\d+-\d+$/.test(key)).slice(0, 200) : undefined;
    const result = service.start(id, { scope, limit, windowKeys });
    return Response.json(result.response, { status: result.accepted ? 202 : 200, headers });
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const id = await checkedId(request, context);
    const body = await readWatchJson(request);
    const service = getSubtitleReviewService();
    const sourceHash = typeof body.sourceHash === 'string' ? body.sourceHash : '';
    if (body.action === 'approve' || body.action === 'reject' || body.action === 'reset') {
      if (!sourceHash) throw new ReviewInputError('缺少 sourceHash。');
      const decision = body.action === 'approve' ? 'approved' : body.action === 'reject' ? 'rejected' : 'candidate';
      return Response.json(service.decide(id, sourceHash, cueIndexes(body.cueIndexes), decision), { headers });
    }
    if (body.action === 'apply') {
      if (!sourceHash) throw new ReviewInputError('缺少 sourceHash。');
      const result = service.apply(id, sourceHash);
      return Response.json({ ...result.response, applied: result.applied, batchId: result.batchId }, { headers });
    }
    if (body.action === 'revert') {
      const result = service.revertLast(id);
      return Response.json({ ...result.response, reverted: result.reverted }, { headers });
    }
    if (body.action === 'export') return Response.json(service.exportAgain(id), { headers });
    if (body.action === 'reapply') {
      if (!sourceHash) throw new ReviewInputError('缺少 sourceHash。');
      const result = service.reapply(id, sourceHash);
      return Response.json({ ...result.response, applied: result.applied, batchId: result.batchId }, { headers });
    }
    throw new ReviewInputError('action 只接受 approve、reject、reset、apply、revert、export 或 reapply。');
  } catch (error) { return errorResponse(error); }
}
