import assert from 'node:assert/strict';
import {createDraftRecoveryStore,draftSaveDefinitelyFailed} from './draft-recovery-store.js';
function memory(){const values=new Map();return {get length(){return values.size;},key:i=>[...values.keys()][i],getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};}
const storage=memory(),a=createDraftRecoveryStore(storage,'org-a','user-a'),b=createDraftRecoveryStore(storage,'org-b','user-a'),c=createDraftRecoveryStore(storage,'org-a','user-b');
const intent=id=>({kind:'estimated_purchase_draft_intent',version:1,organizationId:'org-a',vendorId:'vendor',requestId:id,lines:[{terms:{organizationId:'org-a',vendorId:'vendor'}}]});
assert.deepEqual(a.readBasket(),{vendorId:'',quantities:{}});a.saveBasket({vendorId:'vendor',quantities:{vi:'2'}});assert.equal(a.readBasket().quantities.vi,'2');assert.equal(b.readBasket().vendorId,'');assert.equal(c.readBasket().vendorId,'');
a.retain(intent('one'));a.retain(intent('two'));assert.equal(a.pending().length,2,'different requests and tabs cannot overwrite another pending request');assert.equal(b.pending().length,0);assert.equal(c.pending().length,0);
assert.equal(a.retain({...intent('bad'),organizationId:'org-b'}),false);assert.equal(a.retain({...intent('empty'),lines:[]}),false);
a.settle(a.pending()[0],'saved','draft');assert.equal(a.pending().length,1);a.settle(a.pending()[0],'failed');assert.equal(a.pending().length,0);
a.saveConfirmations([{terms:{organizationId:'org-a'}}]);assert.equal(a.readConfirmations().length,1);assert.equal(b.readConfirmations().length,0);assert.equal(a.saveConfirmations([{terms:{organizationId:'org-b'}}]),false);
const broken=createDraftRecoveryStore({getItem(){throw Error('blocked');},setItem(){throw Error('quota');}},'org-a','user-a');assert.equal(broken.retain(intent('no-write')),false);assert.deepEqual(broken.pending(),[]);
for(const code of ['P0001','23514','42501','40P01'])assert.equal(draftSaveDefinitelyFailed({cause:{code}}),true);
for(const code of ['08006','PGRST003',undefined])assert.equal(draftSaveDefinitelyFailed({cause:{code}}),false);
console.log('PASS draft recovery journal: actor/client isolation, per-request durability, safe settlement, offline selections, cache failures and ambiguous outcomes.');
