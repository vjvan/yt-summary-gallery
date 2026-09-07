/** Conservative extraction guards, NOT general semantic verification or independent fact-checking.
 * They only reject obvious unsupported expansions; accepted prose still needs model + human review. */
export function sourceInterpretationError(source: string, prose: string): string | null {
  const hasEightFigures = /\b(?:8|eight)[ -]figures?\b/i.test(source);
  if (hasEightFigures && /營收|收入|利潤|獲利|收益/.test(prose)
    && !/\brevenue\b|\bincome\b|\bprofit(?:s|able|ability)?\b|\bearnings\b|\bsales\b/i.test(source)) return 'EIGHT_FIGURES_NOT_REVENUE';
  const negated = /\b(?:not|never|no|without|cannot)\b|n['’]t\b/i.test(source);
  const preservesNegation = /不|無|沒|未|別|非|勿|避免|禁止|難以|困難|限制|缺乏|拒絕|停止|不可|失敗/.test(prose);
  if (negated && !preservesNegation) return 'NEGATION_REQUIRES_REVIEW';
  const numericValues = (text: string) => {
    const normalized = text.replace(/(\d[\d,]*(?:\.\d+)?)\s*(萬|億)/g, (_all, raw: string, unit: string) => String(Number(raw.replace(/,/g, '')) * (unit === '萬' ? 10_000 : 100_000_000)));
    return new Set((normalized.match(/\d[\d,]*(?:\.\d+)?/g) || []).map(value => String(Number(value.replace(/,/g, '')))));
  };
  const sourceNumbers = numericValues(source);
  // Common English spelling in a source does not justify arbitrary inferred financial figures.
  const words: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, twenty: 20, hundred: 100, thousand: 1000 };
  for (const word of source.toLowerCase().match(/\b[a-z]+\b/g) || []) if (word in words) sourceNumbers.add(String(words[word]));
  if ([...numericValues(prose)].some(value => !sourceNumbers.has(value))) return 'UNSUPPORTED_NUMERIC_CLAIM';
  return null;
}
