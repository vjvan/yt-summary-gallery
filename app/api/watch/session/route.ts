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
    if (typeof body.url !== 'string' || (body.sourceLanguage !== undefined && body.sourceLanguage !== 'en')) throw new WatchError('INVALID_SOURCE', '請提供 YouTube 連結；第一版只支援英文原文字幕。');
    const url = body.url;
    if (request.headers.get('prefer') === 'respond-async') {
      return Response.json(watchJobs().start(signal => watchService().start(url, 'en', signal), result => {
        watchService().stop((result as { sessionId: string }).sessionId);
      }), { status: 202, headers: watchHeaders(request) });
    }
    const session = await watchService().start(url, 'en', request.signal);
    return Response.json(session, { headers: watchHeaders(request) });
  } catch (error) { return watchErrorResponse(error, request); }
}
