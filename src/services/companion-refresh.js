// Provider-neutral app side of a local companion command. The transfer itself
// still uses the app-owned one-use handoff, fresh selection validation and hash.
export function createCompanionRefreshClient(target,{timeout=90000,uuid=()=>crypto.randomUUID(),schedule=setTimeout,unschedule=clearTimeout}={}){
 const channel='kerdos-refresh-v1',pending=new Set();
 const available=()=>target?.document?.documentElement?.getAttribute('data-kerdos-refresh')==='1';
 const valid=e=>e.source===target&&e.origin===target.location.origin&&e.data?.channel===channel;
 return {
  available,
  watch(callback){
   if(!target?.document||typeof target.addEventListener!=='function')return ()=>{};
   const listener=e=>{if(valid(e)&&e.data.type==='available'&&e.data.version===1)callback(true);};
   target.addEventListener('message',listener);if(available())callback(true);
   return ()=>target.removeEventListener('message',listener);
  },
  refresh(nonce){
   if(!available())return Promise.resolve({outcome:'refresh_unavailable',message:'Install or enable the current companion, then refresh KERDOS.'});
   return new Promise(resolve=>{
    const requestId=uuid();let timer;
    const finish=result=>{unschedule(timer);target.removeEventListener('message',listener);pending.delete(cancel);resolve(result);};
    const cancel=()=>finish({outcome:'refresh_unavailable',message:'Refresh result is unconfirmed. Check KERDOS before retrying.'});
    const listener=e=>{if(valid(e)&&e.data.type==='reply'&&e.data.requestId===requestId)finish({outcome:typeof e.data.outcome==='string'?e.data.outcome:'refresh_unavailable',message:typeof e.data.message==='string'?e.data.message:'Check KERDOS before retrying.'});};
    pending.add(cancel);target.addEventListener('message',listener);timer=schedule(cancel,timeout);
    target.postMessage({channel,type:'refresh',requestId,nonce},target.location.origin);
   });
  },
  dispose(){for(const cancel of [...pending])cancel();},
 };
}
