import type { Glossary } from '../glossary-defaults';
import type { WatchCue, WatchSource } from './types';

const PLATFORM_ALIASES = [
  { canonical: 'OpenArt', pattern: /\bopen[\s-]*art\b/gi },
  { canonical: 'Higgsfield', pattern: /\b(?:higgs[\s-]*field|hexfield)\b/gi },
] as const;
const AI_CONTEXT = /\b(?:AI\s+(?:platforms?|tools?|videos?|images?|ads?|art|generators?|workflows?|models?)|image\s+generat(?:ion|or)|video\s+generat(?:ion|or)|Figma\s+(?:Weave|Wave)|ChatGPT|Midjourney|Nano\s+Banana)\b/i;
const PHYSICS_CONTEXT = /\b(?:physics|bosons?|particles?|quantum|fermions?|electroweak|vacuum|symmetry|scalar\s+field|CERN|Higgs\s+mechanism|permeates|universe)\b/i;
const PHYSICS_MASS = /\b(?:Higgs[\s-]+field|matter)\b.{0,100}\bmass\b|\bmass\b.{0,100}\b(?:Higgs[\s-]+field|matter)\b/i;
// ASR sometimes joins the physical field's name. This output-correction veto
// requires a mass-giving relationship, not an AI platform's mass production.
const JOINED_FIELD_MASS_RELATION = /\bHiggsfield\b[^.!?\r\n]{0,100}\b(?:gives?|provides?|confers?|imparts?|is\s+responsible\s+for)\b[^.!?\r\n]{0,80}\bmass\b(?![\s-]+produc)/i;
const ART_EVENT = /\bopen[\s-]+art\s+(?:exhibition|museum|gallery|show|call|competition|contest|studio)\b/i;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function hasMidjourneyStyleReference(cue: Pick<WatchCue, 'text'>): boolean {
  return /\bMidjourney\b/i.test(cue.text) && /\bsrefs?\b/i.test(cue.text);
}

/** Correct an already-present platform-name spelling in place, never insert a
 * missing mention or translate an actual physics term. All ordinary validation
 * (including exact mention count) still runs on the returned text. */
export function canonicalizeProtectedPlatformTranslation(text: string, source: WatchSource, cue: WatchCue, glossary: Glossary): string {
  if (!/\bHiggsfield\b/i.test(cue.text) || !requiredProtectedTerms(cue, glossary).includes('Higgsfield')) return text;
  const index = source.cues.findIndex(item => item.id === cue.id);
  const nearby = index < 0 ? [cue] : source.cues.slice(Math.max(0, index - 1), index + 2);
  if ([source.title.slice(0, 300), ...nearby.map(item => item.text)].some(value => PHYSICS_CONTEXT.test(value) || PHYSICS_MASS.test(value) || JOINED_FIELD_MASS_RELATION.test(value))) return text;
  if (![source.title.slice(0, 300), ...source.cues.slice(0, 1000).map(item => item.text.slice(0, 500))].some(value => AI_CONTEXT.test(value))) return text;
  return text.replace(/希格斯(?:[場场](?:域)?|菲[爾尔]德)/g, 'Higgsfield');
}

