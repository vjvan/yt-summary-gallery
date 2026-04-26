/**
 * 把 glossary 組合成可貼進 system prompt 的字串。
 *
 * 純函式,不 import store / DB,讓測試 + 重用更乾淨。
 * 預設值在 lib/glossary-defaults.ts;讀寫在 lib/glossary-store.ts。
 */

import type { Glossary } from "../glossary-defaults";

export function buildGlossaryPromptSection(g: Glossary): string {
  const sections: string[] = [];

  if (g.no_translate_terms.length > 0) {
    sections.push("【保留英文的工具/平台/品牌名稱(直接寫英文,不要翻譯)】");
    sections.push(g.no_translate_terms.join(", "));
    sections.push("");
  }

  if (g.term_map.length > 0) {
    sections.push("【中英術語對照表(以下英文出現時請按此對照翻譯,以求一致)】");
    sections.push(g.term_map.map(([en, zh]) => `${en} → ${zh}`).join("\n"));
    sections.push("");
  }

  if (g.style_rules.length > 0) {
    sections.push("【口語化處理規則】");
    sections.push(g.style_rules.map((r, i) => `${i + 1}. ${r}`).join("\n"));
  }

  return sections.join("\n");
}
