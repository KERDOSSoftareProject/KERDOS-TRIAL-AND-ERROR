// B4 field placement consumes a previously studied row/column layout. It has
// no product vocabulary, grouping, arithmetic, reader or persistence imports.
const sourceIndex=index=>Number.isInteger(index)&&index>=0;

export function identifyRowFields({cells=[],columnMap={},sourceHeaders=[],confirmedColumns=new Set(),rowIndex=null}={}){
 const values={},bindings={};
 for(const [field,columnIndex] of Object.entries(columnMap)){
  if(!sourceIndex(columnIndex))continue;
  const rawValue=cells[columnIndex];
  values[field]=rawValue;
  bindings[field]={columnIndex,rowIndex,header:sourceHeaders[columnIndex]||null,rawValue:rawValue??null,
   evidence:confirmedColumns.has(columnIndex)?'stated-or-remembered':'inferred'};
 }
 const columnIndex=sourceIndex(columnMap.description)?columnMap.description:null;
 const rawValue=columnIndex==null?null:cells[columnIndex]??null;
 const conflicts=columnIndex==null?[]:Object.entries(columnMap).filter(([field,index])=>field!=='description'&&index===columnIndex).map(([field])=>field);
 const status=conflicts.length?'ambiguous':rawValue==null||!String(rawValue).trim()?'missing':confirmedColumns.has(columnIndex)?'identified':'inferred';
 const anchor={field:'description',status,columnIndex,rowIndex,rawValue,conflicts};
 const issues=status==='missing'?[{kind:'description-anchor',message:'Product description missing; source row retained for identification.'}]:status==='ambiguous'?[{kind:'description-anchor',message:'Description column conflicts with another assigned field; source row retained for identification.'}]:[];
 // A brand, code or neighboring value is never a substitute for this anchor.
 if(status==='missing'||status==='ambiguous')values.description='';
 return {version:1,anchor,values,bindings,issues};
}
