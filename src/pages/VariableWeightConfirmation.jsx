import {useState} from 'react';
import {MovableDialog} from '../ui/MovableDialog.jsx';
import {variableWeightConfirmationState} from '../services/variable-weight.js';
import {estimateCaseCost,priceBasisFor} from '../procurement.js';
import {formatMoney} from '../localization.js';
import {unitLabel} from '../core/unit-labels.js';
import {btn} from '../ui/styles.js';

export function VariableWeightConfirmation({service,organizationId,listing,mapping,catalogItemId,settings={},approval,disabled=false,canManage,onChanged}){
  const [mode,setMode]=useState(null),[confirmed,setConfirmed]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState(''),[reviewedSnapshot,setReviewedSnapshot]=useState('');
  const input={organizationId,vendorId:listing.vendor_id,catalogItemId,listing,mapping,settings,now:new Date().toISOString()};
  const state=variableWeightConfirmationState(input,approval),basis=priceBasisFor(listing.selling_unit);
  const estimate=estimateCaseCost(listing.price,basis?.basis,basis?.unit,listing.pack_size);
  const estimateLabel=estimate?(estimate.amount!=null?formatMoney(estimate.amount):`${formatMoney(estimate.minimum)}–${formatMoney(estimate.maximum)}`):'Unresolved';
  const snapshot=JSON.stringify({organizationId,listing,mapping,catalogItemId,settings});
  const changed=mode==='review'&&reviewedSnapshot!==snapshot;
  function open(next){setConfirmed(false);setError('');setReviewedSnapshot(snapshot);setMode(next);}
  async function submit(){
    if(pending||disabled||(mode==='review'&&(!confirmed||!state.eligible||changed)))return;
    setPending(true);setError('');
    try{
      const saved=mode==='revoke'?await service.revoke(organizationId,approval):await service.approve({...input,confirmed:true});
      onChanged(saved);setMode(null);setConfirmed(false);
    }catch(err){setError(err.message||String(err));}
    finally{setPending(false);}
  }
  return <div style={{marginTop:8,fontSize:11}}>
    {state.confirmed?<small role="status">Variable-weight terms confirmed. Case ordering remains on hold.</small>:approval?.revokedAt?<small>Confirmation revoked.</small>:approval?<small>Terms changed; confirmation needs review.</small>:null}
    {canManage&&service.supported&&<>
      <button disabled={disabled||pending||!state.eligible} title={disabled?'Apply or undo row edits first':state.reason||'Review the saved rate, pack and estimate'} onClick={()=>open('review')} style={{...btn('#E8F1FB','#003584',{fontSize:11,padding:6,marginTop:4})}}>{state.confirmed?'Review confirmed terms':'Review variable-weight terms'}</button>
      {!state.eligible&&<small style={{display:'block',marginTop:4}}>{state.reason}</small>}
      {approval&&!approval.revokedAt&&<button disabled={disabled||pending} onClick={()=>open('revoke')} style={{border:0,background:'none',color:'#875200',display:'block',fontSize:11,marginTop:4,cursor:'pointer'}}>Revoke confirmation</button>}
    </>}
    {mode&&<MovableDialog label={mode==='revoke'?'Revoke variable-weight confirmation':'Confirm variable-weight terms'} maxWidth={480} zIndex={1200}>
      <div style={{padding:24,background:'white',borderRadius:10}}>
        <h3 style={{marginTop:0}}>{mode==='revoke'?'Revoke confirmation':'Variable-weight terms'}</h3>
        {mode==='review'?<>
          <p>{listing.description}</p>
          <p>Quoted rate: <b>{formatMoney(listing.price)} per {unitLabel(listing.selling_unit).toLowerCase()}</b><br/>Pack: <b>{listing.pack_size}</b><br/>Case estimate: <b>{estimateLabel}</b></p>
          <p>Final charges depend on delivered weight. Confirming these terms does not place an order.</p>
          <label style={{display:'flex',gap:8,alignItems:'flex-start'}}><input type="checkbox" aria-label="Confirm variable-weight terms" checked={confirmed} disabled={pending||disabled||!state.eligible||changed} onChange={event=>setConfirmed(event.target.checked)}/><span>I confirm this rate and pack and understand the case total is an estimate.</span></label>
          <p style={{fontSize:12}}>Case ordering remains on hold until its purchasing requirements are completed.</p>
        </>:<p>Revoke this confirmation? Its saved history will remain available.</p>}
        {changed&&<p role="alert">The row changed. Close and reopen this review before confirming.</p>}
        {error&&<p role="alert" style={{color:'#A32B20'}}>{error}</p>}
        <div style={{display:'flex',gap:8,marginTop:18}}>
          <button disabled={pending||disabled||(mode==='review'&&(!confirmed||!state.eligible||changed))} onClick={submit} style={btn('#003584','white')}>{pending?'Saving…':mode==='revoke'?'Revoke confirmation':'Confirm terms'}</button>
          <button disabled={pending} onClick={()=>{setMode(null);setConfirmed(false);setError('');}} style={btn('#EEE','#444')}>Cancel</button>
        </div>
      </div>
    </MovableDialog>}
  </div>;
}
