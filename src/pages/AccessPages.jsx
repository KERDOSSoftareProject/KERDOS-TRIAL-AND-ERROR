import {useEffect,useState} from "react";
import {backend} from "../backend/index.js";
import {createOrganizationService} from "../services/organization.js";
import {currencyCode} from "../localization.js";
import {btn,inp} from "../ui/styles.js";

const organizationService=createOrganizationService(backend);
export function LandingGate() {
  const [mode,setMode]=useState("login");
  const [email,setEmail]=useState("");
  const [password,setPassword]=useState("");
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");

  async function submit(e) {
    e.preventDefault(); setLoading(true); setError(""); setNotice("");
    try{
      if(mode==="login") await backend.session.signIn({email,password});
      else await backend.session.signUp({email,password});
      if(mode==="signup") setNotice("Check your email to confirm, then sign in.");
    }catch(err){setError(err.message||String(err));}
    setLoading(false);
  }

  const SERVICES=[
    {icon:"💰",color:"#2E7D32",bg:"#E8F5E9",name:"Price Comparison",tag:null,
      text:"See every vendor's price for the same product side-by-side, ranked cheapest first.",
      value:"Save money on every order."},
    {icon:"✅",color:"#1565C0",bg:"#E3F2FD",name:"Price Verification",tag:null,
      text:"Every invoice is checked against what was quoted, automatically — mismatches are flagged.",
      value:"Ensures the price you're quoted is the price you pay."},
    {icon:"🗄️",color:"#6A1B9A",bg:"#F3E5F5",name:"Invoice Retention",tag:null,
      text:"Every invoice kept and organized, never lost in a shoebox or a shared drive.",
      value:"Built for audit-ready record keeping."},
    {icon:"🔗",color:"#888",bg:"#F0F0F0",name:"QuickBooks Integration",tag:"Coming Soon",
      text:"Send recorded invoices straight to QuickBooks — no re-entry.",
      value:"Easier accounting, one click away."},
    {icon:"📦",color:"#E65100",bg:"#FFF3E0",name:"Inventory Management",tag:null,
      text:"Every purchase already tracked — set a par level per item and know when you're running low.",
      value:"Never run out, never over-order."},
  ];

  return (
    <div style={{minHeight:"100vh",background:"linear-gradient(160deg,#003584 0%,#00204F 100%)",padding:"48px 20px 60px"}}>
      <div style={{textAlign:"center",marginBottom:40}}>
        <div style={{fontSize:64,marginBottom:14}}>🦉</div>
        <div style={{fontWeight:900,fontSize:34,letterSpacing:"0.2em",color:"white",marginBottom:14}}>KERDOS</div>
        <div style={{fontWeight:900,fontSize:22,color:"white",marginBottom:10,maxWidth:480,marginLeft:"auto",marginRight:"auto",lineHeight:1.3}}>
          Stop overpaying because you didn't check the other vendor.
        </div>
        <div style={{color:"rgba(255,255,255,0.7)",fontSize:15,maxWidth:480,margin:"0 auto"}}>
          Procurement software that compares vendor prices for you, keeps your ordering and records in one place.
        </div>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(260px, 1fr))",gap:16,maxWidth:1000,margin:"0 auto 40px"}}>
        {SERVICES.map((s,i)=>(
          <div key={i} style={{background:"rgba(255,255,255,0.08)",borderRadius:14,padding:"20px",position:"relative"}}>
            {s.tag&&<div style={{position:"absolute",top:14,right:14,fontSize:10,fontWeight:800,color:"white",background:"rgba(255,255,255,0.2)",padding:"3px 8px",borderRadius:20}}>{s.tag}</div>}
            <div style={{width:44,height:44,borderRadius:12,background:s.bg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,marginBottom:12}}>{s.icon}</div>
            <div style={{color:"white",fontWeight:800,fontSize:16,marginBottom:6}}>{s.name}</div>
            <div style={{color:"rgba(255,255,255,0.75)",fontSize:13,lineHeight:1.45,marginBottom:8}}>{s.text}</div>
            <div style={{color:s.tag?"rgba(255,255,255,0.5)":"#69F0AE",fontWeight:700,fontSize:12}}>{s.value}</div>
          </div>
        ))}
      </div>

      <div style={{background:"white",borderRadius:12,padding:28,width:"100%",maxWidth:380,margin:"0 auto",boxShadow:"0 4px 20px rgba(0,0,0,0.3)"}}>
        <div style={{display:"flex",background:"#F0F2F5",borderRadius:8,padding:3,marginBottom:20}}>
          <button onClick={()=>{setMode("login");setError("");setNotice("");}}
            style={{flex:1,padding:"9px",borderRadius:6,border:"none",cursor:"pointer",fontWeight:700,fontSize:13,
              background:mode==="login"?"white":"transparent",color:mode==="login"?"#003584":"#888",
              boxShadow:mode==="login"?"0 1px 3px rgba(0,0,0,0.1)":"none"}}>
            Sign In
          </button>
          <button onClick={()=>{setMode("signup");setError("");setNotice("");}}
            style={{flex:1,padding:"9px",borderRadius:6,border:"none",cursor:"pointer",fontWeight:700,fontSize:13,
              background:mode==="signup"?"white":"transparent",color:mode==="signup"?"#003584":"#888",
              boxShadow:mode==="signup"?"0 1px 3px rgba(0,0,0,0.1)":"none"}}>
            Sign Up
          </button>
        </div>
        <form onSubmit={submit}>
          <div style={{marginBottom:12}}>
            <input style={inp} type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="Email" required />
          </div>
          <div style={{marginBottom:16}}>
            <input style={inp} type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Password" required />
          </div>
          {error&&<div style={{background:"#FFF3E0",color:"#E65100",padding:"10px 12px",borderRadius:8,fontSize:13,marginBottom:12}}>{error}</div>}
          {notice&&<div style={{background:"#E8F5E9",color:"#2E7D32",padding:"10px 12px",borderRadius:8,fontSize:13,marginBottom:12}}>{notice}</div>}
          <button type="submit" disabled={loading} style={{...btn("#003584"),width:"100%"}}>
            {loading?"Please wait...":mode==="login"?"Sign In":"Create Account"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ── SETUP WIZARD ─────────────────────────────────────────────────────
const SETUP_DRAFT_KEY = "kerdos_setup_draft";

function Setup({user,onComplete}) {
  // Nothing here is saved to the database until the final "Get Started"
  // click - it's a multi-step form, so a refresh, an accidental
  // navigation, or just stepping away mid-fill would otherwise lose
  // everything typed. Autosaving a local draft (keyed to this browser
  // AND this specific user, so it can't leak to someone else signing up
  // on the same shared computer) means coming back restores exactly
  // where you left off, without needing a half-created organization
  // sitting in the database in the meantime.
  const draftKey = SETUP_DRAFT_KEY + "_" + user.id;
  const [step,setStep]=useState(1);
  const [orgName,setOrgName]=useState("");
  const [industry,setIndustry]=useState("");
  const [availableIndustries,setAvailableIndustries]=useState([]);
  useEffect(()=>{
    organizationService.templatedIndustries().then(list=>{
      if(list?.length) setAvailableIndustries(list);
    }).catch(()=>{});
  },[]);
  const [vendors,setVendors]=useState([{name:"",minDollar:"",minUnits:""}]);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const [draftRestored,setDraftRestored]=useState(false);

  useEffect(()=>{
    try{
      const saved=localStorage.getItem(draftKey);
      if(saved){
        const d=JSON.parse(saved);
        if(d.orgName) setOrgName(d.orgName);
        if(d.industry) setIndustry(d.industry);
        if(d.vendors&&d.vendors.length) setVendors(d.vendors);
        if(d.step) setStep(d.step);
        if(d.orgName||d.industry) setDraftRestored(true);
      }
    }catch{/* corrupted or unavailable draft - just start fresh */}
  },[]);

  useEffect(()=>{
    try{
      localStorage.setItem(draftKey,JSON.stringify({step,orgName,industry,vendors}));
    }catch{/* storage full/unavailable - draft save is best-effort, never blocks typing */}
  },[step,orgName,industry,vendors]);

  async function create() {
    setLoading(true); setError("");
    try {
      const org=await organizationService.create({name:orgName,industry,userId:user.id,vendors});
      try{localStorage.removeItem(draftKey);}catch{}
      onComplete(org);
    } catch(err){setError(err.message);}
    setLoading(false);
  }

  return (
    <div style={{minHeight:"100vh",background:"#F0F2F5",display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:"white",borderRadius:12,padding:28,width:"100%",maxWidth:480,boxShadow:"0 2px 8px rgba(0,0,0,0.1)"}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
          <span style={{fontSize:20}}>🦉</span>
          <span style={{fontWeight:900,fontSize:16,letterSpacing:"0.18em",color:"#003584"}}>KERDOS</span>
        </div>
        <h2 style={{margin:"0 0 4px",fontSize:18}}>Welcome — let's get set up</h2>
        <p style={{color:"#888",fontSize:13,margin:"0 0 20px"}}>Takes about 2 minutes.</p>
        {draftRestored&&(
          <div style={{background:"#E8F5E9",color:"#2E7D32",fontSize:12,fontWeight:600,borderRadius:6,padding:"8px 10px",marginBottom:14}}>
            ✓ Picked up where you left off
          </div>
        )}

        {step===1&&<>
          <div style={{marginBottom:12}}>
            <div style={{fontSize:12,fontWeight:600,color:"#666",marginBottom:4}}>Organization name</div>
            <input style={inp} value={orgName} onChange={e=>setOrgName(e.target.value)} placeholder="Your organization's name" />
          </div>
          <div style={{marginBottom:20}}>
            <div style={{fontSize:12,fontWeight:600,color:"#666",marginBottom:4}}>Industry</div>
            {availableIndustries.length>0
              ?<select style={inp} value={industry} onChange={e=>setIndustry(e.target.value)}>
                  <option value="">Select your industry</option>
                  {availableIndustries.map(ind=><option key={ind} value={ind}>{ind.charAt(0).toUpperCase()+ind.slice(1)}</option>)}
                </select>
              :<input style={inp} value={industry} onChange={e=>setIndustry(e.target.value)} placeholder="e.g. restaurant, construction, medical" />
            }
          </div>
          <button onClick={()=>setStep(2)} disabled={!orgName.trim()} style={{...btn("#003584"),width:"100%"}}>Next →</button>
        </>}

        {step===2&&<>
          <p style={{fontSize:13,color:"#555",margin:"0 0 14px"}}>Add your vendors — you can add more later.</p>
          {vendors.map((v,i)=>(
            <div key={i} style={{background:"#F8F9FA",borderRadius:8,padding:12,marginBottom:10}}>
              <div style={{marginBottom:8}}>
                <div style={{fontSize:12,fontWeight:600,color:"#666",marginBottom:4}}>Vendor name</div>
                <input style={inp} value={v.name} onChange={e=>{const vv=[...vendors];vv[i].name=e.target.value;setVendors(vv);}} placeholder="Vendor name" />
              </div>
              <div style={{display:"flex",gap:8}}>
                <div style={{flex:1}}>
                  <div style={{fontSize:12,fontWeight:600,color:"#666",marginBottom:4}}>Min order ({currencyCode()})</div>
                  <input style={inp} value={v.minDollar} onChange={e=>{const vv=[...vendors];vv[i].minDollar=e.target.value;setVendors(vv);}} placeholder="500" type="number" />
                </div>
                <div style={{flex:1}}>
                  <div style={{fontSize:12,fontWeight:600,color:"#666",marginBottom:4}}>Min items</div>
                  <input style={inp} value={v.minUnits} onChange={e=>{const vv=[...vendors];vv[i].minUnits=e.target.value;setVendors(vv);}} placeholder="20" type="number" />
                </div>
              </div>
            </div>
          ))}
          <button onClick={()=>setVendors([...vendors,{name:"",minDollar:"",minUnits:""}])}
            style={{...btn("#F0F2F5","#555"),width:"100%",marginBottom:10}}>+ Add Vendor</button>
          {error&&<div style={{color:"#E65100",fontSize:13,marginBottom:10}}>{error}</div>}
          <div style={{display:"flex",gap:8}}>
            <button onClick={()=>setStep(1)} style={{...btn("#EEE","#555"),flex:1}}>← Back</button>
            <button onClick={create} disabled={loading} style={{...btn("#003584"),flex:2}}>
              {loading?"Creating...":"Get Started →"}
            </button>
          </div>
        </>}
      </div>
    </div>
  );
}

export function OrgGate({user,onComplete}) {
  const [path,setPath]=useState(null); // null | "create" | "join"

  if(path==="create") return <Setup user={user} onComplete={onComplete} />;
  if(path==="join") return <JoinWithCode user={user} onComplete={onComplete} onBack={()=>setPath(null)} />;

  return (
    <div style={{minHeight:"100vh",background:"#F0F2F5",display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:"white",borderRadius:12,padding:28,width:"100%",maxWidth:420,boxShadow:"0 2px 8px rgba(0,0,0,0.1)",textAlign:"center"}}>
        <div style={{display:"flex",justifyContent:"center",marginBottom:8}}><span style={{fontSize:36}}>🦉</span></div>
        <h2 style={{margin:"0 0 4px",fontSize:18}}>Welcome to KERDOS</h2>
        <p style={{color:"#888",fontSize:13,margin:"0 0 24px"}}>Are you starting a new organization, or joining one your team already set up?</p>
        <button onClick={()=>setPath("create")} style={{...btn("#003584"),width:"100%",marginBottom:10}}>Create a new organization</button>
        <button onClick={()=>setPath("join")} style={{...btn("#F0F2F5","#555"),width:"100%"}}>Join with an invite code</button>
      </div>
    </div>
  );
}

function JoinWithCode({user,onComplete,onBack}) {
  const [code,setCode]=useState("");
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");

  async function join() {
    setLoading(true); setError("");
    try {
      const cleanCode=code.trim().toUpperCase();
      await backend.team.acceptInvite(cleanCode,user.id);
      onComplete();
    } catch(err){setError(err.message);}
    setLoading(false);
  }

  return (
    <div style={{minHeight:"100vh",background:"#F0F2F5",display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:"white",borderRadius:12,padding:28,width:"100%",maxWidth:420,boxShadow:"0 2px 8px rgba(0,0,0,0.1)"}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:16}}>
          <span style={{fontSize:20}}>🦉</span>
          <span style={{fontWeight:900,fontSize:16,letterSpacing:"0.18em",color:"#003584"}}>KERDOS</span>
        </div>
        <h2 style={{margin:"0 0 4px",fontSize:18}}>Join your team</h2>
        <p style={{color:"#888",fontSize:13,margin:"0 0 20px"}}>Enter the invite code your owner or manager shared with you.</p>
        <input style={{...inp,textAlign:"center",fontSize:20,letterSpacing:"0.1em",fontWeight:700,marginBottom:14}}
          value={code} onChange={e=>setCode(e.target.value)} placeholder="XXXX-XXXX" />
        {error&&<div style={{color:"#E65100",fontSize:13,marginBottom:14}}>{error}</div>}
        <div style={{display:"flex",gap:8}}>
          <button onClick={onBack} style={{...btn("#EEE","#555"),flex:1}}>← Back</button>
          <button onClick={join} disabled={loading||!code.trim()} style={{...btn("#003584"),flex:2}}>
            {loading?"Joining...":"Join team →"}
          </button>
        </div>
      </div>
    </div>
  );
}
