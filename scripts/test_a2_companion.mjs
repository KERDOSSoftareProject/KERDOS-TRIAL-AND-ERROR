import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {exportSelectedMoxeList} from '../companion/chrome/adapters/moxe.mjs';
const manifest=JSON.parse(readFileSync('companion/chrome/manifest.json','utf8'));
assert.deepEqual(manifest.permissions,['activeTab','scripting','storage']);assert.ok(!manifest.host_permissions);assert.deepEqual(manifest.optional_host_permissions,['https://kerdossoftareproject.github.io/*','https://order.usfoods.com/*']);assert.equal(manifest.content_scripts.length,1);assert.deepEqual(manifest.content_scripts[0].js,['app-channel.js']);assert.equal(manifest.content_scripts[0].all_frames,false);assert.deepEqual(manifest.background,{service_worker:'background.mjs',type:'module'});assert.ok(!manifest.externally_connectable);
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
assert.deepEqual(await exportSelectedMoxeList({...selection,inspectOnly:true}),{outcome:'selection_verified',path:location.pathname});assert.deepEqual(clicks,[],'refresh discovery performs no export clicks');
assert.deepEqual(await exportSelectedMoxeList(selection),{outcome:'download_requested'});assert.deepEqual(clicks,['open','options','check-prices','download']);
clicks=[];shown=false;options=false;checked=false;
assert.deepEqual(await exportSelectedMoxeList({...selection,account:'Wrong Client'}),{outcome:'account_mismatch'});assert.deepEqual(clicks,[]);
globalThis.location.origin='https://wrong.example.com';assert.deepEqual(await exportSelectedMoxeList(selection),{outcome:'wrong_origin'});assert.deepEqual(clicks,[]);
globalThis.location={origin:'https://order.usfoods.com',pathname:'/desktop/home'};assert.deepEqual(await exportSelectedMoxeList(selection),{outcome:'open_selected_list'});
globalThis.location.pathname='/desktop/lists/view/another-selected-list';assert.deepEqual(await exportSelectedMoxeList({...selection,list:'Wrong list'}),{outcome:'list_mismatch'});
// Verification is detected before list/account checks, including redirects off the list.
const originalQuery=document.querySelectorAll;document.querySelectorAll=selector=>selector==='input[type="password"],input[autocomplete="one-time-code"]'?[element('')]:originalQuery(selector);globalThis.location.pathname='/login';clicks=[];assert.equal((await exportSelectedMoxeList(selection)).outcome,'verification_needed');assert.deepEqual(clicks,[]);document.querySelectorAll=originalQuery;
// Exercise exact-byte capture against a controlled Blob-producing page.
globalThis.location={origin:'https://order.usfoods.com',pathname:'/desktop/lists/view/dynamic-client-list'};
// A retry can begin with the matching export dialog still open. Both the
// background page and modal Download controls retain client rectangles.
const ordinaryQuery=document.querySelectorAll;
document.querySelectorAll=selector=>selector==='button,ion-button,ion-label,p,label,[role="button"]'&&shown?[account,initial,downloadOptions,final]:ordinaryQuery(selector);
shown=true;options=false;checked=false;clicks=[];
assert.equal((await exportSelectedMoxeList(selection)).outcome,'download_requested','reuse one verified open dialog instead of treating its Download button as a duplicate page control');
assert.deepEqual(clicks,['options','check-prices','download'],'retry does not reopen the existing dialog');
shown=true;options=true;checked=false;clicks=[];
const ordinaryOptionsClick=downloadOptions.click;downloadOptions.click=()=>{throw Error('already open options must not be toggled');};
assert.equal((await exportSelectedMoxeList(selection)).outcome,'download_requested');
assert.deepEqual(clicks,['check-prices','download']);
downloadOptions.click=ordinaryOptionsClick;
shown=true;options=true;checked=true;clicks=[];
assert.equal((await exportSelectedMoxeList(selection)).outcome,'download_requested');
assert.deepEqual(clicks,['download'],'an already confirmed Product Prices checkbox is not toggled');
// Ionic labels live inside the checkbox. Its enclosing virtual-list row may
// include additional option text; no ARIA label is required on the host.
shown=true;options=true;checked=false;clicks=[];
const labelledAttribute=checkbox.getAttribute;
checkbox.getAttribute=()=>null;
checkbox.parentElement={textContent:'Product Prices Product Notes Product Status And Type'};
assert.equal((await exportSelectedMoxeList(selection)).outcome,'download_requested','identify the checkbox by its own rendered label, not the parent list text');
assert.deepEqual(clicks,['check-prices','download']);
checkbox.getAttribute=labelledAttribute;delete checkbox.parentElement;
const ordinaryModalQuery=modal.querySelectorAll;
// Published multi-select markup puts the primary label inside the host and
// can include a sublabel. A controlled change can replace that host entirely.
shown=true;options=true;checked=false;clicks=[];let replaced=false;
const ordinaryCheckboxClick=checkbox.click,ordinaryCheckboxText=checkbox.textContent;
checkbox.getAttribute=()=>null;checkbox.textContent='Product Prices Include quoted prices';
checkbox.querySelector=()=>element('Product Prices');
checkbox.click=()=>{replaced=true;clicks.push('check-prices');};
const replacement=element('Product Prices',()=>{},{checked:true});
modal.querySelectorAll=selector=>selector.includes('checkbox')?[replaced?replacement:checkbox]:[downloadOptions,final];
assert.equal((await exportSelectedMoxeList(selection)).outcome,'download_requested','confirm the current labelled checkbox after a controlled replacement');
assert.deepEqual(clicks,['check-prices','download']);
checkbox.click=ordinaryCheckboxClick;checkbox.textContent=ordinaryCheckboxText;checkbox.getAttribute=labelledAttribute;delete checkbox.querySelector;modal.querySelectorAll=ordinaryModalQuery;
shown=true;options=true;checked=false;clicks=[];
const unrelated=element('Product Notes',()=>clicks.push('wrong-option'),{parentElement:{textContent:'Product Prices'}});
modal.querySelectorAll=selector=>selector.includes('checkbox')?[unrelated]:[downloadOptions,final];
downloadOptions.click=()=>{throw Error('no exact pricing control');};
assert.notEqual((await exportSelectedMoxeList(selection)).outcome,'download_requested');assert.deepEqual(clicks,[],'a parent label cannot override a different control’s own label');
downloadOptions.click=ordinaryOptionsClick;modal.querySelectorAll=ordinaryModalQuery;
shown=true;options=false;checked=false;clicks=[];
modal.querySelectorAll=selector=>selector.includes('checkbox')?[]:[final];
assert.equal((await exportSelectedMoxeList(selection)).outcome,'download_options_unavailable');
assert.deepEqual(clicks,[],'missing options never starts the final download');
shown=true;options=true;checked=false;clicks=[];
modal.querySelectorAll=selector=>selector.includes('checkbox')?[checkbox,element('Product Prices',{},{getAttribute:()=> 'Product Prices'})]:[downloadOptions,final];
assert.equal((await exportSelectedMoxeList(selection)).outcome,'product_prices_unavailable');
assert.deepEqual(clicks,[],'ambiguous pricing options never starts the final download');
modal.querySelectorAll=ordinaryModalQuery;
const retryQuery=document.querySelectorAll;
document.querySelectorAll=selector=>selector==='ion-modal,[role="dialog"]'?[modal,element(modal.textContent)]:retryQuery(selector);
assert.equal((await exportSelectedMoxeList(selection)).outcome,'download_dialog_unavailable');
assert.deepEqual(clicks,[],'two matching dialogs stop before all export controls');
document.querySelectorAll=ordinaryQuery;
shown=false;options=false;checked=false;
let csv='Product Number,Product Description,Product Price\nSYNTHETIC,Crème brûlée® – jalapeño,1.20\n';
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
assert.equal(captured.outcome,'export_captured');assert.deepEqual(Buffer.from(captured.artifact.base64,'base64'),Buffer.from(csv,'utf8'));assert.equal(URL.createObjectURL,originalCreate);assert.equal(globalThis.__kerdosExportCapture,undefined);
// Unsupported legacy bytes are rejected explicitly without replacement decoding.
const utf8Csv=csv;csv=Uint8Array.of(67,111,100,101,44,78,97,109,101,10,49,44,67,97,102,233,10);
shown=false;options=false;checked=false;
const unsupported=await exportSelectedMoxeList({...selection,capture:true});assert.equal(unsupported.outcome,'unsupported_encoding');assert.equal(unsupported.artifact,undefined);assert.equal(URL.createObjectURL,originalCreate);assert.equal(globalThis.__kerdosExportCapture,undefined);assert.equal(Anchor.prototype.click,originalAnchorClick);assert.equal(Anchor.prototype.dispatchEvent,originalAnchorDispatch);csv=utf8Csv;
// An existing capture owns its sentinel and hooks; a competing attempt must
// stop before the final download without releasing that owner's reservation.
shown=false;options=false;checked=false;clicks=[];
const owner={owned:true};globalThis.__kerdosExportCapture=owner;
assert.equal((await exportSelectedMoxeList({...selection,capture:true})).outcome,'capture_busy');assert.ok(!clicks.includes('download'));assert.equal(globalThis.__kerdosExportCapture,owner);assert.equal(URL.createObjectURL,originalCreate);assert.equal(Anchor.prototype.click,originalAnchorClick);assert.equal(Anchor.prototype.dispatchEvent,originalAnchorDispatch);delete globalThis.__kerdosExportCapture;
shown=false;options=false;checked=false;
final.click=()=>{throw new Error('unexpected download failure');};
assert.equal((await exportSelectedMoxeList({...selection,capture:true})).outcome,'download_export_unavailable');assert.equal(URL.createObjectURL,originalCreate);assert.equal(globalThis.__kerdosExportCapture,undefined);
assert.equal(Anchor.prototype.click,originalAnchorClick);assert.equal(Anchor.prototype.dispatchEvent,originalAnchorDispatch);delete globalThis.HTMLAnchorElement;
delete globalThis.document;delete globalThis.location;
console.log('PASS local companion manifest retains legacy active-tab flow with scoped optional refresh access; controlled DOM export checks account/list, selects prices and reports only download_requested');
console.log('Controlled Blob capture preserves bytes and restores hooks after success/failure; live vendor capture and KERDOS ingestion remain unverified.');
