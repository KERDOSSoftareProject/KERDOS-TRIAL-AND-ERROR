// B5 admission checks consume assigned fields. They never select source
// cells, substitute another field, decide a product group or write records.
import {getProcurementContext} from "../procurement.js";
import {checkCell} from './sheet-layout.js';

const UNCHECKED_ROLES=new Set(['description','brand','mfrCode']);

export function assessBoundFields(identification,{inferredCodeColumn}={}, procurement=getProcurementContext()){
 const bindings=identification?.bindings||{};
 const owners=new Map();
 for(const [role,binding] of Object.entries(bindings)){
  if(!Number.isInteger(binding?.columnIndex))continue;
  const roles=owners.get(binding.columnIndex)||[];
  roles.push(role);owners.set(binding.columnIndex,roles);
 }
 const fields={},cellIssues={};
 for(const [role,binding] of Object.entries(bindings)){
  const raw=binding.rawValue;
  const empty=raw==null||!String(raw).trim();
  const checked=!UNCHECKED_ROLES.has(role);
  const result=checked?checkCell(role,raw, procurement):{ok:true};
  const competing=owners.get(binding.columnIndex)?.filter(other=>other!==role)||[];
  const status=competing.length?'conflict':empty?'missing':!result.ok?'invalid':binding.evidence==='inferred'?'inferred':'present';
  // Confidence describes the field assignment and readable value, not product identity.
  // A guessed layout has no independent corroboration, so it cannot earn 90.
  const accuracy=empty?0:competing.length||!result.ok?null:
   binding.evidence==='stated'||binding.evidence==='remembered'?100:
   binding.evidence==='inferred'?70:null;
  fields[role]={status,columnIndex:binding.columnIndex,evidence:binding.evidence,
   accuracy,
   ...(competing.length?{conflictsWith:competing}:{}),...(!result.ok?{reason:result.reason}:{})};
  // Preserve the existing cell warning contract for the import preview.
  if(checked&&!result.ok)cellIssues[role]=result.reason;
 }
 // An unmapped description is missing evidence, not an empty source cell.
 if(!bindings.description)fields.description={status:'missing',columnIndex:null,evidence:'missing',accuracy:0};
 if(!bindings.code)fields.code=Number.isInteger(inferredCodeColumn)
  ?{status:'inferred',columnIndex:inferredCodeColumn,evidence:'inferred',accuracy:70}
  :{status:'missing',columnIndex:null,evidence:'missing',accuracy:0};
 return {fields,cellIssues};
}

// Assess assigned cells without changing their placement. The caller decides
// whether a source observation can be admitted as a listing.
export function validateAssignedFields(fields,{price,amount,priceUnavailable=false}={}){
 const anchorText=String(fields?.anchor?.rawValue||'').trim();
 const columnHeading=/^(?:col(?:umn)?\s*\d+|description|product description|item description)$/i;
 const assigned=['price','amount'].map(role=>({role,raw:fields?.values?.[role],header:String(fields?.bindings?.[role]?.header||'').trim()}))
  .filter(cell=>cell.raw!=null);
 const headerLike=columnHeading.test(anchorText)||assigned.some(({raw})=>String(raw).trim())&&assigned.every(({raw,header})=>{
  const text=String(raw).trim();
  return !text||text.toLowerCase()===header.toLowerCase()||columnHeading.test(text)||/^(?:price|amount|cost|rate|unit price|quoted price|extended price|line total|total)$/i.test(text);
 });
 const unreadable=price==null&&amount==null&&!priceUnavailable&&assigned.length>0&&!headerLike;
 const anchorStatus=fields?.anchor?.status||'missing';
 const issues=[];
 if(anchorStatus==='missing'||anchorStatus==='ambiguous')issues.push({
  kind:anchorStatus==='ambiguous'?'ambiguous-description':'missing-description',
  message:anchorStatus==='ambiguous'?'Product description column also has another assigned role.':'Product description is missing.',
 });
 if(unreadable){
  const evidence=assigned.find(({raw})=>String(raw).trim());
  const hint=evidence?` ("${String(evidence.raw).trim()}")`:'';
  issues.push({kind:'missing-price',field:evidence?.role||assigned[0].role,message:`Price missing or could not be read${hint}`});
 }
 return {version:1,anchorStatus,priceStatus:priceUnavailable?'unavailable':unreadable?'missing-or-unreadable':price!=null||amount!=null?'parsed':'absent',
  retain:price!=null||amount!=null||priceUnavailable||unreadable,
  requiresReview:anchorStatus==='missing'||anchorStatus==='ambiguous'||unreadable,
  issues};
}

// Collect existing arithmetic and quoted-unit findings after row interpretation.
// Legacy review flags remain available to consumers during the transition.
export function withRowValidation(row){
 if(!row?.fieldValidation)return row;
 const fields={...row.fieldValidation.fields};
 const conflicts=(row.cellConflicts||[]).map(({field,note})=>({field,note}));
 for(const {field} of conflicts)if(fields[field])fields[field]={...fields[field],status:'conflict',accuracy:null};
 const unitClues=row.quoteUnitEvidence||[];
 const unitConflict=unitClues.length>1&&new Set(unitClues.map(clue=>clue.unit)).size>1;
 if(unitConflict&&fields.sellingUnit)fields.sellingUnit={...fields.sellingUnit,status:'conflict',accuracy:null};
 return {...row,fieldValidation:{...row.fieldValidation,fields,conflicts,
  unresolved:(row.cellUnresolved||[]).map(({field,reason})=>({field,reason})),
  quotedUnit:unitConflict?'conflict':unitClues.length?'evidenced':'missing'}};
}
