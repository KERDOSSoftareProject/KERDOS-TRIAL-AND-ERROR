import assert from 'node:assert/strict';
import {clientProductName} from './client-product-name.js';
import {configureProcurement} from '../procurement.js';
configureProcurement({industry:'restaurant'});
const examples=[
 ['-- ORZO - PASTA DRY 71','Orzo Pasta'],['( 275 ) GRN HERTG. T.TISS','Toilet Tissue'],
 ['( CANS-SMALL ) RED KIDNEY','Red Kidney Beans'],['( ITALIAN ) BREAD CRUMB','Breadcrumbs'],
 ['( VINYL ) LARGE GLOVE','Vinyl Gloves'],['( WINDEX ) GLASS CLEANER','Glass Cleaner'],
 ['(( FULL )) SHALLOW PAN','Shallow Food Pan'],['/ RP-200 \\ 2-LB FOOD TRAY','Food Tray'],
 ['1-PC ONLY BOURBON SAUCE','Bourbon Sauce'],['1-PC ONLY TZATZIKI SAUCE','Tzatziki'],
 ['Honey Mustard Dressing','Honey Mustard'],['DRESS HONEY MUSTARD','Honey Mustard'],['avocado','Avocados'],
 ['ANISE (USA)','Anise'],['APPLE (NY) 4','Apple'],['ARCADIAN MIX (USA)','Arcadian Mix'],
];
for(const [name,expected] of examples)assert.equal(clientProductName({name},[],'restaurant'),expected,name);
for(const name of ['(CHN)','(COL)','(COS)','(GTM)','(MOR) 10/3 lb.','(PLASTIC)','1/2 GALLON (USA)'])assert.equal(clientProductName({name},[],'restaurant'),null,name+' is an unidentified fragment, not a client product name');
const row={description:'Original vendor wording',brand:'ACME',pack_size:'4/1 GAL',price:33,field_resolutions:{}};
const before=JSON.stringify(row);assert.equal(clientProductName({name:'ACME Widget'},[row],''),'Widget');assert.equal(JSON.stringify(row),before,'display naming cannot edit source/price/field records');
assert.equal(clientProductName({name:'My house dressing'},[{field_resolutions:{item_name:{confirmedBy:'client'}}}],'restaurant'),'My house dressing','deliberate client names are retained');
assert.equal(clientProductName({name:'orzo'},[],'hardware'),'Orzo','restaurant-specific labels never leak to another industry');
console.log('PASS client names: exact screenshot examples, plain product vocabulary, unidentifiable fragments kept for review, explicit client names and original source fields preserved.');
