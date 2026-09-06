import { assertPairingRequest, pairingToken, watchErrorResponse } from '@/lib/watch/security';
import { watchLimits } from '@/lib/watch/service';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    assertPairingRequest(request);
    return Response.json({ token: pairingToken(), limits: watchLimits() }, { headers: { 'Cache-Control': 'no-store', 'Cross-Origin-Resource-Policy': 'same-origin' } });
  } catch (error) { return watchErrorResponse(error); }
}
