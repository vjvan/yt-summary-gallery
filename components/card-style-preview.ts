import { BACKGROUNDS, FONT_PRESETS, buildStyleCss, type CardStyle } from "@/lib/card-style";

/** Mutate only shared style tokens, never reload or fetch a new editor document. */
export function applyCardStylePreview(document: Document, style: CardStyle): boolean {
  const cards = document.querySelectorAll<HTMLElement>(".social-card");
  if (!cards.length) return false;
  const next = buildStyleCss(style);
  for (const [key, value] of Object.entries(next.variables)) document.documentElement.style.setProperty(key, value);
  const backgroundClasses = [...new Set(Object.values(BACKGROUNDS).flatMap(background => background.className.split(/\s+/).filter(Boolean)))];
  for (const card of cards) {
    if (backgroundClasses.length) card.classList.remove(...backgroundClasses);
    const classes = next.backgroundClass.split(/\s+/).filter(Boolean);
    if (classes.length) card.classList.add(...classes);
  }
  return true;
}

/** A missing local face must be visible, not accepted as a browser fallback. */
export async function ensureCardStylePreviewFonts(document: Document, style: CardStyle): Promise<void> {
  const preset = FONT_PRESETS[style.fontPreset];
  const roles = [preset.display, preset.body, preset.mono];
  const unique = [...new Map(roles.map(role => [`${role.family}:${role.weight}`, role])).values()];
  await Promise.all(unique.map(async role => {
    try {
      const faces = await document.fonts.load(`${role.weight} 24px "${role.family}"`, "閱讀 Aa 0123");
      if (!faces.length || faces.some(face => face.status !== "loaded")) throw new Error("font unavailable");
    } catch {
      throw new Error(`此電腦無法載入「${role.family}」本機字型。請先安裝正確字型，再取消並重新開啟預覽；尚未套用或使用替代字型重畫。`);
    }
  }));
}
