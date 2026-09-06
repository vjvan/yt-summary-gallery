import { watchJobs } from '@/lib/watch/jobs';
import { assertWatchRequest, watchHeaders, watchErrorResponse } from '@/lib/watch/security';
export const runtime = 'nodejs';
export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: watchHeaders(request) }); }
  catch (error) { return watchErrorResponse(error); }
}
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertWatchRequest(request);
    const job = watchJobs().get((await context.params).id);
    return Response.json(job, { status: job.status === 'processing' ? 202 : 200, headers: watchHeaders(request) });
  } catch (error) { return watchErrorResponse(error, request); }
}
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertWatchRequest(request);
    watchJobs().cancel((await context.params).id);
    return Response.json({ cancelled: true }, { headers: watchHeaders(request) });
  } catch (error) { return watchErrorResponse(error, request); }
}
