import { assertWatchRequest, watchHeaders, watchErrorResponse } from '@/lib/watch/security';
import { watchService } from '@/lib/watch/service';
export const runtime = 'nodejs';
export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: watchHeaders(request) }); }
  catch (error) { return watchErrorResponse(error); }
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertWatchRequest(request);
    const { id } = await context.params;
    watchService().stop(id);
    return Response.json({ stopped: true }, { headers: watchHeaders(request) });
  } catch (error) { return watchErrorResponse(error, request); }
}
