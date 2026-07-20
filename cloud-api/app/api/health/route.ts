import { NextResponse } from "next/server";
import { cloudHealth } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const health = await cloudHealth();
    return NextResponse.json(
      {
        ok: true,
        service: "aivan-yt-summary-cloud-api",
        storage: "vercel-blob-private",
        projectCount: health.projectCount,
        checkedAt: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Cloud API health check failed", error);
    return NextResponse.json(
      { ok: false, service: "aivan-yt-summary-cloud-api", error: "storage_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
