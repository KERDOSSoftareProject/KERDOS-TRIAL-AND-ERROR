import {providers} from './providers.mjs';
import {approvedKerdosTab} from './bridge.mjs';
// This view can close without owning or cancelling the companion's transfer.
const button=document.getElementById('export'),pair=document.getElementById('pair'),status=document.getElementById('status');
const setupProvider=providers.find(provider=>globalThis.location?.search==='?setup='+encodeURIComponent(provider.key));
const setupTab=!!setupProvider;
if(setupTab)document.getElementById('manual-transfer').hidden=true;
let revision=0;
function render(value){
 if(typeof value?.message!=='string')return;
 status.textContent=value.message;button.disabled=pair.disabled=value.busy===true;
}
async function command(action){
 const request=++revision;button.disabled=pair.disabled=true;
 try{
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  const result=await chrome.runtime.sendMessage({type:'kerdos-companion-control',action,tabId:tab?.id});
  if(request===revision)render(result);
 }catch{if(request===revision)render({busy:false,message:'Companion unavailable. Reopen it and check KERDOS before starting another transfer.'});}
}
pair.addEventListener('click',()=>command('pair'));
button.addEventListener('click',()=>command('export'));
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='session'&&changes.transferStatus?.newValue){revision++;render(changes.transferStatus.newValue);}});
const initial=++revision;
if(!setupTab)chrome.runtime.sendMessage({type:'kerdos-companion-control',action:'status'}).then(value=>{if(initial===revision)render(value);},()=>{if(initial===revision)render({busy:false,message:'Companion unavailable. Reopen it and check KERDOS before starting another transfer.'});});

const enableRefresh=document.getElementById('enable-refresh'),providerSelect=document.getElementById('provider');
if(enableRefresh&&providerSelect){
 for(const provider of providers){const option=document.createElement('option');option.value=provider.key;option.textContent=provider.name;providerSelect.appendChild(option);}
 if(setupTab){providerSelect.value=setupProvider.key;document.getElementById('provider-label').hidden=true;}
 enableRefresh.addEventListener('click',()=>{
  const provider=providers.find(p=>p.key===providerSelect.value);if(!provider)return;
  // Request synchronously within this explicit extension-page click, once per provider.
  const request=chrome.permissions.request({origins:['https://kerdossoftareproject.github.io/*',provider.origin+'/*']});
  request.then(async granted=>{
   if(!granted){render({busy:false,message:'Refresh access was not granted. The manual transfer remains available.'});return;}
   try{
    const tabs=await chrome.tabs.query({url:'https://kerdossoftareproject.github.io/*'});
    const results=await Promise.allSettled(tabs.filter(tab=>Number.isInteger(tab.id)&&approvedKerdosTab(tab.url)).map(tab=>chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},files:['app-channel.js']})));
    const failed=results.some(result=>result.status==='rejected');
    if(setupTab&&!failed&&results.length){const current=await chrome.tabs.getCurrent();if(current?.id!=null){await chrome.tabs.remove(current.id);return;}}
    render({busy:false,message:failed?'Refresh access enabled. Reload KERDOS to reconnect, then click Refresh prices.':'Refresh access enabled. Return to KERDOS and click Refresh prices.'});
   }catch{render({busy:false,message:'Refresh access enabled. Reload KERDOS to reconnect, then click Refresh prices.'});}
  },()=>render({busy:false,message:'Could not enable refresh access. Manual transfer remains available.'}));
 });
}
