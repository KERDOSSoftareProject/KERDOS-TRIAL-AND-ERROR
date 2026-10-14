// KERDOS's working indicator: a drachma turning on its axis. Original
// drawing in the spirit of the Athenian owl coin — an owl, an olive sprig,
// and the letters ΑΘΕ — used wherever the app is busy on the person's
// behalf. Purely visual; it carries no state.
const STYLE_ID="kerdos-drachma-style";
function ensureStyle(){
  if(typeof document==="undefined"||document.getElementById(STYLE_ID))return;
  const style=document.createElement("style");
  style.id=STYLE_ID;
  style.textContent=`
@keyframes kerdos-drachma-spin{0%{transform:rotateY(0deg)}100%{transform:rotateY(360deg)}}
.kerdos-drachma{display:inline-block;perspective:600px}
.kerdos-drachma svg{animation:kerdos-drachma-spin 1.6s linear infinite;transform-style:preserve-3d;backface-visibility:visible}
@media (prefers-reduced-motion:reduce){.kerdos-drachma svg{animation-duration:4s}}`;
  document.head.appendChild(style);
}

export function Drachma({size=44,label="Working…",style}){
  ensureStyle();
  return (
    <span role="status" aria-label={label} title={label} className="kerdos-drachma" style={{display:"inline-flex",alignItems:"center",gap:10,...style}}>
      <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
        <defs>
          <radialGradient id="kerdos-drachma-face" cx="40%" cy="35%" r="70%">
            <stop offset="0%" stopColor="#F3E3B4"/>
            <stop offset="55%" stopColor="#D8B96B"/>
            <stop offset="100%" stopColor="#A67C2E"/>
          </radialGradient>
        </defs>
        <circle cx="50" cy="50" r="47" fill="url(#kerdos-drachma-face)" stroke="#8A6420" strokeWidth="3"/>
        <circle cx="50" cy="50" r="41" fill="none" stroke="#B48A3C" strokeWidth="1.2" strokeDasharray="2 3"/>
        {/* olive sprig */}
        <path d="M22 30 q4 -8 12 -6" fill="none" stroke="#6E4E14" strokeWidth="2.2" strokeLinecap="round"/>
        <ellipse cx="27" cy="26" rx="3.2" ry="1.7" fill="#6E4E14" transform="rotate(-40 27 26)"/>
        <ellipse cx="33" cy="23" rx="3.2" ry="1.7" fill="#6E4E14" transform="rotate(-20 33 23)"/>
        {/* owl */}
        <ellipse cx="50" cy="58" rx="15" ry="20" fill="#6E4E14"/>
        <circle cx="50" cy="38" r="12" fill="#6E4E14"/>
        <path d="M40 30 l3 -8 l6 6 M60 30 l-3 -8 l-6 6" fill="#6E4E14"/>
        <circle cx="45" cy="37" r="4.6" fill="#F3E3B4"/>
        <circle cx="55" cy="37" r="4.6" fill="#F3E3B4"/>
        <circle cx="45" cy="37" r="2.2" fill="#3A2A08"/>
        <circle cx="55" cy="37" r="2.2" fill="#3A2A08"/>
        <path d="M48 43 l2 4 l2 -4 z" fill="#3A2A08"/>
        <path d="M43 52 q7 5 14 0 M43 60 q7 5 14 0 M43 68 q7 5 14 0" fill="none" stroke="#C9A85C" strokeWidth="1.6"/>
        <path d="M44 78 l-3 6 M50 78 l0 6 M56 78 l3 6" stroke="#6E4E14" strokeWidth="2" strokeLinecap="round"/>
        {/* ΑΘΕ */}
        <text x="70" y="42" fontFamily="Georgia, 'Times New Roman', serif" fontSize="11" fontWeight="700" fill="#6E4E14">Α</text>
        <text x="70" y="56" fontFamily="Georgia, 'Times New Roman', serif" fontSize="11" fontWeight="700" fill="#6E4E14">Θ</text>
        <text x="70" y="70" fontFamily="Georgia, 'Times New Roman', serif" fontSize="11" fontWeight="700" fill="#6E4E14">Ε</text>
      </svg>
      {label&&<span style={{fontSize:13,fontWeight:700,color:"#003584"}}>{label}</span>}
    </span>
  );
}
