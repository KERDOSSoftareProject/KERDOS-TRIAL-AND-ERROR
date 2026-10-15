import {parsePackSize} from '../procurement.js';
// Pending edits are stored as explicitly incomplete text. They survive a
// row save/reload, but cannot be mistaken for a fully understood pack.
export function editablePack(raw){
  const pending=String(raw||'').match(/^(CASE|EACH):([^/]+)\/([^ ]+) (.+)$/);
  if(pending)return {type:pending[1]==='CASE'?'case':'each',count:pending[2]==='?'?'':Number(pending[2]),size:pending[3]==='?'?'':Number(pending[3]),unit:pending[4]==='?'?'':pending[4],catchWeight:false};
  const p=parsePackSize(raw);
  if(!p?.parsed)return {type:'',count:'',size:'',unit:'',catchWeight:false};
  const count=p.caseQty; // Keep outer count and inner quantity separate.
  const type=count>1||String(raw).includes('/')?'case':'each';
  return {type,count,size:p.unitQty,unit:p.unit,catchWeight:!!p.catchWeight};
}
export function serializePack(parts){
  if(!parts.type)return '';
  const count=parts.type==='each'?1:Number(parts.count),size=Number(parts.size);
  const countOK=Number.isInteger(count)&&count>0,sizeOK=Number.isFinite(size)&&size>0;
  if(countOK&&sizeOK&&/^#\d+(?:\.\d+)? CAN$/.test(parts.unit)&&size===1)return `${count}/${parts.unit.replace(' CAN',' CN')}`;
  if(countOK&&sizeOK&&parts.unit)return parts.type==='each'?`${size} ${parts.unit}${parts.catchWeight?' AVG':''}`:`${count}/${size} ${parts.unit}${parts.catchWeight?' AVG':''}`;
  return `${parts.type==='each'?'EACH':'CASE'}:${countOK?count:'?'}/${sizeOK?size:'?'} ${parts.unit||'?'}`;
}
