import {providers} from './providers.mjs';
import {pairKerdosTab,approvedKerdosTab} from './bridge.mjs';
const button=document.getElementById('export'),pair=document.getElementById('pair'),status=document.getElementById('status');
pair.addEventListener('click',async()=>{
 pair.disabled=true;
 try{
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  if(!tab?.id||!approvedKerdosTab(tab.url))throw new Error('wrong_app');
  await chrome.storage.session.remove('pairing');
  const result=await chrome.scripting.executeScript({target:{tabId:tab.id},func:pairKerdosTab});
  const response=result[0]?.result;
  if(!response?.ok||!response.ticket)throw new Error('not_ready');
  await chrome.storage.session.set({pairing:{...response.ticket,tabId:tab.id}});
  status.textContent='Paired for one export. Open the selected vendor list, then click K and Send pricing to KERDOS.';
 }catch{status.textContent='In KERDOS, select the client/vendor and prepare a browser transfer first. Then pair from that KERDOS tab.';}
 finally{pair.disabled=false;}
});
button.addEventListener('click',async()=>{
 button.disabled=true;pair.disabled=true;
 try{
  const {pairing}=await chrome.storage.session.get('pairing');
  if(!pairing||Date.now()>=pairing.expiresAt)throw new Error('pair_first');
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  const provider=tab?.url&&providers.find(p=>p.origin===new URL(tab.url).origin&&p.key===pairing.adapterKey&&p.origin===pairing.portalOrigin);
  if(!tab?.id||!provider)throw new Error('wrong_origin');
  // Remove before export so this one-use selection cannot be replayed by popup.
  await chrome.storage.session.remove('pairing');
  status.textContent='Checking the selected account and exporting its pricing list… Keep this popup open.';
  const result=await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:provider.execute,args:[{account:pairing.account,list:pairing.list,capture:true}]});
  const response=result[0]?.result;
  if(response?.outcome!=='export_captured'){status.textContent=`Stopped: ${response?.outcome||'page_unavailable'}. No file was sent to KERDOS. Prepare a new transfer to retry.`;return;}
  const ack=await chrome.tabs.sendMessage(pairing.tabId,{type:'kerdos-deliver',nonce:pairing.nonce,artifact:response.artifact});
  status.textContent=ack?.ok&&ack.outcome==='received_for_review'?'KERDOS received the CSV for import review. Return to its tab to check the import result. This receipt does not confirm saved prices.':'KERDOS did not accept the file. Prepare a new transfer and retry.';
 }catch{status.textContent='Transfer unavailable. Keep your signed-in KERDOS tab open and prepare/pair a new transfer. No completed import has been confirmed.';}
 finally{button.disabled=false;pair.disabled=false;}
});
