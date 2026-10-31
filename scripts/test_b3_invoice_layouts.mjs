import assert from 'node:assert/strict';
import {parseStructuredDocument} from '../src/core/document-structuring.js';
const word=(text,x,y,width=text.length*6,height=10,fontFamily='sans-serif')=>({text,width,height,fontFamily,transform:[height,0,0,height,x,y]});
const headings=y=>[['QTY',24,18],['U/M',52,16],['PACK/SIZE',74,47],['BRAND',138,31],['DESCRIPTION',201,61],['ITEM',391,21],['PRICE',441,27],['WEIGHT',486,36],['EXT',536,17]].map(([text,x,width])=>word(text,x,y,width,9));
function invoicePage(number=1,{copy=false,invoice='B3-INV-001',secondPrice='5.39'}={}){
 const items=[...headings(536),word('10 CS 1/15LB',37,501,'10 CS 1/15LB'.length*6.324,10.54,'monospace'),word('Test Brand',138,501),word('Bacon Layout',201,501),word('INV-A',391,501),word('3.59',441,501),word('150.00',486,501),word('538.50',555,501),
 word('* R E F R I G E R A T E D *',201,480),word('2 CS 2/8.5LBAV',43,465,'2 CS 2/8.5LBAV'.length*6.324,10.54,'monospace'),word('Turkey Breast',201,465),word('INV-B',391,465),word(secondPrice,441,465),word('34.92',486,465),word('188.22',555,465),
 word('The following items were Out of Stock',138,430),word('INV-C Missing Product 3 CS',138,410),word('These are your outstanding invoices',138,390),word('100001 10/29/25 25.95',138,370),word('NOTICE NEW ORDER MINIMUM $500.00',138,350),word('SERVICE CHARGE: 3.00',138,330)];
 if(copy)items.push(word('CUSTOMER',30,315,544,100),word('COPY',102,135,400,150));
 return {number,width:612,height:792,source:'embedded-text',items,text:'INVOICE: '+invoice+'\nDate: 10/27/2026\n'+items.map(item=>item.text).join('\n')};
}
const read=pages=>({filename:'controlled-layout.pdf',kind:'pdf',pages,worksheets:[],text:pages.map(page=>page.text).join('\n')});
const parse=pages=>{const r=read(pages);return parseStructuredDocument(r.text,r);};
let passed=0;function check(name,fn){fn();passed++;console.log('PASS '+name);}
check('compact headings and fixed-width spanning text retain invoice fields without inventing billing units',()=>{
 const p=parse([invoicePage()]);assert.deepEqual(p.rows.map(row=>[row.code,row.qty,row.packSize,row.price,row.amount]),[['INV-A',10,'1/15LB',3.59,538.5],['INV-B',2,'2/8.5LBAV',5.39,188.22]]);
 assert.ok(p.rows.every(row=>!row.billingUnitEvidence));
 assert.ok(p.rows[0].sourceProvenance.cells.some(cell=>cell.words.some(word=>word.sourceSpan&&word.sourceText==='10 CS 1/15LB')));
});
check('out-of-stock, balances and footer charges remain source evidence, never product rows',()=>{
 const p=parse([invoicePage()]);assert.equal(p.rows.length,2);assert.ok(!p.rows.some(row=>[500,3,25.95].includes(row.price)));assert.ok(p.skipped.some(row=>/non-product/.test(row.reason)));
});
check('explicit identical customer copy contributes provenance without duplicate invoice lines',()=>{
 const r=read([invoicePage(),invoicePage(2,{copy:true})]),before=JSON.stringify(r),p=parseStructuredDocument(r.text,r);
 assert.equal(p.rows.length,2);assert.deepEqual(p.duplicatePages.map(page=>[page.page,page.duplicateOf]),[[2,1]]);
 assert.equal(p.rows[0].sourceProvenance.copies[0].page,2);assert.equal(JSON.stringify(r),before);assert.deepEqual(parseStructuredDocument(r.text,r),p);
});
check('identical unmarked pages and changed copy amounts or invoice identity are not silently deduplicated',()=>{
 for(const options of [{},{copy:true,secondPrice:'5.49'},{copy:true,invoice:'B3-INV-002'}]){const p=parse([invoicePage(),invoicePage(2,options)]);assert.equal(p.rows.length,4);assert.equal(p.duplicatePages.length,0);}
});
check('a new explicit product table after a non-product section remains readable',()=>{
 const page=invoicePage();page.items.push(word('Description',201,300),word('Price',441,300),word('Chicken Breast',201,280),word('40.00',441,280));
 const p=parse([page]);assert.ok(p.rows.some(row=>row.description==='Chicken Breast'&&row.price===40));
});
check('vertically centered prices stay with consecutive wrapped descriptions in each table lane',()=>{
 const items=[word('Product',20,550),word('Price',250,550),word('Product',340,550),word('Price',570,550),
 word('Turkey Breast (Brand',20,510),word('Alpha)',20,500),word('41.25',250,505),word('Chicken Breast (Brand',20,487),word('Beta)',20,477),word('51.75',250,482),
 word('Beef Tenderloin',340,510),word('71.25',570,510),word('Lamb Leg',340,487),word('81.75',570,487)];
 const p=parse([{number:1,width:612,height:792,source:'embedded-text',items,text:'Price list'}]);
 assert.deepEqual(p.rows.map(row=>[row.description,row.price]),[['Turkey Breast (Brand Alpha)',41.25],['Chicken Breast (Brand Beta)',51.75],['Beef Tenderloin',71.25],['Lamb Leg',81.75]]);
});
console.log(`${passed}/6 B3 layout regression checks passed (local, no hosted evidence).`);
