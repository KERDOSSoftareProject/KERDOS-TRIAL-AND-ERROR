// Isolated, top-frame control channel on the approved KERDOS deployment only.
// No source payload, auth state, credentials or vendor IDs cross this channel.
(()=>{
 const valid=url=>{try{const u=new URL(url);return u.origin==='https://kerdossoftareproject.github.io'&&(u.pathname==='/KERDOS-TRIAL-AND-ERROR'||u.pathname.startsWith('/KERDOS-TRIAL-AND-ERROR/'));}catch{return false;}};
 if(window.top!==window||!valid(location.href))return;
 const channel='kerdos-refresh-v1';let pending=false;
 window.addEventListener('message',async event=>{
  const m=event.data;
  if(!valid(location.href)||event.source!==window||event.origin!==location.origin||m?.channel!==channel||m.type!=='refresh'||typeof m.requestId!=='string'||m.requestId.length>80||!/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(m.nonce||''))return;
  const reply=value=>window.postMessage({channel,type:'reply',requestId:m.requestId,...value},location.origin);
  if(pending){reply({busy:true,outcome:'busy',message:'A pricing refresh is already running. Wait for its result.'});return;}
  pending=true;
  try{
   const r=await chrome.runtime.sendMessage({type:'kerdos-companion-refresh',action:'refresh',nonce:m.nonce});
   reply({busy:r?.busy===true,outcome:typeof r?.outcome==='string'?r.outcome:'refresh_unavailable',message:typeof r?.message==='string'?r.message:'Check KERDOS before retrying the refresh.'});
  }catch{reply({busy:false,outcome:'refresh_unavailable',message:'Companion unavailable. Refresh KERDOS after enabling the current companion.'});}
  finally{pending=false;}
 });
 document.documentElement.setAttribute('data-kerdos-refresh','1');
 window.postMessage({channel,type:'available',version:1},location.origin);
})();
