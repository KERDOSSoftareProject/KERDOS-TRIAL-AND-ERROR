import {useEffect,useState} from 'react';
import {VendorConnectUnavailable} from '../services/vendor-connect.js';

const dayNames=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const input={padding:'8px 10px',border:'1px solid #B7C8DE',borderRadius:8,font:'inherit',color:'#00204F',background:'white'};
const dateTime=value=>value?new Date(value).toLocaleString():'';
const labels={pending:'Pending',missed:'Missed',in_progress:'In progress',outcome_unknown:'Outcome unknown',received:'Received for review',saved:'Saved',unchanged:'Already up to date',failed:'Stopped',verification_needed:'Sign-in verification needed',closed_unverified:'Closed after review · outcome unverified'};
export default function VendorSchedulePanel({service,request,runnerReady=false,resultKey=null}){
 const [history,setHistory]=useState(null),[draft,setDraft]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[unavailable,setUnavailable]=useState(false),[reviewConfirmed,setReviewConfirmed]=useState(false),[notice,setNotice]=useState('');
 useEffect(()=>{
  let active=true;setHistory(null);setDraft(null);setError('');setUnavailable(false);setLoading(true);setReviewConfirmed(false);setNotice('');
  service.reconcileSchedule(request.id).then(()=>service.scheduleHistory(request.id)).then(value=>{if(!active)return;setHistory(value);setDraft({
   weekdays:value.schedule?.weekdays||[1,2,3,4,5],localTime:value.schedule?.local_time?.slice(0,5)||'06:00',
   timezone:value.schedule?.timezone||Intl.DateTimeFormat().resolvedOptions().timeZone||'America/New_York',
   graceMinutes:value.schedule?.grace_minutes||15,enabled:value.schedule?.enabled||false,
  });}).catch(e=>{if(active){setUnavailable(e instanceof VendorConnectUnavailable);setError(e.message);}}).finally(()=>{if(active)setLoading(false);});
  return()=>{active=false;};
 },[service,request.id,request.transfer_revision,resultKey]);
 async function save(){
  if(loading||!history||!draft)return;
  setLoading(true);setError('');
  try{
   await service.setSchedule({requestId:request.id,expectedVersion:history.schedule?.version||0,...draft});
   const value=await service.scheduleHistory(request.id);setHistory(value);setDraft({
    weekdays:value.schedule.weekdays,localTime:value.schedule.local_time.slice(0,5),timezone:value.schedule.timezone,
    graceMinutes:value.schedule.grace_minutes,enabled:value.schedule.enabled,
   });
  }catch(e){setError(e.message);}finally{setLoading(false);}
 }
 async function closeUnknown(){
  if(loading||!reviewConfirmed||!history?.blocked_by_unknown||!history.unknown_token)return;
  setLoading(true);setError('');setNotice('');
  try{
   await service.closeUnknownSchedule(request.id,history.unknown_token);
   setHistory(await service.scheduleHistory(request.id));setReviewConfirmed(false);
   setNotice('Unverified attempt closed after your review. Future scheduled times can run if the schedule is enabled.');
  }catch(e){setError(e.message);}finally{setLoading(false);}
 }
 if(loading&&!history)return <p role="status">Loading refresh schedule…</p>;
 if(unavailable)return null;
 const pausedForSignIn=!!(history?.schedule&&!history.schedule.enabled&&history.schedule.effective_to==null&&history.slots?.some(slot=>
  slot.state==='verification_needed'&&Number(slot.version)===Number(history.schedule.version)-1));
 const blockedByUnknown=history?.blocked_by_unknown===true||history?.slots?.some(slot=>slot.state==='outcome_unknown');
 return <section aria-label="Pricing refresh schedule" style={{borderTop:'1px solid #B7C8DE',marginTop:22,paddingTop:18}}>
  <h3 style={{margin:'0 0 8px'}}>Pricing refresh schedule</h3>
  <p style={{lineHeight:1.5}}>A scheduled refresh can run only while a signed-in KERDOS tab and your vendor session are open. Missed times are shown below. Refresh prices remains available at any time.</p>
  {error&&<p role="alert">{error}</p>}
  {notice&&<p role="status">{notice}</p>}
  {history&&draft&&<>
   <fieldset style={{border:0,padding:0,margin:'12px 0'}} disabled={loading}>
    <legend>Days</legend>
    <div style={{display:'flex',gap:12,flexWrap:'wrap'}}>{dayNames.map((name,index)=><label key={name}><input type="checkbox" aria-label={name} checked={draft.weekdays.includes(index+1)} onChange={e=>setDraft(v=>({...v,weekdays:e.target.checked?[...v.weekdays,index+1].sort():v.weekdays.filter(d=>d!==index+1)}))}/>{name}</label>)}</div>
   </fieldset>
   <div style={{display:'flex',gap:12,flexWrap:'wrap'}}>
    <label style={{display:'grid',gap:5}}>Local time<input style={input} type="time" aria-label="Schedule local time" value={draft.localTime} disabled={loading} onChange={e=>setDraft(v=>({...v,localTime:e.target.value}))}/></label>
    <label style={{display:'grid',gap:5}}>Time zone<input style={input} aria-label="Schedule time zone" value={draft.timezone} disabled={loading} onChange={e=>setDraft(v=>({...v,timezone:e.target.value}))}/></label>
    <label style={{display:'grid',gap:5}}>Grace (minutes)<input style={{...input,width:90}} type="number" min="1" max="60" aria-label="Schedule grace minutes" value={draft.graceMinutes} disabled={loading} onChange={e=>setDraft(v=>({...v,graceMinutes:Number(e.target.value)}))}/></label>
   </div>
   <label style={{display:'block',margin:'14px 0'}}><input type="checkbox" aria-label="Enable schedule" checked={draft.enabled} disabled={loading||(!runnerReady&&!history.schedule?.enabled)} onChange={e=>setDraft(v=>({...v,enabled:e.target.checked}))}/> Enable this schedule</label>
   {!runnerReady&&<p role="status">{history.schedule?.enabled?'Your schedule is saved. Connect this browser to run it here.':'Connect this browser before enabling scheduled refreshes.'}</p>}
   <button style={{...input,background:'#00204F',color:'white',cursor:'pointer'}} disabled={loading||!draft.weekdays.length||(!runnerReady&&draft.enabled&&!history.schedule?.enabled)} onClick={save}>Save schedule settings</button>
   {history.schedule&&<p role="status">Version {history.schedule.version} · {history.schedule.enabled?'Enabled':'Off'}{blockedByUnknown?' · scheduled runs blocked':''}</p>}
   {pausedForSignIn&&<p role="alert">A scheduled refresh stopped for vendor sign-in verification, so the schedule was turned off. Sign in directly with your vendor, open the selected pricing list, and click Refresh prices. Once that works, enable the schedule and save its settings.</p>}
   {blockedByUnknown&&<p role="alert">A scheduled refresh has an unknown outcome. KERDOS will not start another scheduled export until that attempt is resolved from its original evidence. Check Price Sheets for the source file; changing the schedule will not clear this hold.</p>}
   {blockedByUnknown&&history.unknown_token&&<div style={{border:'1px solid #B7C8DE',padding:12,borderRadius:8}}>
    <p>After reviewing Price Sheets, you can close this attempt as unverified if no retained file resolves it. KERDOS cannot confirm whether the supplier exported the file. Closing it allows future scheduled times if the schedule is enabled; it does not import a file.</p>
    <label><input type="checkbox" aria-label="Confirm unknown refresh review" checked={reviewConfirmed} disabled={loading} onChange={e=>setReviewConfirmed(e.target.checked)}/> I reviewed Price Sheets and understand this attempt's outcome cannot be confirmed.</label>
    <button style={{...input,display:'block',marginTop:10}} disabled={loading||!reviewConfirmed} onClick={closeUnknown}>Close unverified attempt</button>
   </div>}
   <h4>Recent scheduled times</h4>
   {history.slots.length?<ul>{history.slots.map(slot=><li key={`${slot.version}-${slot.slot_at}`}>{dateTime(slot.slot_at)} · {labels[slot.state]||slot.state}{slot.received_at?' · pricing received':''}</li>)}</ul>:<p>No scheduled times in the past 30 days.</p>}
  </>}
 </section>;
}
