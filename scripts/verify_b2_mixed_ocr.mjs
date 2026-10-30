// Real local PDF.js render -> Tesseract -> production reader/structurer.
// This does not invoke KERDOS, a hosted worker or a database.
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createCanvas} from '@napi-rs/canvas';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {createWorker} from 'tesseract.js';
import {createDocumentReader} from '../src/core/document-reading.js';
import {parseStructuredDocument} from '../src/core/document-structuring.js';

const cache=mkdtempSync(join(tmpdir(),'kerdos-b2-ocr-'));
let worker,calls=0;
try{
  const reading=await createDocumentReader({
    loadPdf:data=>getDocument({data,useSystemFonts:true}).promise,
    recognizePage:async page=>{
      calls++;
      worker=await createWorker('eng',1,{langPath:resolve('public/ocr'),cachePath:cache});
      const viewport=page.getViewport({scale:2});
      const canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
      await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
      const {data}=await worker.recognize(canvas.toBuffer('image/png'),{},{text:true,blocks:true});
      return {...data,coordinateScale:2};
    },
  })({name:'B2_Mixed_Scanned_Prices_Test.pdf',arrayBuffer:async()=>Uint8Array.from(readFileSync('scripts/fixtures/b2/mixed-native-scanned.pdf')).buffer});
  const result=parseStructuredDocument(reading.text,reading);
  assert.equal(calls,1);
  assert.deepEqual(reading.pages.map(page=>page.source),['embedded-text','local-ocr']);
  assert.deepEqual(result.rows.map(row=>[row.code,row.packSize,row.sellingUnit,row.price]),[
    ['730001','20 LB','CASE',46.75],['730002','20LB','CASE',57.85],
  ]);
  assert.equal(result.rows[1].priceNeedsReview,true);
  assert.ok(result.rows[1].sourceProvenance.cells.some(cell=>cell.words.some(word=>word.box)));
  console.log('PASS actual local PDF.js + Tesseract: both pages, exact codes/units/46.75/57.85, OCR boxes and uncertainty retained. No hosted/browser/database acceptance implied.');
}finally{
  if(worker)await worker.terminate();
  rmSync(cache,{recursive:true,force:true});
}
