// Provider-neutral app side of a local companion command. The transfer itself
// still uses the app-owned one-use handoff, fresh selection validation and hash.
export function createCompanionRefreshClient(target,{timeout=90000,uuid=()=>crypto.randomUUID(),schedule=setTimeout,unschedule=clearTimeout}={}){
 const channel='kerdos-refresh-v1',pending=new Set();
 const available=()=>target?.document?.documentElement?.getAttribute('data-kerdos-refresh')==='1';
 const installed=()=>available()||target?.document?.documentElement?.getAttribute('data-kerdos-companion')==='1';
 const valid=e=>e.source===target&&e.origin===target.location.origin&&e.data?.channel===channel;
 function send(type,nonce){
  return new Promise(resolve=>{
   const requestId=uuid();let timer;
   const finish=result=>{unschedule(timer);target.removeEventListener('message',listener);pending.delete(cancel);resolve(result);};
   const cancel=()=>finish({outcome:'refresh_unavailable',message:type==='setup'?'Companion setup could not be confirmed. Check for its tab in Chrome.':'Refresh result is unconfirmed. Check KERDOS before retrying.'});
   const listener=e=>{if(valid(e)&&e.data.type==='reply'&&e.data.requestId===requestId)finish({outcome:typeof e.data.outcome==='string'?e.data.outcome:'refresh_unavailable',message:typeof e.data.message==='string'?e.data.message:'Check KERDOS before retrying.'});};
   pending.add(cancel);target.addEventListener('message',listener);timer=schedule(cancel,type==='setup'?Math.min(timeout,10000):timeout);
   target.postMessage({channel,type,requestId,...(type==='refresh'?{nonce}:{})},target.location.origin);
  });
 }
 return {
  available,installed,
  watch(callback){
   if(!target?.document||typeof target.addEventListener!=='function')return ()=>{};
   const listener=e=>{if(valid(e)&&['available','unavailable'].includes(e.data.type)&&e.data.version===1)callback(e.data.type==='available',true);};
   target.addEventListener('message',listener);callback(available(),installed());
   return ()=>target.removeEventListener('message',listener);
  },
  refresh(nonce){
   if(!available())return Promise.resolve({outcome:'refresh_unavailable',message:'Install or enable the current companion, then refresh KERDOS.'});
   return send('refresh',nonce);
  },
  setup(){return installed()?send('setup'):Promise.resolve({outcome:'refresh_unavailable',message:'Install the KERDOS Companion in this browser to connect.'});},
  dispose(){for(const cancel of [...pending])cancel();},
 };
}
