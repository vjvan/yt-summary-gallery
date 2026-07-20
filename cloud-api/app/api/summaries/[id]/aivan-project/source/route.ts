import { NextRequest, NextResponse } from "next/server";
import { bearerToken, secureEqual, tokenHash } from "@/lib/auth";
import { requireEnv } from "@/lib/env";
import {
  projectSourceId,
  ProjectValidationError,
  sanitizeProject,
  validSummaryId,
} from "@/lib/project";
import { upsertCloudProject } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ingestToken = bearerToken(request);
  if (!ingestToken || !secureEqual(ingestToken, requireEnv("YT_SUMMARY_INGEST_TOKEN"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  if (!validSummaryId(id)) {
    return NextResponse.json({ error: "Invalid summary id" }, { status: 400 });
  }

  try {
    const body = await request.json() as { project?: unknown; accessToken?: unknown };
    if (typeof body.accessToken !== "string" || body.accessToken.length < 32) {
      throw new ProjectValidationError("accessToken 至少需要 32 個字元");
    }

    const { project } = sanitizeProject(body.project);
    const projectId = String(project.id);
    const sourceId = projectSourceId(project);
    if (!sourceId) throw new ProjectValidationError("project 缺少來源 video id");

    await upsertCloudProject({
      summaryId: id,
      projectId,
      sourceId,
      title: typeof project.title === "string" ? project.title : "",
      project,
      accessTokenHash: tokenHash(body.accessToken),
    });

    return NextResponse.json({ ok: true, summaryId: id, projectId, sourceId });
  } catch (error) {
    if (error instanceof ProjectValidationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Cloud source ingest failed", error);
    return NextResponse.json({ error: "雲端來源同步失敗" }, { status: 500 });
  }
}
