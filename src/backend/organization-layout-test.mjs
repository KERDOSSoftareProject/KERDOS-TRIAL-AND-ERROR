import assert from 'node:assert/strict';
import {createSupabaseBackend} from './supabase.js';
import {assertBackendContract} from './contract.js';
import {createOrganizationService} from '../services/organization.js';

globalThis.window={localStorage:{removeItem(){}},sessionStorage:{}};
const calls=[];
let fail=false;
const settings={vendorLayouts:{vendor:{fingerprint:{5:'ignore'}}}};
const backend=assertBackendContract(createSupabaseBackend(
  {url:'https://example.supabase.co',anonKey:'test-public-key'},
  (_url,_key,options)=>{
    assert.equal(options.auth.persistSession,true);
    return {rpc(name,args){calls.push({name,args});return Promise.resolve(fail?{data:null,error:{message:'controlled RPC failure'}}:{data:settings,error:null});}};
  },
));
const service=createOrganizationService(backend);
assert.deepEqual(await service.rememberVendorLayout('org','vendor','fingerprint',{5:'ignore'}),settings);
assert.deepEqual(calls[0],{name:'kerdos_remember_vendor_layout',args:{p_organization_id:'org',p_vendor_id:'vendor',p_fingerprint:'fingerprint',p_answers:{5:'ignore'}}});
fail=true;
await assert.rejects(service.rememberVendorLayout('org','vendor','fingerprint',{5:'ignore'}),/controlled RPC failure/);
console.log('B4 real backend adapter routes and reports layout RPC results');
