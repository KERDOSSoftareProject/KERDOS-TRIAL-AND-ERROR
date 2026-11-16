// A repeated gap before a new description can separate independent offers on
// the same baseline. Require a price on both sides on several source lines.
const priceToken = /^(?:\p{Sc}\s*\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*\.\d{2})(?=\s|$)/u;
const startsDescription = text => /^\p{L}/u.test(text);

export function parallelOfferBoundaries(rows) {
  const candidates = [];
  for (const words of rows) {
    const firstPrice = words.findIndex(word => priceToken.test(word.text));
    const lastPrice = words.findLastIndex(word => priceToken.test(word.text));
    if (firstPrice < 1 || lastPrice <= firstPrice || !words.slice(0, firstPrice).some(word => startsDescription(word.text))) continue;
    for (let i = firstPrice + 1; i < lastPrice; i++) {
      const word = words[i];
      if (!startsDescription(word.text)) continue;
      const leftEdge = words[i - 1].x + words[i - 1].width;
      const tolerance = Math.max(2, word.height * .25);
      if (word.x - leftEdge < word.height * .85) continue;
      let group = candidates.find(candidate => Math.abs(candidate.x - word.x) <= tolerance);
      if (!group) {
        group = {x:word.x, observations:new Map()};
        candidates.push(group);
      }
      if (!group.observations.has(words)) group.observations.set(words, {x:word.x, leftEdge, text:word.text.toLowerCase()});
    }
  }
  return candidates.flatMap(({observations}) => {
    const evidence = [...observations.values()];
    if (evidence.length < 3 || new Set(evidence.map(row => row.text)).size < 3) return [];
    const left = Math.max(...evidence.map(row => row.leftEdge));
    const right = Math.min(...evidence.map(row => row.x));
    return right > left ? [(left + right) / 2] : [];
  }).sort((a,b) => a-b);
}

export function splitOfferLine(words, boundaries) {
  const lanes = Array.from({length:boundaries.length+1}, () => []);
  for (const word of words) {
    const next = boundaries.findIndex(boundary => word.x < boundary);
    lanes[next < 0 ? lanes.length-1 : next].push(word);
  }
  return lanes;
}
