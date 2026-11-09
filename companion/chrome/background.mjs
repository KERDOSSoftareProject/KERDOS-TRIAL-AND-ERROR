import {createTransferRunner} from './transfer-runner.mjs';
import {approvedKerdosTab} from './bridge.mjs';
export function registerCompanionWorker(api){
 const runner=createTransferRunner(api);
 const refreshListener=(message,sender,respond)=>{
  if(sender.id!==api.runtime.id||sender.frameId!==0||!sender.tab||!approvedKerdosTab(sender.url)||(sender.tab.url&&!approvedKerdosTab(sender.tab.url))||message?.type!=='kerdos-companion-refresh'||message.action!=='refresh'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(message.nonce||''))return false;
  runner.run('refresh',sender.tab.id,{expectedNonce:message.nonce}).then(respond,()=>respond({busy:false,outcome:'refresh_unavailable',message:'Refresh unavailable. Check KERDOS before retrying.'}));return true;
 };
 api.runtime.onMessage.addListener(refreshListener);
 const listener=(message,sender,respond)=>{
  // Commands come only from this extension's popup, never a vendor/content tab.
  if(sender.id!==api.runtime.id||sender.tab||sender.url!==api.runtime.getURL('popup.html')||message?.type!=='kerdos-companion-control')return false;
  if(!['status','pair','export'].includes(message.action))return false;
  const result=message.action==='status'?runner.status():runner.run(message.action,message.tabId);
  result.then(respond,()=>respond({busy:false,message:'Companion unavailable. Check KERDOS before starting a new transfer.'}));
  return true;
 };
 api.runtime.onMessage.addListener(listener);
 return {runner,listener,refreshListener};
}
if(globalThis.chrome?.runtime?.onMessage)registerCompanionWorker(globalThis.chrome);
