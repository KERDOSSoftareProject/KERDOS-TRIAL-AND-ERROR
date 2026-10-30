// Captured from actual PDF.js rendering + local Tesseract 7. This fixture has
// no customer data. Snapshot checks exercise production structure/parser logic;
// the separate real OCR command rechecks recognition, not just this capture.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseStructuredDocument} from '../src/core/document-structuring.js';
import {parseDocument} from '../src/ingestion.js';
const capture=JSON.parse(readFileSync('scripts/fixtures/b2/mixed-ocr-reading.json','utf8'));
const make=()=>structuredClone(capture);
const wordsOf=reading=>reading.pages[1].ocr.blocks.flatMap(block=>block.paragraphs.flatMap(paragraph=>paragraph.lines.flatMap(line=>line.words)));
let passed=0;
function check(name,run){run();passed++;console.log('PASS '+name);}
check('real OCR capture groups unequal-height header words and preserves exact code/pack/unit/price',()=>{
 const reading=make(),result=parseStructuredDocument(reading.text,reading);
 assert.deepEqual(result.rows.map(row=>[row.code,row.packSize,row.sellingUnit,row.price]),[['730001','20 LB','CASE',46.75],['730002','20LB','CASE',57.85]]);
 assert.deepEqual(result.rows.map(row=>row.sourceProvenance.page),[1,2]);
 assert.equal(result.rows[1].sourceProvenance.kind,'positioned');
 assert.equal(result.rows[1].billingUnitEvidence.header,'Price Unit');
 assert.equal(result.rows[1].billingUnitEvidence.unit,'CASE');
 assert.ok(result.rows[1].sourceProvenance.cells.every(cell=>cell.words.length));
});
check('uncertain OCR description/pack remains flagged rather than gaining confirmed eligibility',()=>{
 const result=parseStructuredDocument(capture.text,make()),row=result.rows[1];
 assert.equal(row.priceNeedsReview,true);assert.ok(row.issues.some(issue=>issue.kind==='low-confidence-ocr'));
 assert.equal(row.sourceProvenance.cells[1].words.find(word=>word.text==='BreastSm').confidence,35);
 assert.equal(row.sourceProvenance.cells[4].words[0].confidence,93);
 assert.ok(row.description.includes('BreastSm')); // Preserve what OCR actually read, not a fixture-specific correction.
});
check('different descenders on the product line cannot split the row or attach the code to price',()=>{
 const reading=make();
 for(const word of wordsOf(reading))if(word.text==='DeliS'||word.text==='tyke'){word.bbox.y0-=4;word.bbox.y1+=4;}
 const result=parseStructuredDocument(reading.text,reading);
 assert.deepEqual(result.rows.map(row=>row.price),[46.75,57.85]);assert.equal(result.rows[1].code,'730002');
});
check('close but nonoverlapping next product stays a separate row',()=>{
 const reading=make(),paragraph=reading.pages[1].ocr.blocks[0].paragraphs.find(paragraph=>paragraph.lines.some(line=>line.words.some(word=>word.text==='730002')));
 const line=paragraph.lines.find(line=>line.words.some(word=>word.text==='730002')),next=structuredClone(line);
 for(const word of next.words){word.bbox.y0+=50;word.bbox.y1+=50;if(word.text==='730002')word.text='730003';if(word.text==='57.85')word.text='60.25';}
 paragraph.lines.push(next);
 const result=parseStructuredDocument(reading.text,reading);
 assert.deepEqual(result.rows.map(row=>[row.code,row.price]),[['730001',46.75],['730002',57.85],['730003',60.25]]);
});
check('replay is deterministic and retained OCR coordinates are never rewritten',()=>{
 const reading=make(),before=JSON.stringify(reading);
 assert.deepEqual(parseStructuredDocument(reading.text,reading),parseStructuredDocument(reading.text,reading));
 assert.equal(JSON.stringify(reading),before);
});
check('freeform fallback never turns the tail of a long item code into a monetary price',()=>{
 const result=parseDocument(capture.pages[1].text);
 assert.equal(result.rows.length,1);assert.equal(result.rows[0].price,57.85);
 assert.ok(!result.rows.some(row=>row.price===2));
});
console.log(`${passed}/${passed} B2 OCR geometry checks passed (captured real OCR, local parser evidence).`);
