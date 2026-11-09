// Chrome host adapter; execution rules live in the portable runner.
import {providers} from './providers.mjs';
import {pairKerdosTab,approvedKerdosTab} from './bridge.mjs';
import {createPortableTransferRunner} from './core/transfer-runner.mjs';
import {createRefreshSourceResolver} from './refresh-source.mjs';
export function createTransferRunner(api){
 const providerFor=(target,pairing)=>target?.url&&providers.find(p=>p.origin===new URL(target.url).origin&&p.key===pairing.adapterKey&&p.origin===pairing.portalOrigin);
 return createPortableTransferRunner({
  resolveSource:createRefreshSourceResolver(api,providers),
  refreshAccess:()=>api.permissions.contains({origins:['https://kerdossoftareproject.github.io/*']}),
  validTarget:id=>Number.isSafeInteger(id)&&id>0,
  getTarget:id=>api.tabs.get(id),
  isReceiver:target=>approvedKerdosTab(target.url),
  supportsSource:(target,pairing)=>!!providerFor(target,pairing),
  readStatus:async()=>{const {transferStatus}=await api.storage.session.get('transferStatus');return transferStatus;},
  writeStatus:transferStatus=>api.storage.session.set({transferStatus}),
  readPairing:async()=>{const {pairing}=await api.storage.session.get('pairing');if(!pairing)return undefined;const {tabId,...ticket}=pairing;return {...ticket,receiverId:tabId};},
  savePairing:async value=>{const {receiverId,...ticket}=value;await api.storage.session.set({pairing:{...ticket,tabId:receiverId}});},
  clearPairing:()=>api.storage.session.remove('pairing'),
  pair:async target=>{const result=await api.scripting.executeScript({target:{tabId:target.id},func:pairKerdosTab});return result[0]?.result;},
  reserve:(pairing,claimId)=>api.tabs.sendMessage(pairing.receiverId,{type:'kerdos-claim',nonce:pairing.nonce,claimId}),
  reportFailure:(pairing,claimId)=>api.tabs.sendMessage(pairing.receiverId,{type:'kerdos-export-failed',nonce:pairing.nonce,claimId}),
  retrieve:async(target,pairing)=>{
   const provider=providerFor(target,pairing);if(!provider)return {outcome:'execution_unavailable'};
   // User-started portal exports may render their dialog on animation frames,
   // which a background tab need not receive. Activate only the verified source.
   await api.tabs.update(target.id,{active:true});
   try{
    const result=await api.scripting.executeScript({target:{tabId:target.id},world:'MAIN',func:provider.execute,args:[{account:pairing.account,list:pairing.list,capture:true}]});return result[0]?.result;
   }finally{
    // Restore only while the source is still selected and unchanged in the
    // receiver's window. Never override an intervening tab/window/navigation.
    try{
     const source=await api.tabs.get(target.id),receiver=await api.tabs.get(pairing.receiverId);
     if(!target.active&&source.active&&source.url===target.url&&source.windowId===receiver.windowId&&approvedKerdosTab(receiver.url))await api.tabs.update(pairing.receiverId,{active:true});
    }catch{/* A closed tab or unavailable receiver does not invalidate capture. */}
   }
  },
  deliver:(pairing,claimId,artifact)=>api.tabs.sendMessage(pairing.receiverId,{type:'kerdos-deliver',nonce:pairing.nonce,claimId,artifact}),
 });
}
