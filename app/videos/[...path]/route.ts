import { serveGeneratedMedia } from '@/lib/generated-media';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ path: string[] }> };
export async function GET(request: Request, context: Context) {
  return serveGeneratedMedia(request, 'videos', (await context.params).path);
}
export const HEAD = GET;
