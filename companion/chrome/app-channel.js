// Isolated, top-frame control channel on the approved KERDOS deployment only.
// No source payload, auth state, credentials or vendor IDs cross this channel.
(()=>{
 const valid=url=>{try{const u=new URL(url);return u.origin==='https://kerdossoftareproject.github.io'&&(u.pathname==='/KERDOS-TRIAL-AND-ERROR'||u.pathname.startsWith('/KERDOS-TRIAL-AND-ERROR/'));}catch{return false;}};
 if(window.top!==window||!valid(location.href))return;
 if(typeof window.__kerdosRefreshChannelInstalled==='function'){window.__kerdosRefreshChannelInstalled();return;}
 if(window.__kerdosRefreshChannelInstalled)return;
 const channel='kerdos-refresh-v1';let pending=false;
 let generation=0;
 async function announce(){
  const current=++generation;
  let providers=[];
  try{
   const status=await chrome.runtime.sendMessage({type:'kerdos-companion-refresh',action:'status'});
   if(Array.isArray(status?.readyProviders))providers=status.readyProviders;
  }catch{}
  if(current!==generation)return;
  const value=JSON.stringify(providers);
  if(document.documentElement.getAttribute('data-kerdos-ready-providers')===value)return;
  document.documentElement.setAttribute('data-kerdos-ready-providers',value);
  document.documentElement.setAttribute('data-kerdos-refresh',providers.length?'1':'0');
  window.postMessage({channel,type:providers.length?'available':'unavailable',version:1},location.origin);
 }
 window.__kerdosRefreshChannelInstalled=announce;
 document.documentElement.setAttribute('data-kerdos-companion','1');
 chrome.runtime.onMessage?.addListener((message,sender)=>{
  if(sender.id===chrome.runtime.id&&message?.type==='kerdos-companion-access-changed')announce();
 });
 window.addEventListener('message',async event=>{
  const m=event.data;
  if(!valid(location.href)||event.source!==window||event.origin!==location.origin||m?.channel!==channel||!['refresh','setup'].includes(m.type)||typeof m.requestId!=='string'||m.requestId.length>80)return;
  if(m.type==='refresh'&&!/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(m.nonce||''))return;
  if(m.type==='setup'&&(typeof m.adapterKey!=='string'||m.adapterKey.length>80))return;
  const reply=value=>window.postMessage({channel,type:'reply',requestId:m.requestId,...value},location.origin);
  if(pending){reply({busy:true,outcome:'busy',message:'A pricing refresh is already running. Wait for its result.'});return;}
  pending=true;
  try{
   const r=await chrome.runtime.sendMessage({type:'kerdos-companion-refresh',action:m.type,...(m.type==='refresh'?{nonce:m.nonce}:{adapterKey:m.adapterKey})});
   reply({busy:r?.busy===true,outcome:typeof r?.outcome==='string'?r.outcome:'refresh_unavailable',message:typeof r?.message==='string'?r.message:'Check KERDOS before retrying the refresh.'});
  }catch{reply({busy:false,outcome:'refresh_unavailable',message:'Companion unavailable. Refresh KERDOS after enabling the current companion.'});}
  finally{pending=false;}
 });
 announce();
})();
