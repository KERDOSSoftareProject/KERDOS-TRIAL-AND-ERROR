// Local, user/client-scoped recovery journal. No passwords, tokens or full files.
// Each request has its own key so another tab cannot overwrite an unknown save.
export function createDraftRecoveryStore(storage,organizationId,userId){
  const prefix=`kerdos:estimated-drafts:${encodeURIComponent(userId)}:${encodeURIComponent(organizationId)}:`;
  const read=key=>{try{return JSON.parse(storage.getItem(prefix+key)||'null');}catch{return null;}};
  const write=(key,value)=>{try{storage.setItem(prefix+key,JSON.stringify(value));return true;}catch{return false;}};
  const valid=entry=>entry?.version===1&&entry.organizationId===organizationId&&entry.userId===userId&&entry.intent?.organizationId===organizationId&&typeof entry.intent.requestId==='string'&&entry.intent.requestId.length>0&&Array.isArray(entry.intent.lines)&&entry.intent.kind==='estimated_purchase_draft_intent'&&entry.intent.version===1&&entry.intent.lines.length>0&&entry.intent.lines.length<=100&&entry.intent.lines.every(l=>l.terms?.organizationId===organizationId&&l.terms?.vendorId===entry.intent.vendorId);
  return {
    readBasket(){const value=read('basket');return value?.version===1&&value.organizationId===organizationId&&value.userId===userId?{vendorId:typeof value.vendorId==='string'?value.vendorId:'',quantities:value.quantities&&typeof value.quantities==='object'&&!Array.isArray(value.quantities)?Object.fromEntries(Object.entries(value.quantities).filter(([,v])=>typeof v==='string'&&v.length<=20)): {}}:{vendorId:'',quantities:{}};},
    readConfirmations(){const entry=read('confirmations');return entry?.organizationId===organizationId&&entry?.userId===userId&&Array.isArray(entry.rows)?entry.rows.filter(a=>a?.terms?.organizationId===organizationId):[];},
    saveConfirmations(rows){return rows.every(a=>a.terms?.organizationId===organizationId)&&write('confirmations',{organizationId,userId,rows});},
    saveBasket(model){return write('basket',{version:1,organizationId,userId,...model});},
    retain(intent){const entry={version:1,organizationId,userId,intent,status:'pending',createdAt:new Date().toISOString()};return valid(entry)&&write('request:'+intent.requestId,entry);},
    settle(entry,status,draftId=null){return valid(entry)&&['saved','failed'].includes(status)&&write('request:'+entry.intent.requestId,{version:1,organizationId,userId,requestId:entry.intent.requestId,status,draftId,settledAt:new Date().toISOString()});},
    pending(){try{const rows=[];for(let i=0;i<storage.length;i++){const key=storage.key(i);if(!key?.startsWith(prefix+'request:'))continue;const entry=read(key.slice(prefix.length));if(valid(entry)&&entry.status==='pending')rows.push(entry);}return rows.sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)));}catch{return [];}},
  };
}
// A PostgreSQL error response means that statement/transaction rolled back.
// Transport errors and ambiguous API responses remain pending for recovery.
export function draftSaveDefinitelyFailed(error){const code=error?.cause?.code;return typeof code==='string'&&/^[0-9A-Z]{5}$/.test(code)&&!code.startsWith('08');}
