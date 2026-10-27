import {useEffect,useState} from 'react';
import {backend} from '../backend/index.js';
import {listAutomaticReceivingAddresses} from '../services/email-routing.js';

// Read-only view. Registrations are created by database lifecycle triggers,
// never by opening this panel or choosing a client, vendor or document type.
export function ReceivingAddressList({addresses=[],vendors=[],documentType=null,error='',loading=false}){
  const [copyStatus,setCopyStatus]=useState('');
  const shown=addresses.filter(address=>!documentType||address.document_type===documentType);
  async function copy(address){
    try{await navigator.clipboard.writeText(address);setCopyStatus('Address copied');}
    catch{setCopyStatus('Could not copy address');}
  }
  return <section aria-label="Automatic email receiving" style={{background:'white',borderRadius:10,padding:16,marginBottom:16,color:'#17243A'}}>
    <h4 style={{margin:'0 0 8px'}}>Automatic email receiving</h4>
    <p style={{fontSize:12,margin:'0 0 10px'}}>Incoming documents are routed and processed automatically. No upload or selection is needed.</p>
    {loading?<p>Loading receiving addresses…</p>:error?<p role="status">Receiving addresses are temporarily unavailable.</p>:!shown.length?<p role="status">Email receiving is awaiting platform configuration. No client setup is required.</p>:<ul style={{paddingLeft:18,margin:0}}>
      {shown.map(address=><li key={address.id} style={{marginBottom:8}}>
        <strong>{vendors.find(vendor=>vendor.id===address.vendor_id)?.name||'Vendor'}</strong>
        {!documentType&&<span> · {address.document_type==='invoice'?'Invoices':'Price sheets'}</span>}
        <div><code>{address.routing_address}</code> <button onClick={()=>copy(address.routing_address)} aria-label={`Copy ${address.routing_address}`}>Copy address</button></div>
      </li>)}
    </ul>}
    {copyStatus&&<p role="status">{copyStatus}</p>}
  </section>;
}
export function ReceivingAddressesPanel({orgId,vendors=[],documentType=null}){
  const [addresses,setAddresses]=useState([]),[error,setError]=useState(''),[loading,setLoading]=useState(false);
  useEffect(()=>{
    let current=true;
    setAddresses([]);setError('');
    if(!orgId)return ()=>{current=false;};
    setLoading(true);
    listAutomaticReceivingAddresses(backend,orgId,documentType).then(rows=>{if(current)setAddresses(rows);})
      .catch(problem=>{if(current)setError(problem.message);}).finally(()=>{if(current)setLoading(false);});
    return ()=>{current=false;};
  },[orgId,documentType]);
  return <ReceivingAddressList addresses={addresses} vendors={vendors} documentType={documentType} error={error} loading={loading}/>;
}
