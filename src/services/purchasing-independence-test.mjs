// Module F: approved group identity never supplies another listing's fields.
import assert from 'node:assert/strict';
import {configureProcurement} from '../procurement.js';
import {orderGuideAssessment} from '../core/catalog-fields.js';
configureProcurement({industry:'restaurant'});
const category={id:'cat',name:'General',is_holding_pen:false};
const item={id:'group',name:'Pomace Oil',category_id:'cat',category_reason:'confirmed',category_review:false,comparison_mode:'alternatives',brand_locked:false};
const mapping={id:'map',catalog_item_id:item.id,vendor_item_id:'a',match_method:'manual',comparison_track:'exact',confidence_score:100};
function listing(id,pack,price=20){
 const description='Pomace Oil';return {id,vendor_id:'vendor-'+id,description,brand:null,pack_size:pack,price,selling_unit:'CASE',price_basis:'case',price_source:'price_list',price_unavailable:false,import_row:{reviewRequired:false},field_resolutions:{product_group:{catalogItemId:item.id,description,brand:null}}};
}
const a=listing('a','4/1 GAL'),b=listing('b','1/10 LB',30);
const assess=(row,peers=[],changes={})=>orderGuideAssessment({item,vendorItem:row,mapping:{...mapping,vendor_item_id:row.id},category,categories:[category],peers,...changes});
const before=structuredClone({a,b,item,mapping});
assert.equal(assess(a).ready,true);
assert.equal(assess(a,[b]).ready,true,'adding a valid different-dimension offer cannot hold an approved offer');
const incomplete={...b,pack_size:null,selling_unit:null,price_basis:null,price:null,price_unavailable:true};
assert.equal(assess(a,[incomplete]).ready,true,'adding an incomplete peer cannot hold the complete approved offer');
assert.equal(assess(incomplete,[a]).ready,false,'the incomplete listing cannot borrow the complete peer fields');
const original=assess(a,[b]);
for(const peer of [incomplete,{...b,pack_size:'24 CT',price:999,selling_unit:'EACH',price_basis:'each'}]){
 const result=assess(a,[peer]);assert.equal(result.ready,true);
 for(const key of ['product','pack','sellingUnit','price','unitCost'])assert.deepEqual(result.evidence[key],original.evidence[key],key+' must stay local to the assessed listing');
}
assert.deepEqual({a,b,item,mapping},before,'assessment must not mutate input evidence');
const tentative=assess(b,[a],{mapping:{...mapping,vendor_item_id:b.id,comparison_track:'review',confidence_score:70,match_method:'rule_based'}});
assert.equal(tentative.ready,false);assert.ok(tentative.blockers.includes('association'),'a conflicting tentative association cannot inherit approval from its peer');
assert.equal(assess(a,[incomplete],{item:{...item,brand_locked:true,locked_brand:'Required Brand'}}).ready,false,'identity approval cannot remove the client brand restriction');
// Exact-pack restrictions are explicit client policy, distinct from broad
// product grouping. Identifier corroboration improves evidence, not values.
const exactPack=assess(a,[b],{item:{...item,comparison_mode:'exact'}});assert.equal(exactPack.ready,false);assert.ok(exactPack.blockers.includes('pack'));
const identified={...a,gtin:'shared-trade-id'},witness={...b,gtin:'shared-trade-id',pack_size:a.pack_size,price:999};
const corroborated=assess(identified,[witness]);assert.equal(corroborated.evidence.pack.accuracy,100);assert.equal(corroborated.evidence.pack.value,a.pack_size);assert.equal(corroborated.evidence.price.value,a.price);
// Manual unit-cost approval belongs to one listing, not its group.
const overridden={...a,pack_size:null,selling_unit:null,price_basis:null,field_resolutions:{...a.field_resolutions,row_approval:true,unit_cost_override:{value:{price:2,unit:'LB',packPrice:20}}}};
assert.equal(assess(overridden,[incomplete]).ready,true);
const withoutOverride={...incomplete,price:30,price_unavailable:false};
const held=assess(withoutOverride,[overridden]);assert.equal(held.ready,false);assert.ok(held.blockers.includes('pack'));assert.ok(held.blockers.includes('sellingUnit'));
// Freshness is evaluated at the supplied assessment time. Ordering flags do
// not acquire an independent clock; the App mapping is exercised separately.
const dated={...a,price_quote_valid_until:'2026-11-02'};
assert.equal(assess(dated,[b],{now:new Date('2026-11-02T12:00:00Z')}).ready,true);
const expired=assess(dated,[b],{now:new Date('2026-11-03T12:00:00Z')});assert.equal(expired.ready,false);assert.ok(expired.blockers.includes('expired'));
assert.equal(assess(b,[dated],{now:new Date('2026-11-03T12:00:00Z')}).ready,true,'expired peer does not expire the current listing');
console.log('PASS F independence: complete/held/different-dimension peers, local field values/overrides, tentative association, brand restriction, immutable inputs and per-listing expiry');
