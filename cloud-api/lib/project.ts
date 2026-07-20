export const MAX_PROJECT_BYTES = 5 * 1024 * 1024;
const MAX_SLIDES = 100;
const MAX_ELEMENTS_PER_SLIDE = 500;

export type JsonRecord = Record<string, unknown>;

export class ProjectValidationError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ProjectValidationError";
    this.status = status;
  }
}

export function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validSummaryId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export function sanitizeProject(
  input: unknown,
  expectedProjectId?: string
): { project: JsonRecord; serializedBytes: number } {
  if (!isRecord(input)) throw new ProjectValidationError("project 必須是 JSON object");
  if (input.schemaVersion !== "aivan-slide-project-v1") {
    throw new ProjectValidationError("不支援的 Project JSON schema");
  }
  if (typeof input.id !== "string" || !input.id.trim()) {
    throw new ProjectValidationError("project 缺少有效 id");
  }
  if (expectedProjectId && input.id !== expectedProjectId) {
    throw new ProjectValidationError("project id 與影片來源不一致");
  }
  if (!Array.isArray(input.slides) || input.slides.length < 1) {
    throw new ProjectValidationError("project 至少需要一張 slide");
  }
  if (input.slides.length > MAX_SLIDES) {
    throw new ProjectValidationError(`project 不可超過 ${MAX_SLIDES} 張 slide`);
  }

  input.slides.forEach((slide, index) => {
    if (!isRecord(slide) || typeof slide.id !== "string" || !slide.id.trim()) {
      throw new ProjectValidationError(`第 ${index + 1} 張 slide 缺少有效 id`);
    }
    if (!Array.isArray(slide.elements)) {
      throw new ProjectValidationError(`第 ${index + 1} 張 slide 缺少 elements`);
    }
    if (slide.elements.length > MAX_ELEMENTS_PER_SLIDE) {
      throw new ProjectValidationError(
        `第 ${index + 1} 張 slide 不可超過 ${MAX_ELEMENTS_PER_SLIDE} 個 elements`
      );
    }
  });

  const project = JSON.parse(JSON.stringify(input)) as JsonRecord;
  delete project.projectUrl;
  delete project.persistence;
  project.updated = new Date().toISOString();

  const serializedBytes = Buffer.byteLength(JSON.stringify(project), "utf8");
  if (serializedBytes > MAX_PROJECT_BYTES) {
    throw new ProjectValidationError("project 超過 5 MiB 限制", 413);
  }

  return { project, serializedBytes };
}

export function projectSourceId(project: JsonRecord): string {
  const source = isRecord(project.source) ? project.source : {};
  if (typeof source.videoId === "string" && source.videoId.trim()) return source.videoId.trim();
  return String(project.id || "").replace(/^yt-/, "");
}
