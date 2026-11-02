import assert from 'node:assert/strict';
import {configureProcurement} from '../src/procurement.js';
import {buildProductAssociations,productGroupApproved} from '../src/core/product-associations.js';
import {productGroupRequest} from '../src/services/product-associations.js';
import {orderGuideAssessment} from '../src/core/catalog-fields.js';
configureProcurement({industry:'restaurant'});
const row=(id,description,pack_size='4/1 GAL',brand='')=>({id,description,pack_size,brand,price:20,selling_unit:'CASE',vendor_id:'vendor'+id,row_revision:0,field_resolutions:{}});
const a=row('a','OIL POMACE 100%'),b=row('b','POMACE OIL 100% ANTONIO','4/3 LITER'),c=row('c','( POMACE ) OIL 100 %','46174 CT');
const honey=[row('h1','DRESS HONEY MUSTARD'),row('h2','(DRESSING) HONEY MUSTRD'),row('h3',"HONEY MUSTARD KEN'S",undefined,"KEN'S"),row('h4','DRESSING HONEY MUSTARD SHELF STABLE PLASTIC JAR')];
function input(rows){return {industry:'restaurant',vendorItems:rows,catalogItems:rows.map((v,i)=>({id:'c'+v.id,name:v.description,master_item_number:100+i,category_id:'cat',comparison_mode:'alternatives'})),mappings:rows.map(v=>({id:'m'+v.id,vendor_item_id:v.id,catalog_item_id:'c'+v.id,match_method:'rule_based',comparison_track:'review',confidence_score:70}))};}
const source=input([a,b,c,...honey,row('fragment','USA'),row('numeric','12345')]),original=JSON.stringify(source);
const preview=buildProductAssociations(source);
assert.equal(preview.groups.length,2);assert.deepEqual(preview.groups.map(g=>g.rows.length).sort(),[3,4]);assert.equal(preview.unresolved.length,2);
assert.equal(preview.groupedListings+preview.unresolved.length,source.vendorItems.length);assert.equal(JSON.stringify(source),original,'preview cannot change source');
assert.equal(new Set([...preview.groups.flatMap(g=>g.rows.map(v=>v.id)),...preview.unresolved.map(x=>x.row.id)]).size,source.vendorItems.length);
assert.deepEqual(buildProductAssociations({...source,vendorItems:[...source.vendorItems].reverse(),mappings:[...source.mappings].reverse()}).groups,preview.groups,'row order must not change groups');
const group=preview.groups.find(g=>g.rows.length===3);assert.equal(group.canSave,true);assert.equal(group.targetCatalogItemId,'ca');
const request=productGroupRequest(group,source.mappings,{organizationId:'org',requestId:'request'});assert.equal(request.members.length,3);assert.equal(request.confirmed,true);assert.equal(Object.hasOwn(request,'price'),false);
assert.throws(()=>productGroupRequest(group,[],{organizationId:'org',requestId:'r'}),/current catalog/);
for(const descriptions of [['CHICKEN BREAST BONELESS','CHICKEN THIGH BONELESS'],['TOMATO PASTE','TOMATO SAUCE'],['PEANUT BUTTER','BUTTER'],['MILK 1%','MILK 2%']]){
 const fixture=input(descriptions.map((d,i)=>row(String(i),d)));
 // Numeric formulation details must survive even though pack quantities do not.
 const result=buildProductAssociations(fixture);
 assert.equal(result.groups.length,2,descriptions.join(' vs '));
}
for(const patch of [{brand_locked:true},{comparison_mode:'exact'},{preferred_brand:'A'}]){
 const fixture=input([a,b]);fixture.catalogItems[0]={...fixture.catalogItems[0],...patch};assert.equal(buildProductAssociations(fixture).groups.length,2);
}
const rejected=input([a,b,c]);rejected.vendorItems[0]={...a,field_resolutions:{rejected_vendor_item_ids:['c']}};
assert.ok(buildProductAssociations(rejected).groups.every(g=>!(g.rows.some(v=>v.id==='a')&&g.rows.some(v=>v.id==='c'))));
const manual=input([a,b]);manual.vendorItems[0]={...a,field_resolutions:{catalog_item_id:{confirmedBy:'user'}}};assert.equal(buildProductAssociations(manual).groups.length,2);
// The core accepts another industry's vocabulary through the same data contract.
configureProcurement({industry:null});
const nonfood=buildProductAssociations({...input([row('x','HEX BOLT A'),row('y','HEX BOLT B')]),profile:{version:'hardware-test',concepts:[{label:'Hex Bolt',terms:['hex bolt']}],facets:[],fragments:[]}});assert.equal(nonfood.groups.length,1);
configureProcurement({industry:'restaurant'});
const item={id:'target',name:'Pomace Oil',category_id:'cat',master_item_number:100,comparison_mode:'alternatives'},mapping={catalog_item_id:'target',comparison_track:'exact',confidence_score:100,match_method:'manual'};
const approved={...a,field_resolutions:{product_group:{catalogItemId:'target',description:a.description,brand:a.brand}}};
assert.equal(productGroupApproved(approved,item,mapping),true);assert.equal(productGroupApproved({...approved,description:'Tomato paste'},item,mapping),false);
const category={id:'cat',name:'Dry Goods',is_holding_pen:false},fields={item,mapping,category,categories:[category],peers:[b]};
const held=orderGuideAssessment({...fields,vendorItem:{...approved,pack_size:'',selling_unit:'',price:null,price_unavailable:true}});assert.equal(held.ready,false);assert.ok(held.blockers.includes('pack'));assert.ok(held.blockers.includes('quote'));assert.equal(held.blockers.includes('association'),false,'identity approval is separate from purchasing fields');
const mismatch=orderGuideAssessment({...fields,vendorItem:{...approved,description:'Tomato paste'}});assert.ok(mismatch.blockers.includes('association'));
console.log('PASS product association engine/service/readiness: complete coverage, examples, deterministic ordering, restrictions/rejections, independent fields, stale identity and industry-neutral data contract.');
