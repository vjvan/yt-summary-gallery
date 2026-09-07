import { createHmac } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少必要環境變數：${name}`);
  return value;
}

function cloudBaseUrl(): URL {
  const value = requiredEnv("AIVAN_CLOUD_API_URL");
  return new URL(value.endsWith("/") ? value : `${value}/`);
}

function isLocalRequest(request: NextRequest): boolean {
  return ["127.0.0.1", "localhost"].includes(request.nextUrl.hostname);
}

function capabilityToken(summaryId: string): string {
  return createHmac("sha256", requiredEnv("AIVAN_CLOUD_SIGNING_SECRET"))
    .update(`aivan-project:${summaryId}`)
    .digest("base64url");
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isLocalRequest(request) && process.env.YT_SUMMARY_ALLOW_REMOTE_CLOUD_PUBLISH !== "1") {
    return NextResponse.json({ error: "雲端發佈入口只允許從本機 YT Summary 使用" }, { status: 403 });
  }

  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    return NextResponse.json({ error: "Invalid summary id" }, { status: 400 });
  }

  try {
    const localProjectUrl = new URL(`/api/summaries/${id}/aivan-project`, request.nextUrl.origin);
    for (const key of ["palette", "font", "bg", "theme", "recall"]) {
      const value = request.nextUrl.searchParams.get(key);
      if (value) localProjectUrl.searchParams.set(key, value);
    }

    const localResponse = await fetch(localProjectUrl, { cache: "no-store" });
    const project = await localResponse.json().catch(() => ({}));
    if (!localResponse.ok) {
      return NextResponse.json(
        { error: project.error || `本機 Project JSON 產生失敗：HTTP ${localResponse.status}` },
        { status: localResponse.status }
      );
    }

    const accessToken = capabilityToken(id);
    const cloudBase = cloudBaseUrl();
    const ingestUrl = new URL(`/api/summaries/${id}/aivan-project/source`, cloudBase);
    const ingestResponse = await fetch(ingestUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requiredEnv("AIVAN_CLOUD_INGEST_TOKEN")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ project, accessToken }),
      cache: "no-store",
    });
    const ingestResult = await ingestResponse.json().catch(() => ({}));
    if (!ingestResponse.ok) {
      throw new Error(ingestResult.error || `雲端同步失敗：HTTP ${ingestResponse.status}`);
    }

    const projectUrl = new URL(`/api/summaries/${id}/aivan-project`, cloudBase);
    projectUrl.searchParams.set("access", accessToken);

    return NextResponse.json(
      {
        ok: true,
        projectUrl: projectUrl.href,
        provider: "yt-summary-cloud",
        syncedAt: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("AIVAN cloud link failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "AIVAN 雲端同步失敗" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
