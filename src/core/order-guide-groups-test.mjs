import assert from 'node:assert/strict';
import {orderGuideGroups,orderGuideCategories} from './order-guide-groups.js';
import {orderable,solveOrder} from './ordering.js';
const ready={vendorItemId:'v1',vendorId:'vendor-a',vendorName:'A',description:'Supplier wording',vendorItemCode:'CODE1',casePrice:20,packSize:'4/1 GAL',matchTrack:'exact',matchConfidence:100,unverified:false};
const held={...ready,vendorItemId:'v2',vendorId:'vendor-b',vendorName:'B',description:'Honey Mustrd KENS',matchTrack:'review',matchConfidence:70,unverified:true};
const products=[
 {catalogItemId:'z',name:'Zucchini',masterItemNumber:300012,category:'Produce',hasProductIdentity:true,options:[ready]},
 {catalogItemId:'h',name:'Honey Mustard Dressing',masterItemNumber:50013,category:'Frozen',hasProductIdentity:true,options:[held]},
 {catalogItemId:'a',name:'Avocado',masterItemNumber:300006,category:'Produce',hasProductIdentity:true,options:[{...held,vendorItemId:'v3',description:'AVOCADO HASS'}]},
 {catalogItemId:'u',name:'USA',masterItemNumber:900001,category:'Other',hasProductIdentity:false,options:[held]},
 {catalogItemId:'e',name:'Empty catalog entry',masterItemNumber:900002,category:'Other',hasProductIdentity:true,options:[]},
];
const before=JSON.stringify(products),result=orderGuideGroups(products)[0].items;
assert.deepEqual(result.map(i=>i.name),['Avocado','Honey Mustard Dressing','Zucchini']);
assert.deepEqual(result.map(i=>i.masterItemNumber),[300006,50013,300012],'existing KERDOS numbers are retained');
assert.equal(result[1].options.length,0);assert.equal(result[1].linkedOptions.length,1);assert.equal(orderable(result[1].linkedOptions[0]),false);
assert.equal(solveOrder([{...result[1],quantity:1,orderUnit:'case'}],[])[0].unorderable,true,'visibility cannot make a held product orderable');
assert.deepEqual(orderGuideCategories(products),['Frozen','Produce'],'held groups remain available in category filters');
assert.deepEqual(orderGuideGroups(products,{vendor:'vendor-b'})[0].items.map(i=>i.name),['Avocado','Honey Mustard Dressing']);
assert.deepEqual(orderGuideGroups(products,{search:'mustrd'})[0].items.map(i=>i.name),['Honey Mustard Dressing']);
assert.equal(orderGuideGroups(products,{search:'50013'})[0].items[0].catalogItemId,'h');
assert.deepEqual(orderGuideGroups(products,{category:'Frozen'})[0].items.map(i=>i.name),['Honey Mustard Dressing']);
assert.deepEqual(orderGuideGroups(products,{search:'not a saved product'}),[]);
assert.equal(JSON.stringify(products),before,'browse/sort never edits source objects or approvals');
assert.deepEqual(orderGuideGroups([{...products[0],name:'(Zucchini)'},{...products[1],name:'-- Avocado'}])[0].items.map(i=>i.name),['-- Avocado','(Zucchini)'],'source punctuation must not displace alphabetical product names');
console.log('PASS Order Guide groups: alphabetical canonical items, permanent numbers, held-vendor visibility/filtering/search, unresolved exclusion and unchanged purchasing gates.');
