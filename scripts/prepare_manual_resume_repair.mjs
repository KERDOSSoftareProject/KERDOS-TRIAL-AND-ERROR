// Read-only preparation. The output contains private source rows; keep it out of git.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {basename} from 'node:path';
import {createHash} from 'node:crypto';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {createDocumentReader} from '../src/core/document-reading.js';
import {parseStructuredDocument} from '../src/core/document-structuring.js';
import {createSourceRowSnapshot,verifyResumeRows} from '../src/core/import-resume.js';
const [filePath,baselinePath,outputPath]=process.argv.slice(2);
if(!outputPath)throw Error('Usage: node scripts/prepare_manual_resume_repair.mjs retained.pdf private-baseline.json private-repair.json');
const baseline=JSON.parse(readFileSync(baselinePath,'utf8')),doc=baseline.document,bytes=readFileSync(filePath);
assert.equal(doc.status,'processing');assert.equal(baseline.quote_count,0,'This preparation is limited to an interrupted unconfirmed-price import');
assert.ok(baseline.items.every(item=>item.unavailable===true));
const reader=createDocumentReader({loadPdf:data=>getDocument({data,useSystemFonts:true}).promise});
const reading=await reader({name:doc.file_name||basename(filePath),arrayBuffer:async()=>Uint8Array.from(bytes).buffer});
assert.equal(reading.text,doc.original_text,'Retained original text differs');
assert.equal(createHash('sha256').update(reading.text).digest('hex'),doc.fingerprint,'Source fingerprint differs');
const parsed=parseStructuredDocument(reading.text,reading),snapshot=createSourceRowSnapshot(parsed.rows);
for(const item of baseline.items){
 assert.equal(item.source,doc.id);const match=String(item.key).match(/^row:(\d+)$/);assert.ok(match,'Unknown saved key');
 const proof=createSourceRowSnapshot([item.row]).rows[0];proof.key=item.key;
 assert.deepEqual(proof,snapshot.rows[Number(match[1])],'A surviving row differs from the retained original');
}
verifyResumeRows(parsed.rows,doc.completed_keys,baseline.items.map(item=>({key:item.key,sourceLine:item.row.sourceLine})),snapshot);
const savedKeys=new Set(baseline.items.map(item=>item.key));
const output={projectId:'gwtnaudjfoxjermhvhpx',documentId:doc.id,organizationId:doc.organization_id,vendorId:doc.vendor_id,expectedFingerprint:doc.fingerprint,expectedStatus:doc.status,expectedCompletedKeys:doc.completed_keys,sourceRows:snapshot,originalObjectPath:doc.file_path,
 summary:{sourceRows:parsed.rows.length,completedKeys:doc.completed_keys.length,survivingListingsVerified:baseline.items.length,completedKeysWithoutCurrentListing:doc.completed_keys.filter(key=>!savedKeys.has(key)).length,quoteCount:baseline.quote_count,fileSha256:createHash('sha256').update(bytes).digest('hex')},
 instructions:'DRAFT only. Apply the reviewed source_rows migration first. Re-read live document guards before a one-document NULL-to-snapshot update. Preserve status/completed_keys/listings/quotes/original; do not finalize or import anything in this repair.'};
writeFileSync(outputPath,JSON.stringify(output,null,2));console.log(JSON.stringify(output.summary));
