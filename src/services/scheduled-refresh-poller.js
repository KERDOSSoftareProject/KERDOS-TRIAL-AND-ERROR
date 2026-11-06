// A tab-local prompt to ask the server whether a slot is due. The server owns
// the slot and the one-use claim; a browser timer is never the source of truth.
export function createScheduledRefreshPoller({load,claim,canRun,onClaim,onError=()=>{},schedule=setTimeout,unschedule=clearTimeout,intervalMs=30000}){
 if(!load||!claim||!canRun||!onClaim||intervalMs<1000)throw new Error('Invalid scheduled refresh poller');
 let closed=false,timer=null,running=false;
 const next=()=>{if(!closed){timer=schedule(tick,intervalMs);timer?.unref?.();}};
 async function tick(){
  if(closed||running)return;
  timer=null;running=true;
  try{
   if(canRun()){
    const requests=await load();
    for(const request of requests){
     if(closed||!canRun())break;
     const slot=await claim(request.id);
     if(slot){if(!closed)await onClaim(request,slot);break;}
    }
   }
  }catch(error){if(!closed)onError(error);}
  finally{running=false;next();}
 }
 return {start(){if(!closed&&!running&&timer===null)void tick();},stop(){closed=true;if(timer!==null)unschedule(timer);timer=null;}};
}
