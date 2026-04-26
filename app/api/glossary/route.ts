import { NextRequest, NextResponse } from "next/server";
import { getGlossary, saveGlossary, resetGlossary } from "@/lib/glossary-store";
import type { Glossary } from "@/lib/glossary-defaults";

export async function GET() {
  const g = getGlossary();
  return NextResponse.json(g);
}

export async function PUT(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    saveGlossary(body as Glossary);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Save failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/**
 * DELETE = 重置為預設 glossary
 */
export async function DELETE() {
  const g = resetGlossary();
  return NextResponse.json(g);
}
