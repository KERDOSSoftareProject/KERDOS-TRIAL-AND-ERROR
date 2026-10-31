import {useEffect,useState} from "react";

const destinations=[
  {id:"order",name:"Order Guide",hint:"Build orders from current vendor prices",icon:"▤"},
  {id:"catalog",name:"Item Catalog",hint:"Your products and vendor listings",icon:"◇"},
  {id:"priceSheets",name:"Price Sheets",hint:"View current and past price sheets",icon:"▦"},
  {id:"invoices",name:"Invoices",hint:"Review invoices and purchase history",icon:"▤"},
  {id:"inbox",name:"Inbox",hint:"Review incoming documents",icon:"✉",restricted:true},
  {id:"team",name:"Admin",hint:"Manage your team and account",icon:"⚙",restricted:true},
];

export function welcomeGreeting(date){
  const hour=date.getHours();
  return hour<12?"Good morning":hour<17?"Good afternoon":"Good evening";
}

export function welcomeDate(date){
  const day=new Intl.DateTimeFormat(undefined,{weekday:"long"}).format(date);
  const calendar=new Intl.DateTimeFormat(undefined,{month:"long",day:"numeric"}).format(date);
  const time=new Intl.DateTimeFormat(undefined,{hour:"numeric",minute:"2-digit"}).format(date);
  return `${day} · ${calendar} · ${time}`;
}

export function userInitials(name){
  return (name||"").trim().split(/\s+/).slice(0,2).map(part=>part[0]?.toUpperCase()||"").join("")||"K";
}

export default function WelcomeScreen({orgName,role,onNavigate,attentionCount=0,invoiceReviewCount=0,inboxCount=0}){
  const [now,setNow]=useState(()=>new Date());
  useEffect(()=>{
    const timer=setInterval(()=>setNow(new Date()),30000);
    return ()=>clearInterval(timer);
  },[]);
  const canManage=role==="owner"||role==="manager";
  const hints={
    catalog:undefined,
    invoices:invoiceReviewCount>0?`${invoiceReviewCount} invoice lines to review`:undefined,
    inbox:inboxCount>0?`${inboxCount} attachments need attention`:undefined,
  };
  return <section className="welcome-screen" aria-label="Welcome to KERDOS">
    <style>{`
      .welcome-screen { min-height:calc(100vh - 60px); box-sizing:border-box; padding:72px 32px 96px; background:linear-gradient(160deg,#003584 0%,#00204F 100%); color:white; font-family:"Times New Roman",Times,serif; }
      .welcome-inner { max-width:1180px; margin:0 auto; }
      .welcome-greeting { margin:0; text-align:center; font-size:clamp(27px,3vw,38px); font-weight:500; line-height:1.2; }
      .welcome-greeting strong { font-weight:650; color:white; }
      .welcome-greeting { margin-bottom:44px; }
      .welcome-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:24px; }
      .welcome-tile { min-height:190px; border:2px solid transparent; border-radius:14px; background:rgba(255,255,255,0.08); color:white; font-family:inherit; cursor:pointer; display:flex; flex-direction:column; align-items:flex-start; justify-content:center; gap:12px; padding:24px; text-align:left; transition:border-color .15s,box-shadow .15s; }
      .welcome-tile:hover,.welcome-tile:focus-visible { border-color:#69F0AE; box-shadow:0 8px 24px rgba(0,0,0,.18); outline:none; }
      .welcome-icon { width:44px; height:44px; display:flex; align-items:center; justify-content:center; border-radius:12px; background:#E3F2FD; color:#003584; font-size:26px; line-height:1; }
      .welcome-name { font-size:17px; font-weight:700; }
      .welcome-hint { font-size:12px; color:rgba(255,255,255,0.75); line-height:1.4; }
      .welcome-badge { display:inline-block; margin-left:7px; padding:2px 7px; background:#69F0AE; color:#00204F; border-radius:12px; font-size:11px; vertical-align:middle; }
      @media (max-width:560px) { .welcome-screen { padding:46px 18px 70px; } .welcome-grid { grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; } .welcome-tile { min-height:152px; padding:14px; } .welcome-greeting { margin-bottom:32px; } }
      @media (max-width:380px) { .welcome-grid { grid-template-columns:1fr; } .welcome-tile { min-height:116px; } }
    `}</style>
    <div className="welcome-inner">
      <h1 className="welcome-greeting">{welcomeGreeting(now)}{orgName?` ${orgName}`:""}!</h1>
      <div className="welcome-grid">
        {destinations.filter(item=>!item.restricted||canManage).map(item=><button type="button" className="welcome-tile" key={item.id} onClick={()=>onNavigate(item.id)}>
          <span className="welcome-icon" aria-hidden="true">{item.icon}</span>
          <span className="welcome-name">{item.name}{item.id==="inbox"&&inboxCount>0?<span className="welcome-badge" aria-label={`${inboxCount} attachments need attention`}>{inboxCount}</span>:null}</span>
          <span className="welcome-hint">{hints[item.id]||item.hint}</span>
        </button>)}
      </div>
    </div>
  </section>;
}
