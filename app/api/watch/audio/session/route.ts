import { WatchError } from '@/lib/watch/errors';
import { assertWatchRequest, readWatchJson, watchHeaders, watchErrorResponse } from '@/lib/watch/security';
import { audioWatchService } from '@/lib/watch/audio-service';
export const runtime = 'nodejs';
export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: watchHeaders(request) }); }
  catch (error) { return watchErrorResponse(error); }
}
export async function POST(request: Request) {
  try {
    assertWatchRequest(request);
    const body = await readWatchJson(request);
    if (typeof body.url !== 'string' || typeof body.maxChunks !== 'number' || (body.title !== undefined && typeof body.title !== 'string')) throw new WatchError('AUDIO_INVALID_BODY', '請提供影片網址、音訊片段上限與有效標題。');
    const result = audioWatchService().start({ url: body.url, title: body.title, confirmAudio: body.confirmAudio === true, maxChunks: body.maxChunks });
    return Response.json(result, { headers: watchHeaders(request) });
  } catch (error) { return watchErrorResponse(error, request); }
}
