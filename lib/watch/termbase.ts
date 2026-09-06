import type { Glossary } from '../glossary-defaults';

// Focused video-editing preset, based on the user's existing translation termbase.
// This is a runtime supplement, NOT a rewrite of the editable glossary database.
const VIDEO_TERMS: Array<[string, string]> = [
  ['compositor node', '合成器節點'], ['compositor', '合成器'],
  ['masking', '遮罩處理'], ['mask', '遮罩'], ['matte', '遮罩'],
  ['alpha channel', '透明度通道（Alpha）'], ['background layer', '背景圖層'],
  ['foreground', '前景'], ['layer', '圖層'], ['node', '節點'],
  ['first frame', '首格'], ['depth map', '深度圖'], ['soft edge', '柔邊'],
  ['seed', '種子值'], ['blend mode', '混合模式'], ['opacity', '不透明度'],
];

export function withVideoTermbase(user: Glossary): Glossary {
  const terms = new Map<string, [string, string]>();
  for (const pair of [...VIDEO_TERMS, ...user.term_map]) terms.set(pair[0].toLowerCase(), pair);
  return {
    no_translate_terms: [...new Set(['Weave', 'Weavy', 'Figma', 'ControlNet', 'LoRA', 'HED', 'Nano Banana', ...user.no_translate_terms])],
    term_map: [...terms.values()],
    style_rules: [...user.style_rules],
  };
}
