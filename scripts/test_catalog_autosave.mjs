import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
const dir=mkdtempSync(join(process.cwd(),'node_modules/.catalog-autosave-'));
try{
 await build({stdin:{contents:String.raw`
import React from 'react';import Renderer,{act} from 'react-test-renderer';import assert from 'node:assert/strict';
import {CatalogRows} from './src/pages/CatalogRows.jsx';import {ItemCatalogPanel} from './src/pages/ItemCatalogPanel.jsx';import {configureProcurement} from './src/procurement.js';import {orderGuideAssessment} from './src/core/catalog-fields.js';
import {PRICE_UNIT_CONFLICT_REASON} from './src/core/source-units.js';
configureProcurement({industry:'restaurant'});
const cache=new Map();globalThis.window={localStorage:{getItem:k=>cache.get(k)||null,setItem:(k,v)=>cache.set(k,v)}};
const org='00000000-0000-0000-0000-000000000001',id='00000000-0000-0000-0000-000000000011';
const item={id,name:'Honey Mustard',master_item_number:50013,category_id:'general',category_reason:'confirmed'};
const row={id:'vi',organization_id:org,vendor_id:'vendor',vendor_item_code:'000012',description:'HONEY MUSTARD',brand:'Original',pack_size:null,selling_unit:null,price_basis:null,price:2.29,price_unavailable:true,price_source:'price_list',last_updated:'2026-11-04',row_revision:1,field_resolutions:{}};
const mapping={id:'mapping',organization_id:org,vendor_item_id:row.id,catalog_item_id:id,comparison_track:'exact',confidence_score:100,match_method:'manual'};
const category={id:'general',name:'General',range_start:50000,range_end:59999,keywords:[]};
let current=structuredClone(row),fail=false,calls=[],refreshes=0;
globalThis.__autosaveBackend={records:{query(){throw Error('Unexpected read');}},catalog:{saveRow:async request=>{
 if(fail)throw Error('Offline: edits not saved');assert.equal(request.expectedRevision,current.row_revision,'each edit uses the latest accepted revision');calls.push(request);
 for(const [key,value]of Object.entries(request.patch)){current[key]=value;current.field_resolutions[key]={value,confirmedBy:'owner'};}
 current.price_basis=request.priceBasis;
 if(Object.hasOwn(request.patch,'price'))current.price_unavailable=!(Number(current.price)>0);
 current.row_revision++;return structuredClone(current);
}}};
const props={autoSave:true,userId:'owner',baseFieldsOnly:true,orgId:org,industry:'restaurant',items:[{catalogItemId:id}],catalogItems:[item],vendorItems:[row],mappings:[mapping],vendors:[{id:'vendor',name:'Supplier'}],categories:[category,{id:'dairy',name:'Dairy',range_start:30000,range_end:39999}],vocabulary:[],canManage:true,onUpdated:async()=>{refreshes++;},onDetails:()=>{}};
let tree;const mount=async more=>{await act(async()=>{tree=Renderer.create(React.createElement(CatalogRows,{...props,...more}));});await toggle(true);};
const input=label=>tree.root.findByProps({'aria-label':label});const change=async(label,value)=>{await act(async()=>input(label).props.onChange({target:{value}}));};
const toggle=async open=>{await act(async()=>tree.root.findByType('details').props.onToggle({currentTarget:{open}}));};
const pause=()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,850));});
const settle=async()=>{await toggle(false);await toggle(true);};
const text=n=>typeof n==='string'?n:(n?.children||[]).map(text).join('');
await mount();assert.equal(calls.length,0);assert.equal(tree.root.findAllByType('button').filter(b=>/^(Apply|Save)$/.test(text(b))).length,0);assert.ok(!tree.root.findAllByType('th').some(n=>text(n)==='Actions'));
assert.equal(tree.root.findAll(n=>String(n.props['aria-label']||'').startsWith('Group for')).length,0);assert.ok(!JSON.stringify(tree.toJSON()).includes('Confirmed group'));assert.ok(!JSON.stringify(tree.toJSON()).includes('Provisional group'));
assert.equal(input('Brand for 000012').props.value,'');assert.equal(input('Brand for 000012').props.placeholder,'No brand');assert.equal(input('Brand for 000012').props.disabled,false);assert.equal(input('Pack for 000012').props.value,'');assert.equal(text(input('Calculated unit cost for 000012')),'');assert.equal(tree.root.findAllByProps({'aria-label':'Unit cost for 000012'}).length,0);
assert.ok(input('Category for 000012').findAllByType('option').some(n=>text(n)==='Dairy'),'established client category is available without industry tagging');
assert.equal(current.brand,'Original','vendor brand stays on its listing and does not fill the catalog Brand field');
await change('price for 000012','3.50');await settle();assert.equal(calls.length,1);assert.deepEqual(calls.at(-1).patch,{price:3.5});assert.equal(current.selling_unit,null);assert.equal(current.pack_size,null);assert.equal(current.price_unavailable,false);
assert.equal(orderGuideAssessment({item,vendorItem:current,mapping,vendor:props.vendors[0],category,categories:props.categories}).ready,false);
await change('Pack for 000012','case');await change('Count for 000012','4');await change('Amount in each for 000012','1');await change('Each measurement for 000012','GAL');await settle();assert.ok(calls.at(-1).patch.pack_size);assert.ok(!Object.hasOwn(calls.at(-1).patch,'approve_row'));
assert.equal(tree.root.findAllByProps({'aria-label':'Quoted per for 000012'}).length,0);
current={...current,selling_unit:'CASE',price_basis:'case',price_unavailable:false,row_revision:current.row_revision+1,field_resolutions:{...current.field_resolutions,selling_unit:{value:'CASE',confirmedBy:'owner'}}};
await act(async()=>tree.update(React.createElement(CatalogRows,{...props,vendorItems:[current]})));
assert.equal(text(input('Calculated unit cost for 000012')),'$0.88','stored case basis still calculates unit cost');
assert.equal(orderGuideAssessment({item,vendorItem:current,mapping,vendor:props.vendors[0],category,categories:props.categories}).ready,true);
assert.ok(refreshes>=2);
fail=true;await change('price for 000012','4.25');await settle();assert.match(JSON.stringify(tree.toJSON()),/Offline: edits not saved/);assert.equal(Number(input('price for 000012').props.value),4.25);assert.equal(current.price,3.5);
await act(async()=>tree.unmount());assert.ok([...cache.values()].some(v=>JSON.parse(v).draft.price==='4.25'));
await mount({vendorItems:[structuredClone(current)]});assert.equal(Number(input('price for 000012').props.value),4.25,'failed edits survive remount for the same user/client/listing');fail=false;await change('price for 000012','4.50');await settle();assert.equal(current.price,4.5);await act(async()=>tree.unmount());
await mount({userId:'another-user',vendorItems:[structuredClone(current)],canManage:false});assert.equal(Number(input('price for 000012').props.value),4.5);assert.equal(input('Brand for 000012').props.disabled,true);const before=calls.length;await settle();assert.equal(calls.length,before);await act(async()=>tree.unmount());
await mount({vendorItems:[structuredClone(current)]});await change('price for 000012','5.00');await act(async()=>tree.unmount());assert.equal(current.price,5,'leaving the catalog saves the edited field once');
cache.clear();await mount({vendorItems:[structuredClone(current)]});await change('price for 000012','6.25');await settle();const external={...structuredClone(current),price:6.50,row_revision:current.row_revision+1};current=external;await act(async()=>tree.update(React.createElement(CatalogRows,{...props,vendorItems:[external]})));assert.equal(Number(input('price for 000012').props.value),6.5,'a newer incoming revision replaces a clean accepted snapshot');await act(async()=>tree.unmount());await mount({vendorItems:[{...external,price:6.75,row_revision:external.row_revision+1}]});assert.ok(!JSON.stringify(tree.toJSON()).includes('Review your recovered edits'),'a clean persisted visibility marker is not an unsaved conflict');await act(async()=>tree.unmount());
cache.clear();current={...structuredClone(row),pack_size:'4/1 GAL',selling_unit:'CASE',price_basis:'case',price_unavailable:false,field_resolutions:{unit_cost_override:{value:{price:123,unit:'GAL',packPrice:492}}}};await mount({vendorItems:[structuredClone(current)]});await change('price for 000012','7.00');await settle();assert.equal(calls.at(-1).patch.unit_cost_override,null,'a changed price invalidates an old unit-cost override so cost can recalculate');await act(async()=>tree.unmount());
const preferredWrites=[];
const branded={...structuredClone(current),brand:'House',field_resolutions:{...current.field_resolutions}};
await mount({vendorItems:[branded],onPreferBrand:async(itemId,brand)=>{preferredWrites.push({itemId,brand});return true;}});
const brandCell=()=>{let cell=input('Brand for 000012');while(cell.type!=='td')cell=cell.parent;return cell;};
const prefer=()=>brandCell().findAllByType('input').find(input=>input.props.type==='checkbox');
assert.equal(brandCell().findAllByType('input')[0].props.value,'','vendor brand never fills the client Brand control');
await change('Brand for 000012','USA');
assert.equal(prefer().props.checked,false);
await act(async()=>prefer().props.onChange({target:{checked:true}}));
assert.deepEqual(calls.at(-1).patch,{brand:'USA'});assert.deepEqual(preferredWrites,[{itemId:id,brand:'USA'}]);
const other={...branded,id:'other',vendor_item_code:'000013',brand:'Other',field_resolutions:{}};
const acceptedBrand={...branded,brand:'USA',pack_size:'4/5 LB',selling_unit:'CASE',price:16.75,row_revision:current.row_revision,field_resolutions:{...branded.field_resolutions,brand:{value:'USA',confirmedBy:'owner'},selling_unit:{value:'CASE',confirmedBy:'owner'}}};
await act(async()=>tree.update(React.createElement(CatalogRows,{...props,catalogItems:[{...item,preferred_brand:'USA',brand_locked:true,locked_brand:'USA'}],vendorItems:[acceptedBrand,other],mappings:[mapping,{...mapping,id:'mapping-other',vendor_item_id:'other'}],
 onPreferBrand:async(itemId,brand)=>{preferredWrites.push({itemId,brand});return true;}})));
assert.equal(input('Brand for 000012').props.value,'USA');
assert.equal(input('Brand for 000013').props.value,'','the preferred brand does not fill another vendor row');
assert.equal(prefer().props.checked,true);
await act(async()=>prefer().props.onChange({target:{checked:false}}));
assert.deepEqual(preferredWrites.at(-1),{itemId:id,brand:null});
await act(async()=>tree.update(React.createElement(CatalogRows,{...props,baseFieldsOnly:false,catalogItems:[{...item,preferred_brand:null,brand_locked:false,locked_brand:null}],vendorItems:[acceptedBrand,other],mappings:[mapping,{...mapping,id:'mapping-other',vendor_item_id:'other'}],
 onPreferBrand:async(itemId,brand)=>{preferredWrites.push({itemId,brand});return true;}})));
await change('Brand for 000012','');
const beforeClear=calls.length;
await act(async()=>tree.root.findByProps({'aria-label':'Confirm listing 000012'}).props.onClick());
assert.equal(calls.length,beforeClear+1,'confirm saves the cleared brand: '+tree.root.findAllByProps({role:'alert'}).map(text).join(' | '));
assert.equal(calls.at(-1).patch.brand,'','clearing and confirming removes only this vendor brand');
assert.equal(input('Brand for 000013').props.value,'','another vendor row stays blank and editable');
assert.equal(input('Brand for 000013').props.disabled,false);
await act(async()=>tree.unmount());
const panel={...props,role:'owner',productList:[{catalogItemId:id,name:item.name,category:'General',options:[]}],vendorItems:[structuredClone(current)]};await act(async()=>{tree=Renderer.create(React.createElement(ItemCatalogPanel,panel));});const button=label=>tree.root.findAllByType('button').find(n=>text(n)===label);await act(async()=>button('Base fields trial').props.onClick());assert.equal(tree.root.findAllByProps({'aria-label':'Item catalog actions'}).length,0,'base trial has no Actions menu');assert.equal(tree.root.findAllByType('button').filter(b=>text(b)==='Apply').length,0);await act(async()=>tree.unmount());
cache.clear();current={...structuredClone(row),brand:null,pack_size:'4/5 LB',selling_unit:'LB',price:2.41,import_row:{baseFieldCompletion:{fields:{brand:{value:null,status:'not-stated'},pack_size:{value:'4/5 LB',status:'stated'},selling_unit:{value:null,status:'not-stated'}}}}};await mount({vendorItems:[structuredClone(current)]});assert.equal(input('Brand for 000012').props.placeholder,'No brand');assert.equal(input('Pack for 000012').props.value,'case');assert.equal(text(input('Calculated unit cost for 000012')),'','source trial cannot calculate from an older inferred unit');await act(async()=>tree.unmount());
cache.clear();current={...structuredClone(row),brand:null,pack_size:null,selling_unit:null,price:60,import_row:{baseFieldCompletion:{fields:{brand:{value:'Example Brand',status:'shared'},pack_size:{value:'6/#10 CN',status:'stated',caseCountKnown:true},selling_unit:{value:'CASE',status:'stated'}}}}};const countBeforeSource=calls.length;await mount({vendorItems:[structuredClone(current)]});assert.equal(input('Brand for 000012').props.value,'','source-inferred vendor brand does not fill client Brand');assert.equal(input('Pack for 000012').props.value,'case');assert.equal(text(input('Calculated unit cost for 000012')),'$10.00');assert.equal(calls.length,countBeforeSource,'source trial display performs no save on mount');await act(async()=>tree.unmount());
cache.clear();current={...structuredClone(row),pack_size:'5 LB',selling_unit:'CASE',import_row:{baseFieldCompletion:{fields:{pack_size:{value:'5 LB',status:'shared',caseCountKnown:false},selling_unit:{value:'CASE',status:'shared'}}}}};await mount({vendorItems:[structuredClone(current)]});assert.equal(text(input('Calculated unit cost for 000012')),'','a weight-only fallback does not supply a missing case count');await act(async()=>tree.unmount());
cache.clear();current={...structuredClone(row),vendor_item_code:'THYME',description:'1LB (COL)',price:99,import_row:{baseFieldCompletion:{trialIdentifier:{label:'NVIM-332'},fields:{description:{value:'THYME 1LB (COL)'},price:{value:11.5},pack_size:{value:'1 LB',caseCountKnown:false},selling_unit:{value:'EACH'}}}}};const sourceSnapshot=JSON.stringify(current),sourceCalls=calls.length;
await mount({vendorItems:[structuredClone(current)]});assert.match(JSON.stringify(tree.toJSON()),/NVIN-332/);assert.equal(input('product for THYME').props.value,'THYME 1LB (COL)');assert.equal(Number(input('price for THYME').props.value),11.5);assert.equal(text(input('Calculated unit cost for THYME')),'$11.50');await act(async()=>tree.unmount());
await mount({baseFieldsOnly:false,vendorItems:[structuredClone(current)]});assert.equal(input('product for THYME').props.value,'1LB (COL)');assert.equal(Number(input('price for THYME').props.value),99);assert.ok(!JSON.stringify(tree.toJSON()).includes('NVIN-332'),'trial identifier does not leak into full catalog');await act(async()=>tree.unmount());assert.equal(calls.length,sourceCalls);assert.equal(JSON.stringify(current),sourceSnapshot,'reading the trial never rewrites the full listing');
cache.clear();current={...structuredClone(row),description:'STEEL WASHERS',pack_size:'4/10 LB',selling_unit:'CASE',price_basis:'case',price:81,price_unavailable:false,
 import_row:{row:{sellingUnit:null},reviewRequired:true,evidence:{sellingUnitSource:'inferred',fieldInference:{sellingUnit:{source:'cross-vendor comparison',value:'CASE',accuracy:70,reason:'Compared with two confirmed vendor quotes'}}},baseFieldCompletion:{fields:{pack_size:{value:'4/10 LB',status:'stated',caseCountKnown:true},selling_unit:{value:null,status:'not-stated'}}}}};
await mount({vendorItems:[structuredClone(current)]});
assert.equal(orderGuideAssessment({item,vendorItem:current,mapping,vendor:props.vendors[0],category,categories:props.categories}).ready,false);
assert.equal(current.import_row.row.sellingUnit,null,'viewing the listing preserves the vendor original');
await act(async()=>tree.unmount());
current={...current,field_resolutions:{price:{value:81,confirmedBy:'owner'}}};
await mount({baseFieldsOnly:false,vendorItems:[structuredClone(current)],editors:{owner:{name:'Kai Morgan',email:'orders@example.com'}}});
const priceCell=tree.root.find(n=>n.type==='td'&&n.props['data-field-label']==='Quoted price');
assert.doesNotMatch(text(priceCell),/Kai Morgan/,'the catalog does not display the editor name');
const costCell=tree.root.find(n=>n.type==='td'&&n.props['data-field-label']==='Unit cost');
assert.doesNotMatch(text(costCell),/per pounds/i,'the measurement selector provides the unit once');
await act(async()=>tree.unmount());
const tierBase={...row,pack_size:'4/1 GAL',price:20,price_unavailable:false,price_basis:'case',selling_unit:'CASE'};
const tierListings=[
 {...tierBase,id:'held',vendor_item_code:'A',price:null,import_row:{reviewRequired:true,changes:[{field:'description',before:'HONEY MUSTARD',after:'STEEL WASHERS'}]}},
 {...tierBase,id:'no-unit',vendor_item_code:'B',selling_unit:null,import_row:{rowKey:'B',sourceDocumentId:'doc',row:{price:20}}},
 {...tierBase,id:'inferred',vendor_item_code:'C',price_unavailable:true,import_row:{reviewRequired:true,reviewFields:['description','brand','pack_size','selling_unit','price'],conflicts:['Pricing basis "CASE" suggested but not confirmed'],evidence:{sellingUnitSource:'inferred'}}},
 {...tierBase,id:'full',vendor_item_code:'D',field_resolutions:{selling_unit:{value:'CASE',confirmedBy:'owner'}}},
];
await mount({baseFieldsOnly:false,vendorItems:tierListings,mappings:tierListings.map(v=>({...mapping,id:v.id,vendor_item_id:v.id}))});
const tierRows=tree.root.findAll(n=>n.type==='tr'&&n.props['data-migration-tier']!=null);
assert.deepEqual(tierRows.map(n=>n.props['data-migration-tier']),[1,2,3,3]);
const tierCells=tierRows.map(row=>row.findByProps({'data-field-label':'Item name'}));
assert.deepEqual(tierCells.map(cell=>cell.findAllByType('small').filter(label=>!label.props['data-item-name-origin']).map(text).join('')),
  ['Tier 1 · Confirmed', 'Tier 2 · Inferred Migration','Tier 3 · Client Required Migration','Tier 3 · Client Required Migration']);
assert.ok(tierCells.every(cell=>text(cell.findByProps({'data-item-name-origin':'inferred'}))==='Inferred'));
assert.equal(tierCells[0].findByProps({'data-item-name-origin':'inferred'}).props.title,
  "KERDOS named this from the vendor's description; rename it when you like.");
assert.deepEqual(tierCells.map(cell=>cell.findAllByType('button').map(text)),[['Confirm'],['Confirm'],[],[]]);
assert.deepEqual(tierCells.map(cell=>cell.findAllByProps({'aria-label':'Pricing basis'}).length),[0,0,0,1]);
assert.ok(!tree.root.findAllByType('th').some(n=>text(n).includes('Quoted per')));

assert.deepEqual(tierRows.map(n=>n.findAllByType('td').filter(c=>c.props['data-catalog-review-field']).map(c=>c.props['data-field-label'])),[[],[],['Quoted price'],[]],
 'an unresolved pricing basis does not highlight the unrelated unit-cost metric');
assert.match(tree.root.findByType('style').children.join(''),/\[data-catalog-review-field\] :is\(input, select\):enabled \{ background-color: #E3F2FD; box-shadow: inset 0 0 0 2px #1565C0; \}/,'flagged writable controls use one blue fill and border');
for(const n of tierRows)assert.ok(n.findAllByType('td').every(cell=>!cell.props.style.backgroundColor),'surrounding cells stay neutral');
await act(async()=>tree.unmount());
cache.clear();
const pricedListing={...tierBase,field_resolutions:{selling_unit:{value:'CASE',confirmedBy:'owner'}}};
const brandLocked={...item,brand_locked:true,locked_brand:'Preferred'};
await mount({baseFieldsOnly:false,catalogItems:[brandLocked],vendorItems:[pricedListing]});
assert.ok(tree.root.findByProps({'data-migration-tier':2}));
assert.match(text(tree.toJSON()),/Resolve brand conflict/);
assert.equal(text(input('Calculated unit cost for 000012')),'$5.00','a separate brand conflict preserves the supported cost');
assert.equal(tree.root.findAllByProps({'aria-label':'Confirm listing 000012'}).length,0);
assert.equal(orderGuideAssessment({item:brandLocked,vendorItem:pricedListing,mapping,vendor:props.vendors[0],category,categories:props.categories}).ready,false);
await act(async()=>tree.unmount());
const associationReviews=[];
await mount({baseFieldsOnly:false,catalogItems:[{...item,name:'Steel Washers'}],vendorItems:[pricedListing],
 mappings:[{...mapping,comparison_track:'review'}],onDetails:itemId=>associationReviews.push(itemId)});
assert.ok(tree.root.findByProps({'data-migration-tier':2}));
assert.equal(text(input('Calculated unit cost for 000012')),'$5.00','a separate association conflict preserves the supported cost');
const beforeAssociationReview=calls.length;
await act(async()=>tree.root.findAllByType('button').find(button=>text(button)==='Review association').props.onClick());
assert.deepEqual(associationReviews,[id]);
assert.equal(calls.length,beforeAssociationReview,'opening an association review does not approve the row');
await act(async()=>tree.unmount());
await mount({baseFieldsOnly:false,vendorItems:[{...pricedListing,pack_size:null}]});
assert.ok(tree.root.findByProps({'data-migration-tier':3}));
assert.match(text(tree.root.findByProps({'data-field-label':'Pack'})),/Fix pack/);
assert.equal(Number(input('price for 000012').props.value),20,'a missing pack leaves the supplied price visible');
await act(async()=>tree.unmount());
cache.clear();calls.length=0;
const baconItem={...item,id,brand_locked:true,locked_brand:'Wrights',preferred_brand:'Wrights'};
const baconPeers=[55.9,44.99].map((price,i)=>({...row,id:'bacon-peer-'+i,vendor_id:'other-'+i,
 vendor_item_code:'CASE-'+i,description:'BACON LAYOUT',brand:'Other',pack_size:'15 LB',price,
 selling_unit:'CASE',price_basis:'case',price_unavailable:false,last_updated:'2026-11-12',
 import_row:{sourceDocumentId:'peer-doc-'+i,reviewRequired:false,row:{sellingUnit:'CASE',packSize:'15 LB',price}}}));
current={...structuredClone(row),description:'BACON LAYOUT 18/22',brand:'Wrights',pack_size:'15 LB',
 price:null,selling_unit:null,price_basis:null,price_unavailable:true,field_resolutions:{brand:{value:'Wrights',confirmedBy:'owner'}},
 import_row:{sourceDocumentId:'bacon-doc',rowKey:'row:2',reviewRequired:false,row:{description:'BACON LAYOUT 18/22',
 packSize:'15 LB',price:null,priceUnavailable:true,sellingUnit:null}}};
const baconMappings=[mapping,...baconPeers.map((peer,i)=>({...mapping,id:'peer-map-'+i,vendor_item_id:peer.id}))];
const baconProps={baseFieldsOnly:false,catalogItems:[baconItem],vendorItems:[structuredClone(current),...baconPeers],
 mappings:baconMappings,vendors:[props.vendors[0],...baconPeers.map(p=>({id:p.vendor_id,name:p.vendor_id}))],
 editors:{owner:{name:'Kai Morgan'}},onPreferBrand:async()=>true};
await mount(baconProps);await change('price for 000012','2');await change('price for 000012','2.');
await change('price for 000012','2.97');assert.equal(input('price for 000012').props.value,'2.97');
assert.equal(calls.length,0,'typing does not write to the server or interrupt the edit');
assert.equal(text(input('Calculated unit cost for 000012')),'$2.97/lb');
await act(async()=>tree.root.findByProps({'aria-label':'Confirm pricing basis'}).props.onClick());
assert.equal(calls.length,1,'one confirmation writes once');
assert.equal(calls[0].patch.price,2.97);assert.equal(calls[0].patch.selling_unit,'LB');
assert.equal(calls[0].patch.approve_row,true);assert.equal(Object.hasOwn(calls[0].patch,'pack_size'),false);
assert.equal(tree.root.findAllByProps({'aria-label':'Pricing basis'}).length,0,'no extra selector when peers establish one basis');
await act(async()=>tree.update(React.createElement(CatalogRows,{...props,...baconProps,
 vendorItems:[structuredClone(current),...baconPeers]})));
const accepted=tree.root.findAll(n=>n.type==='tr'&&n.props['data-migration-tier']===1)
 .find(n=>n.findAllByProps({'aria-label':'price for 000012'}).length);
assert.ok(accepted,'the confirmed listing moves to Tier 1');
assert.equal(accepted.findAll(n=>n.type==='td'&&n.props['data-catalog-review-field']).length,0,'blue review fields clear');
assert.equal(text(accepted.findByProps({'data-field-label':'Brand'})).includes('KM'),true);
assert.equal(text(accepted.findByProps({'data-field-label':'Quoted price'})).includes('KM'),true);
assert.equal(text(accepted.findByProps({'data-field-label':'Pack'})).includes('KM'),false,'unchanged pack is not attributed');
await change('Brand for 000012','');
const checked=tree.root.findByProps({'aria-label':'Brand for 000012'}).parent.findAllByType('input').find(n=>n.props.type==='checkbox');
assert.equal(checked.props.disabled,false,'a preferred brand can still be unchecked after clearing its text');
await act(async()=>checked.props.onChange({target:{checked:false}}));
await act(async()=>tree.update(React.createElement(CatalogRows,{...props,...baconProps,
 catalogItems:[{...baconItem,brand_locked:false,locked_brand:null,preferred_brand:null}],
 vendorItems:[structuredClone(current),...baconPeers]})));
await act(async()=>tree.root.findByProps({'aria-label':'Confirm listing 000012'}).props.onClick());
assert.equal(calls.at(-1).patch.brand,'','confirm clears this listing brand after removing the preference');
assert.equal(current.selling_unit,'LB');assert.equal(current.price,2.97);
await act(async()=>tree.update(React.createElement(CatalogRows,{...props,...baconProps,
 catalogItems:[{...baconItem,brand_locked:false,locked_brand:null,preferred_brand:null}],
 vendorItems:[structuredClone(current),...baconPeers]})));
assert.ok(tree.root.findAll(n=>n.type==='tr'&&n.props['data-migration-tier']===1)
 .some(n=>n.findAllByProps({'aria-label':'price for 000012'}).length),
 'clearing a preferred brand does not undo a confirmed pricing basis');
await act(async()=>tree.unmount());
const tierPanel={...props,role:'owner',productList:[{catalogItemId:id,name:item.name,category:'General',options:[]}],
 vendorItems:tierListings,mappings:tierListings.map(v=>({...mapping,id:v.id,vendor_item_id:v.id}))};
await act(async()=>{tree=Renderer.create(React.createElement(ItemCatalogPanel,tierPanel));});
const visibleTiers=()=>tree.root.findAll(n=>n.type==='tr'&&n.props['data-migration-tier']!=null).map(n=>n.props['data-migration-tier']);
const writesBeforeFilter=calls.length;
for(const tier of [1,2,3]){
 await change('Sort',String(tier));
 assert.deepEqual(visibleTiers(),tier===3?[3,3]:[tier],'a mixed-tier group shows only its matching vendor listings');
 assert.equal(tree.root.findAllByProps({'data-catalog-group':id}).length,1,'retain the shared KERDOS group');
}
await change('Sort','alphabetical');
assert.deepEqual(visibleTiers(),[1,2,3,3]);
assert.equal(calls.length,writesBeforeFilter,'tier browsing does not write listings');
await act(async()=>tree.unmount());
cache.clear();
current={...structuredClone(row),pack_size:'6/5 LB',price:51.64,selling_unit:null,price_basis:null,price_unavailable:false,
 import_row:{sourceDocumentId:'case-price-sheet',rowKey:'row:0',row:{price:51.64,packSize:'6/5 LB',priceHeader:'Case Price'}}};
const rawPackQuote=structuredClone(current),writesBeforePackQuote=calls.length;
await mount({baseFieldsOnly:false,vendorItems:[structuredClone(current)]});
assert.equal(text(input('Calculated unit cost for 000012')),'$8.61');
assert.equal(input('Unit cost metric for 000012').props.value,'EA');
assert.deepEqual(current,rawPackQuote);
assert.equal(calls.length,writesBeforePackQuote,'reading a verified full-pack price performs no write');
await act(async()=>input('Confirm listing 000012').props.onClick());
assert.equal(calls.length,writesBeforePackQuote+1);
assert.equal(calls.at(-1).patch.selling_unit,'CASE');
assert.equal(tree.root.findAllByProps({'aria-label':'Pricing basis'}).length,0,'Confirm uses the verified source evidence');
await act(async()=>tree.unmount());
cache.clear();
current={...rawPackQuote,price_unavailable:true,import_row:{...rawPackQuote.import_row,reviewRequired:true,
 conflicts:['Quoted unit is unresolved.'],row:{...rawPackQuote.import_row.row,priceHeader:'Price',sellingUnit:'P'}}};
await mount({baseFieldsOnly:false,vendorItems:[structuredClone(current)]});
const unresolvedCost=tree.root.findByProps({'data-field-label':'Unit cost'});
assert.match(text(unresolvedCost),/Choose what the price covers/);
assert.doesNotMatch(text(unresolvedCost),/Empty/);
assert.equal(text(input('Calculated unit cost for 000012')),'');
await act(async()=>tree.unmount());
cache.clear();
current={...tierBase,id:row.id,vendor_item_code:row.vendor_item_code,pack_size:'4/5 LB',
 field_resolutions:{selling_unit:{value:'CASE',confirmedBy:'owner'}},
 import_row:{evidence:{packSource:'description'},row:{price:20,packSize:'4/5 LB',sellingUnit:'CASE'}}};
await mount({baseFieldsOnly:false,vendorItems:[structuredClone(current)]});
assert.equal(tree.root.findByProps({'data-migration-tier':2}).props['data-migration-tier'],2);
await act(async()=>input('Confirm listing 000012').props.onClick());
assert.deepEqual(calls.at(-1).patch,{approve_row:true,pack_size:'4/5 LB'},'confirm records the inferred pack even when its value was already saved');
await act(async()=>tree.unmount());
cache.clear();
current={...row,description:'PORK LINK',pack_size:'5-LBS',price:15.95,price_unavailable:false};
await mount({baseFieldsOnly:false,vendorItems:[structuredClone(current)]});
assert.deepEqual(input('Pricing basis').findAllByType('option').map(text),['Choose price unit','$15.95 · per case','$15.95 · per lb']);
await act(async()=>tree.unmount());
cache.clear();
current={...row,description:'PORK LINK',pack_size:'5-LBS',price:15.95,selling_unit:'LB',price_basis:'measure',price_unavailable:false,
 import_row:{reviewRequired:true,reviewFields:['selling_unit'],conflicts:[PRICE_UNIT_CONFLICT_REASON],
  row:{price:15.95,sourceLine:'PORK LINK | 5-LBS | LB | 15.95/CS'}}};
await mount({baseFieldsOnly:false,vendorItems:[structuredClone(current)]});
assert.match(text(tree.toJSON()),/Review conflicting price units/);
assert.match(text(tree.toJSON()),/15\.95\/CS/);
assert.equal(text(input('Calculated unit cost for 000012')),'','contradictory declarations do not display a chosen cost');
await act(async()=>input('Pricing basis').props.onChange({target:{value:'CASE'}}));
assert.deepEqual(calls.at(-1).patch,{selling_unit:'CASE'},'the buyer chooses one field without approving the whole row');
await act(async()=>tree.unmount());
console.log('PASS catalog autosave: unchanged columns, editable blank source fields, calculated unit cost, no group/status/action additions, established client categories, delayed partial writes, fresh revisions, no unit invention/blanket approval, readiness after field completion, persistent failed drafts, actor isolation, read-only roles and unmount cancellation.');
`,resolveDir:process.cwd(),sourcefile:'autosave-test.mjs',loader:'js'},outfile:join(dir,'test.mjs'),bundle:true,platform:'node',format:'esm',jsx:'automatic',external:['react','react-dom','react-test-renderer'],logLevel:'silent',plugins:[{name:'autosave-backend',setup(b){b.onResolve({filter:/backend\/index\.js$/},()=>({path:'backend',namespace:'autosave'}));b.onLoad({filter:/.*/,namespace:'autosave'},()=>({contents:'export const backend={records:{query:(...args)=>globalThis.__autosaveBackend.records.query(...args)},catalog:{saveRow:(...args)=>globalThis.__autosaveBackend.catalog.saveRow(...args)}};'}));}}]});
 process.stdout.write(execFileSync(process.execPath,[join(dir,'test.mjs')],{encoding:'utf8',timeout:60000}));
}finally{rmSync(dir,{recursive:true,force:true});}
