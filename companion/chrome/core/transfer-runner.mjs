// Transfer execution belongs to the local companion, not its disposable popup.
// Only status and the existing one-use pairing are retained; never CSV or secrets.
// Portable orchestration; hosts own execution and persistence.
// Only fixed outcome codes become client messages; never display adapter diagnostics.
export function exportFailureMessage(outcome){
 let guidance;
 switch(outcome){
  case 'verification_needed':return 'Your vendor requires sign-in or verification. Complete it directly with the vendor, then prepare and pair a new transfer. No file was sent to KERDOS.';
  case 'account_mismatch':guidance='The open vendor account does not match your selected account. Open the selected account.';break;
  case 'list_mismatch':case 'list_changed':guidance='The open pricing list does not match your selection, or changed during export. Open the selected list.';break;
  case 'open_selected_list':guidance='Open your selected vendor pricing list before exporting.';break;
  case 'selection_required':guidance='Choose an account and pricing list in KERDOS before exporting.';break;
  case 'csv_format_required':guidance='The selected export must be in CSV format. Choose the CSV export.';break;
  case 'capture_busy':guidance='An export capture is already running. Wait for it to finish before starting another transfer.';break;
  case 'capture_unavailable':guidance='The companion could not capture this export. Keep the original download for review.';break;
  case 'unsupported_encoding':guidance='This export uses an unsupported text encoding. Keep the original file for review.';break;
  case 'invalid_csv':guidance='The captured file is not a supported CSV export. Check the vendor export format.';break;
  case 'ambiguous_control':case 'page_changed':case 'page_unavailable':guidance='The vendor page could not be verified for this export. Reopen the selected account and list.';break;
  case 'wrong_origin':guidance='Open the vendor portal selected for this connection.';break;
  case 'execution_unavailable':case 'unsupported_adapter':guidance='This connection cannot export through the current companion.';break;
  default:return 'The vendor export did not complete. No file was sent to KERDOS. Prepare a new transfer to retry.';
 }
 return guidance+' No file was sent to KERDOS. Prepare and pair a new transfer before retrying.';
}
export function createPortableTransferRunner(host,{now=Date.now,randomUUID=()=>crypto.randomUUID()}={}){
 let active=false,current={busy:false,message:'Prepare a browser transfer in KERDOS, then pair this tab.'};
 const terminal=message=>({busy:false,message});
 const save=async(busy,message)=>{const snapshot={busy,message};current=snapshot;await host.writeStatus(snapshot);return snapshot;};
 const initialized=(async()=>{
  const transferStatus=await host.readStatus();
  if(transferStatus?.busy){await host.clearPairing();await save(false,'The companion restarted during a transfer. Its result is unconfirmed. Check KERDOS before preparing a new transfer; nothing will be resent automatically.');}
  else if(typeof transferStatus?.message==='string')current={busy:false,message:transferStatus.message};
 })();
 const reportFailure=async reservation=>{
  if(reservation?.pairing.exportFailureNotice===true&&typeof host.reportFailure==='function'){
   try{await host.reportFailure(reservation.pairing,reservation.claimId);}catch{/* The original failure remains valid even when its receiver disappeared. */}
  }
 };
 async function execute(action,targetId){
  let reservation=null,deliveryStarted=false;
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
   reservation={pairing,claimId};
   await host.clearPairing();
   await save(true,'Checking the selected account and exporting its pricing list… You may close this popup and reopen it for the result.');
   const response=await host.retrieve(target,pairing);
   if(response?.outcome!=='export_captured'){await reportFailure(reservation);return terminal(exportFailureMessage(response?.outcome));}
   await save(true,'Delivering the selected pricing file to KERDOS… Prices are not confirmed saved.');
   deliveryStarted=true;
   const ack=await host.deliver(pairing,claimId,response.artifact);
   return terminal(ack?.ok&&ack.outcome==='received_for_review'?'KERDOS received the CSV. Return to its tab to check the automatic import result. This receipt does not confirm saved prices.':'KERDOS did not accept the file. Prepare a new transfer and retry.');
  }catch{
   if(!deliveryStarted)await reportFailure(reservation);
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
