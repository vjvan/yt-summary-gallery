import { WatchError } from '@/lib/watch/errors';
import { assertWatchRequest, readWatchJson, watchHeaders, watchErrorResponse } from '@/lib/watch/security';
import { liveService } from '@/lib/live/service';
import type { LiveStopReason } from '@/lib/live/types';
export const runtime = 'nodejs';
export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: watchHeaders(request) }); }
  catch (error) { return watchErrorResponse(error); }
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertWatchRequest(request); const { id } = await context.params;
    const body = request.body ? await readWatchJson(request) : {};
    if (Object.keys(body).some(key => !['reason', 'unprocessedSeconds'].includes(key)) || (body.reason !== undefined && typeof body.reason !== 'string') || (body.unprocessedSeconds !== undefined && typeof body.unprocessedSeconds !== 'number')) throw new WatchError('LIVE_INVALID_BODY', '停止收音的欄位格式無效。');
    return Response.json(liveService().stop(id, { reason: body.reason as LiveStopReason | undefined, unprocessedSeconds: body.unprocessedSeconds as number | undefined }), { headers: watchHeaders(request) });
  } catch (error) { return watchErrorResponse(error, request); }
}
