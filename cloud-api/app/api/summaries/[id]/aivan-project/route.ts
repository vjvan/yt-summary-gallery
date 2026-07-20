import { NextRequest, NextResponse } from "next/server";
import { bearerToken, secureEqual, tokenHash } from "@/lib/auth";
import { corsHeaders } from "@/lib/cors";
import {
  MAX_PROJECT_BYTES,
  ProjectValidationError,
  sanitizeProject,
  validSummaryId,
} from "@/lib/project";
import {
  findCloudProject,
  latestProjectVersion,
  saveCloudProjectVersion,
} from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function responseHeaders(request: NextRequest): Record<string, string> {
  return { ...corsHeaders(request), "Cache-Control": "no-store" };
}

function saveUrl(request: NextRequest): string {
  const url = new URL(request.nextUrl);
  url.search = "";
  return url.href;
}

function canAccess(token: string, expectedHash: string): boolean {
  return Boolean(token) && secureEqual(tokenHash(token), expectedHash);
}

function authoritativeProject(
  candidate: Record<string, unknown>,
  base: Record<string, unknown>
): Record<string, unknown> {
  candidate.schemaVersion = base.schemaVersion;
  candidate.id = base.id;
  candidate.sourceUrl = base.sourceUrl;
  candidate.source = base.source;
  candidate.provenance = base.provenance;
  return candidate;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const headers = responseHeaders(request);
  const { id } = await params;
  if (!validSummaryId(id)) {
    return NextResponse.json({ error: "Invalid summary id" }, { status: 400, headers });
  }

  try {
    const row = await findCloudProject(id);
    if (!row) return NextResponse.json({ error: "Not found" }, { status: 404, headers });

    const accessToken = request.nextUrl.searchParams.get("access") || "";
    if (!canAccess(accessToken, row.access_token_hash)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
    }

    const base = sanitizeProject(row.base_project_json, row.project_id).project;
    const latest = await latestProjectVersion(row.summary_id);
    const candidate = latest
      ? sanitizeProject(latest.project_json, row.project_id).project
      : JSON.parse(JSON.stringify(base));
    const project = authoritativeProject(candidate, base);

    project.persistence = {
      provider: "yt-summary-cloud",
      saveUrl: saveUrl(request),
      sourceId: row.summary_id,
      revision: latest?.revision ?? 0,
      savedAt: latest?.created_at ?? null,
      dirty: false,
      accessToken,
    };

    return NextResponse.json(project, { headers });
  } catch (error) {
    console.error("Cloud project read failed", error);
    return NextResponse.json({ error: "雲端專案讀取失敗" }, { status: 500, headers });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const headers = responseHeaders(request);
  const { id } = await params;
  if (!validSummaryId(id)) {
    return NextResponse.json({ error: "Invalid summary id" }, { status: 400, headers });
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_PROJECT_BYTES + 256 * 1024) {
    return NextResponse.json({ error: "project 超過 5 MiB 限制" }, { status: 413, headers });
  }

  try {
    const row = await findCloudProject(id);
    if (!row) return NextResponse.json({ error: "Not found" }, { status: 404, headers });

    const accessToken = bearerToken(request);
    if (!canAccess(accessToken, row.access_token_hash)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
    }

    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_PROJECT_BYTES + 256 * 1024) {
      return NextResponse.json({ error: "project 超過 5 MiB 限制" }, { status: 413, headers });
    }

    const body = JSON.parse(raw) as { baseRevision?: unknown; project?: unknown };
    const baseRevision = Number(body.baseRevision);
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
      throw new ProjectValidationError("baseRevision 必須是非負整數");
    }

    const { project } = sanitizeProject(body.project, row.project_id);
    const saved = await saveCloudProjectVersion({
      summaryId: row.summary_id,
      projectId: row.project_id,
      baseRevision,
      project,
    });

    if (!saved.ok) {
      return NextResponse.json(
        {
          error: `專案版本衝突，目前最新版本為 revision ${saved.currentRevision}`,
          code: "revision_conflict",
          currentRevision: saved.currentRevision,
        },
        { status: 409, headers }
      );
    }

    return NextResponse.json(
      { ok: true, revision: saved.revision, savedAt: saved.savedAt },
      { headers }
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "Request JSON 格式錯誤" }, { status: 400, headers });
    }
    if (error instanceof ProjectValidationError) {
      return NextResponse.json({ error: error.message }, { status: error.status, headers });
    }
    console.error("Cloud project save failed", error);
    return NextResponse.json({ error: "雲端專案儲存失敗" }, { status: 500, headers });
  }
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}
