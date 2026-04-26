import { NextResponse } from "next/server";
import { getDb, SummaryRow } from "@/lib/db";

export async function GET() {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM summaries ORDER BY created_at DESC LIMIT 200")
    .all() as SummaryRow[];

  const items = rows.map((row) => ({
    ...row,
    summary: row.summary ? JSON.parse(row.summary) : null,
    card_paths: row.card_paths ? JSON.parse(row.card_paths) : null,
  }));

  return NextResponse.json({ items });
}
