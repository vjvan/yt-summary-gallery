import { NextRequest, NextResponse } from "next/server";
import { getDb, type SummaryRow } from "@/lib/db";
import { ensureSummaryShape, type Summary } from "@/lib/pipeline/extract-summary";
import { buildAivanProject, type TranscriptSegment } from "@/lib/pipeline/build-aivan-project";
import type { VideoMetadata } from "@/lib/pipeline/fetch-transcript";
import {
  AivanProjectConflictError,
  AivanProjectValidationError,
  getLatestAivanProjectVersion,
  MAX_AIVAN_PROJECT_BYTES,
  sanitizeAivanProject,
  saveAivanProjectVersion,
} from "@/lib/aivan-project-store";

const LOCAL_STUDIO_ORIGINS = new Set([
  "http://127.0.0.1:8765",
  "http://localhost:8765",
]);

function allowedOrigins(): Set<string> {
  const configured = (process.env.AIVAN_SLIDE_STUDIO_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set([...LOCAL_STUDIO_ORIGINS, ...configured]);
}

function corsHeaders(req: NextRequest): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const allowed = allowedOrigins();

  return {
    ...(allowed.has(origin) ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function saveUrl(req: NextRequest): string {
  const url = new URL(req.nextUrl);
  url.search = "";
  return url.href;
}

function sqliteUtcToIso(value: string | null): string | null {
  if (!value) return null;
  return `${value.replace(" ", "T")}Z`;
}

function persistenceMetadata(
  req: NextRequest,
  revision: number,
  savedAt: string | null,
  summaryId: string
) {
  return {
    provider: "yt-summary",
    saveUrl: saveUrl(req),
    sourceId: summaryId,
    revision,
    savedAt: sqliteUtcToIso(savedAt),
    dirty: false,
  };
}

function parseSegments(raw: string | null | undefined): TranscriptSegment[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.flatMap((segment) => {
      if (!segment || typeof segment !== "object") return [];
      const candidate = segment as Record<string, unknown>;
      const start = Number(candidate.start);
      const end = Number(candidate.end);
      const text = String(candidate.text || "");
      return Number.isFinite(start) && Number.isFinite(end) && text
        ? [{ start, end, text }]
        : [];
    });
  } catch {
    return [];
  }
}

/**
 * GET /api/summaries/{id}/aivan-project
 *
 * 把 YT Summary 的來源、證據、內容包與現有 Carousel 視覺，輸出成
 * AIVAN Slide Studio 可直接載入的 Project JSON v1。
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM summaries WHERE id = ? OR video_id = ?")
    .get(id, id) as SummaryRow | undefined;

  const headers = {
    ...corsHeaders(req),
    "Cache-Control": "no-store",
  };

  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404, headers });
  if (!row.summary) {
    return NextResponse.json({ error: "尚未產出摘要" }, { status: 400, headers });
  }

  const summary: Summary = ensureSummaryShape(JSON.parse(row.summary) as Partial<Summary>);
  const metadata: VideoMetadata = {
    video_id: row.video_id,
    title: row.title || "",
    channel: row.channel || "",
    duration: row.duration || 0,
    duration_display: row.duration_display || "",
    upload_date: "",
    thumbnail_url: row.thumbnail_url || "",
    view_count: 0,
    transcript_source: row.transcript_source || "whisper",
  };

  const sp = req.nextUrl.searchParams;
  const baseProject = buildAivanProject(summary, metadata, {
    projectId: `yt-${row.video_id}`,
    sourceUrl: new URL(`/card/${row.id}`, req.nextUrl.origin).href,
    sourceType: row.source || "youtube",
    originalUrl: row.url,
    createdAt: row.created_at,
    themeOverride: sp.get("theme") || undefined,
    includeRecall: sp.get("recall") === "1",
    transcriptSegments: parseSegments(row.segments_zh || row.segments),
    watermark: process.env.CARD_WATERMARK || "vjvan.com · P2P AI Lab",
  });

  const latest = getLatestAivanProjectVersion(db, row.id);
  let project = baseProject as Record<string, unknown>;

  if (latest) {
    try {
      project = sanitizeAivanProject(
        JSON.parse(latest.project_json) as unknown,
        `yt-${row.video_id}`
      ).project;
    } catch (error) {
      console.error("讀取 AIVAN project draft 失敗，改用 AI 原稿", error);
      project = baseProject as Record<string, unknown>;
    }
  }

  // 來源與證據永遠由 YT Summary 重新提供，避免草稿偽造或凍結來源 metadata。
  project.schemaVersion = baseProject.schemaVersion;
  project.id = baseProject.id;
  project.sourceUrl = baseProject.sourceUrl;
  project.source = baseProject.source;
  project.provenance = baseProject.provenance;
  project.persistence = persistenceMetadata(
    req,
    latest?.revision ?? 0,
    latest?.created_at ?? null,
    row.id
  );

  return NextResponse.json(project, { headers });
}

/**
 * PUT /api/summaries/{id}/aivan-project
 *
 * 將 Studio 草稿以 append-only revision 保存。baseRevision 必須等於目前最新版，
 * 否則回 409，避免舊分頁靜默覆蓋新版本。
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const headers = {
    ...corsHeaders(req),
    "Cache-Control": "no-store",
  };
  const origin = req.headers.get("origin") || "";
  if (!allowedOrigins().has(origin)) {
    return NextResponse.json(
      { error: "此來源沒有 AIVAN project 寫入權限" },
      { status: 403, headers }
    );
  }

  const contentLength = Number(req.headers.get("content-length") || 0);
  if (contentLength > MAX_AIVAN_PROJECT_BYTES + 256 * 1024) {
    return NextResponse.json({ error: "project 超過 5 MiB 限制" }, { status: 413, headers });
  }

  const { id } = await params;
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM summaries WHERE id = ? OR video_id = ?")
    .get(id, id) as SummaryRow | undefined;

  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404, headers });

  try {
    const raw = await req.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_AIVAN_PROJECT_BYTES + 256 * 1024) {
      return NextResponse.json({ error: "project 超過 5 MiB 限制" }, { status: 413, headers });
    }

    const body = JSON.parse(raw) as { baseRevision?: unknown; project?: unknown };
    const baseRevision = Number(body.baseRevision);
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
      throw new AivanProjectValidationError("baseRevision 必須是非負整數");
    }

    const projectId = `yt-${row.video_id}`;
    const { serialized } = sanitizeAivanProject(body.project, projectId);
    const saved = saveAivanProjectVersion(db, {
      summaryId: row.id,
      projectId,
      baseRevision,
      projectJson: serialized,
    });

    return NextResponse.json(
      {
        ok: true,
        revision: saved.revision,
        savedAt: sqliteUtcToIso(saved.created_at),
      },
      { headers }
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "Request JSON 格式錯誤" }, { status: 400, headers });
    }
    if (error instanceof AivanProjectValidationError) {
      return NextResponse.json({ error: error.message }, { status: error.status, headers });
    }
    if (error instanceof AivanProjectConflictError) {
      return NextResponse.json(
        {
          error: error.message,
          code: "revision_conflict",
          currentRevision: error.currentRevision,
        },
        { status: 409, headers }
      );
    }
    console.error("AIVAN project 儲存失敗", error);
    return NextResponse.json({ error: "AIVAN project 儲存失敗" }, { status: 500, headers });
  }
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}
