import { getDb } from '@/lib/db';
import { assertAttachmentRequest, attachOriginalVideo, attachmentErrorResponse } from '@/lib/pipeline/attach-original';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 960;

/** Raw MP4 body with explicit rights + same-version timeline confirmation; never multipart-buffered. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    // Reject unauthorized requests before even opening the database.
    assertAttachmentRequest(request);
    const result = await attachOriginalVideo(request, (await params).id, { db: getDb(), root: process.cwd() });
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return attachmentErrorResponse(error); }
}
