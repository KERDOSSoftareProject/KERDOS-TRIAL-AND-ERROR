import {useState} from "react";
import {backend} from "../backend/index.js";
import {createOperationsService} from "../services/operations.js";
import {createVendorService} from "../services/vendors.js";
import {currencyCode} from "../localization.js";
import {btn,inp} from "../ui/styles.js";

const operationsService=createOperationsService(backend);
const vendorService=createVendorService(backend);

export function InvoiceEditModal({invoice,vendors,onClose,onDone}) {
  const [vendorId,setVendorId]=useState(invoice.vendor_id);
  const [date,setDate]=useState(invoice.invoice_date||"");
  const [invoiceNumber,setInvoiceNumber]=useState(invoice.invoice_number||"");
  const [totalAmount,setTotalAmount]=useState(invoice.total_amount||"");
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");

  async function save(){
    setSaving(true); setError("");
    try{await operationsService.updateInvoice(invoice.id,{vendor_id:vendorId,invoice_date:date||null,invoice_number:invoiceNumber.trim()||null,total_amount:parseFloat(totalAmount)||0});}
    catch(err){setError(err.message);setSaving(false);return;}
    onDone();
    onClose();
  }

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:"white",borderRadius:12,padding:24,width:"100%",maxWidth:400}}>
        <h3 style={{margin:"0 0 16px",fontSize:16}}>Edit invoice</h3>
        <div style={{marginBottom:10}}>
          <div style={{fontSize:12,fontWeight:600,color:"#666",marginBottom:4}}>Vendor</div>
          <select style={inp} value={vendorId} onChange={e=>setVendorId(e.target.value)}>
            {vendors.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </div>
        <div style={{display:"flex",gap:8,marginBottom:10}}>
          <div style={{flex:1}}>
            <div style={{fontSize:12,fontWeight:600,color:"#666",marginBottom:4}}>Invoice date</div>
            <input style={inp} type="date" value={date} onChange={e=>setDate(e.target.value)} />
          </div>
          <div style={{flex:1}}>
            <div style={{fontSize:12,fontWeight:600,color:"#666",marginBottom:4}}>Invoice #</div>
            <input style={inp} value={invoiceNumber} onChange={e=>setInvoiceNumber(e.target.value)} />
          </div>
        </div>
        <div style={{marginBottom:16}}>
          <div style={{fontSize:12,fontWeight:600,color:"#666",marginBottom:4}}>Total amount ({currencyCode()})</div>
          <input style={inp} type="number" step="0.01" value={totalAmount} onChange={e=>setTotalAmount(e.target.value)} />
        </div>
        {error&&<div style={{color:"#E65100",fontSize:12,marginBottom:12}}>{error}</div>}
        <div style={{display:"flex",gap:8}}>
          <button onClick={onClose} style={{...btn("#EEE","#555"),flex:1}}>Cancel</button>
          <button onClick={save} disabled={saving} style={{...btn("#003584"),flex:2}}>{saving?"Saving...":"Save changes"}</button>
        </div>
      </div>
    </div>
  );
}

export function AddVendorModal({orgId,onClose,onDone}) {
  const [name,setName]=useState("");
  const [email,setEmail]=useState("");
  const [minDollar,setMinDollar]=useState("");
  const [minUnits,setMinUnits]=useState("");
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");

  async function save(){
    if(!name.trim()) return;
    setSaving(true); setError("");
    try{await vendorService.add({organizationId:orgId,name,email,minimumDollar:minDollar,minimumUnits:minUnits});}
    catch(err){setError(err.message);setSaving(false);return;}
    onDone();
    onClose();
  }

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:"white",borderRadius:12,padding:24,width:"100%",maxWidth:400}}>
        <h3 style={{margin:"0 0 16px",fontSize:16}}>Add a vendor</h3>
        <div style={{marginBottom:10}}>
          <div style={{fontSize:12,fontWeight:600,color:"#666",marginBottom:4}}>Vendor name</div>
          <input style={inp} value={name} onChange={e=>setName(e.target.value)} placeholder="Vendor name" />
        </div>
        <div style={{marginBottom:10}}>
          <div style={{fontSize:12,fontWeight:600,color:"#666",marginBottom:4}}>Email — where to send orders</div>
          <input style={inp} type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="orders@vendor.com" />
        </div>
        <div style={{display:"flex",gap:8,marginBottom:16}}>
          <div style={{flex:1}}>
            <div style={{fontSize:12,fontWeight:600,color:"#666",marginBottom:4}}>Min order ({currencyCode()})</div>
            <input style={inp} type="number" value={minDollar} onChange={e=>setMinDollar(e.target.value)} placeholder="500" />
          </div>
          <div style={{flex:1}}>
            <div style={{fontSize:12,fontWeight:600,color:"#666",marginBottom:4}}>Min items</div>
            <input style={inp} type="number" value={minUnits} onChange={e=>setMinUnits(e.target.value)} placeholder="20" />
          </div>
        </div>
        {error&&<div style={{color:"#E65100",fontSize:12,marginBottom:12}}>{error}</div>}
        <div style={{display:"flex",gap:8}}>
          <button onClick={onClose} style={{...btn("#EEE","#555"),flex:1}}>Cancel</button>
          <button onClick={save} disabled={saving||!name.trim()} style={{...btn("#003584"),flex:2}}>{saving?"Adding...":"Add vendor"}</button>
        </div>
      </div>
    </div>
  );
}

// ── PASTE MODAL ───────────────────────────────────────────────────────
