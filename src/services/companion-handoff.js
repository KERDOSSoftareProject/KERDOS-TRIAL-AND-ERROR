// One-use browser handoff. A companion assertion is not supplier authentication.
export const COMPANION_CHANNEL='kerdos-companion-v1';
export const MAX_EXPORT_BYTES=5*1024*1024;
export function createCompanionHandoff({target=window,selection,onReceive,onStateChange=()=>{},now=Date.now,cryptoApi=crypto,schedule=setTimeout,unschedule=clearTimeout}){
  if(!selection.organizationId||!selection.vendorId||!selection.account?.trim()||!selection.list?.trim()||selection.account.length>200||selection.list.length>200||!selection.adapterKey||!selection.portalOrigin)throw new Error('Select the client, vendor, account and list.');
  const approvedOrigin=new URL(selection.portalOrigin);
  if(approvedOrigin.protocol!=='https:'||approvedOrigin.origin!==selection.portalOrigin)throw new Error('Unsupported portal origin.');
  const ticket=Object.freeze({...selection,nonce:cryptoApi.randomUUID(),expiresAt:now()+10*60*1000,protocolVersion:2});
  let active=true,claimed=false,exportClaim=null,state='ready',expiryTimer;
  const transition=next=>{state=next;onStateChange(next);};
  const clearExpiry=()=>{if(expiryTimer!==undefined){unschedule(expiryTimer);expiryTimer=undefined;}};
  const expire=()=>{if(!active||state==='receiving')return;active=false;clearExpiry();transition('expired');};
  expiryTimer=schedule(expire,Math.max(0,ticket.expiresAt-now()));
  expiryTimer?.unref?.();
  const reply=(requestId,result)=>target.postMessage({channel:COMPANION_CHANNEL,type:'reply',requestId,...result},target.location.origin);
  async function listener(event){
    if(event.source!==target||event.origin!==target.location.origin||event.data?.channel!==COMPANION_CHANNEL)return;
    const msg=event.data;
    if(typeof msg.requestId!=='string'||msg.requestId.length>80)return;
    if(active&&now()>=ticket.expiresAt)expire();
    if(msg.type==='pair'){
      reply(msg.requestId,active&&!claimed&&!exportClaim&&now()<ticket.expiresAt?{ok:true,ticket}:{ok:false});return;
    }
    if(msg.type==='claim'){
      if(!active||claimed||exportClaim||now()>=ticket.expiresAt||msg.nonce!==ticket.nonce||typeof msg.claimId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(msg.claimId)){reply(msg.requestId,{ok:false});return;}
      exportClaim=msg.claimId;transition('exporting');reply(msg.requestId,{ok:true,outcome:'ready_for_export'});return;
    }
    if(msg.type!=='deliver')return;
    if(!active||claimed||now()>=ticket.expiresAt||msg.nonce!==ticket.nonce||(exportClaim!==null?msg.claimId!==exportClaim:msg.claimId!=null)){reply(msg.requestId,{ok:false});return;}
    claimed=true; // Reserve before any asynchronous byte work; replays never re-enter.
    try{
      const artifact=msg.artifact;
      if(artifact?.origin!==ticket.portalOrigin||typeof artifact.base64!=='string'||!artifact.base64.length||artifact.base64.length>Math.ceil(MAX_EXPORT_BYTES/3)*4||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(artifact.base64))throw new Error('invalid_artifact');
      const bytes=Uint8Array.from(atob(artifact.base64),c=>c.charCodeAt(0));
      if(!bytes.length||bytes.length>MAX_EXPORT_BYTES)throw new Error('invalid_artifact');
      const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
      if(/^\s*(?:<!doctype|<html|<body|<script)/i.test(text)||!text.includes(',')||!text.includes('\n'))throw new Error('invalid_csv');
      const sha256=Array.from(new Uint8Array(await cryptoApi.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
      if(active&&now()>=ticket.expiresAt)expire();
      if(!active)throw new Error('expired');
      // Use only the app's closed-over assignment, never IDs from the artifact.
      clearExpiry();transition('receiving');
      await onReceive({organizationId:ticket.organizationId,vendorId:ticket.vendorId,
        file:new File([bytes],'vendor-prices.csv',{type:'text/csv'}),
        evidence:{kind:'browser_companion',adapter_key:ticket.adapterKey,origin:artifact.origin,account_label:ticket.account,list_label:ticket.list,received_at:new Date(now()).toISOString(),sha256,byte_length:bytes.length,assurance:'user_approved_browser_session'}});
      if(active){active=false;transition('received');}
      reply(msg.requestId,{ok:true,outcome:'received_for_review'});
    }catch{clearExpiry();if(active){active=false;transition('rejected');}reply(msg.requestId,{ok:false,outcome:'handoff_rejected'});}
  }
  target.addEventListener('message',listener);
  return {expiresAt:ticket.expiresAt,get state(){return state;},cancel(){clearExpiry();const wasActive=active;active=false;target.removeEventListener('message',listener);if(wasActive)transition('cancelled');}};
}
