import { WatchError } from '@/lib/watch/errors';
import { assertWatchRequest, readWatchJson, watchHeaders, watchErrorResponse } from '@/lib/watch/security';
import { liveService } from '@/lib/live/service';
export const runtime = 'nodejs';
export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: watchHeaders(request) }); }
  catch (error) { return watchErrorResponse(error); }
}
export async function GET(request: Request) {
  try { assertWatchRequest(request); return Response.json(liveService().list(), { headers: watchHeaders(request) }); }
  catch (error) { return watchErrorResponse(error, request); }
}
export async function POST(request: Request) {
  try {
    assertWatchRequest(request); const body = await readWatchJson(request);
    if (Object.keys(body).some(key => !['url', 'title', 'confirmAudio'].includes(key)) || typeof body.url !== 'string' || (body.title !== undefined && typeof body.title !== 'string')) throw new WatchError('LIVE_INVALID_BODY', '請提供 Discord 頻道網址、可選標題與收音同意。');
    const result = await liveService().start({ url: body.url, title: body.title, confirmAudio: body.confirmAudio === true }, request.signal);
    return Response.json(result, { headers: watchHeaders(request) });
  } catch (error) { return watchErrorResponse(error, request); }
}
