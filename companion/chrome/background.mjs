import {createTransferRunner} from './transfer-runner.mjs';
export function registerCompanionWorker(api){
 const runner=createTransferRunner(api);
 const listener=(message,sender,respond)=>{
  // Commands come only from this extension's popup, never a vendor/content tab.
  if(sender.id!==api.runtime.id||sender.tab||sender.url!==api.runtime.getURL('popup.html')||message?.type!=='kerdos-companion-control')return false;
  if(!['status','pair','export'].includes(message.action))return false;
  const result=message.action==='status'?runner.status():runner.run(message.action,message.tabId);
  result.then(respond,()=>respond({busy:false,message:'Companion unavailable. Check KERDOS before starting a new transfer.'}));
  return true;
 };
 api.runtime.onMessage.addListener(listener);
 return {runner,listener};
}
if(globalThis.chrome?.runtime?.onMessage)registerCompanionWorker(globalThis.chrome);
