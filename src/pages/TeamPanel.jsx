import {useEffect,useState} from "react";
import {backend} from "../backend/index.js";
import {createCategoryService} from "../services/categories.js";
import {createOrganizationService} from "../services/organization.js";
import {DEFAULT_LOCALE,currencyCode,formatDate,formatMoney,localeSettings} from "../localization.js";
import {btn,inp} from "../ui/styles.js";

const categoryService=createCategoryService(backend);
const organizationService=createOrganizationService(backend);

function generateInviteCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  const part = () => Array.from({length:4}, () => chars[Math.floor(Math.random()*chars.length)]).join("");
  return `${part()}-${part()}`;
}

// Industries that have a starter category template - read from
// industry_templates, so adding an industry is a data insert, never a
// code change. Shown as quick-pick chips in Admin; the industry field
// itself stays free text for anything not templated yet.
// Common price-refresh cadences shown as quick-pick chips in Admin - a
// shortcut for the most common choices, with a custom number field
// always available alongside for anything else (or "Never" to turn the
// whole feature off). Cadences are not tied to any industry.
const REFRESH_PRESETS = [[3,"3 days"],[7,"Weekly"],[14,"Every 2 weeks"],[30,"Monthly"]];

export function TeamPanel({orgId,orgName,orgIndustry,orgSettings,categories,myRole,currentUserId,currentUserEmail,onOrgUpdated,logoUrl,onLogoUpload,logoUploading}) {
  const [editingOrgName,setEditingOrgName]=useState(false);
  const [orgNameInput,setOrgNameInput]=useState(orgName);
  const [savingOrgName,setSavingOrgName]=useState(false);
  const [editingIndustry,setEditingIndustry]=useState(false);
  const [industryInput,setIndustryInput]=useState(orgIndustry||"");
  const [savingIndustry,setSavingIndustry]=useState(false);
  // Checked by default: picking an industry and getting that industry's
  // starter categories is the whole point of the Industry field for most
  // people - but it's still a real opt-out, not just an FYI, for anyone
  // who wants to build their category list by hand instead.
  const [autoLoadCategories,setAutoLoadCategories]=useState(true);
  const [industryMsg,setIndustryMsg]=useState("");
  const [editingLocale,setEditingLocale]=useState(false);
  const [localeInput,setLocaleInput]=useState(orgSettings?.locale||DEFAULT_LOCALE);
  const [currencyInput,setCurrencyInput]=useState(orgSettings?.currency||"USD");
  const [savingLocale,setSavingLocale]=useState(false);
  const [editingRefresh,setEditingRefresh]=useState(false);
  const [refreshInput,setRefreshInput]=useState(orgSettings?.price_refresh_days!=null?String(orgSettings.price_refresh_days):"");
  const [refreshMode,setRefreshMode]=useState(orgSettings?.price_refresh_mode==="automatic"?"automatic":"manual");
  const [savingRefresh,setSavingRefresh]=useState(false);
  const [templatedIndustries,setTemplatedIndustries]=useState([]);
  const [members,setMembers]=useState([]);
  const [codes,setCodes]=useState([]);
  const [loading,setLoading]=useState(true);
  const [showInvite,setShowInvite]=useState(false);
  const [inviteRole,setInviteRole]=useState("employee");
  const [newCode,setNewCode]=useState(null);
  const [error,setError]=useState("");

  async function load() {
    setLoading(true);
    try{
      const result=await organizationService.team(orgId);
      setTemplatedIndustries(result.industries);setMembers(result.members);setCodes(result.codes);
    }catch(err){setError(err.message);}
    setLoading(false);
  }

  useEffect(()=>{ load(); },[orgId]);

  async function saveOrgName(){
    if(!orgNameInput.trim()) return;
    setSavingOrgName(true); setError("");
    try{
      await organizationService.update(orgId,{name:orgNameInput.trim()});
      setEditingOrgName(false);
      onOrgUpdated();
    }catch(err){ setError(err.message); }
    setSavingOrgName(false);
  }

  async function saveIndustry(){
    setSavingIndustry(true); setError("");
    setIndustryMsg("");
    try{
      await organizationService.update(orgId,{industry:industryInput.trim()||null});
      if(autoLoadCategories&&industryInput.trim()){
        const {added,addedVocabulary,found}=await categoryService.loadStarterPack({organizationId:orgId,industry:industryInput.trim(),categories});
        setIndustryMsg(!found?`Saved. No starter pack found for "${industryInput.trim()}" yet — add categories and vocabulary manually in Admin below.`:
          (added||addedVocabulary)?`Saved — added ${added} starter categor${added===1?"y":"ies"} and ${addedVocabulary} vocabulary term${addedVocabulary===1?"":"s"} for ${industryInput.trim()}.`:
          "Saved. This industry's starter pack was already all present.");
      }
      setEditingIndustry(false);
      onOrgUpdated();
    }catch(err){ setError(err.message); }
    setSavingIndustry(false);
  }

  // Every org sets its OWN refresh cadence - weekly price sheets and
  // monthly ones want very different windows. Nothing here assumes any
  // particular schedule; it's just a number stored per org. Merging into
  // existing settings so other keys (if any get added later) aren't wiped.
  async function saveRefreshDays(){
    setSavingRefresh(true); setError("");
    const days=refreshMode==="manual"?null:(refreshInput.trim()===""?null:Math.max(1,parseInt(refreshInput,10)||0)||null);
    if(refreshMode==="automatic"&&!days){setError("Select a validity period in days.");setSavingRefresh(false);return;}
    try{
      await organizationService.update(orgId,{settings:{...(orgSettings||{}),price_refresh_mode:refreshMode,price_refresh_days:days}});
      setEditingRefresh(false);
      onOrgUpdated();
    }catch(err){ setError(err.message); }
    setSavingRefresh(false);
  }

  // Money and date format for this org. The currency list is the
  // browser's own ISO 4217 data; the locale is any BCP 47 tag (en-US,
  // en-GB, de-DE...). Merged into settings like every other org setting.
  async function saveLocale(){
    setSavingLocale(true); setError("");
    const locale=localeInput.trim()||DEFAULT_LOCALE;
    const currency=currencyInput.trim().toUpperCase()||"USD";
    try{
      new Intl.NumberFormat(locale,{style:"currency",currency});
    }catch{
      setError(`"${locale}" / "${currency}" is not a locale and currency the browser recognises.`);
      setSavingLocale(false); return;
    }
    try{
      await organizationService.update(orgId,{settings:{...(orgSettings||{}),locale,currency}});
      setEditingLocale(false);
      onOrgUpdated();
    }catch(err){ setError(err.message); }
    setSavingLocale(false);
  }

  async function createInvite() {
    setError("");
    const code=generateInviteCode();
    try{await organizationService.createInvite({organizationId:orgId,code,role:inviteRole,createdBy:currentUserId});}
    catch(err){setError(err.message);return;}
    setNewCode(code);
    load();
  }

  async function revokeCode(c){
    if(!window.confirm("Revoke this invite code? It can no longer be used to join.")) return;
    setError("");
    try{ await organizationService.revokeInvite(c.id); load(); }
    catch(err){ setError(err.message); }
  }

  async function changeRole(m,newRole){
    if(m.role==="owner"&&newRole!=="owner"&&roleCounts.owner<=1){
      alert("You can't change the only owner's role — make someone else an owner first.");
      return;
    }
    setError("");
    try{ await organizationService.changeRole({organizationId:orgId,userId:m.user_id,role:newRole}); load(); }
    catch(err){ setError(err.message); }
  }

  async function removeMember(m){
    if(m.user_id===currentUserId){ alert("You can't remove yourself from the team."); return; }
    if(m.role==="owner"&&roleCounts.owner<=1){ alert("You can't remove the only owner."); return; }
    if(!window.confirm("Remove this person from your team? They'll lose access immediately.")) return;
    setError("");
    try{ await organizationService.removeMember({organizationId:orgId,userId:m.user_id}); load(); }
    catch(err){ setError(err.message); }
  }

  const roleCounts = {
    owner: members.filter(m=>m.role==="owner").length,
    manager: members.filter(m=>m.role==="manager").length,
    employee: members.filter(m=>m.role==="employee").length,
  };
  const roleBadge = (role) => {
    const colors = {owner:{bg:"#E3F2FD",fg:"#1565C0"},manager:{bg:"#E8F5E9",fg:"#2E7D32"},employee:{bg:"#FFF3E0",fg:"#E65100"}};
    const c = colors[role]||colors.employee;
    return <span style={{fontSize:11,fontWeight:700,padding:"3px 9px",borderRadius:10,background:c.bg,color:c.fg,textTransform:"capitalize"}}>{role}</span>;
  };

  if(loading) return <p style={{color:"rgba(255,255,255,0.7)"}}>Loading team...</p>;

  return (
    <div>
      {error&&!showInvite&&<div style={{background:"#FFF3E0",color:"#E65100",padding:"10px 12px",borderRadius:8,fontSize:13,marginBottom:14}}>{error}</div>}
      {myRole==="owner"&&(
        <div style={{background:"white",borderRadius:10,padding:16,marginBottom:16,boxShadow:"0 1px 3px rgba(0,0,0,0.06)"}}>
          <div style={{fontSize:11,fontWeight:800,color:"#999",letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:12}}>Organization</div>

          <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:16}}>
            {logoUrl?(
              <img src={logoUrl} alt={orgName} style={{height:56,maxWidth:120,objectFit:"contain",borderRadius:6}} />
            ):(
              <div style={{fontSize:36,width:56,height:56,display:"flex",alignItems:"center",justifyContent:"center",background:"#F0F2F5",borderRadius:8}}>🦉</div>
            )}
            <label style={{cursor:"pointer",fontSize:12,fontWeight:700,color:"#003584"}}>
              {logoUploading?"Uploading...":logoUrl?"Change logo":"+ Add logo"}
              <input type="file" accept="image/*" style={{display:"none"}} disabled={logoUploading}
                onChange={e=>onLogoUpload(e.target.files[0])} />
            </label>
          </div>

          <div style={{fontSize:10,fontWeight:700,color:"#AAA",letterSpacing:"0.06em",textTransform:"uppercase",marginBottom:4}}>Name</div>
          {!editingOrgName?(
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <div style={{fontWeight:700,fontSize:15}}>{orgName}</div>
              <button onClick={()=>{setOrgNameInput(orgName);setEditingOrgName(true);}} style={{background:"none",border:"none",cursor:"pointer",color:"#888",fontSize:12,padding:0}}>✎ Rename</button>
            </div>
          ):(
            <div style={{display:"flex",gap:8,marginBottom:14}}>
              <input style={{...inp,flex:1}} value={orgNameInput} onChange={e=>setOrgNameInput(e.target.value)} />
              <button onClick={()=>setEditingOrgName(false)} style={{...btn("#EEE","#555",{padding:"10px 14px"})}}>Cancel</button>
              <button onClick={saveOrgName} disabled={savingOrgName} style={{...btn("#003584",undefined,{padding:"10px 14px"})}}>{savingOrgName?"...":"Save"}</button>
            </div>
          )}

          <div style={{fontSize:10,fontWeight:700,color:"#AAA",letterSpacing:"0.06em",textTransform:"uppercase",marginBottom:4}}>Industry</div>
          {!editingIndustry?(
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{fontWeight:700,fontSize:15,color:orgIndustry?"#111":"#BBB"}}>{orgIndustry||"Not set"}</div>
              <button onClick={()=>{setIndustryInput(orgIndustry||"");setEditingIndustry(true);}} style={{background:"none",border:"none",cursor:"pointer",color:"#888",fontSize:12,padding:0}}>✎ Edit</button>
            </div>
          ):(
            <div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:8}}>
                {templatedIndustries.map(p=>(
                  <button key={p} onClick={()=>setIndustryInput(p)}
                    style={{fontSize:11,fontWeight:700,padding:"5px 11px",borderRadius:14,cursor:"pointer",
                      background:industryInput===p?"#003584":"#EEF2F8",color:industryInput===p?"white":"#003584",
                      border:industryInput===p?"2px solid #003584":"2px solid transparent"}}>
                    {p}
                  </button>
                ))}
              </div>
              <label style={{display:"flex",alignItems:"center",gap:7,fontSize:12,color:"#555",margin:"10px 0"}}>
                <input type="checkbox" checked={autoLoadCategories} onChange={e=>setAutoLoadCategories(e.target.checked)} />
                Also load this industry's starter pack (categories and vocabulary) when I save
              </label>
              <div style={{display:"flex",gap:8}}>
                <input style={{...inp,flex:1}} value={industryInput} onChange={e=>setIndustryInput(e.target.value)} placeholder="Or type your own..." />
                <button onClick={()=>setEditingIndustry(false)} style={{...btn("#EEE","#555",{padding:"10px 14px"})}}>Cancel</button>
                <button onClick={saveIndustry} disabled={savingIndustry} style={{...btn("#003584",undefined,{padding:"10px 14px"})}}>{savingIndustry?"...":"Save"}</button>
              </div>
              <div style={{fontSize:11,color:"#999",marginTop:6}}>
                {autoLoadCategories?"Saving will pull in a starter category set for whatever you pick above - fully editable after (rename, add, delete, edit keywords) in Catalog Categories below.":
                  "Auto-load is off - you can still load a starter set manually from Catalog Categories below any time, or build categories by hand."}
              </div>
            </div>
          )}
          {industryMsg&&<div style={{fontSize:12,color:"#2E7D32",marginTop:6}}>{industryMsg}</div>}

          <div style={{fontSize:10,fontWeight:700,color:"#AAA",letterSpacing:"0.06em",textTransform:"uppercase",margin:"14px 0 4px"}}>Money and dates</div>
          {!editingLocale?(
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{fontWeight:700,fontSize:15}}>{currencyCode()} · {localeSettings().locale} <span style={{fontWeight:400,color:"#AAA",fontSize:12}}>e.g. {formatMoney(1234.5)}, {formatDate(new Date().toISOString())}</span></div>
              <button onClick={()=>{setLocaleInput(orgSettings?.locale||DEFAULT_LOCALE);setCurrencyInput(orgSettings?.currency||"USD");setEditingLocale(true);}} style={{background:"none",border:"none",cursor:"pointer",color:"#888",fontSize:12,padding:0}}>✎ Edit</button>
            </div>
          ):(
            <div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                {(()=>{
                  const codes=(typeof Intl.supportedValuesOf==="function")?Intl.supportedValuesOf("currency"):null;
                  return codes?(
                    <select style={{...inp,width:"auto"}} value={currencyInput} onChange={e=>setCurrencyInput(e.target.value)}>
                      {codes.map(c=><option key={c} value={c}>{c}</option>)}
                    </select>
                  ):(
                    <input style={{...inp,width:110}} value={currencyInput} onChange={e=>setCurrencyInput(e.target.value)} placeholder="USD" />
                  );
                })()}
                <input style={{...inp,flex:1,minWidth:140}} value={localeInput} onChange={e=>setLocaleInput(e.target.value)} placeholder={DEFAULT_LOCALE} />
                <button onClick={()=>setEditingLocale(false)} style={{...btn("#EEE","#555",{padding:"10px 14px"})}}>Cancel</button>
                <button onClick={saveLocale} disabled={savingLocale} style={{...btn("#003584",undefined,{padding:"10px 14px"})}}>{savingLocale?"...":"Save"}</button>
              </div>
              <div style={{fontSize:11,color:"#999",marginTop:6}}>
                Currency is the ISO code. Locale sets number and date order — your browser's is {DEFAULT_LOCALE}.
              </div>
            </div>
          )}

          <div style={{fontSize:10,fontWeight:700,color:"#AAA",letterSpacing:"0.06em",textTransform:"uppercase",margin:"14px 0 4px"}}>Price refresh period</div>
          {!editingRefresh?(
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{fontWeight:700,fontSize:15,color:orgSettings?.price_refresh_days?"#111":"#BBB"}}>
                {orgSettings?.price_refresh_mode!=="automatic"?"Manual expiration — prices remain current until explicitly expired":`${orgSettings?.price_refresh_days||"?"} days — automatic expiration`}
              </div>
              <button onClick={()=>{setRefreshInput(orgSettings?.price_refresh_days!=null?String(orgSettings.price_refresh_days):"");setRefreshMode(orgSettings?.price_refresh_mode==="automatic"?"automatic":"manual");setEditingRefresh(true);}} style={{background:"none",border:"none",cursor:"pointer",color:"#888",fontSize:12,padding:0}}>✎ Edit</button>
            </div>
          ):(
            <div>
              <div style={{display:"flex",gap:8,marginBottom:10}}>
                <button onClick={()=>setRefreshMode("manual")} style={{...btn(refreshMode==="manual"?"#003584":"#EEE",refreshMode==="manual"?"white":"#555"),flex:1}}>Manual expiration</button>
                <button onClick={()=>setRefreshMode("automatic")} style={{...btn(refreshMode==="automatic"?"#003584":"#EEE",refreshMode==="automatic"?"white":"#555"),flex:1}}>Automatic expiration</button>
              </div>
              {refreshMode==="automatic"&&<>
              <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:8}}>
                <button onClick={()=>setRefreshInput("")}
                  style={{fontSize:11,fontWeight:700,padding:"5px 11px",borderRadius:14,cursor:"pointer",
                    background:refreshInput===""?"#003584":"#EEF2F8",color:refreshInput===""?"white":"#003584",
                    border:refreshInput===""?"2px solid #003584":"2px solid transparent"}}>
                  Choose a period
                </button>
                {REFRESH_PRESETS.map(([days,label])=>(
                  <button key={days} onClick={()=>setRefreshInput(String(days))}
                    style={{fontSize:11,fontWeight:700,padding:"5px 11px",borderRadius:14,cursor:"pointer",
                      background:refreshInput===String(days)?"#003584":"#EEF2F8",color:refreshInput===String(days)?"white":"#003584",
                      border:refreshInput===String(days)?"2px solid #003584":"2px solid transparent"}}>
                    {label}
                  </button>
                ))}
              </div>
              <div style={{display:"flex",gap:8}}>
                <input type="number" min="1" style={{...inp,flex:1}} value={refreshInput} onChange={e=>setRefreshInput(e.target.value)} placeholder="Or enter a custom number of days..." />
              </div></>}
              <div style={{display:"flex",gap:8,marginTop:8}}>
                <button onClick={()=>setEditingRefresh(false)} style={{...btn("#EEE","#555",{padding:"10px 14px"})}}>Cancel</button>
                <button onClick={saveRefreshDays} disabled={savingRefresh} style={{...btn("#003584",undefined,{padding:"10px 14px"})}}>{savingRefresh?"...":"Save"}</button>
              </div>
              <div style={{fontSize:11,color:"#999",marginTop:6}}>
                Automatic mode expires quotations after the selected period; manual mode expires only when you choose Expire in Price Sheets. Vendor-specified end dates always apply. Historical quotations and recorded invoices remain unchanged.
              </div>
            </div>
          )}
        </div>
      )}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <h3 style={{margin:0,fontSize:16,color:"white"}}>Team</h3>
        <button onClick={()=>{setShowInvite(true);setNewCode(null);setInviteRole("employee");}} style={{...btn("#003584","white",{fontSize:12,padding:"8px 14px"})}}>+ Invite</button>
      </div>

      <div style={{display:"flex",gap:8,marginBottom:16}}>
        <div style={{flex:1,background:"white",borderRadius:10,padding:14,textAlign:"center",boxShadow:"0 1px 3px rgba(0,0,0,0.06)"}}>
          <div style={{fontWeight:900,fontSize:20,color:"#1565C0"}}>{roleCounts.owner}</div>
          <div style={{fontSize:11,color:"#888"}}>Owner{roleCounts.owner!==1?"s":""}</div>
        </div>
        <div style={{flex:1,background:"white",borderRadius:10,padding:14,textAlign:"center",boxShadow:"0 1px 3px rgba(0,0,0,0.06)"}}>
          <div style={{fontWeight:900,fontSize:20,color:"#2E7D32"}}>{roleCounts.manager}</div>
          <div style={{fontSize:11,color:"#888"}}>Manager{roleCounts.manager!==1?"s":""}</div>
        </div>
        <div style={{flex:1,background:"white",borderRadius:10,padding:14,textAlign:"center",boxShadow:"0 1px 3px rgba(0,0,0,0.06)"}}>
          <div style={{fontWeight:900,fontSize:20,color:"#E65100"}}>{roleCounts.employee}</div>
          <div style={{fontSize:11,color:"#888"}}>Employee{roleCounts.employee!==1?"s":""}</div>
        </div>
      </div>

      <div style={{fontSize:11,fontWeight:800,color:"rgba(255,255,255,0.7)",letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:8}}>Members</div>
      {members.map(m=>(
        <div key={m.user_id} style={{background:"white",borderRadius:8,padding:"10px 14px",marginBottom:6,
          display:"flex",justifyContent:"space-between",alignItems:"center",boxShadow:"0 1px 3px rgba(0,0,0,0.06)"}}>
          <div style={{minWidth:0,flex:1}}>
            <div style={{fontWeight:700,fontSize:13,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
              {m.email||(m.user_id===currentUserId?currentUserEmail:null)||"Pending — hasn't logged in yet"}{m.user_id===currentUserId?" (you)":""}
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
            {myRole==="owner"&&m.user_id!==currentUserId?(
              <select value={m.role} onChange={e=>changeRole(m,e.target.value)} style={{fontSize:11,fontWeight:700,padding:"3px 6px",borderRadius:8,border:"1px solid #DDD"}}>
                <option value="owner">Owner</option>
                <option value="manager">Manager</option>
                <option value="employee">Employee</option>
              </select>
            ):roleBadge(m.role)}
            {myRole==="owner"&&m.user_id!==currentUserId&&(
              <button onClick={()=>removeMember(m)} style={{background:"none",border:"none",cursor:"pointer",color:"#E65100",fontSize:16,padding:0}} title="Remove">×</button>
            )}
          </div>
        </div>
      ))}

      <div style={{fontSize:11,fontWeight:800,color:"rgba(255,255,255,0.7)",letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:8,marginTop:16}}>Invite codes</div>
      {codes.length===0?(
        <div style={{background:"white",borderRadius:10,padding:20,textAlign:"center",boxShadow:"0 1px 3px rgba(0,0,0,0.06)"}}>
          <p style={{color:"#888",fontSize:13,margin:0}}>No invite codes yet — create one to bring someone onto your team.</p>
        </div>
      ):codes.map(c=>(
        <div key={c.id} style={{background:"white",borderRadius:8,padding:"10px 14px",marginBottom:6,
          display:"flex",justifyContent:"space-between",alignItems:"center",boxShadow:"0 1px 3px rgba(0,0,0,0.06)"}}>
          <div>
            <div style={{fontFamily:"monospace",fontWeight:700,fontSize:14}}>{c.code}</div>
            <div style={{fontSize:11,color:"#888"}}>{c.used_by?"Used":"Not yet used"}</div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            {roleBadge(c.role)}
            {!c.used_by&&<button onClick={()=>revokeCode(c)} style={{background:"none",border:"none",cursor:"pointer",color:"#E65100",fontSize:11,fontWeight:700,padding:0}}>Revoke</button>}
          </div>
        </div>
      ))}

      {showInvite&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <div style={{background:"white",borderRadius:12,padding:24,width:"100%",maxWidth:380}}>
            {!newCode?(<>
              <h3 style={{margin:"0 0 14px",fontSize:16}}>Invite someone</h3>
              <div style={{fontSize:12,fontWeight:600,color:"#666",marginBottom:6}}>Their role</div>
              <div style={{display:"flex",gap:8,marginBottom:18}}>
                {myRole==="owner"&&(
                  <button onClick={()=>setInviteRole("manager")} style={{...btn(inviteRole==="manager"?"#2E7D32":"#EEE",inviteRole==="manager"?"white":"#555"),flex:1}}>Manager</button>
                )}
                <button onClick={()=>setInviteRole("employee")} style={{...btn(inviteRole==="employee"?"#E65100":"#EEE",inviteRole==="employee"?"white":"#555"),flex:1}}>Employee</button>
              </div>
              {error&&<div style={{color:"#E65100",fontSize:12,marginBottom:12}}>{error}</div>}
              <div style={{display:"flex",gap:8}}>
                <button onClick={()=>setShowInvite(false)} style={{...btn("#EEE","#555"),flex:1}}>Cancel</button>
                <button onClick={createInvite} style={{...btn("#003584"),flex:2}}>Generate code</button>
              </div>
            </>):(<>
              <h3 style={{margin:"0 0 6px",fontSize:16}}>Share this code</h3>
              <p style={{color:"#888",fontSize:12,margin:"0 0 16px"}}>They'll enter this after signing up to join as {inviteRole}.</p>
              <div style={{background:"#F0F2F5",borderRadius:8,padding:"16px",textAlign:"center",fontFamily:"monospace",fontWeight:900,fontSize:24,letterSpacing:"0.1em",marginBottom:16}}>{newCode}</div>
              <button onClick={()=>setShowInvite(false)} style={{...btn("#003584"),width:"100%"}}>Done</button>
            </>)}
          </div>
        </div>
      )}
    </div>
  );
}

// Lets an org manage its own catalog categories directly — see, add,
// rename keyword lists, delete unused categories, or pull a starter set
// based on the org's industry. Nothing here is specific to any one
// client: the same panel runs for every org; the only difference is
// which rows exist in THEIR catalog_categories.

// The actual browsable master item list, AND where review happens - not
// a separate hidden admin section. Search, filter by category, see
// every item's status and every vendor's price side by side, with the
// same export this data already has elsewhere. A single vendor
// introducing a product for the first time has nothing to be uncertain
// about (there's no second vendor's wording to conflict with), so it's
// shown as a clean 100% match, not flagged as "unconfirmed" - only a
// genuine fuzzy merge between two different vendors' wording gets
// flagged, with the real percentage and a way to confirm or correct it.
