export const PALETTE=[
  {bg:"#E3F2FD",accent:"#1565C0",light:"#BBDEFB"},
  {bg:"#E8F5E9",accent:"#2E7D32",light:"#C8E6C9"},
  {bg:"#FFF3E0",accent:"#E65100",light:"#FFE0B2"},
  {bg:"#F3E5F5",accent:"#6A1B9A",light:"#E1BEE7"},
  {bg:"#FCE4EC",accent:"#880E4F",light:"#F8BBD0"},
  {bg:"#E0F2F1",accent:"#00695C",light:"#B2DFDB"},
];
export const inp={width:"100%",padding:"10px 12px",border:"1px solid #E0E0E0",borderRadius:8,fontSize:14,outline:"none",boxSizing:"border-box"};
export const btn=(bg,color="white",extra={})=>({padding:"10px 18px",borderRadius:8,border:"none",cursor:"pointer",fontWeight:700,fontSize:14,background:bg,color,...extra});
export const chipStyle=(isSelected,size="md")=>({fontSize:size==="sm"?11:12,fontWeight:700,cursor:"pointer",padding:size==="sm"?"5px 12px":"6px 14px",borderRadius:size==="sm"?16:20,background:isSelected?"white":"rgba(255,255,255,0.14)",color:isSelected?"#003584":"white",border:isSelected?"2px solid white":"2px solid rgba(255,255,255,0.3)"});
