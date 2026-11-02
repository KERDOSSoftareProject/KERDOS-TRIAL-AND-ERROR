// Transfer execution belongs to the local companion, not its disposable popup.
// Only status and the existing one-use pairing are retained; never CSV or secrets.
import {providers} from './providers.mjs';
import {pairKerdosTab,approvedKerdosTab} from './bridge.mjs';
export function createTransferRunner(api){
 let active=false,current={busy:false,message:'Prepare a browser transfer in KERDOS, then pair this tab.'};
 const save=async(busy,message)=>{current={busy,message};await api.storage.session.set({transferStatus:current});return current;};
 const initialized=(async()=>{
  const {transferStatus}=await api.storage.session.get('transferStatus');
  if(transferStatus?.busy){await api.storage.session.remove('pairing');await save(false,'The companion restarted during a transfer. Its result is unconfirmed. Check KERDOS before preparing a new transfer; nothing will be resent automatically.');}
  else if(typeof transferStatus?.message==='string')current={busy:false,message:transferStatus.message};
 })();
 async function execute(action,tabId){
  try{
   const tab=await api.tabs.get(tabId);
   if(action==='pair'){
    if(!tab?.id||!approvedKerdosTab(tab.url))throw Error('wrong_app');
    await save(true,'Pairing with the prepared KERDOS tab…');
    await api.storage.session.remove('pairing');
    const result=await api.scripting.executeScript({target:{tabId:tab.id},func:pairKerdosTab});
    const response=result[0]?.result;
    if(!response?.ok||!response.ticket)throw Error('not_ready');
    await api.storage.session.set({pairing:{...response.ticket,tabId:tab.id}});
    return await save(false,'Paired for one export. Open the selected vendor list, then click K and Send pricing to KERDOS.');
   }
   const {pairing}=await api.storage.session.get('pairing');
   if(!pairing||Date.now()>=pairing.expiresAt)throw Error('pair_first');
   const provider=tab?.url&&providers.find(p=>p.origin===new URL(tab.url).origin&&p.key===pairing.adapterKey&&p.origin===pairing.portalOrigin);
   if(!tab?.id||!provider)throw Error('wrong_origin');
   if(pairing.protocolVersion!==2){await api.storage.session.remove('pairing');return await save(false,'Refresh KERDOS, prepare a new browser transfer and pair this companion again before exporting.');}
   await save(true,'Checking that KERDOS is ready for this transfer…');
   const claimId=crypto.randomUUID();
   const ready=await api.tabs.sendMessage(pairing.tabId,{type:'kerdos-claim',nonce:pairing.nonce,claimId});
   if(!ready?.ok||ready.outcome!=='ready_for_export'){await api.storage.session.remove('pairing');return await save(false,'KERDOS is no longer ready for this transfer. Prepare and pair a new transfer. No vendor export was started.');}
   await api.storage.session.remove('pairing');
   await save(true,'Checking the selected account and exporting its pricing list… You may close this popup and reopen it for the result.');
   const result=await api.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:provider.execute,args:[{account:pairing.account,list:pairing.list,capture:true}]});
   const response=result[0]?.result;
   if(response?.outcome==='verification_needed')return await save(false,'Your vendor requires sign-in or verification. Complete it directly with the vendor, then prepare and pair a new transfer. No file was sent to KERDOS.');
   if(response?.outcome!=='export_captured')return await save(false,'The vendor export did not complete. No file was sent to KERDOS. Prepare a new transfer to retry.');
   await save(true,'Delivering the selected pricing file to KERDOS… Prices are not confirmed saved.');
   const ack=await api.tabs.sendMessage(pairing.tabId,{type:'kerdos-deliver',nonce:pairing.nonce,claimId,artifact:response.artifact});
   return await save(false,ack?.ok&&ack.outcome==='received_for_review'?'KERDOS received the CSV. Return to its tab to check the automatic import result. This receipt does not confirm saved prices.':'KERDOS did not accept the file. Prepare a new transfer and retry.');
  }catch{
   return await save(false,action==='pair'?'In KERDOS, prepare a browser transfer first. Then pair from that KERDOS tab.':'Transfer unavailable. Keep your signed-in KERDOS tab open and prepare/pair a new transfer. No completed import has been confirmed.');
  }
 }
 return {
  async status(){await initialized;return {...current,busy:active||current.busy};},
  async run(action,tabId){
   if(!['pair','export'].includes(action)||!Number.isSafeInteger(tabId)||tabId<=0)throw Error('Invalid companion command');
   if(active){await initialized;return {...current,busy:active||current.busy};}
   active=true; // Reserve before storage or tab lookups, including competing popups.
   try{await initialized;return await execute(action,tabId);}finally{active=false;}
  },
 };
}
