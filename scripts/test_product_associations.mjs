import assert from 'node:assert/strict';
import {configureProcurement} from '../src/procurement.js';
import {buildProductAssociations,productGroupApproved,productAssociationIdentity,associationProfile} from '../src/core/product-associations.js';
import {productGroupRequest} from '../src/services/product-associations.js';
import {orderGuideAssessment} from '../src/core/catalog-fields.js';
configureProcurement({industry:'restaurant'});
for(const brand of ['Heinz',"Ken's",'Daisy','Windex'])assert.equal(productAssociationIdentity({description:brand},associationProfile('restaurant')).key,null,'brand-only text never creates a product group');
for(const [description,label] of [['Heinz Ketchup','ketchup'],['Bounty Paper Towels','Paper Towels'],['B3339XH H.D TUFF LINER','Trash Bags'],['(275) GRN HERTG. T.TISS','Toilet Tissue']])assert.equal(productAssociationIdentity({description},associationProfile('restaurant')).label.toLowerCase(),label.toLowerCase());
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
assert.equal(group.disposition,'proposed');
const placed=input([a,b]);
for(const row of placed.vendorItems)row.field_resolutions={product_group:{catalogItemId:'ca',description:row.description,brand:row.brand,confirmed:false}};
for(const mapping of placed.mappings)mapping.catalog_item_id='ca';
const [awaiting]=buildProductAssociations(placed).groups;
assert.equal(awaiting.disposition,'awaiting_confirmation');
assert.equal(awaiting.needsApply,false);
assert.equal(awaiting.canSave,true);
const linked=structuredClone(placed);
for(const row of linked.vendorItems)row.field_resolutions={};
const [retained]=buildProductAssociations(linked).groups;
assert.equal(retained.disposition,'retained','an existing catalog link is not evidence of client confirmation');

const confirmed=structuredClone(placed);
for(const row of confirmed.vendorItems)row.field_resolutions.product_group.confirmed=true;
for(const mapping of confirmed.mappings)Object.assign(mapping,{comparison_track:'exact',confidence_score:100,match_method:'manual'});
confirmed.vendorItems.push(c);
confirmed.catalogItems.push({id:'cc',name:c.description,master_item_number:102,comparison_mode:'alternatives'});
confirmed.mappings.push({id:'mc',vendor_item_id:'c',catalog_item_id:'cc'});
const accepted=buildProductAssociations(confirmed).groups.find(g=>g.rows.some(r=>r.id==='a'));
assert.equal(accepted.disposition,'confirmed');
assert.deepEqual(accepted.rows.map(row=>row.id),['a','b'],'a new candidate cannot absorb a current confirmed group');
assert.equal(accepted.canSave,false);
const stale=structuredClone(confirmed);
stale.vendorItems[0].description='CHICKEN THIGH';
stale.vendorItems[0].field_resolutions.catalog_item_id={value:'ca',confirmedBy:'client'};
const previous=buildProductAssociations(stale).groups.find(g=>g.rows.some(r=>r.id==='a'));
assert.equal(previous.disposition,'retained','a stale confirmation cannot certify the updated description');

const request=productGroupRequest(group,source.mappings,{organizationId:'org',requestId:'request',confirmed:true});assert.equal(request.members.length,3);assert.equal(request.confirmed,true);assert.equal(Object.hasOwn(request,'price'),false);
assert.equal(productGroupRequest(group,source.mappings,{organizationId:'org',requestId:'apply',confirmed:false}).confirmed,false);
assert.throws(()=>productGroupRequest(group,source.mappings,{organizationId:'org',requestId:'r'}),/confirmation choice/);

assert.throws(()=>productGroupRequest(group,[],{organizationId:'org',requestId:'r',confirmed:true}),/current catalog/);
for(const descriptions of [['CHICKEN BREAST BONELESS','CHICKEN THIGH BONELESS'],['TOMATO PASTE','TOMATO SAUCE'],['PEANUT BUTTER','BUTTER']]){
 const fixture=input(descriptions.map((d,i)=>row(String(i),d)));
 // Different products remain separate; presentation details belong to listings.
 const result=buildProductAssociations(fixture);
 assert.equal(result.groups.length,2,descriptions.join(' vs '));
}
for(const descriptions of [['MILK 1%','MILK 2%'],['CHEESE AMERICAN SLICED','AMERICAN CHEESE'],['CHEESE PEPPER JACK LOAF','CHEESE PEPPER JACK'],["BLUE CHEESE CHUNKY KEN'S",'BLUE CHEESE DRESSING']]){
 const grouped=buildProductAssociations(input(descriptions.map((description,i)=>row(String(i),description))));
 assert.equal(grouped.groups.length,1,descriptions.join(' vs '));
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
assert.equal(productGroupApproved(approved,item,mapping),true);
assert.equal(productGroupApproved({...approved,field_resolutions:{product_group:{...approved.field_resolutions.product_group,confirmed:false}}},item,mapping),
 false,'an unconfirmed placement cannot act as a client identity approval even with exact mapping metadata');
assert.equal(productGroupApproved({...approved,description:'Tomato paste'},item,mapping),false);
const category={id:'cat',name:'Dry Goods',is_holding_pen:false},fields={item,mapping,category,categories:[category],peers:[b]};
const held=orderGuideAssessment({...fields,vendorItem:{...approved,pack_size:'',selling_unit:'',price:null,price_unavailable:true}});assert.equal(held.ready,false);assert.ok(held.blockers.includes('pack'));assert.ok(held.blockers.includes('quote'));assert.equal(held.blockers.includes('association'),false,'identity approval is separate from purchasing fields');
const mismatch=orderGuideAssessment({...fields,vendorItem:{...approved,description:'Tomato paste'}});assert.ok(mismatch.blockers.includes('association'));
// Explicitly accepted product groups permit different valid packs, without
// granting missing quote/unit/pack fields any approval.
const complete={...approved,organization_id:'org',vendor_id:'a',pack_size:'4/1 GAL',selling_unit:'CASE',price:20,price_basis:'case',price_source:'price_list',last_updated:new Date().toISOString(),import_row:{reviewRequired:false}};
const different={...complete,id:'peer',vendor_id:'b',pack_size:'4/3 L',description:'OIL POMACE 100%',field_resolutions:{}};
const groupedFields={...fields,item:{...item,category_reason:'confirmed'},vendorItem:complete,peers:[different]};
assert.equal(orderGuideAssessment(groupedFields).evidence.pack.accuracy>=90,true,'accepted group does not treat different purchasing packs as a source conflict');
assert.equal(orderGuideAssessment({...groupedFields,vendorItem:{...complete,selling_unit:null,price_basis:null}}).ready,false,'accepting identity does not supply a quoted unit');
console.log('PASS product association engine/service/readiness: complete coverage, examples, deterministic ordering, restrictions/rejections, independent fields, stale identity and industry-neutral data contract.');
