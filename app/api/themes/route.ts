import { NextResponse } from "next/server";
import { CARD_THEMES } from "@/lib/pipeline/render-card";

/**
 * GET /api/themes
 *
 * 列出所有可用 carousel 配色 theme,給 card 詳情頁的「換配色」picker 用。
 */
export async function GET() {
  return NextResponse.json({
    themes: Object.values(CARD_THEMES).map((t) => ({
      id: t.id,
      label: t.label,
      cardBg: t.cardBg,
      accent: t.accent,
      accentLight: t.accentLight,
      accentDark: t.accentDark,
    })),
  });
}
