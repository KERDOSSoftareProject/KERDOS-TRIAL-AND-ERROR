import {unitLabel} from "../core/unit-labels.js";
import {unitChoices} from "../core/catalog-fields.js";
import {QUOTE_GROUPS,quoteGroup,quoteMetrics,chooseQuoteGroup} from '../core/quote-controls.js';
import {priceBasisFor} from '../procurement.js';
export function QuotedPerControl({industry="",vocabulary=[],value,onChange,disabled,style,label}){
  const group=quoteGroup(value),unit=priceBasisFor(value)?.unit||'';
  const otherMetrics=unitChoices(vocabulary,false,industry).map(u=>u.value).filter(u=>quoteGroup(u)==='measure');
  const metrics=group==='measure'?otherMetrics:quoteMetrics(group);
  const offerOther=String(industry).toLowerCase()!=='restaurant'&&otherMetrics.length>0||group==='measure';
  return <>
    <select aria-label={label} style={style} disabled={disabled} value={group} onChange={e=>onChange(chooseQuoteGroup(e.target.value,value))}>
      <option value="" disabled>Select</option>{QUOTE_GROUPS.map(g=><option key={g.value} value={g.value}>{g.label}</option>)}
      {offerOther&&<option value="measure">Other measurement</option>}
    </select>
    {metrics.length>0&&<select aria-label={`${label} measurement`} style={{...style,marginTop:4}} disabled={disabled} value={unit} onChange={e=>onChange(e.target.value)}>
      <option value="" disabled>Select {group==='measure'?'measurement':group} unit</option>{metrics.map(u=><option key={u} value={u}>{unitLabel(u)}</option>)}
    </select>}
    {group==='measure'&&unit&&!metrics.includes(unit)&&<small style={{display:'block'}}>From sheet: {value}</small>}
    {!group&&value&&<small style={{display:'block'}}>From sheet: {value} · select quoted basis</small>}
  </>;
}
