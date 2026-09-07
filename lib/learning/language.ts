import { normalizeTaiwanSubtitle } from '../watch/taiwan-terminology';
// @ts-expect-error opencc-js has no bundled declarations
import * as OpenCC from 'opencc-js';
const toTraditional: (text: string) => string = OpenCC.Converter({ from: 'cn', to: 'tw' });
/** Only model-authored prose enters here. This changes spelling/terminology, NOT meaning/truth.
 * Never call on source quotes, IDs, hashes, timestamps or user-written implementation notes. */
export function normalizeLearningProse(value: string): string {
  return normalizeTaiwanSubtitle(toTraditional(value), { no_translate_terms: [], term_map: [], style_rules: [] });
}
