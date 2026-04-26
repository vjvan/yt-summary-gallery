import { NextResponse } from "next/server";
import { getDb, SummaryRow } from "@/lib/db";

export interface TagAggregate {
  tag: string;
  count: number;
}

export async function GET() {
  const db = getDb();
  const rows = db
    .prepare("SELECT summary FROM summaries WHERE status = 'done' AND summary IS NOT NULL")
    .all() as Pick<SummaryRow, "summary">[];

  const counter = new Map<string, number>();
  for (const row of rows) {
    try {
      const obj = JSON.parse(row.summary || "{}") as { tags?: string[] };
      for (const t of obj.tags || []) {
        if (typeof t !== "string") continue;
        const trimmed = t.trim();
        if (!trimmed) continue;
        counter.set(trimmed, (counter.get(trimmed) || 0) + 1);
      }
    } catch { /* ignore malformed */ }
  }

  const tags: TagAggregate[] = Array.from(counter.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

  return NextResponse.json({ tags });
}
