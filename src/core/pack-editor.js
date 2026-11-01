import {parsePackSize} from '../procurement.js';
// Pending edits are stored as explicitly incomplete text. They survive a
// row save/reload, but cannot be mistaken for a fully understood pack.
export function editablePack(raw){
  const rangePending=String(raw||'').match(/^RANGE:(CASE|EACH):([\d?]+)\/([\d?.]+)-([\d?.]+) (\S+) AVG$/);
  if(rangePending){
    const value=s=>s==='?'?'':Number(s);
    return {type:rangePending[1]==='CASE'?'case':'each',count:value(rangePending[2]),size:'',rangeMinimum:value(rangePending[3]),rangeMaximum:value(rangePending[4]),unit:rangePending[5]==='?'?'':rangePending[5],catchWeight:true};
  }
  const nestedPending=String(raw||'').match(/^CASE:([\d?./]+) (\S+)( AVG)?$/);
  if(nestedPending){
    const values=nestedPending[1].split('/');
    if(values.length>2){
      const value=s=>s==='?'?'':Number(s);
      return {type:'case',count:value(values[0]),innerCounts:values.slice(1,-1).map(value),size:value(values.at(-1)),unit:nestedPending[2]==='?'?'':nestedPending[2],catchWeight:!!nestedPending[3]};
    }
  }
  const pending=String(raw||'').match(/^(CASE|EACH):([^/]+)\/([^ ]+) (.+?)( AVG)?$/);
  if(pending)return {type:pending[1]==='CASE'?'case':'each',count:pending[2]==='?'?'':Number(pending[2]),size:pending[3]==='?'?'':Number(pending[3]),unit:pending[4]==='?'?'':pending[4],catchWeight:!!pending[5]};
  const p=parsePackSize(raw);
  if(!p?.parsed)return {type:'',count:'',size:'',unit:'',catchWeight:false};
  const count=p.caseQty; // Keep outer count and inner quantity separate.
  const type=count>1||String(raw).includes('/')?'case':'each';
  if(p.weightRange)return {type,count,size:'',unit:p.unit,catchWeight:true,rangeMinimum:p.weightRange.minimum,rangeMaximum:p.weightRange.maximum};
  return {type,count,size:p.nestedCounts?p.levels.at(-1).quantity:p.unitQty,unit:p.unit,catchWeight:!!p.catchWeight,
    ...(p.nestedCounts?{innerCounts:p.nestedCounts.slice(1)}:{})};
}
export function serializePack(parts){
  if(!parts.type)return '';
  const count=parts.type==='each'?1:Number(parts.count),size=Number(parts.size);
  const countOK=Number.isInteger(count)&&count>0,sizeOK=Number.isFinite(size)&&size>0;
  if(Object.hasOwn(parts,'rangeMinimum')){
    const minimum=Number(parts.rangeMinimum),maximum=Number(parts.rangeMaximum),valid=minimum>0&&Number.isFinite(minimum)&&maximum>=minimum&&Number.isFinite(maximum);
    if(countOK&&valid&&parts.unit)return `${parts.type==='case'?count+'/':''}${minimum}-${maximum} ${parts.unit} AVG`;
    return `RANGE:${parts.type==='case'?'CASE':'EACH'}:${countOK?count:'?'}/${minimum>0?minimum:'?'}-${maximum>0?maximum:'?'} ${parts.unit||'?'} AVG`;
  }
  if(parts.type==='case'&&parts.innerCounts?.length){
    const inner=parts.innerCounts.map(Number);
    if(countOK&&sizeOK&&parts.unit&&inner.every(n=>Number.isSafeInteger(n)&&n>0))
      return `${[count,...inner,size].join('/')} ${parts.unit}${parts.catchWeight?' AVG':''}`;
    // Retain incomplete nested edits without collapsing the case hierarchy.
    return `CASE:${[countOK?count:'?',...inner.map(n=>Number.isSafeInteger(n)&&n>0?n:'?'),sizeOK?size:'?'].join('/')} ${parts.unit||'?'}${parts.catchWeight?' AVG':''}`;
  }
  if(countOK&&sizeOK&&/^#\d+(?:\.\d+)? CAN$/.test(parts.unit)&&size===1)return `${count}/${parts.unit.replace(' CAN',' CN')}`;
  if(countOK&&sizeOK&&parts.unit)return parts.type==='each'?`${size} ${parts.unit}${parts.catchWeight?' AVG':''}`:`${count}/${size} ${parts.unit}${parts.catchWeight?' AVG':''}`;
  return `${parts.type==='each'?'EACH':'CASE'}:${countOK?count:'?'}/${sizeOK?size:'?'} ${parts.unit||'?'}${parts.catchWeight?' AVG':''}`;
}
