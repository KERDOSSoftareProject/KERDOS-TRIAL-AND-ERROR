import {unmangleExcelDatePack,normalizeColumnPack,parseDocument,findDate,findInvoiceNumber,findQuoteValidity} from './ingestion.js';
import {pdfTextLines} from './core/pdf-layout.js';
import assert from 'node:assert/strict';
let passed=0,failed=0;
function t(label,got,expected){if(JSON.stringify(got)===JSON.stringify(expected)){passed++;console.log('PASS',label)}else{failed++;console.error('FAIL',label,got,'expected',expected)}}
const email=`From: orders@vendor.com\nSubject: New prices September 21\n\nChicken breast 40 lb $82.50\nChicken base 1 lb $14.00\nChicken thighs 40 lb $54.00`;
const e=parseDocument(email);
t('informal email is a price list',e.documentKind,'pricelist');
t('informal email has exactly 3 products',e.rows.length,3);
t('no fictitious $21 subject price',e.rows.some(r=>r.price===21),false);
t('breast quote parsed',e.rows[0].price,82.5);
t('pack is preserved',e.rows[0].packSize,'40 lb');
t('base remains separate description',e.rows[1].description,'Chicken base');
t('base pack extracted from description',e.rows[1].packSize,'1 lb');
t('metadata not imported as product',e.rows.some(r=>/from:|subject:|invoice\s*#/i.test(r.description)),false);
const invoice=`INVOICE #8765\nDate 09/14/2026\nItem: Chicken Breast Qty: 2 Price: $82.50 Total: $165.00\nItem: Chicken Base Qty: 1 Price: $14.00 Total: $14.00\nTotal: $179.00`;
// ── Mixed fraction pack tests (shared normalizeMixedFraction) ──────────────
const lettuce=parseDocument('LETTUCE ROMAINE 1-1/9 BU 25.00');
t('lettuce 1-1/9 BU produces a readable BU pack',lettuce.rows[0]?.packSize,'1.111111 BU');
t('lettuce original fraction preserved in originalPackSize',lettuce.rows[0]?.originalPackSize,'1-1/9 BU');
t('lettuce source text preserved in sourceLine',lettuce.rows[0]?.sourceLine,'LETTUCE ROMAINE 1-1/9 BU 25.00');
t('lettuce description cleaned of pack',lettuce.rows[0]?.description,'LETTUCE ROMAINE');
// Unit cost is calculated from pack+price — tested in accuracy-test.mjs with full catalog row

const i=parseDocument(invoice);
t('invoice classified as invoice',i.documentKind,'invoice');
t('invoice has exactly 2 products',i.rows.length,2);
t('invoice number not fictitious price',i.rows.some(r=>r.price===765),false);
t('invoice line total preserved',i.rows[0].amount,165);
t('invoice unit price preserved',i.rows[0].price,82.5);
t('invoice date detected',findDate(invoice),'2026-09-14');
t('invoice number detected',findInvoiceNumber(invoice),'8765');
const faulty=parseDocument('INVOICE #8766\nItem: Chicken Breast Qty: 2 Price: $82.50 Total: $175.00');
t('arithmetic discrepancy flagged',faulty.rows[0].issues.length>0,true);
t('no invalid Feb 31 date',findDate('Date: 02/31/2026'),null);
t('vendor valid-through date',findQuoteValidity('New prices\nValid through September 27, 2026'),'2026-09-27');
const unpriced=parseDocument('From: supplier@example.com\nSubject: Price list\nCHICKEN BREAST 40 LB 82');
t('unlabeled integer cannot be assumed price',unpriced.rows.length,0);
const expensive=parseDocument('From: supplier@example.com\nSubject: New prices\nIndustrial assembly 1000.00');
t('four digit unformatted price retained',expensive.rows[0]?.price,1000);
const vendorSheet=parseDocument('Item\tBrand\tSize\tDescription\tQuote Price\n43700\tCOMPNS\t1/500 FT\tALUM FOIL ROLL 18 IN\t44.30\n47432\tRNGELN\t1/15 LB\tBACON LAYOUT 18-22 FROZEN\t3.83');
t('vendor item column is a code',vendorSheet.rows[0]?.code,'43700');
t('vendor description stays a description',vendorSheet.rows[0]?.description,'ALUM FOIL ROLL 18 IN');
t('vendor brand is kept separately',vendorSheet.rows[1]?.brand,'RNGELN');
t('vendor pack is kept separately',vendorSheet.rows[1]?.packSize,'1/15 LB');
const twoColumnQuote=parseDocument('Price List\nProduct    Price    Product    Price\nAPPLE GALA 40 LB    34.00    LIME 150CT    47.50');
t('adjacent quote prices require row review',twoColumnQuote.rows.some(row=>row.issues.some(issue=>issue.includes('Two different prices'))),true);
const unusualInvoice=parseDocument('INVOICE #12345\nMATERIAL    DESCRIPTION    QTY    UNIT PRICE    LINE TOTAL\nX2700    TERRY TOWEL WHITE    125    0.099    12.90');
t('uncertain invoice arithmetic requires review',unusualInvoice.rows.some(row=>row.issues.some(issue=>issue.includes('reconcile'))),true);
t('an unlabeled code-like cell becomes the vendor code',unusualInvoice.rows[0]?.code,'X2700');
const detailSheet=parseDocument('Item Number,Description,Pack,Price,Notes\n1001,BACON LAYOUT,15 LB,3.24,WRIGHTS\n1002,BEEF BASE,6/1 LB,35.95,SELECT');
t('price-sheet extras are kept as details, not issues',detailSheet.rows[0]?.issues.length,0);
t('price-sheet extras stay in the item name as written',detailSheet.rows[1]?.description,'BEEF BASE SELECT');
t('price-sheet extras are exposed for the brand box',detailSheet.rows[0]?.details?.[0],'WRIGHTS');
const detailInvoice=parseDocument('INVOICE #777\nItem,Description,Qty,Unit Price,Amount,Notes\n1001,BACON LAYOUT,2,3.24,6.48,WRIGHTS');
t('invoice extras still require a person',detailInvoice.rows[0]?.issues.some(issue=>issue.includes('Unlabeled invoice details')),true);
const serviceInvoice=parseDocument('INVOICE #12345\nMATERIAL    DESCRIPTION    FREQ EXCH QTY    UNIT PRICE    LINE TOTAL TAX\nX2700    TERRY TOWEL WHITE    01    F    125    0.099    12.38 Y\nX3032    LINEN BAG    01    F    2    0.000    0.00 N\nSUBTOTAL 12.38');
const goodsInvoice=parseDocument('INVOICE 1769909\nItem/Xref ORD DLV UOM Description Pack Size Weight Unit Price Extended\n4806002-1-6-6-6 4.00 4.00 LB CHIX BRST BNLS BLACK LABEL 4/10# CB 1-40# 160.00 $1.79 $286.40\n5100250-1-6-6-6 6.00 6.00 CS WATER POLAND SPRING CT 40-16.9OZ $12.79 $76.74\nTOTAL 363.14');
assert.equal(goodsInvoice.mode,'goods-invoice');
assert.equal(goodsInvoice.rows[0].qty,160);
assert.equal(goodsInvoice.rows[0].packSize,'1-40#');
assert.equal(goodsInvoice.rows[0].priceBasis,'measure');
assert.equal(goodsInvoice.rows[1].qty,6);
assert.equal(goodsInvoice.rows[1].packSize,'40-16.9OZ');
assert.equal(goodsInvoice.rows.filter(row=>row.issues.length).length,0);
const measuredInvoice=parseDocument('INVOICE #12345\nItem No Ordered Delivered Unit Description Pack Size Billed Quantity Unit Price Line Total\nBOLT-004 2.00 2.00 KG FASTENER ALLOY 1/20KG 40.00 $3.25 $130.00\nTOTAL $130.00');
assert.equal(measuredInvoice.mode,'goods-invoice');
assert.equal(measuredInvoice.rows[0].qty,40);
assert.equal(measuredInvoice.rows[0].priceBasis,'measure');
const pdfWords=(x,y,str)=>({transform:[1,0,0,1,x,y],str});
assert.deepEqual(pdfTextLines([pdfWords(60,100,'Product'),pdfWords(260,100,'Price'),pdfWords(365,100,'Product'),pdfWords(560,100,'Price'),pdfWords(60,90,'APPLE 40 LB'),pdfWords(260,90,'34.00'),pdfWords(365,90,'LIME 50 CT'),pdfWords(560,90,'47.50')]),['Product Price','APPLE 40 LB 34.00','Product Price','LIME 50 CT 47.50']);
t('service rate preserves three decimals',serviceInvoice.rows[0]?.price,0.099);
t('service invoice keeps free lines',serviceInvoice.rows[1]?.amount,0);
t('service invoice ignores subtotal',serviceInvoice.rows.length,2);

// Packs a spreadsheet mangled into dates come back as outer/inner counts;
// packaging words and bare counts in a pack column are read as packs.
const dateCases={"2025-12-10 00:00:00":"12/10","2025-06-10":"6/10","12/10/2025":"12/10","10-Dec":"12/10","Dec-10":"12/10","1950-12-01 00:00:00":"12/1","4/5-LB":"4/5-LB","40-LB":"40-LB"};
for(const [input,expected] of Object.entries(dateCases))t(`excel date pack ${input}`,unmangleExcelDatePack(input),expected);
t("packaging word alone is one of that packaging",normalizeColumnPack("CASE"),"1 CASE");
t("bare count in a pack column is a count",normalizeColumnPack("1000"),"1000 CT");
t("a real pack is left alone",normalizeColumnPack("24/15.5"),"24/15.5");
const mangled=parseDocument('Item#,Pack & Size:,Type:,Brand:,Description:,Sell\n#1,2025-12-10 00:00:00,CSE,MISC,GYRO BREAD 7 INCH,30.25\n#2,CASE,CSE,FRESH,CUCUMBER,22.50\n#3,1000,BOX,VB,VB-16FCW PAPER CONT 16OZ,61.00');
t("mangled date row keeps a usable pack",mangled.rows[0]?.packSize,"12/10");
t("produce sold by the case has a pack",mangled.rows[1]?.packSize,"1 CASE");
t("count-only pack reads as a count",mangled.rows[2]?.packSize,"1000 CT");

// ══════════════════════════════════════════════════════════════════════════════
// UGLY FILE BATTERY — every bad layout a vendor can send
// ══════════════════════════════════════════════════════════════════════════════

// ── DELIMITER VARIANTS ────────────────────────────────────────────────────────
const semicolonDelim = parseDocument('Item;Description;Pack;Price\n1001;WIDGET ALPHA;10 EA;12.50\n1002;GADGET BETA;5 EA;8.00');
t('semicolon-delimited sheet parses correctly', semicolonDelim.rows.length, 2);
t('semicolon row gets correct price', semicolonDelim.rows[0].price, 12.50);

const pipeDelim = parseDocument('Item|Description|Pack|Price\n1001|WIDGET ALPHA|10 EA|12.50');
t('pipe-delimited sheet parses correctly', pipeDelim.rows.length, 1);

const mixedSpaceDelim = parseDocument('ITEM     DESCRIPTION          PACK      PRICE\n1001     WIDGET ALPHA         10 EA     12.50\n1002     GADGET BETA          5 EA       8.00');
t('space-aligned columns parse correctly', mixedSpaceDelim.rows.length, 2);
t('space-aligned price correct', mixedSpaceDelim.rows[0].price, 12.50);

// ── HEADER ON WRONG ROW ───────────────────────────────────────────────────────
const headerRow5 = parseDocument(`VENDOR SUPPLY CO
123 MAIN STREET
CITY STATE 00000
PRICE LIST - EFFECTIVE 2026-10-01
Item#,Description,Pack,Price
1001,ITEM ALPHA,10 EA,12.50
1002,ITEM BETA,5 EA,8.00`);
t('header buried under 4 address rows', headerRow5.rows.length, 2);
t('address rows not imported as products', headerRow5.rows.some(r => /VENDOR|MAIN|CITY|EFFECTIVE/i.test(r.description)), false);

const headerRow8 = parseDocument(`
WHOLESALE DISTRIBUTORS INC.
CONFIDENTIAL — DO NOT DISTRIBUTE
QUOTE VALID: OCT 2026



ITEM NO.,DESCRIPTION,PACK SIZE,UNIT PRICE
A001,ITEM ALPHA,12/1 LB,44.50
A002,ITEM BETA,6/1 GAL,18.75`);
t('header after 7 rows of noise', headerRow8.rows.length, 2);
t('blank rows and headers not imported', headerRow8.rows.some(r => /WHOLESALE|CONFIDENTIAL|QUOTE/i.test(r.description)), false);

// ── COLUMNS IN UNUSUAL ORDER ──────────────────────────────────────────────────
const reversedCols = parseDocument('Price,Pack,Description,Item#\n12.50,10 EA,ITEM ALPHA,1001\n8.00,5 EA,ITEM BETA,1002');
t('price first column order parsed', reversedCols.rows.length, 2);
t('price correct in reversed columns', reversedCols.rows[0].price, 12.50);

const priceLastNoPack = parseDocument('Code,Name,Cost\n1001,ITEM ALPHA,12.50\n1002,ITEM BETA,8.00');
t('no pack column — rows still imported', priceLastNoPack.rows.length, 2);
t('price found without pack column', priceLastNoPack.rows[0].price, 12.50);

// ── PACK BURIED IN DESCRIPTION ────────────────────────────────────────────────
const packInDesc = parseDocument('Code,Description,Price\n1001,ITEM ALPHA 10 EA,12.50\n1002,ITEM BETA 4/5 LB,8.00\n1003,ITEM GAMMA 6/1 GAL,18.75');
t('pack extracted from end of description', packInDesc.rows[0].packSize, '10 EA');
t('fraction pack extracted from description', packInDesc.rows[1].packSize, '4/5 LB');
t('gallon pack extracted from description', packInDesc.rows[2].packSize, '6/1 GAL');
t('description cleaned after pack strip', packInDesc.rows[0].description, 'ITEM ALPHA');

const packMidDesc = parseDocument('Code,Description,Price\n1001,ITEM ALPHA (40 LB) FRESH,12.50');
t('pack in parentheses mid-description extracted', packMidDesc.rows[0].packSize, '40 LB');

const packWithOrigin = parseDocument('Code,Description,Price\n1001,ITEM ALPHA (USA) 40 LB,12.50\n1002,ITEM BETA 80 (CAL) 45 LB,8.00');
t('pack after origin code extracted', packWithOrigin.rows[0].packSize, '40 LB');
t('description with origin cleaned', packWithOrigin.rows[0].description, 'ITEM ALPHA (USA)');

// ── PRICE FORMAT VARIANTS ─────────────────────────────────────────────────────
const dollarSigns = parseDocument('Item,Description,Pack,Price\n1001,ITEM ALPHA,10 EA,$12.50\n1002,ITEM BETA,5 EA,"$8,025.00"');
t('dollar sign stripped from price', dollarSigns.rows[0].price, 12.50);
t('comma-formatted price parsed', dollarSigns.rows[1].price, 8025.00);

const euroDecimal = parseDocument('Item;Description;Pack;Price\n1001;ITEM ALPHA;10 EA;12,50\n1002;ITEM BETA;5 EA;8.025,00');
t('european decimal comma in price', euroDecimal.rows[0].price, 12.50);

const pricePerUnit = parseDocument('Item,Description,Pack,Price/LB\n1001,ITEM ALPHA,40 LB,2.15\n1002,ITEM BETA,40 LB,1.85');
t('price per LB column header recognised', pricePerUnit.rows[0].price, 2.15);
t('price per LB basis recorded via sellingUnit', pricePerUnit.rows[0].sellingUnit, 'LB'); // priceBasis='measure' derived from sellingUnit at display time

const multiTierPrice = parseDocument('Item,Description,Pack,List Price,Your Price\n1001,ITEM ALPHA,10 EA,15.00,12.50');
t('your price wins over list price', multiTierPrice.rows[0].price, 12.50);

// ── DESCRIPTION VARIANTS ──────────────────────────────────────────────────────
const allLower = parseDocument('item,description,pack,price\n1001,item alpha standard,10 ea,12.50');
t('all lowercase column headers recognised', allLower.rows.length, 1);
t('all lowercase description preserved', allLower.rows[0].description, 'item alpha standard');

const leadingTrailingSpaces = parseDocument('Item,Description,Pack,Price\n 1001 , ITEM ALPHA ,  10 EA , 12.50 ');
t('leading/trailing spaces stripped from all fields', leadingTrailingSpaces.rows[0].code, '1001');
t('leading/trailing spaces stripped from description', leadingTrailingSpaces.rows[0].description, 'ITEM ALPHA');
t('leading/trailing spaces stripped from price', leadingTrailingSpaces.rows[0].price, 12.50);

const internalDoubleSpaces = parseDocument('Item,Description,Pack,Price\n1001,ITEM  ALPHA  STANDARD,10 EA,12.50');
t('internal double spaces collapsed', internalDoubleSpaces.rows[0].description, 'ITEM ALPHA STANDARD');

const asteriskFlags = parseDocument('Item,Description,Pack,Price\n1001,*ITEM ALPHA*,10 EA,12.50\n1002,ITEM BETA **NEW**,5 EA,8.00\n1003,ITEM GAMMA ***SALE*** FRESH,6 EA,22.00');
t('asterisk flags stripped from description', asteriskFlags.rows[0].description, 'ITEM ALPHA');
t('new flag stripped from description', asteriskFlags.rows[1].description, 'ITEM BETA');
t('triple asterisk sale flag stripped', asteriskFlags.rows[2].description.includes('SALE'), false);

// ── NOISE ROWS ────────────────────────────────────────────────────────────────
const categoryHeaders = parseDocument(`Item,Description,Pack,Price
--- CATEGORY ONE ---
1001,ITEM ALPHA,10 EA,12.50
1002,ITEM BETA,5 EA,8.00
--- CATEGORY TWO ---
2001,ITEM GAMMA,6 EA,22.00`);
t('category header rows not imported as products', categoryHeaders.rows.length, 3);
t('category header not in descriptions', categoryHeaders.rows.some(r => /CATEGORY|---/.test(r.description)), false);

const subtotalRows = parseDocument(`Item,Description,Pack,Price
1001,ITEM ALPHA,10 EA,12.50
1002,ITEM BETA,5 EA,8.00
,SUBTOTAL,,20.50
,,,
2001,ITEM GAMMA,6 EA,22.00
,TOTAL,,42.50`);
t('subtotal rows not imported', subtotalRows.rows.length, 3);
t('total row not imported', subtotalRows.rows.some(r => /SUBTOTAL|TOTAL/i.test(r.description)), false);

const pageBreakRows = parseDocument(`Item,Description,Pack,Price
1001,ITEM ALPHA,10 EA,12.50
PAGE 1 OF 3
1002,ITEM BETA,5 EA,8.00
CONTINUED ON NEXT PAGE
2001,ITEM GAMMA,6 EA,22.00`);
t('page break text not imported', pageBreakRows.rows.length, 3);

const termsAtBottom = parseDocument(`Item,Description,Pack,Price
1001,ITEM ALPHA,10 EA,12.50
1002,ITEM BETA,5 EA,8.00
TERMS: NET 30 DAYS. PRICES SUBJECT TO CHANGE WITHOUT NOTICE.
MINIMUM ORDER $250.00. FUEL SURCHARGE MAY APPLY.`);
t('terms and conditions not imported as products', termsAtBottom.rows.length, 2);

const blankRowsMidFile = parseDocument(`Item,Description,Pack,Price
1001,ITEM ALPHA,10 EA,12.50

1002,ITEM BETA,5 EA,8.00

2001,ITEM GAMMA,6 EA,22.00`);
t('blank rows mid-file do not break parsing', blankRowsMidFile.rows.length, 3);

// ── COLUMN NAME VARIANTS ──────────────────────────────────────────────────────
const abbreviatedHeaders = parseDocument('Itm#,Desc,Pk,Pr\n1001,ITEM ALPHA,10 EA,12.50');
t('abbreviated column headers recognised', abbreviatedHeaders.rows.length, 1);
t('abbreviated headers price correct', abbreviatedHeaders.rows[0].price, 12.50);

const verboseHeaders = parseDocument('Item Number,Product Description,Package Size,Unit Price Per Case\n1001,ITEM ALPHA,10 EA,12.50');
t('verbose column headers recognised', verboseHeaders.rows.length, 1);
t('verbose headers price correct', verboseHeaders.rows[0].price, 12.50);

const numberedHeaders = parseDocument('Col1,Col2,Col3,Col4\n1001,ITEM ALPHA,10 EA,12.50\n1002,ITEM BETA,5 EA,8.00');
t('numbered column headers — data profiler extracts rows', numberedHeaders.rows.length, 2);
t('numbered column headers — first row has text description', numberedHeaders.rows[0].description.length > 0, true);

const extraColumns = parseDocument('Item,Description,Pack,Price,Min Order,Lead Time,Notes\n1001,ITEM ALPHA,10 EA,12.50,1 CS,2 days,Special order');
t('extra columns beyond core four do not break parsing', extraColumns.rows.length, 1);
t('extra column data does not corrupt price', extraColumns.rows[0].price, 12.50);

// ── PACK FORMAT VARIANTS ──────────────────────────────────────────────────────
const weightRange = parseDocument('Item,Description,Pack,Price\n1001,ITEM ALPHA,8-10 LB AVG,12.50\n1002,ITEM BETA,14/16 OZ,8.00');
t('weight range pack imported', weightRange.rows[0].packSize, '8-10 LB AVG');
t('fraction-slash pack imported', weightRange.rows[1].packSize, '14/16 OZ');

const hashWeight = parseDocument('Item,Description,Pack,Price\n1001,ITEM ALPHA 35#,35 LB,12.50\n1002,ITEM BETA,10#,8.00');
t('hash weight in description normalised', hashWeight.rows[0].packSize, '35 LB');

const separateSizeCount = parseDocument('Item,Description,Count,Size,Price\n1001,ITEM ALPHA,24,15.5 OZ,44.50');
t('separate size column used as pack', separateSizeCount.rows[0].packSize, '15.5 OZ');
t('separate size column — price still correct', separateSizeCount.rows[0].price, 44.50);

// ── VENDOR CODE VARIANTS ──────────────────────────────────────────────────────
const alphanumericCodes = parseDocument('Item,Description,Pack,Price\nABC-1001,ITEM ALPHA,10 EA,12.50\nXYZ-002,ITEM BETA,5 EA,8.00');
t('alphanumeric vendor codes preserved', alphanumericCodes.rows[0].code, 'ABC-1001');

const noCodeColumn = parseDocument('Description,Pack,Price\nITEM ALPHA,10 EA,12.50\nITEM BETA,5 EA,8.00');
t('no code column — rows still imported', noCodeColumn.rows.length, 2);
t('no code column — code is null', noCodeColumn.rows[0].code == null || noCodeColumn.rows[0].code === '', true);

// ── PRICE SHEET VS INVOICE DETECTION ─────────────────────────────────────────
const priceSheetKeywords = parseDocument('PRICE LIST\nEffective: October 2026\nItem,Description,Pack,Price\n1001,ITEM ALPHA,10 EA,12.50');
t('PRICE LIST keyword detected as pricelist', priceSheetKeywords.documentKind, 'pricelist');

const invoiceKeywords = parseDocument('INVOICE NO: 88765\nDate: 2026-10-01\nItem,Description,Qty,Unit Price,Total\n1001,ITEM ALPHA,2,12.50,25.00');
t('INVOICE keyword detected as invoice', invoiceKeywords.documentKind, 'invoice');

const orderAckKeywords = parseDocument('ORDER ACKNOWLEDGEMENT\nOrder #: 44321\nItem,Description,Qty,Price\n1001,ITEM ALPHA,2,12.50');
t('ORDER ACKNOWLEDGEMENT detected', orderAckKeywords.documentKind, 'invoice');

// ── SURCHARGE AND FEE ROWS ────────────────────────────────────────────────────
const surchargeRows = parseDocument(`Item,Description,Pack,Price
1001,ITEM ALPHA,10 EA,12.50
,FUEL SURCHARGE,,3.50
,DELIVERY FEE,,15.00
,HANDLING CHARGE,,5.00
1002,ITEM BETA,5 EA,8.00`);
t('fuel surcharge row skipped', surchargeRows.rows.length, 2);
t('delivery fee row skipped', surchargeRows.rows.some(r => /DELIVERY|FUEL|HANDLING/i.test(r.description)), false);

// ── FREEFORM EMAIL VARIANTS ───────────────────────────────────────────────────
const informalEmail = parseDocument(`From: rep@supplier.com
To: buyer@client.com
Subject: Updated pricing

Hi,

Just wanted to send over updated pricing for this week:

Item Alpha 10 EA - $12.50
Item Beta 5 EA - $8.00
Item Gamma 6/1 GAL - $18.75

Let me know if you have any questions.

Best,
Sales Rep`);
t('informal email extracts products', informalEmail.rows.length, 3);
t('signature not imported as product', informalEmail.rows.some(r => /Sales|Best|questions/i.test(r.description)), false);
t('greeting not imported as product', informalEmail.rows.some(r => /Hi|Just|wanted/i.test(r.description)), false);

const emailWithSubjectPrice = parseDocument(`From: rep@supplier.com
Subject: Price update for order #12345
Item Alpha 10 EA $12.50`);
t('order number in subject not imported as price', emailWithSubjectPrice.rows[0]?.price, 12.50);
t('order number not fictitious product', emailWithSubjectPrice.rows.length, 1);

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
