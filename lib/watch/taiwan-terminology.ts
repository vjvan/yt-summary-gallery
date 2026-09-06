import type { Glossary } from '../glossary-defaults';

const SAFE_TERMS: Readonly<Record<string, string>> = { '視頻': '影片', '軟件': '軟體', '硬件': '硬體', '圖像生成': '影像生成' };
/** Transform only unquoted, unprotected spans; exact product names are never rewritten. */
function unprotected(text: string, protectedTerms: string[], transform: (value: string) => string): string {
  const mask = new Uint8Array(text.length);
  const protect = (from: number, to: number) => mask.fill(1, from, to);
  const quotes = /"(?:\\.|[^"\\])*"|'[^'\n]*'|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』/g;
  for (const match of text.matchAll(quotes)) protect(match.index!, match.index! + match[0].length);
  for (const term of protectedTerms.filter(Boolean)) {
    let at = 0;
    while ((at = text.indexOf(term, at)) >= 0) { protect(at, at + term.length); at += term.length; }
  }
  let output = '', from = 0;
  while (from < text.length) {
    const protectedSpan = mask[from]; let to = from + 1;
    while (to < text.length && mask[to] === protectedSpan) to++;
    const span = text.slice(from, to); output += protectedSpan ? span : transform(span); from = to;
  }
  return output;
}
/** User term preferences win except the explicit request to replace ordinary 視頻 with 影片. */
export function normalizeTaiwanSubtitle(text: string, glossary: Glossary, toTraditional: (value: string) => string = value => value): string {
  const names = glossary.no_translate_terms.filter(term => term.length <= 120).slice(0, 500);
  const traditional = unprotected(text, names, toTraditional);
  const preferred = glossary.term_map.map(([, target]) => target).filter(target => target && target.length <= 120 && !/[視视]頻|视频/.test(target));
  return unprotected(traditional, [...names, ...preferred], span => span.replace(/視頻|軟件|硬件|圖像生成/g, term => SAFE_TERMS[term]));
}
