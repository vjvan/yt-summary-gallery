import type Database from "better-sqlite3";
import type { AivanProjectVersionRow } from "./db";

export const MAX_AIVAN_PROJECT_BYTES = 5 * 1024 * 1024;
const MAX_SLIDES = 100;
const MAX_ELEMENTS_PER_SLIDE = 500;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export class AivanProjectValidationError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "AivanProjectValidationError";
    this.status = status;
  }
}

export class AivanProjectConflictError extends Error {
  currentRevision: number;

  constructor(currentRevision: number) {
    super(`專案版本衝突，目前最新版本為 revision ${currentRevision}`);
    this.name = "AivanProjectConflictError";
    this.currentRevision = currentRevision;
  }
}

export function sanitizeAivanProject(
  input: unknown,
  expectedProjectId: string
): { project: JsonRecord; serialized: string } {
  if (!isRecord(input)) {
    throw new AivanProjectValidationError("project 必須是 JSON object");
  }
  if (input.schemaVersion !== "aivan-slide-project-v1") {
    throw new AivanProjectValidationError("不支援的 Project JSON schema");
  }
  if (input.id !== expectedProjectId) {
    throw new AivanProjectValidationError("project id 與影片來源不一致");
  }
  if (!Array.isArray(input.slides) || input.slides.length < 1) {
    throw new AivanProjectValidationError("project 至少需要一張 slide");
  }
  if (input.slides.length > MAX_SLIDES) {
    throw new AivanProjectValidationError(`project 不可超過 ${MAX_SLIDES} 張 slide`);
  }

  input.slides.forEach((slide, index) => {
    if (!isRecord(slide) || typeof slide.id !== "string" || !slide.id.trim()) {
      throw new AivanProjectValidationError(`第 ${index + 1} 張 slide 缺少有效 id`);
    }
    if (!Array.isArray(slide.elements)) {
      throw new AivanProjectValidationError(`第 ${index + 1} 張 slide 缺少 elements`);
    }
    if (slide.elements.length > MAX_ELEMENTS_PER_SLIDE) {
      throw new AivanProjectValidationError(
        `第 ${index + 1} 張 slide 不可超過 ${MAX_ELEMENTS_PER_SLIDE} 個 elements`
      );
    }
  });

  const project = JSON.parse(JSON.stringify(input)) as JsonRecord;
  delete project.projectUrl;
  delete project.persistence;
  project.updated = new Date().toISOString();

  const serialized = JSON.stringify(project);
  if (Buffer.byteLength(serialized, "utf8") > MAX_AIVAN_PROJECT_BYTES) {
    throw new AivanProjectValidationError("project 超過 5 MiB 限制", 413);
  }

  return { project, serialized };
}

export function getLatestAivanProjectVersion(
  db: Database.Database,
  summaryId: string
): AivanProjectVersionRow | undefined {
  return db
    .prepare(
      `SELECT id, summary_id, project_id, revision, project_json, created_at
       FROM aivan_project_versions
       WHERE summary_id = ?
       ORDER BY revision DESC
       LIMIT 1`
    )
    .get(summaryId) as AivanProjectVersionRow | undefined;
}

export function saveAivanProjectVersion(
  db: Database.Database,
  input: {
    summaryId: string;
    projectId: string;
    baseRevision: number;
    projectJson: string;
  }
): AivanProjectVersionRow {
  const save = db.transaction(() => {
    const latest = getLatestAivanProjectVersion(db, input.summaryId);
    const currentRevision = latest?.revision ?? 0;
    if (input.baseRevision !== currentRevision) {
      throw new AivanProjectConflictError(currentRevision);
    }

    const revision = currentRevision + 1;
    db.prepare(
      `INSERT INTO aivan_project_versions
       (summary_id, project_id, revision, project_json)
       VALUES (?, ?, ?, ?)`
    ).run(input.summaryId, input.projectId, revision, input.projectJson);

    const saved = getLatestAivanProjectVersion(db, input.summaryId);
    if (!saved || saved.revision !== revision) {
      throw new Error("AIVAN project 儲存後讀取失敗");
    }
    return saved;
  });

  return save();
}
