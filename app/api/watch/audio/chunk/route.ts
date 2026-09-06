import { assertWatchRequest, watchHeaders, watchErrorResponse } from '@/lib/watch/security';
import { audioWatchService } from '@/lib/watch/audio-service';
import { readAudioMultipart } from '@/lib/watch/audio-upload';
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
    const input = await readAudioMultipart(request);
    if (request.headers.get('prefer') === 'respond-async') {
      return Response.json(watchJobs().start(signal => audioWatchService().chunk(input, signal)), { status: 202, headers: watchHeaders(request) });
    }
    const result = await audioWatchService().chunk(input, request.signal);
    return Response.json(result, { headers: watchHeaders(request) });
  } catch (error) { return watchErrorResponse(error, request); }
}
