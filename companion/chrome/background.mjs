import {createTransferRunner} from './transfer-runner.mjs';
import {approvedKerdosTab} from './bridge.mjs';
import {providers} from './providers.mjs';
const appOrigin='https://kerdossoftareproject.github.io/*';
export function registerCompanionWorker(api){
 const runner=createTransferRunner(api);
 const readyProviders=async()=>api.permissions
  ?(await Promise.all(providers.map(async provider=>await api.permissions.contains({origins:[appOrigin,provider.origin+'/*']})?provider.key:null))).filter(Boolean)
  :[];
 const refreshListener=(message,sender,respond)=>{
  if(sender.id!==api.runtime.id||sender.frameId!==0||!sender.tab||!approvedKerdosTab(sender.url)||(sender.tab.url&&!approvedKerdosTab(sender.tab.url))||message?.type!=='kerdos-companion-refresh')return false;
  if(message.action==='status'){readyProviders().then(keys=>respond({readyProviders:keys}),()=>respond({readyProviders:[]}));return true;}
  if(message.action==='setup'){
   const provider=providers.find(candidate=>candidate.key===message.adapterKey);
   if(!provider)return false;
   api.tabs.create({url:api.runtime.getURL('popup.html?setup='+encodeURIComponent(provider.key)),openerTabId:sender.tab.id}).then(
    ()=>respond({outcome:'setup_opened',message:'Approve site access in the KERDOS Companion tab. KERDOS will connect automatically.'}),
    ()=>respond({outcome:'refresh_unavailable',message:'The Companion setup tab could not open.'}));
   return true;
  }
  if(message.action!=='refresh'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(message.nonce||''))return false;
  runner.run('refresh',sender.tab.id,{expectedNonce:message.nonce}).then(respond,()=>respond({busy:false,outcome:'refresh_unavailable',message:'Refresh unavailable. Check KERDOS before retrying.'}));return true;
 };
 api.runtime.onMessage.addListener(refreshListener);
 api.permissions?.onRemoved?.addListener(()=>{
  api.tabs.query({url:appOrigin}).then(tabs=>Promise.allSettled(tabs.filter(tab=>approvedKerdosTab(tab.url))
   .map(tab=>api.tabs.sendMessage(tab.id,{type:'kerdos-companion-access-changed'},{frameId:0})))).catch(()=>{});
 });
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
