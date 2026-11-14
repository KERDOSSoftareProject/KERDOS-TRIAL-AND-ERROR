import {dictionaryTokens} from './term-dictionary.js';

const vowels = /[aeiou]/g;
const consonants = word => word.replace(vowels, '');
const unique = values => [...new Set(values)];
const phrase = value => dictionaryTokens(value).join(' ');
const statedLevels = /\b\d+(?:\.\d+)?\s*%|\b(?:grade|level)\s+(?:[a-z]{1,2}|\d+(?:\.\d+)?[a-z]?)\b[+-]?|\b(?:premium|standard)\s+grade\b/gi;

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
    for (const spelling of unique([...(entry.includeLabel === false ? [] : [entry.label]), ...entry.terms])) {
      const words = dictionaryTokens(spelling);
      if (!words.length) continue;
      const key = singular(words[0]);
      const candidates = indexed.get(key) || [];
      candidates.push({entry, words});
      indexed.set(key, candidates);
    }
  }
  for (const rules of indexed.values()) rules.sort((a,b) => b.words.length-a.words.length);
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
  const longest = matches.filter(match => !matches.some(other =>
    other.words.length > match.words.length && isWithin(match,other)));
  return longest.filter(match => !longest.some(other => other !== match && (
    (other.words.length === match.words.length && isWithin(match,other)
      && other.entry.authoritative && !match.entry.authoritative)
    || (other.entry.key !== match.entry.key && other.entry.broader.has(match.entry.key)))));
}

function identifyConcepts(words, index, modifierIndex) {
  const forms = findSpans(words, modifierIndex).filter(span =>
    span.entry.role === 'defining' && span.words.length > 1 && !span.entry.concepts.size);
  return keepMostSpecific(findSpans(words, index).filter(product =>
    !forms.some(form => form.words.length > product.words.length && isWithin(product,form))));
}

function informationalPositions(words, modifierIndex, products, concept, undecided) {
  const productPhrases = products.filter(match => match.words.length > 1);
  const modifiers = findSpans(words, modifierIndex).filter(match =>
    !match.entry.concepts.size || match.entry.concepts.has(concept));
  const pending = findSpans(words, undecided);
  const information = modifiers.filter(match => match.entry.role !== 'defining'
    && (match.entry.role === 'level' || !modifiers.some(form =>
      form.entry.role === 'defining' && spansOverlap(match, form) && form.words.length >= match.words.length)));
  return new Set([...pending, ...information]
    .filter(match => !productPhrases.some(product => spansOverlap(match, product)))
    .flatMap(span => words.slice(span.start, span.end).map((_, offset) => span.start + offset)));
}