/** Normalize only model input; never mutate display subtitles, timestamps or stored ASR text. */
export function prepareProtectedCue(source: WatchSource, cue: WatchCue, glossary: Glossary): { cue: WatchCue; glossary: Glossary } {
  // Midjourney's --sref is a style-reference parameter; its spoken plural is
  // still a technical identifier, not permission to retain arbitrary English.
  // Require Midjourney in THIS cue, and respect explicit user term choices.
  if (hasMidjourneyStyleReference(cue)) {
    const references = [...new Set(cue.text.match(/\bsrefs?\b/gi) ?? [])].filter(term => ![...glossary.no_translate_terms, ...glossary.term_map.map(([key]) => key)]
      .some(key => key.toLowerCase().replace(/s$/, '') === term.toLowerCase().replace(/s$/, '')));
    if (references.length) glossary = { ...glossary, no_translate_terms: [...references, ...glossary.no_translate_terms] };
  }
  // A narrow official-product spelling, not a Title Case name detector. Respect
  // explicit user mappings and never reinterpret generic "game boy camera" words.
  const productNames = ['Game Boy Camera'].filter(name => new RegExp(`\\b${escape(name)}\\b`).test(cue.text)
    && !glossary.no_translate_terms.some(term => term.toLowerCase() === name.toLowerCase())
    && !glossary.term_map.some(([term]) => term.toLowerCase() === name.toLowerCase()));
  if (productNames.length) {
    const recognized = { ...glossary, no_translate_terms: [...productNames, ...glossary.no_translate_terms] };
    // This additive exception is only for source-only-name preservation. Do not
    // change prompts/mandatory names for ordinary sentences already cacheable.
    if (protectedNamesOnlyText(cue, recognized) !== null) glossary = recognized;
  }

  const evidence = [source.title.slice(0, 300), ...source.cues.slice(0, 1000).map(item => item.text.slice(0, 500))];
  const aiVideo = evidence.some(text => AI_CONTEXT.test(text));
  const cueIndex = source.cues.findIndex(item => item.id === cue.id);
  const nearby = cueIndex < 0 ? [cue] : source.cues.slice(Math.max(0, cueIndex - 1), cueIndex + 2);
  const physicsText = [source.title.slice(0, 300), ...nearby.map(item => item.text)];
  // 'does not matter' is ordinary speech; mass + matter/field is the physical meaning.
  const physics = physicsText.some(text => PHYSICS_CONTEXT.test(text) || PHYSICS_MASS.test(text));
  let text = cue.text;
  const applied: string[] = [];
  for (const alias of PLATFORM_ALIASES) {
    const knownBrand = evidence.some(value => new RegExp(`\\b${alias.canonical}\\b`, 'i').test(value));
    if ((!aiVideo && !knownBrand) || (alias.canonical === 'Higgsfield' && physics) || (alias.canonical === 'OpenArt' && ART_EVENT.test(cue.text))) continue;
    text = text.replace(alias.pattern, () => { applied.push(alias.canonical); return alias.canonical; });
  }
  if (!applied.length) return { cue, glossary };
  const canonical = [...new Set(applied)];
  // The user's explicit brand correction supersedes old spellings, not unrelated custom keep terms.
  const isAppliedAlias = (term: string) => PLATFORM_ALIASES.some(alias => canonical.includes(alias.canonical)
    && new RegExp(`^(?:${alias.pattern.source.replace(/^\\b|\\b$/g, '')})$`, 'i').test(term));
  return {
    cue: { ...cue, text },
    glossary: {
      ...glossary,
      no_translate_terms: [...canonical, ...glossary.no_translate_terms.filter(term => !isAppliedAlias(term))],
      term_map: glossary.term_map.filter(([term]) => !isAppliedAlias(term)),
    },
  };
}

interface ProtectedTermOccurrence { term: string; start: number; end: number }

/** A narrow word-sense exception, not a global removal from the user's keep list. */
function ordinaryCinematographyTerm(text: string, occurrence: ProtectedTermOccurrence): boolean {
  // An explicitly customized lowercase keep term or a longer phrase still wins.
  // Capitalized Hero, quoted labels, UI sections and unrelated names stay protected.
  if (occurrence.term !== 'Hero' || text.slice(occurrence.start, occurrence.end) !== 'hero') return false;
  const quoted = /`[^`\n]*`|"[^"\n]*"|「[^」]*」|『[^』]*』|“[^”]*”|‘[^’]*’|(?:^|[^A-Za-z0-9])'[^'\n]+'(?=$|[^A-Za-z0-9])/g;
  if ([...text.matchAll(quoted)].some(match => match.index <= occurrence.start && match.index + match[0].length >= occurrence.end)) return false;
  const after = text.slice(occurrence.end);
  const before = text.slice(0, occurrence.start);
  return /^[ \t-]+(?:angles?|shots?)\b/.test(after) || /\b(?:low|high)[ \t-]+angle[ \t-]+$/.test(before);
}

/** Lowercase react after an explicit speaking/experiencing subject is a verb.
 * React labels/framework names, quoted literals and an explicit lowercase keep
 * term remain names; do not remove React from the user's global glossary. */
function ordinaryReactVerb(text: string, occurrence: ProtectedTermOccurrence): boolean {
  if (occurrence.term !== 'React' || text.slice(occurrence.start, occurrence.end) !== 'react') return false;
  const quoted = /`[^`\n]*`|"[^"\n]*"|「[^」]*」|『[^』]*』|“[^”]*”|‘[^’]*’/g;
  if ([...text.matchAll(quoted)].some(match => match.index <= occurrence.start && match.index + match[0].length >= occurrence.end)) return false;
  return /\b(?:I|we|you|they|people|viewers|users|humans|the audience|our brains)\s+(?:(?:can|could|will|would|should|may|might|must|do not|don't|did not|didn't|actually|instinctively|naturally|always|sometimes|all)\s+)*$/i.test(text.slice(0, occurrence.start));
}

