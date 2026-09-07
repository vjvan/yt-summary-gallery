import { getLearningService } from '@/lib/learning/runtime';
import { LearningInputError, parseLearningPost } from '@/lib/learning/validation';
import { assertPairingRequest, readWatchJson } from '@/lib/watch/security';
import { readLearningPatchJson } from '@/lib/learning/http';
import { WatchError } from '@/lib/watch/errors';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
const headers = { 'Cache-Control': 'private, no-store', 'Vary': 'Origin', 'Cross-Origin-Resource-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff' };
function errorResponse(error: unknown) {
  if (error instanceof LearningInputError || error instanceof WatchError) return Response.json({ error: error.message }, { status: error.status, headers });
  return Response.json({ error: '私人學習資料暫時無法讀取，未修改既有摘要。' }, { status: 500, headers });
}
async function checkedId(request: Request, context: Context): Promise<string> {
  // Same guard for reads AND mutations: no remote Host, cross-origin web pages or extension origins.
  assertPairingRequest(request);
  const { id } = await context.params;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new LearningInputError('影片識別碼無效。');
  return id;
}
export async function GET(request: Request, context: Context) {
  try { const id = await checkedId(request, context); return Response.json(getLearningService().get(id), { headers }); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    const id = await checkedId(request, context); const body = parseLearningPost(await readWatchJson(request));
    const service = getLearningService();
    if (body.action === 'cancel') return Response.json(service.cancel(id), { headers });
    const result = service.generate(id);
    return Response.json(result.response, { status: result.accepted ? 202 : 200, headers });
  } catch (error) { return errorResponse(error); }
}
export async function PATCH(request: Request, context: Context) {
  try {
    const id = await checkedId(request, context); const body = await readLearningPatchJson(request);
    return Response.json(getLearningService().patch(id, body), { headers });
  } catch (error) { return errorResponse(error); }
}
