// Chrome host capability for the portable refresh command. Route hints are
// client/vendor/account/list scoped and contain only a checked portal pathname.
// No cookies, tokens, input values, CSV or credentials are retained here.
export function createRefreshSourceResolver(api,providers,{now=Date.now,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 const approvedApp='https://kerdossoftareproject.github.io/*';
 return async pairing=>{
  const provider=providers.find(p=>p.key===pairing.adapterKey&&p.origin===pairing.portalOrigin);
  const checkedPath=path=>typeof path==='string'&&path.length<512&&path.startsWith('/')&&!path.includes('?')&&!path.includes('#')&&provider?.refreshPath?.test(path);
  if(!provider||!['organizationId','vendorId','account','list'].every(k=>typeof pairing[k]==='string'&&pairing[k].length>0))return {outcome:'source_unavailable'};
  if(!await api.permissions.contains({origins:[approvedApp,provider.origin+'/*']}))return {outcome:'permission_required'};
  const scope=JSON.stringify([pairing.organizationId,pairing.vendorId,provider.key,pairing.account,pairing.list]);
  const routeKey='refresh-route:'+scope;
  const inspect=async tab=>{
   try{
    if(!Number.isSafeInteger(tab.id)||new URL(tab.url).origin!==provider.origin)return null;
    const rows=await api.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:provider.execute,args:[{account:pairing.account,list:pairing.list,inspectOnly:true}]});
    return rows[0]?.result;
   }catch{return null;}
  };
  const tabs=await api.tabs.query({url:provider.origin+'/*'});
  if(tabs.length>10)return {outcome:'ambiguous_source'};
  const matches=[];let verification=false;
  for(const tab of tabs){const proof=await inspect(tab);if(proof?.outcome==='verification_needed')verification=true;if(proof?.outcome==='selection_verified'&&checkedPath(proof.path))matches.push({tab,path:proof.path});}
  if(matches.length>1)return {outcome:'ambiguous_source'};
  if(matches.length===1){await api.storage.local.set({[routeKey]:matches[0].path});return {outcome:'ready',targetId:matches[0].tab.id};}
  const stored=(await api.storage.local.get(routeKey))[routeKey];
  if(!checkedPath(stored)){
   if(!tabs.length)await api.tabs.create({url:provider.origin,active:true});
   return {outcome:verification?'verification_needed':'source_selection_required'};
  }
  // A previously verified route can be reopened without reselecting its list.
  // A redirect, expired session or changed account is never repaired by guessing.
  const opened=await api.tabs.create({url:provider.origin+stored,active:false});
  const until=Math.min(now()+20000,pairing.expiresAt);
  do{
   const tab=await api.tabs.get(opened.id),proof=await inspect(tab);
   if(proof?.outcome==='selection_verified'&&checkedPath(proof.path))return {outcome:'ready',targetId:tab.id};
   if(proof?.outcome==='verification_needed'){await api.tabs.update(tab.id,{active:true});return {outcome:'verification_needed'};}
   await pause(250);
  }while(now()<until);
  await api.tabs.update(opened.id,{active:true});return {outcome:'source_selection_required'};
 };
}
