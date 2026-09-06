import { WatchError } from '@/lib/watch/errors';
import { assertWatchRequest, readWatchJson, watchHeaders, watchErrorResponse } from '@/lib/watch/security';
import { watchJobs } from '@/lib/watch/jobs';
import { liveService } from '@/lib/live/service';
import { validateReplyInput } from '@/lib/live/input';
import type { LiveReplyInput } from '@/lib/live/types';
export const runtime = 'nodejs';
export const maxDuration = 120;
export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: watchHeaders(request) }); }
  catch (error) { return watchErrorResponse(error); }
}
export async function POST(request: Request) {
  try {
    assertWatchRequest(request); const body = await readWatchJson(request);
    if (Object.keys(body).some(key => !['sessionId', 'text', 'tone'].includes(key)) || typeof body.sessionId !== 'string' || typeof body.text !== 'string' || (body.tone !== undefined && typeof body.tone !== 'string')) throw new WatchError('LIVE_INVALID_BODY', '請提供直播工作與要翻成英文的中文回覆。');
    const input = body as unknown as LiveReplyInput; validateReplyInput(input);
    if (request.headers.get('prefer')?.toLowerCase() === 'respond-async') return Response.json(watchJobs().start(signal => liveService().reply(input, signal)), { status: 202, headers: watchHeaders(request) });
    return Response.json(await liveService().reply(input, request.signal), { headers: watchHeaders(request) });
  } catch (error) { return watchErrorResponse(error, request); }
}
