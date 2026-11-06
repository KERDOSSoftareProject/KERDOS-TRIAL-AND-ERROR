// Transfer execution belongs to the local companion, not its disposable popup.
// Only status and the existing one-use pairing are retained; never CSV or secrets.
// Portable orchestration; hosts own execution and persistence.
// Only fixed outcome codes become client messages; never display adapter diagnostics.
export function exportFailureMessage(outcome,{refresh=false}={}){
 let guidance;
 switch(outcome){
  case 'verification_needed':return refresh?'Your vendor requires sign-in or verification. Complete it directly with the vendor, then click Refresh prices. No file was sent to KERDOS.':'Your vendor requires sign-in or verification. Complete it directly with the vendor, then prepare and pair a new transfer. No file was sent to KERDOS.';
  case 'account_mismatch':guidance='The open vendor account does not match your selected account. Open the selected account.';break;
  case 'list_mismatch':case 'list_changed':guidance='The open pricing list does not match your selection, or changed during export. Open the selected list.';break;
  case 'open_selected_list':guidance='Open your selected vendor pricing list before exporting.';break;
  case 'selection_required':guidance='Choose an account and pricing list in KERDOS before exporting.';break;
  case 'csv_format_required':guidance='The selected export must be in CSV format. Choose the CSV export.';break;
  case 'capture_busy':guidance='An export capture is already running. Wait for it to finish before starting another transfer.';break;
  case 'capture_unavailable':guidance='The companion could not capture this export. Keep the original download for review.';break;
  case 'unsupported_encoding':guidance='This export uses an unsupported text encoding. Keep the original file for review.';break;
  case 'invalid_csv':guidance='The captured file is not a supported CSV export. Check the vendor export format.';break;
  case 'download_dialog_unavailable':guidance='The companion could not identify one download dialog for the selected list. Close extra download dialogs and reopen the selected list.';break;
  case 'download_options_unavailable':guidance='The companion could not identify Download Options in the selected list’s download dialog.';break;
  case 'product_prices_unavailable':guidance='The companion could not find or confirm Product Prices in the download options.';break;
  case 'download_export_unavailable':guidance='The companion could not complete the Download step for the selected list. Keep any original download for review.';break;
  case 'ambiguous_control':case 'page_changed':case 'page_unavailable':guidance='The vendor page could not be verified for this export. Reopen the selected account and list.';break;
  case 'wrong_origin':guidance='Open the vendor portal selected for this connection.';break;
  case 'execution_unavailable':case 'unsupported_adapter':guidance='This connection cannot export through the current companion.';break;
  default:return 'The vendor export did not complete. No file was sent to KERDOS. '+(refresh?'Click Refresh prices to retry.':'Prepare a new transfer to retry.');
 }
 return guidance+' No file was sent to KERDOS. '+(refresh?'Click Refresh prices to retry.':'Prepare and pair a new transfer before retrying.');
}
export function createPortableTransferRunner(host,{now=Date.now,randomUUID=()=>crypto.randomUUID()}={}){
 let active=false,current={busy:false,message:'Prepare a browser transfer in KERDOS, then pair this tab.'};
 const terminal=(message,outcome)=>({busy:false,message,...(outcome?{outcome}:{})});
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
 async function execute(action,targetId,expectedNonce,refreshContext=false){
  let reservation=null,deliveryStarted=false;
  try{
   const target=await host.getTarget(targetId);
   if(action==='pair'||action==='refresh'){
    if(!target||!host.validTarget(target.id))throw Error('wrong_app');
    if(action==='refresh'&&host.refreshAccess&&!await host.refreshAccess(target))return terminal('Enable Refresh prices access once in the K companion, then return here and click Refresh prices.','permission_required');
    if(!host.isReceiver(target))throw Error('wrong_app');
    await save(true,'Pairing with the prepared KERDOS tab…');
    await host.clearPairing();
    const response=await host.pair(target);
    if(!response?.ok||!response.ticket||(action==='refresh'&&response.ticket.nonce!==expectedNonce))throw Error('not_ready');
    await host.savePairing({...response.ticket,receiverId:target.id});
    if(action==='refresh'){
     const pairing={...response.ticket,receiverId:target.id};
     const source=await host.resolveSource(pairing);
     if(source?.outcome!=='ready'){
      await host.clearPairing();
      const messages={permission_required:'Enable Refresh prices access once in the K companion, then return here and click Refresh prices.',ambiguous_source:'More than one vendor tab matches this account and list. Close the extra matching tabs, then click Refresh prices.',verification_needed:'Your vendor requires sign-in or verification. Complete it directly with the vendor, then click Refresh prices.',source_selection_required:'Open the selected account and pricing list with your vendor once, then return here and click Refresh prices.'};
      Object.assign(messages,{
       source_account_unverified:'The vendor list is open, but the companion could not confirm the selected account. No export was started. Check that the account name in KERDOS matches the vendor page.',
       source_list_unverified:'The vendor list is open, but the companion could not confirm the selected list name. No export was started. Check that the list name in KERDOS matches the vendor page.',
       source_inspection_failed:'The companion could not read the open vendor list page. No export was started. Check companion access to the vendor site before retrying.'
      });
      const outcome=Object.hasOwn(messages,source?.outcome)?source.outcome:'source_unavailable';
      return terminal(outcome==='source_unavailable'?'The selected vendor page is unavailable. Open its pricing list and click Refresh prices to retry.':messages[outcome],outcome);
     }
     if(now()>=pairing.expiresAt)throw Error('expired');
     return execute('export',source.targetId,undefined,true);
    }
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
   if(response?.outcome!=='export_captured'){await reportFailure(reservation);return terminal(exportFailureMessage(response?.outcome,{refresh:refreshContext}));}
   await save(true,'Delivering the selected pricing file to KERDOS… Prices are not confirmed saved.');
   deliveryStarted=true;
   const ack=await host.deliver(pairing,claimId,response.artifact);
   return terminal(ack?.ok&&ack.outcome==='received_for_review'?'KERDOS received the CSV. Return to its tab to check the automatic import result. This receipt does not confirm saved prices.':'KERDOS did not accept the file. Prepare a new transfer and retry.',ack?.ok&&ack.outcome==='received_for_review'?'received_for_review':'handoff_rejected');
  }catch{
   if(!deliveryStarted)await reportFailure(reservation);
   return terminal(action==='pair'?'In KERDOS, prepare a browser transfer first. Then pair from that KERDOS tab.':(refreshContext||action==='refresh'?'Refresh unavailable. Keep KERDOS open and check the selected vendor list before clicking Refresh prices again. No completed import has been confirmed.':'Transfer unavailable. Keep your signed-in KERDOS tab open and prepare/pair a new transfer. No completed import has been confirmed.'));
  }
 }
 return {
  async status(){await initialized;return {...current,busy:active||current.busy};},
  async run(action,targetId,{expectedNonce}={}){
   if(!['pair','export','refresh'].includes(action)||!host.validTarget(targetId)||(action==='refresh'&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(expectedNonce||'')))throw Error('Invalid companion command');
   if(active){await initialized;return {...current,busy:active||current.busy};}
   active=true; // Reserve before storage or tab lookups, including competing popups.
   let result;
   try{await initialized;result=await execute(action,targetId,expectedNonce);}finally{active=false;}
   // Release ownership before publishing ready: storage listeners may issue
   // the next command before this write's promise resolves. No old finally
   // may later clear that new command's lock.
   const saved=await save(false,result.message);
   return action==='refresh'?{...saved,outcome:result.outcome||'refresh_unavailable'}:saved;
  },
 };
}
