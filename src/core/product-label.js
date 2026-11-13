import {dictionaryTokens} from './term-dictionary.js';

const vowels = /[aeiou]/g;
const consonants = word => word.replace(vowels, '');
const unique = values => [...new Set(values)];
const phrase = value => dictionaryTokens(value).join(' ');

function singular(word) {
  if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.length > 4 && /(?:oes|xes|zes|ches|shes)$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !/(?:ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

function isVowelShortening(short, full) {
  if (short.length >= full.length || consonants(short) !== consonants(full)) return false;
  let offset = 0;
  for (const letter of full) if (letter === short[offset]) offset++;
  return offset === short.length;
}

function indexRules(entries) {
  const indexed = new Map();
  for (const entry of entries) {
    for (const spelling of unique([entry.label, ...entry.terms])) {
      const words = dictionaryTokens(spelling);
      if (!words.length) continue;
      const key = singular(words[0]);
      const candidates = indexed.get(key) || [];
      candidates.push({entry, words});
      indexed.set(key, candidates);
    }
  }
  return indexed;
}

function findSpans(words, index) {
  return words.flatMap((word, start) => (index.get(singular(word)) || [])
    .filter(rule => rule.words.every((expected, offset) =>
      words[start + offset] && singular(expected) === singular(words[start + offset])))
    .map(rule => ({...rule, start, end: start + rule.words.length})));
}

const spansOverlap = (a, b) => a.start < b.end && b.start < a.end;
const isWithin = (inner, outer) => inner.start >= outer.start && inner.end <= outer.end;

function keepMostSpecific(matches) {
  return matches.filter(match => !matches.some(other =>
    other !== match && (other.entry.broader?.has(match.entry.key)
      || (other.words.length > match.words.length && isWithin(match, other)))));
}

function identifyConcepts(index, ...representations) {
  const matches = representations.flatMap(words => keepMostSpecific(findSpans(words, index)));
  return matches.filter(match => !matches.some(other => other.entry.broader.has(match.entry.key)));
}

function informationalPositions(words, modifierIndex, conceptIndex) {
  const products = findSpans(words, conceptIndex).filter(match => match.words.length > 1);
  return new Set(findSpans(words, modifierIndex).filter(match =>
    match.entry.role === 'informational' && !match.entry.concepts.size
    && !products.some(product => spansOverlap(match, product)))
    .flatMap(span => words.slice(span.start, span.end).map((_, offset) => span.start + offset)));
}

function indexAliases(groups, vocabulary) {
  const indexed = new Map();
  const add = (spelling, target, cues = []) => {
    const key = phrase(spelling);
    const canonical = phrase(target);
    if (!key || !canonical || key === canonical) return;
    const candidates = indexed.get(key) || new Map();
    const current = candidates.get(canonical);
    const next = cues.map(cue => dictionaryTokens(cue));
    candidates.set(canonical, current && (!current.length || !next.length) ? [] : [...(current || []), ...next]);
    indexed.set(key, candidates);
  };
  const ambiguous = new Set();
  const productWords = new Set();
  for (const entry of Object.values(groups || {}).flat()) {
    if (entry.kind === 'ambiguous') ambiguous.add(phrase(entry.term));
    if (entry.kind !== 'product') continue;
    const canonical = phrase(entry.term);
    if (!canonical.includes(' ')) productWords.add(canonical);
    for (const spelling of entry.aliases || []) add(spelling, canonical, entry.context);
  }
  for (const row of vocabulary || []) {
    if (row.kind === 'synonym') add(row.term, row.canonical);
  }
  return {indexed, ambiguous, productWords};
}

function expand(words, aliases, standalone, known) {
  const isKnown = word => known.has(word) || known.has(singular(word));
  function candidatesFor(word) {
    const exact = word.length >= 3 ? standalone.filter(full => consonants(full) === word && word !== full) : [];
    let candidates = exact.length ? new Map(exact.map(value => [value, []])) : null;
    if (!candidates && !aliases.ambiguous.has(word)) {
      candidates = new Map(aliases.indexed.get(word) || []);
      if (word.length >= 3 && (!isKnown(word) || candidates.size)) {
        for (const full of standalone) {
          if (full !== word && (full.startsWith(word) || isVowelShortening(word, full)) && !candidates.has(full)) {
            candidates.set(full, []);
          }
        }
      }
    }
    return {candidates, method: exact.length ? 'vowels removed' : 'shorthand'};
  }

  const oneWord = word => {
    if (isKnown(word)) return null;
    return candidatesFor(word);
  };
  const units = [];
  for (let start = 0; start < words.length;) {
    const multi = aliases.phrases.get(words[start])?.find(rule =>
      rule.words.every((word, offset) => word === words[start + offset]));
    if (multi) {
      units.push({spelling: multi.spelling, method: 'dictionary phrase', candidates: aliases.indexed.get(multi.spelling)});
      start += multi.words.length;
    } else {
      const spelling = words[start++];
      units.push({spelling, ...oneWord(spelling)});
    }
  }
  const cueWords = units.flatMap(unit => {
    if (unit.candidates?.size !== 1) return dictionaryTokens(unit.spelling);
    const [[target, cues]] = unit.candidates;
    return cues.length ? [] : dictionaryTokens(target);
  });
  const hasCue = cue => cueWords.some((word, start) =>
    cue.every((value, offset) => singular(value) === singular(cueWords[start + offset] || '')));
  const evidence = [];
  const expanded = [];
  for (const {spelling, candidates, method} of units) {
    if (candidates?.size === 1) {
      const [[target, cues]] = candidates;
      if (!cues.length || cues.some(hasCue)) {
        evidence.push({spelling, result: target, method});
        expanded.push(...dictionaryTokens(target));
        continue;
      }
    }
    if (candidates?.size || aliases.ambiguous.has(spelling)) {
      evidence.push({spelling, result: null, candidates: [...(candidates?.keys() || [])].sort(), method});
    }
    expanded.push(...dictionaryTokens(spelling));
  }
  return {words: expanded, evidence};
}

function packPattern(unitWords) {
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const units = [...unitWords].sort((a, b) => b.length - a.length).map(escape).join('|');
  if (!units) return null;
  const amount = '(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
  const quantities = `(?:${amount}\\s*[/x×–-]\\s*)*${amount}`;
  return new RegExp(`\\b${quantities}\\s*[-–]?\\s*(?:${units})\\b|\\b${quantities}\\s*["″]`, 'gi');
}

const title = value => value.replace(/\b[a-z]/g, character => character.toUpperCase());
const review = (reason, evidence = []) => ({status: 'review', key: null, label: null, reason, evidence});

export function createProductLabelReader({profile = {}, dictionaries, vocabulary, unitWords = []} = {}) {
  const concepts = (profile.concepts || []).map(entry => ({
    ...entry,
    key: phrase(entry.label),
    terms: entry.terms || [],
    broader: new Set((entry.broader || []).map(phrase)),
  }));
  const modifiers = (profile.modifiers || []).map(entry => ({
    ...entry,
    key: phrase(entry.label),
    terms: entry.terms || [],
    concepts: new Set((entry.concepts || []).map(phrase)),
  }));
  const conceptIndex = indexRules(concepts);
  const modifierIndex = indexRules(modifiers);
  const knownBrands = (profile.brandTerms || []).map(label => ({label, terms: []}));
  const brandIndex = indexRules(knownBrands);
  const origins = new Set((profile.origins || []).map(phrase));
  const fragments = new Set((profile.fragments || []).map(phrase));
  const uncertainty = indexRules((profile.uncertainPhrases || []).map(entry => ({...entry, label: ''})));
  const aliases = indexAliases(dictionaries, vocabulary);
  aliases.phrases = new Map();
  for (const spelling of aliases.indexed.keys()) {
    const words = dictionaryTokens(spelling);
    if (words.length < 2) continue;
    const entries = aliases.phrases.get(words[0]) || [];
    entries.push({words, spelling});
    entries.sort((a, b) => b.words.length - a.words.length);
    aliases.phrases.set(words[0], entries);
  }
  const standalone = unique([...aliases.productWords, ...(profile.standalone || []).map(phrase),
    ...concepts.map(entry => entry.key), ...modifiers.map(entry => entry.key)])
    .filter(word => /^[a-z]+$/.test(word)).sort();
  const known = new Set([...standalone, ...(profile.knownWords || []).flatMap(dictionaryTokens),
    ...concepts.flatMap(entry => dictionaryTokens(entry.label)), ...modifiers.flatMap(entry => dictionaryTokens(entry.label))]);
  for (const modifier of modifiers) {
    for (const value of modifier.terms) {
      const words = dictionaryTokens(value);
      if (words.length === 1) known.add(words[0]);
    }
  }
  for (const word of [...known]) known.add(singular(word));
  const packs = packPattern(unitWords);

  return function readProductLabel({description, brand, packSize, pack_size: storedPack} = {}) {
    const input = String(description || '').replace(/\(([^()]*)\)/g, (span, content) =>
      origins.has(phrase(content)) ? ' ' : span);
    const source = dictionaryTokens(packs ? input.replace(packs, ' ') : input);
    const stated = [brand, packSize || storedPack].filter(Boolean).map(label => ({label, terms: []}));
    const protectedSpans = [...findSpans(source, conceptIndex), ...findSpans(source, modifierIndex)];
    const sourceDetails = findSpans(source, indexRules(stated))
      .filter(span => !protectedSpans.some(knownSpan => spansOverlap(span, knownSpan)));
    const skipped = new Set([...findSpans(source, brandIndex), ...sourceDetails]
      .flatMap(span => source.slice(span.start, span.end).map((_, offset) => span.start + offset)));
    const words = source.map((word, index) => skipped.has(index) ? '' : word);
    const uncertain = findSpans(words, uncertainty)[0];
    if (uncertain) return review(uncertain.entry.reason);
    const expanded = expand(words, aliases, standalone, known);
    if (expanded.evidence.some(entry => entry.result === null)) {
      return review('Vendor shorthand has more than one reading or needs context', expanded.evidence);
    }

    // Preserve exact source phrases and also recognize phrases formed by expansion.
    const details = informationalPositions(expanded.words, modifierIndex, conceptIndex);
    const identityWords = expanded.words.filter((word, index) => !details.has(index));
    const matches = identifyConcepts(conceptIndex, words, expanded.words, identityWords);
    const keys = unique(matches.map(match => match.entry.key));
    if (keys.length > 1) return review('Description identifies more than one product', expanded.evidence);
    const base = matches[0]?.entry;
    const rawModifiers = findSpans(words, modifierIndex);
    const resolvedModifiers = findSpans(expanded.words, modifierIndex);
    const eligible = [...rawModifiers, ...resolvedModifiers]
      .filter(match => !match.entry.concepts.size || match.entry.concepts.has(base?.key));
    const marks = [...new Map(eligible.map(match => [match.entry.key, match.entry])).values()];
    const defining = marks.filter(mark => mark.role === 'defining');
    const exclusive = defining.filter(mark => mark.exclusive).map(mark => mark.exclusive);
    if (new Set(exclusive).size < exclusive.length) {
      return review('Description has conflicting product forms', expanded.evidence);
    }
    if (base) {
      const variants = defining.sort((a, b) => a.key.localeCompare(b.key));
      return {
        status: 'recognized',
        key: ['product:' + base.key, ...variants.map(mark => mark.key)].join('|'),
        label: [title(base.label.toLowerCase()), ...variants.map(mark => title(mark.label.toLowerCase()))].join(' · '),
        reason: null,
        evidence: expanded.evidence,
      };
    }
    if (profile.requiredBaseWords && expanded.words.some(word => profile.requiredBaseWords.includes(singular(word)))) {
      return review('Product form is stated but the base product is unclear', expanded.evidence);
    }

    const remaining = identityWords.filter(word => word && !fragments.has(word));
    const key = unique(remaining.map(singular)).sort().join(' ');
    if (!/[a-z]{2}/.test(key)) return review('No identifiable product description', expanded.evidence);
    return {status: 'literal', key: 'literal:' + key, label: title(remaining.join(' ')), reason: null, evidence: expanded.evidence};
  };
}
