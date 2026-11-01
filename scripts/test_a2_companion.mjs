import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {exportSelectedMoxeList} from '../companion/chrome/adapters/moxe.mjs';
const manifest=JSON.parse(readFileSync('companion/chrome/manifest.json','utf8'));
assert.deepEqual(manifest.permissions,['activeTab','scripting','storage']);assert.ok(!manifest.host_permissions);assert.ok(!manifest.content_scripts);assert.ok(!manifest.background);assert.ok(!manifest.externally_connectable);
let clicks=[];let shown=false,options=false,checked=false;
const element=(text,click=()=>{},extra={})=>({textContent:text,innerText:text,click,contains:()=>false,getClientRects:()=>[{}],getAttribute:()=>null,...extra});
const account=element('Sample Client (12345678)');
const checkbox=element('Product Prices',()=>{checked=true;clicks.push('check-prices');},{get checked(){return checked;},getAttribute:key=>key==='aria-label'?'Product Prices':null});
// An ordinary data property would freeze the getter through object spread.
Object.defineProperty(checkbox,'checked',{get:()=>checked});
const final=element('Download',()=>clicks.push('download'));
const downloadOptions=element('Download Options',()=>{options=true;clicks.push('options');});
const modal=element('Download Example List Select Format CSV',()=>{},{querySelectorAll:selector=>selector.includes('checkbox')?(options?[checkbox]:[]):[downloadOptions,final]});
const initial=element('Download',()=>{shown=true;clicks.push('open');});
const document={body:{innerText:'MY LIST EXAMPLE LIST'},querySelectorAll:selector=>selector==='[data-cy="list-banner-list-name-text"]'?[element('Example List')]:selector==='ion-modal,[role="dialog"]'?(shown?[modal]:[]):selector.startsWith('input[')?[]:[account,initial]};
globalThis.document=document;globalThis.location={origin:'https://order.usfoods.com',pathname:'/desktop/lists/view/dynamic-client-list'};
const selection={account:'Sample Client',list:'Example List'};
assert.deepEqual(await exportSelectedMoxeList(selection),{outcome:'download_requested'});assert.deepEqual(clicks,['open','options','check-prices','download']);
clicks=[];shown=false;options=false;checked=false;
assert.deepEqual(await exportSelectedMoxeList({...selection,account:'Wrong Client'}),{outcome:'account_mismatch'});assert.deepEqual(clicks,[]);
globalThis.location.origin='https://wrong.example.com';assert.deepEqual(await exportSelectedMoxeList(selection),{outcome:'wrong_origin'});assert.deepEqual(clicks,[]);
globalThis.location={origin:'https://order.usfoods.com',pathname:'/desktop/home'};assert.deepEqual(await exportSelectedMoxeList(selection),{outcome:'open_selected_list'});
globalThis.location.pathname='/desktop/lists/view/another-selected-list';assert.deepEqual(await exportSelectedMoxeList({...selection,list:'Wrong list'}),{outcome:'list_mismatch'});
// Exercise exact-byte capture against a controlled Blob-producing page.
globalThis.location={origin:'https://order.usfoods.com',pathname:'/desktop/lists/view/dynamic-client-list'};
shown=false;options=false;checked=false;
const csv='Product Number,Product Description,Product Price\nSYNTHETIC,Sample Product,1.20\n';
const originalCreate=URL.createObjectURL;
class Anchor {click(){} dispatchEvent(){return true;}}
globalThis.HTMLAnchorElement=Anchor;
const originalAnchorClick=Anchor.prototype.click,originalAnchorDispatch=Anchor.prototype.dispatchEvent;
final.click=()=>{
 clicks.push('download');
 const otherUrl=URL.createObjectURL(new Blob(['Other,CSV\nwrong,list\n'],{type:'text/csv'}));
 const other=new Anchor();other.href=otherUrl;other.download='Unrelated.csv';other.click();URL.revokeObjectURL(otherUrl);
 const url=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
 const anchor=new Anchor();anchor.href=url;anchor.download='Example List.csv';anchor.dispatchEvent({type:'click'});URL.revokeObjectURL(url);
};
const captured=await exportSelectedMoxeList({...selection,capture:true});
assert.equal(captured.outcome,'export_captured');assert.equal(atob(captured.artifact.base64),csv);assert.equal(URL.createObjectURL,originalCreate);assert.equal(globalThis.__kerdosExportCapture,undefined);
shown=false;options=false;checked=false;
final.click=()=>{throw new Error('unexpected download failure');};
assert.equal((await exportSelectedMoxeList({...selection,capture:true})).outcome,'page_unavailable');assert.equal(URL.createObjectURL,originalCreate);assert.equal(globalThis.__kerdosExportCapture,undefined);
assert.equal(Anchor.prototype.click,originalAnchorClick);assert.equal(Anchor.prototype.dispatchEvent,originalAnchorDispatch);delete globalThis.HTMLAnchorElement;
delete globalThis.document;delete globalThis.location;
console.log('PASS local companion manifest is active-tab only; controlled DOM export checks account/list, selects prices and reports only download_requested');
console.log('Controlled Blob capture preserves bytes and restores hooks after success/failure; live vendor capture and KERDOS ingestion remain unverified.');