function definingModifiers(words, index, concept, products) {
  const eligible = findSpans(words, index)
    .filter(match => !match.entry.concepts.size || match.entry.concepts.has(concept));
  return eligible.filter(match => match.entry.role === 'defining'
    && !products.some(product => product.words.length > 1 && isWithin(match, product)
      && !product.entry.definingOutsideName.has(match.entry.key))
    && !eligible.some(other => other.entry.role === 'defining'
      && other.words.length > match.words.length && isWithin(match, other))).map(match => match.entry);
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

function expand(words, aliases, standalone, known, shorthand, conceptIndex, undecided) {
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

  const matchingRule = (word, start) => shorthand.get(word)?.find(rule =>
    rule.words.every((value, offset) => value === words[start + offset]));
  const oneWord = word => {
    if (isKnown(word)) return null;
    return candidatesFor(word);
  };
  const units = [];
  for (let start = 0; start < words.length;) {
    const matches = rule => rule.words.every((word, offset) => word === words[start + offset]);
    const explicit = matchingRule(words[start], start);
    if (explicit) {
      units.push({...explicit,method:'profile shorthand'});
      start += explicit.words.length;
      continue;
    }
    const pending = undecided.get(singular(words[start]))?.find(rule =>
      rule.words.every((word, offset) => singular(word) === singular(words[start + offset] || '')));
    if (pending) {
      units.push({spelling:words.slice(start, start + pending.words.length).join(' ')});
      start += pending.words.length;
      continue;
    }
    const product = conceptIndex.get(singular(words[start]))?.find(rule => rule.words.length > 1
      && rule.words.every((word, offset) => singular(word) === singular(words[start + offset] || '')
        && !matchingRule(words[start + offset],start+offset)?.needsContext));
    if (product) {
      units.push({spelling:words.slice(start,start+product.words.length).join(' ')});
      start += product.words.length;
      continue;
    }
    const multi = aliases.phrases.get(words[start])?.find(rule => matches(rule) &&
      !rule.words.some((word, offset) => matchingRule(word, start + offset)?.needsContext));
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
  const contextualWords = units.map(unit =>
    dictionaryTokens(unit.meanings && !unit.needsContext ? unit.meanings[0] : unit.spelling));
  const evidence = [];
  const ambiguousSpans = [];
  const expanded = [];
  for (const [unitIndex, {spelling, candidates, method, meanings, needsContext, cues}] of units.entries()) {
    if (meanings) {
      const before = needsContext ? contextualWords.slice(0,unitIndex).flat() : [];
      const after = needsContext ? contextualWords.slice(unitIndex+1).flat() : [];
      const hasPhrase = targetWords => [before,after].some(side => side.some((word,index) =>
        word && targetWords.every((value,offset) => singular(value) === singular(side[index+offset] || ''))));
      const supported = needsContext ? meanings.filter(target => {
        if (cues) return (cues.get(target) || []).some(hasPhrase);
        const targetWords = dictionaryTokens(target);
        const substituted = [...before,...targetWords,...after];
        const completesProduct = findSpans(substituted, conceptIndex).some(span =>
          span.start <= before.length && span.end >= before.length + targetWords.length && span.words.length > targetWords.length);
        return hasPhrase(targetWords) || completesProduct;
      }) : meanings;
      const candidatesForReview = supported.length > 1 ? supported : meanings;
      const result = supported.length === 1 ? supported[0] : null;
      const entry = {spelling,result,method,...(!result ? {candidates:candidatesForReview} : {})};
      evidence.push(entry);
      if (!result) ambiguousSpans.push({entry,start:expanded.length,length:dictionaryTokens(spelling).length});
      expanded.push(...dictionaryTokens(result ?? spelling));
      continue;
    }
    if (candidates?.size === 1) {
      const [[target, cues]] = candidates;
      if (!cues.length || cues.some(hasCue)) {
        evidence.push({spelling, result: target, method});
        expanded.push(...dictionaryTokens(target));
        continue;
      }
    }
    if (candidates?.size || aliases.ambiguous.has(spelling)) {
      const entry = {spelling, result: null, candidates: [...(candidates?.keys() || [])].sort(), method};
      evidence.push(entry);
      ambiguousSpans.push({entry,start:expanded.length,length:dictionaryTokens(spelling).length});
    }
    expanded.push(...dictionaryTokens(spelling));
  }
  return {words: expanded, evidence, ambiguousSpans};
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
    label: entry.levelOf || entry.label,
    authoritative: entry.authoritative,
    key: phrase(entry.levelOf || entry.label),
    terms: [entry.label, ...(entry.terms || [])],
    broader: new Set((entry.broader || []).map(phrase)),
    definingOutsideName: new Set((entry.definingOutsideName || []).map(phrase)),
  }));
  const modifiers = (profile.modifiers || []).map(entry => ({
    ...entry,
    key: phrase(entry.label),
    terms: entry.terms || [],
    concepts: new Set((entry.concepts || []).map(phrase)),
  }));
  const conceptIndex = indexRules(concepts);
  const modifierIndex = indexRules([
    ...modifiers,
    {label: 'whole', terms: [], role: 'informational', concepts: new Set()},
  ]);
  const undecided = indexRules((profile.undecidedTerms || []).map(label => ({label,terms:[]})));
  const shorthand = new Map();
  for (const entry of profile.shorthand || []) {
    const words = dictionaryTokens(entry.shorthand);
    if (!words.length) continue;
    const spelling = words.join(' ');
    const meanings = unique(entry.meanings.map(phrase));
    if (!entry.needs_context && [spelling, ...meanings].some(value => {
      const tokens = dictionaryTokens(value);
      return findSpans(tokens, undecided).some(span => span.words.length === tokens.length);
    })) continue;
    const rules = shorthand.get(words[0]) || [];
    rules.push({words,spelling,meanings,needsContext:entry.needs_context,
      cues:entry.cues && new Map(Object.entries(entry.cues).map(([meaning,words]) =>
        [phrase(meaning),words.map(dictionaryTokens).filter(tokens => tokens.length)]))});
    rules.sort((a,b) => b.words.length - a.words.length);
    shorthand.set(words[0], rules);
  }
  const knownBrands = (profile.brandTerms || []).map(label => {
    const words = dictionaryTokens(label);
    const terms = words.at(-1) === 's' ? [words.slice(0,-1).join(' ')] : [];
    return {label,terms};
  });
  const brandIndex = indexRules(knownBrands);
  const origins = new Set((profile.origins || []).map(phrase));
  const fragments = new Set((profile.fragments || []).map(phrase));
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
    ...concepts.filter(entry => !entry.authoritative).map(entry => entry.key),
    ...modifiers.filter(entry => !entry.authoritative).map(entry => entry.key)])
    .filter(word => /^[a-z]+$/.test(word)).sort();
  const known = new Set(['whole', ...standalone, ...(profile.knownWords || []).flatMap(dictionaryTokens),
    ...concepts.flatMap(entry => dictionaryTokens(entry.label)), ...modifiers.flatMap(entry => dictionaryTokens(entry.label))]);
  for (const modifier of modifiers) {
    for (const value of modifier.terms) {
      const words = dictionaryTokens(value);
      if (words.length === 1) known.add(words[0]);
    }
  }
  for (const word of [...known]) known.add(singular(word));
  const packs = packPattern(unitWords);

  function interpret(words,evidence) {
    // Match the expanded line once so a shorter source spelling cannot compete
    // with a complete product phrase made visible by shorthand expansion.
    const products = identifyConcepts(words, conceptIndex, modifierIndex);
    const details = informationalPositions(words, modifierIndex, products, products[0]?.entry.key, undecided);
    const identityWords = words.filter((word, index) => word && !details.has(index));
    const comparisonText = identityWords.join(' ');
    const matches = identifyConcepts(identityWords, conceptIndex, modifierIndex);
    const keys = unique(matches.map(match => match.entry.key));
    const base = matches[0]?.entry;
    const defining = [...new Map(definingModifiers(identityWords, modifierIndex, base?.key, matches)
      .map(mark => [mark.key, mark])).values()];
    const variants = defining.sort((a, b) => a.key.localeCompare(b.key));
    const formKey = variants.map(mark => mark.key).join('|');
    const exclusive = defining.filter(mark => mark.exclusive).map(mark => mark.exclusive);
    const conflictingForms = new Set(exclusive).size < exclusive.length;
    const forReview = reason => ({...review(reason, evidence), comparisonText,
      ...(formKey ? {formKey} : {}), ...(conflictingForms ? {conflictingForms:true} : {})});
    if (keys.length > 1) return forReview('Description identifies more than one product');
    if (conflictingForms) return forReview('Description has conflicting product forms');
    if (base) {
      return {
        status: 'recognized',
        key: ['product:' + base.key, ...variants.map(mark => mark.key)].join('|'),
        label: [title(base.label.toLowerCase()), ...variants.map(mark => title(mark.label.toLowerCase()))].join(' · '),
        reason: null,
        evidence,
        comparisonText,
        ...(formKey ? {formKey} : {}),
      };
    }
    if (profile.requiredBaseWords && words.some(word => profile.requiredBaseWords.includes(singular(word)))) {
      return forReview('Product form is stated but the base product is unclear');
    }

    const remaining = identityWords.filter(word => word && !fragments.has(word));
    const key = unique(remaining.map(singular)).sort().join(' ');
    if (!/[a-z]{2}/.test(key)) return forReview('No identifiable product description');
    return {status: 'literal', key: 'literal:' + key, label: title(remaining.join(' ')), reason: null,
      evidence,comparisonText,...(formKey ? {formKey} : {})};
  }

  return function readProductLabel({description, brand, packSize, pack_size: storedPack} = {}) {
    const input = String(description || '').replace(statedLevels, ' ').replace(/\(([^()]*)\)/g, (span, content) =>
      origins.has(phrase(content)) ? ' ' : span);
    const source = dictionaryTokens(packs ? input.replace(packs, ' ') : input);
    const stated = [brand, packSize || storedPack].filter(Boolean).map(label => ({label, terms: []}));
    const protectedSpans = [...findSpans(source, conceptIndex), ...findSpans(source, modifierIndex)];
    const sourceDetails = findSpans(source, indexRules(stated)).filter(span =>
      !protectedSpans.some(knownSpan => spansOverlap(span, knownSpan))
      && !source.slice(span.start,span.end).some(word => shorthand.get(word)?.some(rule => rule.needsContext)));
    const productBrandAliases = protectedSpans.filter(span => span.entry.authoritative);
    const brands = findSpans(source, brandIndex).filter(span =>
      !productBrandAliases.some(product => isWithin(span,product)));
    const skipped = new Set([...brands, ...sourceDetails]
      .flatMap(span => source.slice(span.start, span.end).map((_, offset) => span.start + offset)));
    const words = source.map((word, index) => skipped.has(index) ? '' : word);
    const expanded = expand(words, aliases, standalone, known, shorthand, conceptIndex, undecided);
    const original = interpret(expanded.words,expanded.evidence);
    if (!expanded.ambiguousSpans.length) return original;

    // Only admit an unresolved shorthand when every plausible reading has
    // the same identity. A common review outcome never establishes identity.
    const combinations = expanded.ambiguousSpans.reduce((count,{entry}) => count*entry.candidates.length,1);
    let agreed;
    if (combinations > 0 && combinations <= 256) {
      let consistent = true;
      function compareReadings(index,offset,words) {
        if (!consistent) return;
        const span = expanded.ambiguousSpans[index];
        if (!span) {
          const reading = interpret(words,expanded.evidence);
          consistent = Boolean(reading.key) && (!agreed || agreed.key === reading.key);
          agreed ??= reading;
          return;
        }
        for (const meaning of span.entry.candidates) {
          const replacement = dictionaryTokens(meaning);
          const start = span.start + offset;
          const next = [...words.slice(0,start),...replacement,...words.slice(start+span.length)];
          compareReadings(index+1,offset+replacement.length-span.length,next);
          if (!consistent) break;
        }
      }
      compareReadings(0,0,expanded.words);
      if (consistent) return original.key === agreed.key ? original : agreed;
    }
    const candidates = expanded.ambiguousSpans.filter(({entry}) => entry.candidates.length).map(({entry}) =>
      `${entry.spelling.toUpperCase()} could mean ${entry.candidates.join(' or ')}`);
    const reason = ['Vendor shorthand has more than one reading or needs context',...candidates].join('. ');
    return {...original,...review(reason,expanded.evidence)};
  };
}
