import { assertWatchRequest, watchHeaders, watchErrorResponse } from '@/lib/watch/security';
import { liveService } from '@/lib/live/service';
export const runtime = 'nodejs';
export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: watchHeaders(request) }); }
  catch (error) { return watchErrorResponse(error); }
}
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try { assertWatchRequest(request); const { id } = await context.params; return Response.json(liveService().get(id), { headers: watchHeaders(request) }); }
  catch (error) { return watchErrorResponse(error, request); }
}
