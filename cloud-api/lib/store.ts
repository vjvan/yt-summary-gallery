import {
  BlobPreconditionFailedError,
  get,
  list,
  put,
} from "@vercel/blob";
import type { JsonRecord } from "./project";

export interface CloudProjectRow {
  summary_id: string;
  project_id: string;
  source_id: string;
  title: string;
  base_project_json: JsonRecord;
  access_token_hash: string;
  source_updated_at: string;
  created_at: string;
  latest_revision: number;
  latest_project_json: JsonRecord | null;
  latest_saved_at: string | null;
}

export interface CloudProjectVersionRow {
  revision: number;
  project_json: JsonRecord;
  created_at: string;
}

interface StoredJson<T> {
  value: T;
  etag: string;
}

const ACCESS = "private" as const;
const ROOT = "yt-summary/projects";

function recordPath(summaryId: string): string {
  return `${ROOT}/${summaryId}/record.json`;
}

function aliasPath(sourceId: string): string {
  return `yt-summary/aliases/${sourceId}.json`;
}

async function readJson<T>(pathname: string): Promise<StoredJson<T> | null> {
  const result = await get(pathname, { access: ACCESS, useCache: false });
  if (!result || result.statusCode !== 200) return null;
  const raw = await new Response(result.stream).text();
  // Private Blob 的 no-cache GET 目前可能回傳 weak ETag（W/"..."），
  // conditional put 則需要 strong ETag；保留同一個值並移除 weak prefix。
  return {
    value: JSON.parse(raw) as T,
    etag: result.blob.etag.replace(/^W\//, ""),
  };
}

async function writeJson(
  pathname: string,
  value: unknown,
  options: { allowOverwrite?: boolean; ifMatch?: string } = {}
) {
  return put(pathname, JSON.stringify(value), {
    access: ACCESS,
    contentType: "application/json; charset=utf-8",
    cacheControlMaxAge: 60,
    addRandomSuffix: false,
    ...options,
  });
}

async function resolveSummaryId(id: string): Promise<string | null> {
  const direct = await readJson<CloudProjectRow>(recordPath(id));
  if (direct) return direct.value.summary_id;

  const alias = await readJson<{ summaryId: string }>(aliasPath(id));
  return alias?.value.summaryId || null;
}

async function readProjectRecord(
  id: string
): Promise<StoredJson<CloudProjectRow> | null> {
  const summaryId = await resolveSummaryId(id);
  return summaryId ? readJson<CloudProjectRow>(recordPath(summaryId)) : null;
}

export async function findCloudProject(id: string): Promise<CloudProjectRow | null> {
  return (await readProjectRecord(id))?.value || null;
}

export async function latestProjectVersion(
  summaryId: string
): Promise<CloudProjectVersionRow | null> {
  const row = (await readProjectRecord(summaryId))?.value;
  if (!row || !row.latest_project_json || row.latest_revision < 1) return null;
  return {
    revision: row.latest_revision,
    project_json: row.latest_project_json,
    created_at: row.latest_saved_at || row.source_updated_at,
  };
}

export async function upsertCloudProject(input: {
  summaryId: string;
  projectId: string;
  sourceId: string;
  title: string;
  project: JsonRecord;
  accessTokenHash: string;
}): Promise<void> {
  const pathname = recordPath(input.summaryId);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await readJson<CloudProjectRow>(pathname);
    const now = new Date().toISOString();
    const next: CloudProjectRow = {
      summary_id: input.summaryId,
      project_id: input.projectId,
      source_id: input.sourceId,
      title: input.title,
      base_project_json: input.project,
      access_token_hash: input.accessTokenHash,
      source_updated_at: now,
      created_at: existing?.value.created_at || now,
      latest_revision: existing?.value.latest_revision || 0,
      latest_project_json: existing?.value.latest_project_json || null,
      latest_saved_at: existing?.value.latest_saved_at || null,
    };

    try {
      await writeJson(pathname, next, existing
        ? { allowOverwrite: true, ifMatch: existing.etag }
        : { allowOverwrite: false });
      await writeJson(
        aliasPath(input.sourceId),
        { summaryId: input.summaryId },
        { allowOverwrite: true }
      );
      return;
    } catch (error) {
      const appearedDuringCreate = !existing && Boolean(await readJson(pathname));
      if (!(error instanceof BlobPreconditionFailedError) && !appearedDuringCreate) throw error;
    }
  }

  throw new Error("雲端來源同步時發生版本競爭，請稍後重試");
}

export async function saveCloudProjectVersion(input: {
  summaryId: string;
  projectId: string;
  baseRevision: number;
  project: JsonRecord;
}): Promise<{ ok: boolean; currentRevision: number; revision: number; savedAt: string | null }> {
  const pathname = recordPath(input.summaryId);
  const stored = await readJson<CloudProjectRow>(pathname);
  if (!stored) throw new Error("找不到雲端專案");

  const currentRevision = stored.value.latest_revision || 0;
  if (currentRevision !== input.baseRevision) {
    return { ok: false, currentRevision, revision: currentRevision, savedAt: null };
  }

  const revision = currentRevision + 1;
  const savedAt = new Date().toISOString();
  const next: CloudProjectRow = {
    ...stored.value,
    latest_revision: revision,
    latest_project_json: input.project,
    latest_saved_at: savedAt,
  };

  try {
    // Vercel Blob 的 ETag 條件寫入提供樂觀鎖，避免兩個 Studio 分頁互相覆蓋。
    // Source: https://vercel.com/docs/vercel-blob#conditional-writes
    await writeJson(pathname, next, {
      allowOverwrite: true,
      ifMatch: stored.etag,
    });
  } catch (error) {
    if (error instanceof BlobPreconditionFailedError) {
      const latest = await readJson<CloudProjectRow>(pathname);
      const latestRevision = latest?.value.latest_revision || currentRevision;
      return {
        ok: false,
        currentRevision: latestRevision,
        revision: latestRevision,
        savedAt: null,
      };
    }
    throw error;
  }

  // 每一版另存為 immutable blob；主要讀取仍走 record.json，避免快取造成舊版。
  await writeJson(
    `${ROOT}/${input.summaryId}/versions/revision-${revision}-${crypto.randomUUID()}.json`,
    {
      summaryId: input.summaryId,
      projectId: input.projectId,
      revision,
      project: input.project,
      createdAt: savedAt,
    }
  );

  return { ok: true, currentRevision: revision, revision, savedAt };
}

export async function cloudHealth(): Promise<{ projectCount: number }> {
  let cursor: string | undefined;
  let projectCount = 0;
  do {
    const page = await list({ prefix: `${ROOT}/`, limit: 1000, cursor });
    projectCount += page.blobs.filter((blob) => blob.pathname.endsWith("/record.json")).length;
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return { projectCount };
}
