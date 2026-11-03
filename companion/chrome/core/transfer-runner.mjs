// Transfer execution belongs to the local companion, not its disposable popup.
// Only status and the existing one-use pairing are retained; never CSV or secrets.
// Portable orchestration; hosts own execution and persistence.
export function createPortableTransferRunner(host,{now=Date.now,randomUUID=()=>crypto.randomUUID()}={}){
 let active=false,current={busy:false,message:'Prepare a browser transfer in KERDOS, then pair this tab.'};
 const terminal=message=>({busy:false,message});
 const save=async(busy,message)=>{const snapshot={busy,message};current=snapshot;await host.writeStatus(snapshot);return snapshot;};
 const initialized=(async()=>{
  const transferStatus=await host.readStatus();
  if(transferStatus?.busy){await host.clearPairing();await save(false,'The companion restarted during a transfer. Its result is unconfirmed. Check KERDOS before preparing a new transfer; nothing will be resent automatically.');}
  else if(typeof transferStatus?.message==='string')current={busy:false,message:transferStatus.message};
 })();
 async function execute(action,targetId){
  try{
   const target=await host.getTarget(targetId);
   if(action==='pair'){
    if(!target||!host.validTarget(target.id)||!host.isReceiver(target))throw Error('wrong_app');
    await save(true,'Pairing with the prepared KERDOS tab…');
    await host.clearPairing();
    const response=await host.pair(target);
    if(!response?.ok||!response.ticket)throw Error('not_ready');
    await host.savePairing({...response.ticket,receiverId:target.id});
    return terminal('Paired for one export. Open the selected vendor list, then click K and Send pricing to KERDOS.');
   }
   const pairing=await host.readPairing();
   if(!pairing||now()>=pairing.expiresAt)throw Error('pair_first');
   if(!target||!host.validTarget(target.id)||!host.supportsSource(target,pairing))throw Error('wrong_origin');
   if(pairing.protocolVersion!==2){await host.clearPairing();return terminal('Refresh KERDOS, prepare a new browser transfer and pair this companion again before exporting.');}
   await save(true,'Checking that KERDOS is ready for this transfer…');
   const claimId=randomUUID();
   const ready=await host.reserve(pairing,claimId);
   if(!ready?.ok||ready.outcome!=='ready_for_export'){await host.clearPairing();return terminal('KERDOS is no longer ready for this transfer. Prepare and pair a new transfer. No vendor export was started.');}
   await host.clearPairing();
   await save(true,'Checking the selected account and exporting its pricing list… You may close this popup and reopen it for the result.');
   const response=await host.retrieve(target,pairing);
   if(response?.outcome==='verification_needed')return terminal('Your vendor requires sign-in or verification. Complete it directly with the vendor, then prepare and pair a new transfer. No file was sent to KERDOS.');
   if(response?.outcome!=='export_captured')return terminal('The vendor export did not complete. No file was sent to KERDOS. Prepare a new transfer to retry.');
   await save(true,'Delivering the selected pricing file to KERDOS… Prices are not confirmed saved.');
   const ack=await host.deliver(pairing,claimId,response.artifact);
   return terminal(ack?.ok&&ack.outcome==='received_for_review'?'KERDOS received the CSV. Return to its tab to check the automatic import result. This receipt does not confirm saved prices.':'KERDOS did not accept the file. Prepare a new transfer and retry.');
  }catch{
   return terminal(action==='pair'?'In KERDOS, prepare a browser transfer first. Then pair from that KERDOS tab.':'Transfer unavailable. Keep your signed-in KERDOS tab open and prepare/pair a new transfer. No completed import has been confirmed.');
  }
 }
 return {
  async status(){await initialized;return {...current,busy:active||current.busy};},
  async run(action,targetId){
   if(!['pair','export'].includes(action)||!host.validTarget(targetId))throw Error('Invalid companion command');
   if(active){await initialized;return {...current,busy:active||current.busy};}
   active=true; // Reserve before storage or tab lookups, including competing popups.
   let result;
   try{await initialized;result=await execute(action,targetId);}finally{active=false;}
   // Release ownership before publishing ready: storage listeners may issue
   // the next command before this write's promise resolves. No old finally
   // may later clear that new command's lock.
   return save(false,result.message);
  },
 };
}
