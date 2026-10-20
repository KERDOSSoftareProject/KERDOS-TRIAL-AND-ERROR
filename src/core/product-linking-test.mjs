import assert from 'node:assert/strict';
import {configureProcurement} from '../procurement.js';
import {createCatalogService} from '../services/catalog.js';
import {autoPlaceable,orderGuideAssessment} from './catalog-fields.js';
import {matchExistingProduct,productFamily} from './product-linking.js';
import {compareCatalogRows} from './catalog-row-order.js';
import {rankVendorOffers,offerDollarDifference} from './ordering.js';
configureProcurement({industry:'Restaurant'});
const categories=[{id:'poultry',name:'Poultry',range_start:1000,range_end:1999,is_holding_pen:false}];
const catalogItems=[],vendorItems=[],mappings=[];
let created=0;
const service=createCatalogService({records:{query(){let value;const q={insert(v){value=v;return q;},select(){return q;},single(){return q;},then(resolve){resolve({data:{id:'c'+(++created),...value},error:null});}};return q;}}});
const base={price:40,selling_unit:'CS',price_basis:'case',price_source:'price_list',price_unavailable:false,last_updated:new Date().toISOString(),row_revision:0};
async function importRow(row){
 const found=await service.matchOrCreate({organizationId:'o',vendorId:row.vendor_id,description:row.description,packSize:row.pack_size,brand:row.brand,categoryId:'poultry',catalogItems,categories,vendorItems,mappings});
 vendorItems.push(row);mappings.push({id:'m'+row.id,vendor_item_id:row.id,catalog_item_id:found.catalogItemId,comparison_track:found.track,confidence_score:found.track==='exact'?100:70,match_method:'rule_based'});return found;
}
const a={id:'a',vendor_id:'A',description:'CHIX BRST BNLS SKNLS',brand:'Vendor Brand A',pack_size:'4/10 LB',...base};
const b={id:'b',vendor_id:'B',description:'BONELESS SKINLESS CHICKEN BREAST',brand:'Vendor Brand B',pack_size:'4 x 10 LB',...base,price:42};
const first=await importRow(a),second=await importRow(b);
assert.equal(first.track,'new');assert.equal(second.track,'exact');
assert.equal(first.catalogItemId,second.catalogItemId);assert.equal(created,1,'two imports share one KERDOS entry');
for(const entry of autoPlaceable({catalogItems,vendorItems,mappings,categories,vendors:[{id:'A'},{id:'B'}],settings:{}}))Object.assign(mappings.find(m=>m.id===entry.mappingId),entry.verification);
const options=mappings.map(m=>{const row=vendorItems.find(v=>v.id===m.vendor_item_id);const ready=orderGuideAssessment({item:catalogItems[0],vendorItem:row,mapping:m,category:categories[0],peers:vendorItems.filter(v=>v.id!==row.id),categories,settings:{}}).ready;assert.equal(ready,true,'both vendor offers qualify');return {vendorId:row.vendor_id,vendorItemId:row.id,packSize:row.pack_size,casePrice:row.price,matchTrack:m.comparison_track,matchConfidence:m.confidence_score,unverified:!ready};});
const ranked=rankVendorOffers(options,{});assert.equal(ranked.length,2);assert.equal(ranked[0].vendorId,'A');assert.equal(offerDollarDifference(ranked[1],ranked[0]),2);
const close=await importRow({...b,id:'c',vendor_id:'C',description:'CHICKEN BREAST',price:39});
assert.equal(close.catalogItemId,first.catalogItemId);assert.equal(close.track,'review','missing defining details attach for review');
assert.equal(mappings.find(m=>m.vendor_item_id==='c').comparison_track,'review');
const distinct=await importRow({...b,id:'d',vendor_id:'D',pack_size:'10 LB'});assert.equal(distinct.track,'new');assert.notEqual(distinct.catalogItemId,first.catalogItemId);
assert.equal(productFamily(a),'chicken');assert.equal(productFamily(b),'chicken');
const rejected={...b,id:'z',field_resolutions:{rejected_vendor_item_ids:['a','b','c']}};
assert.equal(matchExistingProduct(rejected,[catalogItems[0]],vendorItems,mappings),null,'client unlink remains respected');
const single={...a,description:'CHIX BRST BNLS SKNLS SINGLE LOBE TRMD'};
const singleFull={...b,description:'BONELESS SKINLESS CHICKEN BREAST SINGLE-LOBE TRIMMED'};
const singleMap=[{vendor_item_id:single.id,catalog_item_id:simpleCatalogId()}];
function simpleCatalogId(){return catalogItems[0].id;}
assert.equal(matchExistingProduct(singleFull,[catalogItems[0]],[single],singleMap).track,'exact','single-lobe trimmed vendor shorthand matches full wording');
for(const description of ['BONELESS SKINLESS CHICKEN BREAST DOUBLE LOBE TRIMMED','BONELESS SKINLESS CHICKEN BREAST SINGLE LOBE UNTRIMMED']){
 assert.notEqual(matchExistingProduct({...singleFull,description},[catalogItems[0]],[single],singleMap)?.track,'exact','lobe and trim differences stay distinct');
}
// A brand requirement filters offers without losing product/vendor identity.
const simpleItem={...catalogItems[0],name:'CHICKEN BREAST',brand_locked:false};
const knownRows=[a,b],knownMappings=mappings.filter(m=>['a','b'].includes(m.vendor_item_id));
assert.equal(matchExistingProduct(b,[simpleItem],knownRows,knownMappings).track,'exact');
const locked={...simpleItem,brand_locked:true,locked_brand:a.brand};
assert.equal(matchExistingProduct(b,[locked],knownRows,knownMappings).track,'review');
assert.equal(matchExistingProduct({...b,brand:null},[locked],knownRows,knownMappings).track,'review','unknown brand cannot satisfy a requirement');
assert.equal(matchExistingProduct(a,[locked],knownRows,knownMappings).track,'exact');
for(const row of knownRows){
 const assessment=orderGuideAssessment({item:locked,vendorItem:row,mapping:{...knownMappings.find(m=>m.vendor_item_id===row.id),comparison_track:'exact',confidence_score:100},category:categories[0],peers:knownRows.filter(p=>p.id!==row.id),categories,settings:{}});
 assert.equal(assessment.ready,row.id==='a','required brand filters eligible offers');
}
assert.equal(matchExistingProduct(b,[{...locked,brand_locked:false,locked_brand:null}],knownRows,knownMappings).track,'exact','unchecking restores cross-brand matching');
for(const description of ['CHICKEN BREAST BREADED','CHICKEN BREAST BONE IN']){
 const different=matchExistingProduct({...b,description},[simpleItem],knownRows,knownMappings);
 assert.notEqual(different?.track,'exact','different form cannot silently become exact');
}
const displayRow=(id,category,name,price,vendor='Vendor',extra={})=>({item:{id,name},evidence:{category:{value:category}},vendor:{name:vendor},vendorItem:{...base,id,pack_size:'40 LB',price,...extra}});
const displayRows=[displayRow('c','Poultry','CHICKEN BREAST',50,'Alpha'),displayRow('c','Poultry','CHICKEN BREAST',40,'Zeta'),displayRow('c','Poultry','CHICKEN BREAST',1,'Per pound',{selling_unit:'LB',price_basis:'measure'}),displayRow('d','Produce','LETTUCE',10),displayRow('e','General','BEANS',15),displayRow('c','Poultry','CHICKEN BREAST',1,'Expired',{price_expired_at:'2020-01-01',last_updated:'2020-01-01'})];
const ordered=displayRows.sort((x,y)=>compareCatalogRows(x,y));
assert.deepEqual(ordered.map(r=>r.vendor.name),['Vendor','Per pound','Zeta','Alpha','Expired','Vendor'],'category/item groups retained; current equivalent pack prices rank vendors; expired offers last within item');
assert.equal(ordered[0].evidence.category.value,'General');
assert.equal(ordered.at(-1).evidence.category.value,'Produce');
configureProcurement();
console.log('Multi-vendor workflow passed: two imports, one KERDOS number, dictionary/brand-independent identity, ready offers, ranked dropdown prices, review attachment, distinct packs and unlink memory.');
