import { WatchError } from '@/lib/watch/errors';
import { assertWatchRequest, readWatchJson, watchHeaders, watchErrorResponse } from '@/lib/watch/security';
import { watchService } from '@/lib/watch/service';
import { watchJobs } from '@/lib/watch/jobs';
export const runtime = 'nodejs';
export const maxDuration = 120;
export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: watchHeaders(request) }); }
  catch (error) { return watchErrorResponse(error); }
}
export async function POST(request: Request) {
  try {
    assertWatchRequest(request);
    const body = await readWatchJson(request);
    if (typeof body.sessionId !== 'string' || typeof body.time !== 'number') throw new WatchError('INVALID_WINDOW', '缺少字幕工作或播放位置。');
    const id = body.sessionId, time = body.time, consent = body.confirmTranslation === true;
    if (request.headers.get('prefer') === 'respond-async') {
      return Response.json(watchJobs().start(signal => watchService().window(id, time, consent, signal)), { status: 202, headers: watchHeaders(request) });
    }
    const result = await watchService().window(id, time, consent, request.signal);
    return Response.json(result, { headers: watchHeaders(request) });
  } catch (error) { return watchErrorResponse(error, request); }
}
