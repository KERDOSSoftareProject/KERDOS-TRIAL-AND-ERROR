// Vendor-specific adapter candidate. Self-contained for chrome.scripting.
// User-started, DOM-only export. Never reads inputs, cookies, storage or tokens.
// No site requests, credential handling or order actions. Optional bounded CSV Blob capture.
export async function exportSelectedMoxeList(selection){
 const norm=s=>String(s||'').replace(/\s+/g,' ').trim().toUpperCase();
 const visible=el=>el.getClientRects().length>0;
 const nodes=(selector,root=document)=>[...root.querySelectorAll(selector)].filter(visible);
 const uniqueText=(value,root=document)=>{
  const found=nodes('button,ion-button,ion-label,p,label,[role="button"]',root).filter(el=>norm(el.textContent)===norm(value));
  // Nested wrappers with the same text are equivalent only if one contains all.
  const leaves=found.filter(el=>!found.some(other=>other!==el&&el.contains(other)));
  if(leaves.length!==1)throw new Error('ambiguous_control');return leaves[0];
 };
 const context=()=>{
  if(location.origin!=='https://order.usfoods.com')throw new Error('wrong_origin');
  if(!/^\/desktop\/lists\/view\/[^/]+\/?$/.test(location.pathname))throw new Error('open_selected_list');
  if(!selection?.account?.trim()||!selection?.list?.trim())throw new Error('selection_required');
  const names=nodes('button,ion-button,[role="button"]').map(el=>norm(el.textContent).replace(/\s*\(\d+\)$/,''));
  if(!names.includes(norm(selection.account)))throw new Error('account_mismatch');
  const body=norm(document.body.innerText);
  const titles=nodes('[data-cy="list-banner-list-name-text"]');
  if(!body.includes('MY LIST')||titles.length!==1||norm(titles[0].textContent)!==norm(selection.list))throw new Error('list_mismatch');
  if(nodes('input[type="password"],input[autocomplete="one-time-code"]').length)throw new Error('verification_needed');
 };
 const wait=async fn=>{
  const until=Date.now()+8000;
  do{context();const result=fn();if(result)return result;await new Promise(resolve=>setTimeout(resolve,150));}while(Date.now()<until);
  throw new Error('page_changed');
 };
 try{
  context();const originalPath=location.pathname;
  // Capture only the current page path, never a vendor account/list constant.
  uniqueText('Download').click();
  const dialog=await wait(()=>nodes('ion-modal,[role="dialog"]').find(el=>norm(el.innerText||el.textContent).includes(norm('Download '+selection.list))));
  if(!norm(dialog.innerText||dialog.textContent).includes('CSV'))throw new Error('csv_format_required');
  uniqueText('Download Options',dialog).click();
  const checkbox=await wait(()=>nodes('ion-checkbox,[role="checkbox"],input[type="checkbox"]',dialog).find(el=>norm(el.getAttribute('aria-label')||el.parentElement?.textContent)==='PRODUCT PRICES'));
  const checked=()=>checkbox.checked===true||checkbox.getAttribute('aria-checked')==='true';
  if(!checked())checkbox.click();
  await wait(checked);context();
  if(location.pathname!==originalPath)throw new Error('list_changed');
  if(selection.capture){
   // MAIN world is required to see a Blob the page creates. Capture only during
   // this selected export. Never suppress the ordinary browser download.
   if(globalThis.__kerdosExportCapture)return {outcome:'capture_busy'};
   globalThis.__kerdosExportCapture=true;
   const original=URL.createObjectURL,prototype=HTMLAnchorElement.prototype;
   const originalClick=prototype.click,originalDispatch=prototype.dispatchEvent;
   const dispatchDescriptor=Object.getOwnPropertyDescriptor(prototype,'dispatchEvent');
   let timer,settle;const blobs=new Map();
   const captured=new Promise(resolve=>{settle=resolve;timer=setTimeout(()=>resolve(null),10000);});
   const wrapped=function(blob){
    const url=original.call(this,blob);
    if(blobs.size<8&&blob instanceof Blob&&blob.size>0&&blob.size<=5*1024*1024&&/^(?:text\/csv|application\/(?:csv|octet-stream)|text\/plain)(?:;|$)/i.test(blob.type)){
     blobs.set(url,blob);
    }
    return url;
   };
   const observe=anchor=>{
    const filename=String(anchor.download||'');
    if(/\.csv$/i.test(filename)&&norm(filename.replace(/\.csv$/i,''))===norm(selection.list)){
     const blob=blobs.get(anchor.href);if(blob)settle(blob);
    }
   };
   const click=function(...args){observe(this);return originalClick.apply(this,args);};
   const dispatch=function(event){if(event?.type==='click')observe(this);return originalDispatch.call(this,event);};
   try{
    URL.createObjectURL=wrapped;
    prototype.click=click;
    Object.defineProperty(prototype,'dispatchEvent',{configurable:true,writable:true,value:dispatch});
    if(URL.createObjectURL!==wrapped||prototype.click!==click||prototype.dispatchEvent!==dispatch)throw new Error('capture_unavailable');
    uniqueText('Download',dialog).click();
    const blob=await captured;context();
    if(location.pathname!==originalPath)throw new Error('list_changed');
    if(!blob)return {outcome:'capture_unavailable'};
    const bytes=new Uint8Array(await blob.arrayBuffer());
    const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    if(/^\s*(?:<!doctype|<html|<body|<script)/i.test(text)||!text.includes(',')||!text.includes('\n'))return {outcome:'invalid_csv'};
    let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    return {outcome:'export_captured',artifact:{base64:btoa(binary),origin:location.origin}};
   }finally{
    clearTimeout(timer);if(URL.createObjectURL===wrapped)URL.createObjectURL=original;
    if(prototype.click===click)prototype.click=originalClick;
    if(prototype.dispatchEvent===dispatch){if(dispatchDescriptor)Object.defineProperty(prototype,'dispatchEvent',dispatchDescriptor);else delete prototype.dispatchEvent;}
    blobs.clear();
    delete globalThis.__kerdosExportCapture;
   }
  }
  uniqueText('Download',dialog).click();
  // A click cannot prove successful download completion or ingestion.
  return {outcome:'download_requested'};
 }catch(error){
  const safe=['wrong_origin','open_selected_list','selection_required','account_mismatch','list_mismatch','verification_needed','ambiguous_control','page_changed','csv_format_required','list_changed'];
  return {outcome:safe.includes(error.message)?error.message:'page_unavailable'};
 }
}
