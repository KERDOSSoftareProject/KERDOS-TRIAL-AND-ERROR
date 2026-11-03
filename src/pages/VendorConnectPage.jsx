import {useEffect,useMemo,useRef,useState} from 'react';
import {createCompanionHandoff} from '../services/companion-handoff.js';
import {createCompanionRefreshClient} from '../services/companion-refresh.js';
import {createVendorConnectService,VendorConnectUnavailable} from '../services/vendor-connect.js';
const box={background:'white',borderRadius:14,padding:'28px 24px',color:'#00204F',maxWidth:760};
const control={padding:'10px 12px',border:'1px solid #B7C8DE',borderRadius:8,font:'inherit',color:'#00204F',background:'white'};
const button={...control,background:'#00204F',color:'white',cursor:'pointer'};
export default function VendorConnectPage({backend,organizationId,vendors=[],role,onCompanionImport,importInProgress=false,importResult,onTransferStart}){
  const refreshClient=useMemo(()=>createCompanionRefreshClient(typeof window==='undefined'?null:window),[]);
  const [refreshAvailable,setRefreshAvailable]=useState(()=>refreshClient.available());
  useEffect(()=>refreshClient.watch(setRefreshAvailable),[refreshClient]);
  useEffect(()=>()=>refreshClient.dispose(),[refreshClient]);
  const service=useMemo(()=>backend?createVendorConnectService(backend):null,[backend]);
  const allowed=['owner','manager'].includes(role);
  const [data,setData]=useState(null),[message,setMessage]=useState(''),[unavailable,setUnavailable]=useState(false);
  const [vendorId,setVendorId]=useState(''),[adapterKey,setAdapterKey]=useState(''),[busy,setBusy]=useState(false);
  const generation=useRef(0),transferGeneration=useRef(0),prepareAttempt=useRef(0),handoff=useRef(null),receive=useRef(onCompanionImport);
  receive.current=onCompanionImport;
  const [selectionDraft,setSelectionDraft]=useState(null),[armed,setArmed]=useState(false);
  const scopedData=data?.organizationId===organizationId&&data?.backend===backend?data:null;
  const selectedRequest=scopedData?.requests.find(r=>r.organization_id===organizationId&&r.vendor_id===vendorId&&r.adapter_key===adapterKey);
  const selectionScope=JSON.stringify([organizationId,vendorId,adapterKey,selectedRequest?.id||null]);
  const account=selectionDraft?.scope===selectionScope?selectionDraft.account:selectedRequest?.portal_account_label||'';
  const list=selectionDraft?.scope===selectionScope?selectionDraft.list:selectedRequest?.portal_list_label||'';
  function editSelection(field,value){setSelectionDraft(previous=>({...((previous?.scope===selectionScope)?previous:{scope:selectionScope,account,list}),[field]:value}));}
  const transferEligible=!!(allowed&&onCompanionImport&&scopedData?.adapters.some(a=>a.adapter_key===adapterKey&&a.execution_model==='local_browser'&&a.portal_origin)&&selectedRequest?.state==='setup_requested'&&vendors.some(v=>v.id===vendorId&&v.is_active!==false));
  function stopTransfer(){transferGeneration.current++;const existing=handoff.current;handoff.current=null;existing?.cancel();setArmed(false);return !!existing;}
  useEffect(()=>{if(stopTransfer())setMessage('Browser transfer cancelled. Prepare a new transfer for the current selection.');},[organizationId,vendorId,adapterKey,account,list,allowed,backend,transferEligible]);
  useEffect(()=>()=>{transferGeneration.current++;handoff.current?.cancel();},[]);
  async function prepareTransfer(refresh=false){
    if(importInProgress)return;
    stopTransfer();if(!transferEligible)return;
    onTransferStart?.();
    const token=transferGeneration.current,current=generation.current,attempt=++prepareAttempt.current;
    const selected={organizationId,vendorId,adapterKey,requestId:selectedRequest.id,account:account.trim(),list:list.trim()};
    setBusy(true);setMessage('Preparing browser transfer…');
    try{
      const saved=await service.saveSelection(selected);
      const portalOrigin=scopedData.adapters.find(a=>a.adapter_key===adapterKey).portal_origin;
      const binding=Object.freeze({...selected,revision:saved.transfer_revision,portalOrigin});
      const validateTransfer=async()=>{
        if(token!==transferGeneration.current||current!==generation.current)throw new Error('Transfer no longer available');
        await service.verifySelection(binding);
        if(token!==transferGeneration.current||current!==generation.current)throw new Error('Transfer no longer available');
        return true;
      };
      await validateTransfer();
      if(token!==transferGeneration.current||current!==generation.current)return;
      setData(previous=>previous?.organizationId===organizationId&&previous?.backend===backend
        ? {...previous,requests:previous.requests.map(r=>r.id===saved.id?saved:r)}:previous);
      handoff.current=createCompanionHandoff({selection:{organizationId,vendorId,adapterKey,portalOrigin,account:account.trim(),list:list.trim()},onValidate:validateTransfer,onReceive:async payload=>{
        if(token!==transferGeneration.current||!receive.current)throw new Error('Transfer no longer available');
        await receive.current(payload);
      },onStateChange:state=>{
        if(token!==transferGeneration.current)return;
        setArmed(['exporting','receiving'].includes(state));
        const messages={exporting:'Companion is checking your vendor account and exporting the selected list. This does not confirm received or saved prices.',receiving:'Pricing is being handed to automatic ingestion. Prices are not confirmed saved.',received:'Pricing received for automatic ingestion. The transfer receipt alone does not confirm saved prices.',expired:'Browser transfer expired. Prepare and pair a new transfer; no new file can be accepted by this transfer.',rejected:'Browser transfer was not accepted for import review. Prepare and pair a new transfer to retry. No completed import has been confirmed.'};
        if(messages[state])setMessage(messages[state]);
      }});
      setArmed(true);
      if(refresh){
        setMessage('Refreshing the selected vendor pricing…');
        const result=await refreshClient.refresh(handoff.current.nonce);
        if(token!==transferGeneration.current||current!==generation.current)return;
        if(result.outcome!=='received_for_review'){stopTransfer();setMessage(result.message);}
      }else setMessage('Transfer ready for ten minutes. Click the K companion on this KERDOS tab and choose Pair this KERDOS tab.');
    }catch{if(token===transferGeneration.current&&current===generation.current){setArmed(false);setMessage('Could not prepare browser transfer. Refresh the connection or check the selected account and list, then try again.');}}
    finally{if(current===generation.current&&attempt===prepareAttempt.current)setBusy(false);}
  }
  useEffect(()=>{
    const current=++generation.current;let active=true;
    setData(null);setSelectionDraft(null);setMessage('');setUnavailable(false);setVendorId('');setAdapterKey('');setBusy(false);
    if(!service||!organizationId||!allowed){setUnavailable(true);return;}
    service.list(organizationId).then(value=>{if(active&&generation.current===current){
      setData({...value,organizationId,backend});
      const connected=value.requests.filter(r=>r.state==='setup_requested'&&vendors.some(v=>v.id===r.vendor_id&&v.is_active!==false)&&value.adapters.some(a=>a.adapter_key===r.adapter_key&&a.execution_model==='local_browser'));
      if(connected.length===1){setVendorId(connected[0].vendor_id);setAdapterKey(connected[0].adapter_key);}
    }}).catch(error=>{
      if(active&&generation.current===current){setUnavailable(error instanceof VendorConnectUnavailable);setMessage(error.message);}
    });
    return ()=>{active=false;generation.current++;};
  },[service,organizationId,allowed]);
  async function change(action){
    stopTransfer();
    const current=generation.current;setBusy(true);setMessage('');
    try{
      await action();const fresh=await service.list(organizationId);
      if(generation.current===current)setData({...fresh,organizationId,backend});
    }catch(error){if(generation.current===current)setMessage(error.message);}
    finally{if(generation.current===current)setBusy(false);}
  }
  if(!allowed)return <section aria-label="Vendor Connect" style={box}><p>Owner or manager access is required.</p></section>;
  return <section aria-label="Vendor Connect" style={box}>
    <h2 style={{margin:'0 0 12px',fontSize:22}}>Your vendor accounts, connected to KERDOS</h2>
    <p style={{lineHeight:1.6}}>Prepare a connection for one of your vendors. Automatic account access becomes available after that connection has been verified.</p>
    <div role="status" style={{background:'#E3F2FD',borderRadius:10,padding:18,lineHeight:1.6}}>
      <strong>{refreshAvailable?'Refresh pricing through your connected browser session.':'Automatic vendor account access is not active.'}</strong>
      <p style={{margin:'8px 0 0'}}>{refreshAvailable?'Use Refresh prices after enabling companion access once. Sign in or verify directly with your vendor when required. Unattended account access is not active.':'Preparing a connection saves your vendor and provider selection. It does not sign in or retrieve pricing yet. The browser transfer pilot below requires a separate action. Price Sheets and email delivery remain available.'}</p>
    </div>
    {message&&!(message==='Pricing received for automatic ingestion. The transfer receipt alone does not confirm saved prices.'&&importResult?.organizationId===organizationId&&importResult.vendorId===vendorId)&&<p role="alert">{message}</p>}
    {importResult?.organizationId===organizationId&&importResult.vendorId===vendorId&&<p role={importResult.status==='needs_attention'?'alert':'status'} style={{background:importResult.status==='needs_attention'?'#FFF3E0':'#E8F5E9',border:`1px solid ${importResult.status==='needs_attention'?'#FFCC80':'#A5D6A7'}`,borderRadius:8,padding:12}}><strong>Latest pricing result:</strong> {importResult.message}</p>}
    {importInProgress&&<p role="status">KERDOS is processing the received pricing. Refresh will be available when this intake finishes.</p>}
    {!unavailable&&!scopedData&&!message&&<p role="status">Loading your vendor connections…</p>}
    {!unavailable&&scopedData&&<>
      <div style={{display:'flex',gap:14,flexWrap:'wrap',marginTop:20}}>
        <label style={{display:'grid',gap:6}}>Vendor<select aria-label="Vendor account vendor" style={control} value={vendorId} disabled={busy} onChange={e=>setVendorId(e.target.value)}><option value="">Select your vendor</option>{vendors.filter(v=>v.is_active!==false).map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
        <label style={{display:'grid',gap:6}}>Connection provider<select aria-label="Connection provider" style={control} value={adapterKey} disabled={busy} onChange={e=>setAdapterKey(e.target.value)}><option value="">Select a provider</option>{scopedData.adapters.filter(a=>a.setup_available).map(a=><option key={a.adapter_key} value={a.adapter_key}>{a.display_name}</option>)}</select></label>
      </div>
      <button style={{...button,marginTop:14}} disabled={busy||!vendorId||!adapterKey||selectedRequest?.state==='setup_requested'} onClick={()=>change(()=>service.request({organizationId,vendorId,adapterKey}))}>Prepare connection</button>
      {transferEligible&&<div style={{marginTop:20}}>
        <h3>Transfer a pricing list from your browser</h3>
        <p>Sign in with your vendor directly. After retrieval, KERDOS processes the pricing file automatically for the selected vendor and retains unresolved details for review.</p>
        <label style={{display:'grid',gap:6,marginBottom:12}}>Account name shown by your vendor<input aria-label="Portal account name" maxLength={200} style={control} value={account} onChange={e=>editSelection('account',e.target.value)}/></label>
        <label style={{display:'grid',gap:6,marginBottom:12}}>Pricing list name<input aria-label="Portal list name" maxLength={200} style={control} value={list} onChange={e=>editSelection('list',e.target.value)}/></label>
        {refreshAvailable&&<button style={button} disabled={!account.trim()||!list.trim()||busy||importInProgress} onClick={()=>prepareTransfer(true)}>Refresh prices</button>}
        {refreshAvailable?<details style={{marginTop:12}}><summary>Manual browser transfer</summary><button style={button} disabled={!account.trim()||!list.trim()||busy||importInProgress} onClick={()=>prepareTransfer(false)}>Prepare browser transfer</button></details>:<button style={button} disabled={!account.trim()||!list.trim()||busy||importInProgress} onClick={()=>prepareTransfer(false)}>Prepare browser transfer</button>}
        {armed&&<button style={{...control,marginLeft:8}} onClick={()=>{stopTransfer();setMessage('Browser transfer cancelled. Prepare a new transfer to retry.');}}>Cancel browser transfer</button>}
      </div>}
      {selectedRequest&&<p role="status">{selectedRequest.state==='cancelled'?'This setup request was cancelled.':'Setup requested. Account access is awaiting verification.'}</p>}
      <ul style={{paddingLeft:20}}>{scopedData.requests.map(r=><li key={r.id} style={{marginTop:16}}>
        <strong>{vendors.find(v=>v.id===r.vendor_id)?.name||'Vendor'}</strong> · {scopedData.adapters.find(a=>a.adapter_key===r.adapter_key)?.display_name||'Connection provider'}
        <p style={{margin:'4px 0'}}>{r.state==='cancelled'?'Setup cancelled':'Setup requested · Account access is not active'}</p>
        {r.state==='setup_requested'&&<button style={control} disabled={busy} onClick={()=>change(()=>service.cancel({organizationId,requestId:r.id}))}>Cancel setup</button>}
      </li>)}</ul>
    </>}
  </section>;
}
