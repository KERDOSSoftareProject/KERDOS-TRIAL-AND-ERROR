// This view can close without owning or cancelling the companion's transfer.
const button=document.getElementById('export'),pair=document.getElementById('pair'),status=document.getElementById('status');
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
chrome.runtime.sendMessage({type:'kerdos-companion-control',action:'status'}).then(value=>{if(initial===revision)render(value);},()=>{if(initial===revision)render({busy:false,message:'Companion unavailable. Reopen it and check KERDOS before starting another transfer.'});});
