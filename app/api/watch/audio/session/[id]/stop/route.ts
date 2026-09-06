import { assertWatchRequest, watchHeaders, watchErrorResponse } from '@/lib/watch/security';
import { audioWatchService } from '@/lib/watch/audio-service';
export const runtime = 'nodejs';
export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: watchHeaders(request) }); }
  catch (error) { return watchErrorResponse(error); }
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertWatchRequest(request);
    audioWatchService().stop((await context.params).id);
    return Response.json({ stopped: true }, { headers: watchHeaders(request) });
  } catch (error) { return watchErrorResponse(error, request); }
}
