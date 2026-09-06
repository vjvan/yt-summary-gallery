import { assertWatchRequest, watchHeaders, watchErrorResponse } from '@/lib/watch/security';
import { watchJobs } from '@/lib/watch/jobs';
import { readLiveMultipart } from '@/lib/live/input';
import { liveService } from '@/lib/live/service';
export const runtime = 'nodejs';
export const maxDuration = 120;
export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: watchHeaders(request) }); }
  catch (error) { return watchErrorResponse(error); }
}
export async function POST(request: Request) {
  try {
    assertWatchRequest(request); const input = await readLiveMultipart(request);
    if (request.headers.get('prefer')?.toLowerCase() === 'respond-async') return Response.json(watchJobs().start(signal => liveService().chunk(input, signal)), { status: 202, headers: watchHeaders(request) });
    return Response.json(await liveService().chunk(input, request.signal), { headers: watchHeaders(request) });
  } catch (error) { return watchErrorResponse(error, request); }
}
