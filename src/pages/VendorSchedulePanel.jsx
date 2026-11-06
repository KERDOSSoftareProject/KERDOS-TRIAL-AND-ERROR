import {useEffect,useState} from 'react';
import {VendorConnectUnavailable} from '../services/vendor-connect.js';

const dayNames=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const input={padding:'8px 10px',border:'1px solid #B7C8DE',borderRadius:8,font:'inherit',color:'#00204F',background:'white'};
const dateTime=value=>value?new Date(value).toLocaleString():'';
const labels={pending:'Pending',missed:'Missed',in_progress:'In progress',outcome_unknown:'Outcome unknown',received:'Received for review',saved:'Saved',unchanged:'Already up to date',failed:'Stopped',verification_needed:'Sign-in verification needed'};
export default function VendorSchedulePanel({service,request,runnerReady=false}){
 const [history,setHistory]=useState(null),[draft,setDraft]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[unavailable,setUnavailable]=useState(false);
 useEffect(()=>{
  let active=true;setHistory(null);setDraft(null);setError('');setUnavailable(false);setLoading(true);
  service.scheduleHistory(request.id).then(value=>{if(!active)return;setHistory(value);setDraft({
   weekdays:value.schedule?.weekdays||[1,2,3,4,5],localTime:value.schedule?.local_time?.slice(0,5)||'06:00',
   timezone:value.schedule?.timezone||Intl.DateTimeFormat().resolvedOptions().timeZone||'America/New_York',
   graceMinutes:value.schedule?.grace_minutes||15,enabled:value.schedule?.enabled||false,
  });}).catch(e=>{if(active){setUnavailable(e instanceof VendorConnectUnavailable);setError(e.message);}}).finally(()=>{if(active)setLoading(false);});
  return()=>{active=false;};
 },[service,request.id,request.transfer_revision]);
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
 if(loading&&!history)return <p role="status">Loading refresh schedule…</p>;
 if(unavailable)return null;
 return <section aria-label="Pricing refresh schedule" style={{borderTop:'1px solid #B7C8DE',marginTop:22,paddingTop:18}}>
  <h3 style={{margin:'0 0 8px'}}>Pricing refresh schedule</h3>
  <p style={{lineHeight:1.5}}>A scheduled refresh can run only while a signed-in KERDOS tab and your vendor session are open. Missed times are shown below. Refresh prices remains available at any time.</p>
  {error&&<p role="alert">{error}</p>}
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
   {!runnerReady&&<p role="status">Scheduling is being prepared. You can save settings with the schedule off; automatic runs cannot be enabled yet.</p>}
   <button style={{...input,background:'#00204F',color:'white',cursor:'pointer'}} disabled={loading||!draft.weekdays.length||(!runnerReady&&draft.enabled&&!history.schedule?.enabled)} onClick={save}>Save schedule settings</button>
   {history.schedule&&<p role="status">Version {history.schedule.version} · {history.schedule.enabled?'Enabled':'Off'}</p>}
   <h4>Recent scheduled times</h4>
   {history.slots.length?<ul>{history.slots.map(slot=><li key={`${slot.version}-${slot.slot_at}`}>{dateTime(slot.slot_at)} · {labels[slot.state]||slot.state}{slot.received_at?' · pricing received':''}</li>)}</ul>:<p>No scheduled times in the past 30 days.</p>}
  </>}
 </section>;
}
