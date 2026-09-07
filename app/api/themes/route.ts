import { NextResponse } from "next/server";
import { CARD_THEMES, FONT_PRESETS, BACKGROUNDS, DEFAULT_CARD_STYLE } from "@/lib/card-style";

/** Three independent style axes. `themes` remains for one compatibility release. */
export async function GET() {
  const palettes = Object.values(CARD_THEMES);
  return NextResponse.json({
    palettes,
    fontPresets: Object.values(FONT_PRESETS),
    backgrounds: Object.values(BACKGROUNDS),
    defaults: DEFAULT_CARD_STYLE,
    themes: palettes,
  });
}
