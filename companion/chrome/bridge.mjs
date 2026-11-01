// Injected only after a user clicks Pair on the approved KERDOS page.
// Runs in the extension's isolated world; never accesses the app's auth state.
export async function pairKerdosTab(){
 const channel='kerdos-companion-v1';
 const exchange=(type,payload={})=>new Promise(resolve=>{
  const requestId=crypto.randomUUID();
  const finish=value=>{clearTimeout(timer);window.removeEventListener('message',listener);resolve(value);};
  const listener=event=>{
   if(event.source===window&&event.origin===location.origin&&event.data?.channel===channel&&event.data.type==='reply'&&event.data.requestId===requestId)finish(event.data);
  };
  const timer=setTimeout(()=>finish({ok:false}),15000);
  window.addEventListener('message',listener);window.postMessage({channel,type,requestId,...payload},location.origin);
 });
 if(globalThis.__kerdosCompanionListener)chrome.runtime.onMessage.removeListener(globalThis.__kerdosCompanionListener);
 const listener=(message,sender,respond)=>{
  if(sender.id!==chrome.runtime.id||message?.type!=='kerdos-deliver')return false;
  exchange('deliver',{nonce:message.nonce,artifact:message.artifact}).then(respond);return true;
 };
 globalThis.__kerdosCompanionListener=listener;
 chrome.runtime.onMessage.addListener(listener);
 return exchange('pair');
}
export const approvedKerdosTab=url=>{
 try{const parsed=new URL(url);return parsed.origin==='https://kerdossoftareproject.github.io'&&(parsed.pathname==='/KERDOS-TRIAL-AND-ERROR'||parsed.pathname.startsWith('/KERDOS-TRIAL-AND-ERROR/'));}catch{return false;}
};