function matchingProtectedOccurrences(cue: WatchCue, glossary: Glossary): ProtectedTermOccurrence[] {
  const terms = [...new Set(glossary.no_translate_terms.filter(term => term && term.length <= 120))].slice(0, 500).sort((a, b) => b.length - a.length);
  if (!terms.length) return [];
  const canonical = new Map(terms.map(term => [term.toLowerCase(), term]));
  const pattern = new RegExp(`(^|[^A-Za-z0-9_])(${terms.map(escape).join('|')})(?=$|[^A-Za-z0-9_])`, 'gi');
  return [...cue.text.matchAll(pattern)].map(match => ({
    // Both React and react may be explicit user entries. Exact source spelling
    // wins for this homonym, irrespective of glossary order.
    term: /^(?:React|react)$/.test(match[2]) && terms.includes(match[2]) ? match[2] : canonical.get(match[2].toLowerCase())!,
    start: match.index + match[1].length,
    end: match.index + match[1].length + match[2].length,
  }));
}

/** Restrict cache invalidation to occurrences whose old React requirement changed. */
export function hasOrdinaryReactVerb(cue: WatchCue, glossary: Glossary): boolean {
  return matchingProtectedOccurrences(cue, glossary).some(occurrence => ordinaryReactVerb(cue.text, occurrence));
}

/** Longest non-overlapping source mentions, with explicit canonical case and occurrence positions. */
export function protectedTermOccurrences(cue: WatchCue, glossary: Glossary): ProtectedTermOccurrence[] {
  return matchingProtectedOccurrences(cue, glossary).filter(occurrence => !ordinaryCinematographyTerm(cue.text, occurrence) && !ordinaryReactVerb(cue.text, occurrence)).slice(0, 50);
}

/** Canonicalize only genuine protected occurrences, never ordinary homonyms elsewhere in the cue. */
export function canonicalProtectedText(cue: WatchCue, glossary: Glossary): string {
  let text = cue.text;
  for (const occurrence of protectedTermOccurrences(cue, glossary).reverse()) {
    text = text.slice(0, occurrence.start) + occurrence.term + text.slice(occurrence.end);
  }
  return text;
}

/** Longest, non-overlapping source matches; exact user spelling/case and repeated occurrences matter. */
export function requiredProtectedTerms(cue: WatchCue, glossary: Glossary): string[] {
  return protectedTermOccurrences(cue, glossary).map(occurrence => occurrence.term);
}

export function missingProtectedTerms(text: string, required: string[]): string[] {
  const missing: string[] = [];
  for (const term of new Set(required)) {
    const count = [...text.matchAll(new RegExp(`(^|[^A-Za-z0-9_])${escape(term)}(?=$|[^A-Za-z0-9_])`, 'g'))].length;
    const localizedBrand = term === 'OpenArt' ? /開放藝術|开放艺术/.test(text) : term === 'Higgsfield' && /希格斯(?:[場场](?:域)?|菲[爾尔]德)/.test(text);
    if (count !== required.filter(value => value === term).length || localizedBrand) missing.push(term);
  }
  return missing;
}


/** This is source classification before inference, never an English fallback.
 * Only explicit protected names plus an optional source speaker/time prefix
 * qualify. Ordinary words, unprotected numbers and arbitrary Title Case do not. */
export function protectedNamesOnlyText(cue: WatchCue, glossary: Glossary): string | null {
  const text = canonicalProtectedText(cue, glossary).trim();
  if (!text || /[\r\n]/.test(text)) return null;
  // Caption speaker labels use their own observed timestamp. Do not interpret
  // unrelated parenthesized numbers or labels far from this cue as metadata.
  const metadata = /^([A-Z][A-Za-z'’.-]+(?: [A-Z][A-Za-z'’.-]+){1,3})[ \t]+\((\d{1,2}:\d{2}(?::\d{2})?)\)[ \t]*/.exec(text);
  let offset = 0;
  if (metadata) {
    const parts = metadata[2].split(':').map(Number);
    const validClock = parts.at(-1)! < 60 && (parts.length === 2 || parts[1] < 60);
    const seconds = parts.reduce((sum, part) => sum * 60 + part, 0);
    if (!validClock || !Number.isFinite(cue.start) || Math.abs(seconds - cue.start) > 3) return null;
    offset = metadata[0].length;
  }
  const body = text.slice(offset);
  // A cue that is nothing but its own speaker label needs no language generation.
  if (metadata && !body.trim()) return text;
  const occurrences = protectedTermOccurrences({ ...cue, text: body }, glossary);
  if (!occurrences.length) return null;
  let remaining = body;
  for (const occurrence of [...occurrences].reverse()) remaining = remaining.slice(0, occurrence.start) + ' ' + remaining.slice(occurrence.end);
  // A name-only list may have punctuation, never an unprotected word/number.
  if (!/^[ \t.,!?;:，。！？；：、()\[\]{}（）【】「」『』“”‘’'"`–—-]*$/.test(remaining)) return null;
  if (missingProtectedTerms(body, occurrences.map(occurrence => occurrence.term)).length) return null;
  return text;
}
