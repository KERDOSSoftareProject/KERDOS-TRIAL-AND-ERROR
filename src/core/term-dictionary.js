// Data-driven phrase interpretation. No industry, vendor, or client rules here.
export function dictionaryTokens(value) {
  return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
}

export function compileDictionary(groups) {
  const byFirst = new Map();
  for (const [group, entries] of Object.entries(groups)) {
    for (const entry of entries) {
      for (const spelling of new Set([entry.term, ...(entry.aliases || [])])) {
        const tokens = dictionaryTokens(spelling);
        if (!tokens.length) continue;
        const choices = byFirst.get(tokens[0]) || [];
        choices.push({entry, group, spelling, tokens});
        byFirst.set(tokens[0], choices);
      }
    }
  }
  for (const choices of byFirst.values()) choices.sort((a,b) => b.tokens.length-a.tokens.length);
  return function interpret(value) {
    const tokens = dictionaryTokens(value), output = [], evidence = [], unresolved = [];
    const padded = ` ${tokens.join(" ")} `;
    for (let index=0; index<tokens.length;) {
      const match = (byFirst.get(tokens[index]) || []).find(candidate =>
        candidate.tokens.every((token,offset) => token===tokens[index+offset]));
      if (!match) { output.push(tokens[index++]); continue; }
      const {entry, group} = match;
      const original = tokens.slice(index,index+match.tokens.length).join(" ");
      const canonical = dictionaryTokens(entry.term).join(" ");
      const contextKnown = !entry.context || entry.context.some(cue => padded.includes(` ${dictionaryTokens(cue).join(" ")} `));
      const blocked = entry.kind==="ambiguous" || (entry.kind==="product" && original!==canonical && !contextKnown);
      const automatic = entry.kind==="product" && !blocked;
      output.push(...(automatic ? dictionaryTokens(entry.term) : tokens.slice(index,index+match.tokens.length)));
      const detail = {group,term:entry.term,source:original,meaning:entry.meaning,kind:entry.kind,automatic};
      evidence.push(detail);
      if (blocked) unresolved.push(detail);
      index += match.tokens.length;
    }
    return {text:output.join(" "),evidence,unresolved,attributes:{}};
  };
}
