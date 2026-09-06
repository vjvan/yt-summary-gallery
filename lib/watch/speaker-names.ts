import type { Glossary } from '../glossary-defaults';
import type { WatchSource } from './types';

// Caption speaker labels look like "Drew Brucker (27:13)". They are source
// metadata, not vocabulary: a small local model otherwise transliterates the
// same person a dozen different ways across one video (羅瑞·Flynn, 羅里·飛恩…).
const SPEAKER_LABEL = /(^|[^A-Za-z0-9_'’])([A-Z][A-Za-z'’.-]+(?: [A-Z][A-Za-z'’.-]+){1,3})[ \t]+\((?:\d{1,2}:)?\d{1,2}:\d{2}\)/g;
// A label often follows a capitalized sentence opener ("So Rory Flynn (03:19)").
// Those words are never part of the name.
const OPENERS = new Set('A An And As At Because But By For From However I If In It Its Let Now Of On Once Or Our So That The Their Then There These They This Those To We Well What When Where Which While Who Why With You Your Yeah Yes No Okay Ok Oh Right Like Just Dude Man Bro Guys'.toLowerCase().split(' '));

/** Names that label speech at least twice in this video's own captions, most frequent first. */
export function speakerNames(source: Pick<WatchSource, 'cues'>, limit = 8): string[] {
  const counts = new Map<string, number>();
  for (const cue of source.cues.slice(0, 5000)) {
    for (const match of cue.text.slice(0, 4000).matchAll(SPEAKER_LABEL)) {
      const words = match[2].split(' ');
      // Drop leading openers and anything up to a sentence break: "Higgsfield. So Rory Flynn (03:19)".
      while (words.length > 2 && (OPENERS.has(words[0].toLowerCase()) || /[.!?,;:]$/.test(words[0]))) words.shift();
      if (words.length < 2 || words.some(word => /[.!?,;:]$/.test(word))) continue;
      const name = words.join(' ');
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  const ranked = [...counts].filter(([, count]) => count >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  // "Rory Flynn" beats a rarer "Something Rory Flynn" that merely contains it.
  return ranked.filter(([name, count]) => !ranked.some(([other, otherCount]) => other !== name && name.endsWith(' ' + other) && otherCount >= count))
    .slice(0, limit).map(([name]) => name);
}

/** Session-scoped keep terms derived from the source only; the user's glossary and its cache hash are untouched. */
export function withSpeakerNames(source: Pick<WatchSource, 'cues'>, glossary: Glossary): Glossary {
  const names = speakerNames(source).filter(name => name.length <= 120 && !/["\\\x00-\x1f]/.test(name)
    && !glossary.no_translate_terms.some(term => term.toLowerCase() === name.toLowerCase()));
  return names.length ? { ...glossary, no_translate_terms: [...names, ...glossary.no_translate_terms] } : glossary;
}

/** Speaker names are best-effort: prompted, grammar-allowed and repaired once, never a reason to reject a cue. */
export function withoutSpeakerNames(source: Pick<WatchSource, 'cues'>, glossary: Glossary): Glossary {
  const soft = new Set(speakerNames(source).map(name => name.toLowerCase()));
  return { ...glossary, no_translate_terms: glossary.no_translate_terms.filter(term => !soft.has(term.toLowerCase())) };
}
