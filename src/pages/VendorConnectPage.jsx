import {useEffect,useMemo,useRef,useState} from 'react';
import {createCompanionHandoff} from '../services/companion-handoff.js';
import {createVendorConnectService,VendorConnectUnavailable} from '../services/vendor-connect.js';
const box={background:'white',borderRadius:14,padding:'28px 24px',color:'#00204F',maxWidth:760};
const control={padding:'10px 12px',border:'1px solid #B7C8DE',borderRadius:8,font:'inherit',color:'#00204F',background:'white'};
const button={...control,background:'#00204F',color:'white',cursor:'pointer'};
export default function VendorConnectPage({backend,organizationId,vendors=[],role,onCompanionImport}){
  const service=useMemo(()=>backend?createVendorConnectService(backend):null,[backend]);
  const allowed=['owner','manager'].includes(role);
  const [data,setData]=useState(null),[message,setMessage]=useState(''),[unavailable,setUnavailable]=useState(false);
  const [vendorId,setVendorId]=useState(''),[adapterKey,setAdapterKey]=useState(''),[busy,setBusy]=useState(false);
  const generation=useRef(0),handoff=useRef(null),receive=useRef(onCompanionImport);
  receive.current=onCompanionImport;
  const [account,setAccount]=useState(''),[list,setList]=useState(''),[armed,setArmed]=useState(false);
  useEffect(()=>{handoff.current?.cancel();handoff.current=null;setArmed(false);},[organizationId,vendorId,adapterKey,account,list,allowed]);
  useEffect(()=>()=>handoff.current?.cancel(),[]);
  function prepareTransfer(){
    handoff.current?.cancel();
    handoff.current=createCompanionHandoff({selection:{organizationId,vendorId,adapterKey,portalOrigin:data?.adapters.find(a=>a.adapter_key===adapterKey)?.portal_origin,account:account.trim(),list:list.trim()},onReceive:async payload=>{
      await receive.current(payload);setArmed(false);setMessage('CSV received for import review. Check the import result before treating prices as saved.');
    }});
    setArmed(true);setMessage('Transfer ready for ten minutes. Click the K companion on this KERDOS tab and choose Pair this KERDOS tab.');
  }
  useEffect(()=>{
    const current=++generation.current;let active=true;
    setData(null);setMessage('');setUnavailable(false);setVendorId('');setAdapterKey('');setBusy(false);
    if(!service||!organizationId||!allowed){setUnavailable(true);return;}
    service.list(organizationId).then(value=>{if(active&&generation.current===current)setData(value);}).catch(error=>{
      if(active&&generation.current===current){setUnavailable(error instanceof VendorConnectUnavailable);setMessage(error.message);}
    });
    return ()=>{active=false;generation.current++;};
  },[service,organizationId,allowed]);
  const selectedRequest=data?.requests.find(r=>r.vendor_id===vendorId&&r.adapter_key===adapterKey);
  async function change(action){
    handoff.current?.cancel();setArmed(false);
    const current=generation.current;setBusy(true);setMessage('');
    try{
      await action();const fresh=await service.list(organizationId);
      if(generation.current===current)setData(fresh);
    }catch(error){if(generation.current===current)setMessage(error.message);}
    finally{if(generation.current===current)setBusy(false);}
  }
  if(!allowed)return <section aria-label="Vendor Connect" style={box}><p>Owner or manager access is required.</p></section>;
  return <section aria-label="Vendor Connect" style={box}>
    <h2 style={{margin:'0 0 12px',fontSize:22}}>Your vendor accounts, connected to KERDOS</h2>
    <p style={{lineHeight:1.6}}>Prepare a connection for one of your vendors. Automatic account access becomes available after that connection has been verified.</p>
    <div role="status" style={{background:'#E3F2FD',borderRadius:10,padding:18,lineHeight:1.6}}>
      <strong>Automatic vendor account access is not active.</strong>
      <p style={{margin:'8px 0 0'}}>Preparing a connection saves your vendor and provider selection. It does not sign in or retrieve pricing yet. The browser transfer pilot below requires a separate action. Price Sheets and email delivery remain available.</p>
    </div>
    {message&&<p role="alert">{message}</p>}
    {!unavailable&&!data&&!message&&<p role="status">Loading your vendor connections…</p>}
    {!unavailable&&data&&<>
      <div style={{display:'flex',gap:14,flexWrap:'wrap',marginTop:20}}>
        <label style={{display:'grid',gap:6}}>Vendor<select aria-label="Vendor account vendor" style={control} value={vendorId} disabled={busy} onChange={e=>setVendorId(e.target.value)}><option value="">Select your vendor</option>{vendors.filter(v=>v.is_active!==false).map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
        <label style={{display:'grid',gap:6}}>Connection provider<select aria-label="Connection provider" style={control} value={adapterKey} disabled={busy} onChange={e=>setAdapterKey(e.target.value)}><option value="">Select a provider</option>{data.adapters.filter(a=>a.setup_available).map(a=><option key={a.adapter_key} value={a.adapter_key}>{a.display_name}</option>)}</select></label>
      </div>
      <button style={{...button,marginTop:14}} disabled={busy||!vendorId||!adapterKey||selectedRequest?.state==='setup_requested'} onClick={()=>change(()=>service.request({organizationId,vendorId,adapterKey}))}>Prepare connection</button>
      {onCompanionImport&&data.adapters.some(a=>a.adapter_key===adapterKey&&a.execution_model==='local_browser'&&a.portal_origin)&&selectedRequest?.state==='setup_requested'&&vendors.some(v=>v.id===vendorId&&v.is_active!==false)&&<div style={{marginTop:20}}>
        <h3>Transfer a pricing list from your browser</h3>
        <p>Sign in with your vendor directly. This pilot transfers one CSV into the normal import review for the selected vendor.</p>
        <label style={{display:'grid',gap:6,marginBottom:12}}>Account name shown by your vendor<input aria-label="Portal account name" maxLength={200} style={control} value={account} onChange={e=>setAccount(e.target.value)}/></label>
        <label style={{display:'grid',gap:6,marginBottom:12}}>Pricing list name<input aria-label="Portal list name" maxLength={200} style={control} value={list} onChange={e=>setList(e.target.value)}/></label>
        <button style={button} disabled={!account.trim()||!list.trim()||busy} onClick={prepareTransfer}>Prepare browser transfer</button>
        {armed&&<button style={{...control,marginLeft:8}} onClick={()=>{handoff.current?.cancel();setArmed(false);setMessage('Browser transfer cancelled.');}}>Cancel browser transfer</button>}
      </div>}
      {selectedRequest&&<p role="status">{selectedRequest.state==='cancelled'?'This setup request was cancelled.':'Setup requested. Account access is awaiting verification.'}</p>}
      <ul style={{paddingLeft:20}}>{data.requests.map(r=><li key={r.id} style={{marginTop:16}}>
        <strong>{vendors.find(v=>v.id===r.vendor_id)?.name||'Vendor'}</strong> · {data.adapters.find(a=>a.adapter_key===r.adapter_key)?.display_name||'Connection provider'}
        <p style={{margin:'4px 0'}}>{r.state==='cancelled'?'Setup cancelled':'Setup requested · Account access is not active'}</p>
        {r.state==='setup_requested'&&<button style={control} disabled={busy} onClick={()=>change(()=>service.cancel({organizationId,requestId:r.id}))}>Cancel setup</button>}
      </li>)}</ul>
    </>}
  </section>;
}
