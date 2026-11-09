import {navigationPages} from "./workspace-pages.js";
const tabButton={display:"inline-flex",alignItems:"center",gap:8,padding:"8px 13px",border:"1px solid rgba(255,255,255,.4)",borderRadius:8,background:"rgba(255,255,255,.1)",color:"white",fontFamily:"inherit",fontWeight:600,fontSize:14,cursor:"pointer"};
export default function TabHeading({title,onHome,activeTab,onNavigate,role,sticky=false}){
  return <div className={sticky?"workspace-sticky-tabs":undefined} style={{display:"flex",alignItems:"center",gap:18,flexWrap:sticky?"nowrap":"wrap",marginBottom:18}}>
    <h1 style={{margin:0,color:"white",fontSize:20,fontWeight:700,letterSpacing:".02em",textTransform:"uppercase"}}>{title}</h1>
    <nav aria-label="Workspace tabs" style={{display:"flex",alignItems:"center",gap:8,flexWrap:sticky?"nowrap":"wrap",minWidth:0}}>
    <button type="button" onClick={onHome} title="Welcome" aria-current={activeTab==="home"?"page":undefined} style={{...tabButton,...(activeTab==="home"?{background:"rgba(255,255,255,.25)",borderColor:"rgba(255,255,255,.8)"}:{})}}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/><path d="M9 21v-8h6v8"/></svg>
      Home
    </button>
    {navigationPages(role).map(({id,name:label})=><button type="button" key={id} aria-current={activeTab===id?"page":undefined} onClick={()=>onNavigate(id)} style={{...tabButton,...(activeTab===id?{background:"rgba(255,255,255,.25)",borderColor:"rgba(255,255,255,.8)"}:{})}}>{label}</button>)}
    </nav>
  </div>;
}
