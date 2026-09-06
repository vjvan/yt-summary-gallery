import { watchProviderStatus } from '@/lib/watch/provider';
import { assertWatchRequest, watchHeaders, watchErrorResponse } from '@/lib/watch/security';
export const runtime = 'nodejs';
export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: watchHeaders(request) }); }
  catch (error) { return watchErrorResponse(error); }
}
/** Fixed-loopback model availability only; never inference, key values or account data. */
export async function GET(request: Request) {
  try {
    assertWatchRequest(request);
    return Response.json({ version: 3, ...await watchProviderStatus(request.signal) }, { headers: watchHeaders(request) });
  } catch (error) { return watchErrorResponse(error,request); }
}
