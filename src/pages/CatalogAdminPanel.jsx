import {useMemo,useState} from "react";
import {backend,backendInfo} from "../backend/index.js";
import {createCategoryService,holdingPen} from "../services/categories.js";
import {btn,inp} from "../ui/styles.js";
import {industryDictionary} from "../knowledge/category-profiles.js";

const categoryService=createCategoryService(backend);
function withTimeout(promise,ms,label){return Promise.race([promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error(`${label} timed out after ${ms/1000}s - check your connection and try again`)),ms))]);}

export function CatalogPanel({orgId,orgIndustry,categories,catalogItems,vocabulary,onUpdated}) {
  const [adding,setAdding]=useState(false);
  const [vocabKind,setVocabKind]=useState("synonym");
  const [vocabTerm,setVocabTerm]=useState("");
  const [vocabCanonical,setVocabCanonical]=useState("");
  const [vocabBusy,setVocabBusy]=useState(false);
  const [newName,setNewName]=useState("");
  const [newKeywords,setNewKeywords]=useState("");
  const [editingId,setEditingId]=useState(null);
  const [editKeywords,setEditKeywords]=useState("");
  const [loadingTemplate,setLoadingTemplate]=useState(false);
  const [templateMsg,setTemplateMsg]=useState("");
  const [reclassifying,setReclassifying]=useState(false);
  const [reclassifyMsg,setReclassifyMsg]=useState("");
  const [error,setError]=useState("");
  const [dictionarySearch,setDictionarySearch]=useState("");
  const bundled=useMemo(()=>industryDictionary(orgIndustry),[orgIndustry]);
  const dictionaryEntries=useMemo(()=>Object.entries(bundled.groups).flatMap(([group,entries])=>entries.map(entry=>({...entry,group}))),[bundled]);
  const dictionaryMatches=useMemo(()=>{
    const query=dictionarySearch.trim().toLowerCase();
    if(!query)return [];
    return dictionaryEntries.filter(entry=>[entry.term,...entry.aliases,entry.meaning,entry.group].some(text=>text.toLowerCase().includes(query)));
  },[dictionaryEntries,dictionarySearch]);

  const uncategorizedCategory=useMemo(()=>holdingPen(categories),[categories]);

  async function reclassifyUncategorized(){
    setReclassifying(true);
    setReclassifyMsg("");
    setError("");
    try{
      const {moved,checked,matchedButFailed,firstWriteError}=await withTimeout(categoryService.reclassifyUncategorized({catalogItems,categories}),20000,"Reclassify");
      if(matchedButFailed>0){
        // These DID match a category - the write itself failed. Almost
        // certainly a database permissions (RLS) problem, not a
        // dictionary gap - showing this as "none matched" would point
        // straight at the wrong cause.
        setError(`${matchedButFailed} item(s) matched a category but failed to save${firstWriteError?`: ${firstWriteError}`:" (unknown database error)"}.`);
        setReclassifyMsg(moved>0?`Moved ${moved} of ${checked} item(s) — the rest failed to save (see error above).`:"");
      }else{
        setReclassifyMsg(checked===0?"Nothing in Uncategorized right now.":
          moved===0?`Checked ${checked} item(s) in Uncategorized — none had a confident contextual match.`:
          `Moved ${moved} of ${checked} item(s) out of Uncategorized into a matching category.`);
      }
      onUpdated();
    }catch(err){
      setError(`Reclassify failed: ${err.message||String(err)}`);
    }finally{
      setReclassifying(false);
    }
  }

  const itemCounts=useMemo(()=>{
    const m={};
    catalogItems.forEach(ci=>{ if(ci.category_id) m[ci.category_id]=(m[ci.category_id]||0)+1; });
    return m;
  },[catalogItems]);

  const uncategorizedCount=useMemo(()=>uncategorizedCategory?itemCounts[uncategorizedCategory.id]||0:0,[uncategorizedCategory,itemCounts]);


  async function addCategory(){
    if(!newName.trim()) return;
    const keywords=newKeywords.split(",").map(k=>k.trim()).filter(Boolean);
    try{ await categoryService.addCategory({organizationId:orgId,name:newName,keywords,categories}); }
    catch(err){ setError(err.message); return; }
    setNewName("");setNewKeywords("");setAdding(false);setError("");
    onUpdated();
  }

  async function saveKeywords(cat){
    const keywords=editKeywords.split(",").map(k=>k.trim()).filter(Boolean);
    setError("");
    try{
      await categoryService.updateKeywords(cat.id,keywords);
      setEditingId(null);
      onUpdated();
    }catch(err){ setError(err.message); }
  }

  async function deleteCategory(cat){
    if(itemCounts[cat.id]>0){
      alert(`Can't delete "${cat.name}" — ${itemCounts[cat.id]} catalog item(s) are still assigned to it. Reassign them first.`);
      return;
    }
    if(!window.confirm(`Delete category "${cat.name}"?`)) return;
    setError("");
    try{
      await categoryService.deleteCategory(cat.id);
      onUpdated();
    }catch(err){ setError(err.message); }
  }

  // The org's vocabulary is how the matching engine learns this trade's
  // language: a unit, a packaging word, a stopword, or a synonym. Every
  // row is data the org owns; the engine itself never changes.
  async function addVocabulary(){
    const term=vocabTerm.trim().toLowerCase();
    const canonical=vocabCanonical.trim();
    const needsCanonical=vocabKind==="unit"||vocabKind==="synonym";
    if(!term||(needsCanonical&&!canonical)) return;
    setVocabBusy(true); setError("");
    try{
      await categoryService.addVocabulary({organizationId:orgId,kind:vocabKind,term,canonical:needsCanonical?canonical:null});
      setVocabTerm(""); setVocabCanonical("");
      onUpdated();
    }catch(err){ setError(err.message); }
    setVocabBusy(false);
  }
  async function removeVocabulary(row){
    setError("");
    try{
      await categoryService.removeVocabulary(row.id);
      onUpdated();
    }catch(err){ setError(err.message); }
  }

  async function loadStarterTemplate(){
    setLoadingTemplate(true);
    setTemplateMsg("");
    setError("");
    if(!orgIndustry){
      setTemplateMsg("Set an industry for this org above first.");
      setLoadingTemplate(false);
      return;
    }
    try{
      const {added,addedVocabulary,found}=await withTimeout(categoryService.loadStarterPack({organizationId:orgId,industry:orgIndustry,categories}),20000,"Load starter pack");
      setTemplateMsg(!found?`No starter pack found for "${orgIndustry}" yet — add categories and vocabulary manually below, or ask for that industry to be added.`:
        (added||addedVocabulary)?`Added ${added} starter categor${added===1?"y":"ies"} and ${addedVocabulary} vocabulary term${addedVocabulary===1?"":"s"}.`:"This industry's starter pack is already all present.");
      onUpdated();
    }catch(err){
      setError(`Load starter pack failed: ${err.message||String(err)}`);
    }finally{
      setLoadingTemplate(false);
    }
  }

  return (
    <div>
      {!backendInfo.configured&&(
        <div style={{background:"#FFF8E1",border:"1px solid #FFE082",borderRadius:8,padding:"8px 11px",fontSize:11,color:"#8D6E63",marginBottom:12}}>
          No backend is configured for this deployment. Configure a KERDOS backend adapter
          before using this workspace.
        </div>
      )}

      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <h3 style={{margin:0,fontSize:16,color:"white"}}>Catalog Categories</h3>
        <button onClick={()=>setAdding(true)} style={{...btn("#003584","white",{fontSize:12,padding:"8px 14px"})}}>+ Category</button>
      </div>

      {error&&<div style={{background:"#FFF3E0",color:"#E65100",padding:"10px 12px",borderRadius:8,fontSize:13,marginBottom:14}}>{error}</div>}

      <div style={{background:"white",borderRadius:10,padding:14,marginBottom:16,boxShadow:"0 1px 3px rgba(0,0,0,0.06)"}}>
        <div style={{fontSize:12,color:"#666",marginBottom:8}}>
          Pull the starter pack for this org's industry{orgIndustry?<> (<b>{orgIndustry}</b>)</>:""}: categories with keywords, and the vocabulary the matching engine reads. Fully editable after — nothing here is locked to any one client.
        </div>
        <button onClick={loadStarterTemplate} disabled={loadingTemplate} style={{...btn("#2E7D32","white",{fontSize:12,padding:"8px 14px"})}}>
          {loadingTemplate?"Loading...":"Load starter pack"}
        </button>
        {templateMsg&&<div style={{fontSize:11,color:"#888",marginTop:8}}>{templateMsg}</div>}
      </div>

      {uncategorizedCount>0&&(
        <div style={{background:"white",borderRadius:10,padding:14,marginBottom:16,boxShadow:"0 1px 3px rgba(0,0,0,0.06)"}}>
          <div style={{fontSize:12,color:"#666",marginBottom:8}}>
            <b>{uncategorizedCount}</b> item{uncategorizedCount===1?"":"s"} currently sitting in Uncategorized and need to be allocated — these didn't match any category's keywords (either at import time, or before the category existed at all). Re-check now against the categories and keywords you have today.
          </div>
          <button onClick={reclassifyUncategorized} disabled={reclassifying} style={{...btn("#2E7D32","white",{fontSize:12,padding:"8px 14px"})}}>
            {reclassifying?"Checking...":"Reclassify Uncategorized items"}
          </button>
          {reclassifyMsg&&<div style={{fontSize:11,color:"#888",marginTop:8}}>{reclassifyMsg}</div>}
        </div>
      )}

      {categories.length===0?(
        <div style={{background:"white",borderRadius:10,padding:20,textAlign:"center",boxShadow:"0 1px 3px rgba(0,0,0,0.06)"}}>
          <p style={{color:"#888",fontSize:13,margin:0}}>No categories yet — everything imported so far lands in the holding category automatically. Add categories or load a starter pack above.</p>
        </div>
      ):categories.map(cat=>{
        const isEditing=editingId===cat.id;
        return (
          <div key={cat.id} style={{background:"white",borderRadius:8,padding:"12px 14px",marginBottom:8,boxShadow:"0 1px 3px rgba(0,0,0,0.06)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:isEditing?8:0}}>
              <div style={{fontWeight:700,fontSize:14}}>{cat.name} <span style={{fontWeight:400,fontSize:11,color:"#AAA"}}>({itemCounts[cat.id]||0} item{itemCounts[cat.id]===1?"":"s"})</span></div>
              <div style={{display:"flex",gap:10,alignItems:"center"}}>
                {!isEditing&&<button onClick={()=>{setEditingId(cat.id);setEditKeywords((cat.keywords||[]).join(", "));}} style={{background:"none",border:"none",cursor:"pointer",color:"#888",fontSize:12,padding:0}}>✎ Keywords</button>}
                {!cat.is_holding_pen&&<button onClick={()=>deleteCategory(cat)} style={{background:"none",border:"none",cursor:"pointer",color:"#E65100",fontSize:16,padding:0}} title="Delete">×</button>}
              </div>
            </div>
            {isEditing?(
              <div>
                <textarea value={editKeywords} onChange={e=>setEditKeywords(e.target.value)}
                  placeholder="comma, separated, keywords"
                  style={{...inp,width:"100%",minHeight:60,fontFamily:"inherit",boxSizing:"border-box"}} />
                <div style={{display:"flex",gap:8,marginTop:8}}>
                  <button onClick={()=>setEditingId(null)} style={{...btn("#EEE","#555",{padding:"8px 14px",fontSize:12}),flex:1}}>Cancel</button>
                  <button onClick={()=>saveKeywords(cat)} style={{...btn("#003584",undefined,{padding:"8px 14px",fontSize:12}),flex:1}}>Save</button>
                </div>
              </div>
            ):(
              <div style={{fontSize:11,color:"#AAA"}}>{(cat.keywords||[]).length?(cat.keywords||[]).join(", "):"No keywords set — new items won't auto-match into this category yet."}</div>
            )}
          </div>
        );
      })}

      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",margin:"24px 0 6px"}}>
        <h3 style={{margin:0,fontSize:16,color:"white"}}>Vocabulary</h3>
      </div>
      {dictionaryEntries.length>0&&<div style={{background:"white",borderRadius:10,padding:14,marginBottom:12}}>
        <strong>{orgIndustry} dictionaries active · {dictionaryEntries.length} entries</strong>
        <p style={{fontSize:12,color:"#526174",margin:"6px 0 10px"}}>Included automatically: restaurant, chef, food, ingredient, hospitality, and slang terms. Product meanings support matching. Ambiguous terms need context; service slang explains language without changing products or availability.</p>
        <input aria-label="Search industry dictionaries" style={inp} placeholder="Find a term or abbreviation, e.g. Yukon Gold, IQF, all day" value={dictionarySearch} onChange={e=>setDictionarySearch(e.target.value)} />
        {dictionarySearch.trim()&&<div style={{maxHeight:280,overflowY:"auto",marginTop:8}}>
          {dictionaryMatches.length===0?<div style={{fontSize:12}}>No bundled entry found. You can add a verified meaning below.</div>:dictionaryMatches.map(entry=><div key={`${entry.group}:${entry.term}`} style={{padding:"8px 0",borderTop:"1px solid #E2E8F0",fontSize:12}}>
            <b>{entry.term}</b> <span style={{color:"#526174"}}>· {entry.group} · {entry.kind==="product"?(entry.context?"Context required":"Product terminology"):entry.kind==="ambiguous"?"Meaning needs confirmation":"Reference meaning"}</span>
            {entry.aliases.length>0&&<div>Also written: {entry.aliases.join(", ")}</div>}
            <div style={{color:"#526174"}}>{entry.meaning}</div>
          </div>)}
        </div>}
      </div>}
      <div style={{fontSize:12,color:"rgba(255,255,255,0.7)",marginBottom:10}}>
        How the matching engine reads this trade's language. Units and packaging words are kept out of product names; synonyms make two spellings the same word; stopwords carry no meaning.
      </div>
      <div style={{background:"white",borderRadius:10,padding:14,marginBottom:12,boxShadow:"0 1px 3px rgba(0,0,0,0.06)"}}>
        {(()=>{
          const KINDS=[["synonym","Synonym","chix","chicken"],["unit","Unit","sheets","SHEET"],["packaging","Packaging word","bundle",""],["stopword","Stopword","premium",""]];
          const needsCanonical=vocabKind==="unit"||vocabKind==="synonym";
          const [,,exTerm,exCanon]=KINDS.find(k=>k[0]===vocabKind)||KINDS[0];
          return (
            <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
              <select style={{...inp,width:"auto"}} value={vocabKind} onChange={e=>setVocabKind(e.target.value)}>
                {KINDS.map(([k,label])=><option key={k} value={k}>{label}</option>)}
              </select>
              <input style={{...inp,flex:1,minWidth:120}} placeholder={`Term, e.g. ${exTerm}`} value={vocabTerm} onChange={e=>setVocabTerm(e.target.value)}
                onKeyDown={e=>{if(e.key==="Enter") addVocabulary();}} />
              {needsCanonical&&<span style={{color:"#AAA"}}>→</span>}
              {needsCanonical&&<input style={{...inp,flex:1,minWidth:120}} placeholder={vocabKind==="unit"?`Unit code, e.g. ${exCanon}`:`Means, e.g. ${exCanon}`} value={vocabCanonical} onChange={e=>setVocabCanonical(e.target.value)}
                onKeyDown={e=>{if(e.key==="Enter") addVocabulary();}} />}
              <button onClick={addVocabulary} disabled={vocabBusy||!vocabTerm.trim()||(needsCanonical&&!vocabCanonical.trim())} style={{...btn("#003584","white",{fontSize:12,padding:"9px 14px"})}}>{vocabBusy?"...":"Add"}</button>
            </div>
          );
        })()}
      </div>
      {(vocabulary||[]).length===0?(
        <div style={{background:"white",borderRadius:10,padding:16,textAlign:"center",boxShadow:"0 1px 3px rgba(0,0,0,0.06)"}}>
          <p style={{color:"#888",fontSize:13,margin:0}}>No custom vocabulary yet. {dictionaryEntries.length?"The bundled industry dictionaries are already active. Add verified local terms above.":"Load the starter pack above, or add terms as you meet them on price sheets."}</p>
        </div>
      ):["synonym","unit","packaging","stopword"].map(kind=>{
        const rows=(vocabulary||[]).filter(v=>v.kind===kind).sort((a,b)=>a.term.localeCompare(b.term));
        if(!rows.length) return null;
        const title={synonym:"Synonyms",unit:"Units",packaging:"Packaging words",stopword:"Stopwords"}[kind];
        return (
          <div key={kind} style={{background:"white",borderRadius:8,padding:"10px 14px",marginBottom:8,boxShadow:"0 1px 3px rgba(0,0,0,0.06)"}}>
            <div style={{fontSize:10,fontWeight:700,color:"#AAA",letterSpacing:"0.06em",textTransform:"uppercase",marginBottom:6}}>{title} ({rows.length})</div>
            <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
              {rows.map(v=>(
                <span key={v.id} style={{fontSize:12,background:"#F5F7FA",borderRadius:14,padding:"4px 10px",display:"inline-flex",alignItems:"center",gap:6}}>
                  {v.term}{v.canonical?<span style={{color:"#888"}}>→ {v.canonical}</span>:null}
                  <button onClick={()=>removeVocabulary(v)} title="Remove" style={{background:"none",border:"none",cursor:"pointer",color:"#E65100",fontSize:13,padding:0,lineHeight:1}}>×</button>
                </span>
              ))}
            </div>
          </div>
        );
      })}

      {adding&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <div style={{background:"white",borderRadius:12,padding:24,width:"100%",maxWidth:380}}>
            <h3 style={{margin:"0 0 14px",fontSize:16}}>New category</h3>
            <input style={{...inp,width:"100%",marginBottom:10,boxSizing:"border-box"}} placeholder="Category name" value={newName} onChange={e=>setNewName(e.target.value)} />
            <textarea style={{...inp,width:"100%",minHeight:60,marginBottom:10,fontFamily:"inherit",boxSizing:"border-box"}} placeholder="comma, separated, keywords (optional)" value={newKeywords} onChange={e=>setNewKeywords(e.target.value)} />
            {error&&<div style={{color:"#E65100",fontSize:12,marginBottom:10}}>{error}</div>}
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>{setAdding(false);setError("");}} style={{...btn("#EEE","#555"),flex:1}}>Cancel</button>
              <button onClick={addCategory} style={{...btn("#003584"),flex:2}}>Add</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
